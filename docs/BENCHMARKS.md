# Benchmarks

> **What this page will and will not do.** It reports two separate measurements with two separate
> methodologies and two very different levels of confidence, and it labels which is which on every
> table. It does not average them together, does not present a single-run number as a benchmark, and
> does not report anything it cannot say how it was measured.

---

## Contents

- [1. Summary](#1-summary)
- [2. Measurement A — local primitives](#2-measurement-a--local-primitives)
- [3. Measurement B — end-to-end pipeline](#3-measurement-b--end-to-end-pipeline)
- [4. What the numbers mean](#4-what-the-numbers-mean)
- [5. Reproducing these results](#5-reproducing-these-results)
- [6. What is deliberately not measured](#6-what-is-deliberately-not-measured)
- [7. Statistical notes](#7-statistical-notes)

---

## 1. Summary

The headline result is a shape, not a number: **local cryptography and inference are negligible; the
network dominates by three to four orders of magnitude.**

| Stage                                 | Median       | Confidence                             |
| ------------------------------------- | ------------ | -------------------------------------- |
| Envelope encrypt (HKDF + AES-256-GCM) | **0.027 ms** | High — n=200                           |
| JL projection 768 → 384               | **0.195 ms** | High — n=200                           |
| Embed, MiniLM 384-d                   | **2.85 ms**  | High — n=40                            |
| Embed, DistilRoBERTa 768-d            | **6.79 ms**  | High — n=40                            |
| IPFS pin (Pinata)                     | **2.73 s**   | **Low — n=5, one run**                 |
| Sepolia commit + 1 confirmation       | **16.2 s**   | **Low — n=5, one run, testnet jitter** |
| End-to-end per memory                 | **19.2 s**   | **Low — n=5, one run**                 |

Everything that happens on the machine finishes in under 10 ms combined. Everything that leaves the
machine takes seconds. Any optimisation effort spent on the local path is wasted.

---

## 2. Measurement A — local primitives

**Source:** `bench.json`, produced by a dedicated benchmark harness.
**Confidence: high.** Repeated iterations, per-iteration timing, order statistics reported.

### Environment

| Property        | Value                                      |
| --------------- | ------------------------------------------ |
| Node.js         | `v22.13.1`                                 |
| Platform        | `win32`                                    |
| Runtime         | ONNX via `@huggingface/transformers`       |
| Timing          | `performance.now()`, per iteration         |
| Cold model load | **excluded** and reported separately below |

> **Not recorded in this run:** CPU model, core count, RAM, thermal state, whether other processes
> were competing. Those matter for absolute numbers. Treat the values as _this class of machine_,
> and compare across stages rather than against another machine's figures.

### 2.1 Embedding inference

Cold model load, excluded from the inference statistics and reported separately because it is paid
once per process:

| Model                         | Dim | Cold load    |
| ----------------------------- | --- | ------------ |
| `Xenova/all-MiniLM-L6-v2`     | 384 | **197.3 ms** |
| `Xenova/all-distilroberta-v1` | 768 | **665.5 ms** |

That is the load time with the weights already on disk. A cold _container_ additionally pays a
~90 MB download per model.

Inference, warm:

| Model               |   n |  mean |   **p50** |    **p95** |   min |    max | stddev |
| ------------------- | --: | ----: | --------: | ---------: | ----: | -----: | -----: |
| MiniLM 384-d        |  40 | 3.562 | **2.853** | **12.495** | 2.292 | 14.417 |  2.463 |
| DistilRoBERTa 768-d |  40 | 7.095 | **6.788** | **10.280** | 6.005 | 12.060 |  1.100 |

All values in milliseconds.

**Read the dispersion, not just the median.** MiniLM has the lower median (2.85 ms vs 6.79 ms) but
the _worse_ tail: its p95 is 12.50 ms against DistilRoBERTa's 10.28 ms, and its stddev is 2.24× as
large despite being the smaller model. Its max (14.4 ms) is 6.3× its min (2.29 ms), while
DistilRoBERTa's max is 2.0× its min. The smaller model is faster on average and less predictable —
consistent with short runs on a machine with other work happening, where a few iterations catch a
scheduling or GC event. **If you are sizing a p99 budget, DistilRoBERTa is the better-behaved model
even though it is slower.**

### 2.2 Envelope encryption

| Scheme                                              |   n |   mean |    **p50** |    **p95** |    min |    max | stddev |
| --------------------------------------------------- | --: | -----: | ---------: | ---------: | -----: | -----: | -----: |
| **HKDF-SHA256 + AES-256-GCM** (v2, current)         | 200 |  0.034 |  **0.027** |  **0.058** |  0.018 |  0.768 |  0.054 |
| PBKDF2-SHA512 100k + AES-256-GCM (v1, **replaced**) |  20 | 56.961 | **53.135** | **83.210** | 46.348 | 83.210 | 10.541 |

Milliseconds. **The v2 scheme is roughly 1,970× faster at the median and strictly stronger.**

That is not a trade-off that was won by weakening anything. The v1 cost was almost entirely 100,000
SHA-512 iterations stretching a value that was _already a uniformly random 256-bit scalar_. PBKDF2
exists to stretch low-entropy passwords; applied to a random key it buys nothing and costs 53 ms per
memory. Replacing it with a single HKDF-Expand removed the cost, and separating the encryption
keypair from the signing key removed the far more serious defect that sharing a memory required
sharing the wallet key. See
[PROTOCOL.md §6](./PROTOCOL.md#6-key-hierarchy-and-identity).

The `max` of 0.768 ms against a p95 of 0.058 ms is a single outlier in 200 iterations — a GC pause or
a scheduling hiccup, not a property of the algorithm. Note that the mean (0.034) sits above the p50
(0.027) because of it, which is exactly why medians are quoted first everywhere on this page.

### 2.3 Deterministic projection

| Operation            |   n |  mean |   **p50** |   **p95** |   min |    max | stddev |
| -------------------- | --: | ----: | --------: | --------: | ----: | -----: | -----: |
| Achlioptas 768 → 384 | 200 | 0.322 | **0.195** | **0.281** | 0.193 | 10.218 |  0.942 |

Scheme: deterministic sparse Achlioptas, seeded (`bench.json` records the seeded-xorshift32 variant;
the shipped implementation in `src/protocol/projection.js` draws from an **AES-256-CTR** keystream —
see [§5.3](#53-known-drift-in-the-projection-row)).

The `max` of 10.218 ms is the **first** call, which builds and memoises the 768 × 384 matrix. Every
subsequent call reuses it, which is why the p50 (0.195) and p95 (0.281) are tight while the mean
(0.322) is pulled up by that one cost. The memo is a pure cache — its value is a deterministic
function of its key, so its presence or absence cannot change any output.

### 2.4 Cosine similarity

| Operation     |    n |  mean |       p50 |   p95 |   max |
| ------------- | ---: | ----: | --------: | ----: | ----: |
| Cosine, 384-d | 5000 | 0.001 | **0.000** | 0.001 | 0.259 |

**Below timer resolution.** `performance.now()` cannot measure a 384-element dot product on this
platform: a p50 of exactly 0 means "faster than the clock ticks", not "instantaneous". This row is
reported as _unmeasurable at this granularity_ rather than charted as a zero, because a bar of height
zero in a chart is a claim, and this is an absence of measurement.

To get a real number, batch: time 10⁶ iterations and divide.

---

## 3. Measurement B — end-to-end pipeline

**Source:** `simulation-results.json`, a single sequential run of `scripts/simulate.js`.

> ### Confidence: LOW. Read these caveats before quoting any number below.
>
> 1. **n = 5.** One run, five memories. That is enough to show an order of magnitude and nothing
>    more. No confidence interval computed here would be meaningful.
> 2. **Five agent roles, one wallet.** All five agents share a single address. The identity layer is
>    not exercised for sybil behaviour, and because `ReputationManager` requires
>    `target != msg.sender`, the reputation scenarios in that file **could not have executed on
>    chain** and were computed in JavaScript. The `reputationEvents` array is a **modelled scenario,
>    not measured on-chain data.**
> 3. **The chain figure is Sepolia block-inclusion jitter**, not a property of NeuroMesh. Any other
>    application submitting a transaction at the same moment would have measured the same thing.
> 4. **Legacy code path.** The run used `lib/encryption.js` (PBKDF2-SHA512 100k) and
>    `lib/semantic-sync.js` (unseeded `Math.random()` projection), _not_ `src/protocol/`. The
>    encryption row is therefore a measurement of the **superseded** scheme.
> 5. **No environment block was recorded** — no CPU, OS, Node version, RPC provider or date.
> 6. **Not reproducible as-is.** No seed, no pinned model revision, and the network conditions are
>    gone.

### Per-stage latency, n = 5

| Stage                                                          |   n |   min |    **p50** |    mean |    max | Spread (max/min) |
| -------------------------------------------------------------- | --: | ----: | ---------: | ------: | -----: | ---------------: |
| Embedding (both models pooled)                                 |   5 |     9 |     **15** |    18.4 |     28 |             3.1× |
| Key derivation + encryption (PBKDF2-SHA512 100k + AES-256-GCM) |   5 |    50 |     **57** |    69.2 |    121 |             2.4× |
| IPFS pin (Pinata)                                              |   5 | 2,722 |  **2,727** | 2,772.4 |  2,862 |            1.05× |
| Sepolia commit + 1 confirmation                                |   5 | 7,033 | **16,190** |  15,169 | 21,288 |         **3.0×** |
| End-to-end per memory                                          |   5 | 9,888 | **19,160** |  18,080 | 24,298 |             2.5× |

All values in milliseconds. Raw arrays, so you can recompute anything:

```text
embeddingLatencies  [ 9, 15, 13, 28, 27 ]
encryptionLatencies [ 50, 121, 57, 61, 57 ]
ipfsLatencies       [ 2862, 2824, 2727, 2727, 2722 ]
blockchainLatencies [ 16190, 21288, 7033, 19970, 11364 ]
totalLatencies      [ 19160, 24298, 9888, 22835, 14219 ]
```

Composition of the five agents: three on `all-MiniLM-L6-v2` (384-d), two on
`all-distilroberta-v1` (768-d). The embedding row pools both models, which is why its spread is 3.1×:
`[9, 15, 13]` are MiniLM and `[28, 27]` are DistilRoBERTa. **Splitting them gives n=3 and n=2, which
is too few to quote as separate statistics** — use Measurement A for per-model figures.

### Three observations that survive the small n

- **The IPFS row is remarkably tight** (1.05× spread, stddev under 60 ms on a 2.7 s mean). Pinata's
  pin latency was the most predictable thing measured.
- **The chain row is the opposite** (3.0× spread, 7.0 s to 21.3 s). That is Sepolia proposer timing.
  A 1-confirmation wait on a public testnet is a coin flip within a range, not a service level.
- **The mean is below the median on both the chain and total rows** — the distribution is
  left-skewed by one fast inclusion (7.0 s), which is why medians are reported alongside means
  everywhere.

### The encryption row is mislabelled in the source

`simulation-results.json` calls this "AES-256 Encryption". **It is almost entirely PBKDF2.** AES-GCM
over a few hundred bytes is microseconds — Measurement A puts the whole HKDF + AES-256-GCM operation
at a 0.027 ms median. The ~57 ms is 100,000 SHA-512 iterations. The row is renamed here to say so.

---

## 4. What the numbers mean

### 4.1 Where the time goes

Using Measurement A for the local stages and Measurement B for the network stages, for one 384-d
memory at the median:

| Stage                           |         Median | Share of total |
| ------------------------------- | -------------: | -------------: |
| Embed (MiniLM)                  |        2.85 ms |         0.015% |
| Project (if 768 → 384)          |        0.20 ms |         0.001% |
| Seal (HKDF + AES-256-GCM)       |        0.03 ms |        0.0002% |
| **Local subtotal**              |    **~3.1 ms** |    **~0.016%** |
| IPFS pin                        |       2,727 ms |          14.2% |
| Sepolia commit + 1 confirmation |      16,190 ms |          84.5% |
| **Network subtotal**            | **~18,917 ms** |     **~98.7%** |

The residual to the 19,160 ms end-to-end median is un-instrumented glue: JSON handling, HTTP
overhead, provider round-trips.

**Roughly 99.98% of the wall clock is network.** Two consequences follow directly:

1. **Optimising the local path is pointless.** Halving embedding time would improve end-to-end
   latency by 0.008%.
2. **The chain stage is not yours to optimise.** It is testnet block inclusion. The only real levers
   are `TX_CONFIRMATIONS`, batching commits, or moving to a faster chain — none of which is a
   NeuroMesh code change.

This is why `public/js/api.js` sets a 90 s commit deadline and why `TX_TIMEOUT_MS` defaults to 120 s.
The p95 end-to-end is 24.3 s from n=5; a 90 s budget leaves ~3.7× headroom for a tail this page has
too few samples to characterise.

### 4.2 The one improvement that is genuinely NeuroMesh's

The encryption rewrite: **53.135 ms → 0.027 ms at the median.** Against an 18.1 s end-to-end mean
that is a 0.3% improvement in wall clock — but the reason it was done was never speed. It was that
the v1 scheme made the AES passphrase the wallet private key, so sharing a memory meant disclosing
signing authority. The speedup is a side effect of removing a primitive that should never have been
there.

---

## 5. Reproducing these results

### 5.1 Measurement B — the end-to-end run

```bash
npm run simulate     # === npm run benchmark; both run scripts/simulate.js
```

Requires `SEPOLIA_RPC_URL`, a funded `PRIVATE_KEY` and `PINATA_JWT`. Costs real Sepolia gas and real
Pinata pins. Writes `simulation-results.json`.

> **Your numbers will differ, and that is expected.** The chain stage tracks Sepolia's state on the
> day you run it. Expect the same _shape_ — local negligible, network dominant — not the same
> values.

### 5.2 Measurement A — the local primitives

> **There is no committed script that regenerates `bench.json`.** `scripts/` contains `deploy.js`,
> `gen-abi.js`, `generate-report.js` and `simulate.js`. `npm run benchmark` is an alias for
> `npm run simulate`, which produces the **single-run** `simulation-results.json` (Measurement B),
> not the repeated-iteration statistics above. A committed `scripts/benchmark.js` is a roadmap item.

Until it lands, the procedure is fully specified and reproducible by hand:

| Setting    | Value                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Timer      | `performance.now()`, per iteration                                                                                         |
| Warmup     | Cold model load excluded and reported separately; the projection's first-call matrix build is visible as the `max` outlier |
| Iterations | 40 per embedding model; 200 for encryption and projection; 20 for the legacy PBKDF2 comparison; 5000 for cosine            |
| Reported   | `n`, `mean`, `p50`, `p95`, `min`, `max`, `stddev`                                                                          |
| Input      | A fixed short-text corpus, embedded once per iteration                                                                     |

```js
// Sketch. Time each iteration individually — never divide one total by n,
// which discards the distribution and is how a p95 gets lost.
import { performance } from 'node:perf_hooks';

function measure(label, n, fn) {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples[i] = performance.now() - t0;
  }
  const s = Array.from(samples).sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    label,
    n,
    mean: +mean.toFixed(3),
    p50: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    min: +s[0].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    stddev: +Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length).toFixed(3),
  };
}
```

Always record `node -p process.version` and `process.platform` alongside the output, and add the CPU
model — that is the one field this run is missing.

### 5.3 Known drift in the projection row

`bench.json` records the projection scheme as _"deterministic sparse Achlioptas (seeded xorshift32)"_.
The shipped implementation in `src/protocol/projection.js` uses **AES-256-CTR** as its keystream
(`PROJECTION_PRNG = 'aes-256-ctr'`, and the seed is a keccak256 of protocol constants, not an
xorshift state). The benchmark predates that change, so **0.195 ms is a figure for the xorshift
variant, not for the shipped one.** Both are the same construction — sparse Achlioptas at density
1/3, `sqrt(3/toDim)` scaling — differing only in how the words are drawn, so the figure is indicative
rather than exact. It should be re-measured against the shipped code.

---

## 6. What is deliberately not measured

Naming the gaps matters as much as the numbers.

| Not measured                       | Why it is absent                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gas costs**                      | `test/contracts/Gas.snapshot.spec.js` and `test/contracts/__snapshots__/gas.json` hold a snapshot from the Hardhat suite. It is not reproduced here because it is a regression guard, not a benchmark, and the snapshot is the authority                                                                                                                          |
| **Throughput / concurrency**       | Every measurement is single-threaded and sequential. Nothing here says how the node behaves under load. `EMBED_QUEUE_MAX` (64) and `TX_QUEUE_MAX` (32) exist precisely because that behaviour is uncharacterised                                                                                                                                                  |
| **Memory footprint**               | Not recorded. The compose file sets a 2 GB limit based on ONNX being the driver, which is an estimate, not a measurement                                                                                                                                                                                                                                          |
| **Retrieval quality**              | **No recall@k, no MRR, no nDCG, against no labelled corpus.** The trust-weighted ranking is implemented and tested for _correctness_, never for _quality_. Nobody has demonstrated that trust weighting improves retrieval                                                                                                                                        |
| **Cross-model retrieval accuracy** | Cannot be measured meaningfully, because the projection does not align independently trained encoders. See [PROTOCOL.md §7.2](./PROTOCOL.md#72-what-the-replacement-guarantees-and-what-it-does-not)                                                                                                                                                              |
| **Cross-model similarity matrix**  | **Deliberately not reproduced.** The historical matrix in `simulation-results.json` was produced by an unseeded `Math.random()` projection: six cross-model cosines, sample SD 0.0441 against the `1/sqrt(384) = 0.0510` noise prediction, chi-square 3.82 on 6 df, **p = 0.70**. It fit the pure-noise null comfortably. Reprinting it would be reprinting noise |
| **Multi-node / federation**        | There is no federation                                                                                                                                                                                                                                                                                                                                            |
| **Decrypt latency**                | Not separately measured. It is dominated by the IPFS fetch                                                                                                                                                                                                                                                                                                        |

---

## 7. Statistical notes

**On n = 5.** Five samples support an order-of-magnitude claim and nothing finer. A p95 from n=5 is
just the maximum. Every Measurement B figure is quoted with its `n` and its raw array so a reader can
verify that nothing was inflated by selective reporting.

**On percentile definition.** p50 and p95 here are the nearest-rank order statistics:
`s[ceil(p·n) − 1]` on the ascending sorted samples, no interpolation. For n=5, p50 is the third value
and p95 is the fifth (the maximum). For n=40, p95 is the 38th value.

**On mean versus median.** The median is quoted first throughout because several distributions have
outliers that drag the mean: the encryption max (0.768 ms against a 0.058 ms p95), the projection max
(10.218 ms, the matrix build), and the chain distribution's fast 7.0 s inclusion. Where the mean and
median differ materially, both are shown.

**On comparing across measurements.** Measurement A (`bench.json`) and Measurement B
(`simulation-results.json`) come from different code paths, different runs and possibly different
machines. The §4.1 composition table mixes them, and that is a stated approximation, not a measured
end-to-end trace. Read it as "roughly where the time goes", not as a profile.

**On what would make this page stronger.** A committed `scripts/benchmark.js`; a recorded CPU model;
n ≥ 30 on the network stages across several hours; a labelled retrieval corpus with recall@k; and a
re-measurement of the projection against the shipped AES-CTR keystream.

---

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the pipeline these stages belong to
- [PROTOCOL.md](./PROTOCOL.md) — the schemes being measured
- [DEPLOYMENT.md](./DEPLOYMENT.md) — the timeout budgets these figures justify
- [ROADMAP.md](./ROADMAP.md) — the committed benchmark harness and the retrieval-quality evaluation
