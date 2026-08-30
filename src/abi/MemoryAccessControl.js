/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Produced by `node scripts/gen-abi.js` from `artifacts/contracts/MemoryAccessControl.sol/MemoryAccessControl.json`.
 * Edit the Solidity and recompile; never edit this file. `node scripts/gen-abi.js --check`
 * fails CI when the tree and the artifacts disagree.
 *
 * @module src/abi/MemoryAccessControl
 */

/**
 * ABI of the MemoryAccessControl contract, sorted deterministically.
 *
 * @type {ReadonlyArray<any>}
 */
export const MemoryAccessControlAbi = Object.freeze([
  {
    inputs: [
      {
        internalType: 'address',
        name: 'admin',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'ledger_',
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
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
    ],
    name: 'AccessAlreadyGranted',
    type: 'error',
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
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
    ],
    name: 'AccessNotGranted',
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
        name: 'lengthA',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'lengthB',
        type: 'uint256',
      },
    ],
    name: 'ArrayLengthMismatch',
    type: 'error',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'size',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: 'maxSize',
        type: 'uint256',
      },
    ],
    name: 'BatchTooLarge',
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
    name: 'InvalidExpiry',
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
    name: 'MemoryAlreadyRevoked',
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
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'SelfAction',
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
        name: 'grantee',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'expiresAt',
        type: 'uint64',
      },
      {
        indexed: false,
        internalType: 'uint32',
        name: 'keyVersion',
        type: 'uint32',
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'wrappedKey',
        type: 'bytes',
      },
    ],
    name: 'AccessGranted',
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
        name: 'grantee',
        type: 'address',
      },
      {
        indexed: false,
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
    ],
    name: 'AccessRevoked',
    type: 'event',
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
    name: 'ACCESS_GRANT_TYPEHASH',
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
    inputs: [
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'account',
        type: 'address',
      },
    ],
    name: 'canAccess',
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
      {
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
    ],
    name: 'getGrant',
    outputs: [
      {
        components: [
          {
            internalType: 'uint64',
            name: 'grantedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'expiresAt',
            type: 'uint64',
          },
          {
            internalType: 'uint64',
            name: 'revokedAt',
            type: 'uint64',
          },
          {
            internalType: 'uint32',
            name: 'keyVersion',
            type: 'uint32',
          },
          {
            internalType: 'bool',
            name: 'exists',
            type: 'bool',
          },
        ],
        internalType: 'struct IMemoryAccessControl.Grant',
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
    name: 'getGrantees',
    outputs: [
      {
        internalType: 'address[]',
        name: 'page',
        type: 'address[]',
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
        name: 'grantee',
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
    name: 'getGrantsFor',
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
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
    ],
    name: 'getWrappedKey',
    outputs: [
      {
        internalType: 'bytes',
        name: 'wrappedKey',
        type: 'bytes',
      },
      {
        internalType: 'uint32',
        name: 'keyVersion',
        type: 'uint32',
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
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'wrappedKey',
        type: 'bytes',
      },
      {
        internalType: 'uint64',
        name: 'expiresAt',
        type: 'uint64',
      },
    ],
    name: 'grantAccess',
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
        internalType: 'address[]',
        name: 'grantees',
        type: 'address[]',
      },
      {
        internalType: 'bytes[]',
        name: 'wrappedKeys',
        type: 'bytes[]',
      },
      {
        internalType: 'uint64',
        name: 'expiresAt',
        type: 'uint64',
      },
    ],
    name: 'grantAccessBatch',
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
      {
        internalType: 'bytes32',
        name: 'cidHash',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'wrappedKey',
        type: 'bytes',
      },
      {
        internalType: 'uint64',
        name: 'expiresAt',
        type: 'uint64',
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
    name: 'grantAccessFor',
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
    inputs: [],
    name: 'ledger',
    outputs: [
      {
        internalType: 'contract IMemoryLedger',
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
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
    ],
    name: 'moderatorRevokeAccess',
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
        internalType: 'address',
        name: 'grantee',
        type: 'address',
      },
      {
        internalType: 'bytes32',
        name: 'reason',
        type: 'bytes32',
      },
    ],
    name: 'revokeAccess',
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
    name: 'unpause',
    outputs: [],
    stateMutability: 'nonpayable',
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
export const MemoryAccessControlDeployedBytecodeHash =
  '0xabcd87c7deb3b28f626ad93bf09f20c56bfbf39d4497359aee0a160f61544958';

/**
 * Byte length of the artifact's deployed bytecode. A length of 0 at an address means no contract.
 *
 * @type {number}
 */
export const MemoryAccessControlDeployedBytecodeSize = 11162;

/**
 * Names of this contract's public `*_TYPEHASH()` getters, used by the boot invariant.
 *
 * @type {ReadonlyArray<string>}
 */
export const MemoryAccessControlTypehashGetters = Object.freeze(['ACCESS_GRANT_TYPEHASH']);

export default MemoryAccessControlAbi;
