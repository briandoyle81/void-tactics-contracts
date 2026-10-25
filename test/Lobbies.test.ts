import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress, getAddress } from "viem";
import {
  LobbyStatus,
  PlayerLobbyState,
  ShipTuple,
  tupleToShip,
  ActionType,
  MapMode,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";

// Helper function to generate starting positions
function generateStartingPositions(shipIds: bigint[], isCreator: boolean) {
  const positions = [];
  for (let i = 0; i < shipIds.length; i++) {
    if (isCreator) {
      // Creator starts in top-left, each ship 1 down, in columns 0-3
      positions.push({ row: i, col: i % 4 }); // Use columns 0-3
    } else {
      // Joiner starts in bottom-right, each ship 1 up, in columns 13-16
      positions.push({ row: 10 - i, col: 13 + (i % 4) }); // Use columns 13-16
    }
  }
  return positions;
}

describe("Lobbies", function () {
  // Restore the original deployLobbiesFixture for basic tests
  async function deployLobbiesFixture() {
    const [owner, creator, joiner, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    // Deploy all contracts using the module
    const deployed = await hre.ignition.deploy(DeployModule);
    // Create separate contract instances for each user
    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: creator } }
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: joiner } }
    );
    const otherLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: other } }
    );
    // Create Fleets contract instances
    const creatorFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      { client: { wallet: creator } }
    );
    const joinerFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      { client: { wallet: joiner } }
    );
    return {
      lobbies: deployed.lobbies,
      creatorLobbies,
      joinerLobbies,
      otherLobbies,
      fleets: deployed.fleets,
      creatorFleets,
      joinerFleets,
      ships: deployed.ships,
      freeShipClaim: deployed.freeShipClaim,
      game: deployed.game,
      maps: deployed.maps,
      randomManager: deployed.randomManager,
      universalCredits: deployed.universalCredits,
      shipPurchaser: deployed.shipPurchaser,
      singlePlayerMatch: deployed.singlePlayerMatch,
      gameResults: deployed.gameResults,
      owner,
      creator,
      joiner,
      other,
      publicClient,
    };
  }

  // New fixture: sets up ships, lobby, and game for both players
  async function deployFullGameFixture() {
    const [owner, creator, joiner, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const deployed = await hre.ignition.deploy(DeployModule);

    // Contract instances
    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: creator } }
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: joiner } }
    );
    const creatorFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      { client: { wallet: creator } }
    );
    const joinerFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      { client: { wallet: joiner } }
    );
    const ships = deployed.ships;
    const randomManager = deployed.randomManager;
    const game = deployed.game;

    // Purchase and construct ships for both players
    await ships.write.purchaseWithFlow(
      [creator.account.address, 0n, joiner.account.address, 1],
      { value: parseEther("4.99") }
    );
    await ships.write.purchaseWithFlow(
      [joiner.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") }
    );
    // Fulfill random requests for all ships
    for (let i = 1; i <= 10; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;
      await randomManager.write.revealRandomness([serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creator.account });
    await ships.write.constructAllMyShips({ account: joiner.account });

    // Create lobby and join
    const costLimit = 1000n;
    const turnTime = 300n;
    const creatorGoesFirst = true;
    const tx = await creatorLobbies.write.createLobby([
      costLimit,
      turnTime,
      creatorGoesFirst,
      0n, // selectedMapId - no preset map,
      100n, // maxScore
      zeroAddress, // reservedJoiner - no reservation
    ]);
    await joinerLobbies.write.joinLobby([1n]);

    // Create fleets for both players
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

    return {
      lobbies: deployed.lobbies,
      creatorLobbies,
      joinerLobbies,
      creatorFleets,
      joinerFleets,
      ships,
      game,
      randomManager,
      owner,
      creator,
      joiner,
      publicClient,
      lobbyId: 1n,
      creatorFleetId: 1n,
      joinerFleetId: 1n, // assuming fleetId starts at 1 for both
      creatorShipId: 1n,
      joinerShipId: 6n,
    };
  }

  describe("Lobby Creation", function () {
    it("should create a lobby with correct initial values", async function () {
      const { creatorLobbies, creator, publicClient } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n; // 5 minutes
      const creatorGoesFirst = true;

      const tx = await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      expect(receipt.status).to.equal("success");

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.basic.id).to.equal(1n);
      expect(lobby.basic.creator.toLowerCase()).to.equal(
        creator.account.address.toLowerCase()
      );
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.basic.costLimit).to.equal(costLimit);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
      expect(lobby.gameConfig.turnTime).to.equal(turnTime);
      expect(lobby.gameConfig.creatorGoesFirst).to.equal(creatorGoesFirst);
      expect(lobby.players.creatorFleetId).to.equal(0n);
      expect(lobby.players.joinerFleetId).to.equal(0n);

      // Check player state
      const playerState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(playerState.activeLobbiesCount).to.equal(1n);
    });

    it("should revert when creating lobby with invalid turn time", async function () {
      const { creatorLobbies } = await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const invalidTurnTime = 30n; // Less than MIN_TURN_TIME (60 seconds)
      const creatorGoesFirst = true;

      await expect(
        creatorLobbies.write.createLobby([
          costLimit,
          invalidTurnTime,
          creatorGoesFirst,
          0n, // selectedMapId - no preset map,
          100n, // maxScore
          zeroAddress, // reservedJoiner - no reservation
        ])
      ).to.be.rejectedWith("InvalidTurnTime");
    });

    it("should revert with InvalidMapId when selectedMapId is a PvE-only map", async function () {
      const { creatorLobbies, maps, owner } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      await maps.write.createPresetMap([[], MapMode.PvE], {
        account: owner.account,
      });
      const pveMapId = await maps.read.mapCount();

      await expect(
        creatorLobbies.write.createLobby([
          costLimit,
          turnTime,
          creatorGoesFirst,
          pveMapId,
          100n, // maxScore
          zeroAddress, // reservedJoiner - no reservation
        ])
      ).to.be.rejectedWith("InvalidMapId");
    });

    it("should succeed when selectedMapId is a PvP or Both map", async function () {
      const { creatorLobbies, maps, owner } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      await maps.write.createPresetMap([[], MapMode.PvP], {
        account: owner.account,
      });
      const pvpMapId = await maps.read.mapCount();
      await maps.write.createPresetMap([[], MapMode.Both], {
        account: owner.account,
      });
      const bothMapId = await maps.read.mapCount();

      await expect(
        creatorLobbies.write.createLobby([
          costLimit,
          turnTime,
          creatorGoesFirst,
          pvpMapId,
          100n, // maxScore
          zeroAddress, // reservedJoiner - no reservation
        ])
      ).to.not.be.rejected;

      await expect(
        creatorLobbies.write.createLobby(
          [costLimit, turnTime, creatorGoesFirst, bothMapId, 100n, zeroAddress],
          { value: parseEther("1") } // second lobby from this creator requires the fee
        )
      ).to.not.be.rejected;
    });

    it("should require fee for additional lobbies", async function () {
      const { creatorLobbies, creator } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // First lobby should be free
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // Second lobby should require fee
      await expect(
        creatorLobbies.write.createLobby([
          costLimit,
          turnTime,
          creatorGoesFirst,
          0n, // selectedMapId - no preset map,
          100n, // maxScore
          zeroAddress, // reservedJoiner - no reservation
        ])
      ).to.be.rejectedWith("InsufficientFee");

      // Should work with correct fee
      await expect(
        creatorLobbies.write.createLobby(
          [costLimit, turnTime, creatorGoesFirst, 0n, 100n, zeroAddress], // selectedMapId - no preset map, maxScore, reservedJoiner
          {
            value: parseEther("1"),
          }
        )
      ).to.not.be.rejected;

      // Check player state after creating two lobbies
      const playerState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(playerState.activeLobbiesCount).to.equal(2n);
    });

    it("should decrement active lobbies when game starts", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployFullGameFixture);
      // Remove redundant setup code, as deployFullGameFixture already does it
      // Check states after game start
      let creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      let joinerState = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.activeLobbiesCount).to.equal(0n);
      expect(joinerState.activeLobbiesCount).to.equal(0n);
    });

    it("should decrement active lobbies when leaving lobby", async function () {
      const { creatorLobbies, creator } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // Check initial state
      let creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.activeLobbiesCount).to.equal(1n);

      // Leave the lobby
      await creatorLobbies.write.leaveLobby([1n]);

      // Check state after leaving
      creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.activeLobbiesCount).to.equal(0n);
    });

    it("should prevent creating lobby when in timeout", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, randomManager } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // HA4-03 fix (2026-09-28): timeoutJoiner only penalizes the joiner
      // (putting them "in timeout") if the creator actually committed a
      // fleet themselves first — a creator who never creates a fleet is no
      // longer able to penalize an innocent joiner. This test is about the
      // timeout mechanism itself, not that fairness rule, so the creator
      // now legitimately commits a fleet before timing the joiner out.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, zeroAddress, 1],
        { value: parseEther("4.99") },
      );
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      await ships.write.constructAllMyShips({ account: creator.account });

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([
        1n,
        [1n],
        generateStartingPositions([1n], true),
      ]);

      // Timeout the joiner
      await hre.network.provider.send("evm_increaseTime", [301]); // Wait for timeout
      await creatorLobbies.write.timeoutJoiner([1n]);

      // Create new lobby
      await creatorLobbies.write.createLobby(
        [costLimit, turnTime, creatorGoesFirst, 0n, 100n, zeroAddress], // selectedMapId - no preset map, maxScore, reservedJoiner
        { value: parseEther("1") }
      );

      // Try to join while in timeout
      await expect(joinerLobbies.write.joinLobby([2n])).to.be.rejectedWith(
        "PlayerInTimeout"
      );
    });

    it("should allow owner to create lobby for two addresses and start a game", async function () {
      const {
        lobbies,
        creatorLobbies,
        joinerLobbies,
        ships,
        freeShipClaim,
        randomManager,
        game,
        owner,
        creator,
        joiner,
      } = await loadFixture(deployLobbiesFixture);

      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );

      // Both players claim their free ships
      await freeShipClaim.write.claimFreeShips([1], {
        account: creator.account,
      });
      await freeShipClaim.write.claimFreeShips([1], {
        account: joiner.account,
      });

      const fulfillRandomnessForPlayer = async (accountAddress: string) => {
        const shipIds = await ships.read.getShipIdsOwned([accountAddress]);
        for (const shipId of shipIds) {
          const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
          const ship = tupleToShip(shipTuple);
          await randomManager.write.revealRandomness([
            ship.traits.serialNumber,
          ]);
        }
        return shipIds;
      };

      const creatorShipIds = await fulfillRandomnessForPlayer(
        creator.account.address
      );
      const joinerShipIds = await fulfillRandomnessForPlayer(
        joiner.account.address
      );

      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      const costLimit = 1000n;
      const turnTime = 300n;
      const maxScore = 100n;

      await ownerLobbies.write.createLobbyForAddresses([
        creator.account.address,
        joiner.account.address,
        costLimit,
        turnTime,
        0n,
        maxScore,
      ]);

      let lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.state.status).to.equal(LobbyStatus.FleetSelection);
      expect(lobby.players.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );

      const creatorShipId = creatorShipIds[0];
      const joinerShipId = joinerShipIds[0];

      await creatorLobbies.write.createFleet([
        1n,
        [creatorShipId],
        generateStartingPositions([creatorShipId], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [joinerShipId],
        generateStartingPositions([joinerShipId], false),
      ]);

      lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.state.status).to.equal(LobbyStatus.InGame);
      expect(lobby.players.creatorFleetId).to.not.equal(0n);
      expect(lobby.players.joinerFleetId).to.not.equal(0n);

      const creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.hasActiveLobby).to.equal(false);

      const joinerState = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(joinerState.hasActiveLobby).to.equal(false);

      const gameCount = await game.read.gameCount();
      expect(gameCount).to.equal(1n);
    });

    it("should allow next lobby and game after a lobby is cancelled", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
        game,
      } = await loadFixture(deployLobbiesFixture);

      // Prepare ships for both players so the second lobby can start a game.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create lobby #1, then cancel it by creator leaving (no joiner).
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await creatorLobbies.write.leaveLobby([1n]);

      const creatorStateAfterCancel = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorStateAfterCancel.activeLobbiesCount).to.equal(0n);

      // Create lobby #2 and start a game from it.
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([2n]);

      await creatorLobbies.write.createFleet([
        2n,
        [1n],
        generateStartingPositions([1n], true),
      ]);
      await joinerLobbies.write.createFleet([
        2n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // gameCount tracks the number of games started (one), but the game id is
      // now the lobby id, so this game lives at id 2 (lobby 1 was cancelled).
      const gameCount = await game.read.gameCount();
      expect(gameCount).to.equal(1n);

      const startedGame = await game.read.getGame([2n]);
      expect(startedGame.metadata.lobbyId).to.equal(2n);
      expect(startedGame.metadata.gameId).to.equal(2n);
    });
  });

  describe("Lobby Joining", function () {
    it("should allow joining an open lobby", async function () {
      const { creatorLobbies, joinerLobbies, joiner, publicClient } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      const tx = await joinerLobbies.write.joinLobby([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });
      expect(receipt.status).to.equal("success");

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
      expect(lobby.state.status).to.equal(LobbyStatus.FleetSelection);
    });

    it("should revert when joining non-existent lobby", async function () {
      const { joinerLobbies } = await loadFixture(deployLobbiesFixture);

      await expect(joinerLobbies.write.joinLobby([999n])).to.be.rejectedWith(
        "LobbyNotFound"
      );
    });

    it("should revert when joining a full lobby", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create first lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // First player joins
      await joinerLobbies.write.joinLobby([1n]);

      // Create second lobby
      await otherLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // Try to join first lobby while it's in FleetSelection state
      await expect(otherLobbies.write.joinLobby([1n])).to.be.rejectedWith(
        "LobbyNotOpen"
      );
    });

    it("should revert when joining while in timeout", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies, creator, ships, randomManager } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // HA4-03 fix (2026-09-28): see the identical comment in "should
      // prevent creating lobby when in timeout" above — timeoutJoiner now
      // only penalizes the joiner if the creator committed a fleet first.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, zeroAddress, 1],
        { value: parseEther("4.99") },
      );
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      await ships.write.constructAllMyShips({ account: creator.account });

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([
        1n,
        [1n],
        generateStartingPositions([1n], true),
      ]);

      // Timeout the joiner
      await hre.network.provider.send("evm_increaseTime", [301]); // Wait for timeout
      await creatorLobbies.write.timeoutJoiner([1n]);

      // Create new lobby
      await creatorLobbies.write.createLobby(
        [costLimit, turnTime, creatorGoesFirst, 0n, 100n, zeroAddress], // selectedMapId - no preset map, maxScore, reservedJoiner
        { value: parseEther("1") }
      );

      // Try to join while in timeout
      await expect(joinerLobbies.write.joinLobby([2n])).to.be.rejectedWith(
        "PlayerInTimeout"
      );
    });

    it("should revert when creator tries to join their own lobby", async function () {
      const { creatorLobbies } = await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      await expect(creatorLobbies.write.joinLobby([1n])).to.be.rejectedWith(
        "PlayerAlreadyInLobby"
      );
    });

    it("should allow player to join multiple lobbies by paying fee", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        otherLobbies,
        publicClient,
        joiner,
      } = await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create first lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create second lobby
      await otherLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // Try to join second lobby without paying fee (should fail)
      await expect(joinerLobbies.write.joinLobby([2n])).to.be.rejectedWith(
        "InsufficientFee"
      );

      // Join second lobby with fee (should succeed)
      const tx = await joinerLobbies.write.joinLobby([2n], {
        value: parseEther("1"),
      });
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });
      expect(receipt.status).to.equal("success");

      // Verify player is in both lobbies
      const lobby1 = await joinerLobbies.read.getLobby([1n]);
      const lobby2 = await joinerLobbies.read.getLobby([2n]);
      expect(lobby1.players.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
      expect(lobby2.players.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
    });

    it("should revert when trying to join a lobby that already has a joiner", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // First player joins
      await joinerLobbies.write.joinLobby([1n]);

      // Try to join the same lobby with a third player
      await expect(otherLobbies.write.joinLobby([1n])).to.be.rejectedWith(
        "LobbyNotOpen"
      );
    });
  });

  describe("Lobby State Changes", function () {
    it("should emit correct events when creator leaves with joiner", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, publicClient } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Creator leaves, joiner becomes new creator
      const tx = await creatorLobbies.write.leaveLobby([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Check for LobbyReset event
      const events = await creatorLobbies.getEvents.LobbyReset();
      const lobbyResetEvent = events[0];
      expect(lobbyResetEvent).to.not.be.undefined;
      expect(lobbyResetEvent.args.lobbyId).to.equal(1n);
      expect(lobbyResetEvent.args.newCreator!.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );

      // Verify lobby state
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.basic.creator.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
    });

    it("clears the promoted creator's stale joiner fleet so a new joiner isn't bound to it (SP-03)", async function () {
      const { lobbies, creatorLobbies, joinerLobbies, ships, randomManager } =
        await loadFixture(deployLobbiesFixture);
      const [, creator, joiner, other] = await hre.viem.getWalletClients();
      const otherLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: other } },
      );

      // Purchase and construct ships for the joiner (Bob) and the third
      // player (Carol) who'll join after Bob is promoted to creator.
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [other.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      }
      await ships.write.constructAllMyShips({ account: joiner.account });
      await ships.write.constructAllMyShips({ account: other.account });
      // Bob's ships are 1-5 (first purchase), Carol's are 6-10 (second).
      const bobShipId = 1n;
      const carolShipId = 6n;

      // Alice creates the lobby; Bob joins and submits a fleet.
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await joinerLobbies.write.createFleet([
        1n,
        [bobShipId],
        generateStartingPositions([bobShipId], false),
      ]);
      const staleFleetId = (await lobbies.read.getLobby([1n])).players
        .joinerFleetId;
      expect(staleFleetId).to.not.equal(0n);

      // Alice leaves before submitting her own fleet — Bob is promoted to
      // creator, lobby reopens.
      await creatorLobbies.write.leaveLobby([1n]);
      const afterPromotion = await lobbies.read.getLobby([1n]);
      expect(afterPromotion.basic.creator.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      // The fix: the stale joinerFleetId must be cleared, not carried over.
      expect(afterPromotion.players.joinerFleetId).to.equal(0n);

      // Carol joins as the new joiner and must be able to submit her own
      // fleet — this is exactly what reverted FleetAlreadyCreated pre-fix.
      await otherLobbies.write.joinLobby([1n]);
      await otherLobbies.write.createFleet([
        1n,
        [carolShipId],
        generateStartingPositions([carolShipId], false),
      ]);
      const carolFleetId = (await lobbies.read.getLobby([1n])).players
        .joinerFleetId;
      expect(carolFleetId).to.not.equal(0n);
      expect(carolFleetId).to.not.equal(staleFleetId);

      // Bob (now creator) submits his own new fleet, reusing his
      // now-freed-by-clearFleet ship — this is what auto-starts the game,
      // and must bind to Carol's fleet, not Bob's stale old one.
      await joinerLobbies.write.createFleet([
        1n,
        [bobShipId],
        generateStartingPositions([bobShipId], true),
      ]);
      const started = await lobbies.read.getLobby([1n]);
      expect(started.state.status).to.equal(LobbyStatus.InGame);
      expect(started.players.joinerFleetId).to.equal(carolFleetId);
    });

    it("should emit correct events when creator leaves alone", async function () {
      const { creatorLobbies, creator, publicClient } = await loadFixture(
        deployLobbiesFixture
      );
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      // Creator leaves
      const tx = await creatorLobbies.write.leaveLobby([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Check for LobbyAbandoned event
      const events = await creatorLobbies.getEvents.LobbyAbandoned();
      const lobbyAbandonedEvent = events[0];
      expect(lobbyAbandonedEvent).to.not.be.undefined;
      expect(lobbyAbandonedEvent.args.lobbyId).to.equal(1n);
      expect(lobbyAbandonedEvent.args.player!.toLowerCase()).to.equal(
        creator.account.address.toLowerCase()
      );
    });

    it("should emit correct events when joiner leaves", async function () {
      const { creatorLobbies, joinerLobbies, joiner, publicClient } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Joiner leaves
      const tx = await joinerLobbies.write.leaveLobby([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Check for LobbyAbandoned event
      const events = await joinerLobbies.getEvents.LobbyAbandoned();
      const lobbyAbandonedEvent = events[0];
      expect(lobbyAbandonedEvent).to.not.be.undefined;
      expect(lobbyAbandonedEvent.args.lobbyId).to.equal(1n);
      expect(lobbyAbandonedEvent.args.player!.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );

      // Verify lobby state
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
    });

    it("should emit correct events when joiner times out", async function () {
      const { creatorLobbies, joinerLobbies, creator, publicClient } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Wait for timeout
      await hre.network.provider.send("evm_increaseTime", [301]);
      await hre.network.provider.send("evm_mine");

      // Timeout joiner
      const tx = await creatorLobbies.write.timeoutJoiner([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Check for LobbyReset event
      const events = await creatorLobbies.getEvents.LobbyReset();
      const lobbyResetEvent = events[0];
      expect(lobbyResetEvent).to.not.be.undefined;
      expect(lobbyResetEvent.args.lobbyId).to.equal(1n);
      expect(lobbyResetEvent.args.newCreator!.toLowerCase()).to.equal(
        creator.account.address.toLowerCase()
      );

      // Verify lobby state
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
    });

    it("should free the creator's own ships when timing out a joiner who never created a fleet", async function () {
      // Regression test: a creator who commits their fleet before the
      // joiner does, then has to timeoutJoiner() because the joiner never
      // creates one, must get their own ships back (inFleet == false).
      // Previously timeoutJoiner wiped lobby.players.creatorFleetId to 0
      // without ever calling fleets.clearFleet() on it, permanently
      // trapping the creator's ships with no remaining on-chain reference
      // to their fleet id (see docs/design-analysis ship-trap audit).
      const { creatorLobbies, joinerLobbies, creator, ships, randomManager } =
        await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Give the creator a ship and construct it.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, zeroAddress, 1],
        { value: parseEther("4.99") }
      );
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      await ships.write.constructAllMyShips({ account: creator.account });

      // Create and join a lobby; creator commits their fleet first.
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([
        1n,
        [1n],
        generateStartingPositions([1n], true),
      ]);

      // Joiner never creates a fleet. Wait for timeout and kick them.
      await hre.network.provider.send("evm_increaseTime", [301]);
      await creatorLobbies.write.timeoutJoiner([1n]);

      // The creator's ship must be released, not trapped.
      const shipAfter = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple
      );
      expect(shipAfter.shipData.inFleet).to.equal(false);
    });

    it("should emit correct events when joiner quits with penalty", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creatorFleets,
        joinerFleets,
        creator,
        joiner,
        ships,
        randomManager,
        publicClient,
      } = await loadFixture(deployLobbiesFixture);
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Get all ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Only joiner creates a fleet
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // Verify lobby is in FleetSelection state before quitting
      const lobbyBefore = await creatorLobbies.read.getLobby([1n]);
      expect(lobbyBefore.state.status).to.equal(LobbyStatus.FleetSelection);
      expect(lobbyBefore.players.joinerFleetId).to.not.equal(0n);
      expect(lobbyBefore.players.creatorFleetId).to.equal(0n);

      // Wait for creator's timeout
      await hre.network.provider.send("evm_increaseTime", [301]); // Wait for timeout
      await hre.network.provider.send("evm_mine");

      // Get joiner's fleet before quitting
      const joinerFleetBefore = await creatorFleets.read.getFleet([
        lobbyBefore.players.joinerFleetId,
      ]);

      // Joiner quits with penalty
      const tx = await joinerLobbies.write.quitWithPenalty([1n]);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Check for LobbyTerminated event
      const events = await joinerLobbies.getEvents.LobbyTerminated();
      const lobbyTerminatedEvents = events.filter(
        (e) => e.transactionHash === tx
      );
      expect(lobbyTerminatedEvents.length).to.equal(1);
      const lobbyTerminatedEvent = lobbyTerminatedEvents[0];
      expect(lobbyTerminatedEvent.args.lobbyId).to.equal(1n);

      // Verify lobby state
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
      expect(lobby.players.joinerFleetId).to.equal(0n);
      expect(lobby.players.creatorFleetId).to.equal(0n);

      // Verify joiner's fleet is cleared
      const joinerFleetAfter = await creatorFleets.read.getFleet([
        joinerFleetBefore.id,
      ]);
      expect(joinerFleetAfter.shipIds.length).to.equal(0);

      // Verify penalty was applied to creator
      const creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.kickCount).to.equal(1n);
    });

    it("should NOT penalize the joiner via timeoutJoiner when the creator never created a fleet (HA4-03)", async function () {
      // Regression test for HA4-03 (docs/audit-2.md): a creator who never
      // commits a fleet themselves must not be able to penalize an innocent
      // joiner just for waiting their turn — timeoutJoiner should still
      // reset the lobby to Open, just without the punitive kickCount.
      const { creatorLobbies, joinerLobbies, joiner } = await loadFixture(
        deployLobbiesFixture,
      );

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Creator never calls createFleet.
      await hre.network.provider.send("evm_increaseTime", [301]);
      await hre.network.provider.send("evm_mine");
      await creatorLobbies.write.timeoutJoiner([1n]);

      // Lobby still resets — the creator can always reclaim it.
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // But the joiner was NOT penalized: no kickCount, and they can
      // immediately join another lobby without hitting PlayerInTimeout.
      const joinerState = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(joinerState.kickCount).to.equal(0n);

      // HA6-10: being timed out of lobby 1 also gave the joiner their
      // free-lobby slot back (it used to leak, charging them the
      // additionalLobbyFee on every future lobby).
      expect(joinerState.activeLobbiesCount).to.equal(0n);

      // The creator is still in lobby 1, so their second lobby needs the fee.
      await creatorLobbies.write.createLobby(
        [1000n, 300n, true, 0n, 100n, zeroAddress],
        { value: parseEther("1") },
      );
      // must NOT revert PlayerInTimeout, and needs no fee.
      await joinerLobbies.write.joinLobby([2n]);
    });
  });

  describe("Kicked-joiner rejoin ban (HA6-29)", function () {
    it("an address timed out of a lobby can't rejoin that lobby, but can join others", async function () {
      const { creatorLobbies, joinerLobbies, joiner } = await loadFixture(
        deployLobbiesFixture,
      );
      await creatorLobbies.write.createLobby([1000n, 300n, true, 0n, 100n, zeroAddress]);
      await joinerLobbies.write.joinLobby([1n]);
      await hre.network.provider.send("evm_increaseTime", [301]);
      await hre.network.provider.send("evm_mine");
      await creatorLobbies.write.timeoutJoiner([1n]);

      expect(
        await creatorLobbies.read.kickedFromLobby([1n, joiner.account.address]),
      ).to.equal(true);
      await expect(joinerLobbies.write.joinLobby([1n])).to.be.rejectedWith(
        "KickedFromLobby",
      );

      // Other lobbies are unaffected.
      await creatorLobbies.write.createLobby(
        [1000n, 300n, true, 0n, 100n, zeroAddress],
        { value: parseEther("1") },
      );
      await joinerLobbies.write.joinLobby([2n]);
    });
  });

  describe("Fleet Creation", function () {
    it("should only allow Lobbies contract to create fleets", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        fleets,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Get all ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create and join a lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Try to create a fleet directly through the Fleets contract (should fail)
      await expect(
        fleets.write.createFleet([
          1n,
          creator.account.address,
          [1n],
          generateStartingPositions([1n], true),
          1000n,
          true, // isCreator parameter
          0n, // mapId
        ])
      ).to.be.rejectedWith("NotAllowedToManageFleets");

      // Create a fleet through the Lobbies contract (should succeed)
      await expect(
        creatorLobbies.write.createFleet([
          1n,
          [1n],
          generateStartingPositions([1n], true),
        ])
      ).to.not.be.rejected;
    });

    it("keeps a lobby's game on the engine that was live at lobby creation, even if pvpMatch is repointed mid-FleetSelection (UA-10)", async function () {
      const {
        lobbies,
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        owner,
        ships,
        randomManager,
        game,
        gameResults,
      } = await loadFixture(deployLobbiesFixture);

      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Lobby created, joined, and the creator commits a fleet first — this
      // is the pinning moment (lobby creation), well before the joiner's
      // fleet completes the pair and actually starts the game.
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId
        100n, // maxScore
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([
        1n,
        [1n],
        generateStartingPositions([1n], true),
      ]);

      // Simulate an engine rollout mid-FleetSelection: deploy a second,
      // deliberately UNWIRED PvPMatch (its own lobbiesAddress is never set
      // to this real Lobbies contract) and repoint Lobbies.pvpMatch at it —
      // what an admin rolling out a new engine for FUTURE lobbies might do
      // while this lobby is still sitting open, one side already committed.
      const newPvpMatch = await hre.viem.deployContract("PvPMatch", [
        game.address,
        gameResults.address,
      ]);
      await lobbies.write.setPvpMatchAddress([newPvpMatch.address], {
        account: owner.account,
      });

      // The joiner completing their fleet must still start the game on the
      // ORIGINAL (snapshotted) engine, not the new, unwired one — if this
      // were still a live read of Lobbies.pvpMatch, it would revert
      // NotLobbiesContract from the new PvPMatch's own caller guard.
      await expect(
        joinerLobbies.write.createFleet([
          1n,
          [6n],
          generateStartingPositions([6n], false),
        ])
      ).to.not.be.rejected;

      // Confirm the game actually landed on the ORIGINAL engine's Game
      // contract (gameId == lobbyId for PvP).
      const g = await game.read.getGame([1n]);
      expect(g.metadata.creator).to.equal(getAddress(creator.account.address));
      expect(g.metadata.joiner).to.equal(getAddress(joiner.account.address));
    });

    it("should reject fleet creation with duplicate positions", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships for testing (following the pattern from other tests)
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Fulfill random requests for all ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create lobby and join
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create duplicate positions array (same position twice)
      const duplicatePositions = [
        { row: 0, col: 0 }, // First ship at (0, 0)
        { row: 0, col: 0 }, // Second ship also at (0, 0) - DUPLICATE!
      ];

      // Try to create a fleet with duplicate positions (should fail)
      await expect(
        creatorLobbies.write.createFleet([1n, [1n, 2n], duplicatePositions])
      ).to.be.rejectedWith("DuplicatePosition");
    });

    it("should reject fleet creation with invalid positions for creator", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships for testing
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Fulfill random requests (tier 0 mints 5 ships per purchase — read
      // the real count rather than assuming 1:1).
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      await ships.write.constructAllMyShips({ account: creator.account });

      // Create lobby and join
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Try to create a fleet with creator ship in joiner column (should fail)
      const invalidPositions = [
        { row: 0, col: 17 }, // Creator ship in invalid column (>= 17) - INVALID!
      ];

      await expect(
        creatorLobbies.write.createFleet([1n, [1n], invalidPositions])
      ).to.be.rejectedWith("InvalidPosition");
    });

    it("should reject fleet creation with invalid positions for joiner", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships for testing
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Fulfill random requests (tier 0 mints 5 ships per purchase — read
      // the real count rather than assuming 1:1).
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create lobby and join
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Try to create a fleet with joiner ship in creator column (should fail)
      const invalidPositions = [
        { row: 0, col: 0 }, // Joiner ship in creator column - INVALID!
      ];

      await expect(
        joinerLobbies.write.createFleet([1n, [2n], invalidPositions])
      ).to.be.rejectedWith("InvalidPosition");
    });
  });

  describe("Lobby Tracking Functions", function () {
    it("should track player lobbies correctly", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner } =
        await loadFixture(deployLobbiesFixture);

      // Initially no lobbies
      let creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      let joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      expect(creatorLobbyIds.length).to.equal(0);
      expect(joinerLobbyIds.length).to.equal(0);

      // Creator creates a lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      // Check creator has the lobby
      creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      expect(creatorLobbyIds.length).to.equal(1);
      expect(creatorLobbyIds[0]).to.equal(1n);

      // Check joiner still has no lobbies
      joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      expect(joinerLobbyIds.length).to.equal(0);

      // Joiner joins the lobby
      await joinerLobbies.write.joinLobby([1n]);

      // Check both players now have the lobby
      creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      expect(creatorLobbyIds.length).to.equal(1);
      expect(joinerLobbyIds.length).to.equal(1);
      expect(creatorLobbyIds[0]).to.equal(1n);
      expect(joinerLobbyIds[0]).to.equal(1n);
    });

    it("should track open lobbies correctly", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies } = await loadFixture(
        deployLobbiesFixture
      );

      // Initially no open lobbies
      let openLobbyIds = await creatorLobbies.read.getOpenLobbies();
      expect(openLobbyIds.length).to.equal(0);

      // Creator creates a lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      // Check lobby is open
      openLobbyIds = await creatorLobbies.read.getOpenLobbies();
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(1n);

      // Joiner joins the lobby
      await joinerLobbies.write.joinLobby([1n]);

      // Check lobby is no longer open
      openLobbyIds = await creatorLobbies.read.getOpenLobbies();
      expect(openLobbyIds.length).to.equal(0);

      // Create another lobby
      await otherLobbies.write.createLobby([
        2000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      // Check new lobby is open
      openLobbyIds = await creatorLobbies.read.getOpenLobbies();
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(2n);
    });

    it("should handle creator leaving lobby with joiner", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner } =
        await loadFixture(deployLobbiesFixture);

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Creator leaves lobby
      await creatorLobbies.write.leaveLobby([1n]);

      // Check joiner becomes creator and lobby is open again
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.basic.creator.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // Check tracking sets
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      expect(creatorLobbyIds.length).to.equal(0);
      expect(joinerLobbyIds.length).to.equal(1);
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(1n);
    });

    it("should handle creator leaving lobby alone", async function () {
      const { creatorLobbies, creator } = await loadFixture(
        deployLobbiesFixture
      );

      // Create lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      // Creator leaves lobby
      await creatorLobbies.write.leaveLobby([1n]);

      // Check lobby is cleaned up
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      expect(creatorLobbyIds.length).to.equal(0);
      expect(openLobbyIds.length).to.equal(0);
    });

    it("should handle joiner leaving lobby", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner } =
        await loadFixture(deployLobbiesFixture);

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Joiner leaves lobby
      await joinerLobbies.write.leaveLobby([1n]);

      // Check lobby is open again
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // Check tracking sets
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      expect(creatorLobbyIds.length).to.equal(1);
      expect(joinerLobbyIds.length).to.equal(0);
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(1n);
    });

    it("should handle joiner timeout", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner } =
        await loadFixture(deployLobbiesFixture);

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Wait for timeout and timeout joiner
      await hre.network.provider.send("evm_increaseTime", [400]); // 400 seconds later
      await hre.network.provider.send("evm_mine");
      await creatorLobbies.write.timeoutJoiner([1n]);

      // Check lobby is open again
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // Check tracking sets
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      expect(creatorLobbyIds.length).to.equal(1);
      expect(joinerLobbyIds.length).to.equal(0);
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(1n);
    });

    it("should handle quit with penalty", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Fulfill random requests and construct ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleet for joiner
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // Wait for timeout and quit with penalty
      await hre.network.provider.send("evm_increaseTime", [400]); // 400 seconds later
      await hre.network.provider.send("evm_mine");
      await joinerLobbies.write.quitWithPenalty([1n]);

      // Check lobby is open again
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // Check tracking sets
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      // HA6-10: the penalized creator stays in their reopened lobby (and
      // can still leave it); the joiner is out and gets their slot back.
      expect(creatorLobbyIds.map(String)).to.deep.equal(["1"]);
      expect(joinerLobbyIds.length).to.equal(0);
      expect(openLobbyIds.length).to.equal(1);
      expect(openLobbyIds[0]).to.equal(1n);

      const joinerState = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(joinerState.activeLobbiesCount).to.equal(0n);

      await creatorLobbies.write.leaveLobby([1n]);
      const creatorState = (await creatorLobbies.read.getPlayerState([
        creator.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(creatorState.activeLobbiesCount).to.equal(0n);
    });

    it("lets a player in several lobbies leave any of them, not just the last one recorded (HA6-10)", async function () {
      const { creatorLobbies, joinerLobbies, joiner } = await loadFixture(
        deployLobbiesFixture,
      );

      // Joiner joins lobby 1, then creates lobby 2 (paying the extra fee).
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);
      await joinerLobbies.write.createLobby(
        [1000n, 300n, true, 0n, 100n, zeroAddress],
        { value: parseEther("1") },
      );

      // activeLobbyId now points at lobby 2; leaving lobby 1 used to
      // revert NotInLobby.
      await joinerLobbies.write.leaveLobby([1n]);
      let state = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(state.activeLobbiesCount).to.equal(1n);
      expect(state.activeLobbyId).to.equal(2n); // untouched

      await joinerLobbies.write.leaveLobby([2n]);
      state = (await joinerLobbies.read.getPlayerState([
        joiner.account.address,
      ])) as unknown as PlayerLobbyState;
      expect(state.activeLobbiesCount).to.equal(0n);
    });

    it("should clean up when game starts", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        randomManager,
      } = await loadFixture(deployLobbiesFixture);

      // Purchase and construct ships
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") }
      );

      // Fulfill random requests and construct ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start game
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

      // Check tracking sets are cleaned up
      const creatorLobbyIds = await creatorLobbies.read.getPlayerLobbies([
        creator.account.address,
      ]);
      const joinerLobbyIds = await joinerLobbies.read.getPlayerLobbies([
        joiner.account.address,
      ]);
      const openLobbyIds = await creatorLobbies.read.getOpenLobbies();

      expect(creatorLobbyIds.length).to.equal(0);
      expect(joinerLobbyIds.length).to.equal(0);
      expect(openLobbyIds.length).to.equal(0);
    });

    it("should provide correct lobby counts", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies, creator, joiner } =
        await loadFixture(deployLobbiesFixture);

      // Initially no lobbies
      expect(
        await creatorLobbies.read.getPlayerLobbyCount([creator.account.address])
      ).to.equal(0n);
      expect(await creatorLobbies.read.getOpenLobbyCount()).to.equal(0n);

      // Create first lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      expect(
        await creatorLobbies.read.getPlayerLobbyCount([creator.account.address])
      ).to.equal(1n);
      expect(await creatorLobbies.read.getOpenLobbyCount()).to.equal(1n);

      // Join lobby
      await joinerLobbies.write.joinLobby([1n]);

      expect(
        await creatorLobbies.read.getPlayerLobbyCount([creator.account.address])
      ).to.equal(1n);
      expect(
        await joinerLobbies.read.getPlayerLobbyCount([joiner.account.address])
      ).to.equal(1n);
      expect(await creatorLobbies.read.getOpenLobbyCount()).to.equal(0n);

      // Create second lobby
      await otherLobbies.write.createLobby([
        2000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      expect(await creatorLobbies.read.getOpenLobbyCount()).to.equal(1n);
    });

    it("should check lobby membership correctly", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        otherLobbies,
        creator,
        joiner,
        other,
      } = await loadFixture(deployLobbiesFixture);

      // Create and join lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Check membership
      expect(
        await creatorLobbies.read.isPlayerInLobby([creator.account.address, 1])
      ).to.be.true;
      expect(
        await joinerLobbies.read.isPlayerInLobby([joiner.account.address, 1])
      ).to.be.true;
      expect(
        await otherLobbies.read.isPlayerInLobby([other.account.address, 1])
      ).to.be.false;

      // Check lobby openness
      expect(await creatorLobbies.read.isLobbyOpen([1n])).to.be.false;

      // Create another lobby
      await otherLobbies.write.createLobby([
        2000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);

      expect(await creatorLobbies.read.isLobbyOpen([2n])).to.be.true;
    });

    it("should get lobbies from IDs correctly", async function () {
      const { creatorLobbies, joinerLobbies, otherLobbies } = await loadFixture(
        deployLobbiesFixture
      );

      // Create multiple lobbies
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await otherLobbies.write.createLobby([
        2000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Get lobbies by IDs
      const lobbies = await creatorLobbies.read.getLobbiesFromIds([[1n, 2n]]);

      expect(lobbies.length).to.equal(2);
      expect(lobbies[0].basic.id).to.equal(1n);
      expect(lobbies[0].basic.costLimit).to.equal(1000n);
      expect(lobbies[1].basic.id).to.equal(2n);
      expect(lobbies[1].basic.costLimit).to.equal(2000n);
    });
  });

  describe("Game Reservation", function () {
    it("should create a reserved lobby and charge 1 UTC", async function () {
      const {
        creatorLobbies,
        joiner,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address in Lobbies (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator some UTC by purchasing directly (tier 1 = 1.1 UTC, enough for 1 UTC reservation)
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      const initialBalance = await universalCredits.read.balanceOf([
        creator.account.address,
      ]);
      const initialContractBalance = await universalCredits.read.balanceOf([
        lobbies.address,
      ]);

      // Create reserved lobby
      const costLimit = 1000n;
      const turnTime = 300n;
      const creatorGoesFirst = true;

      // Approve UTC transfer
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      const tx = await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        creatorGoesFirst,
        0n, // selectedMapId
        100n, // maxScore
        joiner.account.address, // reservedJoiner
      ]);

      const finalBalance = await universalCredits.read.balanceOf([
        creator.account.address,
      ]);
      const finalContractBalance = await universalCredits.read.balanceOf([
        lobbies.address,
      ]);

      // Check that 1 UTC was transferred
      expect(initialBalance - finalBalance).to.equal(parseEther("1"));
      expect(finalContractBalance - initialContractBalance).to.equal(
        parseEther("1")
      );

      // Check lobby is reserved
      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.reservedJoiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
    });

    it("lets the owner withdraw locked UTC reservation fees (HA3-01)", async function () {
      const {
        creatorLobbies,
        joiner,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address, // reservedJoiner - locks 1 UTC
      ]);

      // Non-owner can't withdraw.
      const joinerLobbiesForWithdraw = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: joiner } }
      );
      await expect(
        joinerLobbiesForWithdraw.write.withdrawUTC([joiner.account.address])
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");

      // Without this fix, the 1 UTC locked above had no recovery path at
      // all — confirm it's now fully recoverable to an arbitrary recipient.
      const contractBalanceBefore = await universalCredits.read.balanceOf([
        lobbies.address,
      ]);
      expect(contractBalanceBefore).to.equal(parseEther("1"));

      const recipient = owner.account.address;
      const recipientBalanceBefore = await universalCredits.read.balanceOf([
        recipient,
      ]);
      await ownerLobbies.write.withdrawUTC([recipient]);

      expect(
        await universalCredits.read.balanceOf([lobbies.address])
      ).to.equal(0n);
      expect(
        await universalCredits.read.balanceOf([recipient])
      ).to.equal(recipientBalanceBefore + parseEther("1"));
    });

    it("should not allow non-reserved player to join reserved lobby", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        otherLobbies,
        joiner,
        other,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator UTC
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      // Approve and create reserved lobby
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address, // reserved for joiner
      ]);

      // Other player should not be able to join
      await expect(otherLobbies.write.joinLobby([1n])).to.be.rejectedWith(
        "NotReservedJoiner"
      );
    });

    it("should allow reserved player to accept game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        joiner,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator UTC
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      // Approve and create reserved lobby
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address,
      ]);

      // Reserved player accepts
      await joinerLobbies.write.acceptGame([1n]);

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase()
      );
      expect(lobby.players.reservedJoiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.FleetSelection);
    });

    it("should allow reserved player to reject game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        otherLobbies,
        joiner,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator UTC
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      // Approve and create reserved lobby
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address,
      ]);

      // Reserved player rejects
      await joinerLobbies.write.rejectGame([1n]);

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.reservedJoiner).to.equal(zeroAddress);
      expect(lobby.players.joiner).to.equal(zeroAddress);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);

      // Now anyone can join
      await otherLobbies.write.joinLobby([1n]);
    });

    it("should not allow non-reserved player to accept or reject", async function () {
      const {
        creatorLobbies,
        otherLobbies,
        joiner,
        other,
        universalCredits,
        shipPurchaser,
        creator,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator UTC
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      // Approve and create reserved lobby
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address,
      ]);

      // Other player should not be able to accept
      await expect(otherLobbies.write.acceptGame([1n])).to.be.rejectedWith(
        "NotReservedJoiner"
      );

      // Other player should not be able to reject
      await expect(otherLobbies.write.rejectGame([1n])).to.be.rejectedWith(
        "NotReservedJoiner"
      );
    });

    it("should revert if creator tries to reserve for themselves", async function () {
      const {
        creatorLobbies,
        creator,
        universalCredits,
        shipPurchaser,
        lobbies,
        owner,
      } = await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Give creator UTC
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );

      // Approve
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });

      // Should revert when trying to reserve for self
      await expect(
        creatorLobbies.write.createLobby([
          1000n,
          300n,
          true,
          0n,
          100n,
          creator.account.address, // reserved for self
        ])
      ).to.be.rejectedWith("PlayerAlreadyInLobby");
    });

    it("should revert if insufficient UTC balance", async function () {
      const { creatorLobbies, joiner, lobbies, owner, universalCredits } =
        await loadFixture(deployLobbiesFixture);

      // Set universalCredits address (owner only)
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);

      // Try to create reserved lobby without UTC
      await expect(
        creatorLobbies.write.createLobby([
          1000n,
          300n,
          true,
          0n,
          100n,
          joiner.account.address,
        ])
      ).to.be.rejected;
    });

    // Shared setup for the HA2-05 tests below: creator reserves lobby 1 for
    // joiner and joiner actually joins via plain joinLobby (not acceptGame,
    // which already correctly clears the reservation).
    async function createAndJoinReservedLobby(fixture: any) {
      const { creatorLobbies, joinerLobbies, joiner, universalCredits, shipPurchaser, creator, lobbies, owner } = fixture;
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } }
      );
      await ownerLobbies.write.setUniversalCreditsAddress([
        universalCredits.address,
      ]);
      await shipPurchaser.write.purchaseUTCWithFlow(
        [creator.account.address, 1n],
        { value: parseEther("9.99"), account: creator.account }
      );
      await universalCredits.write.approve([lobbies.address, parseEther("1")], {
        account: creator.account,
      });
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        joiner.account.address,
      ]);
      await joinerLobbies.write.joinLobby([1n]);
    }

    // HA2-05 (docs/audit-2.md): reservedJoiner was never cleared outside
    // acceptGame/rejectGame, so a reserved player who joined via plain
    // joinLobby and then left could permanently lock the lobby to
    // themselves -- nobody else, including the original creator re-inviting
    // someone new, could ever join it again.
    it("clears reservedJoiner when the reserved player joins then leaves, letting anyone else join (HA2-05)", async function () {
      const fixture = await loadFixture(deployLobbiesFixture);
      const { joinerLobbies, otherLobbies, creatorLobbies } = fixture;
      await createAndJoinReservedLobby(fixture);

      await joinerLobbies.write.leaveLobby([1n]);

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.players.reservedJoiner).to.equal(zeroAddress);

      // A completely different, never-invited address can now join.
      await expect(otherLobbies.write.joinLobby([1n])).to.not.be.rejected;
    });

    // Worse variant: if the *creator* is the one who leaves after the
    // reserved player joined, that player gets promoted to creator -- if
    // reservedJoiner still equaled them, joinLobby's own creator==msg.sender
    // guard would make the lobby permanently unjoinable by anyone, forever.
    it("clears reservedJoiner when the creator leaves and the reserved player is promoted, so the lobby isn't permanently bricked (HA2-05)", async function () {
      const fixture = await loadFixture(deployLobbiesFixture);
      const { creatorLobbies, otherLobbies, joiner } = fixture;
      await createAndJoinReservedLobby(fixture);

      await creatorLobbies.write.leaveLobby([1n]);

      const lobby = await creatorLobbies.read.getLobby([1n]);
      expect(lobby.basic.creator.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(lobby.players.reservedJoiner).to.equal(zeroAddress);

      // A third party can join the now-Bob-owned lobby -- it isn't
      // permanently dead.
      await expect(otherLobbies.write.joinLobby([1n])).to.not.be.rejected;
    });
  });

  describe("Stale lobby pruning (GR-03)", function () {
    async function createOpenLobby(creatorLobbies: any) {
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
    }

    it("defaults staleLobbyThreshold to 7 days", async function () {
      const { lobbies } = await loadFixture(deployLobbiesFixture);
      expect(await lobbies.read.staleLobbyThreshold()).to.equal(
        BigInt(7 * 24 * 60 * 60),
      );
    });

    it("reverts LobbyNotStaleYet before the threshold has elapsed", async function () {
      const { lobbies, creatorLobbies, other } = await loadFixture(
        deployLobbiesFixture,
      );
      await createOpenLobby(creatorLobbies);

      await expect(
        lobbies.write.pruneStaleLobby([1n], { account: other.account }),
      ).to.be.rejectedWith("LobbyNotStaleYet");
    });

    it("lets anyone prune an unjoined lobby once staleLobbyThreshold has elapsed", async function () {
      const { lobbies, creatorLobbies, other } = await loadFixture(
        deployLobbiesFixture,
      );
      await createOpenLobby(creatorLobbies);
      expect(await lobbies.read.getOpenLobbies()).to.deep.equal([1n]);

      await hre.network.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
      await hre.network.provider.send("evm_mine");

      // A totally unrelated address can prune it — permissionless by design.
      await lobbies.write.pruneStaleLobby([1n], { account: other.account });

      expect(await lobbies.read.getOpenLobbies()).to.deep.equal([]);
      // The lobby record itself is untouched — only delisted, not deleted.
      const lobby = await lobbies.read.getLobby([1n]);
      expect(lobby.basic.id).to.equal(1n);
      expect(lobby.state.status).to.equal(LobbyStatus.Open);
    });

    it("reverts LobbyNotOpen if the lobby was already joined (and is therefore no longer in the open set)", async function () {
      const { lobbies, creatorLobbies, joinerLobbies, other } =
        await loadFixture(deployLobbiesFixture);
      await createOpenLobby(creatorLobbies);
      await joinerLobbies.write.joinLobby([1n]);

      await hre.network.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
      await hre.network.provider.send("evm_mine");

      await expect(
        lobbies.write.pruneStaleLobby([1n], { account: other.account }),
      ).to.be.rejectedWith("LobbyNotOpen");
    });

    it("measures staleness from when a lobby last re-entered the open set, not from its original creation time (regression)", async function () {
      // A lobby created long ago, then joined and left again, should get a
      // fresh staleness clock — not be immediately pruneable just because
      // its original createdAt is old. Catches a bug where pruneStaleLobby
      // read lobby.basic.createdAt (set once, at creation) instead of a
      // timestamp refreshed on every re-entry into openLobbyIds.
      const { lobbies, creatorLobbies, joinerLobbies, other } =
        await loadFixture(deployLobbiesFixture);
      await createOpenLobby(creatorLobbies);

      // Age the lobby well past the stale threshold while it's still
      // unjoined.
      await hre.network.provider.send("evm_increaseTime", [8 * 24 * 60 * 60]);
      await hre.network.provider.send("evm_mine");

      // Now a joiner arrives and leaves — the lobby re-enters openLobbyIds
      // "fresh," even though its basic.createdAt is still 8 days old.
      await joinerLobbies.write.joinLobby([1n]);
      await joinerLobbies.write.leaveLobby([1n]);
      expect(await lobbies.read.getOpenLobbies()).to.deep.equal([1n]);

      // Must NOT be immediately pruneable — it just became open again.
      await expect(
        lobbies.write.pruneStaleLobby([1n], { account: other.account }),
      ).to.be.rejectedWith("LobbyNotStaleYet");

      // Once the threshold genuinely elapses from the re-entry, pruning
      // works as normal.
      await hre.network.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
      await hre.network.provider.send("evm_mine");
      await lobbies.write.pruneStaleLobby([1n], { account: other.account });
      expect(await lobbies.read.getOpenLobbies()).to.deep.equal([]);
    });

    it("owner can change staleLobbyThreshold, and the new value is what gets enforced", async function () {
      const { lobbies, creatorLobbies, other } = await loadFixture(
        deployLobbiesFixture,
      );
      await lobbies.write.setStaleLobbyThreshold([60n * 60n]); // 1 hour
      expect(await lobbies.read.staleLobbyThreshold()).to.equal(3600n);

      await createOpenLobby(creatorLobbies);

      // Not stale yet at 30 minutes.
      await hre.network.provider.send("evm_increaseTime", [30 * 60]);
      await hre.network.provider.send("evm_mine");
      await expect(
        lobbies.write.pruneStaleLobby([1n], { account: other.account }),
      ).to.be.rejectedWith("LobbyNotStaleYet");

      // Stale by 31 more minutes (61 total).
      await hre.network.provider.send("evm_increaseTime", [31 * 60]);
      await hre.network.provider.send("evm_mine");
      await lobbies.write.pruneStaleLobby([1n], { account: other.account });
      expect(await lobbies.read.getOpenLobbies()).to.deep.equal([]);
    });

    it("reverts when a non-owner tries to change staleLobbyThreshold", async function () {
      const { creatorLobbies } = await loadFixture(deployLobbiesFixture);
      await expect(
        creatorLobbies.write.setStaleLobbyThreshold([1n]),
      ).to.be.rejected;
    });

    it("getOpenLobbiesPaginated pages through the open set and matches getOpenLobbies when read in full", async function () {
      const { lobbies, creatorLobbies, joinerLobbies, other } =
        await loadFixture(deployLobbiesFixture);
      // Three separate creators so each can have an active lobby simultaneously.
      await createOpenLobby(creatorLobbies);
      await createOpenLobby(joinerLobbies);
      await createOpenLobby(
        await hre.viem.getContractAt("Lobbies", lobbies.address, {
          client: { wallet: other },
        }),
      );

      const all = await lobbies.read.getOpenLobbies();
      expect(all.length).to.equal(3);

      const page1 = await lobbies.read.getOpenLobbiesPaginated([0n, 2n]);
      const page2 = await lobbies.read.getOpenLobbiesPaginated([2n, 2n]);
      expect(page1.length).to.equal(2);
      // Runs past the end (offset 2, limit 2, only 1 remains) — returns
      // fewer than _limit rather than reverting.
      expect(page2.length).to.equal(1);
      expect([...page1, ...page2].map(String).sort()).to.deep.equal(
        all.map(String).sort(),
      );

      const pastEnd = await lobbies.read.getOpenLobbiesPaginated([50n, 10n]);
      expect(pastEnd.length).to.equal(0);
    });
  });
});
