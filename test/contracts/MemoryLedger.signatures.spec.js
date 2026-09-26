import { expect } from 'chai';
import hre from 'hardhat';

import {
  DOMAIN_VERSION,
  LEDGER_DOMAIN_NAME,
  MAX_SIGNATURE_VALIDITY,
  MEMORY_COMMIT_TYPE_STRING,
  MEMORY_REVOCATION_TYPE_STRING,
  cid,
  deadline,
  field,
  validPubKey,
} from './helpers/constants.js';
import {
  input,
  loadFixture,
  registeredFixture,
  time,
  commitWithPrecommit,
} from './helpers/fixtures.js';
import {
  MemoryCommitTypes,
  ZERO_SIGNATURE,
  digestOf,
  flipByte,
  ledgerDomain,
  memoryCommitDigest,
  memoryCommitValue,
  signMemoryCommit,
  signMemoryRevocation,
  toMalleable,
} from './helpers/eip712.js';

const { ethers } = hre;

/**
 * The security heart of the Solidity lane.
 *
 * The contract this suite replaced declared `bytes signature` and never read it: ownership came from
 * `msg.sender`, so the "cryptographic proof of memory" proved only that somebody sent a transaction.
 * Every case below exists to prove that the EIP-712 authorisation now genuinely binds the agent, the
 * CID, the embedding metadata, the deployment and the chain.
 */
describe('MemoryLedger - EIP-712 provenance', function () {
  let ctx;

  beforeEach(async function () {
    ctx = await loadFixture(registeredFixture);
  });

  /* ====================================================================== */
  describe('digest agreement', function () {
    it('hashCommit equals an independently computed TypedDataEncoder digest', async function () {
      const { ledger, agentA, chainId, ledgerAddr } = ctx;
      const inp = input(cid(1));
      const nonce = await ledger.nonces(agentA.address);
      const dl = await deadline();

      const onChain = await ledger.hashCommit(agentA.address, inp, nonce, dl);
      const offChain = digestOf(
        ledgerDomain(chainId, ledgerAddr),
        MemoryCommitTypes,
        memoryCommitValue({ agent: agentA.address, input: inp, nonce, deadline: dl }),
      );
      expect(onChain).to.equal(offChain);
    });

    it('both typehashes equal keccak of the exact canonical type strings', async function () {
      const { ledger } = ctx;
      expect(await ledger.MEMORY_COMMIT_TYPEHASH()).to.equal(ethers.id(MEMORY_COMMIT_TYPE_STRING));
      expect(await ledger.MEMORY_REVOCATION_TYPEHASH()).to.equal(
        ethers.id(MEMORY_REVOCATION_TYPE_STRING),
      );
    });

    it('publishes the documented EIP-712 domain', async function () {
      const { ledger, chainId, ledgerAddr } = ctx;
      const d = await ledger.eip712Domain();
      expect(d.name).to.equal(LEDGER_DOMAIN_NAME);
      expect(d.version).to.equal(DOMAIN_VERSION);
      expect(d.chainId).to.equal(chainId);
      expect(d.verifyingContract).to.equal(ledgerAddr);
    });
  });

  /* ====================================================================== */
  describe('commitMemoryFor - happy path', function () {
    it('attributes the record to the signer while the relayer pays', async function () {
      const { ledger, agentA, relayer } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });

      expect(await ledger.nonces(agentA.address)).to.equal(0n);
      const tx = await ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature);
      const ts = await time.latest();

      await expect(tx)
        .to.emit(ledger, 'MemoryCommitted')
        .withArgs(
          agentA.address,
          ethers.id(inp.cid),
          ethers.ZeroHash,
          inp.cid,
          inp.model,
          inp.embeddingDim,
          inp.isEncrypted,
          1,
          relayer.address,
          ts,
        );

      const m = await ledger.getMemory(ethers.id(inp.cid));
      expect(m.owner).to.equal(agentA.address);
      expect(m.committedBy).to.equal(relayer.address);
      expect(await ledger.nonces(agentA.address)).to.equal(1n);
      // The `owner` topic - the one an indexer filters on - is the agent, never the relayer.
      const logs = await ledger.queryFilter(ledger.filters.MemoryCommitted(agentA.address));
      expect(logs.length).to.equal(1);
    });
  });

  /* ====================================================================== */
  describe('forgery is rejected', function () {
    /** Signs a commit for agentA and returns everything a forgery case needs to mutate. */
    async function authorised(overrides = {}) {
      const { ledger, agentA } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
        ...overrides,
      });
      return { inp, dl, signature };
    }

    async function expectInvalid(promise, signer) {
      const assertion = expect(promise).to.be.revertedWithCustomError(ctx.errs, 'InvalidSignature');
      return signer ? assertion.withArgs(signer) : assertion;
    }

    it("rejects the relayer signing on the agent's behalf", async function () {
      const { ledger, agentA, relayer } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(relayer, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
        agentA.address,
      );
    });

    it('rejects another registered agent signing', async function () {
      const { ledger, agentA, agentB, relayer } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentB, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
        agentA.address,
      );
    });

    it('rejects a substituted CID - the digest binds the content identifier', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { dl, signature } = await authorised();
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, input(cid(999)), dl, signature),
        agentA.address,
      );
    });

    it('rejects a tampered embeddingDim', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      const tampered = { ...inp, embeddingDim: 768 };
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, tampered, dl, signature),
      );
    });

    it('rejects a tampered isEncrypted flag', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      const tampered = { ...inp, isEncrypted: false };
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, tampered, dl, signature),
      );
    });

    it('rejects a tampered model identifier', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      const tampered = { ...inp, model: 'hf:evil/model@sha256:0000' };
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, tampered, dl, signature),
      );
    });

    it('rejects a tampered prevCidHash', async function () {
      const { ledger, agentA, relayer } = ctx;
      await commitWithPrecommit(ledger, agentA, input(cid(500)));
      const { inp, dl, signature } = await authorised();
      const tampered = { ...inp, prevCidHash: ethers.id(cid(500)) };
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, tampered, dl, signature),
      );
    });

    it('rejects a signature bound to a different deployment of the same contract', async function () {
      const { ledger, identityAddr, admin, agentA, relayer, chainId } = ctx;
      const ledger2 = await (
        await ethers.getContractFactory('MemoryLedger')
      ).deploy(admin.address, identityAddr);
      await ledger2.waitForDeployment();

      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
        domainOverride: ledgerDomain(chainId, await ledger2.getAddress()),
      });
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
        agentA.address,
      );
    });

    it('rejects a signature bound to a different chainId', async function () {
      const { ledger, ledgerAddr, chainId, agentA, relayer } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
        domainOverride: ledgerDomain(chainId + 1n, ledgerAddr),
      });
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
        agentA.address,
      );
    });

    it('rejects an all-zero 65-byte signature (no ecrecover-zero-address pass)', async function () {
      const { ledger, agentA, relayer } = ctx;
      const dl = await deadline();
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, input(cid(1)), dl, ZERO_SIGNATURE),
        agentA.address,
      );
    });

    it('rejects the malleable upper-half-order twin of a valid signature', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      // Same message, same signer, different bytes: OZ's ECDSA guard must refuse it.
      await expectInvalid(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, toMalleable(signature)),
        agentA.address,
      );
    });

    it('rejects 64-byte and 66-byte signature blobs', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      const short = ethers.dataSlice(signature, 0, 64);
      const long = ethers.concat([signature, '0x00']);
      await expectInvalid(ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, short));
      await expectInvalid(ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, long));
    });

    it('rejects 100 single-byte mutations of a valid signature without moving any counter', async function () {
      const { ledger, agentA, relayer } = ctx;
      const { inp, dl, signature } = await authorised();
      for (let i = 0; i < 100; i++) {
        await expect(
          ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, flipByte(signature, i)),
        ).to.be.reverted;
      }
      expect(await ledger.totalMemoryCount()).to.equal(0n);
      expect(await ledger.nonces(agentA.address)).to.equal(0n);
    });
  });

  /* ====================================================================== */
  describe('replay and nonces', function () {
    it('rejects the second submission of an identical (signature, input) pair', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const inp = input(cid(1));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });

      await ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature);
      // `_useNonce` already advanced, so the replayed payload now hashes to a DIFFERENT digest and
      // fails signature recovery before it ever reaches the duplicate-CID check.
      await expect(ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature))
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(agentA.address);
      expect(await ledger.totalMemoryCount()).to.equal(1n);
    });

    it('accepts nonces 0 and 1 in order and refuses them out of order', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const dl = await deadline();
      const a = input(cid(10));
      const b = input(cid(11));
      const { signature: sig0 } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: a,
        deadline: dl,
        nonce: 0n,
      });
      const { signature: sig1 } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: b,
        deadline: dl,
        nonce: 1n,
      });

      // Out of order first: nonce 1 while the contract expects 0.
      await expect(
        ledger.connect(relayer).commitMemoryFor(agentA.address, b, dl, sig1),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');

      await ledger.connect(relayer).commitMemoryFor(agentA.address, a, dl, sig0);
      await ledger.connect(relayer).commitMemoryFor(agentA.address, b, dl, sig1);
      expect(await ledger.nonces(agentA.address)).to.equal(2n);
      expect(await ledger.totalMemoryCount()).to.equal(2n);
    });

    it('keeps per-agent nonces independent and never burns one on a failed call', async function () {
      const { ledger, agentA, agentB, relayer, errs } = ctx;
      const dl = await deadline();
      const inpA = input(cid(20));
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inpA,
        deadline: dl,
      });
      await ledger.connect(relayer).commitMemoryFor(agentA.address, inpA, dl, signature);

      expect(await ledger.nonces(agentA.address)).to.equal(1n);
      expect(await ledger.nonces(agentB.address)).to.equal(0n);

      // A rejected authorisation must leave the nonce exactly where it was, or a griefer could
      // desynchronise an agent's signing pipeline for free.
      await expect(
        ledger.connect(relayer).commitMemoryFor(agentB.address, input(cid(21)), dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
      expect(await ledger.nonces(agentB.address)).to.equal(0n);
      expect(await ledger.nonces(agentA.address)).to.equal(1n);
    });
  });

  /* ====================================================================== */
  describe('deadlines', function () {
    it('accepts a deadline equal to the block timestamp', async function () {
      const { ledger, agentA, relayer } = ctx;
      const inp = input(cid(30));
      const dl = (await time.latest()) + 60;
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      await time.setNextBlockTimestamp(dl);
      await ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature);
      expect((await ledger.getMemory(ethers.id(inp.cid))).committedAt).to.equal(dl);
    });

    it('rejects a deadline one second in the past', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const inp = input(cid(31));
      const dl = await time.latest();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      // The next block is mined at `dl + 1`, so the authorisation is already stale.
      await expect(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'SignatureExpired');
    });

    it('rejects a deadline beyond the 30-day validity window', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const inp = input(cid(32));
      const dl = (await time.latest()) + MAX_SIGNATURE_VALIDITY + 24 * 3600;
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      await expect(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'DeadlineTooFar');
    });

    it('expires an in-flight authorisation once time passes it', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const inp = input(cid(33));
      const dl = await deadline(1800);
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });
      await time.increase(3600);
      await expect(
        ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature),
      ).to.be.revertedWithCustomError(errs, 'SignatureExpired');
    });
  });

  /* ====================================================================== */
  describe('identity gating on the signed path', function () {
    it('refuses a valid signature from an agent that deactivated in the meantime', async function () {
      const { ledger, identity, agentA, relayer, errs } = ctx;
      const inp = input(cid(40));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: agentA.address,
        input: inp,
        deadline: dl,
      });

      await identity.connect(agentA).deactivate();
      await expect(ledger.connect(relayer).commitMemoryFor(agentA.address, inp, dl, signature))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(agentA.address);
    });

    it('refuses a never-registered agent even with a perfectly valid signature', async function () {
      const { ledger, outsider, relayer, errs } = ctx;
      const inp = input(cid(41));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(outsider, ledger, {
        agent: outsider.address,
        input: inp,
        deadline: dl,
      });
      await expect(ledger.connect(relayer).commitMemoryFor(outsider.address, inp, dl, signature))
        .to.be.revertedWithCustomError(errs, 'AgentInactive')
        .withArgs(outsider.address);
    });
  });

  /* ====================================================================== */
  describe('ERC-1271 agent wallets', function () {
    it('lets a smart-contract wallet own a memory, and follows its owner', async function () {
      const { ledger, identity, agentA, agentB, relayer, errs } = ctx;
      const wallet = await (
        await ethers.getContractFactory('ERC1271Wallet')
      ).deploy(agentA.address);
      await wallet.waitForDeployment();
      const walletAddr = await wallet.getAddress();
      await wallet.callRegister(await identity.getAddress(), validPubKey('w'), '');

      const inp = input(cid(50));
      const dl = await deadline();
      const { signature } = await signMemoryCommit(agentA, ledger, {
        agent: walletAddr,
        input: inp,
        deadline: dl,
      });
      await ledger.connect(relayer).commitMemoryFor(walletAddr, inp, dl, signature);
      expect((await ledger.getMemory(ethers.id(inp.cid))).owner).to.equal(walletAddr);

      // Rotate the wallet's authorised signer: the old owner can no longer act for it.
      await wallet.setOwner(agentB.address);
      const inp2 = input(cid(51));
      const dl2 = await deadline();
      const { signature: sig2 } = await signMemoryCommit(agentA, ledger, {
        agent: walletAddr,
        input: inp2,
        deadline: dl2,
      });
      await expect(ledger.connect(relayer).commitMemoryFor(walletAddr, inp2, dl2, sig2))
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(walletAddr);
    });
  });

  /* ====================================================================== */
  describe('revokeMemoryFor', function () {
    let h1;

    beforeEach(async function () {
      h1 = ethers.id(cid(60));
      await commitWithPrecommit(ctx.ledger, ctx.agentA, input(cid(60)));
    });

    it("revokes on the owner's authorisation, submitted by a relayer", async function () {
      const { ledger, agentA, relayer } = ctx;
      const dl = await deadline();
      const { signature } = await signMemoryRevocation(agentA, ledger, {
        agent: agentA.address,
        cidHash: h1,
        reason: field('gdpr'),
        deadline: dl,
      });
      const tx = await ledger
        .connect(relayer)
        .revokeMemoryFor(agentA.address, h1, field('gdpr'), dl, signature);
      const ts = await time.latest();
      await expect(tx)
        .to.emit(ledger, 'MemoryRevokedEvent')
        .withArgs(h1, agentA.address, relayer.address, field('gdpr'), ts);
      expect((await ledger.getMemory(h1)).revoked).to.equal(true);
      expect(await ledger.nonces(agentA.address)).to.equal(1n);
    });

    it('rejects a signature over a different cidHash', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const dl = await deadline();
      const { signature } = await signMemoryRevocation(agentA, ledger, {
        agent: agentA.address,
        cidHash: ethers.id('some-other-record'),
        reason: field('gdpr'),
        deadline: dl,
      });
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentA.address, h1, field('gdpr'), dl, signature),
      ).to.be.revertedWithCustomError(errs, 'InvalidSignature');
    });

    it('checks the signature BEFORE ownership', async function () {
      const { ledger, agentA, agentB, relayer, errs } = ctx;
      const dl = await deadline();

      // A perfectly valid signature from a non-owner gets past verification and is then refused on
      // ownership - which proves the ordering, and that a bad signature can never leak ownership info.
      const { signature: goodFromB } = await signMemoryRevocation(agentB, ledger, {
        agent: agentB.address,
        cidHash: h1,
        reason: field('x'),
        deadline: dl,
      });
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentB.address, h1, field('x'), dl, goodFromB),
      )
        .to.be.revertedWithCustomError(errs, 'NotMemoryOwner')
        .withArgs(h1, agentB.address, agentA.address);

      // A forged signature never reaches the ownership check.
      const { signature: forged } = await signMemoryRevocation(agentB, ledger, {
        agent: agentA.address,
        cidHash: h1,
        reason: field('x'),
        deadline: dl,
      });
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentA.address, h1, field('x'), dl, forged),
      )
        .to.be.revertedWithCustomError(errs, 'InvalidSignature')
        .withArgs(agentA.address);
    });

    it('rejects an expired deadline and an unknown record', async function () {
      const { ledger, agentA, relayer, errs } = ctx;
      const dl = await deadline(1800);
      const { signature } = await signMemoryRevocation(agentA, ledger, {
        agent: agentA.address,
        cidHash: h1,
        reason: field('x'),
        deadline: dl,
      });
      await time.increase(3600);
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentA.address, h1, field('x'), dl, signature),
      ).to.be.revertedWithCustomError(errs, 'SignatureExpired');

      const ghost = ethers.id('ghost');
      const dl2 = await deadline();
      const { signature: sig2 } = await signMemoryRevocation(agentA, ledger, {
        agent: agentA.address,
        cidHash: ghost,
        reason: field('x'),
        deadline: dl2,
      });
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentA.address, ghost, field('x'), dl2, sig2),
      )
        .to.be.revertedWithCustomError(errs, 'MemoryNotFound')
        .withArgs(ghost);
    });

    it('is blocked while paused', async function () {
      const { ledger, agentA, relayer, pauser, errs } = ctx;
      const dl = await deadline();
      const { signature } = await signMemoryRevocation(agentA, ledger, {
        agent: agentA.address,
        cidHash: h1,
        reason: field('x'),
        deadline: dl,
      });
      await ledger.connect(pauser).pause();
      await expect(
        ledger.connect(relayer).revokeMemoryFor(agentA.address, h1, field('x'), dl, signature),
      ).to.be.revertedWithCustomError(errs, 'EnforcedPause');
    });
  });

  /* ====================================================================== */
  describe('memoryCommitDigest helper agreement', function () {
    it('matches hashCommit for a chained record too', async function () {
      const { ledger, agentA } = ctx;
      await commitWithPrecommit(ledger, agentA, input(cid(70)));
      const child = input(cid(71), ethers.id(cid(70)), { embeddingDim: 768, isEncrypted: false });
      const nonce = await ledger.nonces(agentA.address);
      const dl = await deadline();
      expect(
        await memoryCommitDigest(ledger, {
          agent: agentA.address,
          input: child,
          nonce,
          deadline: dl,
        }),
      ).to.equal(await ledger.hashCommit(agentA.address, child, nonce, dl));
    });
  });
});
