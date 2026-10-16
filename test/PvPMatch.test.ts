import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import { ShipTuple, tupleToShip } from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";

// Same starting-position convention as test/Game.test.ts's own helper.
function generateStartingPositions(shipIds: bigint[], isCreator: boolean) {
  return shipIds.map((_, i) =>
    isCreator
      ? { row: i % 11, col: i % 4 }
      : { row: Math.max(0, 10 - (i % 11)), col: 13 + (i % 4) },
  );
}

// docs/audit-3.md HA6-27: win effects are PvE-only. PvPMatch has no win-
// effect list at all (two wallets one person controls could farm it).
describe("PvPMatch win effects", function () {
  it("has no win effects (PvE-only, HA6-27)", async function () {
    const artifact = await hre.artifacts.readArtifact("PvPMatch");
    const names = artifact.abi.map((i: any) => i.name);
    expect(names).to.not.include("setWinEffects");
    expect(names).to.not.include("getWinEffects");
  });
});

// UA-02 (docs/upgrade-safety-audit-2026-09-29.md): game/gameResults must be
// permanently locked once this orchestrator has started its first game —
// repointing either while a game it started is still active strands that
// game forever (Game._endGame's uncaught callback into onGameEnded reverts
// on the mismatch). Own describe block, same fixture pattern as the
// win-effects suite above (kept separate to avoid touching that fixture).
describe("PvPMatch engine-live guard (UA-02)", function () {
  async function deployFixture() {
    const [owner, creator, joiner] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: creator } },
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: joiner } },
    );

    return { owner, creator, joiner, deployed, creatorLobbies, joinerLobbies };
  }

  it("rejects setGameAddress/setGameResultsAddress once this orchestrator has started its first game", async function () {
    const { owner, creator, joiner, deployed, creatorLobbies, joinerLobbies } =
      await loadFixture(deployFixture);
    const { pvpMatch, game, gameResults, ships, randomManager } = deployed;

    // Sanity: still callable before any game exists — the normal
    // deploy-time wiring case.
    await expect(
      pvpMatch.write.setGameAddress([game.address], {
        account: owner.account,
      }),
    ).to.not.be.rejected;
    await expect(
      pvpMatch.write.setGameResultsAddress([gameResults.address], {
        account: owner.account,
      }),
    ).to.not.be.rejected;

    // Start a real game through this orchestrator.
    await ships.write.purchaseWithFlow(
      [creator.account.address, 0n, joiner.account.address, 1],
      { value: parseEther("4.99") },
    );
    await ships.write.purchaseWithFlow(
      [joiner.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 10; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creator.account });
    await ships.write.constructAllMyShips({ account: joiner.account });

    await creatorLobbies.write.createLobby([
      1000n,
      300n,
      true,
      0n,
      100n,
      zeroAddress,
    ]);
    await joinerLobbies.write.joinLobby([1n]);
    await creatorLobbies.write.createFleet([
      1n,
      [1n],
      generateStartingPositions([1n], true),
    ]);
    await joinerLobbies.write.createFleet([
      1n,
      [6n],
      generateStartingPositions([6n], false),
    ]);

    // Now that gamesStarted > 0, both setters must be permanently locked —
    // repointing either would strand this now-active game.
    await expect(
      pvpMatch.write.setGameAddress([game.address], {
        account: owner.account,
      }),
    ).to.be.rejectedWith("EngineAlreadyLive");
    await expect(
      pvpMatch.write.setGameResultsAddress([gameResults.address], {
        account: owner.account,
      }),
    ).to.be.rejectedWith("EngineAlreadyLive");
  });
});

// UA-03 (docs/upgrade-safety-audit-2026-09-29.md): revoking this
// PvPMatch's GameResults.isAllowedRecorder authorization while it has
// in-flight games must not brick the whole game-ending transaction.
describe("PvPMatch fault-tolerant result recording (UA-03)", function () {
  async function deployFixture() {
    const [owner, creator, joiner] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: creator } },
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: joiner } },
    );
    const creatorPvpMatch = await hre.viem.getContractAt(
      "PvPMatch",
      deployed.pvpMatch.address,
      { client: { wallet: creator } },
    );

    return {
      owner,
      creator,
      joiner,
      deployed,
      creatorLobbies,
      joinerLobbies,
      creatorPvpMatch,
    };
  }

  it("still ends the game cleanly (and emits GameResultRecordFailed) if isAllowedRecorder is revoked while a game is active", async function () {
    const { owner, creator, joiner, deployed, creatorLobbies, joinerLobbies, creatorPvpMatch } =
      await loadFixture(deployFixture);
    const { ships, randomManager, game, gameResults, pvpMatch } = deployed;

    await ships.write.purchaseWithFlow(
      [creator.account.address, 0n, joiner.account.address, 1],
      { value: parseEther("4.99") },
    );
    await ships.write.purchaseWithFlow(
      [joiner.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 10; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creator.account });
    await ships.write.constructAllMyShips({ account: joiner.account });

    await creatorLobbies.write.createLobby([
      1000n,
      300n,
      true,
      0n,
      100n,
      zeroAddress,
    ]);
    const gameId = 1n;
    await joinerLobbies.write.joinLobby([gameId]);
    await creatorLobbies.write.createFleet([
      gameId,
      [1n],
      generateStartingPositions([1n], true),
    ]);
    await joinerLobbies.write.createFleet([
      gameId,
      [6n],
      generateStartingPositions([6n], false),
    ]);

    // Simulate a live-ops "retire this engine's recorder" action while the
    // game above is still active — the exact UA-03 scenario.
    await gameResults.write.setIsAllowedRecorder(
      [pvpMatch.address, false],
      { account: owner.account },
    );

    // Fleeing must still succeed — the game ends cleanly on Game.sol's own
    // side even though the leaderboard write fails.
    const publicClient = await hre.viem.getPublicClient();
    let fleeHash: `0x${string}`;
    await expect(
      (async () => {
        fleeHash = await creatorPvpMatch.write.flee([gameId]);
      })(),
    ).to.not.be.rejected;
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: fleeHash!,
    });

    const gameAfter = await game.read.getGame([gameId]);
    expect(gameAfter.metadata.ended).to.be.true;
    expect(gameAfter.metadata.winner.toLowerCase()).to.equal(
      joiner.account.address.toLowerCase(),
    );

    // The leaderboard write itself genuinely failed (not silently skipped
    // without a trace) and was never recorded.
    const events = await pvpMatch.getEvents.GameResultRecordFailed(
      undefined,
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
    );
    expect(events).to.have.length(1);
    expect(await gameResults.read.isGameResultRecorded([gameId])).to.be
      .false;
  });
});
