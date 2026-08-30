// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentIdentity} from "../interfaces/IAgentIdentity.sol";
import {IReputationManager} from "../interfaces/IReputationManager.sol";

/**
 * @title ReentrantEndorser
 * @author NeuroMesh Protocol
 * @notice Adversary contract for the stake-reentrancy test. Test-only.
 * @dev While `attacking` is set, the `receive()` hook fires during `ReputationManager.claimStake`'s
 *      ether transfer and immediately re-enters `claimStake`. The inner call must trip
 *      `ReentrancyGuard`; the revert is captured rather than bubbled so the test can assert on both
 *      layers of defence:
 *        - `reentered == true` proves the hook actually ran (the test is not vacuous),
 *        - the outer `claimStake` still reverts, because `EtherTransferFailed` is raised when the
 *          receive hook reverts - and the hook only reverts if it chooses to bubble.
 *      Here the hook swallows the inner revert, which lets the outer claim succeed and proves the
 *      SECOND layer: the `stakeClaimed` flag is written before the transfer, so the re-entrant call
 *      could not have drained anything even without the guard.
 *
 *      NOT FOR PRODUCTION.
 */
contract ReentrantEndorser {
    /// @notice The ReputationManager under attack.
    address public rep;

    /// @notice Target whose endorsement stake is being claimed.
    address public storedTarget;

    /// @notice When true, the receive hook re-enters `claimStake`.
    bool public attacking;

    /// @notice Set once the receive hook has actually executed its re-entrant call.
    bool public reentered;

    /// @notice Revert data captured from the re-entrant call, hex-free and human readable if a string.
    string public lastError;

    /// @notice Registers this contract as an agent so it can participate in the trust graph.
    function register(address identity_, bytes calldata publicKey) external {
        IAgentIdentity(identity_).registerAgent(publicKey, "");
    }

    /// @notice Forwards an endorsement (and its stake) to the ReputationManager.
    function endorse(address rep_, address target) external payable {
        rep = rep_;
        storedTarget = target;
        IReputationManager(rep_).endorseAgent{value: msg.value}(target, "r");
    }

    /// @notice Revokes this contract's endorsement, starting the stake unlock timer.
    function revoke(address rep_, address target) external {
        IReputationManager(rep_).revokeEndorsement(target, "r");
    }

    /// @notice Claims the unlocked stake; the re-entrancy happens inside the resulting ether transfer.
    function claim(address rep_, address target) external {
        rep = rep_;
        storedTarget = target;
        IReputationManager(rep_).claimStake(target);
    }

    /// @notice Arms or disarms the re-entrancy hook.
    function setAttacking(bool value) external {
        attacking = value;
    }

    /// @notice Sets the ReputationManager address without performing any action.
    function setRep(address rep_) external {
        rep = rep_;
    }

    /// @dev The attack surface: fires while ReputationManager is mid-transfer.
    receive() external payable {
        if (!attacking) return;
        reentered = true;
        try IReputationManager(rep).claimStake(storedTarget) {
            lastError = "reentrancy succeeded";
        } catch Error(string memory reason) {
            lastError = reason;
        } catch (bytes memory) {
            lastError = "custom error";
        }
    }
}
