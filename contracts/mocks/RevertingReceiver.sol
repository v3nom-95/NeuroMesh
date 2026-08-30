// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAgentIdentity} from "../interfaces/IAgentIdentity.sol";
import {IReputationManager} from "../interfaces/IReputationManager.sol";

/**
 * @title RevertingReceiver
 * @author NeuroMesh Protocol
 * @notice A contract that refuses every incoming ether transfer. Test-only.
 * @dev Forces the `EtherTransferFailed(address,uint256)` branch in both
 *      `ReputationManager.claimStake` and `ReputationManager.withdrawTreasury`, and lets the suite
 *      assert that `treasuryBalance` is unchanged after such a revert - i.e. that the failure is
 *      atomic rather than a silent loss of accounting.
 *
 *      NOT FOR PRODUCTION.
 */
contract RevertingReceiver {
    /// @notice Registers this contract as an agent so it can participate in the trust graph.
    function register(address identity_, bytes calldata publicKey) external {
        IAgentIdentity(identity_).registerAgent(publicKey, "");
    }

    /// @notice Forwards an endorsement (and its stake) to the ReputationManager.
    function endorse(address rep_, address target) external payable {
        IReputationManager(rep_).endorseAgent{value: msg.value}(target, "r");
    }

    /// @notice Revokes this contract's endorsement, starting the stake unlock timer.
    function revoke(address rep_, address target) external {
        IReputationManager(rep_).revokeEndorsement(target, "r");
    }

    /// @notice Attempts to claim the stake; the transfer back will always fail.
    function claim(address rep_, address target) external {
        IReputationManager(rep_).claimStake(target);
    }

    /// @dev Rejects every incoming transfer.
    receive() external payable {
        revert("nope");
    }
}
