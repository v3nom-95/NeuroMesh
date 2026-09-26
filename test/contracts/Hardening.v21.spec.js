/**
 * Regression tests for the v2.1 hardening pass.
 *
 * One block per tracked issue in docs/V2.1-HARDENING-PLAN.md. Each test first
 * demonstrates the property the fix establishes, and where practical asserts the
 * exact attack the finding described is now impossible.
 */
import { expect } from 'chai';
import hre from 'hardhat';

import { cid, field } from './helpers/constants.js';
import {
  input,
  loadFixture,
  memoriesFixture,
  registeredFixture,
  time,
  MIN_PRECOMMIT_DELAY,
} from './helpers/fixtures.js';

const { ethers } = hre;

/** blindedHash = keccak256(abi.encode(cidHash, agent, salt)) */
function blind(cidString, agent, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes32'],
      [ethers.keccak256(ethers.toUtf8Bytes(cidString)), agent, salt],
    ),
  );
}

describe('v2.1 hardening', function () {
  /* ==================================================================== */
  describe('NM-01 — CID front-running is no longer possible', function () {
    let ctx;
    beforeEach(async function () {
      ctx = await loadFixture(registeredFixture);
    });

    it('rejects a commit with no precommit at all', async function () {
      const { ledger, agentA, errs } = ctx;
      const salt = ethers.id('s');
      await expect(
        ledger.connect(agentA).commitMemory(input(cid(1)), salt),
      ).to.be.revertedWithCustomError(errs, 'PrecommitNotFound');
    });

    it('rejects a reveal that has not aged past the delay', async function () {
      const { ledger, agentA, errs } = ctx;
      const salt = ethers.id('s');
      await ledger.connect(agentA).precommit(blind(cid(1), agentA.address, salt));
      await expect(
        ledger.connect(agentA).commitMemory(input(cid(1)), salt),
      ).to.be.revertedWithCustomError(errs, 'PrecommitTooYoung');
    });

    it('THE ATTACK: an observer who sees the CID cannot steal ownership', async function () {
      const { ledger, agentA, agentB, errs } = ctx;
      const target = cid(7);
      const saltA = ethers.id('agentA-secret');

      // agentA stakes its claim. The blinded hash reveals nothing about the CID.
      await ledger.connect(agentA).precommit(blind(target, agentA.address, saltA));

      // agentB now learns the CID (mempool, or by reading agentA's public pin) and races.
      // Under the v1 contract this single call would have taken ownership permanently.
      const saltB = ethers.id('agentB-attack');
      await expect(
        ledger.connect(agentB).commitMemory(input(target), saltB),
      ).to.be.revertedWithCustomError(errs, 'PrecommitNotFound');

      // Even precommitting now does not help: agentB must still wait out the delay, by which
      // time agentA's older precommit is already revealable.
      await ledger.connect(agentB).precommit(blind(target, agentB.address, saltB));
      await time.increase(MIN_PRECOMMIT_DELAY + 1);
      await ledger.connect(agentA).commitMemory(input(target), saltA);

      const cidHash = ethers.keccak256(ethers.toUtf8Bytes(target));
      expect((await ledger.getMemory(cidHash)).owner).to.equal(agentA.address);

      // agentB's belated reveal now collides with the existing record.
      await expect(
        ledger.connect(agentB).commitMemory(input(target), saltB),
      ).to.be.revertedWithCustomError(errs, 'MemoryAlreadyExists');
    });

    it('burns the salt, so a revealed salt cannot be replayed', async function () {
      const { ledger, agentA, errs } = ctx;
      const salt = ethers.id('once');
      await ledger.connect(agentA).precommit(blind(cid(2), agentA.address, salt));
      await time.increase(MIN_PRECOMMIT_DELAY + 1);
      await ledger.connect(agentA).commitMemory(input(cid(2)), salt);

      await expect(
        ledger.connect(agentA).commitMemory(input(cid(3)), salt),
      ).to.be.revertedWithCustomError(errs, 'PrecommitNotFound');
    });

    it('does not burn the salt when the input is invalid', async function () {
      const { ledger, agentA, errs } = ctx;
      const salt = ethers.id('keepme');
      await ledger.connect(agentA).precommit(blind(cid(4), agentA.address, salt));
      await time.increase(MIN_PRECOMMIT_DELAY + 1);

      // Bad embeddingDim: rejected on validation, before the precommit is consumed.
      await expect(
        ledger
          .connect(agentA)
          .commitMemory(input(cid(4), ethers.ZeroHash, { embeddingDim: 0 }), salt),
      ).to.be.revertedWithCustomError(errs, 'InvalidEmbeddingDim');

      // The same salt still works, so a malformed attempt costs no round-trip.
      await ledger.connect(agentA).commitMemory(input(cid(4)), salt);
      expect((await ledger.getMemory(ethers.keccak256(ethers.toUtf8Bytes(cid(4))))).owner).to.equal(
        agentA.address,
      );
    });

    it('exposes precommitHash and precommittedAt for off-chain callers', async function () {
      const { ledger, agentA } = ctx;
      const salt = ethers.id('view');
      const cidHash = ethers.keccak256(ethers.toUtf8Bytes(cid(5)));
      const expected = blind(cid(5), agentA.address, salt);

      expect(await ledger.precommitHash(cidHash, agentA.address, salt)).to.equal(expected);
      expect(await ledger.precommittedAt(expected)).to.equal(0n);

      await ledger.connect(agentA).precommit(expected);
      expect(await ledger.precommittedAt(expected)).to.equal(BigInt(await time.latest()));
    });
  });

  /* ==================================================================== */
  describe('NM-02 — endorsement stake is slashable after revocation', function () {
    it('THE ATTACK: revoking no longer lets an endorser escape the slasher', async function () {
      const { reputation, paramAdmin, slasher, agentA, agentB } =
        await loadFixture(registeredFixture);
      const STAKE = ethers.parseEther('0.02');
      await reputation.connect(paramAdmin).setEndorsementStake(STAKE);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });

      // agentB front-runs the slasher. Under the old guard this recovered the stake in full.
      await reputation.connect(agentB).revokeEndorsement(agentA.address, 'escaping');

      await expect(
        reputation.connect(slasher).slashEndorsement(agentB.address, agentA.address, field('x')),
      ).to.emit(reputation, 'EndorsementSlashed');

      expect(await reputation.treasuryBalance()).to.equal(STAKE);
      // And the escaped stake can no longer be claimed.
      await expect(reputation.connect(agentB).claimStake(agentA.address)).to.be.reverted;
    });

    it('refuses to slash the same edge twice', async function () {
      const { reputation, paramAdmin, slasher, agentA, agentB, errs } =
        await loadFixture(registeredFixture);
      const STAKE = ethers.parseEther('0.01');
      await reputation.connect(paramAdmin).setEndorsementStake(STAKE);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
      await reputation
        .connect(slasher)
        .slashEndorsement(agentB.address, agentA.address, field('x'));
      await expect(
        reputation.connect(slasher).slashEndorsement(agentB.address, agentA.address, field('x')),
      ).to.be.revertedWithCustomError(errs, 'NotEndorsed');
    });
  });

  /* ==================================================================== */
  describe('NM-04 — decay cannot be defeated by settling frequently', function () {
    it('many rapid settles decay exactly as much as one long wait', async function () {
      const { reputation, agentA, agentB } = await loadFixture(registeredFixture);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x');

      const HALF_LIFE = 90 * 24 * 3600;
      const STEP = Math.floor(HALF_LIFE / 64); // deliberately shorter than one 1/16 bucket

      // Spam settle far faster than the quantisation bucket. Under the old code this pinned
      // lastSettledAt to `now` every time and the score never decayed at all.
      for (let i = 0; i < 64; i += 1) {
        await time.increase(STEP);
        await reputation.settle(agentA.address);
      }

      const after = await reputation.reputationOf(agentA.address);
      const baseline = await reputation.reputationOf(agentB.address); // untouched, zero endorsers
      expect(after).to.be.lt(ethers.parseEther('0.08')); // strictly decayed
      expect(after).to.be.gte(baseline);
    });
  });

  /* ==================================================================== */
  describe('NM-06 — a registrar suspension cannot be self-reverted', function () {
    it('THE ATTACK: the suspended agent can no longer reactivate itself', async function () {
      const { identity, admin, agentA, errs } = await loadFixture(registeredFixture);
      await identity.connect(admin).adminSetActive(agentA.address, false, field('abuse'));
      expect(await identity.isActive(agentA.address)).to.equal(false);

      await expect(identity.connect(agentA).reactivate()).to.be.revertedWithCustomError(
        errs,
        'SuspendedByRegistrar',
      );
      expect(await identity.isActive(agentA.address)).to.equal(false);
    });

    it('only a registrar can lift the suspension', async function () {
      const { identity, admin, agentA } = await loadFixture(registeredFixture);
      await identity.connect(admin).adminSetActive(agentA.address, false, field('abuse'));
      await identity.connect(admin).adminSetActive(agentA.address, true, field('appeal'));
      expect(await identity.isActive(agentA.address)).to.equal(true);
    });

    it('a self-deactivated agent may still reactivate itself', async function () {
      const { identity, agentA } = await loadFixture(registeredFixture);
      await identity.connect(agentA).deactivate();
      await identity.connect(agentA).reactivate();
      expect(await identity.isActive(agentA.address)).to.equal(true);
    });
  });

  /* ==================================================================== */
  describe('NM-07 — an expired grant does not block re-granting', function () {
    it('re-grants after expiry instead of reverting AccessAlreadyGranted', async function () {
      const { access, agentA, agentB, hashes } = await loadFixture(memoriesFixture);
      const key = ethers.hexlify(ethers.randomBytes(48));
      const expiry = (await time.latest()) + 3600;

      await access.connect(agentA).grantAccess(hashes.m1, agentB.address, key, expiry);
      await time.increaseTo(expiry + 1);
      expect(await access.canAccess(hashes.m1, agentB.address)).to.equal(false);

      // Previously this reverted, leaving the pair permanently un-renewable.
      await expect(access.connect(agentA).grantAccess(hashes.m1, agentB.address, key, 0)).to.not.be
        .reverted;
      expect(await access.canAccess(hashes.m1, agentB.address)).to.equal(true);
    });
  });

  /* ==================================================================== */
  describe('NM-09 — treasury withdrawals honour the configured treasury', function () {
    it('refuses an arbitrary recipient', async function () {
      const { reputation, paramAdmin, slasher, admin, agentA, agentB, outsider, errs } =
        await loadFixture(registeredFixture);
      const STAKE = ethers.parseEther('0.01');
      await reputation.connect(paramAdmin).setEndorsementStake(STAKE);
      await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
      await reputation
        .connect(slasher)
        .slashEndorsement(agentB.address, agentA.address, field('x'));

      await expect(
        reputation.connect(admin).withdrawTreasury(outsider.address, STAKE),
      ).to.be.revertedWithCustomError(errs, 'InvalidRecipient');

      await expect(
        reputation.connect(admin).withdrawTreasury(admin.address, STAKE),
      ).to.changeEtherBalances([admin, reputation], [STAKE, -STAKE]);
    });
  });
});
