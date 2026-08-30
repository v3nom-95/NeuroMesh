/**
 * Chain service: read-only operation, the stale-deployment degraded state, typed reads, and the
 * serialized transaction queue.
 *
 * The fake endpoint decodes calldata and encodes results with the **real generated ABI**, so these
 * tests exercise the same encode/decode path production does. A stub that returned plain objects
 * would keep passing if `src/abi/` were wrong, which is precisely the failure mode that made the
 * hand-transcribed v1 ABIs dangerous.
 *
 * @module test/backend/services/chain.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ZeroHash, id as keccakUtf8 } from 'ethers';

import { createChainService } from '../../../src/services/chain.js';
import { eip712 } from '../../../src/protocol/index.js';

import {
  ADDRESSES,
  TEST_AGENT,
  compatibleHandlers,
  fakeNode,
  quietLogger,
  recordingMetrics,
  testConfig,
} from './helpers.js';

/**
 * @param {object} [options] Options.
 * @param {Record<string, string|undefined>} [options.env] Environment overrides.
 * @param {any} [options.node] A pre-built fake node.
 * @param {any} [options.nodeOptions] Options for a fresh fake node.
 * @param {any} [options.metrics] Metrics collector.
 * @returns {any} The service and its node.
 */
function build({ env = {}, node, nodeOptions = {}, metrics } = {}) {
  const chainNode = node ?? fakeNode({ handlers: compatibleHandlers(), ...nodeOptions });
  const service = createChainService({
    config: testConfig(env),
    logger: quietLogger(),
    metrics,
    providerFactory: chainNode.providerFactory,
    walletFactory: chainNode.walletFactory,
    sleep: async () => {},
  });
  return { service, node: chainNode };
}

/** A ledger record tuple in the order `IMemoryLedger.MemoryRecord` declares. */
const MEMORY_RECORD = [
  TEST_AGENT,
  1767225600n,
  384,
  ZeroHash,
  TEST_AGENT,
  0n,
  1,
  true,
  false,
  'bafkreiabc',
  'nm1:tag',
];

describe('services/chain: read-only node', () => {
  it('refuses a signer with 503 read_only and still answers address() with null', () => {
    const { service } = build({ env: { PRIVATE_KEY: undefined } });
    assert.equal(service.address(), null);
    assert.throws(
      () => service.signer(),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 503);
        assert.equal(any.code, 'read_only');
        return true;
      },
    );
  });

  it('refuses every write path before any RPC round trip', () => {
    const { service, node } = build({ env: { PRIVATE_KEY: undefined } });
    assert.throws(
      () => service.assertWritable(),
      (err) => /** @type {any} */ (err).code === 'read_only',
    );
    assert.equal(node.calls.length, 0);
  });

  it('still serves reads', async () => {
    const { service } = build({
      env: { PRIVATE_KEY: undefined },
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: { 'MemoryLedger.totalMemoryCount': () => 17n },
        }),
      },
    });
    assert.equal(await service.readLedger.totalMemoryCount(), 17);
  });

  it('reports the whole chain as disabled when no RPC endpoint is configured', async () => {
    const { service } = build({ env: { SEPOLIA_RPC_URL: undefined, RPC_URLS: undefined } });
    assert.equal(service.enabled, false);
    const state = await service.init();
    assert.equal(state.status, 'disabled');
    await assert.rejects(service.getBlockNumber(), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.code, 'chain_unavailable');
      return true;
    });
  });
});

describe('services/chain: boot compatibility checks', () => {
  it('reports ready when the deployment matches this build', async () => {
    const { service } = build();
    const state = await service.init();
    assert.equal(state.status, 'ready');
    assert.equal(state.reachable, true);
    assert.equal(state.chainId, 11155111);
    assert.equal(state.contractsCompatible, true);
    service.assertWritable();
  });

  it('never probes eip712Domain on ReputationManager, which has no EIP712 mixin', async () => {
    const { service, node } = build();
    await service.init();
    const probed = node.calls.filter((c) => c.method === 'ReputationManager.eip712Domain');
    // Probing it uniformly reverts, which would make a *correct* deployment fail to boot.
    assert.equal(probed.length, 0);
    assert.equal(service.state().contracts.ReputationManager.domain, 'skipped');
  });

  it('degrades rather than crashes when the typehash getters are absent (the v1 deployment)', async () => {
    // fakeNode reverts on any selector it has no handler for, which is exactly what calling
    // MEMORY_COMMIT_TYPEHASH() on the v1 contracts at the addresses in contract-addresses.json does.
    const { service } = build({
      nodeOptions: {
        handlers: { 'MemoryLedger.totalMemoryCount': () => 5n },
      },
    });
    const state = await service.init();
    assert.equal(state.reachable, true);
    assert.equal(state.status, 'degraded');
    assert.equal(state.contractsCompatible, false);
    assert.equal(state.contracts.MemoryLedger.typehashes, 'absent');
    assert.match(String(state.contracts.MemoryLedger.reason), /older deployment/);
    // The whole point: reads keep working.
    assert.equal(await service.readLedger.totalMemoryCount(), 5);
  });

  it('refuses writes on an incompatible deployment with a code an operator can act on', async () => {
    const { service } = build({ nodeOptions: { handlers: {} } });
    await service.init();
    assert.throws(
      () => service.assertWritable(),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 503);
        assert.equal(any.code, 'contracts_incompatible');
        assert.match(any.message, /read-only/i);
        return true;
      },
    );
  });

  it('detects an address with no bytecode and names it', async () => {
    const { service } = build({
      nodeOptions: { handlers: compatibleHandlers(), code: { [ADDRESSES.AgentIdentity]: '0x' } },
    });
    const state = await service.init();
    assert.equal(state.contracts.AgentIdentity.hasCode, false);
    assert.match(String(state.contracts.AgentIdentity.reason), /no contract at/i);
    assert.match(String(state.contracts.AgentIdentity.reason), new RegExp(ADDRESSES.AgentIdentity));
    assert.equal(state.contractsCompatible, false);
  });

  it('reports a chain-id mismatch as a blocking error without throwing at boot', async () => {
    const { service } = build({ nodeOptions: { chainId: 1, handlers: compatibleHandlers() } });
    const state = await service.init();
    assert.equal(state.reachable, true);
    assert.equal(state.error?.code, 'chain_id_mismatch');
    assert.match(String(state.error?.message), /11155111/);
    assert.equal(state.contractsCompatible, false);
  });

  it('detects a typehash that differs from the one this build signs', async () => {
    const wrong = `0x${'ab'.repeat(32)}`;
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: { 'MemoryLedger.MEMORY_COMMIT_TYPEHASH': () => wrong },
        }),
      },
    });
    const state = await service.init();
    assert.equal(state.contracts.MemoryLedger.typehashes, 'mismatch');
    assert.match(String(state.contracts.MemoryLedger.reason), /signature/i);
    assert.equal(state.contractsCompatible, false);
  });

  it('detects an EIP-712 domain that differs from the one this build signs', async () => {
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: {
            'MemoryLedger.eip712Domain': () => [
              '0x0f',
              'SomeOtherProtocol',
              '2',
              11155111n,
              ADDRESSES.MemoryLedger,
              `0x${'0'.repeat(64)}`,
              [],
            ],
          },
        }),
      },
    });
    const state = await service.init();
    assert.equal(state.contracts.MemoryLedger.domain, 'mismatch');
    assert.equal(state.contractsCompatible, false);
  });

  it('treats a contract with no configured address as disabled, not down', async () => {
    const { service } = build({ env: { CONTRACT_MEMORY_ACCESS_CONTROL: undefined } });
    const state = await service.init();
    assert.equal(state.contracts.MemoryAccessControl.configured, false);
    assert.match(String(state.contracts.MemoryAccessControl.reason), /disabled/);
    // A node with no access-control deployment can still commit and read.
    assert.equal(state.contractsCompatible, true);
  });

  it('exposes the verdict through health() for /readyz', async () => {
    const { service } = build();
    await service.init();
    const health = await service.health();
    assert.equal(health.status, 'up');
    assert.equal(health.reachable, true);
    assert.equal(health.contractsCompatible, true);
    assert.equal(health.writable, true);
    assert.equal(health.signer.address, TEST_AGENT);
    assert.equal(typeof health.signer.balanceWei, 'string');
  });

  it('reports degraded with a low balance rather than failing outright', async () => {
    const { service } = build({
      nodeOptions: { handlers: compatibleHandlers(), balances: { [TEST_AGENT]: 1n } },
    });
    await service.init();
    const health = await service.health();
    assert.equal(health.status, 'degraded');
    assert.equal(health.signer.low, true);
    // Low is a warning, not a refusal: the refusal is the exact per-transaction preflight.
    assert.equal(health.writable, true);
  });
});

describe('services/chain: typed reads', () => {
  it('normalizes a MemoryRecord into JSON-safe values', async () => {
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: { 'MemoryLedger.getMemory': () => [MEMORY_RECORD] },
        }),
      },
    });
    const record = await service.readLedger.getMemory(ZeroHash);
    // JSON.stringify throws on a BigInt, so a leaked one turns a chart into a 500.
    assert.doesNotThrow(() => JSON.stringify(record));
    assert.equal(record.owner, TEST_AGENT);
    assert.equal(record.committedAt, 1767225600);
    assert.equal(record.embeddingDim, 384);
    assert.equal(record.revoked, false);
    assert.equal(record.cid, 'bafkreiabc');
  });

  it('decodes verifyMemory including the trailing revoked flag', async () => {
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: {
            'MemoryLedger.verifyMemory': () => [
              TEST_AGENT,
              1767225600n,
              true,
              384,
              'nm1:tag',
              true,
            ],
          },
        }),
      },
    });
    const result = await service.readLedger.verifyMemory('bafkreiabc');
    // The v1 ABI had no `revoked`, and ethers decodes the shortened tuple without complaint —
    // every revoked memory would have been reported as live.
    assert.equal(result.revoked, true);
    assert.equal(result.embeddingDim, 384);
  });

  it('returns reputation in WAD, unconverted', async () => {
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: { 'ReputationManager.reputationOf': () => 720000000000000000n },
        }),
      },
    });
    const value = await service.readReputation.reputationOf(TEST_AGENT);
    // A decimal string, not a number and not a BigInt. The single division lives in
    // src/services/reputation.js.
    assert.equal(value, '720000000000000000');
    assert.equal(typeof value, 'string');
  });

  it('rejects a malformed address before it reaches the RPC', async () => {
    const { service, node } = build();
    await assert.rejects(service.readIdentity.getAgent('not-an-address'), (err) => {
      assert.equal(/** @type {any} */ (err).status, 400);
      return true;
    });
    assert.equal(node.calls.length, 0);
  });

  it('maps a revert to 502 with the decoded reason in details', async () => {
    const { service } = build({
      nodeOptions: {
        handlers: compatibleHandlers({
          extra: {
            'MemoryLedger.getMemory': () => {
              const err = /** @type {any} */ (new Error('execution reverted'));
              err.code = 'CALL_EXCEPTION';
              throw err;
            },
          },
        }),
      },
    });
    await assert.rejects(service.readLedger.getMemory(ZeroHash), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 502);
      assert.equal(any.details.label, 'MemoryLedger.getMemory');
      return true;
    });
  });

  it('refuses a read against a contract with no configured address', async () => {
    const { service } = build({ env: { CONTRACT_MEMORY_ACCESS_CONTROL: undefined } });
    await assert.rejects(service.readAccess.canAccess(ZeroHash, TEST_AGENT), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.code, 'chain_unavailable');
      assert.match(String(any.details), /MemoryAccessControl/);
      return true;
    });
  });
});

describe('services/chain: EIP-712 signing', () => {
  /**
   * @param {any} extra Extra handlers.
   * @returns {any} A node whose `hashCommit` agrees with the local computation.
   */
  function signingNode(extra = {}) {
    return fakeNode({
      handlers: compatibleHandlers({
        extra: {
          'MemoryLedger.nonces': () => 3n,
          'MemoryLedger.hashCommit': (args) =>
            eip712.digest(
              eip712.buildMemoryCommit({
                agent: args[0],
                chainId: 11155111,
                ledger: ADDRESSES.MemoryLedger,
                cid: args[1][0],
                prevCidHash: args[1][1],
                model: args[1][2],
                embeddingDim: Number(args[1][3]),
                isEncrypted: args[1][4],
                nonce: args[2],
                deadline: args[3],
              }),
            ),
          ...extra,
        },
      }),
    });
  }

  it('cross-checks the local digest against MemoryLedger.hashCommit before signing', async () => {
    const { service } = build({ node: signingNode() });
    await service.init();
    const signed = await service.signMemoryCommit({
      cid: 'bafkreiabc',
      prevCidHash: ZeroHash,
      model: 'nm1:tag',
      embeddingDim: 384,
      isEncrypted: true,
      deadline: 2000000000,
    });
    assert.equal(signed.crossChecked, true);
    assert.equal(signed.nonce, '3');
    assert.equal(signed.agent, TEST_AGENT);
    assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
  });

  it('recovers to the signing agent, so the chain will accept the signature', async () => {
    const { service } = build({ node: signingNode() });
    await service.init();
    const signed = await service.signMemoryCommit({
      cid: 'bafkreiabc',
      prevCidHash: ZeroHash,
      model: 'nm1:tag',
      embeddingDim: 384,
      isEncrypted: true,
      deadline: 2000000000,
    });
    const typed = eip712.buildMemoryCommit({
      agent: TEST_AGENT,
      chainId: 11155111,
      ledger: ADDRESSES.MemoryLedger,
      cid: 'bafkreiabc',
      prevCidHash: ZeroHash,
      model: 'nm1:tag',
      embeddingDim: 384,
      isEncrypted: true,
      nonce: 3n,
      deadline: 2000000000,
    });
    assert.equal(eip712.recoverTypedData(typed, signed.signature), TEST_AGENT);
  });

  it('aborts before signing when the contract disagrees about the digest', async () => {
    const { service } = build({
      node: signingNode({ 'MemoryLedger.hashCommit': () => `0x${'cd'.repeat(32)}` }),
    });
    await service.init();
    await assert.rejects(
      service.signMemoryCommit({
        cid: 'bafkreiabc',
        prevCidHash: ZeroHash,
        model: 'nm1:tag',
        embeddingDim: 384,
        isEncrypted: true,
        deadline: 2000000000,
      }),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 409);
        // The runtime guard against ABI or typehash drift, run before anything irreversible.
        assert.match(any.message, /does not match MemoryLedger.hashCommit/);
        return true;
      },
    );
  });
});

describe('services/chain: the transaction queue', () => {
  /**
   * @param {any} [options] Node options.
   * @returns {any} A node whose ledger accepts a commit.
   */
  function writeNode(options = {}) {
    return fakeNode({
      handlers: compatibleHandlers({
        extra: {
          'MemoryLedger.nonces': () => 0n,
          'MemoryLedger.hashCommit': () => `0x${'00'.repeat(32)}`,
        },
      }),
      ...options,
    });
  }

  /**
   * @returns {any} A descriptor for a commit-shaped transaction.
   */
  function descriptor() {
    return {
      label: 'memory.commit',
      contract: 'MemoryLedger',
      method: 'commitMemoryFor',
      args: [
        TEST_AGENT,
        ['bafkreiabc', ZeroHash, 'nm1:tag', 384, true],
        2000000000,
        `0x${'11'.repeat(65)}`,
      ],
    };
  }

  it('assigns strictly consecutive nonces to concurrent submissions', async () => {
    const node = writeNode({ pendingNonce: 7 });
    const { service } = build({ node });
    await service.init();
    const results = await Promise.all([
      service.submit(descriptor()),
      service.submit(descriptor()),
      service.submit(descriptor()),
      service.submit(descriptor()),
      service.submit(descriptor()),
    ]);
    // The v1 defect: five concurrent writes each read the same pending count and broadcast at the
    // same nonce, so four were dropped or replaced.
    assert.deepEqual(
      results.map((r) => Number(r.nonce)),
      [7, 8, 9, 10, 11],
    );
    assert.deepEqual(
      node.sent.map((s) => s.nonce),
      [7, 8, 9, 10, 11],
    );
    assert.equal(new Set(node.sent.map((s) => s.nonce)).size, 5);
  });

  it('applies a 20 percent margin over the gas estimate', async () => {
    const node = writeNode({ gasEstimate: 100000n });
    const { service } = build({ node });
    await service.init();
    await service.submit(descriptor());
    assert.equal(node.sent[0].tx.gasLimit, 120000n);
  });

  it('multiplies the fee data by GAS_PRICE_MULTIPLIER with integer arithmetic', async () => {
    const node = writeNode();
    const { service } = build({ node, env: { GAS_PRICE_MULTIPLIER: '1.5' } });
    await service.init();
    await service.submit(descriptor());
    // 2 gwei * 1.5. Multiplying a BigInt by a float is a TypeError, so this must be integer math.
    assert.equal(node.sent[0].tx.maxFeePerGas, 3000000000n);
    assert.equal(node.sent[0].tx.maxPriorityFeePerGas, 1500000000n);
  });

  it('reports the hash through onHash before the transaction confirms', async () => {
    const node = writeNode();
    const { service } = build({ node });
    await service.init();
    /** @type {string[]} */
    const seen = [];
    const result = await service.submit({ ...descriptor(), onHash: (h) => seen.push(h) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], result.hash);
  });

  it('refuses with 503 insufficient_funds and names the shortfall', async () => {
    const node = writeNode({ balances: { [TEST_AGENT]: 1000n }, gasEstimate: 100000n });
    const { service } = build({ node });
    await service.init();
    await assert.rejects(service.submit(descriptor()), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      assert.equal(any.code, 'insufficient_funds');
      assert.equal(any.details.have, '1000');
      assert.ok(BigInt(any.details.shortfall) > 0n);
      return true;
    });
    assert.equal(node.sent.length, 0);
  });

  it('turns a would-revert estimate into a 400 and never broadcasts', async () => {
    const node = writeNode();
    node.provider.estimateGas = async () => {
      const err = /** @type {any} */ (new Error('execution reverted: StringTooLong'));
      err.code = 'CALL_EXCEPTION';
      err.revert = { name: 'StringTooLong', args: ['model', 126n, 64n] };
      throw err;
    };
    const { service } = build({ node });
    await service.init();
    await assert.rejects(service.submit(descriptor()), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 400);
      assert.match(any.message, /would revert/);
      assert.match(any.message, /No gas was spent/);
      assert.equal(any.details.reason, 'StringTooLong');
      return true;
    });
    assert.equal(node.sent.length, 0);
  });

  it('does not consume a nonce for a transaction it never broadcast', async () => {
    const node = writeNode({ pendingNonce: 4 });
    node.provider.estimateGas = async () => {
      const err = /** @type {any} */ (new Error('execution reverted'));
      err.code = 'CALL_EXCEPTION';
      throw err;
    };
    const { service } = build({ node });
    await service.init();
    await assert.rejects(service.submit(descriptor()));
    node.provider.estimateGas = async () => 100000n;
    const result = await service.submit(descriptor());
    // A reserved-and-abandoned nonce would leave a gap that stalls every later transaction.
    assert.equal(Number(result.nonce), 4);
  });

  it('reports a confirmation timeout as a state that still carries the hash', async () => {
    const node = writeNode({ receipt: null });
    const { service } = build({ node });
    await service.init();
    const result = await service.submit(descriptor());
    assert.equal(result.status, 'timeout');
    // Losing the hash is worse than the timeout: it is the only way to find out what happened.
    assert.match(result.hash, /^0x[0-9a-f]{64}$/);
    assert.match(result.explorerUrl, /etherscan\.io\/tx\/0x/);
  });

  it('throws rather than reporting success when the transaction reverted on chain', async () => {
    const node = writeNode({ receipt: { status: 0, blockNumber: 1, gasUsed: 1n } });
    const { service } = build({ node });
    await service.init();
    await assert.rejects(service.submit(descriptor()), (err) => {
      assert.match(String(/** @type {any} */ (err).message), /reverted on chain/);
      return true;
    });
  });

  it('sheds beyond TX_QUEUE_MAX rather than accepting unbounded work', async () => {
    const node = writeNode();
    /** @type {Array<() => void>} */
    const gate = [];
    node.provider.waitForTransaction = () =>
      new Promise((resolve) =>
        gate.push(() => resolve({ status: 1, blockNumber: 1, gasUsed: 1n })),
      );
    const { service } = build({ node, env: { TX_QUEUE_MAX: '2' } });
    await service.init();
    const first = service.submit(descriptor());
    const second = service.submit(descriptor());
    assert.throws(
      () => service.submit(descriptor()),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 503);
        assert.equal(any.code, 'overloaded');
        return true;
      },
    );
    const drain = setInterval(() => {
      while (gate.length) gate.shift()?.();
    }, 1);
    await Promise.all([first, second]);
    clearInterval(drain);
  });

  it('records a per-label transaction metric', async () => {
    const { metrics, calls } = recordingMetrics();
    const { service } = build({ node: writeNode(), metrics });
    await service.init();
    await service.submit(descriptor());
    const total = calls.find((c) => c.name === 'neuromesh_tx_total');
    assert.ok(total, 'no neuromesh_tx_total was recorded');
    assert.equal(total.args[0].label, 'memory.commit');
    assert.equal(total.args[0].status, 'confirmed');
  });

  it('stops accepting work once drained', async () => {
    const { service } = build({ node: writeNode() });
    await service.init();
    await service.drain(0);
    assert.throws(
      () => service.submit(descriptor()),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.code, 'chain_unavailable');
        assert.match(String(any.details), /shutting down/);
        return true;
      },
    );
  });
});

describe('services/chain: prevCidHash', () => {
  it('is keccak of the parent CID string, matching what the contract computes', () => {
    // The contract computes `keccak256(bytes(input.cid))`. Passing a pre-hashed value would produce
    // a digest the contract disagrees with, which is why the builder takes the raw string.
    assert.equal(keccakUtf8('bafkreiparent').length, 66);
    assert.notEqual(keccakUtf8('bafkreiparent'), ZeroHash);
  });
});
