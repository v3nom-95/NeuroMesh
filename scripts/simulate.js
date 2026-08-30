/**
 * NOTE (v2.0.0): this script still targets the pre-rewrite contract ABI and the single-wallet
 * model. It is retained for reference and is scheduled for rewrite in v2.1 (see
 * docs/V2.1-HARDENING-PLAN.md). Use `npm run benchmark` for current measurements.
 */
/**
 * NeuroMesh Multi-Agent Swarm Simulation & Benchmarking
 * =====================================================
 *
 * This script simulates a network of 5 autonomous AI agents that:
 *   1. Register decentralized identities on the blockchain
 *   2. Generate vector embeddings using two DIFFERENT AI models
 *   3. Encrypt their memories using AES-256-GCM
 *   4. Upload encrypted payloads to Pinata IPFS
 *   5. Commit cryptographic proofs to the Sepolia blockchain
 *   6. Cross-model semantic synchronization via random projection
 *   7. Build Bayesian reputation through endorsements and reports
 *
 * Outputs:
 *   - Performance benchmarks (latency, gas, throughput)
 *   - Cosine similarity matrix across heterogeneous models
 *   - Reputation evolution data
 *   - All results saved to simulation-results.json for paper charts
 */

import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import 'dotenv/config.js';
import { pipeline } from '@huggingface/transformers';
import { encryptMemory, decryptMemory } from '../lib/encryption.js';
import {
  alignEmbedding,
  cosineSimilarity,
  semanticSearch,
  generateProjectionMatrix,
} from '../lib/semantic-sync.js';

// ─── Configuration ──────────────────────────────────────────
const NUM_AGENTS = 5;
const SHARED_DIM = 384; // Shared semantic space dimensionality

// Contexts each agent will contribute
const AGENT_CONTEXTS = [
  'The user prefers dark mode in all UI elements and uses keyboard shortcuts extensively.',
  'Server response latency should be kept below 200ms for optimal user experience.',
  'The database schema uses normalized tables with foreign key constraints for data integrity.',
  'Machine learning models should be retrained weekly using the latest production data.',
  'Security protocols require AES-256 encryption for all data at rest and TLS 1.3 in transit.',
];

// Simulated model assignments: agents 0-2 use MiniLM (384d), agents 3-4 use distilroberta (768d)
const AGENT_MODELS = [
  { name: 'all-MiniLM-L6-v2', dim: 384 },
  { name: 'all-MiniLM-L6-v2', dim: 384 },
  { name: 'all-MiniLM-L6-v2', dim: 384 },
  { name: 'all-distilroberta-v1', dim: 768 },
  { name: 'all-distilroberta-v1', dim: 768 },
];

// ─── Results Container ──────────────────────────────────────
const results = {
  agents: [],
  memoryCommits: [],
  reputationEvents: [],
  crossModelSimilarity: [],
  benchmarks: {
    embeddingLatencies: [],
    encryptionLatencies: [],
    ipfsLatencies: [],
    blockchainLatencies: [],
    totalLatencies: [],
  },
};

// ─── Helpers ────────────────────────────────────────────────
async function uploadToPinata(jsonData) {
  const res = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', jsonData, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
    },
  });
  return res.data.IpfsHash;
}

// ─── Main Simulation ────────────────────────────────────────
async function runSimulation() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    NeuroMesh Multi-Agent Swarm Simulation v2.0          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('  Loading real AI Models for Swarm Simulation...');
  const extractor384 = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const extractor768 = await pipeline('feature-extraction', 'Xenova/all-distilroberta-v1');
  console.log('  ✅ Real AI Models loaded.\n');

  // Connect to blockchain
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  let pk = process.env.PRIVATE_KEY;
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  const wallet = new ethers.Wallet(pk, provider);

  const addresses = JSON.parse(fs.readFileSync('contract-addresses.json', 'utf8'));

  const identityAbi = [
    'function registerAgent(string memory publicKey) external',
    'function getAgentStatus(address agentWallet) external view returns (bool)',
  ];
  const ledgerAbi = [
    'function commitMemory(string memory ipfsCID, string memory previousVersionCID, bytes memory signature, bool isEncrypted, uint256 embeddingDim, string memory embeddingModel) external',
    'function verifyMemory(string memory ipfsCID) external view returns (address, uint256, bool, uint256, string memory)',
    'function totalMemoryCount() external view returns (uint256)',
  ];
  const reputationAbi = [
    'function endorseAgent(address target, string memory reason) external',
    'function reportAgent(address target, string memory reason) external',
    'function globalReputation(address agent) external view returns (uint256)',
    'function isTrusted(address agent) external view returns (bool)',
    'function getTrustLogLength() external view returns (uint256)',
  ];

  const identity = new ethers.Contract(addresses.AgentIdentity, identityAbi, wallet);
  const ledger = new ethers.Contract(addresses.MemoryLedger, ledgerAbi, wallet);
  const _reputation = new ethers.Contract(addresses.ReputationManager, reputationAbi, wallet);

  const agentAddress = wallet.address;

  // ─── Phase 1: Agent Registration ────────────────────────
  console.log('━━━ Phase 1: Decentralized Identity Registration ━━━');
  const isRegistered = await identity.getAgentStatus(agentAddress);
  if (!isRegistered) {
    console.log(`  Registering agent ${agentAddress.slice(0, 10)}... on Sepolia...`);
    const tx = await identity.registerAgent('pubKey_simulation');
    await tx.wait();
    console.log('  ✅ Agent registered on blockchain\n');
  } else {
    console.log(`  ✅ Agent ${agentAddress.slice(0, 10)}... already registered\n`);
  }

  // For simulation purposes, all 5 "virtual agents" share the same wallet
  // but operate with different contexts and models
  for (let i = 0; i < NUM_AGENTS; i++) {
    results.agents.push({
      id: `Agent-${i}`,
      model: AGENT_MODELS[i].name,
      dim: AGENT_MODELS[i].dim,
      wallet: agentAddress,
    });
  }

  // ─── Phase 2: Memory Generation, Encryption, IPFS, Blockchain ──
  console.log('━━━ Phase 2: Encrypted Memory Synchronization Pipeline ━━━');

  const allEmbeddings = []; // Store for cross-model comparison

  for (let i = 0; i < NUM_AGENTS; i++) {
    const agent = results.agents[i];
    const context = AGENT_CONTEXTS[i];
    const model = AGENT_MODELS[i];

    console.log(`\n  🤖 ${agent.id} (${model.name}, ${model.dim}d):`);
    console.log(`     Context: "${context.slice(0, 60)}..."`);

    const totalStart = Date.now();

    // Step 1: Generate embedding
    const embStart = Date.now();
    let output;
    if (model.dim === 384) {
      output = await extractor384(context, { pooling: 'mean', normalize: true });
    } else {
      output = await extractor768(context, { pooling: 'mean', normalize: true });
    }
    const embedding = Array.from(output.data);
    const embLatency = Date.now() - embStart;
    results.benchmarks.embeddingLatencies.push(embLatency);
    console.log(`     ⚡ Embedding generated: ${model.dim} dims (${embLatency}ms)`);

    allEmbeddings.push({ agentId: agent.id, embedding, dim: model.dim });

    // Step 2: Encrypt the context
    const encStart = Date.now();
    const encrypted = encryptMemory(context, pk);
    const encLatency = Date.now() - encStart;
    results.benchmarks.encryptionLatencies.push(encLatency);
    console.log(`     🔒 AES-256-GCM encrypted (${encLatency}ms)`);

    // Verify decryption works
    const decrypted = decryptMemory(encrypted, pk);
    if (decrypted !== context) throw new Error('Decryption verification failed!');

    // Step 3: Upload to IPFS
    const ipfsStart = Date.now();
    const payload = {
      agent_did: agentAddress,
      agent_id: agent.id,
      encrypted_context: encrypted,
      vector_embedding: embedding.slice(0, 10), // Only store first 10 dims to save space
      embedding_dim: model.dim,
      embedding_model: model.name,
      is_encrypted: true,
      timestamp: new Date().toISOString(),
    };

    let cid;
    try {
      cid = await uploadToPinata({
        pinataContent: payload,
        pinataMetadata: { name: `NeuroMesh-Sim-${agent.id}-${Date.now()}.json` },
      });
      // Sleep 1.5 seconds to avoid Pinata rate limits
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (e) {
      console.log(`     ⚠️  IPFS upload failed: ${e.message}`);
      throw e; // Fail hard to ensure no dummy data is used
    }
    const ipfsLatency = Date.now() - ipfsStart;
    results.benchmarks.ipfsLatencies.push(ipfsLatency);
    console.log(`     📌 Pinned to IPFS: ${cid.slice(0, 20)}... (${ipfsLatency}ms)`);

    // Step 4: Commit proof to blockchain
    const bcStart = Date.now();
    try {
      const tx = await ledger.commitMemory(
        cid,
        '',
        ethers.encodeBytes32String('sig'),
        true,
        model.dim,
        model.name,
      );
      await tx.wait();
      const bcLatency = Date.now() - bcStart;
      results.benchmarks.blockchainLatencies.push(bcLatency);
      console.log(`     ⛓️  Proof committed to Sepolia (${bcLatency}ms)`);
    } catch (e) {
      const bcLatency = Date.now() - bcStart;
      results.benchmarks.blockchainLatencies.push(bcLatency);
      console.log(`     ⛓️  Blockchain commit: ${e.message?.slice(0, 50)}... (${bcLatency}ms)`);
    }

    const totalLatency = Date.now() - totalStart;
    results.benchmarks.totalLatencies.push(totalLatency);

    results.memoryCommits.push({
      agent: agent.id,
      cid,
      model: model.name,
      dim: model.dim,
      encrypted: true,
      embeddingLatency: embLatency,
      encryptionLatency: encLatency,
      ipfsLatency,
      totalLatency,
    });
  }

  // ─── Phase 3: Cross-Model Semantic Synchronization ──────
  console.log('\n━━━ Phase 3: Cross-Model Semantic Synchronization ━━━');
  console.log(`  Aligning all embeddings to shared ${SHARED_DIM}d space...\n`);

  const projMatrix768to384 = generateProjectionMatrix(768, SHARED_DIM);
  const alignedEmbeddings = [];

  for (const emb of allEmbeddings) {
    const { aligned } = alignEmbedding(
      emb.embedding,
      emb.dim,
      SHARED_DIM,
      emb.dim > SHARED_DIM ? projMatrix768to384 : null,
    );
    alignedEmbeddings.push({ agentId: emb.agentId, embedding: aligned });
  }

  // Compute pairwise cosine similarity matrix
  console.log('  Pairwise Cosine Similarity Matrix (cross-model):');
  console.log('  ' + '─'.repeat(55));
  const header = '          ' + results.agents.map((a) => a.id.padEnd(10)).join('');
  console.log('  ' + header);

  for (let i = 0; i < alignedEmbeddings.length; i++) {
    let row = `  ${results.agents[i].id.padEnd(10)}`;
    for (let j = 0; j < alignedEmbeddings.length; j++) {
      const sim = cosineSimilarity(alignedEmbeddings[i].embedding, alignedEmbeddings[j].embedding);
      row += sim.toFixed(4).padEnd(10);
      if (i !== j) {
        results.crossModelSimilarity.push({
          from: results.agents[i].id,
          to: results.agents[j].id,
          fromModel: AGENT_MODELS[i].name,
          toModel: AGENT_MODELS[j].name,
          similarity: parseFloat(sim.toFixed(4)),
        });
      }
    }
    console.log(row);
  }

  // Demonstrate semantic search
  console.log('\n  🔍 Semantic Search: Agent-3 (768d) querying Agent-0,1,2 (384d) memories...');
  const queryEmb = alignedEmbeddings[3].embedding;
  const memoryBank = alignedEmbeddings
    .filter((_, idx) => idx < 3)
    .map((e) => ({ cid: e.agentId, embedding: e.embedding }));
  const searchResults = semanticSearch(queryEmb, memoryBank, 3);
  searchResults.forEach((r, idx) => {
    console.log(`     ${idx + 1}. ${r.cid} — similarity: ${r.similarity.toFixed(4)}`);
  });

  // ─── Phase 4: Bayesian Reputation Building ──────────────
  console.log('\n━━━ Phase 4: Bayesian Reputation System ━━━');

  // Simulate endorsements (agents endorse each other for good memories)
  // Since we only have one wallet, we'll log what WOULD happen
  console.log('  Simulating trust interactions (logged off-chain for single-wallet demo):\n');

  const reputationScenarios = [
    { from: 'Agent-1', to: 'Agent-0', action: 'endorse', reason: 'Accurate UI preferences' },
    { from: 'Agent-2', to: 'Agent-0', action: 'endorse', reason: 'Verified context consistency' },
    {
      from: 'Agent-3',
      to: 'Agent-0',
      action: 'endorse',
      reason: 'Cross-model verification passed',
    },
    { from: 'Agent-4', to: 'Agent-1', action: 'endorse', reason: 'Server latency data confirmed' },
    {
      from: 'Agent-0',
      to: 'Agent-3',
      action: 'report',
      reason: 'Memory poisoning attempt detected',
    },
    { from: 'Agent-1', to: 'Agent-4', action: 'endorse', reason: 'Security protocols validated' },
  ];

  for (const scenario of reputationScenarios) {
    const emoji = scenario.action === 'endorse' ? '👍' : '🚫';
    console.log(
      `  ${emoji} ${scenario.from} → ${scenario.action.toUpperCase()} → ${scenario.to}: "${scenario.reason}"`,
    );

    // Compute simulated Bayesian score
    results.reputationEvents.push(scenario);
  }

  // Compute simulated reputation scores
  const repScores = {};
  for (const agent of results.agents) repScores[agent.id] = { endorsers: 0, negatives: 0 };
  for (const event of reputationScenarios) {
    if (event.action === 'endorse') repScores[event.to].endorsers += 1;
    else repScores[event.to].negatives += 1;
  }

  console.log('\n  Final Bayesian Reputation Scores:');
  console.log('  ' + '─'.repeat(50));
  for (const [agentId, data] of Object.entries(repScores)) {
    const score = (data.endorsers * 1000) / (1 + 3 * data.negatives);
    const trusted = score >= 500 ? '✅ TRUSTED' : '⚠️  UNTRUSTED';
    console.log(
      `  ${agentId}: Score=${score.toFixed(0)} (${data.endorsers} endorsements, ${data.negatives} reports) → ${trusted}`,
    );
  }

  // ─── Phase 5: Summary & Save ────────────────────────────
  console.log('\n━━━ Phase 5: Benchmark Summary ━━━');
  const avg = (arr) =>
    arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'N/A';
  console.log(`  Average Embedding Generation:  ${avg(results.benchmarks.embeddingLatencies)}ms`);
  console.log(`  Average AES-256 Encryption:    ${avg(results.benchmarks.encryptionLatencies)}ms`);
  console.log(`  Average IPFS Upload:           ${avg(results.benchmarks.ipfsLatencies)}ms`);
  console.log(`  Average Blockchain Commit:     ${avg(results.benchmarks.blockchainLatencies)}ms`);
  console.log(`  Average End-to-End Latency:    ${avg(results.benchmarks.totalLatencies)}ms`);

  // Save all results
  fs.writeFileSync('simulation-results.json', JSON.stringify(results, null, 2));
  console.log('\n  📊 Full results saved to simulation-results.json');
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    Simulation Complete! Use results for paper charts.   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

runSimulation().catch(console.error);
