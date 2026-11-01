import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import { ShipTuple, tupleToShip, MapMode } from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";

// Deployment zones as map data (2026-09-23): Fleets.createFleet now takes a
// mapId and, when the selected map has a custom creator/joiner zone
// configured (Maps.setCreatorZone/setJoinerZone), validates starting
// positions against that zone instead of the engine-wide default column
// band (creator col 0-3, joiner col 13-16). A map with no custom zone (or
// mapId == 0, the synthetic-fleet sentinel) falls back to that default
// exactly as before this feature existed.
//
// These tests bypass Lobbies entirely and call Fleets.createFleet directly
// (same isolation pattern as Game.test.ts's "Fleets.removeShipFromFleet
// (G-02)" tests), since Lobbies' own createFleet wrapper signature didn't
// change and this feature is really about Fleets<->Maps, not the PvP flow.
// Other createFleet coverage (ownership, cost, variant mixing, duplicate
// positions) is unchanged and stays in Game.test.ts/Lobbies.test.ts.
describe("Fleets — deployment zones (per-map)", function () {
  async function deployFixture() {
    const [owner, creator] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    await deployed.fleets.write.setIsAllowedToManageFleets([
      owner.account.address,
      true,
    ]);

    await deployed.ships.write.purchaseWithFlow(
      [creator.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const shipTuple = (await deployed.ships.read.ships([
        BigInt(i),
      ])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await deployed.randomManager.write.revealRandomness([
        ship.traits.serialNumber,
      ]);
    }
    await deployed.ships.write.constructAllMyShips({
      account: creator.account,
    });

    return {
      fleets: deployed.fleets,
      maps: deployed.maps,
      ships: deployed.ships,
      owner,
      creator,
    };
  }

  async function createEmptyMap(
    f: Awaited<ReturnType<typeof deployFixture>>,
  ): Promise<bigint> {
    await f.maps.write.createFullPresetMap([[], [], [], MapMode.Both], {
      account: f.owner.account,
    });
    return f.maps.read.mapCount();
  }

  it("falls back to the default column band when the map has no custom zone", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);

    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 0, col: 2 }],
        1000n,
        true,
        mapId,
      ]),
    ).to.not.be.rejected;
  });

  it("rejects an unconstructed ship even after its costs are synced (HA6-23)", async function () {
    const f = await loadFixture(deployFixture);
    // A fresh pack: ships 6-10, unconstructed.
    await f.ships.write.purchaseWithFlow(
      [f.creator.account.address, 0n, f.creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    // The permissionless sync stamps a current costsVersion on it (L-03).
    await f.ships.write.syncShipCosts([[6n]]);
    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [6n],
        [{ row: 0, col: 0 }],
        1000n,
        true,
        0n,
      ]),
    ).to.be.rejectedWith("ShipNotConstructed");
  });

  it("rejects a duplicate shipId across two slots in the same fleet (HA4-05)", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);

    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n, 1n],
        [{ row: 0, col: 0 }, { row: 0, col: 1 }],
        1000n,
        true,
        mapId,
      ]),
    ).to.be.rejectedWith("DuplicateShipId");
  });

  it("rejects a creator position outside the default column band when the map has no custom zone", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);

    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 0, col: 8 }],
        1000n,
        true,
        mapId,
      ]),
    ).to.be.rejectedWith("InvalidPosition");
  });

  it("accepts a position inside a map's custom creator zone, even outside the old default column band", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);
    await f.maps.write.setCreatorZone([mapId, [{ row: 5, col: 8 }]], {
      account: f.owner.account,
    });

    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 5, col: 8 }],
        1000n,
        true,
        mapId,
      ]),
    ).to.not.be.rejected;
  });

  it("rejects a position outside a map's custom creator zone, even if it was legal under the old default", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);
    await f.maps.write.setCreatorZone([mapId, [{ row: 5, col: 8 }]], {
      account: f.owner.account,
    });

    // col 2 was a legal creator position under the old global default, but
    // this map's custom zone doesn't include it.
    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 0, col: 2 }],
        1000n,
        true,
        mapId,
      ]),
    ).to.be.rejectedWith("InvalidPosition");
  });

  it("validates the joiner side against its own custom zone independently of the creator zone", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);
    await f.maps.write.setJoinerZone([mapId, [{ row: 3, col: 8 }]], {
      account: f.owner.account,
    });

    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 3, col: 8 }],
        1000n,
        false,
        mapId,
      ]),
    ).to.not.be.rejected;

    // Old default joiner band (col 13-16) no longer applies to this map.
    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [2n],
        [{ row: 3, col: 15 }],
        1000n,
        false,
        mapId,
      ]),
    ).to.be.rejectedWith("InvalidPosition");
  });

  it("mapId=0 always uses the default column rule, even when the map it would have pointed at has a custom zone", async function () {
    const f = await loadFixture(deployFixture);
    const mapId = await createEmptyMap(f);
    await f.maps.write.setCreatorZone([mapId, [{ row: 5, col: 8 }]], {
      account: f.owner.account,
    });

    // mapId 0 is the synthetic-fleet sentinel (see RoguelikeMatch/
    // RoguelikeResupply's placeholder-fleet callers) -- it ignores every
    // map's zone configuration and falls back to the historical default,
    // unchanged.
    await expect(
      f.fleets.write.createFleet([
        0n,
        f.creator.account.address,
        [1n],
        [{ row: 0, col: 2 }],
        1000n,
        true,
        0n,
      ]),
    ).to.not.be.rejected;
  });
});

// Fleets.transferFleet (2026-10-30): moves a roster from its reservation
// fleet into a game's fleet without unlocking the ships. Called directly
// here, as an allowlisted manager, like the tests above.
describe("Fleets.transferFleet", function () {
  async function deployFixture() {
    const [owner, creator, other] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    await deployed.fleets.write.setIsAllowedToManageFleets([
      owner.account.address,
      true,
    ]);

    await deployed.ships.write.purchaseWithFlow(
      [creator.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const ship = tupleToShip(
        (await deployed.ships.read.ships([BigInt(i)])) as ShipTuple,
      );
      await deployed.randomManager.write.revealRandomness([
        ship.traits.serialNumber,
      ]);
    }
    await deployed.ships.write.constructAllMyShips({
      account: creator.account,
    });

    // A reservation fleet: ships 1-3, map-agnostic (mapId 0).
    const roster = [1n, 2n, 3n];
    await deployed.fleets.write.createFleet([
      0n,
      creator.account.address,
      roster,
      roster.map((_, i) => ({ row: i, col: 0 })),
      100000n,
      true,
      0n,
    ]);
    const reservationId = await deployed.fleets.read.fleetCount();

    return {
      fleets: deployed.fleets,
      ships: deployed.ships,
      owner,
      creator,
      other,
      roster,
      reservationId,
    };
  }

  const positions = [
    { row: 4, col: 1 },
    { row: 5, col: 2 },
    { row: 6, col: 3 },
  ];

  const transfer = (
    f: Awaited<ReturnType<typeof deployFixture>>,
    overrides: { from?: bigint; owner?: `0x${string}`; ids?: bigint[]; cap?: bigint } = {},
  ) =>
    f.fleets.write.transferFleet([
      overrides.from ?? f.reservationId,
      7n,
      overrides.owner ?? f.creator.account.address,
      overrides.ids ?? f.roster,
      positions,
      overrides.cap ?? 100000n,
      true,
      0n,
    ]);

  it("moves the ships into a new fleet without unlocking them, and empties the old one", async function () {
    const f = await loadFixture(deployFixture);
    const before = await f.fleets.read.getFleet([f.reservationId]);

    await transfer(f);
    const newId = await f.fleets.read.fleetCount();

    const moved = await f.fleets.read.getFleet([newId]);
    expect(moved.lobbyId).to.equal(7n);
    expect(moved.owner.toLowerCase()).to.equal(
      f.creator.account.address.toLowerCase(),
    );
    expect(moved.shipIds).to.deep.equal(f.roster);
    expect(moved.startingPositions).to.deep.equal(positions);
    expect(moved.totalCost).to.equal(before.totalCost);
    expect(moved.isComplete).to.equal(true);

    expect((await f.fleets.read.getFleet([f.reservationId])).shipIds).to.deep.equal([]);
    for (const id of f.roster) {
      expect((await f.ships.read.getShip([id])).shipData.inFleet).to.equal(true);
    }

    // Clearing the new fleet releases the ships as usual.
    await f.fleets.write.clearFleet([newId]);
    for (const id of f.roster) {
      expect((await f.ships.read.getShip([id])).shipData.inFleet).to.equal(false);
    }
  });

  it("rejects ids that aren't the old fleet's, in the same order", async function () {
    const f = await loadFixture(deployFixture);
    await expect(transfer(f, { ids: [2n, 1n, 3n] })).to.be.rejectedWith(
      "FleetShipsMismatch",
    );
    await expect(transfer(f, { ids: [1n, 2n, 4n] })).to.be.rejectedWith(
      "FleetShipsMismatch",
    );
  });

  it("can't hand off the same reservation twice", async function () {
    const f = await loadFixture(deployFixture);
    await transfer(f);
    await expect(transfer(f)).to.be.rejectedWith("FleetShipsMismatch");
  });

  it("rejects a fleet over the cost cap", async function () {
    const f = await loadFixture(deployFixture);
    const { totalCost } = await f.fleets.read.getFleet([f.reservationId]);
    await expect(transfer(f, { cap: totalCost - 1n })).to.be.rejectedWith(
      "InvalidFleetCost",
    );
    await expect(transfer(f, { cap: totalCost })).to.not.be.rejected;
  });

  it("rejects the wrong owner, an unknown fleet and a caller that can't manage fleets", async function () {
    const f = await loadFixture(deployFixture);
    await expect(
      transfer(f, { owner: f.other.account.address }),
    ).to.be.rejectedWith("ShipNotOwned");
    await expect(transfer(f, { from: 999n })).to.be.rejectedWith(
      "FleetNotFound",
    );
    await expect(
      f.fleets.write.transferFleet(
        [f.reservationId, 7n, f.creator.account.address, f.roster, positions, 100000n, true, 0n],
        { account: f.other.account },
      ),
    ).to.be.rejectedWith("NotAllowedToManageFleets");
  });
});

// reserveFleet (2026-10-31): a roguelike win re-reserves the combat
// fleet's survivors without unlocking them, plus any rejoining ships, which
// get the usual checks and locks.
describe("Fleets.reserveFleet", function () {
  async function deployFixture() {
    const [owner, creator, other] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    await deployed.fleets.write.setIsAllowedToManageFleets([
      owner.account.address,
      true,
    ]);

    for (const buyer of [creator, other]) {
      await deployed.ships.write.purchaseWithFlow(
        [buyer.account.address, 0n, buyer.account.address, 1],
        { value: parseEther("4.99") },
      );
    }
    const count = Number(await deployed.ships.read.shipCount());
    for (let i = 1; i <= count; i++) {
      const ship = tupleToShip(
        (await deployed.ships.read.ships([BigInt(i)])) as ShipTuple,
      );
      await deployed.randomManager.write.revealRandomness([
        ship.traits.serialNumber,
      ]);
    }
    for (const buyer of [creator, other]) {
      await deployed.ships.write.constructAllMyShips({
        account: buyer.account,
      });
    }
    // The other player's first ship.
    const othersShip = BigInt(count / 2 + 1);

    // A combat fleet of ships 1-3 that lost ship 2 mid-game.
    await deployed.fleets.write.createFleet([
      0n,
      creator.account.address,
      [1n, 2n, 3n],
      [0, 1, 2].map((row) => ({ row, col: 0 })),
      100000n,
      true,
      0n,
    ]);
    const combatId = await deployed.fleets.read.fleetCount();
    await deployed.fleets.write.removeShipFromFleet([combatId, 2n]);

    return {
      fleets: deployed.fleets,
      ships: deployed.ships,
      creator,
      other,
      combatId,
      othersShip,
    };
  }

  const reserve = (
    f: Awaited<ReturnType<typeof deployFixture>>,
    ids: bigint[],
    cap = 100000n,
  ) =>
    f.fleets.write.reserveFleet([
      f.combatId,
      f.creator.account.address,
      ids,
      ids.map((_, i) => ({ row: Math.floor(i / 4), col: i % 4 })),
      cap,
    ]);

  const costOf = async (f: any, id: bigint) =>
    BigInt((await f.ships.read.getShip([id])).shipData.cost);

  it("keeps the survivors locked, checks and locks a rejoining ship, and empties the old fleet", async function () {
    const f = await loadFixture(deployFixture);
    const survivors = (await f.fleets.read.getFleet([f.combatId])).shipIds;
    expect(survivors).to.deep.equal([1n, 3n]);
    const keptCost = (await f.fleets.read.getFleet([f.combatId])).totalCost;

    await reserve(f, [...survivors, 2n]);
    const newId = await f.fleets.read.fleetCount();

    const fleet = await f.fleets.read.getFleet([newId]);
    expect(fleet.lobbyId).to.equal(0n);
    expect(fleet.shipIds).to.deep.equal([1n, 3n, 2n]);
    expect(fleet.totalCost).to.equal(keptCost + (await costOf(f, 2n)));
    expect((await f.fleets.read.getFleet([f.combatId])).shipIds).to.deep.equal([]);
    for (const id of [1n, 2n, 3n]) {
      expect((await f.ships.read.getShip([id])).shipData.inFleet).to.equal(true);
    }
  });

  it("re-reserves the survivors alone", async function () {
    const f = await loadFixture(deployFixture);
    await reserve(f, [1n, 3n]);
    const fleet = await f.fleets.read.getFleet([await f.fleets.read.fleetCount()]);
    expect(fleet.shipIds).to.deep.equal([1n, 3n]);
    expect((await f.ships.read.getShip([2n])).shipData.inFleet).to.equal(false);
  });

  it("rejects survivors out of order, missing or repeated, and can't run twice", async function () {
    const f = await loadFixture(deployFixture);
    await expect(reserve(f, [3n, 1n])).to.be.rejectedWith("FleetShipsMismatch");
    await expect(reserve(f, [1n])).to.be.rejectedWith("FleetShipsMismatch");
    await expect(reserve(f, [1n, 3n, 1n])).to.be.rejectedWith("DuplicateShipId");
    await expect(reserve(f, [1n, 3n, 2n, 2n])).to.be.rejectedWith("DuplicateShipId");
    await reserve(f, [1n, 3n]);
    // The old fleet is empty now, so a repeat treats the survivors as
    // joining ships, which are still locked (ShipAlreadyInFleet).
    await expect(reserve(f, [1n, 3n])).to.be.rejected;
  });

  it("checks rejoining ships like any new fleet ship", async function () {
    const f = await loadFixture(deployFixture);
    await expect(reserve(f, [1n, 3n, f.othersShip])).to.be.rejectedWith(
      "ShipNotOwned",
    );
    // Ship 4 is locked in another fleet.
    await f.fleets.write.createFleet([
      0n,
      f.creator.account.address,
      [4n],
      [{ row: 0, col: 0 }],
      100000n,
      true,
      0n,
    ]);
    await expect(reserve(f, [1n, 3n, 4n])).to.be.rejectedWith(
      "ShipAlreadyInFleet",
    );
  });

  it("counts kept and rejoining ships against the cost cap", async function () {
    const f = await loadFixture(deployFixture);
    const total =
      (await f.fleets.read.getFleet([f.combatId])).totalCost +
      (await costOf(f, 2n));
    await expect(reserve(f, [1n, 3n, 2n], total - 1n)).to.be.rejectedWith(
      "InvalidFleetCost",
    );
    await expect(reserve(f, [1n, 3n, 2n], total)).to.not.be.rejected;
  });

  it("rejects the wrong owner and a caller that can't manage fleets", async function () {
    const f = await loadFixture(deployFixture);
    await expect(
      f.fleets.write.reserveFleet([
        f.combatId,
        f.other.account.address,
        [1n, 3n],
        [{ row: 0, col: 0 }, { row: 0, col: 1 }],
        100000n,
      ]),
    ).to.be.rejectedWith("ShipNotOwned");
    await expect(
      f.fleets.write.reserveFleet(
        [
          f.combatId,
          f.creator.account.address,
          [1n, 3n],
          [{ row: 0, col: 0 }, { row: 0, col: 1 }],
          100000n,
        ],
        { account: f.other.account },
      ),
    ).to.be.rejectedWith("NotAllowedToManageFleets");
  });
});

// AI fleets (2026-10-31): a fleet owned by the calling orchestrator whose
// ids are all in AIShips' range skips the per-ship Ships checks and the
// inFleet flags. Any other fleet still gets every check.
describe("Fleets AI fleets", function () {
  async function deployFixture() {
    const [owner, creator] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);
    await deployed.fleets.write.setIsAllowedToManageFleets([owner.account.address, true]);
    await deployed.aiShips.write.setIsAllowedToCreateShips([owner.account.address, true]);

    // One human ship for creator.
    await deployed.ships.write.purchaseWithFlow(
      [creator.account.address, 0n, creator.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const ship = tupleToShip((await deployed.ships.read.ships([BigInt(i)])) as ShipTuple);
      await deployed.randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await deployed.ships.write.constructAllMyShips({ account: creator.account });

    const template = {
      name: "AI Ship",
      id: 0n,
      equipment: { mainWeapon: 0, armor: 0, shields: 0, special: 0 },
      traits: {
        serialNumber: 0n,
        colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0 },
        variant: 1,
        accuracy: 0,
        hull: 0,
        speed: 0,
      },
      shipData: {
        shipsDestroyed: 0, costsVersion: 0, cost: 0, modified: 0, shiny: false,
        constructed: false, inFleet: false, isFreeShip: false, timestampDestroyed: 0n,
      },
      owner: zeroAddress,
    };
    for (let i = 0; i < 3; i++) {
      await deployed.aiShips.write.allocateShip([owner.account.address, template]);
    }
    const aiIds = [1n, 2n, 3n].map((n) => 2n ** 40n + n);
    return { deployed, owner, creator, aiIds };
  }

  const positions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ row: i, col: 13 }));

  it("creates, trims and clears an orchestrator's own AI fleet without touching AI ships' inFleet", async function () {
    const { deployed, owner, aiIds } = await loadFixture(deployFixture);
    const { fleets, shipsRouter } = deployed;
    await fleets.write.createFleet([
      0n, owner.account.address, aiIds, positions(3), 2n ** 256n - 1n, false, 0n,
    ]);
    const fleetId = await fleets.read.fleetCount();
    expect(await fleets.read.isShipInFleet([fleetId, aiIds[0]])).to.equal(true);
    expect((await shipsRouter.read.getShip([aiIds[0]])).shipData.inFleet).to.equal(false);
    expect((await fleets.read.getFleet([fleetId])).isComplete).to.equal(true);

    await fleets.write.removeShipFromFleet([fleetId, aiIds[1]]);
    expect(await fleets.read.isShipInFleet([fleetId, aiIds[1]])).to.equal(false);

    await fleets.write.clearFleet([fleetId]);
    expect(await fleets.read.isShipInFleet([fleetId, aiIds[0]])).to.equal(false);
  });

  it("still checks a caller-owned fleet that includes a human ship", async function () {
    const { deployed, owner, aiIds } = await loadFixture(deployFixture);
    // Ship 1 belongs to creator, not the caller.
    await expect(
      deployed.fleets.write.createFleet([
        0n, owner.account.address, [aiIds[0], 1n], positions(2), 2n ** 256n - 1n, false, 0n,
      ]),
    ).to.be.rejectedWith("ShipNotOwned");
  });

  it("still checks a player's fleet made of AI ids", async function () {
    const { deployed, creator, aiIds } = await loadFixture(deployFixture);
    // The AI ships belong to the orchestrator, not the player.
    await expect(
      deployed.fleets.write.createFleet([
        0n, creator.account.address, [aiIds[0]], positions(1), 2n ** 256n - 1n, false, 0n,
      ]),
    ).to.be.rejectedWith("ShipNotOwned");
  });
});
