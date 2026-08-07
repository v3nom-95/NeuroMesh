// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AgentIdentity {
    struct Agent {
        bool isActive;
        string publicKey;
        uint256 registeredAt;
    }
    
    mapping(address => Agent) public agents;
    
    event AgentRegistered(address indexed agentWallet, string publicKey);
    
    function registerAgent(string memory publicKey) external {
        require(!agents[msg.sender].isActive, "Agent already registered");
        
        agents[msg.sender] = Agent({
            isActive: true,
            publicKey: publicKey,
            registeredAt: block.timestamp
        });
        
        emit AgentRegistered(msg.sender, publicKey);
    }
    
    function getAgentStatus(address agentWallet) external view returns (bool) {
        return agents[agentWallet].isActive;
    }
}
