import { expect } from 'chai';
import hre from 'hardhat';

import {
  BASE_W,
  HALF_LIFE,
  MAX_HALF_LIFE,
  MIN_HALF_LIFE,
  NEG_MULT,
  PRIOR,
  THRESHOLD,
  WAD,
  field,
} from './helpers/constants.js';
import { loadFixture, registeredFixture, time } from './helpers/fixtures.js';
import { attempt } from './helpers/revert.js';

const { ethers } = hre;

const H = BigInt(HALF_LIFE);
const score = (p, n, prior = PRIOR) => (p * WAD) / (p + n + prior);

/** Errors the long-horizon walk is allowed to hit; anything else fails the test. */
const ALLOWED = new Set([
  'AlreadyEndorsed',
  'NotEndorsed',
  'AlreadyReported',
  'NotReported',
  'CooldownActive',
  'SelfAction',
  'AgentInactive',
  'UnclaimedStake',
  'InvalidStake',
]);

/**
 * Time decay is the property the previous contract documented in its header and never implemented -
 * no timestamp was ever consulted by its scoring function. This file proves the replacement is real,
 * arithmetically exact at the anchors, monotone, and correct when it interacts with revocation and
 * with a mid-flight governance change.
 */
describe('ReputationManager - time decay', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
  });

  /* ====================================================================== */
  describe('DecayMath properties', function () {
    it('hits the half-life anchors exactly', async function () {
      const { decayMath } = ctx;
      expect(await decayMath.decayFactor(0, H)).to.equal(WAD);
      expect(await decayMath.decayFactor(H, H)).to.equal(WAD / 2n);
      expect(await decayMath.decayFactor(2n * H, H)).to.equal(WAD / 4n);
      expect(await decayMath.decayFactor(3n * H, H)).to.equal(WAD / 8n);
      expect(await decayMath.applyDecay(WAD, H, H)).to.equal(WAD / 2n);
      expect(await decayMath.applyDecay(4n * WAD, 2n * H, H)).to.equal(WAD);
    });

    it('is within 0.2% of true 2^-x at a half-integer exponent', async function () {
      const { decayMath } = ctx;
      const actual = await decayMath.decayFactor(H / 2n, H);
      const expected = BigInt(Math.round(Math.SQRT1_2 * 1e18));
      const diff = actual > expected ? actual - expected : expected - actual;
      expect(diff * 500n).to.be.at.most(expected); // |diff| / expected <= 0.2%
    });

    it('is monotone non-increasing across 200 sample points in [0, 8H]', async function () {
      const { decayMath } = ctx;
      let previous = WAD;
      for (let i = 0; i <= 200; i++) {
        const elapsed = (8n * H * BigInt(i)) / 200n;
        const f = await decayMath.decayFactor(elapsed, H);
        expect(f).to.be.at.most(previous);
        expect(f).to.be.at.most(WAD);
        previous = f;
      }
    });

    it('saturates to zero beyond 64 half-lives and disables cleanly at halfLife 0', async function () {
      const { decayMath } = ctx;
      // WAD >> 60 is already 0 in integer arithmetic, so the factor bottoms out before the explicit
      // 64-half-life short circuit; both facts are asserted.
      expect(await decayMath.decayFactor(50n * H, H)).to.be.greaterThan(0n);
      expect(await decayMath.decayFactor(60n * H, H)).to.equal(0n);
      expect(await decayMath.decayFactor(64n * H, H)).to.equal(0n);
      expect(await decayMath.decayFactor(10_000n * H, H)).to.equal(0n);

      // A zero half-life is the documented escape hatch for a purely cumulative deployment.
      expect(await decayMath.decayFactor(0, 0)).to.equal(WAD);
      expect(await decayMath.decayFactor(10n ** 12n, 0)).to.equal(WAD);
      expect(await decayMath.applyDecay(WAD, 10n ** 12n, 0)).to.equal(WAD);
    });

    it('exposes the full 1/16 bucket table and rejects an out-of-range index', async function () {
      const { decayMath, errs } = ctx;
      expect(await decayMath.pow2NegSixteenths(0)).to.equal(WAD);
      expect(await decayMath.pow2NegSixteenths(8)).to.equal(707106781186548000n);
      let previous = WAD;
      for (let k = 0; k <= 15; k++) {
        const v = await decayMath.pow2NegSixteenths(k);
        expect(v).to.be.at.most(previous);
        previous = v;
      }
      expect(previous).to.be.greaterThan(WAD / 2n);
      await expect(decayMath.pow2NegSixteenths(16))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('pow2Idx'), 16);
    });
  });

  /* ====================================================================== */
  describe('lazy settlement', function () {
    it('decays in a plain view call, with no transaction at all', async function () {
      const { reputation, agentA, agentB } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      const settledAt = await time.latest();

      await time.increase(HALF_LIFE);

      // Nobody has touched the contract, yet the score already reflects one half-life of decay.
      const [p, n, last] = await reputation.massesOf(agentA.address);
      expect(p).to.equal(BASE_W / 2n);
      expect(n).to.equal(0n);
      expect(last).to.equal(settledAt); // storage is deliberately still stale
      expect(await reputation.reputationOf(agentA.address)).to.equal(score(BASE_W / 2n, 0n));
      expect(await reputation.reputationOf(agentA.address)).to.equal(40000000000000000n);
    });

    it('settle materialises exactly the value the view already reported', async function () {
      const { reputation, agentA, agentB, outsider } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await time.increase(HALF_LIFE);

      const viewed = (await reputation.massesOf(agentA.address))[0];
      await reputation.connect(outsider).settle(agentA.address);
      const now = await time.latest();

      const [p, , last] = await reputation.massesOf(agentA.address);
      expect(p).to.be.closeTo(viewed, 10n ** 12n);
      expect(last).to.equal(now);

      // Settling again immediately is a no-op on the masses.
      await reputation.connect(outsider).settle(agentA.address);
      expect((await reputation.massesOf(agentA.address))[0]).to.equal(p);
    });
  });

  /* ====================================================================== */
  describe('decay changes the verdict', function () {
    it('retires a trusted agent after three half-lives of silence', async function () {
      this.timeout(120000);
      const { reputation, agentA, registeredExtras } = ctx;
      for (let i = 0; i < 18; i++) {
        await reputation.connect(registeredExtras[i]).endorseAgent(agentA.address, 'x');
      }
      expect(await reputation.isTrusted(agentA.address)).to.equal(true);
      const massBefore = (await reputation.massesOf(agentA.address))[0];
      expect(massBefore).to.equal(18n * BASE_W);

      await time.increase(3 * HALF_LIFE);

      // No transaction from anyone: stale reputation genuinely expires.
      const [p] = await reputation.massesOf(agentA.address);
      expect(p).to.equal(massBefore / 8n);
      expect(await reputation.reputationOf(agentA.address)).to.equal(score(massBefore / 8n, 0n));
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);
      // The endorsement edges themselves are untouched; only their evidentiary weight decayed.
      expect(await reputation.endorserCount(agentA.address)).to.equal(18n);
    });

    it('lets a reported agent recover if nobody re-reports', async function () {
      const { reputation, agentA, agentB } = ctx;
      await reputation.connect(agentB).reportAgent(agentA.address, 'poisoning');
      const n0 = (await reputation.massesOf(agentA.address))[1];
      expect(n0).to.equal((BASE_W * NEG_MULT) / WAD);

      await time.increase(2 * HALF_LIFE);
      expect((await reputation.massesOf(agentA.address))[1]).to.equal(n0 / 4n);
      await time.increase(62 * HALF_LIFE);
      expect((await reputation.massesOf(agentA.address))[1]).to.equal(0n);
      expect(await reputation.reporterCount(agentA.address)).to.equal(1n);
    });
  });

  /* ====================================================================== */
  describe('decay versus revocation accounting', function () {
    for (const halves of [0.1, 1.5, 3.7, 20]) {
      it(`stays consistent when revocations are interleaved at ${halves} half-lives`, async function () {
        const { reputation, decayMath, agentA, registeredExtras } = ctx;
        const [e0, e1, e2] = registeredExtras;
        for (const w of [e0, e1, e2]) await reputation.connect(w).endorseAgent(agentA.address, 'x');
        expect((await reputation.massesOf(agentA.address))[0]).to.equal(3n * BASE_W);

        const elapsed = Math.round(halves * HALF_LIFE);
        await time.increase(elapsed);

        const massBefore = (await reputation.massesOf(agentA.address))[0];
        const tx = await reputation.connect(e0).revokeEndorsement(agentA.address, 'x');
        const receipt = await tx.wait();
        const parsed = receipt.logs
          .map((l) => {
            try {
              return reputation.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .find((l) => l?.name === 'EndorsementRevoked');
        const removed = parsed.args.removedWeightWad;

        const predicted = await decayMath.applyDecay(BASE_W, elapsed, HALF_LIFE);
        // Within 1%: the aggregate and the edge are decayed in slightly different bucketing frames.
        expect(removed).to.be.closeTo(predicted, predicted / 100n + 1n);

        const [after] = await reputation.massesOf(agentA.address);
        expect(after).to.be.at.most(massBefore); // never underflows, never grows
        expect(after).to.be.closeTo(massBefore - removed, massBefore / 100n + 1n);
        expect(await reputation.endorserCount(agentA.address)).to.equal(2n);

        await reputation.connect(e1).revokeEndorsement(agentA.address, 'x');
        await reputation.connect(e2).revokeEndorsement(agentA.address, 'x');
        // The endorserCount == 0 anchor: removing the last edge zeroes the mass outright, so no
        // rounding dust can accumulate across cycles.
        expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
        expect((await reputation.massesOf(agentA.address))[0]).to.equal(0n);
        expect(await reputation.reputationOf(agentA.address)).to.equal(0n);
      });
    }
  });

  /* ====================================================================== */
  describe('half-life governance changes', function () {
    for (const [label, next] of [
      ['shortened tenfold', HALF_LIFE / 10],
      ['lengthened tenfold', HALF_LIFE * 10],
      ['clamped to the minimum', MIN_HALF_LIFE],
      ['clamped to the maximum', MAX_HALF_LIFE],
    ]) {
      it(`absorbs a half-life ${label} without reverting or inflating mass`, async function () {
        const { reputation, paramAdmin, agentA, registeredExtras } = ctx;
        const [e0, e1] = registeredExtras;
        await reputation.connect(e0).endorseAgent(agentA.address, 'x');
        await reputation.connect(e1).endorseAgent(agentA.address, 'x');
        const initial = (await reputation.massesOf(agentA.address))[0];

        await time.increase(HALF_LIFE);
        await reputation.connect(paramAdmin).setHalfLife(next);

        // The removal amount is recomputed in the NEW frame while the aggregate was accrued in the
        // old one, so the subtraction must saturate rather than revert.
        await reputation.connect(e0).revokeEndorsement(agentA.address, 'x');
        const [mid] = await reputation.massesOf(agentA.address);
        expect(mid).to.be.at.least(0n);
        expect(mid).to.be.at.most(initial);

        await reputation.connect(e1).revokeEndorsement(agentA.address, 'x');
        expect((await reputation.massesOf(agentA.address))[0]).to.equal(0n);
      });
    }
  });

  /* ====================================================================== */
  describe('long-horizon stability', function () {
    it('survives 40 randomised time jumps and trust actions with no arithmetic panic', async function () {
      this.timeout(300000);
      const { reputation, errs, agentA, agentB, agentC, registeredExtras } = ctx;
      const actors = [agentA, agentB, agentC, registeredExtras[0]];
      const iface = errs.interface;

      // A deterministic LCG: reproducible in CI, no external randomness.
      let s = 42;
      const rnd = (n) => (s = (s * 1103515245 + 12345) % 2147483648) % n;

      for (let i = 0; i < 40; i++) {
        const from = actors[rnd(actors.length)];
        const to = actors[rnd(actors.length)];
        const action = i % 4;

        const call =
          action === 0
            ? () => reputation.connect(from).endorseAgent(to.address, 'e')
            : action === 1
              ? () => reputation.connect(from).revokeEndorsement(to.address, 'r')
              : action === 2
                ? () => reputation.connect(from).reportAgent(to.address, 'p')
                : () => reputation.connect(from).withdrawReport(to.address, 'w');

        const outcome = await attempt(call, iface);
        if (!outcome.ok) {
          expect(outcome.kind, `unexpected revert: ${outcome.message}`).to.equal('custom');
          expect(ALLOWED.has(outcome.name), `unexpected error ${outcome.name}`).to.equal(true);
        }

        // Between one hour and 200 days, from the same deterministic sequence.
        await time.increase(3600 + rnd(200 * 24 * 3600));

        for (const a of actors) {
          const rep = await reputation.reputationOf(a.address);
          expect(rep).to.be.at.least(0n);
          expect(rep).to.be.lessThan(WAD);

          const [p, n] = await reputation.massesOf(a.address);
          const count = await reputation.endorserCount(a.address);
          const reports = await reputation.reporterCount(a.address);
          const maxW = await reputation.maxEndorserWeightWad();
          const negMult = await reputation.negativeMultiplierWad();

          expect(p).to.be.at.most(count * maxW);
          expect(n).to.be.at.most((reports * maxW * negMult) / WAD);
          if (count === 0n) expect(p).to.equal(0n);
          if (reports === 0n) expect(n).to.equal(0n);
        }
      }

      // Everything still resolves against the threshold after a multi-year walk.
      for (const a of actors) {
        expect(await reputation.isTrusted(a.address)).to.equal(
          (await reputation.reputationOf(a.address)) >= THRESHOLD,
        );
      }
      void ethers;
    });
  });
});
