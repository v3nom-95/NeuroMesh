/**
 * NeuroMesh Cross-Model Semantic Synchronization Module
 *
 * Different AI models produce embeddings of different dimensionalities:
 *   - all-MiniLM-L6-v2      -> 384 dimensions
 *   - all-distilroberta-v1   -> 768 dimensions
 *   - BERT-base              -> 768 dimensions
 *
 * For heterogeneous agents to share and understand each other's memories,
 * we need a "semantic translation layer" that projects embeddings into a
 * shared semantic space.
 *
 * This module implements:
 *   1. Random projection (Johnson-Lindenstrauss) for dimensionality reduction
 *   2. Zero-padding for dimensionality expansion
 *   3. Cosine similarity for cross-model memory retrieval
 */

/**
 * Generate a random projection matrix of shape (fromDim, toDim).
 * Based on Johnson-Lindenstrauss lemma: random projections approximately
 * preserve pairwise distances between high-dimensional points.
 *
 * Each element ~ N(0, 1/toDim) to preserve expected norms.
 */
export function generateProjectionMatrix(fromDim, toDim) {
    const matrix = [];
    const scale = 1.0 / Math.sqrt(toDim);
    for (let i = 0; i < fromDim; i++) {
        const row = [];
        for (let j = 0; j < toDim; j++) {
            // Box-Muller transform for Gaussian random numbers
            const u1 = Math.random();
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            row.push(z * scale);
        }
        matrix.push(row);
    }
    return matrix;
}

/**
 * Project a vector from one dimensionality to another using the projection matrix.
 * result[j] = sum_i( vector[i] * matrix[i][j] )
 */
export function projectEmbedding(vector, projectionMatrix) {
    const toDim = projectionMatrix[0].length;
    const result = new Array(toDim).fill(0);
    for (let i = 0; i < vector.length; i++) {
        for (let j = 0; j < toDim; j++) {
            result[j] += vector[i] * projectionMatrix[i][j];
        }
    }
    return result;
}

/**
 * Align two embeddings to a shared target dimensionality.
 * - If embedding is larger than target: project down using random projection.
 * - If embedding is smaller than target: zero-pad to target dimension.
 * - If equal: return as-is.
 *
 * @param {number[]} embedding - The source embedding vector
 * @param {number} sourceDim - Original dimensionality
 * @param {number} targetDim - Shared target dimensionality
 * @param {number[][]|null} projMatrix - Pre-computed projection matrix (or null to generate)
 * @returns {{ aligned: number[], projMatrix: number[][] | null }}
 */
export function alignEmbedding(embedding, sourceDim, targetDim, projMatrix = null) {
    if (sourceDim === targetDim) {
        return { aligned: embedding, projMatrix: null };
    }

    if (sourceDim > targetDim) {
        // Dimensionality REDUCTION via random projection
        if (!projMatrix) {
            projMatrix = generateProjectionMatrix(sourceDim, targetDim);
        }
        const aligned = projectEmbedding(embedding, projMatrix);
        return { aligned, projMatrix };
    }

    // Dimensionality EXPANSION via zero-padding
    const aligned = [...embedding, ...new Array(targetDim - sourceDim).fill(0)];
    return { aligned, projMatrix: null };
}

/**
 * Compute cosine similarity between two vectors (must be same dimensionality).
 * Returns a value between -1 and 1.
 */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find the top-K most semantically similar memories from a memory bank.
 *
 * @param {number[]} queryEmbedding - The query vector (aligned to shared dim)
 * @param {{ cid: string, embedding: number[] }[]} memoryBank - Stored memories with aligned embeddings
 * @param {number} topK - Number of results to return
 * @returns {{ cid: string, similarity: number }[]}
 */
export function semanticSearch(queryEmbedding, memoryBank, topK = 5) {
    const scored = memoryBank.map(mem => ({
        cid: mem.cid,
        similarity: cosineSimilarity(queryEmbedding, mem.embedding)
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
