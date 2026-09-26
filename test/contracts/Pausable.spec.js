import { expect } from 'chai';
import hre from 'hardhat';

import { PAUSER_ROLE, STAKE_LOCK, cid, deadline, field, validPubKey } from './helpers/constants.js';
import {
  input,
  loadFixture,
  memoriesFixture,
  time,
  commitWithPrecommit,
} from './helpers/fixtures.js';
import {
  signAccessGrant,
  signMemoryCommit,
  signMemoryRevocation,
  signRegistration,
  signKeyRotation,
} from './helpers/eip712.js';

const { ethers } = hre;

const STAKE = ethers.parseEther('0.02');

/**
 * The incident switch is only useful if it covers the right surface AND deliberately leaves the
 * right holes: user-protective exits and moderation must survive a pause, because a pause is exactly
 * when an operator needs them. Both halves are asserted here.
 */
describe('Pausable surface', function () {
  let ctx;

  /**
   * memoriesFixture plus everything the pause-exempt paths need to be exercisable:
   * a live grant, a staked-and-revoked endorsement past its lock, and a non-zero treasury balance.
   */
  async function pausableFixture() {
    const base = await memoriesFixture();
    const {
      reputation,
      access,
      paramAdmin,
      slasher,
      agentA,
      agentB,
      agentC,
      hashes,
      registeredExtras,
    } = base;

    await access.connect(agentA).grantAccess(hashes.m1, agentB.address, '0xdeadbeef', 0);

    await reputation.connect(paramAdmin).setEndorsementStake(STAKE);
    // agentB's stake is revoked and unlocked, so claimStake is callable while paused.
    await reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE });
    await reputation.connect(agentB).revokeEndorsement(agentA.address, 'x');
    // agentC's stake gets slashed, funding the treasury so withdrawTreasury is callable while paused.
    await reputation.connect(agentC).endorseAgent(agentA.address, 'x', { value: STAKE });
    await reputation.connect(slasher).slashEndorsement(agentC.address, agentA.address, field('x'));
    // A live report by an extra, so withdrawReport has something to block.
    await reputation.connect(registeredExtras[0]).reportAgent(agentA.address, 'p');
    await time.increase(STAKE_LOCK);

    return base;
  }

  beforeEach(async function () {
    ctx = await loadFixture(pausableFixture);
  });

  async function pauseAll() {
    const { identity, ledger, reputation, access, pauser } = ctx;
    for (const c of [identity, ledger, reputation, access]) await c.connect(pauser).pause();
  }

  /** Every state-creating entrypoint, with arguments that would otherwise succeed. */
  async function blockedCalls() {
    const {
      identity,
      ledger,
      reputation,
      access,
      agentA,
      agentB,
      relayer,
      outsider,
      hashes,
      registeredExtras,
    } = ctx;
    const dl = await deadline();

    const { signature: regSig } = await signRegistration(outsider, identity, {
      agent: outsider.address,
      publicKey: validPubKey('o'),
      metadataURI: '',
      deadline: dl,
    });
    const { signature: rotSig } = await signKeyRotation(agentA, identity, {
      agent: agentA.address,
      publicKey: validPubKey('A9'),
      deadline: dl,
    });
    const commitInput = input(cid(900));
    const { signature: commitSig } = await signMemoryCommit(agentA, ledger, {
      agent: agentA.address,
      input: commitInput,
      deadline: dl,
    });
    const { signature: revokeSig } = await signMemoryRevocation(agentA, ledger, {
      agent: agentA.address,
      cidHash: hashes.m1,
      reason: field('x'),
      deadline: dl,
    });
    const { signature: grantSig } = await signAccessGrant(agentA, access, {
      owner: agentA.address,
      cidHash: hashes.m2,
      grantee: agentB.address,
      wrappedKey: '0xdeadbeef',
      expiresAt: 0,
      deadline: dl,
    });

    return [
      [
        'identity.registerAgent',
        () => identity.connect(outsider).registerAgent(validPubKey('o'), ''),
      ],
      [
        'identity.registerAgentFor',
        () =>
          identity
            .connect(relayer)
            .registerAgentFor(outsider.address, validPubKey('o'), '', dl, regSig),
      ],
      ['identity.rotateKey', () => identity.connect(agentA).rotateKey(validPubKey('A9'))],
      [
        'identity.rotateKeyFor',
        () => identity.connect(relayer).rotateKeyFor(agentA.address, validPubKey('A9'), dl, rotSig),
      ],
      ['identity.setMetadataURI', () => identity.connect(agentA).setMetadataURI('ipfs://x')],
      ['identity.reactivate', () => identity.connect(agentA).reactivate()],

      ['ledger.commitMemory', () => commitWithPrecommit(ledger, agentA, input(cid(901)))],
      [
        'ledger.commitMemoryFor',
        () => ledger.connect(relayer).commitMemoryFor(agentA.address, commitInput, dl, commitSig),
      ],
      ['ledger.revokeMemory', () => ledger.connect(agentA).revokeMemory(hashes.m1, field('x'))],
      [
        'ledger.revokeMemoryFor',
        () =>
          ledger
            .connect(relayer)
            .revokeMemoryFor(agentA.address, hashes.m1, field('x'), dl, revokeSig),
      ],

      [
        'reputation.endorseAgent',
        () => reputation.connect(agentB).endorseAgent(agentA.address, 'x', { value: STAKE }),
      ],
      ['reputation.reportAgent', () => reputation.connect(agentB).reportAgent(agentA.address, 'x')],
      [
        'reputation.withdrawReport',
        () => reputation.connect(registeredExtras[0]).withdrawReport(agentA.address, 'x'),
      ],
      ['reputation.settle', () => reputation.connect(outsider).settle(agentA.address)],
      ['reputation.settleBatch', () => reputation.connect(outsider).settleBatch([agentA.address])],

      [
        'access.grantAccess',
        () => access.connect(agentA).grantAccess(hashes.m2, agentB.address, '0xdeadbeef', 0),
      ],
      [
        'access.grantAccessBatch',
        () =>
          access.connect(agentA).grantAccessBatch(hashes.m2, [agentB.address], ['0xdeadbeef'], 0),
      ],
      [
        'access.grantAccessFor',
        () =>
          access
            .connect(relayer)
            .grantAccessFor(
              agentA.address,
              hashes.m2,
              agentB.address,
              '0xdeadbeef',
              0,
              dl,
              grantSig,
            ),
      ],
      [
        'access.revokeAccess',
        () => access.connect(agentA).revokeAccess(hashes.m1, agentB.address, field('x')),
      ],
    ];
  }

  it('blocks every state-creating entrypoint with EnforcedPause', async function () {
    const calls = await blockedCalls();
    await pauseAll();
    for (const [label, call] of calls) {
      await expect(call(), label).to.be.revertedWithCustomError(ctx.errs, 'EnforcedPause');
    }
    // 19, not 20: revokeEndorsement became a documented pause exemption (NM-08), because
    // claimStake is pause-exempt and revocation is its precondition.
    expect(calls.length).to.equal(19);
  });

  it('restores every one of them after unpause', async function () {
    const { identity, ledger, reputation, access, pauser } = ctx;
    await pauseAll();
    for (const c of [identity, ledger, reputation, access]) await c.connect(pauser).unpause();

    const calls = await blockedCalls();
    // Run the independent, non-conflicting ones; each must now go through.
    const labels = new Set([
      'identity.registerAgent',
      'identity.rotateKey',
      'identity.setMetadataURI',
      'ledger.commitMemory',
      'reputation.settle',
      'reputation.settleBatch',
      'access.grantAccess',
      'access.revokeAccess',
    ]);
    for (const [label, call] of calls) {
      if (labels.has(label)) await call();
    }
    expect(await identity.totalAgents()).to.equal(24n);
  });

  it('DOCUMENTED EXEMPTIONS: self-protection, moderation and fund exits survive a pause', async function () {
    const { identity, ledger, reputation, access, admin, moderator, agentA, agentB, hashes } = ctx;
    await pauseAll();

    // Self-protection: an agent whose key is compromised must be able to stop the protocol
    // accepting new work in its name, precisely during an incident.
    await identity.connect(agentA).deactivate();
    expect(await identity.isActive(agentA.address)).to.equal(false);

    // Moderation: taking illegal or poisoned content down is the operator's job during a pause.
    await identity.connect(admin).adminSetActive(agentA.address, true, field('reinstate'));
    await ledger.connect(moderator).moderatorRevokeMemory(hashes.m2, field('takedown'));
    expect((await ledger.getMemory(hashes.m2)).revoked).to.equal(true);
    await access
      .connect(moderator)
      .moderatorRevokeAccess(hashes.m1, agentB.address, field('takedown'));
    expect(await access.canAccess(hashes.m1, agentB.address)).to.equal(false);

    // Funds must always be exitable.
    await expect(reputation.connect(agentB).claimStake(agentA.address)).to.changeEtherBalances(
      [agentB, reputation],
      [STAKE, -STAKE],
    );
    await expect(
      reputation.connect(admin).withdrawTreasury(admin.address, STAKE),
    ).to.changeEtherBalances([admin, reputation], [STAKE, -STAKE]);
  });

  it('leaves every view function readable while paused', async function () {
    const { identity, ledger, reputation, access, agentA, agentB, hashes } = ctx;
    await pauseAll();

    expect(await identity.isActive(agentA.address)).to.equal(true);
    expect(await identity.totalAgents()).to.equal(23n);
    expect((await identity.getAgent(agentA.address)).keyVersion).to.equal(1n);
    expect((await identity.getAgents(0, 10))[1]).to.equal(23n);

    expect(await ledger.totalMemoryCount()).to.equal(4n);
    expect((await ledger.getMemory(hashes.m1)).owner).to.equal(agentA.address);
    expect(await ledger.getVersionChain(hashes.m3, 10)).to.have.lengthOf(3);

    expect(await reputation.reputationOf(agentA.address)).to.be.a('bigint');
    expect(await reputation.isTrusted(agentA.address)).to.equal(false);
    expect((await reputation.getTrustEvents(0, 5))[1]).to.be.greaterThan(0n);

    expect(await access.canAccess(hashes.m1, agentB.address)).to.equal(true);
    expect((await access.getGrantees(hashes.m1, 0, 10))[1]).to.equal(1n);
  });

  it('rejects a redundant pause, a redundant unpause and an unauthorised pauser', async function () {
    const { identity, pauser, outsider, errs } = ctx;
    await expect(identity.connect(outsider).pause())
      .to.be.revertedWithCustomError(errs, 'AccessControlUnauthorizedAccount')
      .withArgs(outsider.address, PAUSER_ROLE);

    await expect(identity.connect(pauser).unpause()).to.be.revertedWithCustomError(
      errs,
      'ExpectedPause',
    );
    await identity.connect(pauser).pause();
    await expect(identity.connect(pauser).pause()).to.be.revertedWithCustomError(
      errs,
      'EnforcedPause',
    );
    await identity.connect(pauser).unpause();
    expect(await identity.paused()).to.equal(false);
  });
});
