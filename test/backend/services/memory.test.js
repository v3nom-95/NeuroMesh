/**
 * Memory service: the commit pipeline as a job, the compensating unpin, and the read/verify/decrypt
 * paths.
 *
 * These tests wire the **real** embedding (mock provider), crypto and semantic services together and
 * fake only the two things a unit test must not do for real: pin to a paid service and spend gas.
 * The fake pinner computes genuine CIDv1 values over the exact bytes it is handed, so an assertion
 * that "the CID in the job result addresses the bytes that were stored" is a real assertion.
 *
 * @module test/backend/services/memory.test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCryptoService } from '../../../src/services/crypto.js';
import { createEmbeddingService } from '../../../src/services/embeddings.js';
import { COMMIT_STEPS, createMemoryService } from '../../../src/services/memory.js';
import { createSemanticService } from '../../../src/services/semantic.js';
import { canonical, constants, payload as payloadCodec } from '../../../src/protocol/index.js';

import { TEST_AGENT, fakePinner, quietLogger, testConfig } from './helpers.js';

/**
 * A chain double that records what it was asked to do.
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.writable] Whether `assertWritable` passes.
 * @param {Error|null} [options.submitError] Make `submit` reject with this.
 * @param {any} [options.record] What `getMemoryByCid` returns.
 * @returns {any} The double, plus a `submits` log.
 */
function fakeChain({ writable = true, submitError = null, record } = {}) {
  /** @type {any[]} */
  const submits = [];
  return {
    submits,
    assertWritable() {
      if (!writable) {
        const err = /** @type {any} */ (new Error('read only'));
        err.status = 503;
        err.code = 'read_only';
        throw err;
      }
    },
    address: () => TEST_AGENT,
    /**
     * @param {any} args Commit arguments.
     * @returns {Promise<any>} A signature bundle.
     */
    async signMemoryCommit(args) {
      return {
        signature: `0x${'11'.repeat(65)}`,
        digest: `0x${'22'.repeat(32)}`,
        nonce: '0',
        deadline: args.deadline,
        agent: TEST_AGENT,
        crossChecked: true,
      };
    },
    /**
     * @param {any} descriptor Transaction descriptor.
     * @returns {Promise<any>} The result.
     */
    async submit(descriptor) {
      submits.push(descriptor);
      if (submitError) throw submitError;
      descriptor.onHash?.(`0x${'ab'.repeat(32)}`);
      return {
        status: 'confirmed',
        hash: `0x${'ab'.repeat(32)}`,
        nonce: '0',
        blockNumber: 8123457,
        gasUsed: '190000',
        effectiveGasPrice: '1500000000',
        explorerUrl: `https://sepolia.etherscan.io/tx/0x${'ab'.repeat(32)}`,
        retried: false,
        confirmations: 1,
      };
    },
    readLedger: {
      /**
       * @param {string} cid CID.
       * @returns {Promise<any>} A ledger record.
       */
      async getMemoryByCid(cid) {
        if (record === null) throw new Error('no ledger record');
        // The default echoes what was actually committed, so verify's model and dimension bindings
        // are checked against a consistent record rather than against a placeholder.
        const committed = submits[0]?.args?.[1];
        return (
          record ?? {
            owner: TEST_AGENT,
            committedAt: 1767225600,
            embeddingDim: Number(committed?.[3] ?? 384),
            prevCidHash: `0x${'00'.repeat(32)}`,
            committedBy: TEST_AGENT,
            revokedAt: 0,
            version: 1,
            isEncrypted: true,
            revoked: false,
            cid,
            model: String(committed?.[2] ?? 'nm1:tag'),
          }
        );
      },
      /**
       * @returns {Promise<any>} An empty owner page.
       */
      async getOwnerMemoryRecords() {
        return { page: [], total: 0 };
      },
    },
  };
}

/**
 * Build a fully wired service graph with only the pinner and the chain faked.
 *
 * @param {object} [options] Options.
 * @param {any} [options.chain] Chain double.
 * @param {any} [options.ipfs] Pinner double.
 * @param {Record<string, string|undefined>} [options.env] Environment overrides.
 * @returns {Promise<any>} The graph.
 */
async function build({ chain = fakeChain(), ipfs = fakePinner(), env = {} } = {}) {
  const config = testConfig(env);
  const logger = quietLogger();
  const embeddings = createEmbeddingService({ config, logger });
  await embeddings.init();
  const crypto = createCryptoService({ config, logger });
  await crypto.init();
  const semantic = createSemanticService({ config, logger, persist: false });
  const memory = createMemoryService({
    config,
    logger,
    embeddings,
    crypto,
    ipfs,
    chain,
    semantic,
  });
  return { memory, chain, ipfs, crypto, semantic, embeddings, config };
}

describe('services/memory: the happy path', () => {
  it('returns a job immediately and completes every step', async () => {
    const graph = await build();
    const job = graph.memory.create({ context: 'a memory worth keeping' });
    // The pipeline starts synchronously, so the job is already `running` by the time create returns.
    // What matters is that create does not await the pipeline.
    assert.ok(['queued', 'running'].includes(job.state));
    assert.deepEqual(
      job.steps.map((/** @type {any} */ s) => s.name),
      [...COMMIT_STEPS],
    );
    const finished = await graph.memory.waitFor(job.id);
    assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
    assert.deepEqual(
      finished.steps.map((/** @type {any} */ s) => s.state),
      ['done', 'done', 'done', 'done', 'done', 'done'],
    );
    for (const step of finished.steps) assert.ok(typeof step.ms === 'number');
  });

  it('reports a CID that addresses exactly the bytes that were pinned', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'exact bytes' }).id);
    const cid = /** @type {string} */ (job.result.cid);
    const stored = graph.ipfs.store.get(cid);
    assert.ok(stored, 'nothing was stored under the reported CID');
    assert.equal(canonical.cidFromBytes(stored).cid, cid);
  });

  it('pins a payload that validates against the v2 schema', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'schema check' }).id);
    const bytes = graph.ipfs.store.get(job.result.cid);
    const parsed = payloadCodec.parseMemoryPayload(JSON.parse(Buffer.from(bytes).toString('utf8')));
    assert.equal(parsed.v, constants.PROTOCOL_VERSION);
    assert.equal(parsed.agentDid, graph.crypto.agentDid());
    assert.equal(parsed.model.dim, 384);
    assert.equal(parsed.alignment.dim, 384);
  });

  it('never publishes the plaintext embedding beside the ciphertext', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'private vector' }).id);
    const bytes = graph.ipfs.store.get(job.result.cid);
    const parsed = payloadCodec.parseMemoryPayload(JSON.parse(Buffer.from(bytes).toString('utf8')));
    // v1 pinned `vector_embedding` in the clear next to `encrypted_context`. Embedding-inversion
    // work recovers substantial text from a sentence embedding, so that was close to publishing the
    // plaintext next to its own encryption.
    assert.equal(parsed.embedding.visibility, 'grantees');
    assert.equal(parsed.embedding.data, null);
    assert.match(parsed.embedding.dataDigest, /^0x[0-9a-f]{64}$/);
    assert.equal(parsed.context, null);
    assert.ok(parsed.cipher);
    // Only a 256-bit SimHash stays public, for candidate retrieval.
    assert.equal(parsed.lsh?.bits, 256);
  });

  it('commits a model tag that fits the on-chain limit and commits to the payload URI', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'model binding' }).id);
    const input = graph.chain.submits[0].args[1];
    const chainModel = input[2];
    assert.ok(Buffer.byteLength(chainModel, 'utf8') <= 64);
    const bytes = graph.ipfs.store.get(job.result.cid);
    const parsed = payloadCodec.parseMemoryPayload(JSON.parse(Buffer.from(bytes).toString('utf8')));
    const expected = `nm1:${canonical.b64u(
      Uint8Array.from(Buffer.from(parsed.model.id.slice(2), 'hex')),
    )}`;
    assert.equal(chainModel, expected);
  });

  it('commits the embedding dimension the payload actually carries', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'dimension' }).id);
    const input = graph.chain.submits[0].args[1];
    const bytes = graph.ipfs.store.get(job.result.cid);
    const parsed = payloadCodec.parseMemoryPayload(JSON.parse(Buffer.from(bytes).toString('utf8')));
    // v1 hardcoded 384 regardless of what was embedded, producing a permanent false record.
    assert.equal(Number(input[3]), parsed.alignment.dim);
    assert.equal(input[4], true);
  });

  it('calls commitMemoryFor, not commitMemory, so the record binds to the author', async () => {
    const graph = await build();
    await graph.memory.waitFor(graph.memory.create({ context: 'meta transaction' }).id);
    const descriptor = graph.chain.submits[0];
    assert.equal(descriptor.method, 'commitMemoryFor');
    assert.equal(descriptor.args[0], TEST_AGENT);
    // v1 passed the ASCII string "sig" as the proof and let the contract take ownership from
    // msg.sender, so the record bound to whoever paid gas, not to the author.
    assert.match(descriptor.args[3], /^0x[0-9a-f]{130}$/);
  });

  it('indexes the memory for search and counts it locally', async () => {
    const graph = await build();
    await graph.memory.waitFor(graph.memory.create({ context: 'indexed' }).id);
    assert.equal(graph.memory.count(), 1);
    assert.equal(graph.semantic.size(), 1);
  });

  it('records a parent CID as prevCidHash and in the payload', async () => {
    const graph = await build();
    const first = await graph.memory.waitFor(graph.memory.create({ context: 'v1 of a note' }).id);
    const second = await graph.memory.waitFor(
      graph.memory.create({ context: 'v2 of a note', parentCid: first.result.cid }).id,
    );
    const input = graph.chain.submits[1].args[1];
    assert.notEqual(input[1], `0x${'00'.repeat(32)}`);
    const bytes = graph.ipfs.store.get(second.result.cid);
    const parsed = payloadCodec.parseMemoryPayload(JSON.parse(Buffer.from(bytes).toString('utf8')));
    assert.equal(parsed.prevCid, first.result.cid);
  });
});

describe('services/memory: failure after pinning', () => {
  it('runs a compensating unpin and still reports the CID', async () => {
    const ipfs = fakePinner();
    const graph = await build({
      ipfs,
      chain: fakeChain({ submitError: new Error('the chain write failed') }),
    });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'doomed' }).id);
    assert.equal(job.state, 'failed');
    // The client must never be left without the CID it has started paying for. This is the exact
    // v1 failure: the object was pinned, the commit failed, and the response was nothing at all.
    assert.match(String(job.result.cid), /^bafk/);
    assert.equal(job.result.pinRolledBack, true);
    assert.equal(ipfs.store.size, 0);
    assert.ok(ipfs.calls.some((c) => c.startsWith('unpin:')));
  });

  it('marks the failing step as failed and leaves the earlier ones done', async () => {
    const graph = await build({ chain: fakeChain({ submitError: new Error('boom') }) });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'doomed' }).id);
    const byName = Object.fromEntries(job.steps.map((/** @type {any} */ s) => [s.name, s.state]));
    assert.equal(byName.embed, 'done');
    assert.equal(byName.align, 'done');
    assert.equal(byName.encrypt, 'done');
    assert.equal(byName.pin, 'done');
    assert.equal(byName.confirm, 'failed');
  });

  it('warns loudly when the compensating unpin itself fails', async () => {
    const ipfs = fakePinner({ unpinFails: true });
    const graph = await build({
      ipfs,
      chain: fakeChain({ submitError: new Error('the chain write failed') }),
    });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'doubly doomed' }).id);
    assert.equal(job.result.pinRolledBack, false);
    assert.equal(job.result.pinRollbackReason, 'simulated unpin failure');
    const warning = job.warnings.find((/** @type {string} */ w) => w.includes('remains pinned'));
    assert.ok(warning, 'the operator was not told the object is still pinned and billed');
    assert.match(warning, /listPins/);
    // The object really is still there — the warning is not cosmetic.
    assert.equal(ipfs.store.size, 1);
  });

  it('preserves the original failure rather than the compensation failure', async () => {
    const graph = await build({
      ipfs: fakePinner({ unpinFails: true }),
      chain: fakeChain({ submitError: new Error('the chain write failed') }),
    });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'doomed' }).id);
    assert.match(String(job.error.message), /chain write failed/);
  });

  it('does not index or count a memory whose commit failed', async () => {
    const graph = await build({ chain: fakeChain({ submitError: new Error('boom') }) });
    await graph.memory.waitFor(graph.memory.create({ context: 'doomed' }).id);
    assert.equal(graph.memory.count(), 0);
    assert.equal(graph.semantic.size(), 0);
  });
});

describe('services/memory: input validation', () => {
  it('refuses a non-string context before creating a job', async () => {
    const graph = await build();
    assert.throws(
      () => graph.memory.create({ context: /** @type {any} */ (['a', 'b']) }),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 400);
        assert.match(any.message, /batch/);
        return true;
      },
    );
    assert.equal(graph.memory.jobs.size(), 0);
  });

  it('refuses an empty context and one over the limit', async () => {
    const graph = await build({ env: { MAX_CONTEXT_CHARS: '32' } });
    assert.throws(
      () => graph.memory.create({ context: '   ' }),
      (err) => /** @type {any} */ (err).status === 400,
    );
    assert.throws(
      () => graph.memory.create({ context: 'x'.repeat(33) }),
      (err) => /** @type {any} */ (err).status === 413,
    );
  });

  it('refuses on a read-only node without creating a job that only exists to fail', async () => {
    const graph = await build({ chain: fakeChain({ writable: false }) });
    assert.throws(
      () => graph.memory.create({ context: 'anything' }),
      (err) => /** @type {any} */ (err).code === 'read_only',
    );
    assert.equal(graph.memory.jobs.size(), 0);
  });
});

describe('services/memory: reading back', () => {
  it('fetches, validates and reports the memory with a content-addressed ETag', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'read me back' }).id);
    const fetched = await graph.memory.get(job.result.cid);
    assert.equal(fetched.cid, job.result.cid);
    assert.equal(fetched.payloadVersion, constants.PROTOCOL_VERSION);
    assert.equal(fetched.onchain.owner, TEST_AGENT);
    assert.equal(fetched.etag, `"${canonical.digestFromCid(job.result.cid).slice(2)}"`);
  });

  it('reports a missing ledger record with a reason rather than a 404', async () => {
    const graph = await build({ chain: fakeChain({ record: null }) });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'unrecorded' }).id);
    const fetched = await graph.memory.get(job.result.cid);
    assert.equal(fetched.onchain, null);
    assert.ok(typeof fetched.onchainReason === 'string');
  });

  it('rejects a malformed CID before any network call', async () => {
    const graph = await build();
    await assert.rejects(
      graph.memory.get('QmLegacyV0Cid'),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });

  it('paginates the local index and refuses a cursor from a different filter set', async () => {
    const graph = await build();
    for (const text of ['one', 'two', 'three']) {
      await graph.memory.waitFor(graph.memory.create({ context: text }).id);
    }
    const first = graph.memory.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.total, 3);
    assert.ok(first.nextCursor);
    assert.equal(first.source, 'local-index');
    const second = graph.memory.list({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    // A cursor issued for a different filter set describes a different sequence; continuing with it
    // silently returns the wrong page.
    assert.throws(
      () => graph.memory.list({ limit: 2, cursor: first.nextCursor, encrypted: false }),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });

  it('returns the newest memory first', async () => {
    const graph = await build();
    const first = await graph.memory.waitFor(graph.memory.create({ context: 'older' }).id);
    const second = await graph.memory.waitFor(graph.memory.create({ context: 'newer' }).id);
    assert.equal(graph.memory.list().items[0].cid, second.result.cid);
    assert.equal(graph.memory.list().items[1].cid, first.result.cid);
  });
});

describe('services/memory: decrypt', () => {
  it('takes a CID and nothing else, and returns the original plaintext', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(
      graph.memory.create({ context: 'the secret this node remembers' }).id,
    );
    const opened = await graph.memory.decrypt(job.result.cid, { actor: 'test' });
    assert.equal(opened.context, 'the secret this node remembers');
    assert.equal(opened.verified, true);
    assert.equal(opened.embeddingVerified, true);
    // The replacement for POST /api/decrypt, which accepted caller-supplied ciphertext and
    // decrypted it with the node's chain signing key. There is no parameter through which a caller
    // could supply ciphertext, and the source is checked for one so the route cannot come back.
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/services/memory.js', import.meta.url)),
      'utf8',
    );
    assert.ok(!/encryptedData/.test(source));
  });

  it('refuses a CID this node holds no bytes for', async () => {
    const graph = await build();
    await assert.rejects(
      graph.memory.decrypt('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'),
      /nothing stored/,
    );
  });
});

describe('services/memory: verify', () => {
  it('reports every step, and passes for a memory this node wrote', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'verify me' }).id);
    const report = await graph.memory.verify(job.result.cid);
    assert.equal(report.ok, true);
    const byName = Object.fromEntries(
      report.steps.map((/** @type {any} */ s) => [s.name, s.state]),
    );
    assert.equal(byName['cid-format'], 'pass');
    assert.equal(byName['cid-matches-bytes'], 'pass');
    assert.equal(byName.schema, 'pass');
    assert.equal(byName.canonical, 'pass');
    assert.equal(byName['owner-binding'], 'pass');
    assert.equal(byName['dimension-binding'], 'pass');
    assert.equal(byName['model-binding'], 'pass');
    assert.equal(byName.revocation, 'pass');
    assert.equal(byName['recipient-entry'], 'pass');
    assert.equal(byName.decryptable, 'pass');
  });

  it('fails the dimension binding when the chain and the payload disagree', async () => {
    const graph = await build({
      chain: fakeChain({
        record: {
          owner: TEST_AGENT,
          committedAt: 1,
          embeddingDim: 768,
          prevCidHash: `0x${'00'.repeat(32)}`,
          committedBy: TEST_AGENT,
          revokedAt: 0,
          version: 1,
          isEncrypted: true,
          revoked: false,
          cid: 'bafk',
          model: 'nm1:tag',
        },
      }),
    });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'mismatched' }).id);
    const report = await graph.memory.verify(job.result.cid);
    assert.equal(report.ok, false);
    const step = report.steps.find((/** @type {any} */ s) => s.name === 'dimension-binding');
    assert.equal(step.state, 'fail');
    assert.match(step.detail, /cannot be corrected on chain/);
  });

  it('fails on a revoked record', async () => {
    const graph = await build({
      chain: fakeChain({
        record: {
          owner: TEST_AGENT,
          committedAt: 1,
          embeddingDim: 384,
          prevCidHash: `0x${'00'.repeat(32)}`,
          committedBy: TEST_AGENT,
          revokedAt: 99,
          version: 1,
          isEncrypted: true,
          revoked: true,
          cid: 'bafk',
          model: 'nm1:tag',
        },
      }),
    });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'revoked' }).id);
    const report = await graph.memory.verify(job.result.cid);
    assert.equal(report.ok, false);
    const step = report.steps.find((/** @type {any} */ s) => s.name === 'revocation');
    assert.equal(step.state, 'fail');
  });

  it('reports skip, not pass, for steps it cannot evaluate', async () => {
    const graph = await build({ chain: fakeChain({ record: null }) });
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'no chain' }).id);
    const report = await graph.memory.verify(job.result.cid);
    const chainStep = report.steps.find((/** @type {any} */ s) => s.name === 'chain-record');
    // "Could not check" is a different fact from "checked and passed", and the report says which.
    assert.equal(chainStep.state, 'skip');
    assert.match(chainStep.detail, /could not be read/);
  });

  it('rejects a CID that is not v1 raw sha2-256', async () => {
    const graph = await build();
    const report = await graph.memory.verify('QmLegacy');
    assert.equal(report.ok, false);
    assert.equal(report.steps[0].name, 'cid-format');
    assert.equal(report.steps[0].state, 'fail');
  });
});

describe('services/memory: the job registry', () => {
  it('returns null for an unknown job and throws 404 when one is required', async () => {
    const graph = await build();
    assert.equal(graph.memory.getJob('00000000-0000-4000-8000-000000000000'), null);
    assert.throws(
      () => graph.memory.jobs.require('00000000-0000-4000-8000-000000000000'),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 404);
        assert.equal(any.code, 'job_not_found');
        return true;
      },
    );
  });

  it('keeps the job readable by id after it finishes', async () => {
    const graph = await build();
    const job = graph.memory.create({ context: 'findable' });
    await graph.memory.waitFor(job.id);
    const found = graph.memory.getJob(job.id);
    assert.equal(found.id, job.id);
    assert.equal(found.state, 'succeeded');
    assert.ok(found.finishedAt);
  });

  it('never retains more than JOB_MAX jobs', async () => {
    const graph = await build({ env: { JOB_MAX: '3' } });
    for (let i = 0; i < 6; i += 1) {
      await graph.memory.waitFor(graph.memory.create({ context: `memory ${i}` }).id);
    }
    assert.ok(graph.memory.jobs.size() <= 3);
  });

  it('records a warning when the model weights are not digest-pinned', async () => {
    const graph = await build();
    const job = await graph.memory.waitFor(graph.memory.create({ context: 'unpinned model' }).id);
    // The registry carries no weights digest yet, and the job says so rather than letting a reader
    // assume model.uri identifies specific weights.
    assert.ok(job.warnings.some((/** @type {string} */ w) => w.includes('@sha256')));
  });
});
