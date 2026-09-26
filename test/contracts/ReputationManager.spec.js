import { expect } from 'chai';
import hre from 'hardhat';

import {
  ACTOR_COOLDOWN,
  BASE_W,
  DEFAULT_ADMIN_ROLE,
  ENDORSE_COOLDOWN,
  HALF_LIFE,
  MAX_COOLDOWN,
  MAX_ENDORSER_WEIGHT_WAD,
  MAX_HALF_LIFE,
  MAX_NEG_MULTIPLIER_WAD,
  MAX_PAGE_SIZE,
  MAX_PRIOR_WAD,
  MAX_REASON_BYTES,
  MAX_STAKE_LOCK,
  MAX_TRUST_LOG_CAPACITY,
  MAX_W,
  MIN_HALF_LIFE,
  NEG_MULT,
  PARAM_ADMIN_ROLE,
  PRIOR,
  REPORT_COOLDOWN,
  SLASHER_ROLE,
  STAKE_LOCK,
  THRESHOLD,
  TREASURER_ROLE,
  TRUST_LOG_CAPACITY,
  WAD,
  field,
  strOfLength,
  validPubKey,
} from './helpers/constants.js';
import { loadFixture, registeredFixture, time } from './helpers/fixtures.js';

const { ethers } = hre;

/** The documented score: `P / (P + N + prior)`, in WAD, floored exactly as `Math.mulDiv` floors. */
const score = (p, n, prior = PRIOR) => (p * WAD) / (p + n + prior);

/** Weight an endorser with reputation `rep` contributes: `base + (max - base) * rep / WAD`, capped. */
const weightFor = (rep, base = BASE_W, max = MAX_W) => {
  const w = base + ((max - base) * rep) / WAD;
  return w < max ? w : max;
};

const TrustEventKind = {
  None: 0,
  Endorse: 1,
  RevokeEndorse: 2,
  Report: 3,
  WithdrawReport: 4,
  Slash: 5,
};

describe('ReputationManager', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
  });

  /* ====================================================================== */
  describe('initial state', function () {
    it('validates every constructor argument', async function () {
      const Factory = await ethers.getContractFactory('ReputationManager');
      const { admin, identityAddr, outsider, errs } = ctx;
      await expect(
        Factory.deploy(admin.address, ethers.ZeroAddress, admin.address, 16),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(Factory.deploy(admin.address, outsider.address, admin.address, 16))
        .to.be.revertedWithCustomError(errs, 'NotAContract')
        .withArgs(outsider.address);
      await expect(
        Factory.deploy(admin.address, identityAddr, ethers.ZeroAddress, 16),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(Factory.deploy(admin.address, identityAddr, admin.address, 0))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('logCapacity'), 0);
      await expect(
        Factory.deploy(admin.address, identityAddr, admin.address, MAX_TRUST_LOG_CAPACITY + 1),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('logCapacity'), MAX_TRUST_LOG_CAPACITY + 1);
    });

    it('starts every agent at zero and exposes the documented defaults', async function () {
      const { reputation, agentA, agentB, admin } = ctx;
      for (const a of [agentA, agentB]) {
        expect(await reputation.reputationOf(a.address)).to.equal(0n);
        expect(await reputation.globalReputation(a.address)).to.equal(0n);
        expect(await reputation.reputationBps(a.address)).to.equal(0n);
        expect(await reputation.isTrusted(a.address)).to.equal(false);
        expect(await reputation.endorserCount(a.address)).to.equal(0n);
        expect(await reputation.reporterCount(a.address)).to.equal(0n);
        const [p, n, last] = await reputation.massesOf(a.address);
        expect([p, n, last]).to.deep.equal([0n, 0n, 0n]);
      }

      expect(await reputation.halfLifeSeconds()).to.equal(BigInt(HALF_LIFE));
      expect(await reputation.priorWad()).to.equal(PRIOR);
      expect(await reputation.trustThresholdWad()).to.equal(THRESHOLD);
      expect(await reputation.negativeMultiplierWad()).to.equal(NEG_MULT);
      expect(await reputation.baseEndorserWeightWad()).to.equal(BASE_W);
      expect(await reputation.maxEndorserWeightWad()).to.equal(MAX_W);
      expect(await reputation.endorseCooldown()).to.equal(BigInt(ENDORSE_COOLDOWN));
      expect(await reputation.reportCooldown()).to.equal(BigInt(REPORT_COOLDOWN));
      expect(await reputation.actorCooldown()).to.equal(BigInt(ACTOR_COOLDOWN));
      expect(await reputation.endorsementStakeWei()).to.equal(0n);
      expect(await reputation.stakeLockPeriod()).to.equal(BigInt(STAKE_LOCK));
      expect(await reputation.treasury()).to.equal(admin.address);
      expect(await reputation.treasuryBalance()).to.equal(0n);
      expect(await reputation.TRUST_LOG_CAPACITY()).to.equal(BigInt(TRUST_LOG_CAPACITY));
      expect(await reputation.getTrustLogLength()).to.equal(0n);
      expect(await reputation.hasRole(TREASURER_ROLE, admin.address)).to.equal(true);
    });
  });

  /* ====================================================================== */
  describe('endorseAgent', function () {
    it('adds exactly one base-weight edge and produces the documented score', async function () {
      const { reputation, agentA, agentB } = ctx;
      const tx = await reputation.connect(agentB).endorseAgent(agentA.address, 'accurate recall');
      const ts = await time.latest();

      const expected = score(BASE_W, 0n);
      await expect(tx)
        .to.emit(reputation, 'AgentEndorsed')
        .withArgs(
          agentB.address,
          agentA.address,
          BASE_W,
          0n,
          'accurate recall',
          ethers.id('accurate recall'),
        );
      await expect(tx)
        .to.emit(reputation, 'ReputationChanged')
        .withArgs(agentA.address, expected, BASE_W, 0n);

      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
      const [p, n] = await reputation.massesOf(agentA.address);
      expect(p).to.equal(BASE_W);
      expect(n).to.equal(0n);
      // 0.25 / (0.25 + 3) == 0.076923... - nowhere near the 0.6 trust line.
      expect(expected).to.equal(76923076923076923n);
      expect(await reputation.reputationOf(agentA.address)).to.equal(expected);
      expect(await reputation.reputationBps(agentA.address)).to.equal(769n);
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);

      const e = await reputation.getEndorsement(agentB.address, agentA.address);
      expect(e.weight).to.equal(BASE_W);
      expect(e.createdAt).to.equal(ts);
      expect(e.revokedAt).to.equal(0n);
      expect(e.stake).to.equal(0n);
      expect(e.stakeClaimed).to.equal(false);
      expect(e.slashed).to.equal(false);
      expect(await reputation.hasActiveEndorsement(agentB.address, agentA.address)).to.equal(true);
    });

    it('REGRESSION: one endorsement from one wallet does NOT make an agent trusted', async function () {
      const { reputation, agentA, agentB } = ctx;
      // The previous contract scored `endorsers * 1000 / (1 + 3 * negatives)` against a hardcoded
      // threshold of 500, so exactly this transaction flipped an agent to TRUSTED for the cost of one
      // throwaway address.
      await reputation.connect(agentB).endorseAgent(agentA.address, 'hi');
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);
      expect(await reputation.reputationOf(agentA.address)).to.be.lessThan(THRESHOLD);
    });

    it('rejects self-endorsement', async function () {
      const { reputation, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).endorseAgent(agentB.address, 'me'))
        .to.be.revertedWithCustomError(errs, 'SelfAction')
        .withArgs(agentB.address);
    });

    it('rejects an inactive endorser or target', async function () {
      const { reputation, identity, agentA, agentB, outsider, errs } = ctx;
      await expect(reputation.connect(outsider).endorseAgent(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);
      await expect(reputation.connect(agentB).endorseAgent(outsider.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);

      await identity.connect(agentA).deactivate();
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('rejects a second live endorsement of the same target', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'again'))
        .to.be.revertedWithCustomError(errs, 'AlreadyEndorsed')
        .withArgs(agentB.address, agentA.address);
    });

    it('rejects an oversize reason', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, strOfLength(129)))
        .to.be.revertedWithCustomError(errs, 'StringTooLong')
        .withArgs(field('reason'), 129, MAX_REASON_BYTES);
      // The cap itself is accepted.
      await reputation.connect(agentB).endorseAgent(agentA.address, strOfLength(MAX_REASON_BYTES));
    });

    it('rejects ether when staking is disabled', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: 1n }))
        .to.be.revertedWithCustomError(errs, 'InvalidStake')
        .withArgs(0n, 1n);
    });

    it('is blocked while paused', async function () {
      const { reputation, pauser, agentA, agentB, errs } = ctx;
      await reputation.connect(pauser).pause();
      await expect(
        reputation.connect(agentB).endorseAgent(agentA.address, 'x'),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('cooldowns', function () {
    it('enforces the per-pair cooldown after a revoke', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'changed my mind');

      await expect(
        reputation.connect(agentB).endorseAgent(agentA.address, 'again'),
      ).to.be.revertedWithCustomError(errs, 'CooldownActive');
      await time.increase(ENDORSE_COOLDOWN);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'again');
      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
    });

    it('enforces the per-actor cooldown across different targets', async function () {
      const { reputation, agentA, agentB, agentC, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await expect(
        reputation.connect(agentB).endorseAgent(agentC.address, 'y'),
      ).to.be.revertedWithCustomError(errs, 'CooldownActive');
      await time.increase(ACTOR_COOLDOWN);
      await reputation.connect(agentB).endorseAgent(agentC.address, 'y');
      expect(await reputation.endorserCount(agentC.address)).to.equal(1n);
    });

    it('zeroing the cooldowns removes both restrictions', async function () {
      const { reputation, paramAdmin, agentA, agentB, agentC } = ctx;
      await reputation.connect(paramAdmin).setCooldowns(0, 0, 0);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await reputation.connect(agentB).endorseAgent(agentC.address, 'y');
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'z');
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x2');
      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
      expect(await reputation.endorserCount(agentC.address)).to.equal(1n);
    });
  });

  /* ====================================================================== */
  describe('revokeEndorsement - the endorserCount regression', function () {
    it('returns the count and the mass to exactly zero', async function () {
      const { reputation, agentA, agentB } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      const tx = await reputation.connect(agentB).revokeEndorsement(agentA.address, 'withdrawn');
      const ts = await time.latest();

      await expect(tx)
        .to.emit(reputation, 'EndorsementRevoked')
        .withArgs(agentB.address, agentA.address, BASE_W, 'withdrawn', ethers.id('withdrawn'));

      expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
      const [p] = await reputation.massesOf(agentA.address);
      // The endorserCount == 0 anchor: no bucketed-decay dust may survive the last revocation.
      expect(p).to.equal(0n);
      expect(await reputation.reputationOf(agentA.address)).to.equal(0n);
      const e = await reputation.getEndorsement(agentB.address, agentA.address);
      expect(e.revokedAt).to.equal(ts);
      expect(await reputation.hasActiveEndorsement(agentB.address, agentA.address)).to.equal(false);
    });

    it('rejects revoking what was never endorsed, or revoking twice', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).revokeEndorsement(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'NotEndorsed')
        .withArgs(agentB.address, agentA.address);

      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'x');
      await expect(reputation.connect(agentB).revokeEndorsement(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'NotEndorsed')
        .withArgs(agentB.address, agentA.address);
    });

    it('decrements exactly one edge when several endorsers exist', async function () {
      const { reputation, agentA, registeredExtras } = ctx;
      const [e0, e1, e2] = registeredExtras;
      for (const w of [e0, e1, e2]) await reputation.connect(w).endorseAgent(agentA.address, 'x');

      expect(await reputation.endorserCount(agentA.address)).to.equal(3n);
      expect((await reputation.massesOf(agentA.address))[0]).to.equal(3n * BASE_W);

      await reputation.connect(e0).revokeEndorsement(agentA.address, 'x');
      expect(await reputation.endorserCount(agentA.address)).to.equal(2n);
      const [p] = await reputation.massesOf(agentA.address);
      expect(p).to.be.closeTo(2n * BASE_W, 10n ** 12n);
    });

    it('REGRESSION: endorse/report cycling cannot inflate endorserCount past one', async function () {
      const { reputation, paramAdmin, agentA, agentB } = ctx;
      await reputation.connect(paramAdmin).setCooldowns(0, 0, 0);

      // In the previous contract `endorserCount` was only ever incremented, and `reportAgent` merely
      // zeroed a local-trust entry, so this exact loop drove the count to 5 from a single wallet.
      for (let i = 0; i < 5; i++) {
        await reputation.connect(agentB).endorseAgent(agentA.address, `round ${i}`);
        expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
        await reputation.connect(agentB).reportAgent(agentA.address, `round ${i}`);
        expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
        await reputation.connect(agentB).withdrawReport(agentA.address, `round ${i}`);
      }

      await reputation.connect(agentB).endorseAgent(agentA.address, 'final');
      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
      expect(await reputation.reputationOf(agentA.address)).to.be.at.most(score(BASE_W, 0n));

      // ...and leaving the report standing makes the score strictly worse than a clean endorsement.
      await reputation.connect(agentB).reportAgent(agentA.address, 'final');
      expect(await reputation.reputationOf(agentA.address)).to.be.lessThan(score(BASE_W, 0n));
      expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('reportAgent', function () {
    it('adds negative mass scaled by the negative multiplier', async function () {
      const { reputation, agentA, agentB, agentC } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'good');
      const expectedRw = (BASE_W * NEG_MULT) / WAD;

      await expect(reputation.connect(agentC).reportAgent(agentA.address, 'memory poisoning'))
        .to.emit(reputation, 'AgentReported')
        .withArgs(
          agentC.address,
          agentA.address,
          expectedRw,
          'memory poisoning',
          ethers.id('memory poisoning'),
        );

      expect(await reputation.reporterCount(agentA.address)).to.equal(1n);
      const [p, n] = await reputation.massesOf(agentA.address);
      expect(p).to.equal(BASE_W);
      expect(n).to.equal(expectedRw);
      expect(await reputation.reputationOf(agentA.address)).to.equal(score(BASE_W, expectedRw));
      // 0.25 / (0.25 + 0.75 + 3) == 0.0625
      expect(await reputation.reputationOf(agentA.address)).to.equal(62500000000000000n);
      expect(await reputation.hasActiveReport(agentC.address, agentA.address)).to.equal(true);
    });

    it("weights a report by the reporter's own standing", async function () {
      const { reputation, agentA, agentB, agentC, registeredExtras } = ctx;
      // Build agentC up so its report bites harder than an unknown reporter's would.
      for (const w of registeredExtras.slice(0, 8)) {
        await reputation.connect(w).endorseAgent(agentC.address, 'x');
      }
      const cWeight = await reputation.previewEndorsementWeight(agentC.address);
      expect(cWeight).to.be.greaterThan(BASE_W);

      await reputation.connect(agentB).reportAgent(agentA.address, 'weak');
      const weakN = (await reputation.massesOf(agentA.address))[1];
      await reputation.connect(agentC).reportAgent(agentA.address, 'strong');
      const bothN = (await reputation.massesOf(agentA.address))[1];

      expect(weakN).to.equal((BASE_W * NEG_MULT) / WAD);
      expect(bothN - weakN).to.equal((cWeight * NEG_MULT) / WAD);
      expect(bothN - weakN).to.be.greaterThan(weakN);
    });

    it("auto-revokes the reporter's own endorsement in the same transaction", async function () {
      const { reputation, agentA, agentB } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'good');
      await time.increase(ENDORSE_COOLDOWN);

      const tx = await reputation.connect(agentB).reportAgent(agentA.address, 'actually poisoned');
      const ts = await time.latest();

      // The edge really is torn down, and - crucially for any off-chain mirror - it says so in the log.
      await expect(tx)
        .to.emit(reputation, 'EndorsementRevoked')
        .withArgs(
          agentB.address,
          agentA.address,
          BASE_W,
          'actually poisoned',
          ethers.id('actually poisoned'),
        );

      expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
      expect((await reputation.getEndorsement(agentB.address, agentA.address)).revokedAt).to.equal(
        ts,
      );
      const [p, n] = await reputation.massesOf(agentA.address);
      expect(p).to.equal(0n);
      expect(n).to.equal((BASE_W * NEG_MULT) / WAD);
    });

    it('rejects self-report and double reporting', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).reportAgent(agentB.address, 'me'))
        .to.be.revertedWithCustomError(errs, 'SelfAction')
        .withArgs(agentB.address);

      await reputation.connect(agentB).reportAgent(agentA.address, 'x');
      await expect(reputation.connect(agentB).reportAgent(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'AlreadyReported')
        .withArgs(agentB.address, agentA.address);
    });

    it('withdrawReport removes the evidence exactly', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).withdrawReport(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'NotReported')
        .withArgs(agentB.address, agentA.address);

      await reputation.connect(agentB).reportAgent(agentA.address, 'x');
      const expectedRw = (BASE_W * NEG_MULT) / WAD;
      await expect(reputation.connect(agentB).withdrawReport(agentA.address, 'mistake'))
        .to.emit(reputation, 'ReportWithdrawn')
        .withArgs(agentB.address, agentA.address, expectedRw, 'mistake', ethers.id('mistake'));

      expect(await reputation.reporterCount(agentA.address)).to.equal(0n);
      expect((await reputation.massesOf(agentA.address))[1]).to.equal(0n);
      await expect(reputation.connect(agentB).withdrawReport(agentA.address, 'again'))
        .to.be.revertedWithCustomError(errs, 'NotReported')
        .withArgs(agentB.address, agentA.address);
    });
  });

  /* ====================================================================== */
  describe('endorser weighting (one-hop transitive trust)', function () {
    it('gives an unknown endorser exactly the base weight', async function () {
      const { reputation, agentB } = ctx;
      expect(await reputation.previewEndorsementWeight(agentB.address)).to.equal(BASE_W);
    });

    it('rises monotonically toward the ceiling and never past it', async function () {
      const { reputation, agentB, registeredExtras } = ctx;
      let previous = await reputation.previewEndorsementWeight(agentB.address);
      for (const w of registeredExtras) {
        await reputation.connect(w).endorseAgent(agentB.address, 'x');
        const current = await reputation.previewEndorsementWeight(agentB.address);
        expect(current).to.be.at.least(previous);
        expect(current).to.be.at.most(MAX_W);
        expect(current).to.equal(weightFor(await reputation.reputationOf(agentB.address)));
        previous = current;
      }
      expect(previous).to.be.greaterThan(BASE_W);
    });

    it('freezes the previewed weight into the edge it creates', async function () {
      const { reputation, agentB, agentC, registeredExtras } = ctx;
      for (const w of registeredExtras.slice(0, 6)) {
        await reputation.connect(w).endorseAgent(agentB.address, 'x');
      }
      const preview = await reputation.previewEndorsementWeight(agentB.address);
      await reputation.connect(agentB).endorseAgent(agentC.address, 'vouch');
      expect((await reputation.getEndorsement(agentB.address, agentC.address)).weight).to.equal(
        preview,
      );
      expect((await reputation.massesOf(agentC.address))[0]).to.equal(preview);
    });
  });

  /* ====================================================================== */
  describe('sybil resistance', function () {
    it('needs the arithmetically documented 18 distinct fresh endorsers, not two', async function () {
      const { reputation, agentA, registeredExtras } = ctx;

      // ceil(prior * threshold / ((1 - threshold) * base)) with the deployed defaults.
      const needed = Number(
        (PRIOR * THRESHOLD + ((WAD - THRESHOLD) * BASE_W - 1n)) / ((WAD - THRESHOLD) * BASE_W),
      );
      expect(needed).to.equal(18);

      for (let i = 0; i < 5; i++) {
        await reputation.connect(registeredExtras[i]).endorseAgent(agentA.address, 'x');
      }
      // Five throwaway wallets are not enough - and each one had to be separately registered.
      expect(await reputation.reputationOf(agentA.address)).to.equal(score(5n * BASE_W, 0n));
      expect(await reputation.reputationOf(agentA.address)).to.be.lessThan(THRESHOLD);
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);

      for (let i = 5; i < 17; i++) {
        await reputation.connect(registeredExtras[i]).endorseAgent(agentA.address, 'x');
      }
      expect(await reputation.endorserCount(agentA.address)).to.equal(17n);
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);

      await reputation.connect(registeredExtras[17]).endorseAgent(agentA.address, 'x');
      expect((await reputation.massesOf(agentA.address))[0]).to.equal(18n * BASE_W);
      // P = 4.5, score = 4.5 / 7.5 = 0.6 exactly, which is the threshold.
      expect(await reputation.reputationOf(agentA.address)).to.equal(THRESHOLD);
      expect(await reputation.isTrusted(agentA.address)).to.equal(true);
    });
  });

  /* ====================================================================== */
  describe('stake escrow', function () {
    const STAKE = ethers.parseEther('0.01');

    beforeEach(async function () {
      await ctx.reputation.connect(ctx.paramAdmin).setEndorsementStake(STAKE);
    });

    it('requires the exact stake and escrows it', async function () {
      const { reputation, reputationAddr, agentA, agentB, errs } = ctx;
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'x'))
        .to.be.revertedWithCustomError(errs, 'InvalidStake')
        .withArgs(STAKE, 0n);
      await expect(
        reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE + 1n }),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidStake')
        .withArgs(STAKE, STAKE + 1n);

      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
      expect(await ethers.provider.getBalance(reputationAddr)).to.equal(STAKE);
      expect((await reputation.getEndorsement(agentB.address, agentA.address)).stake).to.equal(
        STAKE,
      );
    });

    it('locks the stake until revocation plus the lock period, then pays exactly once', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });

      await expect(
        reputation.connect(agentB).claimStake(agentA.address),
      ).to.be.revertedWithCustomError(errs, 'StakeLocked');
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'x');
      await expect(
        reputation.connect(agentB).claimStake(agentA.address),
      ).to.be.revertedWithCustomError(errs, 'StakeLocked');

      await time.increase(STAKE_LOCK);
      const claim = reputation.connect(agentB).claimStake(agentA.address);
      await expect(claim).to.changeEtherBalances([agentB, reputation], [STAKE, -STAKE]);
      await expect(claim)
        .to.emit(reputation, 'StakeClaimed')
        .withArgs(agentB.address, agentA.address, STAKE);

      await expect(reputation.connect(agentB).claimStake(agentA.address))
        .to.be.revertedWithCustomError(errs, 'NothingToClaim')
        .withArgs(agentB.address, agentA.address);
    });

    it('refuses a re-endorsement that would strand an unclaimed stake', async function () {
      const { reputation, agentA, agentB, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'x');
      await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'x2', { value: STAKE }))
        .to.be.revertedWithCustomError(errs, 'UnclaimedStake')
        .withArgs(agentB.address, agentA.address);

      await time.increase(STAKE_LOCK);
      await reputation.connect(agentB).claimStake(agentA.address);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x2', { value: STAKE });
      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
    });

    it('reverts NothingToClaim when there is no escrow at all', async function () {
      const { reputation, agentA, agentC, errs } = ctx;
      await expect(reputation.connect(agentC).claimStake(agentA.address))
        .to.be.revertedWithCustomError(errs, 'NothingToClaim')
        .withArgs(agentC.address, agentA.address);
    });

    it('DOCUMENTED EXEMPTION: claimStake works while paused - funds must stay exitable', async function () {
      const { reputation, pauser, agentA, agentB } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'x');
      await time.increase(STAKE_LOCK);
      await reputation.connect(pauser).pause();
      await expect(reputation.connect(agentB).claimStake(agentA.address)).to.changeEtherBalances(
        [agentB, reputation],
        [STAKE, -STAKE],
      );
    });

    it('refuses a plain ether transfer - there is no receive() or fallback()', async function () {
      const { reputationAddr, agentB } = ctx;
      await expect(agentB.sendTransaction({ to: reputationAddr, value: 1n })).to.be.reverted;
      expect(await ethers.provider.getBalance(reputationAddr)).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('slashing and treasury', function () {
    const STAKE = ethers.parseEther('0.01');

    beforeEach(async function () {
      await ctx.reputation.connect(ctx.paramAdmin).setEndorsementStake(STAKE);
      await ctx.reputation
        .connect(ctx.agentB)
        .endorseAgent(ctx.agentA.address, 'x', { value: STAKE });
    });

    it('removes the edge and confiscates the escrow to the treasury balance', async function () {
      const { reputation, slasher, agentA, agentB, errs } = ctx;
      await expect(
        reputation
          .connect(slasher)
          .slashEndorsement(agentB.address, agentA.address, field('collusion')),
      )
        .to.emit(reputation, 'EndorsementSlashed')
        .withArgs(agentB.address, agentA.address, slasher.address, STAKE, field('collusion'));

      expect(await reputation.endorserCount(agentA.address)).to.equal(0n);
      expect((await reputation.massesOf(agentA.address))[0]).to.equal(0n);
      expect((await reputation.getEndorsement(agentB.address, agentA.address)).slashed).to.equal(
        true,
      );
      expect(await reputation.treasuryBalance()).to.equal(STAKE);

      await time.increase(STAKE_LOCK);
      await expect(reputation.connect(agentB).claimStake(agentA.address))
        .to.be.revertedWithCustomError(errs, 'StakeAlreadySlashed')
        .withArgs(agentB.address, agentA.address);
    });

    it('is restricted to SLASHER_ROLE and requires a live edge', async function () {
      const { reputation, slasher, outsider, agentA, agentC, errs } = ctx;
      await expect(
        reputation
          .connect(outsider)
          .slashEndorsement(ctx.agentB.address, agentA.address, field('x')),
      )
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, SLASHER_ROLE);
      await expect(
        reputation.connect(slasher).slashEndorsement(agentC.address, agentA.address, field('x')),
      )
        .to.be.revertedWithCustomError(errs, 'NotEndorsed')
        .withArgs(agentC.address, agentA.address);
    });

    it('lets the treasurer withdraw, bounded by treasuryBalance', async function () {
      const { reputation, slasher, admin, agentA, agentB, outsider, errs } = ctx;
      await reputation
        .connect(slasher)
        .slashEndorsement(agentB.address, agentA.address, field('x'));

      await expect(reputation.connect(outsider).withdrawTreasury(outsider.address, 1n))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, TREASURER_ROLE);
      await expect(
        reputation.connect(admin).withdrawTreasury(ethers.ZeroAddress, 1n),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(reputation.connect(admin).withdrawTreasury(admin.address, 0n))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('amount'), 0n);
      await expect(reputation.connect(admin).withdrawTreasury(admin.address, STAKE + 1n))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('amount'), STAKE + 1n);

      await expect(
        reputation.connect(admin).withdrawTreasury(admin.address, STAKE),
      ).to.changeEtherBalances([admin, reputation], [STAKE, -STAKE]);
      expect(await reputation.treasuryBalance()).to.equal(0n);
    });

    it('keeps treasury accounting atomic when the recipient rejects the transfer', async function () {
      const { reputation, slasher, admin, agentA, agentB, errs } = ctx;
      await reputation
        .connect(slasher)
        .slashEndorsement(agentB.address, agentA.address, field('x'));

      const receiver = await (await ethers.getContractFactory('RevertingReceiver')).deploy();
      await receiver.waitForDeployment();
      const addr = await receiver.getAddress();

      await reputation.connect(admin).setTreasury(addr);
      await expect(reputation.connect(admin).withdrawTreasury(addr, STAKE))
        .to.be.revertedWithCustomError(errs, 'EtherTransferFailed')
        .withArgs(addr, STAKE);
      expect(await reputation.treasuryBalance()).to.equal(STAKE);
      expect(await ethers.provider.getBalance(await reputation.getAddress())).to.equal(STAKE);
    });

    it('surfaces EtherTransferFailed when an endorser cannot receive its own stake back', async function () {
      const { reputationAddr, identityAddr, agentA, errs } = ctx;
      const receiver = await (await ethers.getContractFactory('RevertingReceiver')).deploy();
      await receiver.waitForDeployment();
      await receiver.register(identityAddr, validPubKey('rr'));
      await receiver.endorse(reputationAddr, agentA.address, { value: STAKE });
      await receiver.revoke(reputationAddr, agentA.address);
      await time.increase(STAKE_LOCK);
      await expect(receiver.claim(reputationAddr, agentA.address)).to.be.revertedWithCustomError(
        errs,
        'EtherTransferFailed',
      );
    });
  });

  /* ====================================================================== */
  describe('reentrancy on claimStake', function () {
    const STAKE = ethers.parseEther('0.01');

    async function armedEndorser(attacking) {
      const { reputation, reputationAddr, identityAddr, agentA, deployer } = ctx;
      const mock = await (await ethers.getContractFactory('ReentrantEndorser')).deploy();
      await mock.waitForDeployment();
      await mock.register(identityAddr, validPubKey(`re-${attacking}`));
      await mock.connect(deployer).endorse(reputationAddr, agentA.address, { value: STAKE });
      await mock.revoke(reputationAddr, agentA.address);
      await time.increase(STAKE_LOCK);
      await mock.setAttacking(attacking);
      void reputation;
      return mock;
    }

    beforeEach(async function () {
      await ctx.reputation.connect(ctx.paramAdmin).setEndorsementStake(STAKE);
    });

    it('pays exactly once even when the receive hook re-enters', async function () {
      const { reputation, reputationAddr, agentA } = ctx;
      const mock = await armedEndorser(true);
      const mockAddr = await mock.getAddress();

      const before = await ethers.provider.getBalance(reputationAddr);
      await mock.claim(reputationAddr, agentA.address);

      // The hook really ran (the test is not vacuous) and the re-entrant call was rejected...
      expect(await mock.reentered()).to.equal(true);
      expect(await mock.lastError()).to.equal('custom error');
      // ...and the escrow left the contract exactly once.
      expect(await ethers.provider.getBalance(reputationAddr)).to.equal(before - STAKE);
      expect(await ethers.provider.getBalance(mockAddr)).to.equal(STAKE);
      expect((await reputation.getEndorsement(mockAddr, agentA.address)).stakeClaimed).to.equal(
        true,
      );
    });

    it('pays exactly once on the honest path', async function () {
      const { reputationAddr, agentA } = ctx;
      const mock = await armedEndorser(false);
      const mockAddr = await mock.getAddress();
      await mock.claim(reputationAddr, agentA.address);
      expect(await mock.reentered()).to.equal(false);
      expect(await ethers.provider.getBalance(mockAddr)).to.equal(STAKE);
      expect(await ethers.provider.getBalance(reputationAddr)).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('trust log ring buffer', function () {
    beforeEach(async function () {
      const { reputation, agentA, registeredExtras } = ctx;
      for (const w of registeredExtras) {
        await reputation.connect(w).endorseAgent(agentA.address, 'vouch');
      }
    });

    it('reports the lifetime count while retaining only the capacity', async function () {
      const { reputation, agentA, registeredExtras, errs } = ctx;
      expect(await reputation.getTrustLogLength()).to.equal(20n);

      const [page, total] = await reputation.getTrustEvents(0, 10);
      expect(total).to.equal(20n);
      expect(page.length).to.equal(10);

      // Newest first, strictly non-increasing timestamps.
      for (let i = 1; i < page.length; i++) {
        expect(page[i].timestamp).to.be.at.most(page[i - 1].timestamp);
      }
      expect(page[0].from).to.equal(registeredExtras[19].address);
      expect(page[0].to).to.equal(agentA.address);
      expect(page[0].kind).to.equal(TrustEventKind.Endorse);
      expect(page[0].weight).to.equal(BASE_W);
      // Only the hash of the reason is retained on chain; the plaintext lives in the event log.
      expect(page[0].reasonHash).to.equal(ethers.id('vouch'));

      const [full] = await reputation.getTrustEvents(0, TRUST_LOG_CAPACITY);
      expect(full.length).to.equal(TRUST_LOG_CAPACITY);
      // The four oldest events have scrolled out of the ring for good.
      expect(full.map((e) => e.from)).to.deep.equal(
        registeredExtras
          .slice(4)
          .map((w) => w.address)
          .reverse(),
      );

      const [empty, total2] = await reputation.getTrustEvents(TRUST_LOG_CAPACITY, 5);
      expect(empty).to.deep.equal([]);
      expect(total2).to.equal(20n);

      await expect(reputation.getTrustEvents(0, 0))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(0, MAX_PAGE_SIZE);
      await expect(reputation.getTrustEvents(0, MAX_PAGE_SIZE + 1))
        .to.be.revertedWithCustomError(errs, 'InvalidPageSize')
        .withArgs(MAX_PAGE_SIZE + 1, MAX_PAGE_SIZE);
    });

    it('stays bounded after a hundred further events', async function () {
      this.timeout(300000);
      const { reputation, agentA, registeredExtras } = ctx;
      for (let round = 0; round < 3; round++) {
        for (const w of registeredExtras) {
          await reputation.connect(w).revokeEndorsement(agentA.address, 'r');
        }
        await time.increase(ENDORSE_COOLDOWN);
        for (const w of registeredExtras) {
          await reputation.connect(w).endorseAgent(agentA.address, 'e');
        }
        await time.increase(ENDORSE_COOLDOWN);
      }
      expect(await reputation.getTrustLogLength()).to.equal(140n);
      const [page, total] = await reputation.getTrustEvents(0, TRUST_LOG_CAPACITY);
      expect(page.length).to.equal(TRUST_LOG_CAPACITY);
      expect(total).to.equal(140n);
    });
  });

  /* ====================================================================== */
  describe('governed parameters', function () {
    const cases = [
      {
        fn: 'setHalfLife',
        name: 'halfLife',
        get: 'halfLifeSeconds',
        ok: [7 * 24 * 3600],
        bad: [0, MIN_HALF_LIFE - 60, MAX_HALF_LIFE + 24 * 3600],
      },
      {
        fn: 'setPrior',
        name: 'prior',
        get: 'priorWad',
        ok: [5n * WAD],
        bad: [10n ** 16n, MAX_PRIOR_WAD + WAD],
      },
      {
        fn: 'setTrustThreshold',
        name: 'threshold',
        get: 'trustThresholdWad',
        ok: [(7n * WAD) / 10n],
        bad: [0n, WAD],
      },
      {
        fn: 'setNegativeMultiplier',
        name: 'negMultiplier',
        get: 'negativeMultiplierWad',
        ok: [2n * WAD],
        bad: [(9n * WAD) / 10n, MAX_NEG_MULTIPLIER_WAD + WAD],
      },
      {
        fn: 'setStakeLockPeriod',
        name: 'stakeLock',
        get: 'stakeLockPeriod',
        ok: [3 * 24 * 3600],
        bad: [MAX_STAKE_LOCK + 1],
      },
      {
        fn: 'setEndorsementStake',
        name: 'stake',
        get: 'endorsementStakeWei',
        ok: [ethers.parseEther('0.5')],
        bad: [],
      },
    ];

    for (const c of cases) {
      it(`${c.fn} moves the value, emits ParameterUpdated and enforces its bounds`, async function () {
        const { reputation, paramAdmin, outsider, errs } = ctx;
        for (const value of c.ok) {
          const previous = await reputation[c.get]();
          await expect(reputation.connect(paramAdmin)[c.fn](value))
            .to.emit(reputation, 'ParameterUpdated')
            .withArgs(field(c.name), previous, value);
          expect(await reputation[c.get]()).to.equal(value);
        }
        for (const value of c.bad) {
          await expect(reputation.connect(paramAdmin)[c.fn](value))
            .to.be.revertedWithCustomError(errs, 'InvalidParameter')
            .withArgs(field(c.name), value);
        }
        await expect(reputation.connect(outsider)[c.fn](c.ok[0]))
          .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
          .withArgs(outsider.address, PARAM_ADMIN_ROLE);
      });
    }

    it('setEndorserWeights moves both bounds atomically and rejects an inverted pair', async function () {
      const { reputation, paramAdmin, outsider, errs } = ctx;
      await expect(reputation.connect(paramAdmin).setEndorserWeights(WAD / 10n, (15n * WAD) / 10n))
        .to.emit(reputation, 'ParameterUpdated')
        .withArgs(field('baseWeight'), BASE_W, WAD / 10n)
        .and.to.emit(reputation, 'ParameterUpdated')
        .withArgs(field('maxWeight'), MAX_W, (15n * WAD) / 10n);
      expect(await reputation.baseEndorserWeightWad()).to.equal(WAD / 10n);
      expect(await reputation.maxEndorserWeightWad()).to.equal((15n * WAD) / 10n);

      await expect(reputation.connect(paramAdmin).setEndorserWeights(0n, WAD))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('baseWeight'), 0n);
      // base > max would make previewEndorsementWeight underflow, so it is refused outright.
      await expect(reputation.connect(paramAdmin).setEndorserWeights(2n * WAD, WAD))
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('baseWeight'), 2n * WAD);
      await expect(
        reputation.connect(paramAdmin).setEndorserWeights(WAD, MAX_ENDORSER_WEIGHT_WAD + 1n),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidParameter')
        .withArgs(field('maxWeight'), MAX_ENDORSER_WEIGHT_WAD + 1n);
      await expect(reputation.connect(outsider).setEndorserWeights(WAD / 10n, WAD))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, PARAM_ADMIN_ROLE);
    });

    it('setCooldowns moves all three and bounds each independently', async function () {
      const { reputation, paramAdmin, outsider, errs } = ctx;
      await expect(reputation.connect(paramAdmin).setCooldowns(60, 120, 30))
        .to.emit(reputation, 'ParameterUpdated')
        .withArgs(field('endorseCooldown'), BigInt(ENDORSE_COOLDOWN), 60n)
        .and.to.emit(reputation, 'ParameterUpdated')
        .withArgs(field('reportCooldown'), BigInt(REPORT_COOLDOWN), 120n)
        .and.to.emit(reputation, 'ParameterUpdated')
        .withArgs(field('actorCooldown'), BigInt(ACTOR_COOLDOWN), 30n);
      expect(await reputation.endorseCooldown()).to.equal(60n);
      expect(await reputation.reportCooldown()).to.equal(120n);
      expect(await reputation.actorCooldown()).to.equal(30n);

      for (const [args, name, value] of [
        [[MAX_COOLDOWN + 1, 0, 0], 'endorseCooldown', MAX_COOLDOWN + 1],
        [[0, MAX_COOLDOWN + 1, 0], 'reportCooldown', MAX_COOLDOWN + 1],
        [[0, 0, MAX_COOLDOWN + 1], 'actorCooldown', MAX_COOLDOWN + 1],
      ]) {
        await expect(reputation.connect(paramAdmin).setCooldowns(...args))
          .to.be.revertedWithCustomError(errs, 'InvalidParameter')
          .withArgs(field(name), value);
      }
      await expect(reputation.connect(outsider).setCooldowns(1, 1, 1))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(outsider.address, PARAM_ADMIN_ROLE);
    });

    it('setTreasury is a DEFAULT_ADMIN decision, not a PARAM_ADMIN one', async function () {
      const { reputation, admin, paramAdmin, outsider, errs } = ctx;
      await expect(reputation.connect(paramAdmin).setTreasury(outsider.address))
        .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
        .withArgs(paramAdmin.address, DEFAULT_ADMIN_ROLE);
      await expect(
        reputation.connect(admin).setTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(errs, 'ZeroAddress');
      await expect(reputation.connect(admin).setTreasury(outsider.address))
        .to.emit(reputation, 'TreasuryUpdated')
        .withArgs(admin.address, outsider.address);
      expect(await reputation.treasury()).to.equal(outsider.address);
    });

    it('raising the threshold retires a previously trusted agent with no other state change', async function () {
      const { reputation, paramAdmin, agentA, agentB } = ctx;
      await reputation.connect(paramAdmin).setTrustThreshold(WAD / 20n);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      expect(await reputation.isTrusted(agentA.address)).to.equal(true);

      const before = await reputation.reputationOf(agentA.address);
      await reputation.connect(paramAdmin).setTrustThreshold((9n * WAD) / 10n);
      expect(await reputation.isTrusted(agentA.address)).to.equal(false);
      expect(await reputation.reputationOf(agentA.address)).to.equal(before);
      expect(await reputation.endorserCount(agentA.address)).to.equal(1n);
    });
  });

  /* ====================================================================== */
  describe('settle', function () {
    it('is permissionless and batched, with a bounded batch size', async function () {
      const { reputation, outsider, agentA, agentB, errs } = ctx;
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');
      await reputation.connect(outsider).settle(agentA.address);
      // NM-04: the clock advances only by the time the bucketed factor consumed, so the residual
      // (< halfLife/16) is carried and lastSettledAt trails block.timestamp.
      expect((await reputation.massesOf(agentA.address))[2]).to.be.lte(await time.latest());

      const many = new Array(51).fill(agentA.address);
      await expect(reputation.connect(outsider).settleBatch(many))
        .to.be.revertedWithCustomError(errs, 'BatchTooLarge')
        .withArgs(51, 50);
      await reputation.connect(outsider).settleBatch(new Array(50).fill(agentA.address));
    });
  });
});
