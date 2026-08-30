import { expect } from 'chai';
import hre from 'hardhat';

import {
  BASE_W,
  PRIOR,
  STAKE_LOCK,
  THRESHOLD,
  WAD,
  cid,
  deadline,
  field,
  validPubKey,
} from './helpers/constants.js';
import { deployFixture, input, loadFixture, time } from './helpers/fixtures.js';
import { signRegistration } from './helpers/eip712.js';

const { ethers } = hre;

const score = (p, n) => (p * WAD) / (p + n + PRIOR);
const HALF_LIFE = 90 * 24 * 3600;
const STAKE = ethers.parseEther('0.02');

/**
 * One ordered narrative across all four contracts, in the order the backend actually drives them.
 * The `it`s deliberately share state - this file doubles as executable documentation of the event
 * stream a dashboard or indexer will consume.
 */
describe('End-to-end protocol narrative', function () {
  let ctx;
  const h = {};

  before(async function () {
    ctx = await loadFixture(deployFixture);
  });

  it('1. three agents join - two paying their own gas, one sponsored by a relayer', async function () {
    const { identity, agentA, agentB, agentC, relayer } = ctx;

    await expect(identity.connect(agentA).registerAgent(validPubKey('A'), 'ipfs://a')).to.emit(
      identity,
      'AgentRegistered',
    );
    await identity.connect(agentB).registerAgent(validPubKey('B'), 'ipfs://b');

    const dl = await deadline();
    const { signature } = await signRegistration(agentC, identity, {
      agent: agentC.address,
      publicKey: validPubKey('C'),
      metadataURI: 'ipfs://c',
      deadline: dl,
    });
    await expect(
      identity
        .connect(relayer)
        .registerAgentFor(agentC.address, validPubKey('C'), 'ipfs://c', dl, signature),
    )
      .to.emit(identity, 'AgentRegistered')
      .withArgs(
        agentC.address,
        relayer.address,
        validPubKey('C'),
        'ipfs://c',
        (await time.latest()) + 1,
      );

    expect(await identity.totalAgents()).to.equal(3n);
    expect(await identity.isActive(agentC.address)).to.equal(true);
  });

  it('2. agentA publishes a three-deep version chain', async function () {
    const { ledger, agentA } = ctx;
    h.v1 = ethers.id(cid(1));
    h.v2 = ethers.id(cid(2));
    h.v3 = ethers.id(cid(3));

    await ledger.connect(agentA).commitMemory(input(cid(1)));
    await ledger.connect(agentA).commitMemory(input(cid(2), h.v1));
    await expect(ledger.connect(agentA).commitMemory(input(cid(3), h.v2)))
      .to.emit(ledger, 'MemoryCommitted')
      .withArgs(
        agentA.address,
        h.v3,
        h.v2,
        cid(3),
        input(cid(3)).model,
        384,
        true,
        3,
        agentA.address,
        (await time.latest()) + 1,
      );

    expect(await ledger.getVersionChain(h.v3, 10)).to.deep.equal([h.v3, h.v2, h.v1]);
    expect(await ledger.activeMemoryCount(agentA.address)).to.equal(3n);
  });

  it('3. agentA delegates decryption of v3 to agentC', async function () {
    const { access, identity, agentA, agentC } = ctx;
    const wrappedKey = '0x' + 'ab'.repeat(96);
    const [, keyVersion] = await identity.getPublicKey(agentC.address);

    await expect(access.connect(agentA).grantAccess(h.v3, agentC.address, wrappedKey, 0))
      .to.emit(access, 'AccessGranted')
      .withArgs(h.v3, agentA.address, agentC.address, 0, keyVersion, wrappedKey);

    expect(await access.canAccess(h.v3, agentC.address)).to.equal(true);
    expect(await access.canAccess(h.v3, ctx.agentB.address)).to.equal(false);
  });

  it("4. two endorsements lift agentA's score but leave it far below the trust line", async function () {
    const { reputation, agentA, agentB, agentC } = ctx;
    await reputation.connect(agentB).endorseAgent(agentA.address, 'accurate recall');
    await reputation.connect(agentC).endorseAgent(agentA.address, 'useful context');

    expect(await reputation.endorserCount(agentA.address)).to.equal(2n);
    expect(await reputation.reputationOf(agentA.address)).to.equal(score(2n * BASE_W, 0n));
    expect(await reputation.reputationOf(agentA.address)).to.be.lessThan(THRESHOLD);
    expect(await reputation.isTrusted(agentA.address)).to.equal(false);
  });

  it('5. sixteen further distinct, registered endorsers finally cross the threshold', async function () {
    const { identity, reputation, agentA, extras } = ctx;
    for (let i = 0; i < 16; i++) {
      await identity.connect(extras[i]).registerAgent(validPubKey(`e${i}`), '');
      await reputation.connect(extras[i]).endorseAgent(agentA.address, 'vouch');
    }

    expect(await reputation.endorserCount(agentA.address)).to.equal(18n);
    expect((await reputation.massesOf(agentA.address))[0]).to.equal(18n * BASE_W);
    expect(await reputation.reputationOf(agentA.address)).to.equal(THRESHOLD);
    expect(await reputation.isTrusted(agentA.address)).to.equal(true);
  });

  it('6. four half-lives of silence expire that trust, with no transaction from anyone', async function () {
    const { reputation, agentA } = ctx;
    const before = (await reputation.massesOf(agentA.address))[0];
    await time.increase(4 * HALF_LIFE);

    const [after] = await reputation.massesOf(agentA.address);
    expect(after).to.equal(before / 16n);
    expect(await reputation.isTrusted(agentA.address)).to.equal(false);
    // The edges survive; only their evidentiary weight decayed.
    expect(await reputation.endorserCount(agentA.address)).to.equal(18n);
  });

  it('7. agentC reports agentA, and its own endorsement is torn down in the same transaction', async function () {
    const { reputation, agentA, agentC } = ctx;
    const tx = await reputation.connect(agentC).reportAgent(agentA.address, 'memory poisoning');

    await expect(tx).to.emit(reputation, 'AgentReported');
    await expect(tx).to.emit(reputation, 'EndorsementRevoked');
    expect(await reputation.endorserCount(agentA.address)).to.equal(17n);
    expect(await reputation.reporterCount(agentA.address)).to.equal(1n);
    expect(await reputation.hasActiveEndorsement(agentC.address, agentA.address)).to.equal(false);
    expect((await reputation.massesOf(agentA.address))[1]).to.be.greaterThan(0n);
  });

  it('8. a moderator takes the poisoned record down, which withdraws every downstream grant', async function () {
    const { ledger, access, moderator, agentA, agentC } = ctx;
    await expect(ledger.connect(moderator).moderatorRevokeMemory(h.v3, field('poisoned')))
      .to.emit(ledger, 'MemoryRevokedEvent')
      .withArgs(
        h.v3,
        agentA.address,
        moderator.address,
        field('poisoned'),
        (await time.latest()) + 1,
      );

    // The cross-contract check: MemoryAccessControl reads liveness straight from the ledger, so no
    // separate revocation of the grant is required.
    expect(await access.canAccess(h.v3, agentC.address)).to.equal(false);
    expect((await access.getGrant(h.v3, agentC.address)).revokedAt).to.equal(0n);
    expect(await ledger.activeMemoryCount(agentA.address)).to.equal(2n);
  });

  it('9. a grantee key rotation makes the published envelope visibly stale', async function () {
    const { access, identity, agentA, agentC } = ctx;
    await identity.connect(agentC).rotateKey(validPubKey('C2'));
    const [, currentVersion] = await identity.getPublicKey(agentC.address);
    expect(currentVersion).to.equal(2n);
    expect((await access.getGrant(h.v3, agentC.address)).keyVersion).to.equal(1n);

    // agentA can rotate too: identity, memories and reputation all survive it unchanged.
    await identity.connect(agentA).rotateKey(validPubKey('A2'));
    expect((await identity.getPublicKey(agentA.address))[1]).to.equal(2n);
    expect(await ctx.ledger.getOwnerMemoryCount(agentA.address)).to.equal(3n);
    expect(await ctx.reputation.endorserCount(agentA.address)).to.equal(17n);
  });

  it('10. agentA deactivates: no new work in its name, but its history stays fully readable', async function () {
    const { identity, ledger, reputation, agentA, agentB, errs } = ctx;
    await identity.connect(agentA).deactivate();

    await expect(ledger.connect(agentA).commitMemory(input(cid(4))))
      .to.be.revertedWithCustomError(errs, 'AgentInactive')
      .withArgs(agentA.address);
    await expect(reputation.connect(agentB).endorseAgent(agentA.address, 'x'))
      .to.be.revertedWithCustomError(errs, 'AgentInactive')
      .withArgs(agentA.address);

    expect(await identity.isRegistered(agentA.address)).to.equal(true);
    expect((await ledger.getMemory(h.v1)).owner).to.equal(agentA.address);
    expect(await ledger.getVersionChain(h.v3, 10)).to.have.lengthOf(3);
    expect(await reputation.reputationOf(agentA.address)).to.be.greaterThan(0n);
  });

  it('11. an incident pause blocks new state while leaving exits and moderation open', async function () {
    const {
      identity,
      ledger,
      reputation,
      access,
      paramAdmin,
      pauser,
      moderator,
      admin,
      agentB,
      extras,
      errs,
    } = ctx;

    // Arrange a claimable stake so the fund-exit exemption can be exercised under pause.
    await reputation.connect(paramAdmin).setEndorsementStake(STAKE);
    await reputation.connect(agentB).endorseAgent(extras[0].address, 'x', { value: STAKE });
    await reputation.connect(agentB).revokeEndorsement(extras[0].address, 'x');
    await time.increase(STAKE_LOCK);

    for (const c of [identity, ledger, reputation, access]) await c.connect(pauser).pause();

    await expect(ledger.connect(agentB).commitMemory(input(cid(5)))).to.be.revertedWithCustomError(
      errs,
      'EnforcedPause',
    );
    await expect(
      reputation.connect(extras[1]).endorseAgent(agentB.address, 'x', { value: STAKE }),
    ).to.be.revertedWithCustomError(errs, 'EnforcedPause');

    // Views keep working...
    expect(await ledger.totalMemoryCount()).to.equal(3n);
    expect(await reputation.isTrusted(ctx.agentA.address)).to.equal(false);
    // ...moderation keeps working...
    await ledger.connect(moderator).moderatorRevokeMemory(h.v2, field('takedown'));
    expect((await ledger.getMemory(h.v2)).revoked).to.equal(true);
    // ...and so does the exit.
    await expect(reputation.connect(agentB).claimStake(extras[0].address)).to.changeEtherBalances(
      [agentB, reputation],
      [STAKE, -STAKE],
    );
    void admin;

    for (const c of [identity, ledger, reputation, access]) await c.connect(pauser).unpause();
    await ledger.connect(agentB).commitMemory(input(cid(5)));
    expect(await ledger.totalMemoryCount()).to.equal(4n);
  });
});
