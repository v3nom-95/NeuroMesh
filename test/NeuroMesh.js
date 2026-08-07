import { expect } from "chai";
import hre from "hardhat";

describe("NeuroMesh Protocol v2 — Research Expansion", function () {
  let identity, ledger, reputation;
  let owner, agent1, agent2, agent3;

  beforeEach(async function () {
    [owner, agent1, agent2, agent3] = await hre.ethers.getSigners();

    const AgentIdentity = await hre.ethers.getContractFactory("AgentIdentity");
    identity = await AgentIdentity.deploy();

    const MemoryLedger = await hre.ethers.getContractFactory("MemoryLedger");
    ledger = await MemoryLedger.deploy();

    const ReputationManager = await hre.ethers.getContractFactory("ReputationManager");
    reputation = await ReputationManager.deploy(await identity.getAddress());
  });

  describe("AgentIdentity", function () {
    it("Should register a new agent", async function () {
      await identity.connect(agent1).registerAgent("pubKey123");
      expect(await identity.getAgentStatus(agent1.address)).to.equal(true);
    });

    it("Should reject duplicate registration", async function () {
      await identity.connect(agent1).registerAgent("pubKey123");
      await expect(identity.connect(agent1).registerAgent("pubKey456"))
        .to.be.revertedWith("Agent already registered");
    });
  });

  describe("MemoryLedger (Upgraded)", function () {
    it("Should commit an encrypted memory with metadata", async function () {
      const cid = "QmEncryptedHash123";
      await ledger.connect(agent1).commitMemory(
        cid, "", hre.ethers.encodeBytes32String("sig"),
        true,   // isEncrypted
        384,    // embeddingDim
        "all-MiniLM-L6-v2" // embeddingModel
      );

      const [memOwner, timestamp, isEncrypted, embDim, embModel] = await ledger.verifyMemory(cid);
      expect(memOwner).to.equal(agent1.address);
      expect(isEncrypted).to.equal(true);
      expect(embDim).to.equal(384n);
      expect(embModel).to.equal("all-MiniLM-L6-v2");
    });

    it("Should track total memory count", async function () {
      await ledger.connect(agent1).commitMemory("cid1", "", "0x00", true, 384, "model1");
      await ledger.connect(agent2).commitMemory("cid2", "", "0x00", false, 768, "model2");
      expect(await ledger.totalMemoryCount()).to.equal(2n);
    });

    it("Should track owner memories by index", async function () {
      await ledger.connect(agent1).commitMemory("cid1", "", "0x00", true, 384, "model1");
      await ledger.connect(agent1).commitMemory("cid2", "cid1", "0x00", true, 384, "model1");
      expect(await ledger.getOwnerMemoryCount(agent1.address)).to.equal(2n);
      expect(await ledger.getOwnerMemoryAtIndex(agent1.address, 0)).to.equal("cid1");
      expect(await ledger.getOwnerMemoryAtIndex(agent1.address, 1)).to.equal("cid2");
    });
  });

  describe("ReputationManager (Bayesian EigenTrust)", function () {
    beforeEach(async function () {
      await identity.connect(agent1).registerAgent("pubKey1");
      await identity.connect(agent2).registerAgent("pubKey2");
      await identity.connect(agent3).registerAgent("pubKey3");
    });

    it("Should increase global reputation on endorsement", async function () {
      await reputation.connect(agent2).endorseAgent(agent1.address, "Good memory quality");
      const rep = await reputation.globalReputation(agent1.address);
      expect(rep).to.be.gt(0n);
    });

    it("Should mark agent as trusted after endorsements", async function () {
      await reputation.connect(agent2).endorseAgent(agent1.address, "Accurate context");
      expect(await reputation.isTrusted(agent1.address)).to.equal(true);
    });

    it("Should reduce reputation on report (asymmetric penalty)", async function () {
      await reputation.connect(agent2).endorseAgent(agent1.address, "Good");
      await reputation.connect(agent3).endorseAgent(agent1.address, "Good");
      const repBefore = await reputation.globalReputation(agent1.address);

      await reputation.connect(agent2).reportAgent(agent1.address, "Memory poisoning detected");
      const repAfter = await reputation.globalReputation(agent1.address);

      expect(repAfter).to.be.lt(repBefore);
    });

    it("Should prevent self-endorsement", async function () {
      await expect(reputation.connect(agent1).endorseAgent(agent1.address, "Self"))
        .to.be.revertedWith("Cannot endorse yourself");
    });

    it("Should log trust events", async function () {
      await reputation.connect(agent2).endorseAgent(agent1.address, "Good");
      await reputation.connect(agent3).reportAgent(agent1.address, "Bad");
      expect(await reputation.getTrustLogLength()).to.equal(2n);
    });
  });
});
