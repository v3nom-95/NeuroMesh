import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config.js';

export default {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: false,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test/contracts',
    cache: './cache',
    artifacts: './artifacts',
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
