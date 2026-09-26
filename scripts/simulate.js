/**
 * NeuroMesh multi-agent swarm simulation.
 *
 * Drives a swarm of genuinely distinct on-chain agents through the full protocol:
 * DID registration, embedding, envelope encryption, content addressing, signed
 * memory commits, and reputation interactions.
 *
 * This replaces the v1 script, whose five "agents" all shared a single wallet — so
 * identity and reputation were logged off-chain rather than exercised. Here each
 * agent is a distinct address derived from a mnemonic via BIP-44, so endorsements
 * and reports are real transactions between real, separate identities.
 *
 * Defaults to the in-process Hardhat network: funded accounts, no cost, no secrets.
 * Running against a live network is opt-in and gated on an explicit confirmation.
 *
 * Usage:
 *   npx hardhat run scripts/simulate.js                         # local, free
 *   npx hardhat run scripts/simulate.js --network sepolia       # needs CONFIRM_SPEND=1
 *
 * Env:
 *   AGENTS=5              number of agents in the swarm
 *   CONFIRM_SPEND=1       required to run against any non-local chain
 *   NEUROMESH_EMBEDDING_PROVIDER=mock   skip model downloads
 *
 * @module scripts/simulate
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import hre from 'hardhat';

const LOCAL_CHAIN_IDS = new Set([31337, 1337]);
const DEFAULT_AGENTS = 5;
const MNEMONIC = 'test test test test test test test test test test test junk';

/** Contexts each agent contributes. Deliberately varied so similarity is meaningful. */
const CONTEXTS = [
  'The user prefers dark mode in all UI elements and uses keyboard shortcuts extensively.',
  'Server response latency should be kept below 200ms for optimal user experience.',
  'The database schema uses normalized tables with foreign key constraints for data integrity.',
  'Machine learning models should be retrained weekly using the latest production data.',
  'Security protocols require AES-256 encryption for all data at rest and TLS 1.3 in transit.',
  'Kubernetes pods define resource requests and limits to avoid noisy-neighbour effects.',
  'Feature flags default to off and are removed within two releases of full rollout.',
  'Every public API response carries a request id for distributed trace correlation.',
];

/** @param {string} m */
function say(m) {
  process.stdout.write(`${m}\n`);
}

/**
 * @param {number[]} xs
 */
function summarize(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean: Number(mean.toFixed(2)),
    p50: Number(s[Math.floor(s.length * 0.5)].toFixed(2)),
    min: Number(s[0].toFixed(2)),
    max: Number(s[s.length - 1].toFixed(2)),
  };
}

async function main() {
  const { ethers, network } = /** @type {any} */ (hre);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal = LOCAL_CHAIN_IDS.has(chainId);

  say('\nNeuroMesh swarm simulation');
  say(`  network   ${network.name} (chainId ${chainId})`);

  if (!isLocal && process.env.CONFIRM_SPEND !== '1') {
    say(
      `\n  Refusing to run against chain ${chainId}: this submits real transactions and spends\n` +
        '  funds from the configured key. Re-run with CONFIRM_SPEND=1 if that is intended.\n',
    );
    return;
  }

  const agentCount = Math.max(2, Number(process.env.AGENTS || DEFAULT_AGENTS));

  // ── Deploy (local) or load the recorded deployment (live) ───────────────
  /** @type {Record<string, string>} */
  let addresses;
  if (isLocal) {
    say('  deploying a fresh suite to the local chain...');
    const [deployer] = await ethers.getSigners();
    const identity = await (
      await ethers.getContractFactory('AgentIdentity')
    ).deploy(deployer.address);
    await identity.waitForDeployment();
    const ledger = await (
      await ethers.getContractFactory('MemoryLedger')
    ).deploy(deployer.address, await identity.getAddress());
    await ledger.waitForDeployment();
    const reputation = await (
      await ethers.getContractFactory('ReputationManager')
    ).deploy(deployer.address, await identity.getAddress(), deployer.address, 1024);
    await reputation.waitForDeployment();
    addresses = {
      AgentIdentity: await identity.getAddress(),
      MemoryLedger: await ledger.getAddress(),
      ReputationManager: await reputation.getAddress(),
    };
  } else {
    const rec = path.join(process.cwd(), 'deployments', `${chainId}.json`);
    if (!fs.existsSync(rec)) {
      say(`\n  No deployments/${chainId}.json. Deploy first: npm run deploy:sepolia\n`);
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(rec, 'utf8'));
    addresses = Object.fromEntries(
      Object.entries(parsed.contracts).map(([k, v]) => [k, /** @type {any} */ (v).address]),
    );
  }

  const identity = await ethers.getContractAt('AgentIdentity', addresses.AgentIdentity);
  const ledger = await ethers.getContractAt('MemoryLedger', addresses.MemoryLedger);
  const reputation = await ethers.getContractAt('ReputationManager', addresses.ReputationManager);

  // ── Build a swarm of DISTINCT wallets ──────────────────────────────────
  // This is the substantive fix over v1: separate addresses mean the identity
  // registry and the reputation graph are genuinely exercised.
  const [funder] = await ethers.getSigners();
  /** @type {any[]} */
  const agents = [];
  for (let i = 0; i < agentCount; i += 1) {
    const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i + 1}`);
    const wallet = new ethers.Wallet(hd.privateKey, ethers.provider);
    if (isLocal) {
      await ethers.provider.send('hardhat_setBalance', [
        wallet.address,
        '0x' + (10n ** 20n).toString(16),
      ]);
    }
    agents.push({ id: `Agent-${i}`, wallet, context: CONTEXTS[i % CONTEXTS.length] });
  }
  say(`  swarm     ${agentCount} distinct addresses (BIP-44 m/44'/60'/0'/0/1..${agentCount})`);
  if (!isLocal) {
    const bal = await ethers.provider.getBalance(funder.address);
    say(`  funder    ${funder.address} (${ethers.formatEther(bal)} ETH)`);
  }

  // ── Protocol + embeddings ──────────────────────────────────────────────
  if (!process.env.NEUROMESH_EMBEDDING_PROVIDER && isLocal) {
    process.env.NEUROMESH_EMBEDDING_PROVIDER = 'mock';
  }
  const envelope = await import('../src/protocol/envelope.js');
  const canonical = await import('../src/protocol/canonical.js');
  const projection = await import('../src/protocol/projection.js');
  const similarity = await import('../src/protocol/similarity.js');
  const { createEmbeddingService } = await import('../src/services/embeddings.js');

  const embeddings = createEmbeddingService();
  await embeddings.init();
  await embeddings.whenReady();
  const models = embeddings.models();
  say(`  encoders  ${models.join(', ')} (provider: ${embeddings.provider})\n`);

  const results = {
    generatedAt: new Date().toISOString(),
    chainId,
    network: network.name,
    addresses,
    agents: /** @type {any[]} */ ([]),
    memories: /** @type {any[]} */ ([]),
    reputationEvents: /** @type {any[]} */ ([]),
    similarity: /** @type {any[]} */ ([]),
    latencies: {
      registerMs: /** @type {number[]} */ ([]),
      embedMs: /** @type {number[]} */ ([]),
      encryptMs: /** @type {number[]} */ ([]),
      commitMs: /** @type {number[]} */ ([]),
      endorseMs: /** @type {number[]} */ ([]),
    },
  };

  // ── Phase 1: registration ──────────────────────────────────────────────
  say('Phase 1 — decentralized identity registration');
  for (const a of agents) {
    const modelKey = models[agents.indexOf(a) % models.length];
    if (await identity.isActive(a.wallet.address)) {
      say(`  ${a.id.padEnd(9)} already registered`);
    } else {
      const t = performance.now();
      const pub = a.wallet.signingKey.publicKey;
      const tx = await identity
        .connect(a.wallet)
        .registerAgent(pub, `did:neuromesh:${a.id.toLowerCase()}`);
      await tx.wait();
      results.latencies.registerMs.push(performance.now() - t);
      say(`  ${a.id.padEnd(9)} ${a.wallet.address} registered`);
    }
    results.agents.push({ id: a.id, address: a.wallet.address, model: modelKey });
  }

  // ── Phase 2: encrypted memory commits ──────────────────────────────────
  say('\nPhase 2 — embed, encrypt, address, commit');
  /** @type {{id: string, vector: number[]}[]} */
  const aligned = [];

  for (const a of agents) {
    const modelKey = models[agents.indexOf(a) % models.length];

    const tEmbed = performance.now();
    const embedded = await embeddings.embed(a.context, { model: modelKey });
    const embedMs = performance.now() - tEmbed;
    results.latencies.embedMs.push(embedMs);

    const raw = Array.from(embedded.vector);
    const info = embeddings.modelInfo(modelKey);

    const tEnc = performance.now();
    const cek = envelope.generateCek();
    const contentId = envelope.generateContentId();
    const aad = envelope.buildAad({
      agentDid: `did:pkh:eip155:${chainId}:${a.wallet.address}`,
      contentId,
      modelId: modelKey,
      keyVersion: 1,
    });
    const cipher = envelope.seal(a.context, { cek, aad });
    const encryptMs = performance.now() - tEnc;
    results.latencies.encryptMs.push(encryptMs);

    // Content addressing over the canonical payload: same logical payload => same CID.
    const payload = {
      version: 'neuromesh/2.0.0',
      agentDid: `did:pkh:eip155:${chainId}:${a.wallet.address}`,
      contentId,
      model: { id: modelKey, dim: info.dim },
      cipher,
    };
    const bytes = canonical.canonicalBytes(payload);
    const { cid } = canonical.cidFromBytes(bytes);

    const tCommit = performance.now();
    const tx = await ledger.connect(a.wallet).commitMemory({
      cid,
      prevCidHash: ethers.ZeroHash,
      model: embedded.chainModel,
      embeddingDim: embedded.dim,
      isEncrypted: true,
    });
    await tx.wait();
    const commitMs = performance.now() - tCommit;
    results.latencies.commitMs.push(commitMs);

    say(
      `  ${a.id.padEnd(9)} ${modelKey.padEnd(14)} ${info.dim}d  ` +
        `cid ${cid.slice(0, 18)}…  (embed ${embedMs.toFixed(1)}ms, commit ${commitMs.toFixed(0)}ms)`,
    );

    results.memories.push({
      agent: a.id,
      address: a.wallet.address,
      cid,
      model: modelKey,
      dim: info.dim,
      encrypted: true,
      embedMs: Number(embedMs.toFixed(2)),
      encryptMs: Number(encryptMs.toFixed(3)),
      commitMs: Number(commitMs.toFixed(1)),
    });

    aligned.push({
      id: a.id,
      vector: Array.from(projection.alignEmbedding({ embedding: raw }).aligned),
    });
  }

  // ── Phase 3: cross-model similarity in the shared space ────────────────
  say('\nPhase 3 — cross-model similarity (deterministic projection)');
  for (let i = 0; i < aligned.length; i += 1) {
    for (let j = i + 1; j < aligned.length; j += 1) {
      const sim = similarity.cosineSimilarity(aligned[i].vector, aligned[j].vector);
      results.similarity.push({
        from: aligned[i].id,
        to: aligned[j].id,
        similarity: Number(sim.toFixed(4)),
      });
    }
  }
  say(`  ${results.similarity.length} pairs computed in the shared 384d space`);

  // ── Phase 4: on-chain reputation between distinct identities ───────────
  say('\nPhase 4 — reputation (real transactions between distinct agents)');
  /** @type {[number, number, 'endorse'|'report', string][]} */
  const interactions = [
    [1, 0, 'endorse', 'context verified independently'],
    [2, 0, 'endorse', 'cross-model retrieval agreed'],
    [3, 0, 'endorse', 'signature and CID checked'],
    [4, 1, 'endorse', 'latency claim reproduced'],
    [0, 3, 'report', 'memory contradicted a verified commit'],
  ];

  for (const [fromIdx, toIdx, action, reason] of interactions) {
    if (fromIdx >= agents.length || toIdx >= agents.length) continue;
    const from = agents[fromIdx];
    const to = agents[toIdx];
    try {
      const t = performance.now();
      const tx =
        action === 'endorse'
          ? await reputation.connect(from.wallet).endorseAgent(to.wallet.address, reason)
          : await reputation.connect(from.wallet).reportAgent(to.wallet.address, reason);
      await tx.wait();
      results.latencies.endorseMs.push(performance.now() - t);
      say(`  ${from.id} ${action === 'endorse' ? '→ endorsed' : '⚠ reported'} ${to.id}`);
      results.reputationEvents.push({ from: from.id, to: to.id, action, reason, onChain: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      say(`  ${from.id} ${action} ${to.id} reverted: ${msg.split('\n')[0].slice(0, 90)}`);
      results.reputationEvents.push({
        from: from.id,
        to: to.id,
        action,
        reason,
        onChain: false,
        error: msg.split('\n')[0],
      });
    }
  }

  say('\n  final on-chain scores');
  for (const a of agents) {
    const score = await reputation.globalReputation(a.wallet.address).catch(() => null);
    const trusted = await reputation.isTrusted(a.wallet.address).catch(() => false);
    const pretty = score === null ? 'n/a' : `${Number(ethers.formatEther(score)).toFixed(4)}`;
    say(`    ${a.id.padEnd(9)} ${pretty.padStart(8)}  ${trusted ? 'TRUSTED' : 'untrusted'}`);
    const rec = results.agents.find((x) => x.id === a.id);
    if (rec) {
      rec.reputation = pretty;
      rec.trusted = trusted;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = Object.fromEntries(
    Object.entries(results.latencies).map(([k, v]) => [k, summarize(v)]),
  );
  say('\nLatency summary (ms)');
  for (const [k, s] of Object.entries(summary)) {
    if (s) say(`  ${k.padEnd(12)} n=${String(s.n).padStart(2)}  p50 ${String(s.p50).padStart(8)}`);
  }

  await embeddings.shutdown();

  const out = path.join(process.cwd(), 'simulation-results.json');
  fs.writeFileSync(out, `${JSON.stringify({ ...results, summary }, null, 2)}\n`);
  say(`\nWritten to ${path.basename(out)}\n`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`\nSimulation failed: ${error instanceof Error ? error.message : String(error)}`);
});
