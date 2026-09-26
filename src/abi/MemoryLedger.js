/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Produced by `node scripts/gen-abi.js` from `artifacts/contracts/MemoryLedger.sol/MemoryLedger.json`.
 * Edit the Solidity and recompile; never edit this file. `node scripts/gen-abi.js --check`
 * fails CI when the tree and the artifacts disagree.
 *
 * @module src/abi/MemoryLedger
 */

/**
 * ABI of the MemoryLedger contract, sorted deterministically.
 *
 * @type {ReadonlyArray<any>}
 */
export const MemoryLedgerAbi = Object.freeze([
  {
    inputs: [
      {
        internalType: 'address',
        name: 'admin',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'identity_',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [],
    name: 'AccessControlBadConfirmation',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'neededRole',
        type: 'bytes32',
      },
    ],
    name: 'AccessControlUnauthorizedAccount',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'AgentInactive',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'deadline',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'maxDeadline',
        type: 'uint256',
      },
    ],
    name: 'DeadlineTooFar',
    type: 'error',
  },
  {
    inputs: [],
    name: 'EnforcedPause',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ExpectedPause',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'currentNonce',
        type: 'uint256',
      },
    ],
    name: 'InvalidAccountNonce',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'dim',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'minDim',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'maxDim',
        type: 'uint256',
      },
    ],
    name: 'InvalidEmbeddingDim',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'limit',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'maxLimit',
        type: 'uint256',
      },
    ],
    name: 'InvalidPageSize',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'name',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'value',
        type: 'uint256',
      },
    ],
    name: 'InvalidParameter',
    type: 'error',
  },
  {
    inputs: [],
    name: 'InvalidShortString',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'expectedSigner',
        type: 'address',
      },
    ],
    name: 'InvalidSignature',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'MemoryAlreadyExists',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'MemoryAlreadyRevoked',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'MemoryNotFound',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'target',
        type: 'address',
      },
    ],
    name: 'NotAContract',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'caller',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
    ],
    name: 'NotMemoryOwner',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'prevCidHash',
        type: 'bytes32',
      },
    ],
    name: 'ParentNotFound',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'prevCidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'parentOwner',
        type: 'address',
      },
    ],
    name: 'ParentNotOwnedByAgent',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'prevCidHash',
        type: 'bytes32',
      },
    ],
    name: 'ParentRevoked',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
    ],
    name: 'PrecommitAlreadyExists',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
      {
        internalType: 'uint64',
        name: 'expiresAt',
        type: 'uint64',
      },
      {
        internalType: 'uint256',
        name: 'blockTimestamp',
        type: 'uint256',
      },
    ],
    name: 'PrecommitExpired',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
    ],
    name: 'PrecommitNotFound',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
      {
        internalType: 'uint64',
        name: 'revealableAt',
        type: 'uint64',
      },
      {
        internalType: 'uint256',
        name: 'blockTimestamp',
        type: 'uint256',
      },
    ],
    name: 'PrecommitTooYoung',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'SelfReferentialParent',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'deadline',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'blockTimestamp',
        type: 'uint256',
      },
    ],
    name: 'SignatureExpired',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'field',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'length',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'maxLength',
        type: 'uint256',
      },
    ],
    name: 'StringTooLong',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'string',
        name: 'str',
        type: 'string',
      },
    ],
    name: 'StringTooLong',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'field',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'length',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'minLength',
        type: 'uint256',
      },
    ],
    name: 'StringTooShort',
    type: 'error',
  },
  {
    inputs: [],
    name: 'ZeroAddress',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [],
    name: 'EIP712DomainChanged',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'prevCidHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'cid',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'model',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'embeddingDim',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'bool',
        name: 'isEncrypted',
        type: 'bool',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'version',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'committedBy',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'committedAt',
        type: 'uint64',
      },
    ],
    name: 'MemoryCommitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'actor',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'revokedAt',
        type: 'uint64',
      },
    ],
    name: 'MemoryRevokedEvent',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'Paused',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'at',
        type: 'uint64',
      },
    ],
    name: 'Precommitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'previousAdminRole',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'newAdminRole',
        type: 'bytes32',
      },
    ],
    name: 'RoleAdminChanged',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'sender',
        type: 'address',
      },
    ],
    name: 'RoleGranted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'sender',
        type: 'address',
      },
    ],
    name: 'RoleRevoked',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'Unpaused',
    type: 'event',
  },
  {
    inputs: [],
    name: 'DEFAULT_ADMIN_ROLE',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'MEMORY_COMMIT_TYPEHASH',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'MEMORY_REVOCATION_TYPEHASH',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    name: 'activeMemoryCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'string',
        name: 'cid',
        type: 'string',
      },
    ],
    name: 'cidHashOf',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryInput',
        name: 'input',
        type: 'tuple',
      },
      {
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'commitMemory',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryInput',
        name: 'input',
        type: 'tuple',
      },
      {
        internalType: 'uint256',
        name: 'deadline',
        type: 'uint256',
      },
      {
        internalType: 'bytes',
        name: 'signature',
        type: 'bytes',
      },
    ],
    name: 'commitMemoryFor',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'eip712Domain',
    outputs: [
      {
        internalType: 'bytes1',
        name: 'fields',
        type: 'bytes1',
      },
      {
        internalType: 'string',
        name: 'name',
        type: 'string',
      },
      {
        internalType: 'string',
        name: 'version',
        type: 'string',
      },
      {
        internalType: 'uint256',
        name: 'chainId',
        type: 'uint256',
      },
      {
        internalType: 'address',
        name: 'verifyingContract',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
      {
        internalType: 'uint256[]',
        name: 'extensions',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'exists',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'offset',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'limit',
        type: 'uint256',
      },
    ],
    name: 'getChildren',
    outputs: [
      {
        internalType: 'bytes32[]',
        name: 'page',
        type: 'bytes32[]',
      },
      {
        internalType: 'uint256',
        name: 'total',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
    ],
    name: 'getMemory',
    outputs: [
      {
        components: [
          {
            internalType: 'address',
            name: 'owner',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'committedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'committedBy',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'revokedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'version',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
          {
            internalType: 'bool',
            name: 'revoked',
            type: 'bool',
          },
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryRecord',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'string',
        name: 'cid',
        type: 'string',
      },
    ],
    name: 'getMemoryByCid',
    outputs: [
      {
        components: [
          {
            internalType: 'address',
            name: 'owner',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'committedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'committedBy',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'revokedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'version',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
          {
            internalType: 'bool',
            name: 'revoked',
            type: 'bool',
          },
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryRecord',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'offset',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'limit',
        type: 'uint256',
      },
    ],
    name: 'getOwnerMemories',
    outputs: [
      {
        internalType: 'bytes32[]',
        name: 'page',
        type: 'bytes32[]',
      },
      {
        internalType: 'uint256',
        name: 'total',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
    ],
    name: 'getOwnerMemoryCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'offset',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'limit',
        type: 'uint256',
      },
    ],
    name: 'getOwnerMemoryRecords',
    outputs: [
      {
        components: [
          {
            internalType: 'address',
            name: 'owner',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'committedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'address',
            name: 'committedBy',
            type: 'address',
          },
          {
            internalType: 'uint64',
            name: 'revokedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'version',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
          {
            internalType: 'bool',
            name: 'revoked',
            type: 'bool',
          },
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryRecord[]',
        name: 'page',
        type: 'tuple[]',
      },
      {
        internalType: 'uint256',
        name: 'total',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
    ],
    name: 'getRoleAdmin',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'index',
        type: 'uint256',
      },
    ],
    name: 'getRoleMember',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
    ],
    name: 'getRoleMemberCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
    ],
    name: 'getRoleMembers',
    outputs: [
      {
        internalType: 'address[]',
        name: '',
        type: 'address[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'maxDepth',
        type: 'uint256',
      },
    ],
    name: 'getVersionChain',
    outputs: [
      {
        internalType: 'bytes32[]',
        name: 'chain',
        type: 'bytes32[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'grantRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'hasRole',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'string',
            name: 'cid',
            type: 'string',
          },
          {
            internalType: 'bytes32',
            name: 'prevCidHash',
            type: 'bytes32',
          },
          {
            internalType: 'string',
            name: 'model',
            type: 'string',
          },
          {
            internalType: 'uint32',
            name: 'embeddingDim',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'isEncrypted',
            type: 'bool',
          },
        ],
        internalType: 'struct IMemoryLedger.MemoryInput',
        name: 'input',
        type: 'tuple',
      },
      {
        internalType: 'uint256',
        name: 'nonce',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'deadline',
        type: 'uint256',
      },
    ],
    name: 'hashCommit',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'identity',
    outputs: [
      {
        internalType: 'contract IAgentIdentity',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
    ],
    name: 'moderatorRevokeMemory',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
    ],
    name: 'nonces',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'pause',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'paused',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
    ],
    name: 'precommit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
    ],
    name: 'precommitHash',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'blindedHash',
        type: 'bytes32',
      },
    ],
    name: 'precommittedAt',
    outputs: [
      {
        internalType: 'uint64',
        name: '',
        type: 'uint64',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'callerConfirmation',
        type: 'address',
      },
    ],
    name: 'renounceRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
    ],
    name: 'revokeMemory',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'agent',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'deadline',
        type: 'uint256',
      },
      {
        internalType: 'bytes',
        name: 'signature',
        type: 'bytes',
      },
    ],
    name: 'revokeMemoryFor',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'role',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'revokeRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes4',
        name: 'interfaceId',
        type: 'bytes4',
      },
    ],
    name: 'supportsInterface',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalMemoryCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalRevokedCount',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'unpause',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'string',
        name: 'cid',
        type: 'string',
      },
    ],
    name: 'verifyMemory',
    outputs: [
      {
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      {
        internalType: 'uint64',
        name: 'committedAt',
        type: 'uint64',
      },
      {
        internalType: 'bool',
        name: 'isEncrypted',
        type: 'bool',
      },
      {
        internalType: 'uint32',
        name: 'embeddingDim',
        type: 'uint32',
      },
      {
        internalType: 'string',
        name: 'model',
        type: 'string',
      },
      {
        internalType: 'bool',
        name: 'revoked',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
]);

/**
 * keccak256 of the artifact's `deployedBytecode`.
 *
 * Compare against `eth_getCode` to detect that a configured address holds a different build of
 * this contract. Two caveats, both deliberate and both treated by the chain service as DEGRADED
 * rather than fatal: immutable variables are zeroed in the artifact but populated on chain, so a
 * contract with immutables never matches byte-for-byte; and metadata hashes differ across compiler
 * settings. A mismatch therefore means "cannot prove this is the build we know", not "wrong".
 *
 * @type {string}
 */
export const MemoryLedgerDeployedBytecodeHash =
  '0xe2381bc39db86a16b470c79b89c512bf154ab8651c56adb2532810991f10e2d9';

/**
 * Byte length of the artifact's deployed bytecode. A length of 0 at an address means no contract.
 *
 * @type {number}
 */
export const MemoryLedgerDeployedBytecodeSize = 13753;

/**
 * Names of this contract's public `*_TYPEHASH()` getters, used by the boot invariant.
 *
 * @type {ReadonlyArray<string>}
 */
export const MemoryLedgerTypehashGetters = Object.freeze([
  'MEMORY_COMMIT_TYPEHASH',
  'MEMORY_REVOCATION_TYPEHASH',
]);

export default MemoryLedgerAbi;
