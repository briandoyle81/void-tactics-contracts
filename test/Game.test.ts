import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress, parseEventLogs } from "viem";
import {
  LobbyStatus,
  PlayerLobbyState,
  ShipTuple,
  tupleToShip,
  ActionType,
  Ship,
  GameDataView,
  MapMode,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { attributeParams } from "./fixtures/attributeTables";
import {
  setShipPosition,
  setShipHullPointsToZero,
  setShipHullPoints,
  primeShipForRealDestruction,
} from "./helpers/gameStorage";

// Replaces debugDestroyShip: primes the ship (hullPoints=0,
// reactorCriticalTimer=2, added to shipsWithZeroHP) then drives exactly one
// real round to completion via Pass moves for every OTHER currently-active
// ship, in the given turn order. Game.sol's own
// _incrementReactorCriticalTimerForZeroHPShips then increments the primed
// ship's timer to 3 and destroys it for real at that round's end — see
// test/helpers/gameStorage.ts's primeShipForRealDestruction doc comment.
// `selfMoverAccount`: a 0-HP ship can only legally Retreat, never Pass
// (Game.sol:592-595) — so if the ship being destroyed is its owner's ONLY
// ship, that owner can never act once it's primed, and — since the turn
// only ever switches inside a moveShip call — the game deadlocks (the
// other player can't move either, because it's still not their turn).
// Passing the owner's account here Pass-moves the target ship ONCE, WHILE
// IT'S STILL HEALTHY, before priming — handing the turn off normally, the
// same way a real ship that takes lethal damage mid-round (after already
// having acted that round) would.
async function destroyShipViaRound(
  game: any,
  gameId: bigint,
  shipId: bigint,
  otherMovers: { shipId: bigint; account: any }[],
  selfMoverAccount?: any,
) {
  if (selfMoverAccount) {
    const preGameData = (await game.read.getGame([
      gameId,
    ])) as unknown as GameDataView;
    const selfPos = findShipPosition(preGameData, shipId);
    await game.write.moveShip(
      [gameId, shipId, selfPos.row, selfPos.col, ActionType.Pass, 0n],
      { account: selfMoverAccount },
    );
  }
  await primeShipForRealDestruction(game.address, gameId, shipId);
  const gameData = (await game.read.getGame([gameId])) as unknown as GameDataView;
  for (const mover of otherMovers) {
    const pos = findShipPosition(gameData, mover.shipId);
    await game.write.moveShip(
      [gameId, mover.shipId, pos.row, pos.col, ActionType.Pass, 0n],
      { account: mover.account },
    );
  }
}

// Helper function to find a ship's position from GameDataView
function findShipPosition(gameData: GameDataView, shipId: bigint) {
  for (const shipPosition of gameData.shipPositions) {
    if (shipPosition.shipId === shipId) {
      return shipPosition.position;
    }
  }
  throw new Error(`Ship ${shipId} not found in game data`);
}

// Helper function to generate starting positions
function generateStartingPositions(shipIds: bigint[], isCreator: boolean) {
  const positions = [];
  for (let i = 0; i < shipIds.length; i++) {
    if (isCreator) {
      // Creator starts in top-left, each ship 1 down, in columns 0-3
      // Wrap rows to stay within 0-10 range
      positions.push({ row: i % 11, col: i % 4 }); // Use columns 0-3
    } else {
      // Joiner starts in bottom-right, each ship 1 up, in columns 13-16
      // Ensure rows stay within 0-10 range
      const row = Math.max(0, 10 - (i % 11));
      positions.push({ row, col: 13 + (i % 4) }); // Use columns 13-16
    }
  }
  return positions;
}

const GRID_MAX_COLUMN = 16;

async function getValidHorizontalDestination(
  game: any,
  gameId: bigint,
  shipId: bigint,
  currentCol: number,
  desiredDelta = 4,
  allowNoOp = false,
) {
  const attributes = await game.read.getShipAttributes([gameId, shipId]);
  const movement = Number(attributes.movement);

  if (movement === 0) {
    return currentCol;
  }

  let delta = Math.min(movement, Math.max(desiredDelta, 0));

  if (delta === 0) {
    if (allowNoOp) {
      return currentCol;
    }
    delta = Math.min(movement, 1);
  }

  if (!allowNoOp) {
    delta = Math.max(delta, 1);
  }

  return Math.min(currentCol + delta, GRID_MAX_COLUMN);
}

async function moveShipWithinMovement(
  game: any,
  gameId: bigint,
  shipId: bigint,
  account: any,
  desiredDelta = 4,
  actionType: ActionType = ActionType.Pass,
  allowNoOp = false,
) {
  const gameData = (await game.read.getGame([gameId])) as GameDataView;
  const shipPosition = findShipPosition(gameData, shipId);
  const destinationCol = await getValidHorizontalDestination(
    game,
    gameId,
    shipId,
    shipPosition.col,
    desiredDelta,
    allowNoOp,
  );

  await game.write.moveShip(
    [gameId, shipId, shipPosition.row, destinationCol, actionType, 0n],
    {
      account,
    },
  );
}

describe("Game", function () {
  async function deployGameFixture() {
    const [owner, creator, joiner, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    // Deploy all contracts using the module
    const deployed = await hre.ignition.deploy(DeployModule);

    // Create separate contract instances for each user
    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      {
        client: { wallet: creator },
      },
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      {
        client: { wallet: joiner },
      },
    );
    const otherLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      {
        client: { wallet: other },
      },
    );

    // Create Fleets contract instances
    const creatorFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      {
        client: { wallet: creator },
      },
    );
    const joinerFleets = await hre.viem.getContractAt(
      "Fleets",
      deployed.fleets.address,
      {
        client: { wallet: joiner },
      },
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
      shipAttributes: deployed.shipAttributes,
      game: deployed.game,
      pvpMatch: deployed.pvpMatch,
      randomManager: deployed.randomManager,
      maps: deployed.maps,
      gameResults: deployed.gameResults,
      owner,
      creator,
      joiner,
      other,
      publicClient,
    };
  }

  describe("setAddresses engine-live guard (UA-01)", function () {
    it("rejects setAddresses once this engine has started its first game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        owner,
        ships,
        game,
        maps,
        fleets,
        shipAttributes,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Sanity: still callable before any game exists (this is the normal
      // deploy-time wiring call every fixture/deploy relies on).
      await expect(
        game.write.setAddresses(
          [maps.address, fleets.address, shipAttributes.address, ships.address],
          { account: owner.account },
        ),
      ).to.not.be.rejected;

      // Start a real game on this engine.
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

      // Now that gameCount > 0, this engine's shared-infra addresses must
      // be permanently locked — swapping any of them here would instantly
      // corrupt the game that's now active on this exact Game contract.
      await expect(
        game.write.setAddresses(
          [maps.address, fleets.address, shipAttributes.address, ships.address],
          { account: owner.account },
        ),
      ).to.be.rejectedWith("EngineAlreadyLive");
    });
  });

  describe("Resolver setters engine-live guard (UA-07)", function () {
    it("rejects setFactionAbilityResolver/setSpecialResolver once this engine has started its first game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        owner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Sanity: still callable before any game exists. The actual address
      // doesn't matter for this test — only the access-control gate is
      // under test, not resolver behavior — so any placeholder works.
      const dummyResolver = owner.account.address;
      await expect(
        game.write.setFactionAbilityResolver([1, dummyResolver], {
          account: owner.account,
        }),
      ).to.not.be.rejected;

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

      await expect(
        game.write.setFactionAbilityResolver([1, dummyResolver], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("EngineAlreadyLive");
      await expect(
        game.write.setSpecialResolver([1, 1, dummyResolver], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("EngineAlreadyLive");
    });
  });

  describe("Maps debug tile setters engine-ended guard (UA-12)", function () {
    it("rejects setBlockedTile/setImpassableTile/setScoringTile against an already-ended game, but still allows them against an active one", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        owner,
        ships,
        game,
        maps,
        pvpMatch,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
      const gameId = 1n;

      // Still active: the debug setters work normally.
      await expect(
        maps.write.setBlockedTile([gameId, 0, 0, true], {
          account: owner.account,
        }),
      ).to.not.be.rejected;

      // End the game.
      await pvpMatch.write.flee([gameId], { account: creator.account });
      expect((await game.read.getGame([gameId])).metadata.ended).to.equal(
        true,
      );

      // Now rejected across all three setters.
      await expect(
        maps.write.setBlockedTile([gameId, 0, 0, true], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("GameAlreadyEnded");
      await expect(
        maps.write.setImpassableTile([gameId, 0, 0, true], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("GameAlreadyEnded");
      await expect(
        maps.write.setScoringTile([gameId, 0, 0, 5], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("GameAlreadyEnded");
    });
  });

  describe("Game Ship Attributes", function () {
    it("should calculate correct hull points for ships", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Get the constructed ship to see its traits
      const constructedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const constructedShip = tupleToShip(constructedShipTuple);

      // Calculate expected hull points: baseHull (100) + (traits.hull * 10)
      const expectedHullPoints = 100 + constructedShip.traits.hull * 10;

      // Create a game and calculate attributes
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get the ship attributes
      const attributes = await game.read.getShipAttributes([1n, 1]);

      expect(attributes.hullPoints).to.equal(expectedHullPoints);
    });

    it("should calculate correct movement for ships with different equipment", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get ship attributes for both players
      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const joinerAttributes = await game.read.getShipAttributes([1n, 6n]);

      // Verify movement calculations
      // Base speed is 5, plus trait bonus, plus equipment modifiers
      expect(creatorAttributes.movement).to.be.greaterThan(0);
      expect(joinerAttributes.movement).to.be.greaterThan(0);

      // Movement should be calculated as: baseSpeed + traits.speed + equipment modifiers
      // We can't predict exact values due to randomness, but they should be reasonable
      expect(creatorAttributes.movement).to.be.lessThan(20); // Reasonable upper bound
      expect(joinerAttributes.movement).to.be.lessThan(20);
    });

    it("should calculate correct weapon range and damage", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Get the constructed ship to see its equipment
      const constructedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const constructedShip = tupleToShip(constructedShipTuple);

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get the ship attributes
      const attributes = await game.read.getShipAttributes([1n, 1]);

      // Verify weapon attributes based on equipment
      const mainWeapon = constructedShip.equipment.mainWeapon;

      // Expected values based on ShipAttributes contract's gun data
      const expectedRanges = [3, 6, 4, 2]; // Generic, Sniper, Missile, Close
      const expectedDamages = [50, 40, 60, 80];

      // Get the ship's accuracy level to calculate expected range with fore accuracy bonus
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const accuracyLevel = ship.traits.accuracy;

      // Fore accuracy bonuses as percentages: 0, 25, 50 for levels 0, 1, 2
      const foreAccuracyBonuses = [0, 25, 50];
      const baseRange = expectedRanges[mainWeapon];
      const foreAccuracyBonus = Math.floor(
        (baseRange * foreAccuracyBonuses[accuracyLevel]) / 100,
      );
      const expectedRangeWithBonus = baseRange + foreAccuracyBonus;

      expect(attributes.range).to.equal(expectedRangeWithBonus);
      expect(attributes.gunDamage).to.equal(expectedDamages[mainWeapon]);
    });

    it("should handle negative movement correctly", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get ship attributes for both players
      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const joinerAttributes = await game.read.getShipAttributes([1n, 6n]);

      // Movement should never be negative (clamped to 0)
      expect(creatorAttributes.movement).to.be.greaterThanOrEqual(0);
      expect(joinerAttributes.movement).to.be.greaterThanOrEqual(0);
    });

    it("should calculate attributes for multiple ships in a fleet", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n, 3n],
        generateStartingPositions([1n, 2n, 3n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n],
        generateStartingPositions([6n, 7n, 8n], false),
      ]);

      // Get game data which includes all ship attributes
      const gameData = (await game.read.getGame([1n])) as any;

      // Verify we got attributes for all ships
      expect(gameData.shipAttributes.length).to.equal(6); // 3 creator + 3 joiner ships

      // Verify each ship has valid attributes
      for (let i = 0; i < 6; i++) {
        expect(gameData.shipAttributes[i].version).to.equal(1);
        expect(gameData.shipAttributes[i].hullPoints).to.be.greaterThan(0);
        expect(gameData.shipAttributes[i].movement).to.be.greaterThanOrEqual(0);
        expect(gameData.shipAttributes[i].range).to.be.greaterThan(0);
        expect(gameData.shipAttributes[i].gunDamage).to.be.greaterThan(0);
      }
    });

    it("should return correct game data with ship attributes", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets
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

      // Get complete game data
      const gameData = (await game.read.getGame([1n])) as any;

      // Verify game data structure
      expect(gameData.metadata.gameId).to.equal(1n);
      expect(gameData.metadata.lobbyId).to.equal(1n);
      expect(gameData.metadata.creator.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
      expect(gameData.metadata.joiner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(gameData.metadata.creatorGoesFirst).to.be.true;
      expect(Number(gameData.metadata.startedAt)).to.be.greaterThan(0);
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Verify ship attributes arrays
      expect(gameData.shipAttributes.length).to.equal(2); // 1 creator + 1 joiner ship

      // Verify creator ship attributes (first in the array)
      const creatorAttrs = gameData.shipAttributes[0];
      expect(creatorAttrs.version).to.equal(1);
      expect(creatorAttrs.hullPoints).to.be.greaterThan(0);
      expect(creatorAttrs.movement).to.be.greaterThanOrEqual(0);
      expect(creatorAttrs.range).to.be.greaterThan(0);
      expect(creatorAttrs.gunDamage).to.be.greaterThan(0);
      expect(creatorAttrs.statusEffects.length).to.equal(0);

      // Verify joiner ship attributes (second in the array)
      const joinerAttrs = gameData.shipAttributes[1];
      expect(joinerAttrs.version).to.equal(1);
      expect(joinerAttrs.hullPoints).to.be.greaterThan(0);
      expect(joinerAttrs.movement).to.be.greaterThanOrEqual(0);
      expect(joinerAttrs.range).to.be.greaterThan(0);
      expect(joinerAttrs.gunDamage).to.be.greaterThan(0);
      expect(joinerAttrs.statusEffects.length).to.equal(0);
    });

    it("pins each ship's attributes version at game start, unaffected by a later publish", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        owner,
        ships,
        shipAttributes,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // The game snapshotted variant 1's attributes version (1) for its ship.
      const pinned = await game.read.getShipAttributes([1n, 1n]);
      expect(pinned.version).to.equal(1);

      // Publish a much tankier variant 1 (version 2) and make it live.
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 1,
            baseHull: 200,
            baseSpeed: 3,
            foreAccuracy: [0, 25, 50],
            hull: [0, 10, 20],
            engineSpeeds: [0, 1, 2],
            guns: [
              { range: 3, damage: 50, movement: 0 },
              { range: 6, damage: 40, movement: 0 },
              { range: 4, damage: 60, movement: -1 },
              { range: 2, damage: 80, movement: 0 },
            ],
            armors: [
              { damageReduction: 0, movement: 1 },
              { damageReduction: 15, movement: 0 },
              { damageReduction: 30, movement: -1 },
              { damageReduction: 45, movement: -2 },
            ],
            shields: [
              { damageReduction: 0, movement: 1 },
              { damageReduction: 15, movement: 1 },
              { damageReduction: 30, movement: 0 },
              { damageReduction: 45, movement: -1 },
            ],
            specials: [{ range: 0, strength: 0, movement: 0 }],
          }),
        ],
        { account: owner.account },
      );
      expect(
        await shipAttributes.read.getCurrentAttributesVersion([1]),
      ).to.equal(2);

      // A fresh calculation now reflects v2...
      const live = await shipAttributes.read.calculateShipAttributesById([1n]);
      expect(live.version).to.equal(2);
      expect(live.hullPoints).to.be.greaterThan(pinned.hullPoints);

      // ...but the in-flight game keeps its start-of-game snapshot,
      const after = await game.read.getShipAttributes([1n, 1n]);
      expect(after.version).to.equal(1);
      expect(after.hullPoints).to.equal(pinned.hullPoints);

      // and can't be re-snapshotted to pull the new version in — the
      // snapshot function isn't externally callable at all (HA6-01).
      expect(
        game.abi.some(
          (item: { type: string; name?: string }) =>
            item.type === "function" &&
            item.name === "calculateShipAttributes",
        ),
      ).to.equal(false);
    });

    it("should revert when trying to get attributes for non-existent game", async function () {
      const { game } = await loadFixture(deployGameFixture);

      await expect(game.read.getShipAttributes([999n, 1])).to.be.rejectedWith(
        "GameNotFound",
      );
    });

    it("should revert when trying to get attributes for non-existent ship", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Try to get attributes for non-existent ship
      await expect(game.read.getShipAttributes([1n, 999n])).to.be.rejectedWith(
        "ShipNotFound",
      );
    });
  });

  describe("Game Grid", function () {
    it("should initialize grid with correct dimensions", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get complete game data
      const gridGameData = (await game.read.getGame([1n])) as any;

      // Verify grid dimensions (11 rows x 17 columns)
      expect(gridGameData.gridDimensions.gridWidth).to.equal(17); // Number of columns
      expect(gridGameData.gridDimensions.gridHeight).to.equal(11); // Number of rows
    });

    it("should place both players' ships correctly at the start of a game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        lobbies,
        owner,
      } = await loadFixture(deployGameFixture);

      // Increase max fleet cost limit to allow high cost limit for this test
      const ownerLobbies = await hre.viem.getContractAt(
        "Lobbies",
        lobbies.address,
        { client: { wallet: owner } },
      );
      await ownerLobbies.write.setMaxFleetCostLimit([5000n]);

      // Purchase and construct 12 ships for both players (exceeds single column capacity of 10)
      // Alternate purchases: creator gets odd IDs (1,3,5...), joiner gets even IDs (2,4,6...)
      for (let i = 0; i < 12; i++) {
        await ships.write.purchaseWithFlow(
          [creator.account.address, 0n, joiner.account.address, 1],
          { value: parseEther("4.99") },
        );
        await ships.write.purchaseWithFlow(
          [joiner.account.address, 0n, creator.account.address, 1],
          { value: parseEther("4.99") },
        );
      }

      // Get ships' serial numbers and fulfill random requests for all ships
      // (tier 0 mints 5 ships per purchase, so 24 purchases means more than
      // 24 ships — read the real count rather than assuming 1:1).
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with high points limit to allow many ships
      await creatorLobbies.write.createLobby([
        5000n, // Very high points limit
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with 12 ships each (exceeds single column capacity)
      // Based on actual ownership pattern: creator and joiner ship IDs
      const creatorShipIds = [
        1n,
        2n,
        3n,
        4n,
        5n,
        11n,
        12n,
        13n,
        14n,
        15n,
        21n,
        22n,
      ];
      const joinerShipIds = [
        6n,
        7n,
        8n,
        9n,
        10n,
        16n,
        17n,
        18n,
        19n,
        20n,
        26n,
        27n,
      ];

      await creatorLobbies.write.createFleet([
        1n,
        creatorShipIds,
        generateStartingPositions(creatorShipIds, true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        joinerShipIds,
        generateStartingPositions(joinerShipIds, false),
      ]);

      // Get ship positions
      const shipPositions = (await game.read.getAllShipPositions([1n])) as any;

      // Separate creator and joiner ships
      const creatorShips = shipPositions
        .filter((pos: any) => creatorShipIds.includes(pos.shipId))
        .sort((a: any, b: any) => a.position.row - b.position.row); // Sort ascending for verification
      const joinerShips = shipPositions
        .filter((pos: any) => joinerShipIds.includes(pos.shipId))
        .sort((a: any, b: any) => b.position.row - a.position.row); // Sort descending for verification

      // Verify we have the expected number of ships
      expect(creatorShips.length).to.equal(12);
      expect(joinerShips.length).to.equal(12);

      // Verify creator ships are placed in columns 0-3
      // With 12 ships and i % 4, we get: 0,1,2,3,0,1,2,3,0,1,2,3
      const creatorShipsInCol0 = creatorShips.filter(
        (ship) => ship.position.col === 0,
      );
      const creatorShipsInCol1 = creatorShips.filter(
        (ship) => ship.position.col === 1,
      );
      const creatorShipsInCol2 = creatorShips.filter(
        (ship) => ship.position.col === 2,
      );
      const creatorShipsInCol3 = creatorShips.filter(
        (ship) => ship.position.col === 3,
      );

      expect(creatorShipsInCol0.length).to.equal(3); // Ships at indices 0, 4, 8
      expect(creatorShipsInCol1.length).to.equal(3); // Ships at indices 1, 5, 9
      expect(creatorShipsInCol2.length).to.equal(3); // Ships at indices 2, 6, 10
      expect(creatorShipsInCol3.length).to.equal(3); // Ships at indices 3, 7, 11

      // Verify no ships are placed outside allowed columns (0-3)
      const creatorColumns = [
        ...new Set(creatorShips.map((ship) => ship.position.col)),
      ].sort((a, b) => a - b);
      expect(creatorColumns).to.deep.equal([0, 1, 2, 3]); // Only columns 0-3

      // Verify joiner ships are placed in columns 13-16
      // With 12 ships and 13 + (i % 4), we get: 13,14,15,16,13,14,15,16,13,14,15,16
      const joinerShipsInCol13 = joinerShips.filter(
        (ship) => ship.position.col === 13,
      );
      const joinerShipsInCol14 = joinerShips.filter(
        (ship) => ship.position.col === 14,
      );
      const joinerShipsInCol15 = joinerShips.filter(
        (ship) => ship.position.col === 15,
      );
      const joinerShipsInCol16 = joinerShips.filter(
        (ship) => ship.position.col === 16,
      );

      expect(joinerShipsInCol13.length).to.equal(3); // Ships at indices 0, 4, 8
      expect(joinerShipsInCol14.length).to.equal(3); // Ships at indices 1, 5, 9
      expect(joinerShipsInCol15.length).to.equal(3); // Ships at indices 2, 6, 10
      expect(joinerShipsInCol16.length).to.equal(3); // Ships at indices 3, 7, 11

      // Verify no ships are placed outside allowed columns
      const joinerColumns = [
        ...new Set(joinerShips.map((ship) => ship.position.col)),
      ].sort((a, b) => a - b);
      expect(joinerColumns).to.deep.equal([13, 14, 15, 16]); // Only columns 13-16

      // Verify no ships are placed in columns between the two sides
      const allColumns = shipPositions.map((pos: any) => pos.position.col);
      const uniqueColumns = [...new Set(allColumns)].sort((a, b) => a - b);
      expect(uniqueColumns).to.deep.equal([0, 1, 2, 3, 13, 14, 15, 16]); // Creator columns 0-3, Joiner columns 13-16
    });

    it("should allow querying ship at specific grid position", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Check ship positions using getAllShipPositions
      const allShipPositions = await game.read.getAllShipPositions([1n]);
      const shipAtOrigin = allShipPositions.find((pos) => pos.shipId === 1n);
      const shipAtEnd = allShipPositions.find((pos) => pos.shipId === 6n);

      expect(shipAtOrigin?.position.row).to.equal(0);
      expect(shipAtOrigin?.position.col).to.equal(0);
      expect(shipAtEnd?.position.row).to.equal(10);
      expect(shipAtEnd?.position.col).to.equal(13);
    });

    it("should allow querying individual ship positions", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get individual ship positions
      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorShipPosition = findShipPosition(gameData, 1n);
      expect(creatorShipPosition.row).to.equal(0);
      expect(creatorShipPosition.col).to.equal(0);

      const joinerShipPosition = findShipPosition(gameData, 6n);
      expect(joinerShipPosition.row).to.equal(10);
      expect(joinerShipPosition.col).to.equal(13);
    });
  });

  describe("Ship Movement", function () {
    it("should allow valid ship movement within movement range", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get creator's ship attributes to check movement range
      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      // Verify initial position
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const initialPosition = findShipPosition(gameData, 1n);
      expect(initialPosition.row).to.equal(0);
      expect(initialPosition.col).to.equal(0);

      // Move ship within its movement range (e.g., 2 spaces to the right)
      if (movementRange >= 2) {
        await game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
          account: creator.account,
        });

        // Verify new position
        let gameData = (await game.read.getGame([
          1n,
        ])) as unknown as GameDataView;
        const newPosition = findShipPosition(gameData, 1n);
        expect(newPosition.row).to.equal(0);
        expect(newPosition.col).to.equal(2);

        // Verify grid is updated using getAllShipPositions
        const allShipPositions = await game.read.getAllShipPositions([1n]);
        const shipAt00 = allShipPositions.find(
          (pos) => pos.position.row === 0 && pos.position.col === 0,
        );
        const shipAt02 = allShipPositions.find(
          (pos) => pos.position.row === 0 && pos.position.col === 2,
        );

        expect(shipAt00).to.be.undefined; // Should be empty
        expect(shipAt02?.shipId).to.equal(1n); // Ship 1 should be at (0,2)

        // Verify turn switched to joiner
        gameData = (await game.read.getGame([1n])) as any;
        expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
          joiner.account.address.toLowerCase(),
        );
      }
    });

    it("should revert InvalidMove when the path to a destination crosses an impassable tile (blocks THROUGH, not just onto)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        owner,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map
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

      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      if (movementRange >= 2) {
        // Controlled start position, straight horizontal path to (5,4).
        await setShipPosition(game.address, 1n, 1n, 5, 2);
        // Impassable tile strictly BETWEEN start and destination (not the
        // destination itself) -- proves the path is blocked THROUGH the
        // cell, not just when landing ON it.
        await maps.write.setImpassableTile([1n, 5, 3, true], {
          account: owner.account,
        });

        await expect(
          game.write.moveShip([1n, 1n, 5, 4, ActionType.Pass, 0n], {
            account: creator.account,
          }),
        ).to.be.rejectedWith("InvalidMove");
      }
    });

    it("should still allow a move whose path crosses a tile that is only blocked (LOS), not impassable", async function () {
      // Same shape as the impassable test above, but with setBlockedTile
      // instead -- proves the two bits are independent at the Game.sol
      // boundary: a pure line-of-sight obstacle never stops movement.
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        owner,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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

      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      if (movementRange >= 2) {
        await setShipPosition(game.address, 1n, 1n, 5, 2);
        await maps.write.setBlockedTile([1n, 5, 3, true], {
          account: owner.account,
        });

        await game.write.moveShip([1n, 1n, 5, 4, ActionType.Pass, 0n], {
          account: creator.account,
        });

        const gameData = (await game.read.getGame([
          1n,
        ])) as unknown as GameDataView;
        const newPosition = findShipPosition(gameData, 1n);
        expect(newPosition.row).to.equal(5);
        expect(newPosition.col).to.equal(4);
      }
    });

    // Enemy-ship blocking (2026-09-25): a ship's CURRENT position now blocks
    // an opposing-side ship's path through it, the same way impassable
    // terrain does — but only the enemy side; a ship's own ally never
    // blocks anything beyond the pre-existing "can't land on an occupied
    // tile" rule (unchanged, any ship still blocks landing on its own tile).
    it("should revert InvalidMove when the path crosses a tile occupied by an ENEMY ship (blocks THROUGH, not just onto)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // Two joiner ships: 6n is just along for a valid game, 7n is placed
      // directly in the mover's path below.
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      if (movementRange >= 2) {
        await setShipPosition(game.address, 1n, 1n, 5, 2);
        // Enemy (joiner) ship strictly BETWEEN start (5,2) and destination
        // (5,4) — not the destination itself, proving "through" not "onto".
        await setShipPosition(game.address, 1n, 7n, 5, 3);

        await expect(
          game.write.moveShip([1n, 1n, 5, 4, ActionType.Pass, 0n], {
            account: creator.account,
          }),
        ).to.be.rejectedWith("InvalidMove");
      }
    });

    it("should still allow the path to cross a tile occupied by an ALLY ship", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // Two creator ships: 1n is the mover, 2n (its own ally) sits directly
      // in its path.
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      if (movementRange >= 2) {
        await setShipPosition(game.address, 1n, 1n, 5, 2);
        await setShipPosition(game.address, 1n, 2n, 5, 3);

        await game.write.moveShip([1n, 1n, 5, 4, ActionType.Pass, 0n], {
          account: creator.account,
        });

        const gameData = (await game.read.getGame([
          1n,
        ])) as unknown as GameDataView;
        const newPosition = findShipPosition(gameData, 1n);
        expect(newPosition.row).to.equal(5);
        expect(newPosition.col).to.equal(4);
      }
    });

    // Disabled (0 HP) ships are wreckage, not obstacles (2026-09-28): an
    // enemy that's been shot down to 0 HP no longer blocks passing through
    // its tile — only landing on it, via the pre-existing occupied-tile rule.
    it("should let a ship pass THROUGH a disabled (0 HP) enemy ship, but still not land ON its tile", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // 6n stays healthy so the game keeps going; 7n is the one disabled and
      // parked in the mover's path.
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      if (movementRange >= 2) {
        await setShipPosition(game.address, 1n, 1n, 5, 2);
        await setShipPosition(game.address, 1n, 7n, 5, 3);
        await setShipHullPointsToZero(game.address, 1n, 7n);

        // Landing on the disabled ship's own tile is still illegal.
        await expect(
          game.write.moveShip([1n, 1n, 5, 3, ActionType.Pass, 0n], {
            account: creator.account,
          }),
        ).to.be.rejectedWith("InvalidMove");

        // Passing through it to the tile beyond is legal now.
        await game.write.moveShip([1n, 1n, 5, 4, ActionType.Pass, 0n], {
          account: creator.account,
        });

        const gameData = (await game.read.getGame([
          1n,
        ])) as unknown as GameDataView;
        const newPosition = findShipPosition(gameData, 1n);
        expect(newPosition.row).to.equal(5);
        expect(newPosition.col).to.equal(4);
      }
    });

    it("should prevent movement beyond ship's movement range", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get creator's ship attributes
      const creatorAttributes = await game.read.getShipAttributes([1n, 1]);
      const movementRange = creatorAttributes.movement;

      // Try to move beyond movement range
      await expect(
        game.write.moveShip(
          [1n, 1n, 0, 5 + movementRange + 1, ActionType.Pass, 0n],
          {
            account: creator.account,
          },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should prevent movement when it's not the player's turn", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Try to move joiner's ship when it's creator's turn
      const gameData = (await game.read.getGame([1n])) as GameDataView;
      const ship6Position = findShipPosition(gameData, 6n);
      const ship6TargetCol = await getValidHorizontalDestination(
        game,
        1n,
        6n,
        ship6Position.col,
        4,
        true,
      );
      await expect(
        game.write.moveShip(
          [1n, 6n, ship6Position.row, ship6TargetCol, ActionType.Pass, 0n],
          {
            account: joiner.account,
          },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should prevent moving a ship that doesn't belong to the player", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Try to move joiner's ship with creator's account
      const gameData = (await game.read.getGame([1n])) as GameDataView;
      const ship6Position = findShipPosition(gameData, 6n);
      const ship6TargetCol = await getValidHorizontalDestination(
        game,
        1n,
        6n,
        ship6Position.col,
        4,
        true,
      );
      await expect(
        game.write.moveShip(
          [1n, 6n, ship6Position.row, ship6TargetCol, ActionType.Pass, 0n],
          {
            account: creator.account,
          },
        ),
      ).to.be.rejectedWith("ShipNotOwned");
    });

    it("should prevent moving a ship twice in the same round", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Move ship once
      await game.write.moveShip([1n, 1n, 0, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Try to move the same ship again (should fail because turn switched)
      await expect(
        game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should emit Move event with correct oldRow and oldCol for actual movement", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get initial position
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const initialPosition = findShipPosition(gameData, 1n);
      const oldRow = initialPosition.row;
      const oldCol = initialPosition.col;

      // Move ship to a new position, clamped to its actual (RNG-derived,
      // equipment-dependent) movement stat rather than a hardcoded delta --
      // deploy-sequence changes shift trait/equipment RNG, so a fixed delta
      // can exceed movement.
      const newRow = oldRow;
      const newCol = await getValidHorizontalDestination(
        game,
        1n,
        1n,
        oldCol,
        2,
      );
      if (newCol === oldCol) {
        // Equipment RNG happened to leave this ship with 0 movement this
        // run -- nothing to assert "actual movement" against.
        this.skip();
      }
      await game.write.moveShip([1n, 1n, newRow, newCol, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Get Move events
      const moveEvents = await game.getEvents.Move();
      const latestMoveEvent = moveEvents[moveEvents.length - 1];

      // Verify event was emitted with correct values
      expect(latestMoveEvent).to.not.be.undefined;
      expect(latestMoveEvent.args.gameId).to.equal(1n);
      expect(latestMoveEvent.args.shipId).to.equal(1n);
      expect(latestMoveEvent.args.oldRow).to.equal(oldRow);
      expect(latestMoveEvent.args.oldCol).to.equal(oldCol);
      expect(latestMoveEvent.args.newRow).to.equal(newRow);
      expect(latestMoveEvent.args.newCol).to.equal(newCol);
      expect(latestMoveEvent.args.actionType).to.equal(ActionType.Pass);
      expect(latestMoveEvent.args.targetShipId).to.equal(0n);
    });

    it("should emit Move event with oldRow == newRow and oldCol == newCol for no-op move", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Get initial position
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const initialPosition = findShipPosition(gameData, 1n);
      const currentRow = initialPosition.row;
      const currentCol = initialPosition.col;

      // Move ship to the same position (no-op move)
      await game.write.moveShip(
        [1n, 1n, currentRow, currentCol, ActionType.Pass, 0n],
        {
          account: creator.account,
        },
      );

      // Get Move events
      const moveEvents = await game.getEvents.Move();
      const latestMoveEvent = moveEvents[moveEvents.length - 1];

      // Verify event was emitted with oldRow == newRow and oldCol == newCol
      expect(latestMoveEvent).to.not.be.undefined;
      expect(latestMoveEvent.args.gameId).to.equal(1n);
      expect(latestMoveEvent.args.shipId).to.equal(1n);
      expect(latestMoveEvent.args.oldRow).to.equal(currentRow);
      expect(latestMoveEvent.args.oldCol).to.equal(currentCol);
      expect(latestMoveEvent.args.newRow).to.equal(currentRow);
      expect(latestMoveEvent.args.newCol).to.equal(currentCol);
      expect(latestMoveEvent.args.actionType).to.equal(ActionType.Pass);
      expect(latestMoveEvent.args.targetShipId).to.equal(0n);
    });

    it("should emit Move event with correct oldRow and oldCol for multiple consecutive moves", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        publicClient,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // First move: from (0, 0) to (0, 1)
      const firstMoveTx = await game.write.moveShip(
        [1n, 1n, 0, 1, ActionType.Pass, 0n],
        {
          account: creator.account,
        },
      );
      const firstMoveReceipt = await publicClient.getTransactionReceipt({
        hash: firstMoveTx,
      });

      // Get joiner ship's movement attribute to calculate a valid move
      const joinerAttributes = await game.read.getShipAttributes([1n, 6n]);
      const movement = Number(joinerAttributes.movement);

      // Joiner ship starts at (10, 13) - move it within movement range
      // Move horizontally by movement amount (or less if it would go out of bounds)
      const startCol = 13;
      const maxCol = 16; // GRID_WIDTH - 1
      const newCol = Math.min(startCol + movement, maxCol);

      // Joiner move completes round 1; round 2 starts with second player (joiner when creatorGoesFirst)
      await game.write.moveShip([1n, 6n, 10, newCol, ActionType.Pass, 0n], {
        account: joiner.account,
      });

      // Round 2: joiner goes first (alternating), so joiner moves again before creator
      const gameDataRound2 = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const joinerPosRound2 = findShipPosition(gameDataRound2, 6n);
      await game.write.moveShip(
        [1n, 6n, joinerPosRound2.row, joinerPosRound2.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      // Second move: creator from (0, 1) to (0, 2)
      const secondMoveTx = await game.write.moveShip(
        [1n, 1n, 0, 2, ActionType.Pass, 0n],
        {
          account: creator.account,
        },
      );
      const secondMoveReceipt = await publicClient.getTransactionReceipt({
        hash: secondMoveTx,
      });

      // Parse Move events from transaction receipts
      const firstMoveEvents = parseEventLogs({
        abi: game.abi,
        logs: firstMoveReceipt.logs,
        eventName: "Move",
      });
      const secondMoveEvents = parseEventLogs({
        abi: game.abi,
        logs: secondMoveReceipt.logs,
        eventName: "Move",
      });

      // Find the Move event for ship 1 in each transaction
      const firstMoveEvent = firstMoveEvents.find(
        (e) => e.args.shipId === 1n && e.args.gameId === 1n,
      );
      const secondMoveEvent = secondMoveEvents.find(
        (e) => e.args.shipId === 1n && e.args.gameId === 1n,
      );

      expect(firstMoveEvent).to.not.be.undefined;
      expect(secondMoveEvent).to.not.be.undefined;

      // Verify first move: (0, 0) -> (0, 1)
      expect(firstMoveEvent!.args.oldRow).to.equal(0);
      expect(firstMoveEvent!.args.oldCol).to.equal(0);
      expect(firstMoveEvent!.args.newRow).to.equal(0);
      expect(firstMoveEvent!.args.newCol).to.equal(1);

      // Verify second move: (0, 1) -> (0, 2)
      expect(secondMoveEvent!.args.oldRow).to.equal(0);
      expect(secondMoveEvent!.args.oldCol).to.equal(1);
      expect(secondMoveEvent!.args.newRow).to.equal(0);
      expect(secondMoveEvent!.args.newCol).to.equal(2);
    });

    it("should switch turns correctly with equal fleet sizes", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Check initial turn
      let gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Creator moves first ship
      await game.write.moveShip([1n, 1n, 0, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Verify turn switched to joiner
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Joiner moves first ship
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);

      // Verify turn switched back to creator
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Creator moves second ship
      await game.write.moveShip([1n, 2n, 2, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Verify turn switched to joiner
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Joiner moves second ship (completing the round)
      await moveShipWithinMovement(game, 1n, 7n, joiner.account);

      // Round 2 starts with second player (joiner when creatorGoesFirst)
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Joiner moves in round 2, then creator
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
      await game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
        account: creator.account,
      });
    });

    it("should prevent moving onto a tile occupied by a friendly ship", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Ship 2 is at (1,1); moving ship 1 onto a friendly tile is InvalidMove (ram path rejects same owner).
      await expect(
        game.write.moveShip([1n, 1n, 1, 1, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should allow diagonal movement", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Try diagonal movement (both row and column change) - should work now.
      // Delta is clamped to the ship's actual (RNG-derived, equipment-
      // dependent) movement stat rather than hardcoded, since deploy-
      // sequence changes shift trait/equipment RNG. A true diagonal step
      // needs at least 2 movement (1 row + 1 col); if this ship's rolled
      // equipment left it below that, there's nothing diagonal to test.
      const attributes = await game.read.getShipAttributes([1n, 1n]);
      const movement = Number(attributes.movement);
      const delta = Math.floor(movement / 2);
      if (delta < 1) {
        this.skip();
      }
      await game.write.moveShip([1n, 1n, delta, delta, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Verify the ship moved to the new position
      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const shipPosition = findShipPosition(gameData, 1n);
      expect(shipPosition.row).to.equal(delta);
      expect(shipPosition.col).to.equal(delta);
    });

    it("should handle different fleet sizes correctly", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with different sizes: creator has 3 ships, joiner has 5 ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n, 3n],
        generateStartingPositions([1n, 2n, 3n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n, 9n, 10n],
        generateStartingPositions([6n, 7n, 8n, 9n, 10n], false),
      ]);

      // Round 1: Creator moves first ship (no-op: this test is about
      // turn-passing with uneven fleet sizes, not movement, so stay in place
      // rather than assume a specific random movement stat)
      await game.write.moveShip([1n, 1n, 0, 0, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Round 1: Joiner moves first ship
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);

      // Round 1: Creator moves second ship (no-op, see above)
      await game.write.moveShip([1n, 2n, 1, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Round 1: Joiner moves second ship
      await moveShipWithinMovement(game, 1n, 7n, joiner.account);

      // Round 1: Creator moves third ship (no-op, see above)
      await game.write.moveShip([1n, 3n, 2, 2, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Round 1: Joiner moves third ship
      await moveShipWithinMovement(game, 1n, 8n, joiner.account);

      // Round 1: Joiner moves fourth ship (creator has no more ships, so joiner continues)
      await moveShipWithinMovement(game, 1n, 9n, joiner.account);

      // Round 1: Joiner moves fifth ship (completing the round)
      await moveShipWithinMovement(game, 1n, 10n, joiner.account);

      // Round 2 starts with second player (joiner when creatorGoesFirst)
      let gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      expect(
        (
          (await game.read.getGame([1n])) as any
        ).turnState.currentTurn.toLowerCase(),
      ).to.equal(creator.account.address.toLowerCase());
      await game.write.moveShip([1n, 1n, 0, 0, ActionType.Pass, 0n], {
        account: creator.account,
      });
    });

    it("should prevent destroyed ships from moving", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game (multiple ships so destroying one doesn't end the game)
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Destroy creator's ship
      await destroyShipViaRound(game, 1n, 1n, [
        { shipId: 2n, account: creator.account },
        { shipId: 6n, account: joiner.account },
        { shipId: 7n, account: joiner.account },
      ]);

      // Round 2 starts with joiner (alternating first player) — hand the
      // turn back to creator before checking they can't move ship 1.
      const round2GameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const joinerPos6Round2 = findShipPosition(round2GameData, 6n);
      await game.write.moveShip(
        [
          1n,
          6n,
          joinerPos6Round2.row,
          joinerPos6Round2.col,
          ActionType.Pass,
          0n,
        ],
        { account: joiner.account },
      );

      // Try to move the destroyed ship
      await expect(
        game.write.moveShip([1n, 1n, 0, 1, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("ShipDestroyed");
    });

    it("should end game and record result when all ships of one player are destroyed", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with single ships each
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

      const gameId = 1n;

      // Check initial game status
      const initialGame = await game.read.getGame([gameId]);
      expect(initialGame.metadata.winner).to.equal(
        "0x0000000000000000000000000000000000000000",
      ); // No winner yet

      // Destroy creator's only ship (this should end the game). Creator has
      // no other ship, so ship 1 must Pass once while still healthy (see
      // destroyShipViaRound's selfMoverAccount doc comment) before being
      // primed; then joiner's ship 6 completes the round.
      await destroyShipViaRound(
        game,
        gameId,
        1n,
        [{ shipId: 6n, account: joiner.account }],
        creator.account,
      );

      // Check that the game ended and joiner won
      const finalGame = await game.read.getGame([gameId]);
      expect(finalGame.metadata.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      ); // Joiner wins when creator has no ships

      // Check that the game result was recorded in GameResults
      expect(await gameResults.read.isGameResultRecorded([gameId])).to.be.true;
      const result = await gameResults.read.getGameResult([gameId]);
      expect(result.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(result.loser.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
    });

    it("should exclude destroyed ships from round completion", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Destroy one of creator's ships. Unlike the original instant debug
      // call (which destroyed ship 1 before round 1's moves even started),
      // real destruction only happens once a round completes (reactor
      // timer 2->3) — so this round (creator's ship 2, then joiner's ships
      // 6 and 7) both destroys ship 1 AND stands in for the original
      // test's "round 1" moves in one step. Round 2 (below) is then
      // identical to the original test's round 2: 3 fresh ships (2, 6, 7),
      // no destroyed-ship offsetting needed anymore since ship 1 is
      // already fully gone by the time round 2 starts.
      await destroyShipViaRound(game, 1n, 1n, [
        { shipId: 2n, account: creator.account },
        { shipId: 6n, account: joiner.account },
        { shipId: 7n, account: joiner.account },
      ]);

      // Round 2 starts with joiner (alternating first player)
      const gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      expect(
        (
          (await game.read.getGame([1n])) as any
        ).turnState.currentTurn.toLowerCase(),
      ).to.equal(creator.account.address.toLowerCase());
      // Any legal move completes the round; use the ship's real movement
      // instead of a hardcoded 2-3 tile walk (ships' movement is random and
      // can be as low as 1).
      await moveShipWithinMovement(game, 1n, 2n, creator.account);
    });

    it("should not end round when joiner has more ships until all surviving ships have moved (no skipped ships)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n, 9n],
        generateStartingPositions([6n, 7n, 8n, 9n], false),
      ]);

      // Turn order: creator 1, joiner 6, creator 2 -> then joiner's turn. Destroy 8 and 9 so joiner must still move ship 7.
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos1 = findShipPosition(gameData, 1n);
      await game.write.moveShip(
        [1n, 1n, creatorPos1.row, creatorPos1.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos6 = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [1n, 6n, joinerPos6.row, joinerPos6.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos2 = findShipPosition(gameData, 2n);
      await game.write.moveShip(
        [1n, 2n, creatorPos2.row, creatorPos2.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      // The real reactor-timer mechanism can only destroy a ship as part of
      // COMPLETING a round (it's driven by round-end bookkeeping), so it
      // can't reproduce "destroy two ships instantly mid-round without
      // ending the round" the way the old debug call could. This test's
      // real point — round completion must still wait on a genuinely
      // active ship (7) even though two OTHER ships (8, 9) don't need to
      // move — is exactly as well tested by zeroing 8 and 9's HP instead:
      // a 0-HP ship is counted via shipsWithZeroHP (not required to move)
      // without being destroyed, exercising the identical round-completion
      // accounting this test is actually about.
      await setShipHullPointsToZero(game.address, 1n, 8n);
      await setShipHullPointsToZero(game.address, 1n, 9n);

      const stateAfterDestroy = (await game.read.getGame([1n])) as any;
      expect(stateAfterDestroy.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(stateAfterDestroy.turnState.currentRound).to.equal(1n);

      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos7 = findShipPosition(gameData, 7n);
      await game.write.moveShip(
        [1n, 7n, joinerPos7.row, joinerPos7.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      const stateAfterJoiner7 = (await game.read.getGame([1n])) as any;
      expect(stateAfterJoiner7.turnState.currentRound).to.equal(2n);
      expect(stateAfterJoiner7.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
    });

    it("should remove destroyed ships from grid positions", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
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

      // Verify ship is initially on the grid
      let allShipPositions = await game.read.getAllShipPositions([1n]);
      let shipAt00 = allShipPositions.find(
        (pos) => pos.position.row === 0 && pos.position.col === 0,
      );
      expect(shipAt00?.shipId).to.equal(1n);

      // Destroy the ship (creator has no other ship — see
      // destroyShipViaRound's selfMoverAccount doc comment; joiner's ship 6
      // then completes the round, destroying ship 1 via reactor timer).
      await destroyShipViaRound(
        game,
        1n,
        1n,
        [{ shipId: 6n, account: joiner.account }],
        creator.account,
      );

      // Verify ship is removed from grid
      allShipPositions = await game.read.getAllShipPositions([1n]);
      shipAt00 = allShipPositions.find(
        (pos) => pos.position.row === 0 && pos.position.col === 5,
      );
      expect(shipAt00).to.be.undefined;
    });

    it("should include destroyed ships in getAllShipPositions with destroyed status", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Get initial ship positions
      const initialPositions = (await game.read.getAllShipPositions([
        1n,
      ])) as any;
      expect(initialPositions.length).to.equal(4);

      // For testing purposes, we'll test the 0 hull points behavior by creating a simple scenario
      // where we can verify that the contract logic treats 0 hull points the same as destroyed ships

      // First, let's verify that the contract correctly handles destroyed
      // ships. Unlike the original instant debug call, real destruction
      // only happens once a round completes — so this (creator's ship 2,
      // then joiner's ships 6 and 7) both destroys ship 1 AND stands in for
      // the original test's "round 1" moves, landing us in round 2
      // already (matching the "should exclude destroyed ships from round
      // completion" test's same restructuring above).
      await destroyShipViaRound(game, 1n, 1n, [
        { shipId: 2n, account: creator.account },
        { shipId: 6n, account: joiner.account },
        { shipId: 7n, account: joiner.account },
      ]);

      // Round 2 starts with joiner (alternating)
      let gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Try to move the destroyed ship (should fail) — it's creator's turn.
      await expect(
        game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("ShipDestroyed");

      // Destroyed ships remain in getAllShipPositions (gone list, status = destroyed)
      const updatedPositions = (await game.read.getAllShipPositions([
        1n,
      ])) as any;
      expect(updatedPositions.length).to.equal(4);

      const shipIds = updatedPositions.map((pos: any) => pos.shipId);
      expect(shipIds).to.include(1n);
      expect(shipIds).to.include(2n);
      expect(shipIds).to.include(6n);
      expect(shipIds).to.include(7n);

      const destroyedShip1 = updatedPositions.find(
        (pos: any) => pos.shipId === 1n,
      );
      expect(destroyedShip1).to.not.equal(undefined);
      expect(destroyedShip1.status).to.equal(1); // 1 = destroyed

      // Creator's round-2 move (the ShipDestroyed revert attempt above
      // didn't consume creator's turn).
      // Any legal move completes the round; use the ship's real movement
      // instead of a hardcoded 2-3 tile walk (ships' movement is random and
      // can be as low as 1).
      await moveShipWithinMovement(game, 1n, 2n, creator.account);
    });

    it("should prevent destroying already destroyed ships", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with an extra ship each side (unlike the other
      // single-ship-fleet destroy tests): destroying creator's ONLY ship
      // would end the game immediately (see "should end game and record
      // result..."), leaving no way to submit any further moveShip call at
      // all — this test specifically needs the game to still be live
      // afterward, to attempt a second destroy.
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Destroy ship 1 once (creator's other ship, 2, has no trouble
      // moving, so no selfMoverAccount handoff is needed here).
      await destroyShipViaRound(game, 1n, 1n, [
        { shipId: 2n, account: creator.account },
        { shipId: 6n, account: joiner.account },
        { shipId: 7n, account: joiner.account },
      ]);
      const shipAfterFirstDestroy = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      expect(shipAfterFirstDestroy.shipData.timestampDestroyed).to.not.equal(
        0,
      );

      // Real gameplay has no path left to re-target an already-destroyed
      // ship (moveShip itself already rejects it — see "should prevent
      // destroyed ships from moving" — and every combat resolver requires
      // a live, status==0 target), so `_removeShipFromGame`'s own
      // `ShipDestroyed` guard (the thing this test originally exercised
      // via the debug backdoor) is no longer independently reachable
      // without that backdoor. What's still verifiable: re-priming the
      // same, already-gone ship and completing another round doesn't
      // silently re-process it — `ships.isShipDestroyed` gates the
      // reactor-timer removal path (see Game.sol's
      // _incrementReactorCriticalTimerForZeroHPShips), so
      // timestampDestroyed must stay exactly what it was set to the first
      // time, not get overwritten by a second _removeShipFromGame call.
      // Round 2 starts with joiner (alternating) — drive their ships (6,
      // then 7) to complete it; ship 1 stays inertly re-primed throughout.
      await primeShipForRealDestruction(game.address, 1n, 1n);
      let gameDataRound2 = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      let pos = findShipPosition(gameDataRound2, 6n);
      await game.write.moveShip(
        [1n, 6n, pos.row, pos.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );
      // Ship 2 is creator's only remaining active ship (ship 1 is gone for
      // real; its re-primed shipsWithZeroHP entry is inert dead weight —
      // see above), so round 2 completes as soon as it moves, without
      // needing ship 7 to act.
      gameDataRound2 = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      pos = findShipPosition(gameDataRound2, 2n);
      await game.write.moveShip(
        [1n, 2n, pos.row, pos.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      const shipAfterSecondAttempt = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      expect(shipAfterSecondAttempt.shipData.timestampDestroyed).to.equal(
        shipAfterFirstDestroy.shipData.timestampDestroyed,
      );
    });

    it("should keep turn with player who has more ships", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets: creator has 2 ships, joiner has 3 ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n],
        generateStartingPositions([6n, 7n, 8n], false),
      ]);

      // Round 1: Creator moves first ship
      await game.write.moveShip([1n, 1n, 0, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Verify turn switched to joiner
      let gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Round 1: Joiner moves first ship
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);

      // Verify turn switched back to creator
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Round 1: Creator moves second ship (last ship)
      await game.write.moveShip([1n, 2n, 2, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Verify turn stays with joiner (creator has no more ships)
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Round 1: Joiner moves second ship
      await moveShipWithinMovement(
        game,
        1n,
        7n,
        joiner.account,
        0,
        ActionType.Pass,
        true,
      );

      // Verify turn stays with joiner (creator still has no more ships)
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Round 1: Joiner moves third ship (completing the round)
      await moveShipWithinMovement(game, 1n, 8n, joiner.account);

      // Round 2 starts with joiner (alternating)
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      expect(
        (
          (await game.read.getGame([1n])) as any
        ).turnState.currentTurn.toLowerCase(),
      ).to.equal(creator.account.address.toLowerCase());
      await game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
        account: creator.account,
      });
    });

    it("should handle turn switching correctly when ships are destroyed", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets: both have 3 ships initially
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n, 3n],
        generateStartingPositions([1n, 2n, 3n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n],
        generateStartingPositions([6n, 7n, 8n], false),
      ]);

      // Round 1: Creator moves first ship
      await game.write.moveShip([1n, 1n, 0, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Round 1: Joiner moves first ship
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);

      // Round 1: Creator moves second ship
      await game.write.moveShip([1n, 2n, 2, 1, ActionType.Pass, 0n], {
        account: creator.account,
      });

      // Destroy creator's last unmoved ship (ship 3) — mid-round, after 3
      // real moves already happened, so (as in the earlier "should not end
      // round..." test) the real reactor-timer mechanism can't reproduce
      // this instantly. Zeroing ship 3's HP instead tests the identical
      // "creator has no movable ships left, turn stays with joiner"
      // invariant this test is actually about (see setShipHullPointsToZero
      // above for the same substitution reasoning).
      await setShipHullPointsToZero(game.address, 1n, 3n);

      // Round 1: Joiner moves second ship
      await moveShipWithinMovement(
        game,
        1n,
        7n,
        joiner.account,
        0,
        ActionType.Pass,
        true,
      );

      // After this move, creator has no unmoved ships, so the turn should remain with the joiner
      let gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // Round 1: Joiner moves third ship (completing the round)
      await moveShipWithinMovement(game, 1n, 8n, joiner.account);

      // Round 2 starts with joiner (alternating)
      gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      expect(
        (
          (await game.read.getGame([1n])) as any
        ).turnState.currentTurn.toLowerCase(),
      ).to.equal(creator.account.address.toLowerCase());
      await game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
        account: creator.account,
      });
    });
  });

  describe("Shooting", function () {
    it("should allow a ship to shoot another ship when in range", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with one ship each
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

      // Get initial positions and attributes
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      let creatorPos = findShipPosition(gameData, 1n);
      let joinerPos = findShipPosition(gameData, 6n);
      let creatorAttrs = await game.read.getShipAttributes([1n, 1]);
      let joinerAttrs = await game.read.getShipAttributes([1n, 6n]);

      const creatorRange = creatorAttrs.range;
      const joinerRange = joinerAttrs.range;
      const creatorMovement = creatorAttrs.movement;
      const joinerMovement = joinerAttrs.movement;

      // Choose target positions that are adjacent to each other
      // Creator targets (10, 10), Joiner targets (10, 11) - adjacent positions
      const creatorTarget = { row: 10, col: 10 };
      const joinerTarget = { row: 10, col: 11 };

      // Move ships towards their target positions
      let round = 0;
      let shootingSuccessful = false;

      while (!shootingSuccessful && round < 50) {
        // Re-fetch positions and game state each loop
        gameData = (await game.read.getGame([1n])) as any;
        creatorPos = findShipPosition(gameData, 1n);
        joinerPos = findShipPosition(gameData, 6n);

        // Check if ships are in shooting range
        const manhattanDistance =
          Math.abs(creatorPos.row - joinerPos.row) +
          Math.abs(creatorPos.col - joinerPos.col);

        if (
          manhattanDistance <= creatorRange ||
          manhattanDistance <= joinerRange
        ) {
          // Ships are in range, try to shoot
          const currentTurn = gameData.turnState.currentTurn.toLowerCase();

          if (currentTurn === creator.account.address.toLowerCase()) {
            // Creator's turn - try to shoot
            try {
              await game.write.moveShip(
                [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
                { account: creator.account },
              );
              shootingSuccessful = true;
              break;
            } catch (error) {
              // Move towards target if can't shoot
              let newRow = creatorPos.row;
              let newCol = creatorPos.col;

              if (creatorPos.row !== creatorTarget.row) {
                newRow =
                  creatorPos.row +
                  (creatorTarget.row > creatorPos.row ? 1 : -1);
              } else if (creatorPos.col !== creatorTarget.col) {
                newCol =
                  creatorPos.col +
                  (creatorTarget.col > creatorPos.col ? 1 : -1);
              }

              // Ensure we don't move out of bounds
              newRow = Math.min(Math.max(newRow, 0), 19);
              newCol = Math.min(Math.max(newCol, 0), 29);

              await game.write.moveShip(
                [1n, 1n, newRow, newCol, ActionType.Pass, 0n],
                { account: creator.account },
              );
            }
          } else {
            // Joiner's turn - try to shoot
            try {
              await game.write.moveShip(
                [1n, 6n, joinerPos.row, joinerPos.col, ActionType.Shoot, 1],
                { account: joiner.account },
              );
              shootingSuccessful = true;
              break;
            } catch (error) {
              // Move towards target if can't shoot
              let newRow = joinerPos.row;
              let newCol = joinerPos.col;

              if (joinerPos.row !== joinerTarget.row) {
                newRow =
                  joinerPos.row + (joinerTarget.row > joinerPos.row ? 1 : -1);
              } else if (joinerPos.col !== joinerTarget.col) {
                newCol =
                  joinerPos.col + (joinerTarget.col > joinerPos.col ? 1 : -1);
              }

              // Ensure we don't move out of bounds
              newRow = Math.min(Math.max(newRow, 0), 19);
              newCol = Math.min(Math.max(newCol, 0), 29);

              await game.write.moveShip(
                [1n, 6n, newRow, newCol, ActionType.Pass, 0n],
                { account: joiner.account },
              );
            }
          }
        } else {
          // Ships not in range, move towards targets based on whose turn it is
          const currentTurn = gameData.turnState.currentTurn.toLowerCase();

          if (currentTurn === creator.account.address.toLowerCase()) {
            // Creator's turn - move towards target
            let newRow = creatorPos.row;
            let newCol = creatorPos.col;

            if (creatorPos.row !== creatorTarget.row) {
              newRow =
                creatorPos.row + (creatorTarget.row > creatorPos.row ? 1 : -1);
            } else if (creatorPos.col !== creatorTarget.col) {
              newCol =
                creatorPos.col + (creatorTarget.col > creatorPos.col ? 1 : -1);
            }

            // Ensure we don't move out of bounds
            newRow = Math.min(Math.max(newRow, 0), 19);
            newCol = Math.min(Math.max(newCol, 0), 29);

            await game.write.moveShip(
              [1n, 1n, newRow, newCol, ActionType.Pass, 0n],
              { account: creator.account },
            );
          } else {
            // Joiner's turn - move towards target
            let newRow = joinerPos.row;
            let newCol = joinerPos.col;

            if (joinerPos.row !== joinerTarget.row) {
              newRow =
                joinerPos.row + (joinerTarget.row > joinerPos.row ? 1 : -1);
            } else if (joinerPos.col !== joinerTarget.col) {
              newCol =
                joinerPos.col + (joinerTarget.col > joinerPos.col ? 1 : -1);
            }

            // Ensure we don't move out of bounds
            newRow = Math.min(Math.max(newRow, 0), 19);
            newCol = Math.min(Math.max(newCol, 0), 29);

            await game.write.moveShip(
              [1n, 6n, newRow, newCol, ActionType.Pass, 0n],
              { account: joiner.account },
            );
          }
        }

        round++;
      }

      // Verify that shooting was successful
      expect(shootingSuccessful).to.be.true;

      // Verify that one ship took damage
      const finalCreatorAttrs = await game.read.getShipAttributes([1n, 1]);
      const finalJoinerAttrs = await game.read.getShipAttributes([1n, 6n]);

      // At least one ship should have taken damage (hull points reduced)
      const creatorTookDamage =
        finalCreatorAttrs.hullPoints < creatorAttrs.hullPoints;
      const joinerTookDamage =
        finalJoinerAttrs.hullPoints < joinerAttrs.hullPoints;

      expect(creatorTookDamage || joinerTookDamage).to.be.true;
    });

    it("rejects shooting a ship that was never placed in this game (HA2-01)", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager } =
        await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players — tier 0 mints 5
      // ships per purchase, so joiner ends up with ships 6-10; only ship 6
      // is placed into the fleet below, leaving 7-10 real, joiner-owned,
      // constructed ships that were never part of this (or any) game.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
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
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);

      // Ship 7 exists, is owned by joiner (a different owner than the
      // shooter, so it clears that check), and was never placed in game 1
      // at all — before HA2-01's fix this would pass straight through into
      // the zero-HP "reactor critical" branch and could eventually brick
      // round completion; after the fix it must be rejected immediately,
      // regardless of the shooter's actual position/range.
      await expect(
        game.write.moveShip(
          [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 7n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should block shooting when line of sight is obstructed", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
        maps,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with one ship each
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

      // Use debug moves to position ships exactly where we need them
      // Position creator ship at (10, 5) and joiner ship at (10, 7)
      // This gives us a Manhattan distance of 2, which should be within range
      await setShipPosition(game.address, 1n, 1n, 10, 5);
      await setShipPosition(game.address, 1n, 6n, 10, 7);

      // Place wall tile between the ships to block line of sight
      // Place wall at column 6 (between ships at 5 and 7)
      await maps.write.setBlockedTile([1n, 10, 6, true], {
        account: owner.account,
      });

      // Get current positions and attributes
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      let creatorPos = findShipPosition(gameData, 1n);
      let joinerPos = findShipPosition(gameData, 6n);
      let creatorAttrs = await game.read.getShipAttributes([1n, 1]);

      // Verify ships are in range (Manhattan distance = 10, which should be within range)
      const manhattanDistance =
        Math.abs(creatorPos.row - joinerPos.row) +
        Math.abs(creatorPos.col - joinerPos.col);
      expect(manhattanDistance).to.be.lessThanOrEqual(creatorAttrs.range);

      // Ensure it's the creator's turn before attempting to shoot
      gameData = (await game.read.getGame([1n])) as any;
      if (
        gameData.turnState.currentTurn.toLowerCase() !==
        creator.account.address.toLowerCase()
      ) {
        // Let joiner pass their turn (move in place)
        await game.write.moveShip(
          [1n, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
          { account: joiner.account },
        );
      }

      // Attempt to shoot - should fail due to line of sight being blocked
      await expect(
        game.write.moveShip(
          [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    // Enemy-ship LOS blocking (2026-09-25): same shape as the terrain test
    // above, but the obstruction is a third ship instead of a blocked tile —
    // and only when it's on the OPPOSING side from the shooter. The shot's
    // own target never self-blocks (Game.sol excludes it when building the
    // enemy-occupied bitmap) — this test's success case for a clean line
    // already exercises that: the target itself sits exactly at the
    // destination of the LOS check every time a shot is attempted, so if
    // that exclusion were missing, no shot beyond range 1 would ever land.
    it("should block shooting when line of sight is obstructed by an ENEMY ship, not just terrain", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // 6n is the shot's target; 7n (a second enemy ship) sits between
      // shooter and target, blocking the shot.
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      await setShipPosition(game.address, 1n, 1n, 10, 5);
      await setShipPosition(game.address, 1n, 6n, 10, 7);
      await setShipPosition(game.address, 1n, 7n, 10, 6);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);

      await expect(
        game.write.moveShip(
          [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should NOT block shooting when the obstruction is an ALLY ship", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // 1n is the shooter; 2n (its own ally) sits between shooter and
      // target, and must NOT block the shot.
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipPosition(game.address, 1n, 1n, 10, 5);
      await setShipPosition(game.address, 1n, 6n, 10, 7);
      await setShipPosition(game.address, 1n, 2n, 10, 6);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);

      await game.write.moveShip(
        [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
        { account: creator.account },
      );
      // Reaching here without a revert is the assertion: the ally in the
      // way never blocked the shot.
    });

    // Disabled (0 HP) enemy ships don't block line of sight either
    // (2026-09-28) — same wreckage-isn't-an-obstacle rule as movement.
    it("should NOT block shooting when the obstruction is a disabled (0 HP) enemy ship", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      const totalShipCount = Number(await ships.read.shipCount());
      for (let i = 1; i <= totalShipCount; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
      // Same geometry as the ENEMY-obstruction test above, except the
      // in-between enemy (7n) is disabled, so the shot at 6n now lands.
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      await setShipPosition(game.address, 1n, 1n, 10, 5);
      await setShipPosition(game.address, 1n, 6n, 10, 7);
      await setShipPosition(game.address, 1n, 7n, 10, 6);
      await setShipHullPointsToZero(game.address, 1n, 7n);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);

      await game.write.moveShip(
        [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
        { account: creator.account },
      );
      // Reaching here without a revert is the assertion.
    });

    it("should allow special actions even when line of sight is obstructed (only range matters)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Construct creator's ship with EMP using
      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Create a ship with EMP for creator's first ship (ship 1)
      const empShip: Ship = {
        name: "EMP Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0, // Generic
          armor: 0, // None
          shields: 0, // None
          special: 1, // EMP
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2, // Use valid speed value (0, 1, or 2)
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };

      // Authorize owner to create ships
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      // Construct the EMP ship
      await ships.write.customizeShip([1n, empShip], {
        account: owner.account,
      });

      // Construct joiner's ship
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with one ship each
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

      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;

      // Move ships to positions where they can see each other but with a wall between them
      // Creator at (5, 2), Joiner at (5, 14) - same row, different columns
      // Use debugMove for this
      await setShipPosition(game.address, 1n, 1n, 5, 2);
      await setShipPosition(game.address, 1n, 6n, 5, 14);
      // The ships now sit at those squares, so every move below acts IN PLACE
      // from them. (An earlier version moved to the ships' original start
      // squares, turning this into a 7-tile walk back; it only passed while a
      // ship's movement happened to cover that distance, and failed with
      // InvalidMove from the movement check — not line of sight — once movement
      // changed.)

      // Create a wall between the ships to block line of sight
      // Wall at row 5, columns 8-10 (blocking the direct path)
      for (let col = 8; col <= 10; col++) {
        await maps.write.setBlockedTile([1n, 5, col, true], {
          account: owner.account,
        });
      }

      // Ensure it's creator's turn
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      if (
        gameData.turnState.currentTurn.toLowerCase() !==
        creator.account.address.toLowerCase()
      ) {
        // Let joiner pass their turn
        await game.write.moveShip(
          [1n, 6n, 5, 14, ActionType.Pass, 0n],
          { account: joiner.account },
        );
      }

      // Try to use a special action - should succeed even with obstructed line of sight
      // Note: This test assumes the ship has a special ability. If not, it will fail for that reason, not line of sight.
      // The key point is that line of sight is not checked for special actions.
      try {
        await game.write.moveShip(
          [1n, 1n, 5, 2, ActionType.Special, 6n],
          { account: creator.account },
        );
        // If this succeeds, it means line of sight wasn't checked (which is correct)
        // If it fails, it should be for a reason other than line of sight
      } catch (error) {
        // If it fails, it should be for a reason other than line of sight
        // (e.g., ship doesn't have special ability, out of range, etc.)
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // Resolvers revert with a descriptive error (e.g. OutOfRange,
        // TargetNotEnemy) rather than the generic InvalidMove Game.sol uses
        // elsewhere — a generic InvalidMove here would mean the failure
        // came from somewhere else (e.g. a line-of-sight check leaking into
        // the special-action path), which is exactly what this test guards
        // against.
        expect(errorMessage).to.not.include("InvalidMove");
        // The error should be something like "ship doesn't have special ability" not "line of sight blocked"
      }
    });
  });

  describe("Ships with 0 Hull Points", function () {
    it("should treat ships with 0 hull points the same as destroyed ships, but should still be included in getAllShipPositions", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Get initial ship positions
      const initialPositions = (await game.read.getAllShipPositions([
        1n,
      ])) as any;
      expect(initialPositions.length).to.equal(4);

      // Use debug function to set ship 1's hull points to 0
      await setShipHullPointsToZero(game.address, 1n, 1);

      // Verify ship 1 has 0 hull points
      expect((await game.read.getShipAttributes([1n, 1])).hullPoints).to.equal(
        0,
      );

      // Try to move the ship with 0 hull points (should fail)
      await expect(
        game.write.moveShip([1n, 1n, 0, 2, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("ShipDestroyed");

      // Verify the ship with 0 hull points is still included in getAllShipPositions
      const updatedPositions = (await game.read.getAllShipPositions([
        1n,
      ])) as any;
      expect(updatedPositions.length).to.equal(4); // Still 4 ships now

      // Verify ship 1 is still in the positions (allowing it to be repaired)
      const shipIds = updatedPositions.map((pos: any) => pos.shipId);
      expect(shipIds).to.include(1n);
      expect(shipIds).to.include(2n);
      expect(shipIds).to.include(6n);
      expect(shipIds).to.include(7n);

      // Verify round completion works correctly with the ship having 0 hull points
      // Move the remaining ships to complete the round
      // Any legal move completes the round; use the ship's real movement
      // instead of a hardcoded 2-3 tile walk (ships' movement is random and
      // can be as low as 1).
      await moveShipWithinMovement(game, 1n, 2n, creator.account);
      await moveShipWithinMovement(
        game,
        1n,
        6n,
        joiner.account,
        0,
        ActionType.Pass,
        true,
      );
      await moveShipWithinMovement(
        game,
        1n,
        7n,
        joiner.account,
        0,
        ActionType.Pass,
        true,
      );

      // Round 2 starts with joiner (alternating)
      const gameData = (await game.read.getGame([1n])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      expect(
        (
          (await game.read.getGame([1n])) as any
        ).turnState.currentTurn.toLowerCase(),
      ).to.equal(creator.account.address.toLowerCase());
      // Any legal move completes the round; use the ship's real movement
      // instead of a hardcoded 2-3 tile walk (ships' movement is random and
      // can be as low as 1).
      await moveShipWithinMovement(game, 1n, 2n, creator.account);
    });
  });

  describe("Round completion (moved ∩ zero HP)", function () {
    it("does not end the round early when a ship moved then was reduced to 0 HP the same round", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
        [1n, 2n, 3n],
        generateStartingPositions([1n, 2n, 3n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n, 8n],
        generateStartingPositions([6n, 7n, 8n], false),
      ]);

      await setShipHullPointsToZero(game.address, 1n, 1n);

      await setShipPosition(game.address, 1n, 1n, 0, 0);
      await setShipPosition(game.address, 1n, 2n, 5, 5);
      await setShipPosition(game.address, 1n, 3n, 5, 7);
      // Adjacent line so opening shot and finisher are range 1 (no LOS map dependency)
      await setShipPosition(game.address, 1n, 6n, 5, 6);
      await setShipPosition(game.address, 1n, 7n, 8, 13);
      await setShipPosition(game.address, 1n, 8n, 9, 14);

      let gameData = (await game.read.getGame([1n])) as GameDataView;
      expect(gameData.turnState.currentRound).to.equal(1n);
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      const ship6Before = await game.read.getShipAttributes([1n, 6n]);
      expect(ship6Before.hullPoints).to.be.greaterThan(0);

      // 1) Creator ship 2 passes in round 1 (no damage yet) — ship 6 must
      // stay alive through round 1 so the "moved then reduced to 0 HP" case
      // this test targets can land in round 2 instead. Leaving ship 6 at
      // full HP into round 2 maximizes the damage margin for the two real
      // shots that finish it off there (ships' gun damage/hull points are
      // randomly generated per deploy, so relying on an exact hit count
      // against a partially-damaged target is fragile; two full-power hits
      // against a full-health target is not).
      const pos2 = findShipPosition(gameData, 2n);
      await game.write.moveShip(
        [1n, 2n, pos2.row, pos2.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      // 2) Joiner 6 passes (now in shipMovedThisRound)
      gameData = (await game.read.getGame([1n])) as GameDataView;
      const pos6 = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [1n, 6n, pos6.row, pos6.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      // 3) Creator ship 3 also passes in round 1 — ship 6 reaches round 2
      // undamaged.
      gameData = (await game.read.getGame([1n])) as GameDataView;
      const pos3 = findShipPosition(gameData, 3n);
      await game.write.moveShip(
        [1n, 3n, pos3.row, pos3.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      // 4) Joiner 7 passes
      gameData = (await game.read.getGame([1n])) as GameDataView;
      const pos7 = findShipPosition(gameData, 7n);
      await game.write.moveShip(
        [1n, 7n, pos7.row, pos7.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      gameData = (await game.read.getGame([1n])) as GameDataView;
      expect(gameData.turnState.currentRound).to.equal(1n);
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // 5) Joiner 8 still gets to act before round 1 completes
      const pos8 = findShipPosition(gameData, 8n);
      await game.write.moveShip(
        [1n, 8n, pos8.row, pos8.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      // Round 1 closes out (ship 1's permanent debug 0-HP state plus the five
      // real actions above account for all six ships), moving into round 2 with
      // ship 6 still alive at low HP and shipMovedThisRound cleared.
      gameData = (await game.read.getGame([1n])) as GameDataView;
      expect(gameData.turnState.currentRound).to.equal(2n);
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      // 6) Round 2 onward: joiner ship 6 passes first (entering
      // shipMovedThisRound), then creator ships 3 and 2 each take a real
      // shot at it. Ships' gun damage / max hull points are randomly
      // generated per deploy — and shift with anything that changes the
      // number of prior on-chain operations, including unrelated test
      // files — so the exact number of rounds needed to bring ship 6 to 0
      // HP isn't knowable in advance. Loop, reading actual on-chain hull
      // points after each shot, until it actually dies (bounded well above
      // any realistic hit count), then verify round completion doesn't
      // double-count it in the round the kill actually lands in — the
      // case under test.
      //
      // Who goes first alternates each round (round 1 above was
      // creator-first; round 2 is joiner-first; round 3 back to
      // creator-first; ...), so which side's ships act in which slot isn't
      // fixed — read currentTurn each round and dispatch accordingly. In a
      // creator-first round, creator's first ship must act before ship 6
      // has moved, so it's a harmless pass; the real shots always land only
      // after ship 6's own pass, whichever round shape is in play.
      async function passAction(shipId: bigint, account: any) {
        const g = (await game.read.getGame([1n])) as GameDataView;
        const pos = findShipPosition(g, shipId);
        await game.write.moveShip(
          [1n, shipId, pos.row, pos.col, ActionType.Pass, 0n],
          { account },
        );
      }

      async function shootShip6(shipId: bigint, account: any) {
        const g = (await game.read.getGame([1n])) as GameDataView;
        const pos = findShipPosition(g, shipId);
        await game.write.moveShip(
          [1n, shipId, pos.row, pos.col, ActionType.Shoot, 6n],
          { account },
        );
      }

      async function ship6IsDead() {
        return (
          (await game.read.getShipAttributes([1n, 6n])).hullPoints === 0
        );
      }

      // Asserts the case under test: even though ship 6 is now both
      // moved-this-round and zero-HP, the round must not complete until
      // every other active ship also acts.
      async function assertRoundStillOpen(loopRound: number) {
        const g = (await game.read.getGame([1n])) as GameDataView;
        expect(g.turnState.currentRound).to.equal(BigInt(loopRound + 1));
        expect(g.turnState.currentTurn.toLowerCase()).to.equal(
          joiner.account.address.toLowerCase(),
        );
      }

      const MAX_ROUNDS = 10;
      let ship6Dead = false;
      let round = 0;
      while (!ship6Dead && round < MAX_ROUNDS) {
        round++;

        gameData = (await game.read.getGame([1n])) as GameDataView;
        const creatorFirst =
          gameData.turnState.currentTurn.toLowerCase() ===
          creator.account.address.toLowerCase();

        if (creatorFirst) {
          await passAction(3n, creator.account); // ship 6 hasn't moved yet
          await passAction(6n, joiner.account); // now moved
          await shootShip6(2n, creator.account); // safe: ship 6 already moved
          if (await ship6IsDead()) {
            ship6Dead = true;
            await assertRoundStillOpen(round);
          }
          await passAction(7n, joiner.account);
          await passAction(8n, joiner.account);
        } else {
          await passAction(6n, joiner.account); // moved
          await shootShip6(3n, creator.account);
          if (await ship6IsDead()) {
            ship6Dead = true;
            await assertRoundStillOpen(round);
          }
          await passAction(7n, joiner.account);
          if (!ship6Dead) {
            await shootShip6(2n, creator.account);
            if (await ship6IsDead()) {
              ship6Dead = true;
              await assertRoundStillOpen(round);
            }
          } else {
            await passAction(2n, creator.account);
          }
          await passAction(8n, joiner.account);
        }
      }

      expect(ship6Dead).to.be.true;
      expect(await ship6IsDead()).to.be.true;

      // Only now, after every remaining ship acted this round, should the
      // round (and the already-dead ship 6 within it) roll over.
      gameData = (await game.read.getGame([1n])) as GameDataView;
      expect(gameData.turnState.currentRound).to.equal(BigInt(round + 2));
    });
  });

  describe("Ram (ActionType.FactionAbility, faction 1)", function () {
    // Ram is resolver-backed (RamResolver) and dispatched by
    // traits.variant alone — every faction-1 ship has it regardless of
    // loadout, so this only needs to set the ship's faction via
    // customizeShip (owner authorized, same mechanism the
    // EMP/RepairDrones/FlakArray tests use), not its equipped special.
    async function setShipFaction(
      ships: any,
      owner: any,
      shipId: bigint,
      variant: number,
    ) {
      const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      ship.traits.variant = variant;
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.customizeShip([shipId, ship], {
        account: owner.account,
      });
    }

    it("evicts a 0 HP enemy, applies 1 reactor damage to the rammer, and relocates it onto the victim's tile", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      await setShipFaction(ships, owner, 1n, 1);

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

      await setShipPosition(game.address, 1n, 1n, 5, 5);
      await setShipPosition(game.address, 1n, 6n, 5, 6);
      await setShipHullPointsToZero(game.address, 1n, 6n);

      expect(
        (await game.read.getShipAttributes([1n, 1n])).reactorCriticalTimer,
      ).to.equal(0);

      // No-op move (stay at (5,5)), then Ram ship 6 (adjacent, within range 1)
      await game.write.moveShip(
        [1n, 1n, 5, 5, ActionType.FactionAbility, 6n],
        { account: creator.account },
      );

      const attrsAfter = await game.read.getShipAttributes([1n, 1n]);
      expect(attrsAfter.reactorCriticalTimer).to.equal(1);
      const gameAfter = (await game.read.getGame([1n])) as GameDataView;
      const pos1 = findShipPosition(gameAfter, 1n);
      expect(pos1.row).to.equal(5);
      expect(pos1.col).to.equal(6);
      expect(gameAfter.joinerActiveShipIds).to.not.include(6n);
    });

    it("reverts when a non-faction-1 ship attempts a faction ability", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      // Faction 2 (variant 2) has its own real resolver now (RepairResolver),
      // so it's no longer naturally "unconfigured" the way this test needs —
      // explicitly unset it for just this test instead of switching to a
      // different variant number, which would need its own full
      // ShipAttributes setup (cost/traits config) that this fixture doesn't
      // provide for anything beyond variants 1/2.
      await game.write.setFactionAbilityResolver([2, zeroAddress], {
        account: owner.account,
      });
      await setShipFaction(ships, owner, 1n, 2);

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

      await setShipPosition(game.address, 1n, 1n, 5, 5);
      await setShipPosition(game.address, 1n, 6n, 5, 6);
      await setShipHullPointsToZero(game.address, 1n, 6n);

      await expect(
        game.write.moveShip(
          [1n, 1n, 5, 5, ActionType.FactionAbility, 6n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("reverts when ramming a friendly ship at 0 HP", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      await setShipFaction(ships, owner, 1n, 1);

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipPosition(game.address, 1n, 1n, 5, 5);
      await setShipPosition(game.address, 1n, 2n, 5, 6);
      await setShipHullPointsToZero(game.address, 1n, 2n);

      // Ship 2 is friendly (same side as ship 1) — Ram can only hit the
      // opposing side, even though ship 2 is at 0 HP.
      await expect(
        game.write.moveShip(
          [1n, 1n, 5, 5, ActionType.FactionAbility, 2n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidRamTarget");
    });

    it("reverts before ever reaching the resolver when the target ship doesn't exist", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      await setShipFaction(ships, owner, 1n, 1);

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

      await setShipPosition(game.address, 1n, 1n, 5, 5);

      // 9999n was never minted — Game.sol/SpecialEffectsLib must reject this
      // before ever calling out to RamResolver (defense in depth: Game.sol
      // guarantees a non-zero target exists, rather than trusting every
      // resolver to check this itself).
      await expect(
        game.write.moveShip(
          [1n, 1n, 5, 5, ActionType.FactionAbility, 9999n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("ShipNotFound");
    });

    it("reverts when destination is occupied by a living enemy", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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

      await setShipPosition(game.address, 1n, 1n, 5, 5);
      await setShipPosition(game.address, 1n, 6n, 5, 6);

      await expect(
        game.write.moveShip([1n, 1n, 5, 6, ActionType.Pass, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("InvalidMove");
    });

  });

  describe("Reactor Critical Timer", function () {
    it("ends the game cleanly when two 0-HP ships hit timer 3 on the same tick (HA6-02)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
      } = await loadFixture(deployGameFixture);

      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      for (let i = 1; i <= 10; i++) {
        const ship = tupleToShip(
          (await ships.read.ships([BigInt(i)])) as ShipTuple,
        );
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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Creator goes first (selected fleet first). creator 1 -> joiner 6 ->
      // creator 2 would complete the round once joiner's 7 counts as 0-HP.
      const pass = async (shipId: bigint, account: any) => {
        const gd = (await game.read.getGame([1n])) as unknown as GameDataView;
        const pos = findShipPosition(gd, shipId);
        await game.write.moveShip(
          [1n, shipId, pos.row, pos.col, ActionType.Pass, 0n],
          { account },
        );
      };
      await pass(1n, creator.account);
      await pass(6n, joiner.account);

      // Both of joiner's ships are downed with identical timers, so both
      // reach 3 on the same round-start tick. The first removal leaves
      // joiner with no active ship and ends the game (clearing fleets); the
      // second removal used to revert ShipNotFound, unwinding the move.
      await primeShipForRealDestruction(game.address, 1n, 6n);
      await primeShipForRealDestruction(game.address, 1n, 7n);

      await pass(2n, creator.account);

      const finalGame = await game.read.getGame([1n]);
      expect(finalGame.metadata.ended).to.equal(true);
      expect(finalGame.metadata.winner.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
    });

    it("should increment reactor critical timer when shooting ships with 0 HP", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with one ship each
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

      // Move ships toward each other until in range (similar to shooting test)
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;

      // Place ships very close together for this test.
      // Move within actual ship movement so this remains deterministic.
      await moveShipWithinMovement(game, 1n, 1n, creator.account);
      // Move joiner ship toward the creator ship within its movement range
      await moveShipWithinMovement(game, 1n, 6n, joiner.account);
      // Ensure it's creator's turn
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      if (
        gameData.turnState.currentTurn.toLowerCase() !==
        creator.account.address.toLowerCase()
      ) {
        // If it's joiner's turn, have them move in place to make it creator's turn
        gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
        const joinerPos = findShipPosition(gameData, 6n);
        await game.write.moveShip(
          [1n, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
          { account: joiner.account },
        );
      }

      // Now use debug to make joiner's ship (ship 6) HP zero
      await setShipHullPointsToZero(game.address, 1n, 6n);

      // Verify ship 6 has 0 HP and 0 reactor critical timer
      const ship6Attrs = await game.read.getShipAttributes([1n, 6n]);
      expect(ship6Attrs.hullPoints).to.equal(0);
      expect(ship6Attrs.reactorCriticalTimer).to.equal(0);

      // Use debug function to place ships close together for shooting
      await setShipPosition(game.address, 1n, 1n, 4, 0);
      await setShipPosition(game.address, 1n, 6n, 4, 2);

      // Have creator's ship shoot joiner's ship (which has 0 HP)
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);
      await game.write.moveShip(
        [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Shoot, 6n],
        { account: creator.account },
      );

      // Verify reactor critical timer was incremented by 2:
      // 1 for being shot while having 0 HP, plus 1 for starting a new round with 0 HP
      const ship6AttrsAfter = await game.read.getShipAttributes([1n, 6n]);
      expect(ship6AttrsAfter.reactorCriticalTimer).to.equal(
        ship6Attrs.reactorCriticalTimer + 2,
      );
    });

    it("should increment reactor critical timer for ships with 0 HP at the beginning of a round", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with two creator ships so creator can move one while the other has 0 HP
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // Complete the first round (turn order: creator, joiner, creator)
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos1 = findShipPosition(gameData, 1n);
      await game.write.moveShip(
        [1n, 1n, creatorPos1.row, creatorPos1.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [1n, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos2 = findShipPosition(gameData, 2n);
      await game.write.moveShip(
        [1n, 2n, creatorPos2.row, creatorPos2.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      // Now set creator's ship 1 HP to 0 (after round has ended)
      await setShipHullPointsToZero(game.address, 1n, 1);

      const ship1Attrs = await game.read.getShipAttributes([1n, 1]);
      expect(ship1Attrs.hullPoints).to.equal(0);
      expect(ship1Attrs.reactorCriticalTimer).to.equal(0);

      // Round 2 starts with joiner (alternating); joiner moves first, then creator moves ship 2
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos2 = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [1n, 6n, joinerPos2.row, joinerPos2.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos2Again = findShipPosition(gameData, 2n);
      await game.write.moveShip(
        [
          1n,
          2n,
          creatorPos2Again.row,
          creatorPos2Again.col,
          ActionType.Pass,
          0n,
        ],
        { account: creator.account },
      );

      const ship1AttrsAfter = await game.read.getShipAttributes([1n, 1]);
      expect(ship1AttrsAfter.reactorCriticalTimer).to.equal(1);
    });

    it("should destroy ships with reactor critical timer >= 3 at the end of a round", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with two ships each
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Use debug to set player 1's first ship's HP to zero
      await setShipHullPointsToZero(game.address, 1n, 1);

      // Have all players use no-op moves until ship 1's reactor critical timer is 3
      // Odd game rounds (1, 3): creator first. Even (2): joiner first.
      let round = 0;
      while (round < 3) {
        const gameData = (await game.read.getGame([
          1n,
        ])) as unknown as GameDataView;
        const creatorPos2 = findShipPosition(gameData, 2n);
        const joinerPos1 = findShipPosition(gameData, 6n);
        const joinerPos2 = findShipPosition(gameData, 7n);

        if (round % 2 === 0) {
          // Round 1, 3: creator first
          await game.write.moveShip(
            [1n, 2n, creatorPos2.row, creatorPos2.col, ActionType.Pass, 0n],
            { account: creator.account },
          );
          await game.write.moveShip(
            [1n, 6n, joinerPos1.row, joinerPos1.col, ActionType.Pass, 0n],
            { account: joiner.account },
          );
          await game.write.moveShip(
            [1n, 7n, joinerPos2.row, joinerPos2.col, ActionType.Pass, 0n],
            { account: joiner.account },
          );
        } else {
          // Round 2: joiner first; order joiner 6, creator 2, joiner 7
          await game.write.moveShip(
            [1n, 6n, joinerPos1.row, joinerPos1.col, ActionType.Pass, 0n],
            { account: joiner.account },
          );
          await game.write.moveShip(
            [1n, 2n, creatorPos2.row, creatorPos2.col, ActionType.Pass, 0n],
            { account: creator.account },
          );
          await game.write.moveShip(
            [1n, 7n, joinerPos2.row, joinerPos2.col, ActionType.Pass, 0n],
            { account: joiner.account },
          );
        }
        round++;
      }

      // Ship 1 reaches timer 3 at start of round 3 and is destroyed instantly (no longer at end of round)
      // Verify ship 1 was destroyed due to critical reactor timer
      const ship1Tuple = await ships.read.ships([1n]);
      const ship1 = tupleToShip(ship1Tuple);
      expect(ship1.shipData.timestampDestroyed).to.not.equal(0);

      // Destroyed ship 1 stays in getAllShipPositions (gone list)
      const positions = (await game.read.getAllShipPositions([1n])) as any;
      expect(positions.length).to.equal(4);

      const remainingShipIds = positions.map((pos: any) => pos.shipId);
      expect(remainingShipIds).to.include(1n);
      expect(remainingShipIds).to.include(2n);
      expect(remainingShipIds).to.include(6n);
      expect(remainingShipIds).to.include(7n);

      const destroyedShip1 = positions.find((pos: any) => pos.shipId === 1n);
      expect(destroyedShip1).to.not.equal(undefined);
      expect(destroyedShip1.status).to.equal(1);

      // Round 4: totalActiveShipsAtRoundStart=4, shipsRemovedThisRound=1 (ship 1 destroyed at round start). Need 3 moves.
      // Round 4 is even -> joiner first. Order: joiner 6, creator 2, joiner 7 -> round completes; round 5 starts with creator.
      const gameDataAfterDestroy = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const joinerPos1After = findShipPosition(gameDataAfterDestroy, 6n);
      const joinerPos2After = findShipPosition(gameDataAfterDestroy, 7n);
      const creatorPos2After = findShipPosition(gameDataAfterDestroy, 2n);
      await game.write.moveShip(
        [1n, 6n, joinerPos1After.row, joinerPos1After.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );
      await game.write.moveShip(
        [
          1n,
          2n,
          creatorPos2After.row,
          creatorPos2After.col,
          ActionType.Pass,
          0n,
        ],
        { account: creator.account },
      );
      await game.write.moveShip(
        [1n, 7n, joinerPos2After.row, joinerPos2After.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      // Move remaining ships to new positions (round 5; creator's turn)
      const gameDataFinal = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const creatorPos2Final = findShipPosition(gameDataFinal, 2n);
      const joinerPos6Final = findShipPosition(gameDataFinal, 6n);
      await game.write.moveShip(
        [
          1n,
          2n,
          creatorPos2Final.row + 1,
          creatorPos2Final.col,
          ActionType.Pass,
          0n,
        ],
        { account: creator.account },
      );
      await game.write.moveShip(
        [
          1n,
          6n,
          joinerPos6Final.row - 1,
          joinerPos6Final.col - 1,
          ActionType.Pass,
          0n,
        ],
        { account: joiner.account },
      );
    });

    it("should allow ships to retreat and remove them from the game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with two ships each
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Get initial ship positions
      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos1 = findShipPosition(gameData, 1n);
      const joinerPos1 = findShipPosition(gameData, 6n);

      // Have creator's ship 1 retreat
      await game.write.moveShip(
        [1n, 1n, creatorPos1.row, creatorPos1.col, ActionType.Retreat, 0n],
        { account: creator.account },
      );

      // Fled ship 1 is not on the grid but is still listed in getAllShipPositions (gone list)
      const allShipPositions = await game.read.getAllShipPositions([1n]);
      const fledShip1 = allShipPositions.find((pos) => pos.shipId === 1n);
      expect(fledShip1).to.not.equal(undefined);
      expect(fledShip1!.status).to.equal(2); // 2 = fled
      expect(fledShip1!.position.row).to.equal(creatorPos1.row);
      expect(fledShip1!.position.col).to.equal(creatorPos1.col);

      const positions = (await game.read.getAllShipPositions([1n])) as any;
      expect(positions.length).to.equal(4);

      const remainingShipIds = positions.map((pos: any) => pos.shipId);
      expect(remainingShipIds).to.include(1n);
      expect(remainingShipIds).to.include(2n);
      expect(remainingShipIds).to.include(6n);
      expect(remainingShipIds).to.include(7n);

      // Verify that the game can continue with remaining ships
      // After retreat, it should be joiner's turn
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos1After = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [
          1n,
          6n,
          joinerPos1After.row - 1,
          joinerPos1After.col - 1,
          ActionType.Pass,
          0n,
        ],
        { account: joiner.account },
      );

      // Now it should be creator's turn to move ship 2
      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos2 = findShipPosition(gameData, 2n);
      await game.write.moveShip(
        [1n, 2n, creatorPos2.row + 1, creatorPos2.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
    });

    it("should allow retreat (flee) for a ship with 0 HP as creator's turn", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      let gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const creatorPos1 = findShipPosition(gameData, 1n);

      await setShipHullPointsToZero(game.address, 1n, 1);
      const ship1Attrs = await game.read.getShipAttributes([1n, 1]);
      expect(ship1Attrs.hullPoints).to.equal(0);

      // Retreat (flee) ship 1 as creator's turn (Retreat allowed for 0 HP and already-moved ships)
      await game.write.moveShip(
        [1n, 1n, creatorPos1.row, creatorPos1.col, ActionType.Retreat, 0n],
        { account: creator.account },
      );

      const positions = (await game.read.getAllShipPositions([1n])) as any;
      expect(positions.length).to.equal(4);
      const remainingShipIds = positions.map((pos: any) => pos.shipId);
      expect(remainingShipIds).to.include(1n);
      expect(remainingShipIds).to.include(2n);
      expect(remainingShipIds).to.include(6n);
      expect(remainingShipIds).to.include(7n);

      const fledShip1 = positions.find((pos: any) => pos.shipId === 1n);
      expect(fledShip1).to.not.equal(undefined);
      expect(fledShip1.status).to.equal(2); // 2 = fled

      gameData = (await game.read.getGame([1n])) as unknown as GameDataView;
      const joinerPos1 = findShipPosition(gameData, 6n);
      await game.write.moveShip(
        [1n, 6n, joinerPos1.row - 1, joinerPos1.col - 1, ActionType.Pass, 0n],
        { account: joiner.account },
      );
    });

    it("should allow ships with RepairDrones to repair friendly ships", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Create a ship with RepairDrones for creator's first ship (ship 1)
      const repairShip: Ship = {
        name: "Repair Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0, // Generic
          armor: 0, // None
          shields: 0, // None
          special: 2, // RepairDrones
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2, // Use valid speed value (0, 1, or 2)
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };

      // Authorize owner to create ships
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      // Construct the repair ship
      await ships.write.customizeShip([1n, repairShip], {
        account: owner.account,
      });

      // Construct the second ship normally
      await ships.write.constructShip([2n], { account: creator.account });

      // Construct joiner's ship
      await ships.write.constructShip([6n], { account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      // Set ship 2's HP to 0 using debug function
      await setShipHullPointsToZero(game.address, 1n, 2n);

      // Verify ship 2 has 0 HP
      const ship2AttrsBefore = await game.read.getShipAttributes([1n, 2n]);
      expect(ship2AttrsBefore.hullPoints).to.equal(0);

      // Get ship positions
      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const ship1Pos = findShipPosition(gameData, 1n);
      const ship2Pos = findShipPosition(gameData, 2n);

      // Move ship 1 to be within range 3 of ship 2 and use RepairDrones special
      // Since RepairDrones has range 3, we can move ship 1 to position (2, 0) which is adjacent to ship 2 at (1, 0)
      await game.write.moveShip([1n, 1n, 2, 0, ActionType.Special, 2n], {
        account: creator.account,
      });

      // Verify ship 2's HP was increased by the repair strength (40)
      const ship2AttrsAfter = await game.read.getShipAttributes([1n, 2n]);
      expect(ship2AttrsAfter.hullPoints).to.equal(40); // Should be exactly 40 since RepairDrones restores 40 HP
    });

    it("should cap a RepairDrones heal at healCapPercent of maxHullPoints instead of the full 40", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      const repairShip: Ship = {
        name: "Repair Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0,
          armor: 0,
          shields: 0,
          special: 2, // RepairDrones
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2,
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.customizeShip([1n, repairShip], {
        account: owner.account,
      });
      await ships.write.constructShip([2n], { account: creator.account });
      await ships.write.constructShip([6n], { account: joiner.account });

      // UA-06 fix (2026-09-29): healCapPercent is now pinned per-game at
      // startGame, so this must be set BEFORE the game starts (before the
      // joiner's fleet completes the pair below) to actually apply to it —
      // setting it on an already-active game no longer retroactively
      // changes that game's cap, by design.
      const capPercent = 1;
      await game.write.setHealCapPercent([capPercent], {
        account: owner.account,
      });
      expect(await game.read.healCapPercent()).to.equal(capPercent);

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipHullPointsToZero(game.address, 1n, 2n);
      const { maxHullPoints } = await game.read.getShipAttributes([1n, 2n]);

      // Deliberately far below RepairDrones' fixed 40-HP strength (the
      // baseline test above confirms maxHullPoints >= 40, since an
      // uncapped heal there lands at exactly 40) — 1% is guaranteed to
      // bite regardless of this ship's actual max HP.
      const expectedCap = (Number(maxHullPoints) * capPercent) / 100; // integer division, matches _applyHullDelta's Solidity math

      await game.write.moveShip([1n, 1n, 2, 0, ActionType.Special, 2n], {
        account: creator.account,
      });

      const ship2AttrsAfter = await game.read.getShipAttributes([1n, 2n]);
      expect(ship2AttrsAfter.hullPoints).to.equal(Math.floor(expectedCap));
      expect(ship2AttrsAfter.hullPoints).to.be.lessThan(40);
    });

    // Shared setup for the HA6-24/25 heal tests: creator [1 (RepairDrones),
    // 2], joiner [6]; ship 2 knocked to 0 HP; optional heal cap set first.
    async function setUpRepairOnDownedAlly(capPercent?: number, downShip2 = true) {
      const f = await loadFixture(deployGameFixture);
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } = f;
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      for (let i = 1; i <= 10; i++) {
        const ship = tupleToShip((await ships.read.ships([BigInt(i)])) as ShipTuple);
        await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      }
      const colors = { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 };
      await ships.write.setIsAllowedToCreateShips([owner.account.address, true], {
        account: owner.account,
      });
      await ships.write.customizeShip(
        [
          1n,
          {
            name: "Repair Ship",
            id: 1n,
            equipment: { mainWeapon: 0, armor: 0, shields: 0, special: 2 },
            traits: { serialNumber: 12345n, colors, variant: 1, accuracy: 0, hull: 0, speed: 2 },
            shipData: {
              shipsDestroyed: 0, costsVersion: 1, cost: 0, shiny: false, constructed: false,
              inFleet: false, isFreeShip: false, modified: 0, timestampDestroyed: 0n,
            },
            owner: creator.account.address,
          },
        ],
        { account: owner.account },
      );
      await ships.write.constructShip([2n], { account: creator.account });
      await ships.write.constructShip([6n], { account: joiner.account });
      if (capPercent !== undefined) {
        await game.write.setHealCapPercent([capPercent], { account: owner.account });
      }
      await creatorLobbies.write.createLobby([1000n, 300n, true, 0n, 100n, zeroAddress]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([1n, [1n, 2n], generateStartingPositions([1n, 2n], true)]);
      await joinerLobbies.write.createFleet([1n, [6n], generateStartingPositions([6n], false)]);
      if (downShip2) await setShipHullPointsToZero(game.address, 1n, 2n);
      return f;
    }

    it("a ship that already moved, was knocked to 0 HP, then revived the same round can't act twice (HA6-24)", async function () {
      const { game, creator, joiner } = await setUpRepairOnDownedAlly(undefined, false);
      // Ship 1 (RepairDrones) at (5,3), ship 2 at (5,5), enemy ship 6 adjacent at (5,6).
      await setShipPosition(game.address, 1n, 1n, 5, 3);
      await setShipPosition(game.address, 1n, 2n, 5, 5);
      await setShipPosition(game.address, 1n, 6n, 5, 6);
      await setShipHullPoints(game.address, 1n, 2n, 1);

      // Ship 2 acts first this round.
      await game.write.moveShip([1n, 2n, 5, 5, ActionType.Pass, 0n], { account: creator.account });
      // The enemy knocks it to 0 HP (this clears its moved flag).
      await game.write.moveShip([1n, 6n, 5, 6, ActionType.Shoot, 2n], { account: joiner.account });
      expect((await game.read.getShipAttributes([1n, 2n])).hullPoints).to.equal(0);
      // Ship 1 revives it.
      await game.write.moveShip([1n, 1n, 5, 3, ActionType.Special, 2n], { account: creator.account });
      expect((await game.read.getShipAttributes([1n, 2n])).hullPoints).to.be.greaterThan(0);

      // Ship 2 already acted, so every ship has moved and the round ends.
      // Before the fix ship 2 counted as unmoved and got a second turn.
      const gd = (await game.read.getGame([1n])) as unknown as GameDataView;
      expect(gd.turnState.currentRound).to.equal(2n);
    });

    it("keeps a ship healed to 0 HP (heal cap 0) in the zero-HP set, so the round still completes (HA6-25)", async function () {
      const { game, creator, joiner } = await setUpRepairOnDownedAlly(0);
      await game.write.moveShip([1n, 1n, 2, 0, ActionType.Special, 2n], {
        account: creator.account,
      });
      expect((await game.read.getShipAttributes([1n, 2n])).hullPoints).to.equal(0);

      // Joiner's only ship moves; ship 1 moved and ship 2 is still a 0-HP
      // ship, so the round completes and ship 2's reactor timer ticks.
      // Before the fix ship 2 dropped out of the zero-HP set and the round
      // could never complete.
      const gd = (await game.read.getGame([1n])) as unknown as GameDataView;
      const pos6 = findShipPosition(gd, 6n);
      await game.write.moveShip([1n, 6n, pos6.row, pos6.col, ActionType.Pass, 0n], {
        account: joiner.account,
      });
      const after = (await game.read.getGame([1n])) as unknown as GameDataView;
      expect(after.turnState.currentRound).to.equal(gd.turnState.currentRound + 1n);
      expect((await game.read.getShipAttributes([1n, 2n])).reactorCriticalTimer).to.equal(1);
    });

    it("ends a game where both sides are fully disabled at once by score, as a draw on a tie (HA6-26)", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager } =
        await loadFixture(deployGameFixture);
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );
      for (let i = 1; i <= 10; i++) {
        const ship = tupleToShip((await ships.read.ships([BigInt(i)])) as ShipTuple);
        await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });
      await creatorLobbies.write.createLobby([1000n, 300n, true, 0n, 100n, zeroAddress]);
      await joinerLobbies.write.joinLobby([1n]);
      await creatorLobbies.write.createFleet([1n, [1n, 2n], generateStartingPositions([1n, 2n], true)]);
      await joinerLobbies.write.createFleet([1n, [6n], generateStartingPositions([6n], false)]);

      let gd = (await game.read.getGame([1n])) as unknown as GameDataView;
      let pos = findShipPosition(gd, 1n);
      await game.write.moveShip([1n, 1n, pos.row, pos.col, ActionType.Pass, 0n], { account: creator.account });
      gd = (await game.read.getGame([1n])) as unknown as GameDataView;
      pos = findShipPosition(gd, 6n);
      await game.write.moveShip([1n, 6n, pos.row, pos.col, ActionType.Pass, 0n], { account: joiner.account });

      // Creator ship 1 and joiner's only ship 6 are down; creator's ship 2
      // retreats, leaving neither side an active ship at once.
      await setShipHullPointsToZero(game.address, 1n, 1n);
      await setShipHullPointsToZero(game.address, 1n, 6n);
      gd = (await game.read.getGame([1n])) as unknown as GameDataView;
      pos = findShipPosition(gd, 2n);
      await game.write.moveShip([1n, 2n, pos.row, pos.col, ActionType.Retreat, 0n], { account: creator.account });

      const final = (await game.read.getGame([1n])) as unknown as GameDataView;
      expect(final.metadata.ended).to.equal(true);
      // Scores are tied 0-0, so it's a draw — the creator used to lose
      // automatically just for being checked first.
      expect(final.metadata.winner).to.equal(zeroAddress);
    });

    it("reverts setHealCapPercent above 100 and from a non-owner address", async function () {
      const { game, creator } = await loadFixture(deployGameFixture);

      await expect(
        game.write.setHealCapPercent([101]),
      ).to.be.rejectedWith("InvalidHealCapPercent");

      const creatorGame = await hre.viem.getContractAt(
        "Game",
        game.address,
        { client: { wallet: creator } },
      );
      await expect(
        creatorGame.write.setHealCapPercent([50]),
      ).to.be.rejected;

      expect(await game.read.healCapPercent()).to.equal(80);
    });

    it("keeps an active game's heal cap pinned to whatever was live at startGame, even if the owner lowers it mid-game (UA-06)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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

      const repairShip: Ship = {
        name: "Repair Ship",
        id: 1n,
        equipment: { mainWeapon: 0, armor: 0, shields: 0, special: 2 }, // RepairDrones
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2,
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.customizeShip([1n, repairShip], {
        account: owner.account,
      });
      await ships.write.constructShip([2n], { account: creator.account });
      await ships.write.constructShip([6n], { account: joiner.account });

      // Game starts with the default 80% cap still live.
      expect(await game.read.healCapPercent()).to.equal(80);
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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipHullPointsToZero(game.address, 1n, 2n);

      // Owner lowers the cap AFTER this game has already started — this is
      // exactly the UA-06 scenario. A live (unpinned) read would make the
      // upcoming heal apply this new, much lower cap retroactively.
      await game.write.setHealCapPercent([1], { account: owner.account });
      expect(await game.read.healCapPercent()).to.equal(1);

      await game.write.moveShip([1n, 1n, 2, 0, ActionType.Special, 2n], {
        account: creator.account,
      });

      // RepairDrones' fixed strength (40) heals the ship in full, uncapped
      // by the new 1% value — proving this game's heal cap stayed pinned
      // to the 80% that was live when it started (40 is under 80% of max),
      // not the value the owner changed mid-game.
      const ship2AttrsAfter = await game.read.getShipAttributes([1n, 2n]);
      expect(ship2AttrsAfter.hullPoints).to.equal(40);
    });

    it("should not complete round until repaired (formerly 0 HP) ship moves", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }

      const repairShip: Ship = {
        name: "Repair Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0,
          armor: 0,
          shields: 0,
          special: 2, // RepairDrones
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2,
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.customizeShip([1n, repairShip], {
        account: owner.account,
      });
      await ships.write.constructShip([2n], { account: creator.account });
      await ships.write.constructShip([6n], { account: joiner.account });

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipHullPointsToZero(game.address, 1n, 2n);
      expect((await game.read.getShipAttributes([1n, 2n])).hullPoints).to.equal(
        0,
      );

      // Creator moves ship 1 and repairs ship 2 (ship 2 removed from shipsWithZeroHP)
      await game.write.moveShip([1n, 1n, 2, 0, ActionType.Special, 2n], {
        account: creator.account,
      });
      expect((await game.read.getShipAttributes([1n, 2n])).hullPoints).to.equal(
        40,
      );

      // Round must not be complete: we need 3 counts, have 1 move. Repaired ship must still move.
      const stateAfterRepair = (await game.read.getGame([1n])) as any;
      expect(stateAfterRepair.turnState.currentRound).to.equal(1n);
      expect(stateAfterRepair.turnState.currentTurn.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      await game.write.moveShip([1n, 6n, 10, 13, ActionType.Pass, 0n], {
        account: joiner.account,
      });

      // Still round 1; creator must move ship 2 (repaired ship) before round can complete
      const stateAfterJoiner = (await game.read.getGame([1n])) as any;
      expect(stateAfterJoiner.turnState.currentRound).to.equal(1n);
      expect(stateAfterJoiner.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      const gameDataBefore = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const ship2Pos = findShipPosition(gameDataBefore, 2n);
      await game.write.moveShip(
        [1n, 2n, ship2Pos.row, ship2Pos.col, ActionType.Pass, 0n],
        { account: creator.account },
      );

      const stateAfterCreator2 = (await game.read.getGame([1n])) as any;
      expect(stateAfterCreator2.turnState.currentRound).to.equal(2n);
    });

    it("should allow ships with EMP to increase enemy ship's reactor critical timer", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Create a ship with EMP for creator's first ship (ship 1)
      const empShip: Ship = {
        name: "EMP Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0, // Generic
          armor: 0, // None
          shields: 0, // None
          special: 1, // EMP
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2, // Use valid speed value (0, 1, or 2)
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };

      // Authorize owner to create ships
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      // Construct the EMP ship
      await ships.write.customizeShip([1n, empShip], {
        account: owner.account,
      });

      // Construct the second ship normally
      await ships.write.constructShip([2n], { account: creator.account });

      // Construct joiner's ship
      await ships.write.constructShip([6n], { account: joiner.account });

      // Create a game
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with one ship each
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

      // Use debug function to position ships adjacent to each other for EMP test
      // Position creator's ship at (10, 15) and joiner's ship at (10, 16) - adjacent positions
      await setShipPosition(game.address, 1n, 1n, 10, 15);
      await setShipPosition(game.address, 1n, 6n, 10, 16);

      // Verify joiner's ship has 0 reactor critical timer initially
      const joinerShipAttrsBefore = await game.read.getShipAttributes([1n, 6n]);
      expect(joinerShipAttrsBefore.reactorCriticalTimer).to.equal(0);

      // Ensure it's creator's turn to use EMP
      // Since we used debug functions to position ships, we need to ensure the turn is correct

      // Now use EMP from creator's ship to target joiner's ship
      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      // Loop through gameData.shipPositions and log the shipId and position
      // for (const ship of gameData.shipPositions) {
      //   console.log("ship", ship.shipId, ship.position);
      // }
      const creatorPos = findShipPosition(gameData, 1n);
      // console.log("creatorPos", creatorPos);
      await game.write.moveShip(
        [1n, 1n, creatorPos.row, creatorPos.col, ActionType.Special, 6n],
        {
          account: creator.account,
        },
      );

      // Verify joiner's ship's reactor critical timer was increased by the EMP strength (1)
      const joinerShipAttrsAfter = await game.read.getShipAttributes([1n, 6n]);
      expect(joinerShipAttrsAfter.reactorCriticalTimer).to.equal(1); // Should be exactly 1 since EMP strength is 1
    });

    it("should allow ships with FlakArray to damage all ships in range", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

      // 1. Purchase ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // 2. Set the first ship as having a FlakArray
      const flakShip: Ship = {
        name: "FlakArray Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0, // Generic
          armor: 0, // None
          shields: 0, // None
          special: 3, // FlakArray
        },
        traits: {
          serialNumber: 12345n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 2, // Use valid speed value (0, 1, or 2)
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: creator.account.address,
      };

      // Authorize owner to create ships
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      // Create the FlakArray ship
      await ships.write.customizeShip([1n, flakShip], {
        account: owner.account,
      });

      // 3. Construct the remaining ships
      await ships.write.constructShip([2n], { account: creator.account });
      await ships.write.constructShip([3n], { account: creator.account });
      await ships.write.constructShip([6n], { account: joiner.account });
      await ships.write.constructShip([7n], { account: joiner.account });

      // 4. Create a lobby, fleet, game etc for both players
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets with multiple ships each
      await creatorLobbies.write.createFleet([
        1n,
        [1n, 2n, 3n],
        generateStartingPositions([1n, 2n, 3n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // 5. Move the FlakArray ship to the center with the debug function
      await setShipPosition(game.address, 1n, 1n, 5, 8);

      // 6. Move the remaining ships so that 1 from each team are within 3 squares and 1 from each team are outside 3 away
      // FlakArray has range 3, so we need ships within 3 squares and outside 3 squares
      // FlakArray is at (5, 8) - center of grid

      // Creator's second ship (ship 2) - within range (distance 2)
      await setShipPosition(game.address, 1n, 2n, 6, 6);

      // Creator's third ship (ship 3) - outside range (distance 5)
      await setShipPosition(game.address, 1n, 3n, 0, 0);

      // Joiner's first ship (ship 6) - within range (Manhattan distance 3)
      // FlakArray is at (5, 8), ship 6 at (7, 9) gives Manhattan distance |7-5| + |9-8| = 2 + 1 = 3
      await setShipPosition(game.address, 1n, 6n, 7, 9);

      // Joiner's second ship (ship 7) - outside range (distance 6)
      await setShipPosition(game.address, 1n, 7n, 10, 16);

      // Get initial hull points of all ships
      const ship1AttrsBefore = await game.read.getShipAttributes([1n, 1]); // FlakArray ship
      const ship2AttrsBefore = await game.read.getShipAttributes([1n, 2n]); // creator's second ship (in range)
      const ship3AttrsBefore = await game.read.getShipAttributes([1n, 3n]); // creator's third ship (out of range)
      const ship6AttrsBefore = await game.read.getShipAttributes([1n, 6n]); // joiner's first ship (in range)
      const ship7AttrsBefore = await game.read.getShipAttributes([1n, 7n]); // joiner's second ship (out of range)

      // 7. Use the first ship's first turn to stay in place and fire FlakArray
      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const flakPos = findShipPosition(gameData, 1n);
      await game.write.moveShip(
        [1n, 1n, flakPos.row, flakPos.col, ActionType.Special, 0n],
        { account: creator.account },
      );

      // Get hull points after FlakArray attack
      const ship1AttrsAfter = await game.read.getShipAttributes([1n, 1]);
      const ship2AttrsAfter = await game.read.getShipAttributes([1n, 2n]);
      const ship3AttrsAfter = await game.read.getShipAttributes([1n, 3n]);
      const ship6AttrsAfter = await game.read.getShipAttributes([1n, 6n]);
      const ship7AttrsAfter = await game.read.getShipAttributes([1n, 7n]);

      // 8. Make sure that ship is undamaged (FlakArray ship should not damage itself)
      expect(ship1AttrsAfter.hullPoints).to.equal(ship1AttrsBefore.hullPoints);

      // 9. Make sure that both friendly and enemy ships in range are damaged
      // FlakArray damages ALL ships in range (both friendly and enemy)
      // FlakArray strength is 30, and it applies armor/shield damage reduction
      const flakStrength = 30; // Current FlakArray strength

      // Ship 2 damage calculation (friendly ship in range)
      // Apply damage reduction like regular weapons
      const ship2DamageReduction = ship2AttrsBefore.damageReduction;
      const ship2ExpectedDamage = Math.max(
        0,
        flakStrength - Math.floor((flakStrength * ship2DamageReduction) / 100),
      );
      expect(ship2AttrsAfter.hullPoints).to.equal(
        Math.max(0, ship2AttrsBefore.hullPoints - ship2ExpectedDamage),
      );

      // Ship 6 damage calculation (enemy ship in range)
      // Apply damage reduction like regular weapons
      const ship6DamageReduction = ship6AttrsBefore.damageReduction;
      const ship6ExpectedDamage = Math.max(
        0,
        flakStrength - Math.floor((flakStrength * ship6DamageReduction) / 100),
      );
      expect(ship6AttrsAfter.hullPoints).to.equal(
        Math.max(0, ship6AttrsBefore.hullPoints - ship6ExpectedDamage),
      );

      // 10. Make sure that the ships out of range are undamaged
      expect(ship3AttrsAfter.hullPoints).to.equal(ship3AttrsBefore.hullPoints);
      expect(ship7AttrsAfter.hullPoints).to.equal(ship7AttrsBefore.hullPoints);
    });
  });

  describe("Variant 2 (new faction) equipped Specials", function () {
    const baseColors = {
      h1: 0,
      s1: 0,
      l1: 0,
      h2: 0,
      s2: 0,
      l2: 0,
      h3: 0,
      s3: 0,
      l3: 0,
    };

    function buildCustomShip(overrides: {
      name: string;
      id: bigint;
      owner: `0x${string}`;
      special: number;
      variant: number;
    }): Ship {
      return {
        name: overrides.name,
        id: overrides.id,
        equipment: {
          mainWeapon: 0, // Generic
          armor: 0, // None
          shields: 0, // None
          special: overrides.special,
        },
        traits: {
          serialNumber: 12345n,
          colors: baseColors,
          variant: overrides.variant,
          accuracy: 0,
          hull: 0,
          speed: 2,
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: overrides.owner,
      };
    }

    it("should allow ships with Drone Swarm to damage an enemy ship in range", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const droneSwarmShip = buildCustomShip({
        name: "Drone Swarm Ship",
        id: 1n,
        owner: creator.account.address,
        special: 2, // DroneSwarm (variant 2's slot 2)
        variant: 2,
      });
      await ships.write.customizeShip([1n, droneSwarmShip], {
        account: owner.account,
      });

      await ships.write.constructShip([6n], { account: joiner.account });

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

      // Drone Swarm has range 5 — place the enemy 5 squares away (still in range).
      await setShipPosition(game.address, 1n, 1n, 5, 0);
      await setShipPosition(game.address, 1n, 6n, 5, 5);

      const targetAttrsBefore = await game.read.getShipAttributes([1n, 6n]);

      await game.write.moveShip([1n, 1n, 5, 0, ActionType.Special, 6n], {
        account: creator.account,
      });

      const targetAttrsAfter = await game.read.getShipAttributes([1n, 6n]);
      const strength = 40;
      const expectedDamage = Math.max(
        0,
        strength -
          Math.floor((strength * targetAttrsBefore.damageReduction) / 100),
      );
      expect(targetAttrsAfter.hullPoints).to.equal(
        Math.max(0, targetAttrsBefore.hullPoints - expectedDamage),
      );
    });

    it("should revert OutOfRange for Drone Swarm beyond range 5", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const droneSwarmShip = buildCustomShip({
        name: "Drone Swarm Ship",
        id: 1n,
        owner: creator.account.address,
        special: 2, // DroneSwarm (variant 2's slot 2)
        variant: 2,
      });
      await ships.write.customizeShip([1n, droneSwarmShip], {
        account: owner.account,
      });
      await ships.write.constructShip([6n], { account: joiner.account });

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

      // Manhattan distance 6 — one past Drone Swarm's range of 5.
      await setShipPosition(game.address, 1n, 1n, 0, 0);
      await setShipPosition(game.address, 1n, 6n, 0, 6);

      await expect(
        game.write.moveShip([1n, 1n, 0, 0, ActionType.Special, 6n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("OutOfRange");
    });

    it("should revert TargetNotEnemy for Drone Swarm targeting a friendly ship", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const droneSwarmShip = buildCustomShip({
        name: "Drone Swarm Ship",
        id: 1n,
        owner: creator.account.address,
        special: 2, // DroneSwarm (variant 2's slot 2)
        variant: 2,
      });
      await ships.write.customizeShip([1n, droneSwarmShip], {
        account: owner.account,
      });
      // Fleets.createFleet now rejects mixing variants within one fleet, so
      // the friendly target ship also needs to be variant 2 to sit in the
      // same fleet as the Drone Swarm caster.
      const friendlyShip = buildCustomShip({
        name: "Friendly Ship",
        id: 2n,
        owner: creator.account.address,
        special: 0, // None
        variant: 2,
      });
      await ships.write.customizeShip([2n, friendlyShip], {
        account: owner.account,
      });
      await ships.write.constructShip([6n], { account: joiner.account });

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      await setShipPosition(game.address, 1n, 1n, 5, 0);
      await setShipPosition(game.address, 1n, 2n, 5, 1);

      await expect(
        game.write.moveShip([1n, 1n, 5, 0, ActionType.Special, 2n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("TargetNotEnemy");
    });

    it("should have Electric Storm hit friendly, enemy, and the caster's own ship with reactor damage", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const stormShip = buildCustomShip({
        name: "Electric Storm Ship",
        id: 1n,
        owner: creator.account.address,
        special: 1, // ElectricStorm (variant 2's slot 1)
        variant: 2,
      });
      await ships.write.customizeShip([1n, stormShip], {
        account: owner.account,
      });
      // Fleets.createFleet now rejects mixing variants within one fleet, so
      // the ally also needs to be variant 2 to sit in the same fleet as the
      // Electric Storm caster.
      const allyShip = buildCustomShip({
        name: "Ally Ship",
        id: 2n,
        owner: creator.account.address,
        special: 0, // None
        variant: 2,
      });
      await ships.write.customizeShip([2n, allyShip], {
        account: owner.account,
      }); // ally
      await ships.write.constructShip([6n], { account: joiner.account }); // enemy
      await ships.write.constructShip([7n], { account: joiner.account }); // enemy, out of range

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // Electric Storm has range 2, centered on the caster's own position.
      await setShipPosition(game.address, 1n, 1n, 5, 8);
      // ally, distance 1 (in range)
      await setShipPosition(game.address, 1n, 2n, 5, 9);
      // enemy, distance 2 (in range)
      await setShipPosition(game.address, 1n, 6n, 6, 9);
      // enemy, far away (out of range)
      await setShipPosition(game.address, 1n, 7n, 0, 0);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const stormPos = findShipPosition(gameData, 1n);
      await game.write.moveShip(
        [1n, 1n, stormPos.row, stormPos.col, ActionType.Special, 0n],
        { account: creator.account },
      );

      const casterAttrs = await game.read.getShipAttributes([1n, 1n]);
      const allyAttrs = await game.read.getShipAttributes([1n, 2n]);
      const enemyInRangeAttrs = await game.read.getShipAttributes([1n, 6n]);
      const enemyOutOfRangeAttrs = await game.read.getShipAttributes([
        1n,
        7n,
      ]);

      // Electric Storm strength is 1 (same per-hit reactor damage as EMP).
      expect(casterAttrs.reactorCriticalTimer).to.equal(1); // hits itself too
      expect(allyAttrs.reactorCriticalTimer).to.equal(1);
      expect(enemyInRangeAttrs.reactorCriticalTimer).to.equal(1);
      expect(enemyOutOfRangeAttrs.reactorCriticalTimer).to.equal(0);
    });

    it("should give a ship with Additional Thruster +3 movement, but revert InvalidMove if used as an action", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const thrusterShip = buildCustomShip({
        name: "Thruster Ship",
        id: 1n,
        owner: creator.account.address,
        special: 3, // AdditionalThruster (variant 2's slot 3)
        variant: 2,
      });
      await ships.write.customizeShip([1n, thrusterShip], {
        account: owner.account,
      });

      const noSpecialShip = buildCustomShip({
        name: "No Special Ship",
        id: 2n,
        owner: creator.account.address,
        special: 0, // None
        variant: 2,
      });
      await ships.write.customizeShip([2n, noSpecialShip], {
        account: owner.account,
      });

      await ships.write.constructShip([6n], { account: joiner.account });

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        1n,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      const thrusterAttrs = await game.read.getShipAttributes([1n, 1n]);
      const noSpecialAttrs = await game.read.getShipAttributes([1n, 2n]);
      expect(thrusterAttrs.movement).to.equal(noSpecialAttrs.movement + 3);

      const gameData = (await game.read.getGame([
        1n,
      ])) as unknown as GameDataView;
      const thrusterPos = findShipPosition(gameData, 1n);
      await expect(
        game.write.moveShip(
          [1n, 1n, thrusterPos.row, thrusterPos.col, ActionType.Special, 0n],
          { account: creator.account },
        ),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should revert InvalidMove for Drone Swarm's slot equipped on a variant 1 ship (no resolver registered for that (variant, slot) pair)", async function () {
      const { creatorLobbies, joinerLobbies, creator, joiner, ships, game, randomManager, owner } =
        await loadFixture(deployGameFixture);

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

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      // Special is a per-faction local slot — Game.specialResolvers is
      // keyed by (variant, slot), and Drone Swarm's resolver is only
      // registered at (variant 2, slot 2). A variant-1 ship equipping slot
      // 5 (unused for that faction) hits an unregistered (variant, slot)
      // pair entirely, reverting InvalidMove before any range check ever
      // runs. (Slot 2 would NOT do this: variant 1's slot 2 is its own,
      // unrelated RepairDrones special.)
      const wrongFactionShip = buildCustomShip({
        name: "Wrong Faction Ship",
        id: 1n,
        owner: creator.account.address,
        special: 5, // no resolver registered for (variant 1, slot 5)
        variant: 1,
      });
      await ships.write.customizeShip([1n, wrongFactionShip], {
        account: owner.account,
      });
      await ships.write.constructShip([6n], { account: joiner.account });

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

      await setShipPosition(game.address, 1n, 1n, 5, 0);
      await setShipPosition(game.address, 1n, 6n, 5, 1);

      await expect(
        game.write.moveShip([1n, 1n, 5, 0, ActionType.Special, 6n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should revert InvalidVariant when minting a ship with variant 3 (only 2 variants exist now)", async function () {
      const { ships, owner, creator } = await loadFixture(deployGameFixture);

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      const variant3Ship = buildCustomShip({
        name: "Phantom Variant Ship",
        id: 0n,
        owner: creator.account.address,
        special: 0,
        variant: 3,
      });

      await expect(
        ships.write.createSpecificShip(
          [creator.account.address, variant3Ship],
          { account: owner.account },
        ),
      ).to.be.rejectedWith("InvalidVariant");
    });
  });

  describe("Turn Timeout", function () {
    it("should enforce turn timeouts correctly", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        pvpMatch,
        fleets,
        lobbies,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with a short turn time (5 minutes - minimum allowed)
      const shortTurnTime = 300n;
      await creatorLobbies.write.createLobby([
        1000n,
        shortTurnTime,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      const lobbyId = 1n;
      await joinerLobbies.write.joinLobby([lobbyId]);

      // Create fleets (this automatically starts the game)
      await creatorLobbies.write.createFleet([
        lobbyId,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        lobbyId,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      const gameId = 1n;

      // Check initial turn info
      const gameData = (await game.read.getGame([gameId])) as any;
      expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      ); // currentTurn

      // Wait for turn to timeout (simulate by advancing time)
      await hre.network.provider.send("evm_increaseTime", [
        Number(shortTurnTime) + 1,
      ]);
      await hre.network.provider.send("evm_mine", []);

      // Timeout: other player calls endGameOnTimeout to claim win (timed-out player forfeits)
      await expect(
        pvpMatch.write.endGameOnTimeout([gameId], { account: creator.account }),
      ).to.be.rejectedWith("InvalidMove");

      await pvpMatch.write.endGameOnTimeout([gameId], {
        account: joiner.account,
      });

      const gameDataAfterTimeout = (await game.read.getGame([gameId])) as any;
      expect(gameDataAfterTimeout.metadata.winner?.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
    });

    it("should allow either player to flee and end the game", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        pvpMatch,
        fleets,
        lobbies,
        randomManager,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with a short turn time (5 minutes - minimum allowed)
      const shortTurnTime = 300n;
      await creatorLobbies.write.createLobby([
        1000n,
        shortTurnTime,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);

      const lobbyId = 1n;
      await joinerLobbies.write.joinLobby([lobbyId]);

      // Create fleets (this automatically starts the game)
      await creatorLobbies.write.createFleet([
        lobbyId,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        lobbyId,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      const gameId = 1n;

      // Check initial game status
      const initialGame = await game.read.getGame([gameId]);
      expect(initialGame.metadata.winner).to.equal(
        "0x0000000000000000000000000000000000000000",
      ); // winner (zero address means game not over)

      // Creator flees
      await pvpMatch.write.flee([gameId], { account: creator.account });

      // Check game status after flee
      const gameAfterFlee = await game.read.getGame([gameId]);
      expect(gameAfterFlee.metadata.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      ); // winner (joiner wins when creator flees)

      // Check that the game result was recorded in GameResults
      expect(await gameResults.read.isGameResultRecorded([gameId])).to.be.true;
      const result = await gameResults.read.getGameResult([gameId]);
      expect(result.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(result.loser.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // Verify that moves are no longer allowed
      await expect(
        game.write.moveShip([gameId, 1n, 0, 1, 0, 0n], {
          account: creator.account,
        }),
      ).to.be.rejectedWith("InvalidMove");

      // Verify that the other player cannot flee again
      await expect(
        pvpMatch.write.flee([gameId], { account: joiner.account }),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("keys a game (and its result) by lobby id after an earlier lobby was cancelled", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        pvpMatch,
        randomManager,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
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
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create lobby #1 and cancel it (creator leaves with no joiner). This
      // advances lobbyCount to 1 without ever starting a game, so the next
      // game's id (== its lobby id) will be 2, not 1 — a sparse game id.
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await creatorLobbies.write.leaveLobby([1n]);

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
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        2n,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      // The game lives at id 2 (== lobby id); there is no game at id 1.
      await expect(game.read.getGame([1n])).to.be.rejectedWith("GameNotFound");

      const startedGame = (await game.read.getGame([2n])) as GameDataView;
      expect(startedGame.metadata.gameId).to.equal(2n);
      expect(startedGame.metadata.lobbyId).to.equal(2n);
      expect(startedGame.metadata.winner).to.equal(zeroAddress);

      // playerGames tracks the sparse id (2) for both players.
      const creatorGames = (await game.read.getGamesForPlayer([
        creator.account.address,
      ])) as GameDataView[];
      expect(creatorGames.length).to.equal(1);
      expect(creatorGames[0].metadata.gameId).to.equal(2n);
      const joinerGames = (await game.read.getGamesForPlayer([
        joiner.account.address,
      ])) as GameDataView[];
      expect(joinerGames.length).to.equal(1);
      expect(joinerGames[0].metadata.gameId).to.equal(2n);

      // Drive the game to completion (creator flees -> joiner wins) and verify
      // GameResults is keyed by the sparse game id (2), with nothing at id 1.
      await pvpMatch.write.flee([2n], { account: creator.account });

      const finishedGame = (await game.read.getGame([2n])) as GameDataView;
      expect(finishedGame.metadata.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );

      expect(await gameResults.read.isGameResultRecorded([2n])).to.be.true;
      const result = await gameResults.read.getGameResult([2n]);
      expect(result.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(result.loser.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );

      // No result was ever recorded at the phantom id 1.
      expect(await gameResults.read.isGameResultRecorded([1n])).to.be.false;
    });

    it("should end game when all ships are retreated", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        pvpMatch,
        fleets,
        lobbies,
        randomManager,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      const lobbyId = 1n;
      await joinerLobbies.write.joinLobby([lobbyId]);

      // Create fleets (this automatically starts the game)
      await creatorLobbies.write.createFleet([
        lobbyId,
        [1n, 2n],
        generateStartingPositions([1n, 2n], true),
      ]);
      await joinerLobbies.write.createFleet([
        lobbyId,
        [6n, 7n],
        generateStartingPositions([6n, 7n], false),
      ]);

      const gameId = 1n;

      // Check initial game status
      const initialGame = await game.read.getGame([gameId]);
      expect(initialGame.metadata.winner).to.equal(
        "0x0000000000000000000000000000000000000000",
      ); // No winner yet

      // Creator retreats all their ships
      await game.write.moveShip([gameId, 1n, 0, 0, 2, 0n], {
        account: creator.account,
      }); // Retreat ship 1

      // Complete the round so joiner can move (move to a valid position)
      await moveShipWithinMovement(game, gameId, 6n, joiner.account); // Joiner moves to complete round

      await game.write.moveShip([gameId, 2n, 2, 0, 2, 0n], {
        account: creator.account,
      }); // Retreat ship 2

      // Check game status after all creator ships retreated
      const gameAfterRetreat = await game.read.getGame([gameId]);
      expect(gameAfterRetreat.metadata.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      ); // Joiner wins because creator has no active ships

      // Verify that moves are no longer allowed
      await expect(
        game.write.moveShip([gameId, 6n, 0, 1, 0, 0n], {
          account: joiner.account,
        }),
      ).to.be.rejectedWith("InvalidMove");
    });

    it("should award win to creator when their score exceeds maxScore and is higher than joiner after simultaneous scoring", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        randomManager,
        owner,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Fulfill randomness and construct ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with low maxScore for quick endgame
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        5n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game (one ship each)
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

      const gameId = 1n;

      // Place scoring tiles under each player's ship
      let gameData = (await game.read.getGame([gameId])) as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);
      const joinerPos = findShipPosition(gameData, 6n);

      // Creator tile: 5 points (reaches maxScore), Joiner tile: 3 points
      await maps.write.setScoringTile(
        [gameId, creatorPos.row, creatorPos.col, 5],
        { account: owner.account },
      );
      await maps.write.setScoringTile(
        [gameId, joinerPos.row, joinerPos.col, 3],
        { account: owner.account },
      );

      // Complete the round with no-op moves to trigger end-of-round scoring
      await game.write.moveShip(
        [gameId, 1n, creatorPos.row, creatorPos.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
      await game.write.moveShip(
        [gameId, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      const finalGame = (await game.read.getGame([gameId])) as any;
      expect(finalGame.metadata.winner.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
      expect(finalGame.creatorScore).to.equal(5n);
      expect(finalGame.joinerScore).to.equal(3n);

      // Game result should be recorded for a non-draw outcome
      expect(await gameResults.read.isGameResultRecorded([gameId])).to.be.true;
      const result = await gameResults.read.getGameResult([gameId]);
      expect(result.winner.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
      expect(result.loser.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
    });

    it("should award win to joiner when their score exceeds maxScore and is higher than creator after simultaneous scoring", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        randomManager,
        owner,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Fulfill randomness and construct ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with low maxScore for quick endgame
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        5n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game (one ship each)
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

      const gameId = 1n;

      // Place scoring tiles under each player's ship
      let gameData = (await game.read.getGame([gameId])) as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);
      const joinerPos = findShipPosition(gameData, 6n);

      // Creator tile: 3 points, Joiner tile: 5 points (reaches maxScore)
      await maps.write.setScoringTile(
        [gameId, creatorPos.row, creatorPos.col, 3],
        { account: owner.account },
      );
      await maps.write.setScoringTile(
        [gameId, joinerPos.row, joinerPos.col, 5],
        { account: owner.account },
      );

      // Complete the round with no-op moves to trigger end-of-round scoring
      await game.write.moveShip(
        [gameId, 1n, creatorPos.row, creatorPos.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
      await game.write.moveShip(
        [gameId, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      const finalGame = (await game.read.getGame([gameId])) as any;
      expect(finalGame.metadata.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(finalGame.creatorScore).to.equal(3n);
      expect(finalGame.joinerScore).to.equal(5n);

      // Game result should be recorded for a non-draw outcome
      expect(await gameResults.read.isGameResultRecorded([gameId])).to.be.true;
      const result = await gameResults.read.getGameResult([gameId]);
      expect(result.winner.toLowerCase()).to.equal(
        joiner.account.address.toLowerCase(),
      );
      expect(result.loser.toLowerCase()).to.equal(
        creator.account.address.toLowerCase(),
      );
    });

    it("should end the game as a draw when both players reach at least maxScore with equal scores after simultaneous scoring", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        randomManager,
        owner,
        gameResults,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Fulfill randomness and construct ships
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a lobby with low maxScore for quick endgame
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n, // selectedMapId - no preset map,
        5n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // Create fleets to start the game (one ship each)
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

      const gameId = 1n;

      // Place scoring tiles under each player's ship
      let gameData = (await game.read.getGame([gameId])) as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);
      const joinerPos = findShipPosition(gameData, 6n);

      // Both tiles: 5 points (both reach maxScore with equal scores)
      await maps.write.setScoringTile(
        [gameId, creatorPos.row, creatorPos.col, 5],
        { account: owner.account },
      );
      await maps.write.setScoringTile(
        [gameId, joinerPos.row, joinerPos.col, 5],
        { account: owner.account },
      );

      // Complete the round with no-op moves to trigger end-of-round scoring
      await game.write.moveShip(
        [gameId, 1n, creatorPos.row, creatorPos.col, ActionType.Pass, 0n],
        { account: creator.account },
      );
      await game.write.moveShip(
        [gameId, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
        { account: joiner.account },
      );

      const finalGame = (await game.read.getGame([gameId])) as any;
      expect(finalGame.creatorScore).to.equal(5n);
      expect(finalGame.joinerScore).to.equal(5n);
      expect(finalGame.metadata.winner).to.equal(zeroAddress); // Draw

      // Draws should not be recorded in GameResults
      expect(await gameResults.read.isGameResultRecorded([gameId])).to.be.false;
    });

    it("does not brick round completion if Maps.isAllowedGame is revoked for this engine mid-game (UA-04)", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        maps,
        randomManager,
        owner,
      } = await loadFixture(deployGameFixture);

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

      // High maxScore so this round's scoring doesn't end the game — this
      // test only cares whether the round can complete at all.
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        0n,
        100n, // maxScore
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

      const gameId = 1n;
      let gameData = (await game.read.getGame([gameId])) as GameDataView;
      const creatorPos = findShipPosition(gameData, 1n);
      const joinerPos = findShipPosition(gameData, 6n);
      await maps.write.setScoringTile(
        [gameId, creatorPos.row, creatorPos.col, 5],
        { account: owner.account },
      );

      // Simulate a live-ops "retire this engine" cleanup action, exactly
      // like UA-04 describes, while this game is still active.
      await maps.write.setIsAllowedGame([game.address, false], {
        account: owner.account,
      });

      // Completing the round (a no-op Pass for each player, landing the
      // creator's ship back on the scoring tile) must still succeed —
      // before the fix, Maps.getScoreAndZeroOut's revert would propagate
      // all the way up through moveShip, permanently blocking this game.
      await expect(
        game.write.moveShip(
          [gameId, 1n, creatorPos.row, creatorPos.col, ActionType.Pass, 0n],
          { account: creator.account },
        ),
      ).to.not.be.rejected;
      await expect(
        game.write.moveShip(
          [gameId, 6n, joinerPos.row, joinerPos.col, ActionType.Pass, 0n],
          { account: joiner.account },
        ),
      ).to.not.be.rejected;

      // The round completed, but the points were NOT awarded — scoring is
      // the thing that degraded, not the round itself.
      const finalGame = (await game.read.getGame([gameId])) as any;
      expect(finalGame.creatorScore).to.equal(0n);
    });

    it("should respect preset maps when calculating line of sight", async function () {
      const {
        creatorLobbies,
        joinerLobbies,
        creator,
        joiner,
        ships,
        game,
        fleets,
        lobbies,
        randomManager,
        maps,
        owner,
      } = await loadFixture(deployGameFixture);

      // Purchase and construct ships for both players
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, joiner.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [joiner.account.address, 0n, creator.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber;
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships for both players
      await ships.write.constructAllMyShips({ account: creator.account });
      await ships.write.constructAllMyShips({ account: joiner.account });

      // Create a preset map with blocked tiles that will block line of sight
      const blockedPositions = [
        { row: 5, col: 8 }, // Block the middle of the grid
        { row: 5, col: 9 },
        { row: 5, col: 10 },
      ];

      await maps.write.createPresetMap([blockedPositions, MapMode.Both], {
        account: owner.account,
      });
      const mapId = await maps.read.mapCount();

      // Create a lobby with the selected preset map
      await creatorLobbies.write.createLobby([
        1000n,
        300n,
        true,
        mapId, // Use the preset map,
        100n, // maxScore
        zeroAddress, // reservedJoiner - no reservation
      ]);
      const lobbyId = 1n;
      await joinerLobbies.write.joinLobby([lobbyId]);

      // Create fleets (this automatically starts the game and applies the preset map)
      await creatorLobbies.write.createFleet([
        lobbyId,
        [1n],
        generateStartingPositions([1n], true),
      ]);
      await joinerLobbies.write.createFleet([
        lobbyId,
        [6n],
        generateStartingPositions([6n], false),
      ]);

      const gameId = 1n;
      const creatorShipIds = [1n];
      const joinerShipIds = [6n];

      // Get game data to see ship positions
      const gameData = (await game.read.getGame([
        gameId,
      ])) as unknown as GameDataView;

      // Creator ships start at column 0, joiner ships start at column 13
      // With the blocked tiles at row 5, columns 8-10, line of sight should be blocked
      // when trying to shoot from one side to the other through the middle

      // Test line of sight that should be blocked by the preset map
      const hasLOS = await maps.read.hasMaps([
        BigInt(gameId),
        5, // Start at row 5 (same row as blocked tiles)
        0, // Start at column 0 (creator side)
        5, // End at row 5 (same row as blocked tiles)
        16, // End at column 16 (passes through blocked tiles at columns 8-10)
      ]);

      // Line of sight should be blocked because it passes through the blocked tiles
      expect(hasLOS).to.be.false;

      // Test line of sight that should be clear (above the blocked tiles)
      const hasLOSAbove = await maps.read.hasMaps([
        BigInt(gameId),
        2, // Start at row 2 (above blocked tiles)
        0, // Start at column 0
        10, // End at row 10 (within bounds)
        15, // End at column 15 (avoid blocked tiles at columns 8-10)
      ]);

      // Line of sight should be clear above the blocked tiles
      expect(hasLOSAbove).to.be.true;

      // Test line of sight that should be clear (below the blocked tiles)
      // Use a path that avoids the blocked tiles at row 5, columns 8-10
      // Path from (10, 0) to (0, 7) avoids blocked tiles (goes left of column 8)
      const hasLOSBelow = await maps.read.hasMaps([
        BigInt(gameId),
        10, // Start at row 10 (below blocked tiles)
        0, // Start at column 0
        0, // End at row 0 (top of grid)
        7, // End at column 7 (left of blocked tiles at columns 8-10)
      ]);

      // Line of sight should be clear below the blocked tiles
      expect(hasLOSBelow).to.be.true;
    });
  });

  describe("Fleets.removeShipFromFleet (G-02)", function () {
    it("removes a middle ship via swap-and-pop, preserving membership/cost/inFleet state for the rest", async function () {
      const { fleets, ships, owner, creator, randomManager } =
        await loadFixture(deployGameFixture);

      // Purchase a tier-0 (5-ship) batch for creator: ships 1-5.
      await ships.write.purchaseWithFlow(
        [creator.account.address, 0n, owner.account.address, 1],
        { value: parseEther("4.99") },
      );
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: creator.account });

      // Bypass Lobbies and call Fleets directly so this test isolates
      // removeShipFromFleet's swap-and-pop behavior specifically.
      await fleets.write.setIsAllowedToManageFleets([
        owner.account.address,
        true,
      ]);

      const shipIds = [1n, 2n, 3n];
      const shipCosts: number[] = [];
      for (const id of shipIds) {
        const shipTuple = (await ships.read.ships([id])) as ShipTuple;
        shipCosts.push(tupleToShip(shipTuple).shipData.cost);
      }
      const totalCost = shipCosts.reduce((a, b) => a + b, 0);

      await fleets.write.createFleet([
        0n,
        creator.account.address,
        shipIds,
        generateStartingPositions(shipIds, true),
        BigInt(totalCost),
        true,
        0n, // mapId
      ]);
      const fleetId = await fleets.read.fleetCount();

      // Remove the MIDDLE ship (id 2n at index 1) — exercises the actual
      // swap (last element moved into the removed slot), not just a
      // trivial pop of the last element.
      await fleets.write.removeShipFromFleet([fleetId, 2n]);

      const fleetAfter = await fleets.read.getFleet([fleetId]);
      const remaining = [...fleetAfter.shipIds].map((id) => id.toString()).sort();
      expect(remaining).to.deep.equal(["1", "3"]);
      expect(fleetAfter.totalCost).to.equal(BigInt(shipCosts[0] + shipCosts[2]));

      // Removed ship is released; the swapped-in and untouched ships stay in-fleet.
      const removedShip = tupleToShip(
        (await ships.read.ships([2n])) as ShipTuple,
      );
      const keptShip1 = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      const keptShip3 = tupleToShip(
        (await ships.read.ships([3n])) as ShipTuple,
      );
      expect(removedShip.shipData.inFleet).to.be.false;
      expect(keptShip1.shipData.inFleet).to.be.true;
      expect(keptShip3.shipData.inFleet).to.be.true;
    });
  });
});
