let agentAddress = '';

async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        if (data.error || data.agentAddress === 'Loading...') {
            setTimeout(fetchStatus, 2000);
            return;
        }

        agentAddress = data.agentAddress;
        document.getElementById('agent-address').innerText = agentAddress;
        
        if (data.isRegistered) {
            const btn = document.getElementById('register-btn');
            btn.innerText = "Agent Registered on Sepolia ✅";
            btn.disabled = true;
        }
        
        loadMemories();
    } catch (e) {
        console.error("Backend not ready yet...", e);
        setTimeout(fetchStatus, 3000);
    }
}

document.getElementById('register-btn').addEventListener('click', async () => {
    const btn = document.getElementById('register-btn');
    btn.innerText = "Sending Transaction to Sepolia...";
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/register', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            btn.innerText = "Agent Registered on Sepolia ✅";
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        console.error(e);
        btn.innerText = "Registration Failed. Did you supply testnet ETH?";
        btn.disabled = false;
    }
});

document.getElementById('commit-btn').addEventListener('click', async () => {
    const text = document.getElementById('memory-input').value;
    if (!text) return;
    
    const loader = document.getElementById('loader');
    const textEl = document.getElementById('loader-text');
    const btn = document.getElementById('commit-btn');
    
    btn.disabled = true;
    loader.classList.remove('hidden');
    
    textEl.innerText = "Pipeline: Generating Embeddings ➔ Pinata IPFS ➔ Sepolia Tx";
    
    try {
        const res = await fetch('/api/memory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: text })
        });
        const data = await res.json();
        
        if(data.success) {
            document.getElementById('memory-input').value = '';
            await loadMemories();
        }
    } catch (e) {
        alert("Error committing memory to the real network.");
    }
    
    loader.classList.add('hidden');
    btn.disabled = false;
});

async function loadMemories() {
    try {
        const res = await fetch('/api/memories');
        const memories = await res.json();
        
        const list = document.getElementById('memory-list');
        list.innerHTML = '';
        
        if (memories.length === 0) {
            list.innerHTML = '<p style="color: #64748b; text-align: center;">No memories pinned on your Pinata account yet.</p>';
            return;
        }

        memories.forEach(async m => {
            const card = document.createElement('div');
            card.className = 'memory-card';
            const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${m.cid}`;
            
            card.innerHTML = `
                <div class="mem-cid">📌 IPFS CID: <a href="${gatewayUrl}" target="_blank" style="color: var(--secondary);">${m.cid}</a></div>
                <div class="mem-content" id="content-${m.cid}">Loading from decentralized IPFS node...</div>
                <div class="mem-meta">
                    🕒 Pinned on ${new Date(m.timestamp).toLocaleString()}
                </div>
            `;
            list.appendChild(card);
            
            try {
                const ipfsRes = await fetch(gatewayUrl);
                const ipfsData = await ipfsRes.json();
                document.getElementById(`content-${m.cid}`).innerText = `"${ipfsData.raw_context}"`;
            } catch (err) {
                document.getElementById(`content-${m.cid}`).innerText = "View Raw JSON on IPFS (Gateway may take a moment to sync)";
            }
        });
    } catch (e) {
        console.error("Failed to load memories", e);
    }
}

fetchStatus();

// --- Tab Switching Logic ---
function switchTab(tabId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(tabId).classList.remove('hidden');
    document.querySelector(`button[onclick="switchTab('${tabId}')"]`).classList.add('active');

    if (tabId === 'network-view') {
        loadSimulationResults();
    }
}

// --- Fetch and Render Simulation Results ---
async function loadSimulationResults() {
    try {
        const res = await fetch('/api/simulation-results');
        const data = await res.json();
        
        if (data.error) {
            console.warn(data.error);
            return;
        }

        // 1. Render Agents
        const agentsGrid = document.getElementById('agents-grid');
        agentsGrid.innerHTML = '';
        data.agents.forEach(agent => {
            agentsGrid.innerHTML += `
                <div class="agent-card">
                    <h3>🤖 ${agent.id}</h3>
                    <p>Model: ${agent.model}</p>
                    <p>Dimensions: <span class="dim">${agent.dim}d</span></p>
                    <p style="font-size: 0.75rem; word-break: break-all;">Wallet: ${agent.wallet}</p>
                </div>
            `;
        });

        // 2. Render Benchmarks
        const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : "N/A";
        document.getElementById('stat-emb').innerText = avg(data.benchmarks.embeddingLatencies) + " ms";
        document.getElementById('stat-enc').innerText = avg(data.benchmarks.encryptionLatencies) + " ms";
        document.getElementById('stat-ipfs').innerText = avg(data.benchmarks.ipfsLatencies) + " ms";
        document.getElementById('stat-bc').innerText = avg(data.benchmarks.blockchainLatencies) + " ms";

        // 3. Render Semantic Similarity Matrix (Table)
        const simTbody = document.getElementById('similarity-tbody');
        simTbody.innerHTML = '';
        data.crossModelSimilarity.forEach(sim => {
            // Highlight high similarity
            const color = sim.similarity > 0.05 ? 'var(--primary)' : 'var(--text)';
            simTbody.innerHTML += `
                <tr style="color: ${color}">
                    <td>${sim.from}</td>
                    <td>${sim.to}</td>
                    <td>${sim.fromModel}</td>
                    <td>${sim.toModel}</td>
                    <td><strong>${sim.similarity.toFixed(4)}</strong></td>
                </tr>
            `;
        });

        // 4. Render Reputation Events and Scores
        const eventsList = document.getElementById('rep-events-list');
        eventsList.innerHTML = '';
        const repScores = {};
        data.agents.forEach(a => repScores[a.id] = { endorsers: 0, negatives: 0 });

        data.reputationEvents.forEach(ev => {
            const isEndorse = ev.action === 'endorse';
            eventsList.innerHTML += `
                <li class="${isEndorse ? 'rep-endorse' : 'rep-report'}">
                    <strong>${ev.from}</strong> ${isEndorse ? '👍 endorsed' : '🚫 reported'} <strong>${ev.to}</strong>: 
                    <em>"${ev.reason}"</em>
                </li>
            `;
            if (isEndorse) repScores[ev.to].endorsers++;
            else repScores[ev.to].negatives++;
        });

        const scoresList = document.getElementById('rep-scores-list');
        scoresList.innerHTML = '';
        for (const [agentId, scores] of Object.entries(repScores)) {
            const bayesianScore = (scores.endorsers * 1000) / (1 + 3 * scores.negatives);
            const isTrusted = bayesianScore >= 500;
            scoresList.innerHTML += `
                <li>
                    <strong>${agentId}</strong> (Score: ${bayesianScore.toFixed(0)})
                    <span class="${isTrusted ? 'rep-score-trust' : 'rep-score-warn'}">
                        ${isTrusted ? '✅ TRUSTED' : '⚠️ UNTRUSTED'}
                    </span>
                </li>
            `;
        }

    } catch (e) {
        console.error("Failed to load simulation results:", e);
    }
}
