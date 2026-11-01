import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { encodePacked, keccak256 } from "viem";
import { installHistoryContract, recordBlockHash } from "./fixtures/eip2935";

// Standalone tests — RandomManager has no constructor args and no
// dependencies, so this deploys just that contract directly.
describe("RandomManager", function () {
  async function deployFixture() {
    const randomManager = await hre.viem.deployContract("RandomManager", []);
    return { randomManager };
  }

  async function getResult(randomManager: any, id: bigint) {
    const request = await randomManager.read.requests([id]);
    // Request struct: (blockNumber, revealed, result)
    return {
      blockNumber: request[0] as bigint,
      revealed: request[1] as boolean,
      result: request[2] as bigint,
    };
  }

  it("fulfillRandomRequest reveals-and-locks on first call — no separate reveal transaction needed", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await hre.network.provider.send("evm_mine");

    expect(await randomManager.read.canFulfill([1n])).to.equal(true);

    await randomManager.write.fulfillRandomRequest([1n]);
    const { revealed, result } = await getResult(randomManager, 1n);
    expect(revealed).to.equal(true);
    expect(result).to.not.equal(0n);
  });

  it("fulfillRandomRequest is idempotent — a second call returns the same already-locked result", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await hre.network.provider.send("evm_mine");

    await randomManager.write.fulfillRandomRequest([1n]);
    const first = await getResult(randomManager, 1n);

    // Mine more blocks — must NOT change the result.
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await randomManager.write.fulfillRandomRequest([1n]);
    const second = await getResult(randomManager, 1n);

    expect(second.result).to.equal(first.result);
  });

  // Expected result: low 64 bits of keccak256(blockhash(target), id).
  async function expectedResult(blockNumber: bigint, id: bigint) {
    const publicClient = await hre.viem.getPublicClient();
    const { hash } = await publicClient.getBlock({ blockNumber });
    const h = keccak256(encodePacked(["bytes32", "uint256"], [hash!, id]));
    return BigInt(h) & ((1n << 64n) - 1n);
  }

  describe("block-hash randomness (HA6-19)", function () {
    it("derives the result from the request block's hash, however late and by whomever it's revealed", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await randomManager.write.requestRandomness(); // id 1
      const { blockNumber } = await getResult(randomManager, 1n);

      // Reveal much later (but inside the window) from a different account.
      await hre.network.provider.send("hardhat_mine", ["0x64"]); // 100 blocks
      const [, stranger] = await hre.viem.getWalletClients();
      const asStranger = await hre.viem.getContractAt(
        "RandomManager",
        randomManager.address,
        { client: { wallet: stranger } },
      );
      await asStranger.write.revealRandomness([1n]);

      expect((await getResult(randomManager, 1n)).result).to.equal(
        await expectedResult(blockNumber, 1n),
      );
    });

    it("gives ships requested in the same block independent results", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await hre.network.provider.send("evm_setAutomine", [false]);
      try {
        await randomManager.write.requestRandomness({ gas: 200_000n });
        await randomManager.write.requestRandomness({ gas: 200_000n });
        await hre.network.provider.send("evm_mine");
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true]);
      }
      const a = await getResult(randomManager, 1n);
      const b = await getResult(randomManager, 2n);
      expect(a.blockNumber).to.equal(b.blockNumber);
      await randomManager.write.revealRandomnessBatch([[1n, 2n]]);
      expect((await getResult(randomManager, 1n)).result).to.not.equal(
        (await getResult(randomManager, 2n)).result,
      );
    });

    it("reverts TooSoonToReveal in the request's own block", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      const publicClient = await hre.viem.getPublicClient();
      await hre.network.provider.send("evm_setAutomine", [false]);
      let revealTx: `0x${string}`;
      try {
        await randomManager.write.requestRandomness({ gas: 200_000n });
        revealTx = await randomManager.write.revealRandomness([1n], {
          gas: 200_000n,
        });
        await hre.network.provider.send("evm_mine");
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true]);
      }
      const receipt = await publicClient.getTransactionReceipt({
        hash: revealTx!,
      });
      expect(receipt.status).to.equal("reverted");
      expect((await getResult(randomManager, 1n)).revealed).to.equal(false);
    });

    it("expires after the 256-block window: RequestExpired, isExpired true, canFulfill false", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await randomManager.write.requestRandomness(); // id 1
      // At exactly +256 blocks the hash is still available.
      await hre.network.provider.send("hardhat_mine", ["0xff"]); // 255; next tx block is +256
      expect(await randomManager.read.canFulfill([1n])).to.equal(true);

      await hre.network.provider.send("hardhat_mine", ["0x2"]);
      expect(await randomManager.read.isExpired([1n])).to.equal(true);
      expect(await randomManager.read.canFulfill([1n])).to.equal(false);
      await expect(
        randomManager.write.fulfillRandomRequest([1n]),
      ).to.be.rejectedWith("RequestExpired");
    });

    // 2026-10-16: with a working EIP-2935 history contract (as on Base) the
    // window is 8191 blocks instead of 256 (BlockHashLib).
    it("with EIP-2935, reveals past 256 blocks with the same result, and a block captured by a later request outlives the history too", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await installHistoryContract();
      await randomManager.write.requestRandomness(); // id 1
      const { blockNumber: block1 } = await getResult(randomManager, 1n);
      await hre.network.provider.send("evm_mine");
      // id 2's request stores block1's hash (sealed, still readable).
      await randomManager.write.requestRandomness(); // id 2
      const { blockNumber: block2 } = await getResult(randomManager, 2n);
      // Only block2's hash is recorded in the history contract (on a real
      // chain every block's is): block1 can only be served from blockSeed.
      await recordBlockHash(block2);
      expect(await randomManager.read.blockSeed([block1])).to.not.equal(
        `0x${"0".repeat(64)}`,
      );
      expect(block2).to.equal(block1 + 2n);

      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // 300 blocks
      expect(await randomManager.read.isExpired([2n])).to.equal(false);
      expect(await randomManager.read.canFulfill([2n])).to.equal(true);
      await randomManager.write.fulfillRandomRequest([2n]);
      expect((await getResult(randomManager, 2n)).result).to.equal(
        await expectedResult(block2, 2n),
      );
      // id 1 was captured by id 2's request, so it isn't expired either.
      await randomManager.write.fulfillRandomRequest([1n]);
      expect((await getResult(randomManager, 1n)).result).to.equal(
        await expectedResult(block1, 1n),
      );
    });

    it("with EIP-2935, an uncaptured request expires once it's more than 8191 blocks old, for good", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await installHistoryContract();
      await randomManager.write.requestRandomness(); // id 1
      const { blockNumber } = await getResult(randomManager, 1n);
      await recordBlockHash(blockNumber);

      await hre.network.provider.send("hardhat_mine", ["0x1f00"]); // 7936 blocks
      expect(await randomManager.read.canFulfill([1n])).to.equal(true);
      await hre.network.provider.send("hardhat_mine", ["0x200"]); // past 8191
      expect(await randomManager.read.isExpired([1n])).to.equal(true);
      expect(await randomManager.read.canFulfill([1n])).to.equal(false);
      await expect(
        randomManager.write.fulfillRandomRequest([1n]),
      ).to.be.rejectedWith("RequestExpired");
      // A later capture can't revive it.
      await randomManager.write.capturePending([5n]);
      expect(await randomManager.read.isExpired([1n])).to.equal(true);
    });
  });

  // docs/trustless-randomness-plan-2026-11-01.md (audit-4 HA7-10): nothing
  // can re-roll a request, and ordinary calls store pending block hashes
  // before they age out.
  describe("capture instead of re-roll (HA7-10)", function () {
    it("has no owner and no re-target", async function () {
      const artifact = await hre.artifacts.readArtifact("RandomManager");
      const names = artifact.abi.map((e: any) => e.name);
      expect(names).to.not.include("retargetExpired");
      expect(names).to.not.include("owner");
    });

    it("a later request in another block captures an earlier one, which then outlives the window on its original roll", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await randomManager.write.requestRandomness(); // id 1
      const { blockNumber } = await getResult(randomManager, 1n);
      await randomManager.write.requestRandomness(); // id 2, next block: captures id 1's block
      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // past 256

      expect(await randomManager.read.isExpired([1n])).to.equal(false);
      await randomManager.write.fulfillRandomRequest([1n]);
      expect((await getResult(randomManager, 1n)).result).to.equal(
        await expectedResult(blockNumber, 1n),
      );
    });

    it("capturePending is permissionless, walks at most maxBlocks, stops at the current block and skips aged-out blocks", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await randomManager.write.requestRandomness(); // id 1, block A
      const a = (await getResult(randomManager, 1n)).blockNumber;
      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // A ages out
      await randomManager.write.capturePending([0n]); // walks nothing
      await randomManager.write.requestRandomness(); // id 2: captures (skips) A
      expect(await randomManager.read.isExpired([1n])).to.equal(true);
      expect(await randomManager.read.blockSeed([a])).to.equal(`0x${"0".repeat(64)}`);

      // Three more blocks with requests, none captured yet past id 2's own.
      const [, stranger] = await hre.viem.getWalletClients();
      const asStranger = await hre.viem.getContractAt(
        "RandomManager",
        randomManager.address,
        { client: { wallet: stranger } },
      );
      await hre.network.provider.send("evm_setAutomine", [false]);
      try {
        await randomManager.write.requestRandomness({ gas: 300_000n }); // id 3
        await randomManager.write.requestRandomness({ gas: 300_000n }); // id 4, same block
        await hre.network.provider.send("evm_mine");
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true]);
      }
      // Queue: A (skipped), id 2's block (captured by id 3's request), id
      // 3/4's block (queued once; id 4 couldn't capture its own block).
      expect(await randomManager.read.pendingHead()).to.equal(2n);
      expect(await randomManager.read.hasPendingCapture()).to.equal(true);
      await asStranger.write.capturePending([0n]); // walks nothing
      expect(await randomManager.read.pendingHead()).to.equal(2n);
      await asStranger.write.capturePending([5n]); // only one left
      expect(await randomManager.read.pendingHead()).to.equal(3n);
      expect(await randomManager.read.hasPendingCapture()).to.equal(false);
      const b34 = (await getResult(randomManager, 3n)).blockNumber;
      expect((await getResult(randomManager, 4n)).blockNumber).to.equal(b34);
      expect(await randomManager.read.blockSeed([b34])).to.not.equal(
        `0x${"0".repeat(64)}`,
      );
    });
  });

  it("fulfillRandomRequest reverts RequestNotFound for an invalid id", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await expect(
      randomManager.write.fulfillRandomRequest([999n]),
    ).to.be.rejectedWith("RequestNotFound");
  });

  it("canFulfillBatch is false if any id in the batch isn't ready, true once all are", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await randomManager.write.requestRandomness(); // id 2
    expect(await randomManager.read.canFulfillBatch([[1n, 2n]])).to.equal(
      false,
    );

    await hre.network.provider.send("evm_mine");
    expect(await randomManager.read.canFulfillBatch([[1n, 2n]])).to.equal(
      true,
    );
  });

  it("revealRandomness (optional pre-warming) locks in the same way fulfillRandomRequest would", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await hre.network.provider.send("evm_mine");

    await randomManager.write.revealRandomness([1n]);
    const { revealed, result } = await getResult(randomManager, 1n);
    expect(revealed).to.equal(true);

    // fulfillRandomRequest afterward just returns the same locked value.
    await randomManager.write.fulfillRandomRequest([1n]);
    const after = await getResult(randomManager, 1n);
    expect(after.result).to.equal(result);
  });

  it("revealRandomness reverts RequestNotFound for an invalid id (regression: this check was dropped when reveal was folded into fulfillRandomRequest)", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await expect(
      randomManager.write.revealRandomness([999n]),
    ).to.be.rejectedWith("RequestNotFound");
    await expect(
      randomManager.write.revealRandomness([0n]),
    ).to.be.rejectedWith("RequestNotFound");
  });

  it("reveals a batch in one call, matching individual reveals", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    const requestIds: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      await randomManager.write.requestRandomness();
      requestIds.push(BigInt(i + 1));
    }

    // The last request's block is the current chain head — mine one more
    // so its hash exists, matching production where reveal always happens
    // in a later block than the mint.
    await hre.network.provider.send("evm_mine");

    expect(await randomManager.read.canRevealBatch([requestIds])).to.equal(
      true,
    );

    await randomManager.write.revealRandomnessBatch([requestIds]);

    for (const id of requestIds) {
      const { revealed, result } = await getResult(randomManager, id);
      expect(revealed).to.equal(true);
      expect(result).to.not.equal(0n);
    }
  });

  it("canRevealBatch tolerates an already-revealed id (only checks readiness of the rest)", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await randomManager.write.requestRandomness(); // id 2
    await hre.network.provider.send("evm_mine");
    await randomManager.write.revealRandomnessBatch([[1n]]); // reveal id 1 only

    // id 1 is already revealed (tolerated, not a failure condition); id 2
    // is still unrevealed but ready — the batch as a whole is callable.
    expect(await randomManager.read.canRevealBatch([[1n, 2n]])).to.equal(
      true,
    );
  });

  it("revealRandomnessBatch reverts the whole batch on a genuinely invalid id", async function () {
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1

    await expect(
      randomManager.write.revealRandomnessBatch([[1n, 999n]]),
    ).to.be.rejectedWith("RequestNotFound");
  });

  it("revealRandomnessBatch tolerates (skips) an id someone else already revealed, instead of reverting the whole batch", async function () {
    // Regression test for a griefing vector: revealRandomness/
    // revealRandomnessBatch are deliberately permissionless, so a hostile
    // third party can watch for a pending mint and front-run a single id
    // out of the victim's batch with their own revealRandomness call, for
    // the cost of gas only. If the batch reverted on any already-revealed
    // id, that would let an attacker force any player back to one-at-a-time
    // reveals for free. It must not revert — the already-done id should
    // just be skipped, with its already-locked-in result returned.
    const { randomManager } = await loadFixture(deployFixture);

    await randomManager.write.requestRandomness(); // id 1
    await randomManager.write.requestRandomness(); // id 2
    await hre.network.provider.send("evm_mine");

    // A hostile outside actor (not the "victim" submitting the batch)
    // reveals id 1 first, purely to try to break the victim's batch call.
    await randomManager.write.revealRandomness([1n]);
    const griefedResult = (await getResult(randomManager, 1n)).result;

    // The victim's batch call must not revert just because id 1 was
    // already revealed by someone else.
    await randomManager.write.revealRandomnessBatch([[1n, 2n]]);

    // id 1's result is unchanged (the griefer's reveal, not overwritten),
    // and id 2 got freshly revealed by the victim's batch call.
    expect((await getResult(randomManager, 1n)).result).to.equal(
      griefedResult,
    );
    expect((await getResult(randomManager, 2n)).result).to.not.equal(0n);
  });
});
