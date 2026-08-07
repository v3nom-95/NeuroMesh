/**
 * NeuroMesh Encryption Module
 * AES-256-GCM encryption for privacy-preserving memory payloads.
 *
 * Before a memory context is uploaded to IPFS, it is encrypted using
 * a key derived from the agent's private key + a random salt. Only
 * the agent (or agents it shares the key with) can decrypt the memory.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derive a 256-bit AES key from a passphrase (agent's private key) + salt.
 * Uses PBKDF2 with SHA-512 for key stretching.
 */
function deriveKey(passphrase, salt) {
    return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext - The raw context to encrypt
 * @param {string} passphrase - The agent's private key or shared secret
 * @returns {{ encrypted: string, salt: string, iv: string, tag: string }}
 */
export function encryptMemory(plaintext, passphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(passphrase, salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
        encrypted,
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        tag: tag.toString('hex')
    };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @param {{ encrypted: string, salt: string, iv: string, tag: string }} encryptedData
 * @param {string} passphrase - The agent's private key or shared secret
 * @returns {string} The decrypted plaintext
 */
export function decryptMemory(encryptedData, passphrase) {
    const salt = Buffer.from(encryptedData.salt, 'hex');
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const tag = Buffer.from(encryptedData.tag, 'hex');
    const key = deriveKey(passphrase, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
