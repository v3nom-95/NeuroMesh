/**
 * Semantic service: deterministic alignment, the projection-equality filter, and trust-weighted
 * ranking.
 *
 * The headline assertion in this file is the one that spawns a second Node process. The original
 * `lib/semantic-sync.js` drew its projection matrix from unseeded `Math.random`, so two processes
 * projected into different subspaces and every cross-model cosine was noise — this repository's own
 * `simulation-results.json` fits the pure-noise null at p = 0.70. A single-process determinism check
 * would not have caught that; only a second process does.
 *
 * @module test/backend/services/semantic.test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSemanticService } from '../../../src/services/semantic.js';
import { mockEmbedding } from '../../../src/services/embeddings.js';
import { constants, projection } from '../../../src/protocol/index.js';

import { quietLogger, testConfig } from './helpers.js';

/** Two addresses used only as owner labels. */
const ALICE = '0xD4F91196316f802B67C6B17e0B1845A23beaA2ad';
const BOB = '0x10701017eC0faed2309E103C51AB503214F940Fb';

/**
 * @param {object} [deps] Overrides.
 * @returns {any} A service with persistence off and a quiet logger.
 */
function build(deps = {}) {
  return createSemanticService({
    config: testConfig(),
    logger: quietLogger(),
    // Never touch the developer's real index file from a unit test.
    persist: false,
    ...deps,
  });
}

/**
 * A stand-in embedding service that returns deterministic mock vectors.
 *
 * @param {number} [dim] Dimensionality.
 * @returns {any} The stand-in.
 */
function fakeEmbeddings(dim = 384) {
  return {
    /**
     * @param {string} text Text to embed.
     * @returns {Promise<any>} A mock embedding result.
     */
    async embed(text) {
      return { vector: mockEmbedding(text, dim), dim, modelId: `0x${'aa'.repeat(32)}` };
    },
  };
}

/**
 * A reputation stand-in with fixed scores.
 *
 * @param {Record<string, number>} scores Address to score in [0, 1].
 * @returns {any} The stand-in.
 */
function fakeReputation(scores) {
  return {
    /**
     * @param {string} address Agent address.
     * @returns {Promise<{score: number}>} The score.
     */
    async scoreOf(address) {
      return { score: scores[address] ?? 0 };
    },
  };
}

/**
 * A stable 32-byte digest for a label, so a test can use readable CIDs.
 *
 * `upsert` derives the index key from the CID when none is given, and that derivation demands a real
 * base32 CIDv1. Supplying the key explicitly keeps the fixtures readable without weakening the
 * production path.
 *
 * @param {string} label Readable CID stand-in.
 * @returns {string} 0x + 64 hex.
 */
function digestFor(label) {
  return `0x${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}

/**
 * Seed the index with one entry per text.
 *
 * @param {any} service The semantic service.
 * @param {Array<{cid: string, text: string, owner?: string, createdAt?: number}>} rows Entries.
 * @returns {void}
 */
function seed(service, rows) {
  for (const row of rows) {
    const aligned = service.align(mockEmbedding(row.text, 384));
    service.upsert({
      cid: row.cid,
      cidDigest: digestFor(row.cid),
      owner: row.owner ?? ALICE,
      z: aligned.z,
      lsh: aligned.lsh,
      projectionId: aligned.projectionId,
      createdAt: row.createdAt ?? Math.floor(Date.now() / 1000),
      model: 'hf:Xenova/all-MiniLM-L6-v2?normalize=true&pooling=mean',
    });
  }
}

describe('services/semantic: determinism', () => {
  it('produces the identical aligned vector twice in one process', () => {
    const service = build();
    const vector = mockEmbedding('a memory about deterministic projections', 768);
    const first = service.align(vector);
    const second = service.align(vector);
    assert.deepEqual([...first.z], [...second.z]);
    assert.equal(first.projectionId, second.projectionId);
  });

  it('produces the identical aligned vector in a second, independent process', () => {
    const service = build();
    const local = service.align(mockEmbedding('cross-process alignment probe', 768));
    const projectionUrl = pathToFileURL(
      fileURLToPath(new URL('../../../src/protocol/projection.js', import.meta.url)),
    ).href;
    const embeddingsUrl = pathToFileURL(
      fileURLToPath(new URL('../../../src/services/embeddings.js', import.meta.url)),
    ).href;
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const p = await import(${JSON.stringify(projectionUrl)});
         const e = await import(${JSON.stringify(embeddingsUrl)});
         const aligned = p.alignEmbedding({ embedding: e.mockEmbedding('cross-process alignment probe', 768), targetDim: 384 });
         const z = Float32Array.from(aligned.aligned);
         process.stdout.write(JSON.stringify({
           z: Buffer.from(z.buffer).toString('hex'),
           lsh: Buffer.from(p.simhash256(z)).toString('hex'),
           id: aligned.projectionId,
         }));`,
      ],
      { encoding: 'utf8' },
    );
    const other = JSON.parse(stdout);
    // Byte-identical, not merely similar. Anything drawn from an unseeded source would differ here.
    assert.equal(Buffer.from(local.z.buffer).toString('hex'), other.z);
    assert.equal(Buffer.from(local.lsh).toString('hex'), other.lsh);
    assert.equal(local.projectionId, other.id);
  });

  it('contains no call to Math.random anywhere in its own source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/services/semantic.js', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(code), 'Math.random reappeared in the alignment path');
  });

  it('records a projectionId that names the algorithm and the dimensions', () => {
    const service = build();
    const aligned = service.align(mockEmbedding('x', 768));
    assert.equal(aligned.projectionId, projection.projectionId(768, 384));
    assert.match(
      aligned.projectionId,
      /^neuromesh-proj\/v1\/achlioptas-s3\/aes-256-ctr\/768-384\//,
    );
  });
});

describe('services/semantic: alignment', () => {
  it('projects a 768-d vector into the shared 384-d space and normalises it', () => {
    const service = build();
    const aligned = service.align(mockEmbedding('a longer model', 768));
    assert.equal(aligned.outDim, constants.SHARED_EMBEDDING_DIM);
    assert.equal(aligned.sourceDim, 768);
    assert.equal(aligned.projected, true);
    let norm = 0;
    for (const value of aligned.z) norm += value * value;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);
  });

  it('treats a same-dimension vector as a no-op, not as an alignment', () => {
    const service = build();
    const aligned = service.align(mockEmbedding('already 384', 384));
    assert.equal(aligned.projected, false);
  });

  it('refuses to expand a smaller vector rather than zero-padding it', () => {
    const service = build();
    assert.throws(
      () => service.align(mockEmbedding('small', 128), { targetDim: 384 }),
      (err) => {
        const any = /** @type {any} */ (err);
        assert.equal(any.status, 400);
        // Padding makes the cosine computable and meaningless, which is worse than refusing.
        assert.match(any.message, /zero-padding/);
        return true;
      },
    );
  });

  it('reports the noise baseline alongside every alignment', () => {
    const service = build();
    const aligned = service.align(mockEmbedding('x', 384));
    assert.ok(Math.abs(aligned.noiseBaseline - 1 / Math.sqrt(384)) < 1e-12);
  });
});

describe('services/semantic: the index', () => {
  it('refuses an entry with no projectionId', () => {
    const service = build();
    assert.throws(
      () =>
        service.upsert({
          cid: 'bafk1',
          cidDigest: digestFor('bafk1'),
          owner: ALICE,
          z: mockEmbedding('x', 384),
          projectionId: '',
        }),
      (err) => {
        assert.match(String(/** @type {any} */ (err).message), /projectionId/);
        return true;
      },
    );
  });

  it('replaces rather than duplicates on a second upsert of the same CID', () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'first' }]);
    seed(service, [{ cid: 'bafk1', text: 'second' }]);
    assert.equal(service.size(), 1);
  });

  it('evicts the oldest entry beyond SEMANTIC_INDEX_MAX', () => {
    const service = createSemanticService({
      config: testConfig({ SEMANTIC_INDEX_MAX: '2' }),
      logger: quietLogger(),
      persist: false,
    });
    seed(service, [
      { cid: 'bafk1', text: 'one' },
      { cid: 'bafk2', text: 'two' },
      { cid: 'bafk3', text: 'three' },
    ]);
    assert.equal(service.size(), 2);
  });

  it('reports its state, including the noise baseline for the shared space', () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'one' }]);
    const stats = service.stats();
    assert.equal(stats.size, 1);
    assert.equal(stats.status, 'ready');
    assert.equal(stats.outDim, 384);
    assert.equal(stats.persisted, false);
    assert.equal(Object.values(stats.byProjection)[0], 1);
  });
});

describe('services/semantic: search', () => {
  it('ranks the exact match first with a similarity of 1', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [
      { cid: 'bafk-target', text: 'the exact query text' },
      { cid: 'bafk-other', text: 'something else entirely' },
      { cid: 'bafk-third', text: 'a third unrelated memory' },
    ]);
    const result = await service.search({ query: 'the exact query text', trustWeighted: false });
    assert.equal(result.results[0].cid, 'bafk-target');
    assert.ok(Math.abs(result.results[0].similarity - 1) < 1e-6);
  });

  it('ships the noise baseline in every response', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [{ cid: 'bafk1', text: 'one' }]);
    const result = await service.search({ query: 'anything' });
    // The number that exposed the original bug. Beside every similarity, a regression to noise is
    // visible rather than plausible.
    assert.ok(Math.abs(result.diagnostics.noiseBaseline - 1 / Math.sqrt(384)) < 1e-12);
    assert.equal(result.diagnostics.indexSize, 1);
    assert.equal(result.diagnostics.projectionId, projection.projectionId(384, 384));
  });

  it('drops entries from a different projection instead of scoring them', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [{ cid: 'bafk-same', text: 'same projection' }]);
    const aligned = service.align(mockEmbedding('other projection', 384));
    service.upsert({
      cid: 'bafk-foreign',
      cidDigest: digestFor('bafk-foreign'),
      owner: ALICE,
      z: aligned.z,
      lsh: aligned.lsh,
      projectionId: 'neuromesh-proj/v0/some-other-projection/768-384/deadbeef',
    });
    const result = await service.search({ query: 'same projection', trustWeighted: false });
    assert.deepEqual(
      result.results.map((r) => r.cid),
      ['bafk-same'],
    );
    const dropped = result.diagnostics.skipped.find((s) => s.cid === 'bafk-foreign');
    // Comparing across projections is the original defect. Producing a number for it anyway would
    // reintroduce the bug at the ranking layer.
    assert.ok(dropped);
    assert.match(dropped.reason, /projection_mismatch/);
  });

  it('skips revoked entries', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [{ cid: 'bafk-live', text: 'live memory' }]);
    const aligned = service.align(mockEmbedding('revoked memory', 384));
    service.upsert({
      cid: 'bafk-dead',
      cidDigest: digestFor('bafk-dead'),
      owner: ALICE,
      z: aligned.z,
      lsh: aligned.lsh,
      projectionId: aligned.projectionId,
      revoked: true,
    });
    const result = await service.search({ query: 'revoked memory', trustWeighted: false });
    assert.ok(!result.results.some((r) => r.cid === 'bafk-dead'));
    assert.ok(
      result.diagnostics.skipped.some((s) => s.cid === 'bafk-dead' && s.reason === 'revoked'),
    );
  });

  it('re-ranks by trust without ever gating on it', async () => {
    const service = build({
      embeddings: fakeEmbeddings(),
      reputation: fakeReputation({ [ALICE]: 0.9, [BOB]: 0 }),
    });
    // Two entries with the same content, so similarity is identical and only trust separates them.
    const aligned = service.align(mockEmbedding('identical content', 384));
    for (const [cid, owner] of [
      ['bafk-bob', BOB],
      ['bafk-alice', ALICE],
    ]) {
      service.upsert({
        cid,
        cidDigest: digestFor(cid),
        owner,
        z: aligned.z,
        lsh: aligned.lsh,
        projectionId: aligned.projectionId,
      });
    }
    const result = await service.search({ query: 'identical content', trustWeighted: true });
    assert.equal(result.results[0].cid, 'bafk-alice');
    assert.equal(result.results[0].trustWeight, 0.9);
    // The zero-reputation memory is ranked below, never removed: reputation re-ranks, it never gates.
    assert.equal(result.results[1].cid, 'bafk-bob');
    assert.ok(result.results[1].score > 0);
  });

  it('leaves the score equal to the similarity when trust weighting is off', async () => {
    const service = build({
      embeddings: fakeEmbeddings(),
      reputation: fakeReputation({ [ALICE]: 0.9 }),
    });
    seed(service, [{ cid: 'bafk1', text: 'a memory' }]);
    const result = await service.search({ query: 'a memory', trustWeighted: false });
    assert.ok(Math.abs(result.results[0].score - result.results[0].similarity) < 1e-9);
  });

  it('ranks an agent at the trust floor when reputation is unavailable', async () => {
    const service = build({
      embeddings: fakeEmbeddings(),
      reputation: {
        /**
         * @returns {Promise<never>} Always rejects.
         */
        scoreOf: async () => {
          throw new Error('rpc is down');
        },
      },
    });
    seed(service, [{ cid: 'bafk1', text: 'a memory' }]);
    const result = await service.search({ query: 'a memory', trustWeighted: true });
    // An outage must not become a gate.
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].trustWeight, 0);
    assert.ok(result.results[0].score > 0);
  });

  it('never fabricates a preview', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [{ cid: 'bafk1', text: 'secret content' }]);
    const result = await service.search({ query: 'secret content' });
    // The plaintext is only reachable through the authenticated per-CID unwrap.
    assert.equal(result.results[0].preview, null);
  });

  it('filters by owner', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [
      { cid: 'bafk-a', text: 'shared text', owner: ALICE },
      { cid: 'bafk-b', text: 'shared text', owner: BOB },
    ]);
    const result = await service.search({ query: 'shared text', owner: BOB });
    assert.deepEqual(
      result.results.map((r) => r.cid),
      ['bafk-b'],
    );
  });

  it('applies a similarity floor', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    seed(service, [{ cid: 'bafk1', text: 'one thing' }]);
    const result = await service.search({
      query: 'a completely different thing',
      minSimilarity: 0.99,
      trustWeighted: false,
    });
    assert.equal(result.results.length, 0);
  });

  it('honours topK and validates it', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    // Three entries with identical content, so all three score above the similarity floor and the
    // only thing that can reduce the result count is topK itself.
    const aligned = service.align(mockEmbedding('identical', 384));
    for (const cid of ['bafk1', 'bafk2', 'bafk3']) {
      service.upsert({
        cid,
        cidDigest: digestFor(cid),
        owner: ALICE,
        z: aligned.z,
        lsh: aligned.lsh,
        projectionId: aligned.projectionId,
      });
    }
    assert.equal((await service.search({ query: 'identical', topK: 2 })).results.length, 2);
    await assert.rejects(
      service.search({ query: 'one', topK: 0 }),
      (err) => /** @type {any} */ (err).status === 400,
    );
    await assert.rejects(
      service.search({ query: 'one', topK: 1000 }),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });

  it('requires a query or an embedding', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    await assert.rejects(service.search({}), (err) => /** @type {any} */ (err).status === 400);
  });

  it('accepts a raw embedding without needing the embedding service', async () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'target' }]);
    const result = await service.search({
      embedding: mockEmbedding('target', 384),
      trustWeighted: false,
    });
    assert.equal(result.results[0].cid, 'bafk1');
  });

  it('orders ties by ascending CID, so the ranking is total and reproducible', async () => {
    const service = build({ embeddings: fakeEmbeddings() });
    const aligned = service.align(mockEmbedding('tied content', 384));
    for (const cid of ['bafk-c', 'bafk-a', 'bafk-b']) {
      service.upsert({
        cid,
        cidDigest: digestFor(cid),
        owner: ALICE,
        z: aligned.z,
        lsh: aligned.lsh,
        projectionId: aligned.projectionId,
      });
    }
    const result = await service.search({ query: 'tied content', trustWeighted: false });
    assert.deepEqual(
      result.results.map((r) => r.cid),
      ['bafk-a', 'bafk-b', 'bafk-c'],
    );
  });
});

describe('services/semantic: lifecycle', () => {
  it('reports degraded rather than down on a cold, empty index', async () => {
    const service = build();
    await service.init();
    assert.equal(service.stats().status, 'degraded');
  });

  it('does not write to disk when persistence is off', async () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'one' }]);
    assert.deepEqual(await service.save(), { written: 0, path: null });
  });

  it('clears cleanly on shutdown', async () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'one' }]);
    await service.shutdown();
    assert.equal(service.size(), 0);
  });

  it('removes an entry by its digest', () => {
    const service = build();
    seed(service, [{ cid: 'bafk1', text: 'one' }]);
    const key = service.stats().size === 1 ? [...Object.keys(service.stats().byProjection)] : [];
    assert.equal(key.length, 1);
    const entry = service.get(digestFor('bafk1'));
    assert.ok(entry);
    assert.equal(service.remove(entry.cidDigest), true);
    assert.equal(service.size(), 0);
    assert.equal(service.remove(entry.cidDigest), false);
  });
});
