/**
 * Snapshot-isolated deployment fixtures.
 *
 * Every `describe` in the suite obtains its world through `loadFixture`, so the EVM is restored from
 * a snapshot instead of redeploying four contracts per test. That is what keeps a suite this size in
 * the tens of seconds rather than the tens of minutes, and it also guarantees that no test can leak
 * state into the next one.
 */
import hre from 'hardhat';
import { loadFixture, time, mine, setBalance } from '@nomicfoundation/hardhat-network-helpers';

import {
  MODERATOR_ROLE,
  PARAM_ADMIN_ROLE,
  PAUSER_ROLE,
  SLASHER_ROLE,
  TRUST_LOG_CAPACITY,
  cid,
  validPubKey,
} from './constants.js';

const { ethers } = hre;

export { loadFixture, time, mine, setBalance };

/** How many synthetic, funded agent wallets the fixtures create beyond the named signers. */
export const EXTRA_COUNT = 24;

/** How many of those extras `registeredFixture` registers in AgentIdentity. */
export const REGISTERED_EXTRAS = 20;

/**
 * Deterministic funded wallets.
 *
 * Hardhat's in-process network only hands out 20 signers, and the sybil-resistance test alone needs
 * 18 distinct endorsers plus a target. Rather than edit `hardhat.config.js` (owned by another lane)
 * these are derived from fixed labels and funded with `setBalance`, which lands inside the fixture
 * snapshot like any other state.
 */
export function extraWallets(count = EXTRA_COUNT) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(new ethers.Wallet(ethers.id(`neuromesh-extra-agent-${i}`), ethers.provider));
  }
  return out;
}

/**
 * The named cast used throughout the suite.
 * @returns roles-by-name plus `extras`, an array of {@link EXTRA_COUNT} generated wallets.
 */
export async function namedAccounts() {
  const s = await ethers.getSigners();
  return {
    deployer: s[0],
    admin: s[1],
    pauser: s[2],
    paramAdmin: s[3],
    moderator: s[4],
    slasher: s[5],
    agentA: s[6],
    agentB: s[7],
    agentC: s[8],
    relayer: s[9],
    outsider: s[10],
    treasurer: s[1],
    extras: extraWallets(),
  };
}

/**
 * Deploys the four protocol contracts plus the test-only mocks, and wires every operational role.
 *
 * `trustLogCapacity` is deliberately 16 so the ring buffer wraps after a handful of transactions -
 * the production value would need thousands of events to exercise the same code path.
 */
export async function deployFixture() {
  const acc = await namedAccounts();
  const { admin, pauser, paramAdmin, moderator, slasher, extras } = acc;

  // Fund the synthetic wallets before anything else, so they can pay for their own transactions.
  for (const w of extras) {
    await setBalance(w.address, ethers.parseEther('10000'));
  }

  const identity = await (await ethers.getContractFactory('AgentIdentity')).deploy(admin.address);
  await identity.waitForDeployment();

  const ledger = await (
    await ethers.getContractFactory('MemoryLedger')
  ).deploy(admin.address, await identity.getAddress());
  await ledger.waitForDeployment();

  const reputation = await (
    await ethers.getContractFactory('ReputationManager')
  ).deploy(admin.address, await identity.getAddress(), admin.address, TRUST_LOG_CAPACITY);
  await reputation.waitForDeployment();

  const access = await (
    await ethers.getContractFactory('MemoryAccessControl')
  ).deploy(admin.address, await ledger.getAddress(), await identity.getAddress());
  await access.waitForDeployment();

  // Test-only helpers.
  const errs = await (await ethers.getContractFactory('NeuroMeshErrorsProbe')).deploy();
  await errs.waitForDeployment();
  const decayMath = await (await ethers.getContractFactory('DecayMathHarness')).deploy();
  await decayMath.waitForDeployment();

  // Operational roles: the admin bootstrap only grants DEFAULT_ADMIN + PAUSER to `admin`.
  for (const c of [identity, ledger, reputation, access]) {
    await c.connect(admin).grantRole(PAUSER_ROLE, pauser.address);
  }
  await reputation.connect(admin).grantRole(PARAM_ADMIN_ROLE, paramAdmin.address);
  await reputation.connect(admin).grantRole(SLASHER_ROLE, slasher.address);
  await ledger.connect(admin).grantRole(MODERATOR_ROLE, moderator.address);
  await access.connect(admin).grantRole(MODERATOR_ROLE, moderator.address);

  const { chainId } = await ethers.provider.getNetwork();

  return {
    ...acc,
    identity,
    ledger,
    reputation,
    access,
    errs,
    decayMath,
    chainId,
    identityAddr: await identity.getAddress(),
    ledgerAddr: await ledger.getAddress(),
    reputationAddr: await reputation.getAddress(),
    accessAddr: await access.getAddress(),
  };
}

/** {@link deployFixture} plus three named agents and {@link REGISTERED_EXTRAS} synthetic agents. */
export async function registeredFixture() {
  const ctx = await deployFixture();
  const { identity, agentA, agentB, agentC, extras } = ctx;

  await identity.connect(agentA).registerAgent(validPubKey('A'), 'ipfs://agent-a');
  await identity.connect(agentB).registerAgent(validPubKey('B'), 'ipfs://agent-b');
  await identity.connect(agentC).registerAgent(validPubKey('C'), 'ipfs://agent-c');

  for (let i = 0; i < REGISTERED_EXTRAS; i++) {
    await identity.connect(extras[i]).registerAgent(validPubKey(`x${i}`), '');
  }

  return { ...ctx, registeredExtras: extras.slice(0, REGISTERED_EXTRAS) };
}

/** {@link registeredFixture} plus a three-deep version chain owned by agentA and a standalone by agentB. */
export async function memoriesFixture() {
  const ctx = await registeredFixture();
  const { ledger, agentA, agentB } = ctx;

  const cids = { m1: cid(1), m2: cid(2), m3: cid(3), b1: cid(101) };
  const h = (c) => ethers.id(c);

  await commitWithPrecommit(ledger, agentA, input(cids.m1));
  await commitWithPrecommit(ledger, agentA, input(cids.m2, h(cids.m1)));
  await commitWithPrecommit(ledger, agentA, input(cids.m3, h(cids.m2)));
  await commitWithPrecommit(ledger, agentB, input(cids.b1));

  return {
    ...ctx,
    cids,
    hashes: { m1: h(cids.m1), m2: h(cids.m2), m3: h(cids.m3), b1: h(cids.b1) },
  };
}

/**
 * Builds a `MemoryLedger.MemoryInput` tuple with protocol-valid defaults.
 * @param {string} cidString  IPFS content identifier
 * @param {string} prevCidHash parent hash, or the zero hash for a genesis record
 */
export function input(cidString, prevCidHash = ethers.ZeroHash, overrides = {}) {
  return {
    cid: cidString,
    prevCidHash,
    model: 'hf:Xenova/all-MiniLM-L6-v2@sha256:deadbeef',
    embeddingDim: 384,
    isEncrypted: true,
    ...overrides,
  };
}

/**
 * Commit a memory through the commit–reveal flow.
 *
 * `commitMemory` requires a matured {precommit}, which is what closes the CID
 * front-running hole (NM-01). Tests should exercise the real two-step path rather
 * than a shortcut, so this helper precommits, advances past MIN_PRECOMMIT_DELAY,
 * and then reveals.
 *
 * @param {any} ledger     MemoryLedger, already `.connect(signer)`-ed or not.
 * @param {any} signer     The committing agent.
 * @param {any} memInput   A MemoryInput struct (see {@link input}).
 * @param {string} [salt]  Optional explicit salt; defaults to one derived from the CID.
 * @returns {Promise<any>} The commit transaction response.
 */
let _saltNonce = 0;
export async function commitWithPrecommit(ledger, signer, memInput, salt) {
  // Unique per call: a commit that reverts leaves its precommit unspent, and re-precommitting
  // the same blinded hash would revert with PrecommitAlreadyExists.
  _saltNonce += 1;
  const useSalt = salt ?? ethers.id(`salt:${memInput.cid}:${_saltNonce}`);
  const cidHash = ethers.keccak256(ethers.toUtf8Bytes(memInput.cid));
  const blinded = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes32'],
      [cidHash, await signer.getAddress(), useSalt],
    ),
  );
  await ledger.connect(signer).precommit(blinded);
  await time.increase(MIN_PRECOMMIT_DELAY + 1);
  return ledger.connect(signer).commitMemory(memInput, useSalt);
}

/** Seconds a precommit must age before it may be revealed (mirrors Limits.MIN_PRECOMMIT_DELAY). */
export const MIN_PRECOMMIT_DELAY = 24;
