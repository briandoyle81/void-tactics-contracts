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
    it("with EIP-2935, reveals past 256 blocks with the same result; an unrecorded block still expires", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await installHistoryContract();
      await randomManager.write.requestRandomness(); // id 1
      await randomManager.write.requestRandomness(); // id 2: left to expire
      const { blockNumber: block1 } = await getResult(randomManager, 1n);
      const { blockNumber: block2 } = await getResult(randomManager, 2n);
      await recordBlockHash(block2);
      // Only block2's hash is recorded (on a real chain every block's is),
      // so id 1 shows what happens when the history can't serve a block.
      expect(block2).to.equal(block1 + 1n);

      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // 300 blocks
      expect(await randomManager.read.isExpired([2n])).to.equal(false);
      expect(await randomManager.read.canFulfill([2n])).to.equal(true);
      await randomManager.write.fulfillRandomRequest([2n]);
      expect((await getResult(randomManager, 2n)).result).to.equal(
        await expectedResult(block2, 2n),
      );

      // id 1's block hash was never recorded: unreadable past 256, so expired.
      expect(await randomManager.read.isExpired([1n])).to.equal(true);
      await expect(
        randomManager.write.fulfillRandomRequest([1n]),
      ).to.be.rejectedWith("RequestExpired");
    });

    it("with EIP-2935, a request still expires once it's more than 8191 blocks old", async function () {
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

      // The owner re-target still recovers it.
      await randomManager.write.retargetExpired([[1n]]);
      await hre.network.provider.send("evm_mine");
      await randomManager.write.fulfillRandomRequest([1n]);
      expect((await getResult(randomManager, 1n)).revealed).to.equal(true);
    });

    it("lets only the owner re-target expired requests, skipping revealed and still-valid ones", async function () {
      const { randomManager } = await loadFixture(deployFixture);
      await randomManager.write.requestRandomness(); // id 1: will expire
      await randomManager.write.requestRandomness(); // id 2: will be revealed
      await hre.network.provider.send("evm_mine");
      await randomManager.write.revealRandomness([2n]);
      const revealed2 = await getResult(randomManager, 2n);
      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // 300 blocks
      await randomManager.write.requestRandomness(); // id 3: still valid
      const before3 = await getResult(randomManager, 3n);

      const [, stranger] = await hre.viem.getWalletClients();
      const asStranger = await hre.viem.getContractAt(
        "RandomManager",
        randomManager.address,
        { client: { wallet: stranger } },
      );
      await expect(
        asStranger.write.retargetExpired([[1n]]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");

      await randomManager.write.retargetExpired([[1n, 2n, 3n, 999n]]);
      const after1 = await getResult(randomManager, 1n);
      expect(await randomManager.read.isExpired([1n])).to.equal(false);
      expect(await getResult(randomManager, 2n)).to.deep.equal(revealed2);
      expect((await getResult(randomManager, 3n)).blockNumber).to.equal(
        before3.blockNumber,
      );

      // The re-targeted request now resolves from its new block's hash.
      await randomManager.write.fulfillRandomRequest([1n]);
      expect((await getResult(randomManager, 1n)).result).to.equal(
        await expectedResult(after1.blockNumber, 1n),
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
