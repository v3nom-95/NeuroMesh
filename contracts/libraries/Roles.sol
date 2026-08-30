// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title Roles
 * @author NeuroMesh Protocol
 * @notice Shared `AccessControl` role identifiers so every NeuroMesh contract agrees on role ids.
 * @dev Value-type constants are legal inside a library, so this compiles to zero deployed code -
 *      each reference is inlined as a 32-byte push.
 *
 *      INTENDED PRODUCTION POSTURE
 *      ---------------------------
 *      - `DEFAULT_ADMIN_ROLE` (0x00, from OpenZeppelin `AccessControl`): a multisig behind a timelock.
 *        It is the admin of every role below and is the only role that can grant or revoke them.
 *      - `PAUSER_ROLE`: an operational hot key, so an incident can be contained in seconds without
 *        waking the timelock. It is deliberately the least powerful role - it cannot move funds and
 *        cannot change any parameter.
 *      - Every other role: the same multisig that holds `DEFAULT_ADMIN_ROLE`.
 *
 *      Role holders are enumerable on chain (see `NeuroMeshGuarded`, which extends
 *      `AccessControlEnumerable`), so a dashboard can list them without an off-chain indexer.
 */
library Roles {
    /**
     * @notice May call `pause()` / `unpause()` on AgentIdentity, MemoryLedger, ReputationManager and
     *         MemoryAccessControl.
     * @dev Cannot move funds, cannot change parameters, cannot grant roles. Pausing blocks new
     *      state-changing entrypoints only; user-protective exits (`AgentIdentity.deactivate`,
     *      `ReputationManager.claimStake`) and moderation remain available while paused.
     */
    bytes32 internal constant PAUSER_ROLE = keccak256("NEUROMESH_PAUSER_ROLE");

    /**
     * @notice May call the ReputationManager parameter setters (half-life, prior, threshold,
     *         negative multiplier, endorser weights, cooldowns, stake, stake lock).
     * @dev Honoured by ReputationManager only. Confers no power over identity, memories or funds.
     */
    bytes32 internal constant PARAM_ADMIN_ROLE = keccak256("NEUROMESH_PARAM_ADMIN_ROLE");

    /**
     * @notice May call `AgentIdentity.adminSetActive` to suspend or reinstate an agent.
     * @dev Honoured by AgentIdentity only. Cannot register agents on their behalf (that always
     *      requires the agent's own EIP-712 signature) and cannot rotate an agent's key.
     */
    bytes32 internal constant REGISTRAR_ROLE = keccak256("NEUROMESH_REGISTRAR_ROLE");

    /**
     * @notice May call `MemoryLedger.moderatorRevokeMemory` and
     *         `MemoryAccessControl.moderatorRevokeAccess`.
     * @dev A content takedown signal: it tombstones the on-chain record and withdraws on-chain
     *      authorisation. It cannot delete the record, cannot rewrite ownership, and - since the
     *      bytes live on IPFS - cannot unpublish anything.
     */
    bytes32 internal constant MODERATOR_ROLE = keccak256("NEUROMESH_MODERATOR_ROLE");

    /**
     * @notice May call `ReputationManager.slashEndorsement`, removing an endorsement and confiscating
     *         its stake to the treasury.
     * @dev Honoured by ReputationManager only.
     */
    bytes32 internal constant SLASHER_ROLE = keccak256("NEUROMESH_SLASHER_ROLE");

    /**
     * @notice May call `ReputationManager.withdrawTreasury`, moving slashed stake out of the contract.
     * @dev Bounded by `treasuryBalance`; can never touch stake that is still escrowed for an endorser.
     */
    bytes32 internal constant TREASURER_ROLE = keccak256("NEUROMESH_TREASURER_ROLE");
}
