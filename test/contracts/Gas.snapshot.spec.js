import { fileURLToPath } from 'node:url';

import { expect } from 'chai';
import hre from 'hardhat';

import { cid, deadline, field, validPubKey } from './helpers/constants.js';
import { input, loadFixture, registeredFixture } from './helpers/fixtures.js';
import { signMemoryCommit, signRegistration } from './helpers/eip712.js';
import { checkGas, gasOf, loadSnapshot, writeSnapshot } from './helpers/gas.js';

const { ethers } = hre;

const SNAPSHOT_PATH = fileURLToPath(new URL('./__snapshots__/gas.json', import.meta.url));
const TOLERANCE_PCT = 10;
const EIP170_LIMIT = 24576;

describe('Gas snapshot and bytecode size', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
  });

  it(`stays within ${TOLERANCE_PCT}% of the committed baseline for every canonical operation`, async function () {
    this.timeout(300000);
    const {
      identity,
      ledger,
      reputation,
      access,
      agentA,
      agentB,
      agentC,
      relayer,
      extras,
      registeredExtras,
    } = ctx;
    const measured = {};

    /* -------------------- AgentIdentity -------------------- */
    // Warm the registry with one extra registration, then measure the next one, so the number is not
    // distorted by first-write-to-a-fresh-slot costs that no production call would ever pay again.
    await identity.connect(extras[20]).registerAgent(validPubKey('g0'), '');
    measured['identity.registerAgent'] = await gasOf(
      identity.connect(extras[21]).registerAgent(validPubKey('g1'), ''),
    );

    const dl = await deadline();
    const { signature: regSig } = await signRegistration(extras[22], identity, {
      agent: extras[22].address,
      publicKey: validPubKey('g2'),
      metadataURI: '',
      deadline: dl,
    });
    measured['identity.registerAgentFor'] = await gasOf(
      identity
        .connect(relayer)
        .registerAgentFor(extras[22].address, validPubKey('g2'), '', dl, regSig),
    );

    await identity.connect(agentA).rotateKey(validPubKey('A2'));
    measured['identity.rotateKey'] = await gasOf(
      identity.connect(agentA).rotateKey(validPubKey('A3')),
    );

    /* -------------------- MemoryLedger -------------------- */
    await ledger.connect(agentA).commitMemory(input(cid(1)));
    measured['ledger.commitMemory.genesis'] = await gasOf(
      ledger.connect(agentA).commitMemory(input(cid(2))),
    );
    await ledger.connect(agentA).commitMemory(input(cid(3), ethers.id(cid(1))));
    measured['ledger.commitMemory.withParent'] = await gasOf(
      ledger.connect(agentA).commitMemory(input(cid(4), ethers.id(cid(2)))),
    );

    const commitInput = input(cid(5));
    const dl2 = await deadline();
    const { signature: commitSig } = await signMemoryCommit(agentA, ledger, {
      agent: agentA.address,
      input: commitInput,
      deadline: dl2,
    });
    measured['ledger.commitMemoryFor'] = await gasOf(
      ledger.connect(relayer).commitMemoryFor(agentA.address, commitInput, dl2, commitSig),
    );

    await ledger.connect(agentA).revokeMemory(ethers.id(cid(3)), field('x'));
    measured['ledger.revokeMemory'] = await gasOf(
      ledger.connect(agentA).revokeMemory(ethers.id(cid(4)), field('x')),
    );

    /* -------------------- ReputationManager -------------------- */
    measured['reputation.endorseAgent.first'] = await gasOf(
      reputation.connect(agentB).endorseAgent(agentC.address, 'gas'),
    );
    measured['reputation.endorseAgent.subsequent'] = await gasOf(
      reputation.connect(registeredExtras[0]).endorseAgent(agentC.address, 'gas'),
    );
    measured['reputation.revokeEndorsement'] = await gasOf(
      reputation.connect(agentB).revokeEndorsement(agentC.address, 'gas'),
    );
    measured['reputation.reportAgent'] = await gasOf(
      reputation.connect(registeredExtras[1]).reportAgent(agentC.address, 'gas'),
    );
    measured['reputation.settle'] = await gasOf(reputation.connect(relayer).settle(agentC.address));

    /* -------------------- MemoryAccessControl -------------------- */
    await access
      .connect(agentA)
      .grantAccess(ethers.id(cid(1)), agentB.address, '0xdeadbeefdeadbeef', 0);
    measured['access.grantAccess'] = await gasOf(
      access
        .connect(agentA)
        .grantAccess(ethers.id(cid(2)), agentB.address, '0xdeadbeefdeadbeef', 0),
    );

    /* -------------------- Compare -------------------- */
    const baseline = loadSnapshot(SNAPSHOT_PATH);
    const drift = [];
    const created = [];
    for (const [name, used] of Object.entries(measured)) {
      const result = checkGas(name, used, baseline, TOLERANCE_PCT);
      if (result.status === 'new') {
        created.push(`${name} = ${used}`);
      } else if (result.status === 'drift') {
        drift.push(
          `${name}: baseline ${baseline[name]}, measured ${used} (${(result.delta * 100).toFixed(2)}%)`,
        );
      }
    }

    if (writeSnapshot(SNAPSHOT_PATH, measured)) {
      console.log(`gas snapshot rewritten (${Object.keys(measured).length} entries)`);
      return;
    }

    expect(
      created,
      `missing baseline entries - regenerate with UPDATE_GAS_SNAPSHOT=true:\n${created.join('\n')}`,
    ).to.have.lengthOf(0);
    expect(drift, `gas drift beyond ${TOLERANCE_PCT}%:\n${drift.join('\n')}`).to.have.lengthOf(0);
  });

  describe('bytecode size', function () {
    it('keeps every deployed contract under the EIP-170 limit', async function () {
      const { identityAddr, ledgerAddr, reputationAddr, accessAddr } = ctx;
      const sizes = {};
      for (const [name, addr] of [
        ['AgentIdentity', identityAddr],
        ['MemoryLedger', ledgerAddr],
        ['ReputationManager', reputationAddr],
        ['MemoryAccessControl', accessAddr],
      ]) {
        const code = await ethers.provider.getCode(addr);
        const size = (code.length - 2) / 2;
        sizes[name] = size;
        expect(size, `${name} exceeds EIP-170`).to.be.lessThan(EIP170_LIMIT);
      }

      console.log(
        '      runtime bytecode:',
        Object.entries(sizes)
          .map(([n, s]) => `${n} ${s}B (headroom ${EIP170_LIMIT - s}B)`)
          .join(', '),
      );
    });
  });
});
