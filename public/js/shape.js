/**
 * Response shaping.
 *
 * The backend's route list is frozen (see `ENDPOINTS` in api.js) but its
 * payload FIELD NAMES are not: the API is being rewritten in parallel with
 * this console. Every view therefore reads server data through exactly one
 * module — this one — so that a rename on the server is a change here and
 * nowhere else.
 *
 * Two rules govern everything below.
 *
 * 1. Never invent a value. A field the node did not send reads as `null`, and
 *    the view renders an em dash. The predecessor of this console read
 *    `ipfsData.raw_context` — a key the server has never written — and every
 *    memory card in the app silently displayed the string "undefined" as if it
 *    were the memory's content. A missing field must LOOK missing.
 * 2. Never throw. A normalizer runs on hostile input (a half-written
 *    `simulation-results.json`, a proxy's HTML error page that slipped past
 *    the content-type check, a field that changed type between two node
 *    versions). Anything unreadable degrades to `null` or an empty array.
 *
 * Nothing here touches the DOM, so it is all pure and directly testable.
 *
 * @module shape
 */

/* ==================================================================== *
 * Primitive readers
 * ==================================================================== */

/**
 * Read a dotted path without throwing on a missing or non-object link.
 *
 * @param {unknown} source
 * @param {string} path e.g. `'chain.contracts.registry'`
 * @returns {unknown} `undefined` when any link is absent
 */
export function pathValue(source, path) {
  let cursor = source;
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = /** @type {Record<string, unknown>} */ (cursor)[key];
  }
  return cursor;
}

/**
 * First path that yields something other than `null`/`undefined`.
 *
 * This is how the console survives an unfrozen API: it accepts every spelling
 * the backend might plausibly use, rather than guessing one and rendering a
 * blank panel when the guess is wrong.
 *
 * @param {unknown} source
 * @param {readonly string[]} paths
 * @returns {unknown}
 */
export function firstOf(source, paths) {
  for (const path of paths) {
    const value = pathValue(source, path);
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {string | null} a non-empty trimmed string, or null
 */
export function asString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/**
 * Accepts a numeric string too: JSON from a chain-adjacent service routinely
 * carries block numbers and balances as strings to dodge float precision.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Tri-state on purpose: `null` means "the node did not say", which is a
 * different thing from `false` and must render differently.
 *
 * @param {unknown} value
 * @returns {boolean | null}
 */
export function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'yes' || lowered === 'ok' || lowered === '1') return true;
    if (lowered === 'false' || lowered === 'no' || lowered === '0') return false;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** Ethereum address, checked before it is ever put in an explorer URL. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

/**
 * A `did:pkh` DID carries the address in its last segment. Returning it lets
 * the identity card link a DID to the explorer without a second field.
 *
 * @param {string | null} did
 * @returns {string | null}
 */
export function addressFromDid(did) {
  if (typeof did !== 'string') return null;
  const tail = did.split(':').pop();
  return isAddress(tail) ? /** @type {string} */ (tail) : null;
}

/* ==================================================================== *
 * Status
 * ==================================================================== */

/**
 * @typedef {object} NodeStatus
 * @property {unknown} raw the untouched payload, for the System view's JSON pane
 * @property {{ name: string|null, version: string|null, commit: string|null, uptimeSec: number|null }} node
 * @property {{ address: string|null, did: string|null, registered: boolean|null,
 *   score: number|null, trusted: boolean|null, endorsements: number|null,
 *   reports: number|null, scoreMax: number|null, trustThreshold: number|null }} agent
 * @property {{ configured: boolean, network: string|null, chainId: number|null,
 *   blockNumber: number|null, explorerBase: string|null, balance: string|null,
 *   contracts: Array<{ name: string, address: string }> }} chain
 * @property {{ ready: boolean|null, name: string|null, dimensions: number|null,
 *   progress: number|null }} model
 * @property {{ configured: boolean|null, gateway: string|null }} ipfs
 * @property {boolean} readOnly
 * @property {{ memories: number|null, agents: number|null }} counts
 */

/** Used only when the node reports a chain but names no explorer. */
const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';

/**
 * Well-known explorer bases, keyed by chain id. A base is NEVER guessed for an
 * unknown chain: a wrong explorer link is worse than no link, because it looks
 * authoritative and resolves to a different network's address.
 */
const EXPLORERS = new Map([
  [1, 'https://etherscan.io'],
  [11155111, SEPOLIA_EXPLORER],
]);

/**
 * Normalize `GET /api/status`.
 *
 * @param {unknown} raw
 * @returns {NodeStatus}
 */
export function normalizeStatus(raw) {
  const chainId = asNumber(
    firstOf(raw, ['chain.chainId', 'chain.id', 'chainId', 'network.chainId']),
  );
  const explorerBase =
    asString(firstOf(raw, ['chain.explorerUrl', 'chain.explorer', 'explorerUrl'])) ??
    (chainId === null ? null : (EXPLORERS.get(chainId) ?? null));

  // `node.*` is accepted alongside `agent.*` because the status route is
  // specified as "node identity + chain + readiness" and the backend is not
  // frozen. Reading `node.address` but not `node.registered` would resolve the
  // address while leaving registration permanently unknown — which hides the
  // Register action and makes the node unregisterable from this console.
  const registered = asBool(
    firstOf(raw, [
      'agent.registered',
      'registered',
      'agent.isRegistered',
      'identity.registered',
      'node.registered',
      'node.isRegistered',
    ]),
  );

  const did = asString(firstOf(raw, ['agent.did', 'did', 'identity.did', 'node.did']));
  const address =
    asString(
      firstOf(raw, [
        'agent.address',
        'address',
        'identity.address',
        'agent.wallet',
        'node.address',
      ]),
    ) ?? addressFromDid(did);

  return {
    raw,
    node: {
      name: asString(firstOf(raw, ['node.name', 'name', 'service'])),
      version: asString(firstOf(raw, ['node.version', 'version', 'build.version'])),
      commit: asString(firstOf(raw, ['node.commit', 'commit', 'build.commit', 'gitSha'])),
      uptimeSec: asNumber(firstOf(raw, ['node.uptimeSec', 'uptimeSec', 'uptime', 'uptimeSeconds'])),
    },
    agent: {
      address,
      did,
      registered,
      score: asNumber(
        firstOf(raw, ['agent.reputation.score', 'agent.score', 'reputation.score', 'score']),
      ),
      trusted: asBool(
        firstOf(raw, ['agent.reputation.trusted', 'agent.trusted', 'reputation.trusted']),
      ),
      endorsements: asNumber(
        firstOf(raw, [
          'agent.reputation.endorsements',
          'agent.endorsements',
          'reputation.endorsements',
          'agent.reputation.endorsers',
        ]),
      ),
      reports: asNumber(
        firstOf(raw, [
          'agent.reputation.reports',
          'agent.reports',
          'reputation.reports',
          'agent.reputation.negatives',
        ]),
      ),
      scoreMax: asNumber(
        firstOf(raw, ['agent.reputation.max', 'reputation.max', 'reputation.scoreMax']),
      ),
      trustThreshold: asNumber(
        firstOf(raw, [
          'agent.reputation.trustThreshold',
          'reputation.trustThreshold',
          'reputation.threshold',
        ]),
      ),
    },
    chain: {
      configured: asBool(firstOf(raw, ['chain.configured', 'chainConfigured'])) ?? chainId !== null,
      network: asString(firstOf(raw, ['chain.network', 'network.name', 'network', 'chain.name'])),
      chainId,
      blockNumber: asNumber(
        firstOf(raw, ['chain.blockNumber', 'chain.block', 'blockNumber', 'chain.latestBlock']),
      ),
      explorerBase,
      balance: asString(firstOf(raw, ['chain.balance', 'balance', 'chain.signerBalance'])),
      contracts: normalizeContracts(firstOf(raw, ['chain.contracts', 'contracts', 'addresses'])),
    },
    model: {
      ready: asBool(firstOf(raw, ['model.ready', 'model.loaded', 'embedding.ready', 'modelReady'])),
      name: asString(
        firstOf(raw, ['model.name', 'model.id', 'model', 'embedding.model', 'embeddingModel']),
      ),
      dimensions: asNumber(
        firstOf(raw, ['model.dimensions', 'model.dim', 'embedding.dim', 'embeddingDim']),
      ),
      progress: asNumber(firstOf(raw, ['model.progress', 'embedding.progress'])),
    },
    ipfs: {
      configured: asBool(firstOf(raw, ['ipfs.configured', 'ipfsConfigured', 'pinning.configured'])),
      gateway: asString(firstOf(raw, ['ipfs.gateway', 'ipfsGateway', 'pinning.gateway'])),
    },
    readOnly: asBool(firstOf(raw, ['readOnly', 'readonly', 'node.readOnly'])) === true,
    counts: {
      memories: asNumber(
        firstOf(raw, ['counts.memories', 'memoryCount', 'stats.memories', 'memories.total']),
      ),
      agents: asNumber(firstOf(raw, ['counts.agents', 'agentCount', 'stats.agents'])),
    },
  };
}

/**
 * Contracts arrive either as `{ AgentRegistry: '0x…' }` or as
 * `[{ name, address }]`. Anything that is not a well-formed address is
 * dropped rather than rendered as a dead explorer link.
 *
 * @param {unknown} value
 * @returns {Array<{ name: string, address: string }>}
 */
export function normalizeContracts(value) {
  /** @type {Array<{ name: string, address: string }>} */
  const out = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const address = asString(firstOf(entry, ['address', 'value']));
      if (!isAddress(address)) continue;
      out.push({
        name: asString(firstOf(entry, ['name', 'label', 'contract'])) ?? 'Contract',
        address: /** @type {string} */ (address),
      });
    }
    return out;
  }
  for (const [name, entry] of Object.entries(asRecord(value))) {
    const address = typeof entry === 'string' ? entry : asString(firstOf(entry, ['address']));
    if (!isAddress(address)) continue;
    out.push({ name, address: /** @type {string} */ (address) });
  }
  return out;
}

/**
 * The status payload doubles as a capability report. Views ask this rather
 * than re-deriving "can I write?" from three fields each.
 *
 * @param {NodeStatus | null} status
 * @returns {{ chain: boolean, model: boolean, ipfs: boolean, write: boolean }}
 */
export function capabilities(status) {
  if (!status) return { chain: false, model: false, ipfs: false, write: false };
  const chain = status.chain.configured === true;
  return {
    chain,
    // `null` means the node did not report readiness. Treating that as "not
    // ready" would disable the composer on a node that simply has a terser
    // status payload, so an unreported capability is assumed present and the
    // request is allowed to fail loudly instead.
    model: status.model.ready !== false,
    ipfs: status.ipfs.configured !== false,
    write: chain && !status.readOnly,
  };
}

/* ==================================================================== *
 * Memories
 * ==================================================================== */

/**
 * @typedef {object} MemoryRecord
 * @property {string|null} cid
 * @property {string|null} agent
 * @property {string|null} model
 * @property {number|null} dims
 * @property {boolean|null} encrypted
 * @property {number|null} createdAt epoch ms
 * @property {string|null} txHash
 * @property {number|null} blockNumber
 * @property {number|null} size bytes
 * @property {string|null} preview plaintext the SERVER chose to expose; never inferred
 * @property {unknown} raw
 */

/**
 * Solidity timestamps are seconds. Anything below 1e11 cannot be a plausible
 * millisecond epoch for this decade, so it is scaled.
 *
 * @param {unknown} value
 * @returns {number | null} epoch milliseconds
 */
export function asEpochMs(value) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = asNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

/**
 * Normalize one memory.
 *
 * `preview` is populated ONLY from a field whose name states that the server
 * deliberately exposed readable text. `raw_context` is not one of those names
 * and is not read here — the audit's third critical finding was that the old
 * dashboard read exactly that key, which nothing has ever written.
 *
 * @param {unknown} raw
 * @returns {MemoryRecord}
 */
export function normalizeMemory(raw) {
  const encrypted = asBool(firstOf(raw, ['encrypted', 'isEncrypted', 'is_encrypted']));
  const preview = asString(firstOf(raw, ['preview', 'contextPreview', 'snippet', 'summary']));
  // A `context` field is only readable text when the record says it is not
  // encrypted. On an encrypted record that key holds ciphertext.
  const plaintext = encrypted === false ? asString(firstOf(raw, ['context'])) : null;

  return {
    cid: asString(firstOf(raw, ['cid', 'CID', 'contentId', 'ipfsHash', 'IpfsHash'])),
    agent: asString(firstOf(raw, ['agent', 'owner', 'agentAddress', 'agent_did', 'did', 'from'])),
    model: asString(firstOf(raw, ['model', 'embeddingModel', 'embedding_model', 'modelId'])),
    dims: asNumber(firstOf(raw, ['dims', 'dim', 'dimensions', 'embeddingDim', 'embedding_dim'])),
    encrypted,
    createdAt: asEpochMs(
      firstOf(raw, ['createdAt', 'timestamp', 'pinnedAt', 'time', 'blockTimestamp', 'at']),
    ),
    txHash: asString(firstOf(raw, ['txHash', 'transactionHash', 'tx', 'proofTx'])),
    blockNumber: asNumber(firstOf(raw, ['blockNumber', 'block'])),
    size: asNumber(firstOf(raw, ['size', 'bytes', 'PinSize', 'pinSize'])),
    preview: preview ?? plaintext,
    raw,
  };
}

/**
 * Normalize `GET /api/memories`. Accepts a bare array, `{items}`, `{memories}`
 * or `{data}`, because all four are plausible and only one of them is going to
 * be what the backend ships.
 *
 * @param {unknown} raw
 * @returns {{ items: MemoryRecord[], nextCursor: string|null, total: number|null }}
 */
export function normalizeMemoryList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : asArray(firstOf(raw, ['items', 'memories', 'data', 'results', 'records']));
  return {
    items: list.map(normalizeMemory),
    nextCursor: asString(firstOf(raw, ['nextCursor', 'cursor', 'next', 'paging.nextCursor'])),
    total: asNumber(firstOf(raw, ['total', 'count', 'paging.total'])),
  };
}

/**
 * Build a public gateway URL for a CID.
 *
 * Returns null when the node named no gateway: the console never hard-codes a
 * third party. Note that this URL is only ever used as a user-activated link —
 * the page itself must not fetch a cross-origin gateway, which would leak
 * every viewer's IP and the CIDs they read, and is blocked by `connect-src`.
 *
 * @param {string | null} gateway base, with or without a trailing `/ipfs/`
 * @param {string | null} cid
 * @returns {string | null}
 */
export function gatewayUrl(gateway, cid) {
  if (typeof gateway !== 'string' || gateway === '') return null;
  if (typeof cid !== 'string' || cid === '') return null;
  const base = gateway.replace(/\/+$/, '');
  const withPath = /\/ipfs$/.test(base) ? base : base + '/ipfs';
  return withPath + '/' + encodeURIComponent(cid);
}

/* ==================================================================== *
 * Reputation
 * ==================================================================== */

/**
 * @typedef {object} RepEntry
 * @property {string|null} address
 * @property {string} label
 * @property {number|null} score
 * @property {boolean|null} trusted
 * @property {number|null} endorsements
 * @property {number|null} reports
 */

/**
 * @typedef {object} TrustEvent
 * @property {string|null} from
 * @property {string|null} to
 * @property {'endorse'|'report'} action
 * @property {string|null} reason
 * @property {number|null} at epoch ms, or null when the source has no clock
 * @property {string|null} txHash
 */

/**
 * Normalize `GET /api/reputation`.
 *
 * The score and the trusted flag are read, never computed. The old dashboard
 * reimplemented `(endorsers * 1000) / (1 + 3 * negatives)` and a `>= 500`
 * cutoff in the browser; that arithmetic lives in ReputationManager.sol and
 * duplicating it guarantees the two drift apart silently.
 *
 * @param {unknown} raw
 * @returns {{ entries: RepEntry[], events: TrustEvent[],
 *   thresholds: { trusted: number|null, max: number|null } }}
 */
export function normalizeReputation(raw) {
  const list = Array.isArray(raw)
    ? raw
    : asArray(firstOf(raw, ['entries', 'agents', 'scores', 'items', 'data']));
  const events = asArray(firstOf(raw, ['events', 'trustEvents', 'reputationEvents', 'history']));
  return {
    entries: list.map(normalizeRepEntry),
    events: events.map(normalizeTrustEvent),
    thresholds: {
      trusted: asNumber(firstOf(raw, ['thresholds.trusted', 'trustThreshold', 'thresholds.min'])),
      max: asNumber(firstOf(raw, ['thresholds.max', 'scoreMax', 'thresholds.scoreMax'])),
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {RepEntry}
 */
export function normalizeRepEntry(raw) {
  const address = asString(firstOf(raw, ['address', 'agent', 'wallet', 'id', 'did']));
  return {
    address,
    label: asString(firstOf(raw, ['label', 'name', 'id'])) ?? address ?? 'Unknown agent',
    score: asNumber(firstOf(raw, ['score', 'reputation', 'reputationScore'])),
    trusted: asBool(firstOf(raw, ['trusted', 'isTrusted'])),
    endorsements: asNumber(firstOf(raw, ['endorsements', 'endorsers', 'positives', 'up'])),
    reports: asNumber(firstOf(raw, ['reports', 'negatives', 'down'])),
  };
}

/**
 * @param {unknown} raw
 * @returns {TrustEvent}
 */
export function normalizeTrustEvent(raw) {
  const action = (asString(firstOf(raw, ['action', 'type', 'kind'])) ?? 'endorse').toLowerCase();
  return {
    from: asString(firstOf(raw, ['from', 'by', 'source', 'endorser'])),
    to: asString(firstOf(raw, ['to', 'target', 'subject'])),
    action: action.startsWith('report') || action.startsWith('slash') ? 'report' : 'endorse',
    reason: asString(firstOf(raw, ['reason', 'note', 'message'])),
    at: asEpochMs(firstOf(raw, ['at', 'timestamp', 'time', 'blockTimestamp', 'createdAt'])),
    txHash: asString(firstOf(raw, ['txHash', 'transactionHash', 'tx'])),
  };
}

/**
 * Collapse events into one weighted edge per ordered pair per action, which is
 * what the topology chart wants. Twenty endorsements between the same two
 * agents are one thick edge, not twenty overlapping lines.
 *
 * @param {readonly TrustEvent[]} events
 * @returns {Array<{ from: string, to: string, type: string, weight: number }>}
 */
export function aggregateEdges(events) {
  /** @type {Map<string, { from: string, to: string, type: string, weight: number }>} */
  const edges = new Map();
  for (const event of events) {
    if (!event.from || !event.to) continue;
    const key = event.from + '\u0000' + event.to + '\u0000' + event.action;
    const existing = edges.get(key);
    if (existing) existing.weight += 1;
    else edges.set(key, { from: event.from, to: event.to, type: event.action, weight: 1 });
  }
  return Array.from(edges.values());
}

/* ==================================================================== *
 * Semantic search and similarity
 * ==================================================================== */

/**
 * @typedef {object} SearchHit
 * @property {string|null} cid
 * @property {string|null} agent
 * @property {number|null} similarity raw cosine similarity
 * @property {number|null} trustWeight the reputation multiplier the node applied
 * @property {number|null} score the combined ranking score, when the node sends one
 * @property {string|null} model
 * @property {string|null} preview
 */

/**
 * Normalize `POST /api/semantic/search`.
 *
 * `score` is deliberately NOT filled in from `similarity` when the node omits
 * it. The whole point of the results table is to make the trust weighting
 * visible; showing the raw similarity in the "combined score" column would
 * misrepresent an unweighted ranking as a weighted one.
 *
 * @param {unknown} raw
 * @returns {{ hits: SearchHit[], tookMs: number|null, trustWeighted: boolean|null }}
 */
export function normalizeSearch(raw) {
  const list = Array.isArray(raw)
    ? raw
    : asArray(firstOf(raw, ['results', 'hits', 'items', 'matches', 'data']));
  return {
    hits: list.map((entry) => ({
      cid: asString(firstOf(entry, ['cid', 'CID', 'contentId', 'id'])),
      agent: asString(firstOf(entry, ['agent', 'owner', 'agentAddress', 'from', 'did'])),
      similarity: asNumber(firstOf(entry, ['similarity', 'cosine', 'rawSimilarity', 'sim'])),
      trustWeight: asNumber(
        firstOf(entry, ['trustWeight', 'reputationWeight', 'weight', 'trust', 'trustScore']),
      ),
      score: asNumber(firstOf(entry, ['score', 'combinedScore', 'rankScore', 'weightedScore'])),
      model: asString(firstOf(entry, ['model', 'embeddingModel'])),
      preview: asString(firstOf(entry, ['preview', 'contextPreview', 'snippet'])),
    })),
    tookMs: asNumber(firstOf(raw, ['tookMs', 'took', 'latencyMs', 'elapsedMs', 'durationMs'])),
    trustWeighted: asBool(firstOf(raw, ['trustWeighted', 'weighted', 'trustWeighting'])),
  };
}

/**
 * Pivot a similarity payload into a square matrix.
 *
 * Accepts a ready-made matrix, or the flat pair list the simulation writes
 * (`{from, to, fromModel, toModel, similarity}`). The diagonal is `null`, not
 * 1: the node does not compare a memory with itself, and drawing an invented
 * perfect-match diagonal would be a fabricated data point.
 *
 * @param {unknown} raw
 * @returns {{ labels: string[], matrix: Array<Array<number|null>>,
 *   pairs: Array<{ from: string, to: string, fromModel: string|null,
 *     toModel: string|null, similarity: number|null }>,
 *   models: Map<string, { model: string|null, dim: number|null }> }}
 */
export function normalizeSimilarity(raw) {
  /** @type {Map<string, { model: string|null, dim: number|null }>} */
  const models = new Map();
  for (const agent of asArray(firstOf(raw, ['agents', 'nodes']))) {
    const id = asString(firstOf(agent, ['id', 'address', 'label', 'agent']));
    if (!id) continue;
    models.set(id, {
      model: asString(firstOf(agent, ['model', 'embeddingModel'])),
      dim: asNumber(firstOf(agent, ['dim', 'dims', 'dimensions', 'embeddingDim'])),
    });
  }

  const explicitMatrix = firstOf(raw, ['matrix', 'values']);
  const explicitLabels = asArray(firstOf(raw, ['labels', 'rowLabels'])).map((entry) =>
    String(entry),
  );
  if (Array.isArray(explicitMatrix) && explicitMatrix.length > 0) {
    const matrix = explicitMatrix.map((row) => asArray(row).map((cell) => asNumber(cell)));
    const labels =
      explicitLabels.length === matrix.length
        ? explicitLabels
        : matrix.map((_row, index) => 'Agent ' + (index + 1));
    return { labels, matrix, pairs: pairsFromMatrix(labels, matrix), models };
  }

  const flat = asArray(
    firstOf(raw, ['pairs', 'crossModelSimilarity', 'similarities', 'entries', 'items']),
  );
  /** @type {Array<{ from: string, to: string, fromModel: string|null,
   *   toModel: string|null, similarity: number|null }>} */
  const pairs = [];
  for (const entry of flat) {
    const from = asString(firstOf(entry, ['from', 'a', 'source']));
    const to = asString(firstOf(entry, ['to', 'b', 'target']));
    if (!from || !to) continue;
    pairs.push({
      from,
      to,
      fromModel: asString(firstOf(entry, ['fromModel', 'aModel', 'sourceModel'])),
      toModel: asString(firstOf(entry, ['toModel', 'bModel', 'targetModel'])),
      similarity: asNumber(firstOf(entry, ['similarity', 'cosine', 'value', 'score'])),
    });
  }

  /** @type {string[]} */
  const labels = [];
  const seen = new Set();
  for (const id of models.keys()) {
    labels.push(id);
    seen.add(id);
  }
  for (const pair of pairs) {
    for (const id of [pair.from, pair.to]) {
      if (seen.has(id)) continue;
      seen.add(id);
      labels.push(id);
    }
  }

  const index = new Map(labels.map((label, position) => [label, position]));
  const matrix = labels.map(() => labels.map(() => /** @type {number|null} */ (null)));
  for (const pair of pairs) {
    const row = index.get(pair.from);
    const column = index.get(pair.to);
    if (row === undefined || column === undefined) continue;
    matrix[row][column] = pair.similarity;
  }
  return { labels, matrix, pairs, models };
}

/**
 * @param {readonly string[]} labels
 * @param {ReadonlyArray<ReadonlyArray<number|null>>} matrix
 * @returns {Array<{ from: string, to: string, fromModel: null, toModel: null, similarity: number|null }>}
 */
function pairsFromMatrix(labels, matrix) {
  /** @type {Array<{ from: string, to: string, fromModel: null, toModel: null, similarity: number|null }>} */
  const pairs = [];
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < (matrix[row] || []).length; column += 1) {
      if (row === column) continue;
      const value = matrix[row][column];
      if (value === null || value === undefined) continue;
      pairs.push({
        from: labels[row] ?? String(row),
        to: labels[column] ?? String(column),
        fromModel: null,
        toModel: null,
        similarity: value,
      });
    }
  }
  return pairs;
}

/* ==================================================================== *
 * Simulation benchmarks
 * ==================================================================== */

/**
 * The stages the simulation records, in pipeline order, with the several
 * spellings the on-disk file and the backend have each used.
 */
export const STAGES = Object.freeze([
  { key: 'embedding', label: 'Embedding', sources: ['embeddingLatencies', 'embedding', 'embed'] },
  {
    key: 'encryption',
    label: 'Encryption',
    sources: ['encryptionLatencies', 'encryption', 'encrypt'],
  },
  { key: 'ipfs', label: 'IPFS pin', sources: ['ipfsLatencies', 'ipfs', 'pin', 'pinLatencies'] },
  {
    key: 'chain',
    label: 'Chain commit',
    sources: ['blockchainLatencies', 'chainLatencies', 'chain', 'blockchain'],
  },
  { key: 'total', label: 'End to end', sources: ['totalLatencies', 'total', 'endToEnd'] },
]);

/**
 * Normalize `GET /api/simulation-results`.
 *
 * @param {unknown} raw
 * @returns {{ agents: Array<{ id: string, model: string|null, dim: number|null,
 *   wallet: string|null }>, events: TrustEvent[],
 *   stages: Array<{ key: string, label: string, values: number[] }> }}
 */
export function normalizeSimulation(raw) {
  const benchmarks = asRecord(firstOf(raw, ['benchmarks', 'latencies', 'metrics']));
  /** @type {Array<{ key: string, label: string, values: number[] }>} */
  const stages = [];
  for (const stage of STAGES) {
    /** @type {number[]} */
    let values = [];
    for (const source of stage.sources) {
      const candidate = benchmarks[source];
      if (Array.isArray(candidate)) {
        values = candidate.map(asNumber).filter(
          /** @returns {value is number} */
          (value) => value !== null,
        );
        break;
      }
    }
    if (values.length > 0) stages.push({ key: stage.key, label: stage.label, values });
  }

  return {
    agents: asArray(firstOf(raw, ['agents', 'nodes']))
      .map((agent) => ({
        id: asString(firstOf(agent, ['id', 'address', 'label'])) ?? '',
        model: asString(firstOf(agent, ['model', 'embeddingModel'])),
        dim: asNumber(firstOf(agent, ['dim', 'dims', 'dimensions'])),
        wallet: asString(firstOf(agent, ['wallet', 'address'])),
      }))
      .filter((agent) => agent.id !== ''),
    events: asArray(firstOf(raw, ['reputationEvents', 'events', 'trustEvents'])).map(
      normalizeTrustEvent,
    ),
    stages,
  };
}

/* ==================================================================== *
 * Health, readiness and Prometheus metrics
 * ==================================================================== */

/**
 * @typedef {object} ReadinessCheck
 * @property {string} name
 * @property {'ok'|'warn'|'fail'|'unknown'} status
 * @property {string|null} detail
 * @property {number|null} latencyMs
 */

/**
 * Turn whatever `GET /healthz` + `GET /readyz` report into a uniform check list.
 *
 * Unknown check names render generically, so a backend that adds a `disk`
 * probe tomorrow needs no frontend change — the audit's complaint about a
 * hard-coded three-panel status block was exactly this.
 *
 * @param {unknown} raw a health or readiness payload
 * @returns {ReadinessCheck[]}
 */
export function normalizeChecks(raw) {
  const source = firstOf(raw, ['checks', 'components', 'details', 'services', 'probes']);

  /** @type {ReadinessCheck[]} */
  const checks = [];
  const push = (/** @type {string} */ name, /** @type {unknown} */ entry) => {
    if (typeof entry === 'boolean') {
      checks.push({ name, status: entry ? 'ok' : 'fail', detail: null, latencyMs: null });
      return;
    }
    if (typeof entry === 'string') {
      checks.push({ name, status: checkStatus(entry), detail: entry, latencyMs: null });
      return;
    }
    const statusValue = firstOf(entry, ['status', 'state', 'ok', 'ready', 'healthy']);
    checks.push({
      name,
      status:
        typeof statusValue === 'boolean'
          ? statusValue
            ? 'ok'
            : 'fail'
          : checkStatus(asString(statusValue)),
      detail: asString(firstOf(entry, ['detail', 'message', 'error', 'info', 'reason'])),
      latencyMs: asNumber(firstOf(entry, ['latencyMs', 'durationMs', 'tookMs', 'elapsedMs'])),
    });
  };

  if (Array.isArray(source)) {
    for (const entry of source) {
      push(asString(firstOf(entry, ['name', 'check', 'component', 'id'])) ?? 'check', entry);
    }
  } else if (source && typeof source === 'object') {
    for (const [name, entry] of Object.entries(asRecord(source))) push(name, entry);
  }
  return checks;
}

/**
 * @param {string | null | undefined} value
 * @returns {'ok'|'warn'|'fail'|'unknown'}
 */
export function checkStatus(value) {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.trim().toLowerCase();
  if (['ok', 'up', 'pass', 'ready', 'healthy', 'true', 'connected'].includes(lowered)) return 'ok';
  if (['degraded', 'warn', 'warning', 'loading', 'starting', 'pending'].includes(lowered)) {
    return 'warn';
  }
  if (['fail', 'failed', 'down', 'error', 'false', 'unavailable'].includes(lowered)) return 'fail';
  return 'unknown';
}

/**
 * @typedef {object} MetricFamily
 * @property {string} name
 * @property {string|null} help
 * @property {string|null} type
 * @property {Array<{ labels: Record<string, string>, value: number }>} samples
 */

/**
 * Parse the Prometheus text exposition format.
 *
 * Deliberately tolerant: an unparsable line is skipped rather than aborting
 * the parse, because the metrics endpoint is a diagnostic and a diagnostic
 * that refuses to render when one exporter misbehaves is worse than useless.
 *
 * @param {string} text
 * @returns {Map<string, MetricFamily>}
 */
export function parsePrometheus(text) {
  /** @type {Map<string, MetricFamily>} */
  const families = new Map();
  if (typeof text !== 'string' || text === '') return families;

  /**
   * @param {string} name
   * @returns {MetricFamily}
   */
  const family = (name) => {
    let entry = families.get(name);
    if (!entry) {
      entry = { name, help: null, type: null, samples: [] };
      families.set(name, entry);
    }
    return entry;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('#')) {
      const meta = /^#\s+(HELP|TYPE)\s+(\S+)\s+([\s\S]*)$/.exec(line);
      if (!meta) continue;
      const entry = family(meta[2]);
      if (meta[1] === 'HELP') entry.help = meta[3];
      else entry.type = meta[3].trim().toLowerCase();
      continue;
    }

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/.exec(line);
    if (!match) continue;
    const value = parseMetricValue(match[3].trim().split(/\s+/)[0]);
    if (value === null) continue;
    family(match[1]).samples.push({ labels: parseLabels(match[2]), value });
  }
  return families;
}

/**
 * @param {string} token
 * @returns {number | null}
 */
function parseMetricValue(token) {
  if (token === 'NaN') return null;
  if (token === '+Inf') return Infinity;
  if (token === '-Inf') return -Infinity;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {string | undefined} block the `{a="1",b="2"}` chunk, braces included
 * @returns {Record<string, string>}
 */
function parseLabels(block) {
  /** @type {Record<string, string>} */
  const labels = {};
  if (!block) return labels;
  const body = block.slice(1, -1);
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match = pattern.exec(body);
  while (match !== null) {
    labels[match[1]] = match[2].replace(/\\(.)/g, (_all, char) => (char === 'n' ? '\n' : char));
    match = pattern.exec(body);
  }
  return labels;
}

/**
 * Estimate a quantile from histogram buckets by linear interpolation inside
 * the bucket that crosses the target rank.
 *
 * This is the same approximation `histogram_quantile()` makes in PromQL, and
 * it is labelled as an estimate wherever it is rendered — a bucketed quantile
 * is not a measured one.
 *
 * @param {ReadonlyArray<{ le: number, count: number }>} buckets cumulative
 * @param {number} p in 0..1
 * @returns {number | null}
 */
export function histogramQuantile(buckets, p) {
  const sorted = buckets
    .filter((bucket) => Number.isFinite(bucket.count))
    .slice()
    .sort((a, b) => a.le - b.le);
  if (sorted.length === 0) return null;
  const total = sorted[sorted.length - 1].count;
  if (!Number.isFinite(total) || total <= 0) return null;

  const rank = p * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bucket of sorted) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) return lowerBound;
      const span = bucket.count - lowerCount;
      if (span <= 0) return bucket.le;
      return lowerBound + ((rank - lowerCount) / span) * (bucket.le - lowerBound);
    }
    lowerBound = Number.isFinite(bucket.le) ? bucket.le : lowerBound;
    lowerCount = bucket.count;
  }
  return lowerBound;
}

/**
 * Pull per-stage latency statistics out of a parsed metric set.
 *
 * Handles both shapes a backend realistically exposes: a summary with
 * `quantile` labels, and a histogram with `_bucket`/`_count`/`_sum`. Values in
 * seconds (the Prometheus convention, signalled by a `_seconds` suffix) are
 * converted to milliseconds so the whole console speaks one unit.
 *
 * @param {Map<string, MetricFamily>} families
 * @returns {Array<{ label: string, count: number|null, p50: number|null,
 *   p95: number|null, p99: number|null, mean: number|null, estimated: boolean }>}
 */
export function stageLatencies(families) {
  /** @type {Array<{ label: string, count: number|null, p50: number|null, p95: number|null,
   *   p99: number|null, mean: number|null, estimated: boolean }>} */
  const rows = [];

  for (const [name, entry] of families) {
    if (!/(latency|duration|seconds|_ms)/i.test(name)) continue;
    if (/_(bucket|count|sum)$/.test(name)) continue;

    const toMs = /_seconds/i.test(name) ? 1000 : 1;
    const label = prettyMetricName(name);

    const bucketFamily = families.get(name + '_bucket');
    const countFamily = families.get(name + '_count');
    const sumFamily = families.get(name + '_sum');
    const count = countFamily ? sumSamples(countFamily) : null;
    const sum = sumFamily ? sumSamples(sumFamily) : null;

    if (bucketFamily && bucketFamily.samples.length > 0) {
      /** @type {Map<number, number>} */
      const buckets = new Map();
      for (const sample of bucketFamily.samples) {
        const le = Number(sample.labels.le);
        if (Number.isNaN(le)) continue;
        buckets.set(le, (buckets.get(le) ?? 0) + sample.value);
      }
      const series = Array.from(buckets, ([le, value]) => ({ le, count: value }));
      rows.push({
        label,
        count,
        p50: scale(histogramQuantile(series, 0.5), toMs),
        p95: scale(histogramQuantile(series, 0.95), toMs),
        p99: scale(histogramQuantile(series, 0.99), toMs),
        mean: count && sum !== null && count > 0 ? (sum / count) * toMs : null,
        estimated: true,
      });
      continue;
    }

    const quantiles = entry.samples.filter((sample) => sample.labels.quantile !== undefined);
    if (quantiles.length > 0) {
      /** @param {number} target @returns {number|null} */
      const at = (target) => {
        const hit = quantiles.find(
          (sample) => Math.abs(Number(sample.labels.quantile) - target) < 1e-9,
        );
        return hit ? scale(hit.value, toMs) : null;
      };
      rows.push({
        label,
        count,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        mean: count && sum !== null && count > 0 ? (sum / count) * toMs : null,
        estimated: false,
      });
    }
  }
  return rows;
}

/**
 * @param {number | null} value
 * @param {number} factor
 * @returns {number | null}
 */
function scale(value, factor) {
  return value === null || !Number.isFinite(value) ? null : value * factor;
}

/**
 * @param {MetricFamily} family
 * @returns {number}
 */
function sumSamples(family) {
  let total = 0;
  for (const sample of family.samples) if (Number.isFinite(sample.value)) total += sample.value;
  return total;
}

/**
 * `neuromesh_commit_duration_seconds` -> `Neuromesh commit duration`.
 *
 * @param {string} name
 * @returns {string}
 */
export function prettyMetricName(name) {
  const words = name
    .replace(/_(seconds|milliseconds|ms|total|bucket|count|sum)$/i, '')
    .replace(/[_:]+/g, ' ')
    .trim();
  return words === '' ? name : words.charAt(0).toUpperCase() + words.slice(1);
}
