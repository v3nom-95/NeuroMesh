/**
 * Deterministic cross-model projection.
 *
 * This suite exists because of a specific, measured bug: the v1 projection matrix was drawn from
 * `Math.random()`, so every process and every node projected into a different subspace and the
 * published cross-model similarity matrix was statistically indistinguishable from noise (sample SD
 * 0.0441 against the 0.0510 prediction; chi-square 3.82 on 6 dof, p = 0.70).
 *
 * The headline case therefore does not merely re-run the code in this process — it **forks a second
 * Node process** and asserts byte-identical output. That is the comparison the old implementation
 * would have failed with probability 1.
 *
 * No network, no filesystem writes, no env.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DimensionMismatchError } from '../../../src/protocol/errors.js';
import {
  PROJECTION_PARAMS,
  alignEmbedding,
  buildProjectionMatrix,
  derivePlanes,
  hammingDistance,
  keystream,
  l2Normalize,
  noiseBaseline,
  projectEmbedding,
  projectionId,
  projectionMatrixDigest,
  projectionSeed,
  simhash256,
} from '../../../src/protocol/projection.js';
import { cosineSimilarity } from '../../../src/protocol/similarity.js';

const MODULE_URL = new URL('../../../src/protocol/projection.js', import.meta.url).href;

/** A fixed, non-random 768-d test vector. */
const vector768 = () => Array.from({ length: 768 }, (_, i) => Math.sin(i / 7) + Math.cos(i / 3));

/** Float64 vector to a base64 string, so two processes can compare bit patterns, not decimals. */
function bits(vec) {
  const buf = new ArrayBuffer(vec.length * 8);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i += 1) view.setFloat64(i * 8, vec[i], true);
  return Buffer.from(buf).toString('base64');
}

/**
 * Compute the projection fingerprint in a *separate* Node process.
 *
 * The script is passed with `--input-type=module -e`, so there is no fixture file for the test
 * runner to accidentally pick up as a test.
 *
 * @returns {{ id: string, matrix: string, aligned: string, simhash: string, seed: string }}
 */
function fingerprintInChildProcess() {
  const source = `
    import { alignEmbedding, projectionMatrixDigest, projectionSeed, simhash256 }
      from ${JSON.stringify(MODULE_URL)};
    const v = Array.from({ length: 768 }, (_, i) => Math.sin(i / 7) + Math.cos(i / 3));
    const a = alignEmbedding({ embedding: v, targetDim: 384 });
    const buf = new ArrayBuffer(a.aligned.length * 8);
    const view = new DataView(buf);
    for (let i = 0; i < a.aligned.length; i += 1) view.setFloat64(i * 8, a.aligned[i], true);
    process.stdout.write(JSON.stringify({
      id: a.projectionId,
      matrix: projectionMatrixDigest(768, 384),
      aligned: Buffer.from(buf).toString('base64'),
      simhash: Buffer.from(simhash256(a.aligned)).toString('hex'),
      seed: projectionSeed(768, 384),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return JSON.parse(out);
}

describe('determinism across processes', () => {
  it('a SECOND Node process produces a byte-identical matrix, vector and signature', () => {
    const local = alignEmbedding({ embedding: vector768(), targetDim: 384 });
    const child = fingerprintInChildProcess();

    assert.equal(child.seed, projectionSeed(768, 384), 'seed must be a pure function of the dims');
    assert.equal(child.id, local.projectionId, 'projectionId must agree');
    assert.equal(
      child.matrix,
      projectionMatrixDigest(768, 384),
      'the projection MATRIX must be byte-identical in a fresh process — this is the assertion the ' +
        'Math.random() implementation could never pass',
    );
    assert.equal(child.aligned, bits(local.aligned), 'the projected vector must be bit-identical');
    assert.equal(
      child.simhash,
      Buffer.from(simhash256(local.aligned)).toString('hex'),
      'the published SimHash signature must be identical, or candidate retrieval is unreproducible',
    );
  });

  it('two child processes agree with each other, not just with this one', () => {
    const a = fingerprintInChildProcess();
    const b = fingerprintInChildProcess();
    assert.deepEqual(a, b);
  });
});

describe('determinism in-process', () => {
  it('repeated calls return the identical matrix digest', () => {
    assert.equal(projectionMatrixDigest(768, 384), projectionMatrixDigest(768, 384));
  });

  it('memoisation cannot change a result: a rebuilt matrix equals the cached one', () => {
    const first = buildProjectionMatrix(64, 16);
    const second = buildProjectionMatrix(64, 16);
    assert.deepEqual(Array.from(first), Array.from(second));
  });

  it('the aligned vector is identical on a second call (no hidden module state)', () => {
    const v = vector768();
    assert.equal(
      bits(alignEmbedding({ embedding: v }).aligned),
      bits(alignEmbedding({ embedding: v }).aligned),
    );
  });

  it('the keystream is reproducible from its seed alone', () => {
    const seed = projectionSeed(8, 4);
    const a = Array.from({ length: 16 }, keystream(seed));
    const b = Array.from({ length: 16 }, keystream(seed));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, Array.from({ length: 16 }, keystream(projectionSeed(8, 2))));
  });
});

describe('the matrix has the specified Achlioptas distribution', () => {
  it('entries take exactly three values: +c, 0, -c with c = sqrt(3 / toDim)', () => {
    const toDim = 64;
    const matrix = buildProjectionMatrix(256, toDim);
    const c = Math.sqrt(3 / toDim);
    const seen = new Set(matrix);
    assert.deepEqual(
      [...seen].sort((x, y) => x - y),
      [-c, 0, c],
    );
  });

  it('is sparse: about two thirds of entries are zero', () => {
    const matrix = buildProjectionMatrix(256, 64);
    const zeros = matrix.reduce((n, x) => n + (x === 0 ? 1 : 0), 0);
    const fraction = zeros / matrix.length;
    assert.ok(
      Math.abs(fraction - 2 / 3) < 0.01,
      `expected ~2/3 zeros for density s=3, got ${fraction.toFixed(4)}`,
    );
  });

  it('is balanced: +c and -c occur about equally often', () => {
    const matrix = buildProjectionMatrix(256, 64);
    const pos = matrix.reduce((n, x) => n + (x > 0 ? 1 : 0), 0);
    const neg = matrix.reduce((n, x) => n + (x < 0 ? 1 : 0), 0);
    assert.ok(Math.abs(pos - neg) / matrix.length < 0.01, `pos ${pos} vs neg ${neg}`);
  });

  it('exposes its parameters, so a reimplementation has something to check against', () => {
    assert.equal(PROJECTION_PARAMS.density, 3);
    assert.equal(PROJECTION_PARAMS.thresholdPositive, Math.floor(2 ** 32 / 6));
    assert.equal(PROJECTION_PARAMS.thresholdNegative, Math.floor(2 ** 32 / 3));
    assert.equal(PROJECTION_PARAMS.wordOrder, 'big-endian uint32');
  });
});

describe('projectionId', () => {
  it('encodes version, algorithm, PRNG and both dimensions', () => {
    assert.equal(
      projectionId(768, 384),
      `neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/768-384/${projectionSeed(768, 384).slice(2, 10)}`,
    );
  });

  it('differs for different dimension pairs', () => {
    assert.notEqual(projectionId(768, 384), projectionId(512, 384));
    assert.notEqual(projectionId(768, 384), projectionId(768, 256));
  });
});

describe('alignEmbedding', () => {
  it('returns a unit-norm vector of the target dimension', () => {
    const { aligned, targetDim, projected } = alignEmbedding({ embedding: vector768() });
    assert.equal(aligned.length, 384);
    assert.equal(targetDim, 384);
    assert.equal(projected, true);
    assert.ok(Math.abs(1 - Math.sqrt(aligned.reduce((s, x) => s + x * x, 0))) < 1e-12);
  });

  it('does not project when the dimensions already match, and says so', () => {
    const v = Array.from({ length: 384 }, (_, i) => Math.cos(i));
    const result = alignEmbedding({ embedding: v, targetDim: 384 });
    assert.equal(result.projected, false);
    assert.deepEqual(Array.from(result.aligned), Array.from(l2Normalize(v)));
  });

  it('REFUSES to zero-pad a smaller vector up to a larger dimension', () => {
    assert.throws(
      () => alignEmbedding({ embedding: new Array(384).fill(0.1), targetDim: 768 }),
      (error) => {
        assert.ok(error instanceof DimensionMismatchError);
        assert.match(error.message, /zero-padded/);
        return true;
      },
    );
  });

  it('rejects an empty vector', () => {
    assert.throws(() => alignEmbedding({ embedding: [] }), DimensionMismatchError);
  });

  it('rejects a dimension outside the contract bounds', () => {
    assert.throws(
      () => alignEmbedding({ embedding: vector768(), targetDim: 0 }),
      DimensionMismatchError,
    );
    assert.throws(
      () => alignEmbedding({ embedding: new Array(9000).fill(1), targetDim: 384 }),
      DimensionMismatchError,
    );
  });

  it('reports the noise baseline alongside every alignment', () => {
    const { noiseBaseline: nb } = alignEmbedding({ embedding: vector768() });
    assert.equal(nb, 1 / Math.sqrt(384));
    assert.ok(Math.abs(nb - 0.05103) < 1e-4);
  });
});

describe('the projection approximately preserves within-space geometry', () => {
  it('a Johnson-Lindenstrauss check: pairwise cosines survive the 768 -> 384 projection', () => {
    // Deterministic pseudo-vectors, no randomness in the test either.
    const make = (k) => Array.from({ length: 768 }, (_, i) => Math.sin((i + 1) * k * 0.017));
    const a = make(1);
    const b = make(1.02); // deliberately close to `a`
    const c = make(9); // deliberately unrelated

    const before = { ab: cosineSimilarity(a, b), ac: cosineSimilarity(a, c) };
    const pa = alignEmbedding({ embedding: a }).aligned;
    const pb = alignEmbedding({ embedding: b }).aligned;
    const pc = alignEmbedding({ embedding: c }).aligned;
    const after = { ab: cosineSimilarity(pa, pb), ac: cosineSimilarity(pa, pc) };

    assert.ok(
      Math.abs(after.ab - before.ab) < 0.1,
      `close pair: ${before.ab.toFixed(4)} -> ${after.ab.toFixed(4)}`,
    );
    assert.ok(
      after.ab > after.ac,
      'the projection must preserve the ORDER of similarities, which is what retrieval depends on',
    );
    assert.ok(
      after.ab > 10 * noiseBaseline(384),
      'a genuine match must land far above the noise floor, unlike the v1 cross-model matrix',
    );
  });

  it('projectEmbedding is linear', () => {
    const a = vector768();
    const b = a.map((x) => x * 2);
    const pa = projectEmbedding(a, 384);
    const pb = projectEmbedding(b, 384);
    for (let i = 0; i < 384; i += 1) assert.ok(Math.abs(pb[i] - 2 * pa[i]) < 1e-12);
  });
});

describe('noiseBaseline', () => {
  it('is 1/sqrt(k) and is exported as a real function, not prose', () => {
    assert.equal(noiseBaseline(384), 1 / Math.sqrt(384));
    assert.equal(noiseBaseline(768), 1 / Math.sqrt(768));
    assert.throws(() => noiseBaseline(0), DimensionMismatchError);
  });
});

describe('simhash', () => {
  it('produces 256 bits and is deterministic', () => {
    const v = alignEmbedding({ embedding: vector768() }).aligned;
    const sig = simhash256(v);
    assert.equal(sig.length, 32);
    assert.deepEqual(Array.from(simhash256(v)), Array.from(sig));
  });

  it('similar vectors give closer signatures than unrelated ones', () => {
    const make = (k) => Array.from({ length: 384 }, (_, i) => Math.sin((i + 1) * k * 0.017));
    const a = l2Normalize(make(1));
    const near = l2Normalize(make(1.01));
    const far = l2Normalize(make(9));
    const dNear = hammingDistance(simhash256(a), simhash256(near));
    const dFar = hammingDistance(simhash256(a), simhash256(far));
    assert.ok(dNear < dFar, `near ${dNear} should be closer than far ${dFar}`);
  });

  it('derivePlanes is deterministic and rejects a non-byte-aligned bit count', () => {
    assert.deepEqual(Array.from(derivePlanes(16, 8)), Array.from(derivePlanes(16, 8)));
    assert.throws(() => derivePlanes(16, 12), { code: 'INVALID_SIMHASH_BITS' });
  });

  it('hammingDistance rejects mismatched widths', () => {
    assert.throws(
      () => hammingDistance(new Uint8Array(4), new Uint8Array(8)),
      DimensionMismatchError,
    );
  });
});

describe('no unseeded randomness anywhere in the alignment path', () => {
  /**
   * Strip block comments, line comments and string literals, so a mention of the old API inside a
   * deprecation message is not mistaken for a call. This is a deliberately crude scanner — it exists
   * to catch a regression, not to parse JavaScript.
   *
   * @param {string} source Source text.
   * @returns {string} Source with comments and string literals removed.
   */
  function stripCommentsAndStrings(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  const files = [
    'src/protocol/projection.js',
    'src/protocol/similarity.js',
    'lib/semantic-sync.js',
  ];

  for (const file of files) {
    it(`${file} contains no executable Math.random`, () => {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      assert.ok(
        !/Math\s*\.\s*random/.test(stripCommentsAndStrings(source)),
        `${file} must never draw from the unseeded platform PRNG`,
      );
    });
  }
});

describe('the removed v1 API', () => {
  it('generateProjectionMatrix throws REMOVED_UNSOUND_API with the reason and the number', async () => {
    const legacy = await import('../../../lib/semantic-sync.js');
    assert.throws(
      () => legacy.generateProjectionMatrix(768, 384),
      (error) => {
        assert.equal(error.code, 'REMOVED_UNSOUND_API');
        assert.match(error.message, /p = 0\.70/);
        return true;
      },
    );
  });

  it('the old positional alignEmbedding signature throws instead of guessing', async () => {
    const legacy = await import('../../../lib/semantic-sync.js');
    assert.throws(() => legacy.alignEmbedding(vector768(), 768, 384, null), {
      code: 'REMOVED_UNSOUND_API',
    });
    assert.throws(() => legacy.projectEmbedding([1, 2], [[1], [2]]), {
      code: 'REMOVED_UNSOUND_API',
    });
  });

  it('the v2 keyword form still works through the facade', async () => {
    const legacy = await import('../../../lib/semantic-sync.js');
    const viaFacade = legacy.alignEmbedding({ embedding: vector768(), targetDim: 384 });
    assert.equal(bits(viaFacade.aligned), bits(alignEmbedding({ embedding: vector768() }).aligned));
  });
});
