import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';
import axios from 'axios';
import "dotenv/config.js";
import { encryptMemory, decryptMemory } from './lib/encryption.js';
import { alignEmbedding, cosineSimilarity, semanticSearch } from './lib/semantic-sync.js';

const { pipeline } = await import('@xenova/transformers');
console.log("Loading AI model for embeddings (Xenova/all-MiniLM-L6-v2)...");
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
console.log("AI Model loaded successfully!");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Global state
let agentWallet = null;
let contracts = {};

async function initBlockchain() {
    console.log("Connecting to Sepolia Testnet...");
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    let pk = process.env.PRIVATE_KEY;
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    agentWallet = new ethers.Wallet(pk, provider);

    const addressesPath = join(__dirname, 'contract-addresses.json');
    if (!fs.existsSync(addressesPath)) {
        console.error("contract-addresses.json not found! Run: npx hardhat run scripts/deploy.js --network sepolia");
        return;
    }
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const identityAbi = [
        "function registerAgent(string memory publicKey) external",
        "function getAgentStatus(address agentWallet) external view returns (bool)"
    ];
    const ledgerAbi = [
        "function commitMemory(string memory ipfsCID, string memory previousVersionCID, bytes memory signature, bool isEncrypted, uint256 embeddingDim, string memory embeddingModel) external",
        "function verifyMemory(string memory ipfsCID) external view returns (address, uint256, bool, uint256, string memory)",
        "function totalMemoryCount() external view returns (uint256)"
    ];
    const reputationAbi = [
        "function endorseAgent(address target, string memory reason) external",
        "function reportAgent(address target, string memory reason) external",
        "function globalReputation(address agent) external view returns (uint256)",
        "function isTrusted(address agent) external view returns (bool)"
    ];

    contracts.identity = new ethers.Contract(addresses.AgentIdentity, identityAbi, agentWallet);
    contracts.ledger = new ethers.Contract(addresses.MemoryLedger, ledgerAbi, agentWallet);
    contracts.reputation = new ethers.Contract(addresses.ReputationManager, reputationAbi, agentWallet);

    console.log("Connected! Agent address:", agentWallet.address);
}

// Upload JSON to Pinata
async function uploadToPinata(jsonData) {
    const res = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", jsonData, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.PINATA_JWT}`
        }
    });
    return res.data.IpfsHash;
}

app.get('/api/status', async (req, res) => {
    if (!contracts.identity) return res.json({ agentAddress: 'Loading...', isRegistered: false });
    try {
        const isRegistered = await contracts.identity.getAgentStatus(agentWallet.address);
        res.json({ agentAddress: agentWallet.address, isRegistered });
    } catch (e) {
        res.json({ agentAddress: agentWallet.address, isRegistered: false });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        console.log("Sending registration tx to Sepolia...");
        const tx = await contracts.identity.registerAgent("pubKey_sepolia");
        await tx.wait();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/memory', async (req, res) => {
    const { context } = req.body;

    console.log("Generating Vector Embeddings locally...");
    const output = await extractor(context, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    // Encrypt the context using AES-256-GCM
    let pk = process.env.PRIVATE_KEY;
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    console.log("Encrypting context with AES-256-GCM...");
    const encryptedContext = encryptMemory(context, pk);

    const payload = {
        agent_did: agentWallet.address,
        encrypted_context: encryptedContext,
        vector_embedding: embedding,
        embedding_model: 'Xenova/all-MiniLM-L6-v2',
        embedding_dim: 384,
        is_encrypted: true,
        timestamp: new Date().toISOString()
    };

    console.log("Uploading encrypted payload to Pinata IPFS...");
    const cid = await uploadToPinata({
        pinataContent: payload,
        pinataMetadata: { name: `Neuromesh-Memory-${Date.now()}.json` }
    });
    console.log("Pinned to IPFS. CID:", cid);

    console.log("Committing Proof of Memory to Sepolia blockchain...");
    const tx = await contracts.ledger.commitMemory(
        cid, "", ethers.encodeBytes32String("sig"),
        true,  // isEncrypted
        384,   // embeddingDim
        "all-MiniLM-L6-v2" // embeddingModel
    );
    await tx.wait();
    console.log("Committed successfully!");

    res.json({ success: true, cid, embeddingLength: embedding.length, encrypted: true });
});

app.get('/api/memories', async (req, res) => {
    try {
        const pinataRes = await axios.get("https://api.pinata.cloud/data/pinList?status=pinned", {
            headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }
        });

        const memories = [];
        for (const item of pinataRes.data.rows) {
            memories.push({
                cid: item.ipfs_pin_hash,
                timestamp: item.date_pinned
            });
        }
        res.json(memories);
    } catch (e) {
        console.error("Failed to list memories from Pinata:", e.message);
        res.json([]);
    }
});

app.get('/api/simulation-results', (req, res) => {
    try {
        const resultsPath = join(__dirname, 'simulation-results.json');
        if (fs.existsSync(resultsPath)) {
            const data = fs.readFileSync(resultsPath, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.status(404).json({ error: "Simulation results not found. Run simulation first." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Decrypt a memory (for authorized agents)
app.post('/api/decrypt', async (req, res) => {
    const { encryptedData } = req.body;
    try {
        let pk = process.env.PRIVATE_KEY;
        if (!pk.startsWith("0x")) pk = "0x" + pk;
        const decrypted = decryptMemory(encryptedData, pk);
        res.json({ success: true, context: decrypted });
    } catch (e) {
        res.status(403).json({ success: false, error: "Decryption failed. Unauthorized." });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`NeuroMesh Node running on http://0.0.0.0:${PORT}`);
    await initBlockchain().catch(e => console.error("Blockchain init failed:", e));
});
