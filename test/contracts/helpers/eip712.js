/**
 * EIP-712 typed-data builders.
 *
 * Field ORDER in each `types` entry is load-bearing: it defines the type string that is hashed into
 * the typehash, so reordering any line silently changes every digest and turns every signature test
 * into a false negative. These arrays are kept byte-for-byte aligned with the `keccak256("...")`
 * literals in AgentIdentity.sol, MemoryLedger.sol and MemoryAccessControl.sol, and
 * `MemoryLedger.signatures.spec.js` asserts that alignment directly against the on-chain typehashes.
 */
import hre from 'hardhat';

import {
  ACCESS_DOMAIN_NAME,
  DOMAIN_VERSION,
  IDENTITY_DOMAIN_NAME,
  LEDGER_DOMAIN_NAME,
} from './constants.js';

const { ethers } = hre;

/* -------------------------------------------------------------------------- */
/* Domains                                                                     */
/* -------------------------------------------------------------------------- */

export function domain(name, chainId, verifyingContract, version = DOMAIN_VERSION) {
  return { name, version, chainId, verifyingContract };
}

export const identityDomain = (chainId, addr) => domain(IDENTITY_DOMAIN_NAME, chainId, addr);
export const ledgerDomain = (chainId, addr) => domain(LEDGER_DOMAIN_NAME, chainId, addr);
export const accessDomain = (chainId, addr) => domain(ACCESS_DOMAIN_NAME, chainId, addr);

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export const RegistrationTypes = Object.freeze({
  Registration: [
    { name: 'agent', type: 'address' },
    { name: 'publicKeyHash', type: 'bytes32' },
    { name: 'metadataURIHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
});

export const KeyRotationTypes = Object.freeze({
  KeyRotation: [
    { name: 'agent', type: 'address' },
    { name: 'publicKeyHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
});

export const MemoryCommitTypes = Object.freeze({
  MemoryCommit: [
    { name: 'agent', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'prevCidHash', type: 'bytes32' },
    { name: 'modelHash', type: 'bytes32' },
    { name: 'embeddingDim', type: 'uint32' },
    { name: 'isEncrypted', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
});

export const MemoryRevocationTypes = Object.freeze({
  MemoryRevocation: [
    { name: 'agent', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'reason', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
});

export const AccessGrantTypes = Object.freeze({
  AccessGrant: [
    { name: 'owner', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'grantee', type: 'address' },
    { name: 'wrappedKeyHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
});

/* -------------------------------------------------------------------------- */
/* Value builders                                                              */
/* -------------------------------------------------------------------------- */

export const registrationValue = ({ agent, publicKey, metadataURI, nonce, deadline }) => ({
  agent,
  publicKeyHash: ethers.keccak256(publicKey),
  metadataURIHash: ethers.id(metadataURI),
  nonce,
  deadline,
});

export const keyRotationValue = ({ agent, publicKey, nonce, deadline }) => ({
  agent,
  publicKeyHash: ethers.keccak256(publicKey),
  nonce,
  deadline,
});

export const memoryCommitValue = ({ agent, input, nonce, deadline }) => ({
  agent,
  cidHash: ethers.id(input.cid),
  prevCidHash: input.prevCidHash,
  modelHash: ethers.id(input.model),
  embeddingDim: input.embeddingDim,
  isEncrypted: input.isEncrypted,
  nonce,
  deadline,
});

export const memoryRevocationValue = ({ agent, cidHash, reason, nonce, deadline }) => ({
  agent,
  cidHash,
  reason,
  nonce,
  deadline,
});

export const accessGrantValue = ({
  owner,
  cidHash,
  grantee,
  wrappedKey,
  expiresAt,
  nonce,
  deadline,
}) => ({
  owner,
  cidHash,
  grantee,
  wrappedKeyHash: ethers.keccak256(wrappedKey),
  expiresAt,
  nonce,
  deadline,
});

/* -------------------------------------------------------------------------- */
/* High-level signers - each reads the live nonce so no test hardcodes one     */
/* -------------------------------------------------------------------------- */

async function ctxOf(contract, domainFactory) {
  const { chainId } = await hre.ethers.provider.getNetwork();
  return domainFactory(chainId, await contract.getAddress());
}

export async function signRegistration(
  signer,
  identity,
  { agent, publicKey, metadataURI, deadline, nonce },
) {
  const dom = await ctxOf(identity, identityDomain);
  const value = registrationValue({
    agent,
    publicKey,
    metadataURI,
    nonce: nonce ?? (await identity.nonces(agent)),
    deadline,
  });
  return {
    signature: await signer.signTypedData(dom, RegistrationTypes, value),
    value,
    domain: dom,
  };
}

export async function signKeyRotation(signer, identity, { agent, publicKey, deadline, nonce }) {
  const dom = await ctxOf(identity, identityDomain);
  const value = keyRotationValue({
    agent,
    publicKey,
    nonce: nonce ?? (await identity.nonces(agent)),
    deadline,
  });
  return {
    signature: await signer.signTypedData(dom, KeyRotationTypes, value),
    value,
    domain: dom,
  };
}

export async function signMemoryCommit(
  signer,
  ledger,
  { agent, input, deadline, nonce, domainOverride },
) {
  const dom = domainOverride ?? (await ctxOf(ledger, ledgerDomain));
  const value = memoryCommitValue({
    agent,
    input,
    nonce: nonce ?? (await ledger.nonces(agent)),
    deadline,
  });
  return {
    signature: await signer.signTypedData(dom, MemoryCommitTypes, value),
    value,
    domain: dom,
  };
}

export async function signMemoryRevocation(
  signer,
  ledger,
  { agent, cidHash, reason, deadline, nonce },
) {
  const dom = await ctxOf(ledger, ledgerDomain);
  const value = memoryRevocationValue({
    agent,
    cidHash,
    reason,
    nonce: nonce ?? (await ledger.nonces(agent)),
    deadline,
  });
  return {
    signature: await signer.signTypedData(dom, MemoryRevocationTypes, value),
    value,
    domain: dom,
  };
}

export async function signAccessGrant(
  signer,
  access,
  { owner, cidHash, grantee, wrappedKey, expiresAt, deadline, nonce },
) {
  const dom = await ctxOf(access, accessDomain);
  const value = accessGrantValue({
    owner,
    cidHash,
    grantee,
    wrappedKey,
    expiresAt,
    nonce: nonce ?? (await access.nonces(owner)),
    deadline,
  });
  return {
    signature: await signer.signTypedData(dom, AccessGrantTypes, value),
    value,
    domain: dom,
  };
}

/* -------------------------------------------------------------------------- */
/* Independent digest computation (the cross-check against `hashCommit`)        */
/* -------------------------------------------------------------------------- */

export const digestOf = (dom, types, value) => ethers.TypedDataEncoder.hash(dom, types, value);

export async function memoryCommitDigest(ledger, { agent, input, nonce, deadline }) {
  const dom = await ctxOf(ledger, ledgerDomain);
  return digestOf(dom, MemoryCommitTypes, memoryCommitValue({ agent, input, nonce, deadline }));
}

/* -------------------------------------------------------------------------- */
/* Signature mutilation helpers for the forgery suite                          */
/* -------------------------------------------------------------------------- */

/** secp256k1 group order; `s` values above N/2 are the malleable half OZ's ECDSA rejects. */
export const SECP256K1_N = ethers.N;

/** Rewrites a 65-byte signature into its malleable `(N - s, flipped v)` twin. */
export function toMalleable(signature) {
  const sig = ethers.Signature.from(signature);
  const s = SECP256K1_N - BigInt(sig.s);
  const v = sig.v === 27 ? 28 : 27;
  return ethers.concat([sig.r, ethers.zeroPadValue(ethers.toBeHex(s), 32), ethers.toBeHex(v, 1)]);
}

/** Flips one byte of a signature at `index`, producing a structurally valid but wrong signature. */
export function flipByte(signature, index) {
  const bytes = ethers.getBytes(signature);
  bytes[index % bytes.length] ^= 0xff;
  return ethers.hexlify(bytes);
}

/** 65 zero bytes: the canonical "ecrecover returns address(0)" probe. */
export const ZERO_SIGNATURE = '0x' + '00'.repeat(65);
