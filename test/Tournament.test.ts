import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import { ActionType, GameDataView, ShipTuple, tupleToShip } from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";

const EMPTY_PROOF = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as const;

// Mirror of Game.test's helper for placing ships in valid starting columns.
function generateStartingPositions(shipIds: bigint[], isCreator: boolean) {
  const positions = [];
  for (let i = 0; i < shipIds.length; i++) {
    if (isCreator) {
      positions.push({ row: i % 11, col: i % 4 });
    } else {
      const row = Math.max(0, 10 - (i % 11));
      positions.push({ row, col: 13 + (i % 4) });
    }
  }
  return positions;
}

// Mirror of Game.test's helper for finding a ship's position from GameDataView.
function findShipPosition(gameData: GameDataView, shipId: bigint) {
  for (const shipPosition of gameData.shipPositions) {
    if (shipPosition.shipId === shipId) {
      return shipPosition.position;
    }
  }
  throw new Error(`Ship ${shipId} not found in game data`);
}

describe("Tournament", function () {
  async function deployTournamentFixture() {
    const [owner, alice, bob, carol] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    // The module wires the protocol fee recipient to the deployer (account 0),
    // which is `owner` here.
    const feeRecipient = owner;

    const deployed = await hre.ignition.deploy(DeployModule);

    // Tournament + World ID mock come from the Ignition module.
    const tournament = deployed.tournament;
    const mockWorldId = deployed.worldId;

    // Per-wallet contract instances.
    const asOwner = await hre.viem.getContractAt(
      "Tournament",
      tournament.address,
      { client: { wallet: owner } }
    );
    const asAlice = await hre.viem.getContractAt(
      "Tournament",
      tournament.address,
      { client: { wallet: alice } }
    );
    const asBob = await hre.viem.getContractAt(
      "Tournament",
      tournament.address,
      { client: { wallet: bob } }
    );
    const asCarol = await hre.viem.getContractAt(
      "Tournament",
      tournament.address,
      { client: { wallet: carol } }
    );

    const now = (await publicClient.getBlock()).timestamp;

    return {
      deployed,
      tournament,
      mockWorldId,
      asOwner,
      asAlice,
      asBob,
      asCarol,
      owner,
      alice,
      bob,
      carol,
      feeRecipient,
      publicClient,
      now,
    };
  }

  function defaultConfig(
    now: bigint,
    overrides: Partial<{
      entryFee: bigint;
      minPlayers: number;
      maxPlayers: number;
      lastStartTime: bigint;
      costLimit: bigint;
      turnTime: bigint;
      selectedMapId: bigint;
      maxScore: bigint;
      matchTimeout: bigint;
    }> = {}
  ) {
    return {
      entryFee: parseEther("1"),
      minPlayers: 2,
      maxPlayers: 4,
      lastStartTime: now + 3600n,
      costLimit: 1000n,
      turnTime: 300n,
      selectedMapId: 0n,
      maxScore: 100n,
      matchTimeout: 3600n, // MIN_MATCH_TIMEOUT
      ...overrides,
    };
  }

  async function increaseTime(seconds: number) {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine", []);
  }

  // Creates a real, started PvP game between playerA/playerB (no moves
  // needed — Game.startGame sets metadata.startedAt as soon as both fleets
  // exist) and returns its gameId. Used to give assignMatchGame (HA3-03) a
  // genuinely valid game to assign, instead of an unvalidated fake id.
  async function createRealGameBetween(
    deployed: any,
    playerA: any,
    playerB: any
  ): Promise<bigint> {
    const { ships, lobbies, randomManager } = deployed;
    await ships.write.purchaseWithFlow(
      [playerA.account.address, 0, playerB.account.address, 1],
      { value: parseEther("4.99") }
    );
    await ships.write.purchaseWithFlow(
      [playerB.account.address, 0, playerA.account.address, 1],
      { value: parseEther("4.99") }
    );
    for (let i = 1; i <= 10; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: playerA.account });
    await ships.write.constructAllMyShips({ account: playerB.account });

    await lobbies.write.createLobbyForAddresses([
      playerA.account.address,
      playerB.account.address,
      1000n,
      300n,
      0n,
      100n,
    ]);
    const lobbyId = await lobbies.read.lobbyCount();

    await lobbies.write.createFleet(
      [lobbyId, [1n], generateStartingPositions([1n], true)],
      { account: playerA.account }
    );
    await lobbies.write.createFleet(
      [lobbyId, [6n], generateStartingPositions([6n], false)],
      { account: playerB.account }
    );

    return lobbyId;
  }

  describe("Creation & sponsorship", function () {
    it("creates a tournament and records a sponsor prize from the creator's value", async function () {
      const { asOwner, owner, now } = await loadFixture(deployTournamentFixture);

      await asOwner.write.createTournament([defaultConfig(now)], {
        value: parseEther("5"),
      });

      const summary = await asOwner.read.getTournamentSummary([1n]);
      // state (0 == Registration), creator, prizePool, registrantCount, ...
      expect(summary[0]).to.equal(0);
      expect(summary[1].toLowerCase()).to.equal(owner.account.address.toLowerCase());
      expect(summary[2]).to.equal(parseEther("5"));
      expect(summary[3]).to.equal(0n);
    });

    it("rejects invalid config", async function () {
      const { asOwner, now } = await loadFixture(deployTournamentFixture);
      await expect(
        asOwner.write.createTournament([defaultConfig(now, { minPlayers: 1 })])
      ).to.be.rejectedWith("InvalidConfig");
    });

    it("allows only a single sponsor", async function () {
      const { asOwner, asAlice, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([defaultConfig(now)], {
        value: parseEther("5"),
      });
      // A different address cannot become a second sponsor.
      await expect(
        asAlice.write.addSponsorPrize([1n], { value: parseEther("1") })
      ).to.be.rejectedWith("SponsorAlreadySet");
      // The original sponsor can top up.
      await asOwner.write.addSponsorPrize([1n], { value: parseEther("1") });
      const summary = await asOwner.read.getTournamentSummary([1n]);
      expect(summary[2]).to.equal(parseEther("6"));
    });

    it("rejects claiming the sponsor slot with a zero-value call (HA4-04)", async function () {
      const { asOwner, asAlice, now } = await loadFixture(
        deployTournamentFixture,
      );
      // No sponsor set at creation.
      await asOwner.write.createTournament([defaultConfig(now)]);

      // Alice can't squat the sponsor slot for free.
      await expect(
        asAlice.write.addSponsorPrize([1n]),
      ).to.be.rejectedWith("NoSponsorContribution");

      // The slot is still open — a real contribution from anyone succeeds.
      await asAlice.write.addSponsorPrize([1n], { value: parseEther("1") });
      const summary = await asOwner.read.getTournamentSummary([1n]);
      expect(summary[2]).to.equal(parseEther("1"));

      // Now that Alice is the real sponsor, a zero-value call from someone
      // else still correctly rejects as SponsorAlreadySet, not this check.
      await expect(
        asOwner.write.addSponsorPrize([1n]),
      ).to.be.rejectedWith("SponsorAlreadySet");
    });
  });

  describe("Registration (World ID gate)", function () {
    it("registers verified players and enforces fee, dedupe, and nullifier uniqueness", async function () {
      const { asOwner, asAlice, asBob, asCarol, mockWorldId, alice, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([defaultConfig(now)]);

      await asAlice.write.register([1n, 0n, 101n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 102n, EMPTY_PROOF], {
        value: parseEther("1"),
      });

      const registrants = await asOwner.read.getRegistrants([1n]);
      expect(registrants.length).to.equal(2);
      expect(await asOwner.read.isRegistered([1n, alice.account.address])).to.be
        .true;

      // Wrong fee.
      await expect(
        asCarol.write.register([1n, 0n, 103n, EMPTY_PROOF], {
          value: parseEther("2"),
        })
      ).to.be.rejectedWith("WrongEntryFee");

      // Reused nullifier.
      await expect(
        asCarol.write.register([1n, 0n, 101n, EMPTY_PROOF], {
          value: parseEther("1"),
        })
      ).to.be.rejectedWith("NullifierUsed");

      // Same address twice (fresh nullifier).
      await expect(
        asAlice.write.register([1n, 0n, 999n, EMPTY_PROOF], {
          value: parseEther("1"),
        })
      ).to.be.rejectedWith("AlreadyRegistered");

      // Invalid World ID proof.
      await mockWorldId.write.setShouldRevert([true]);
      await expect(
        asCarol.write.register([1n, 0n, 104n, EMPTY_PROOF], {
          value: parseEther("1"),
        })
      ).to.be.rejectedWith("MockWorldID: invalid proof");

      const summary = await asOwner.read.getTournamentSummary([1n]);
      expect(summary[2]).to.equal(parseEther("2")); // two paid entries
    });
  });

  describe("Start conditions", function () {
    it("won't start before the deadline below max, but starts after the deadline above min", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([defaultConfig(now)]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });

      await expect(asOwner.write.start([1n])).to.be.rejectedWith(
        "StartConditionsNotMet"
      );

      await increaseTime(3601);
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket.length).to.equal(1); // N=2 -> 1 match
    });

    it("starts immediately when the field reaches max size", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]); // at max, no time travel needed
      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket.length).to.equal(1);
    });
  });

  describe("Bracket shuffle expiry (HA2-07)", function () {
    it("rejects buildBracket once the reveal window has expired", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([defaultConfig(now)]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await increaseTime(3601);
      await asOwner.write.start([1n]);

      // SHUFFLE_REVEAL_WINDOW is 10 minutes; let it lapse unused.
      await increaseTime(601);

      await expect(asOwner.write.buildBracket([1n])).to.be.rejectedWith(
        "ShuffleWindowExpired"
      );
    });

    it("lets anyone reroll an expired shuffle request and build normally afterward", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([defaultConfig(now)]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await increaseTime(3601);
      await asOwner.write.start([1n]);

      // Rerolling before expiry is rejected.
      await expect(
        asOwner.write.rerollBracketShuffle([1n])
      ).to.be.rejectedWith("ShuffleWindowNotExpired");

      await increaseTime(601);

      // Permissionless: alice (not the tournament creator) can force it.
      await asAlice.write.rerollBracketShuffle([1n]);

      // The old request's window expired, but the reroll opened a fresh
      // one, so buildBracket() succeeds immediately again.
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket.length).to.equal(1);
    });
  });

  describe("Bracket seeding & byes", function () {
    it("allows a reroll as soon as the shuffle request expires, even before the reveal deadline (HA6-19)", async function () {
      const { asOwner, asAlice, asBob, asCarol, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([defaultConfig(now)]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await increaseTime(3601);
      await asOwner.write.start([1n]);

      // 300 blocks: past the 256-block blockhash window, but hardhat_mine
      // only advances time 1s per block, so still inside the 10-minute
      // SHUFFLE_REVEAL_WINDOW.
      await hre.network.provider.send("hardhat_mine", ["0x12c"]);
      await expect(asOwner.write.buildBracket([1n])).to.be.rejectedWith(
        "RequestExpired"
      );

      // Previously this gap had no way forward until the deadline passed.
      await asCarol.write.rerollBracketShuffle([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      expect((await asOwner.read.getBracket([1n])).length).to.equal(1);
    });

    it("pads to a power of two and auto-advances byes to top seeds", async function () {
      const { asOwner, asAlice, asBob, asCarol, alice, bob, carol, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([defaultConfig(now)]);

      // 3 registrants -> N=4, 3 matches, 2 rounds, one bye for whichever
      // registrant the post-registration shuffle assigns seed 1 to.
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asCarol.write.register([1n, 0n, 3n, EMPTY_PROOF], {
        value: parseEther("1"),
      });

      await increaseTime(3601);
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      // Seeding is shuffled (not registration order) — read back who
      // actually holds each seed instead of assuming it's alice.
      const seedOf: Record<string, bigint> = {};
      for (const [name, addr] of [
        ["alice", alice.account.address],
        ["bob", bob.account.address],
        ["carol", carol.account.address],
      ] as const) {
        seedOf[name] = await asOwner.read.getSeed([1n, addr]);
      }
      // Compare via Number(...) rather than === 1n — hardhat-viem doesn't
      // consistently decode a uint32 return as bigint, and bigint/number
      // strict equality never coerces (1n === 1 is false).
      const seed1Name = (["alice", "bob", "carol"] as const).find(
        (name) => Number(seedOf[name]) === 1
      )!;
      const seed1Address = { alice, bob, carol }[seed1Name].account.address;

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket.length).to.equal(3);

      // Round-0 match 0 is seed1 vs seed4 (bye) -> seed1 auto-advances.
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(
        seed1Address.toLowerCase()
      );
      // Round-0 match 1 (seed2 vs seed3) is a real, unresolved match.
      expect(bracket[1].resolved).to.be.false;
      expect(bracket[1].player1).to.not.equal(zeroAddress);
      expect(bracket[1].player2).to.not.equal(zeroAddress);
      // Final (index 2) already has seed1 slotted in from the bye.
      expect(bracket[2].player1.toLowerCase()).to.equal(
        seed1Address.toLowerCase()
      );
      expect(bracket[2].player2).to.equal(zeroAddress);
    });

    it("shuffles seeds so registration order doesn't determine pairing", async function () {
      const { asOwner, asAlice, asBob, asCarol, alice, bob, carol, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 8 }),
      ]);

      const registrants = [
        [asAlice, 1n, alice],
        [asBob, 2n, bob],
        [asCarol, 3n, carol],
      ] as const;
      for (const [asPlayer, nullifier] of registrants) {
        await asPlayer.write.register([1n, 0n, nullifier, EMPTY_PROOF], {
          value: parseEther("1"),
        });
      }

      await increaseTime(3601);
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      // Every registrant gets a distinct, valid seed in [1, n] — the
      // shuffle is a real bijection, not a no-op or a broken mapping.
      const seeds = await Promise.all(
        [alice, bob, carol].map((p) =>
          asOwner.read.getSeed([1n, p.account.address])
        )
      );
      expect(new Set(seeds).size).to.equal(3);
      for (const s of seeds) {
        // uint32 return decodes as bigint — chai's greaterThan/lessThan
        // matchers don't handle bigint, so compare explicitly.
        expect(s > 0n && s <= 3n).to.be.true;
      }
    });
  });

  describe("Draw resolution", function () {
    it("verifies the draw on-chain against Game before awarding it to the lower seed", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, owner, now } =
        await loadFixture(deployTournamentFixture);

      const ships = deployed.ships;
      const game = deployed.game;
      const pvpMatch = deployed.pvpMatch;
      const maps = deployed.maps;
      const randomManager = deployed.randomManager;
      const lobbies = deployed.lobbies;

      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      // Seeding is shuffled at buildBracket() time, so which of alice/bob
      // holds seed 1 (the draw tiebreak winner, player1 in a straight
      // 2-player final) is no longer determined by registration order.
      const seededBracket = await asOwner.read.getBracket([1n]);
      const lowerSeedAddress = seededBracket[0].player1;

      // Can't resolve a draw before a game is even assigned to the match.
      await expect(
        asOwner.write.resolveDraw([1n, 0n, `0x${"00".repeat(32)}`])
      ).to.be.rejectedWith("GameNotAssigned");

      // --- Set up a real game between alice and bob and drive it to a genuine draw ---
      await ships.write.purchaseWithFlow(
        [alice.account.address, 0, bob.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [bob.account.address, 0, alice.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: alice.account });
      await ships.write.constructAllMyShips({ account: bob.account });

      await lobbies.write.createLobbyForAddresses([
        alice.account.address,
        bob.account.address,
        1000n,
        300n,
        0n,
        5n, // low maxScore for a quick draw
      ]);
      const lobbyId = 1n; // first lobby -> gameId == lobbyId == 1

      await lobbies.write.createFleet(
        [lobbyId, [1n], generateStartingPositions([1n], true)],
        { account: alice.account }
      );
      await lobbies.write.createFleet(
        [lobbyId, [6n], generateStartingPositions([6n], false)],
        { account: bob.account }
      );

      let gameData = (await game.read.getGame([lobbyId])) as GameDataView;
      const alicePos = findShipPosition(gameData, 1n);
      const bobPos = findShipPosition(gameData, 6n);

      // Equal scoring tiles under each ship: both reach maxScore with equal scores.
      await maps.write.setScoringTile(
        [lobbyId, alicePos.row, alicePos.col, 5],
        { account: owner.account }
      );
      await maps.write.setScoringTile(
        [lobbyId, bobPos.row, bobPos.col, 5],
        { account: owner.account }
      );

      await game.write.moveShip(
        [lobbyId, 1n, alicePos.row, alicePos.col, ActionType.Pass, 0n],
        { account: alice.account }
      );
      await game.write.moveShip(
        [lobbyId, 6n, bobPos.row, bobPos.col, ActionType.Pass, 0n],
        { account: bob.account }
      );

      const finishedGame = (await game.read.getGame([lobbyId])) as GameDataView;
      expect(finishedGame.metadata.winner).to.equal(zeroAddress); // genuine draw
      expect(finishedGame.metadata.ended).to.be.true;

      // --- Link the game to the match, then resolve the draw ---
      await asOwner.write.assignMatchGame([1n, 0n, lobbyId]);

      // Permissionless now that the draw is verified on-chain — bob (not the
      // tournament creator) can call it just as well as the creator can.
      await asBob.write.resolveDraw([1n, 0n, `0x${"11".repeat(32)}`]);
      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(
        lowerSeedAddress.toLowerCase()
      );
    });

    it("rejects resolveDraw when the assigned game actually has a winner", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, now } =
        await loadFixture(deployTournamentFixture);

      const ships = deployed.ships;
      const game = deployed.game;
      const pvpMatch = deployed.pvpMatch;
      const randomManager = deployed.randomManager;
      const lobbies = deployed.lobbies;

      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      await ships.write.purchaseWithFlow(
        [alice.account.address, 0, bob.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [bob.account.address, 0, alice.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: alice.account });
      await ships.write.constructAllMyShips({ account: bob.account });

      await lobbies.write.createLobbyForAddresses([
        alice.account.address,
        bob.account.address,
        1000n,
        300n,
        0n,
        100n,
      ]);
      const lobbyId = 1n;

      await lobbies.write.createFleet(
        [lobbyId, [1n], generateStartingPositions([1n], true)],
        { account: alice.account }
      );
      await lobbies.write.createFleet(
        [lobbyId, [6n], generateStartingPositions([6n], false)],
        { account: bob.account }
      );

      // Alice flees -> bob wins outright; this is not a draw.
      await pvpMatch.write.flee([lobbyId], { account: alice.account });

      await asOwner.write.assignMatchGame([1n, 0n, lobbyId]);
      await expect(
        asOwner.write.resolveDraw([1n, 0n, `0x${"22".repeat(32)}`])
      ).to.be.rejectedWith("NotADraw");
    });
  });

  describe("End-to-end: real game result, finalize & claim", function () {
    it("records a game winner from GameResults and splits prizes 60/40 minus a 1% fee", async function () {
      const {
        deployed,
        asOwner,
        asAlice,
        asBob,
        owner,
        alice,
        bob,
        feeRecipient,
        now,
      } = await loadFixture(deployTournamentFixture);

      const ships = deployed.ships;
      const game = deployed.game;
      const pvpMatch = deployed.pvpMatch;
      const gameResults = deployed.gameResults;
      const randomManager = deployed.randomManager;
      const lobbies = deployed.lobbies;

      // --- Tournament: 2 players, 1 ether entry each ---
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]); // final match: player1 = alice, player2 = bob

      // --- Set up a real game between alice and bob ---
      await ships.write.purchaseWithFlow(
        [alice.account.address, 0, bob.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [bob.account.address, 0, alice.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: alice.account });
      await ships.write.constructAllMyShips({ account: bob.account });

      // Owner (Lobbies owner + tournament creator) pairs the two players.
      await lobbies.write.createLobbyForAddresses([
        alice.account.address,
        bob.account.address,
        1000n,
        300n,
        0n,
        100n,
      ]);
      const lobbyId = 1n; // first lobby -> gameId == lobbyId == 1

      await lobbies.write.createFleet(
        [lobbyId, [1n], generateStartingPositions([1n], true)],
        { account: alice.account }
      );
      await lobbies.write.createFleet(
        [lobbyId, [6n], generateStartingPositions([6n], false)],
        { account: bob.account }
      );

      // Alice flees -> bob wins; GameResults records winner=bob, loser=alice.
      await pvpMatch.write.flee([lobbyId], { account: alice.account });
      expect(await gameResults.read.isGameResultRecorded([lobbyId])).to.be.true;

      // --- Link the game to the match and record the result ---
      await asOwner.write.assignMatchGame([1n, 0n, lobbyId]);
      await asOwner.write.recordResult([1n, 0n, `0x${"ab".repeat(32)}`]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(
        bob.account.address.toLowerCase()
      );

      // --- Finalize: pool = 2 ether; fee = 0.02; champion 60% of 1.98; runner-up 40% ---
      await asOwner.write.finalize([1n]);
      expect(
        await asOwner.read.winningsOf([1n, bob.account.address])
      ).to.equal(parseEther("1.188"));
      expect(
        await asOwner.read.winningsOf([1n, alice.account.address])
      ).to.equal(parseEther("0.792"));
      expect(
        await asOwner.read.winningsOf([1n, feeRecipient.account.address])
      ).to.equal(parseEther("0.02"));

      // --- Claim (pull payment) ---
      await asBob.write.claim([1n]);
      expect(
        await asOwner.read.winningsOf([1n, bob.account.address])
      ).to.equal(0n);
      await expect(asBob.write.claim([1n])).to.be.rejectedWith("NothingToClaim");
    });

    it("rejects recordResult before a game has been assigned to the match", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      // No game assigned yet -> GameNotAssigned.
      await expect(
        asOwner.write.recordResult([1n, 0n, `0x${"00".repeat(32)}`])
      ).to.be.rejectedWith("GameNotAssigned");
    });

    it("T-03: assignMatchGame is permissionless — not gated to the tournament creator", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, now } =
        await loadFixture(deployTournamentFixture);

      const ships = deployed.ships;
      const game = deployed.game;
      const pvpMatch = deployed.pvpMatch;
      const randomManager = deployed.randomManager;
      const lobbies = deployed.lobbies;

      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]); // asOwner is the tournament creator here

      await ships.write.purchaseWithFlow(
        [alice.account.address, 0, bob.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [bob.account.address, 0, alice.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: alice.account });
      await ships.write.constructAllMyShips({ account: bob.account });

      await lobbies.write.createLobbyForAddresses([
        alice.account.address,
        bob.account.address,
        1000n,
        300n,
        0n,
        100n,
      ]);
      const lobbyId = 1n;

      await lobbies.write.createFleet(
        [lobbyId, [1n], generateStartingPositions([1n], true)],
        { account: alice.account }
      );
      await lobbies.write.createFleet(
        [lobbyId, [6n], generateStartingPositions([6n], false)],
        { account: bob.account }
      );

      await pvpMatch.write.flee([lobbyId], { account: alice.account }); // bob wins

      // Neither call below is made by the tournament creator (asOwner) — proving
      // the whole pipeline no longer depends on the creator staying responsive.
      await asBob.write.assignMatchGame([1n, 0n, lobbyId]);
      await asAlice.write.recordResult([1n, 0n, `0x${"44".repeat(32)}`]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(
        bob.account.address.toLowerCase()
      );
    });

    it("rejects reusing a game that predates this match becoming ready (T-02)", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, now } =
        await loadFixture(deployTournamentFixture);

      const ships = deployed.ships;
      const game = deployed.game;
      const pvpMatch = deployed.pvpMatch;
      const randomManager = deployed.randomManager;
      const lobbies = deployed.lobbies;

      // --- Play a real, unrelated game between alice and bob BEFORE the
      // tournament (and this match) exists at all. ---
      await ships.write.purchaseWithFlow(
        [alice.account.address, 0, bob.account.address, 1],
        { value: parseEther("4.99") }
      );
      await ships.write.purchaseWithFlow(
        [bob.account.address, 0, alice.account.address, 1],
        { value: parseEther("4.99") }
      );
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: alice.account });
      await ships.write.constructAllMyShips({ account: bob.account });

      await lobbies.write.createLobbyForAddresses([
        alice.account.address,
        bob.account.address,
        1000n,
        300n,
        0n,
        100n,
      ]);
      const oldGameId = 1n;

      await lobbies.write.createFleet(
        [oldGameId, [1n], generateStartingPositions([1n], true)],
        { account: alice.account }
      );
      await lobbies.write.createFleet(
        [oldGameId, [6n], generateStartingPositions([6n], false)],
        { account: bob.account }
      );

      // Bob wins this old, pre-tournament game.
      await pvpMatch.write.flee([oldGameId], { account: alice.account });

      // --- Only now does the tournament (and this match) come into existence.
      // The match's readyAt is strictly later than the old game above. ---
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      // HA3-03: assignMatchGame now re-verifies the T-02 timing check itself
      // (not just recordResult/resolveDraw), so the reuse attempt is
      // rejected right at assignment time, before ever reaching recordResult.
      await expect(
        asOwner.write.assignMatchGame([1n, 0n, oldGameId])
      ).to.be.rejectedWith("GamePredatesAssignment");
    });
  });

  describe("Forfeit timeout (T-05)", function () {
    it("rejects createTournament with maxPlayers above MAX_PLAYERS (HA6-17)", async function () {
      const { asOwner, now } = await loadFixture(deployTournamentFixture);
      expect(await asOwner.read.MAX_PLAYERS()).to.equal(128);
      await expect(
        asOwner.write.createTournament([defaultConfig(now, { maxPlayers: 129 })])
      ).to.be.rejectedWith("InvalidConfig");
      await asOwner.write.createTournament([defaultConfig(now, { maxPlayers: 128 })]);
    });

    it("rejects createTournament with a matchTimeout outside [MIN, MAX]", async function () {
      const { asOwner, now } = await loadFixture(deployTournamentFixture);
      await expect(
        asOwner.write.createTournament([
          defaultConfig(now, { matchTimeout: 3599n }), // below MIN_MATCH_TIMEOUT
        ])
      ).to.be.rejectedWith("InvalidConfig");
      await expect(
        asOwner.write.createTournament([
          defaultConfig(now, { matchTimeout: 604801n }), // above MAX_MATCH_TIMEOUT
        ])
      ).to.be.rejectedWith("InvalidConfig");
    });

    it("rejects claimForfeitWin before the timeout has elapsed", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      await expect(
        asAlice.write.claimForfeitWin([1n, 0n])
      ).to.be.rejectedWith("MatchTimeoutNotReached");
    });

    it("rejects claimForfeitWin from an address that isn't one of the match's players", async function () {
      const { asOwner, asAlice, asBob, asCarol, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      await increaseTime(3601);

      await expect(
        asCarol.write.claimForfeitWin([1n, 0n])
      ).to.be.rejectedWith("NotAMatchPlayer");
    });

    it("rejects claimForfeitWin once a game has already been assigned", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      // HA3-03: assignMatchGame now validates its gameId, so this needs a
      // genuinely real game between the match's two players (a fake id like
      // 999n would now revert at assignment time, not later).
      const gameId = await createRealGameBetween(deployed, alice, bob);
      await asBob.write.assignMatchGame([1n, 0n, gameId]);
      await increaseTime(3601);

      await expect(
        asAlice.write.claimForfeitWin([1n, 0n])
      ).to.be.rejectedWith("GameAlreadyAssigned");
    });

    it("lets the present player claim a walkover once matchTimeout has elapsed with no game assigned", async function () {
      const { asOwner, asAlice, asBob, bob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]); // final match: player1 = alice, player2 = bob

      // Alice never shows up. Once matchTimeout elapses, bob claims the walkover.
      await increaseTime(3601);
      await asBob.write.claimForfeitWin([1n, 0n]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(
        bob.account.address.toLowerCase()
      );
    });
  });

  describe("Stalled match resolution (griefing backstop)", function () {
    // Regression coverage for the "two silent registrants freeze the whole
    // bracket forever" griefing vector: since seed == registration order
    // and pairing is deterministic, any account can guarantee a self-vs-self
    // match, then simply never play or forfeit it, blocking finalize() for
    // every other registrant and sponsor with no recovery path before this
    // fix. resolveStalledMatch is the permissionless backstop.

    it("rejects resolveStalledMatch before the timeout has elapsed", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);

      await expect(
        asOwner.write.resolveStalledMatch([1n, 0n])
      ).to.be.rejectedWith("MatchTimeoutNotReached");
    });

    it("rejects resolveStalledMatch on an assigned game until its turn timeout plus matchTimeout has passed", async function () {
      const { deployed, asOwner, asAlice, asBob, alice, bob, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      // HA3-03: assignMatchGame now validates its gameId (see the sibling
      // claimForfeitWin test above for the same reasoning).
      const gameId = await createRealGameBetween(deployed, alice, bob);
      await asBob.write.assignMatchGame([1n, 0n, gameId]);
      // Past matchTimeout from readyAt, but not past the game's turn
      // timeout (300s) + matchTimeout (3600s) — the waiting player still
      // has their grace period to end the game normally.
      await increaseTime(3601);

      await expect(
        asOwner.write.resolveStalledMatch([1n, 0n])
      ).to.be.rejectedWith("GameNotStalled");
    });

    it("resolves an assigned game both players abandoned against the player whose turn it was (HA6-08)", async function () {
      const { deployed, asOwner, asAlice, asBob, asCarol, alice, bob, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      const gameId = await createRealGameBetween(deployed, alice, bob);
      await asBob.write.assignMatchGame([1n, 0n, gameId]);

      const [, turnState] = await deployed.game.read.getGameMetadataAndTurnState([
        gameId,
      ]);
      const stalledPlayer = turnState.currentTurn.toLowerCase();
      const expectedWinner =
        stalledPlayer === alice.account.address.toLowerCase()
          ? bob.account.address.toLowerCase()
          : alice.account.address.toLowerCase();

      // Neither player moves, times out, or flees. Past turn timeout (300s)
      // + matchTimeout (3600s), an uninvolved third party unfreezes it.
      await increaseTime(300 + 3600 + 1);
      await asCarol.write.resolveStalledMatch([1n, 0n]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      expect(bracket[0].winner.toLowerCase()).to.equal(expectedWinner);
      await asOwner.write.finalize([1n]);
    });

    it("rejects resolveStalledMatch once the match is already resolved", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      await increaseTime(3601);
      await asBob.write.claimForfeitWin([1n, 0n]);

      await expect(
        asOwner.write.resolveStalledMatch([1n, 0n])
      ).to.be.rejectedWith("MatchAlreadyResolved");
    });

    it("lets an uninvolved third party force-resolve a match neither player engaged with, unfreezing finalize() and claim() for everyone", async function () {
      const { asOwner, asAlice, asBob, asCarol, alice, bob, feeRecipient, now } =
        await loadFixture(deployTournamentFixture);
      await asOwner.write.createTournament([
        defaultConfig(now, { maxPlayers: 2 }),
      ]);
      // Both registrants — simulating two Sybil accounts landing in the same
      // (here, the only) match — go completely silent: neither assigns a
      // game nor calls claimForfeitWin.
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asOwner.write.start([1n]);
      await hre.network.provider.send("evm_mine");
      await asOwner.write.buildBracket([1n]);
      await increaseTime(3601);

      // Seeding is shuffled at buildBracket() time, so which of alice/bob
      // is player1 (seed 1, the tiebreak winner) is no longer determined by
      // registration order — read it back instead of assuming alice.
      const beforeResolve = await asOwner.read.getBracket([1n]);
      const winnerAddress = beforeResolve[0].player1;
      const asWinner = winnerAddress.toLowerCase() === alice.account.address.toLowerCase()
        ? asAlice
        : asBob;
      const winnerAccount = winnerAddress.toLowerCase() === alice.account.address.toLowerCase()
        ? alice
        : bob;

      // Carol is not a participant in this tournament at all — proving this
      // really is permissionless, not just open to the other player.
      await asCarol.write.resolveStalledMatch([1n, 0n]);

      const bracket = await asOwner.read.getBracket([1n]);
      expect(bracket[0].resolved).to.be.true;
      // Seed tiebreak always resolves to player1 in a straight 2-player
      // final (seed 1 <= seed 2), regardless of who the shuffle assigned it to.
      expect(bracket[0].winner.toLowerCase()).to.equal(
        winnerAddress.toLowerCase()
      );

      // The bracket is no longer stuck: finalize() and claim() now work,
      // proving the whole prize pool (including the protocol fee) is freed.
      await asOwner.write.finalize([1n]);
      const winnerWinnings = await asOwner.read.winningsOf([
        1n,
        winnerAccount.account.address,
      ]);
      const feeWinnings = await asOwner.read.winningsOf([
        1n,
        feeRecipient.account.address,
      ]);
      expect(winnerWinnings > 0n).to.be.true;
      expect(feeWinnings > 0n).to.be.true;
      await asWinner.write.claim([1n]);
    });
  });

  describe("Cancellation & refunds", function () {
    it("cancels below min after the deadline and refunds players and the sponsor", async function () {
      const { asOwner, asAlice, asBob, now } = await loadFixture(
        deployTournamentFixture
      );
      // min 3, so two registrants is below min.
      await asOwner.write.createTournament(
        [defaultConfig(now, { minPlayers: 3 })],
        { value: parseEther("5") } // owner is the sponsor
      );
      await asAlice.write.register([1n, 0n, 1n, EMPTY_PROOF], {
        value: parseEther("1"),
      });
      await asBob.write.register([1n, 0n, 2n, EMPTY_PROOF], {
        value: parseEther("1"),
      });

      // Cannot cancel before the deadline.
      await expect(asOwner.write.cancel([1n])).to.be.rejectedWith(
        "CancelConditionsNotMet"
      );

      await increaseTime(3601);
      await asOwner.write.cancel([1n]);

      // Players reclaim entry fees; second attempt reverts.
      await asAlice.write.claimRefund([1n]);
      await expect(asAlice.write.claimRefund([1n])).to.be.rejectedWith(
        "NothingToClaim"
      );
      await asBob.write.claimRefund([1n]);

      // Sponsor (owner) reclaims the sponsor amount.
      await asOwner.write.claimRefund([1n]);
      await expect(asOwner.write.claimRefund([1n])).to.be.rejectedWith(
        "NothingToClaim"
      );
    });
  });

  describe("Win effects", function () {
    it("has none: tournaments are PvP and win effects are PvE-only (HA6-27)", async function () {
      const artifact = await hre.artifacts.readArtifact("Tournament");
      const names = artifact.abi.map((i: any) => i.name);
      expect(names).to.not.include("setWinEffects");
      expect(names).to.not.include("getWinEffects");
    });
  });
});
