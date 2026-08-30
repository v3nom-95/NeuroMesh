// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {Roles} from "../libraries/Roles.sol";
import {ZeroAddress} from "../libraries/NeuroMeshErrors.sol";

/**
 * @title NeuroMeshGuarded
 * @author NeuroMesh Protocol
 * @notice Shared administrative base for every NeuroMesh contract: enumerable role-based access
 *         control, an emergency pause switch, and a validated admin bootstrap.
 * @dev `AccessControlEnumerable` is chosen over plain `AccessControl` so the dashboard can answer
 *      "who can pause this contract?" with `getRoleMemberCount` / `getRoleMember` instead of
 *      replaying `RoleGranted`/`RoleRevoked` logs through an indexer. The extra cost is one
 *      `EnumerableSet` write per grant/revoke, which happens rarely.
 *
 *      `supportsInterface` is inherited from `AccessControlEnumerable`; a derived contract that
 *      overrides it MUST call `super.supportsInterface(interfaceId)` or ERC-165 detection of the
 *      access-control interfaces breaks.
 *
 *      PAUSE SEMANTICS. `whenNotPaused` guards entrypoints that create new protocol state. It is
 *      deliberately NOT applied to (a) exits that protect users - `AgentIdentity.deactivate` and
 *      `ReputationManager.claimStake` - or (b) moderation and role administration, which are exactly
 *      the tools an operator needs during the incident that caused the pause. Each such exemption is
 *      documented at its call site.
 */
abstract contract NeuroMeshGuarded is AccessControlEnumerable, Pausable {
    /**
     * @notice Bootstraps `admin` as protocol administrator and initial pauser.
     * @dev `admin` receives `DEFAULT_ADMIN_ROLE`, which is the admin of every other NeuroMesh role
     *      and can therefore hand `PAUSER_ROLE` to a dedicated hot key and renounce its own.
     * @param admin Address to receive `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`; must be non-zero.
     */
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, admin);
    }

    /**
     * @notice Halts every pause-gated entrypoint on this contract.
     * @dev Restricted to `PAUSER_ROLE`. Reverts if already paused (OpenZeppelin `Pausable`).
     */
    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Resumes normal operation.
     * @dev Restricted to `PAUSER_ROLE`. Reverts if not paused (OpenZeppelin `Pausable`).
     */
    function unpause() external onlyRole(Roles.PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Reverts with `ZeroAddress()` when `a` is the zero address.
     * @param a Address to validate.
     */
    function _requireNonZero(address a) internal pure {
        if (a == address(0)) revert ZeroAddress();
    }
}
