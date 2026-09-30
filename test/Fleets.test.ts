import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther } from "viem";
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
