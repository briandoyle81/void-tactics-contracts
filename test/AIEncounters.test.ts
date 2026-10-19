import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { MapMode } from "./types";

// Standalone tests — AIEncounters only depends on Maps (read-only, via
// mapExists), so this deploys just those two contracts directly rather than
// the full DeployAndConfig module, matching test/Maps.test.ts's convention.
describe("AIEncounters", function () {
  const defaultTraits = {
    serialNumber: 0n,
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
    speed: 0,
  };

  const defaultEquipment = {
    mainWeapon: 0, // Generic
    armor: 0, // None
    shields: 0, // None
    special: 0, // None
  };

  const defaultArchetype = 0; // Grunt

  async function deployFixture() {
    const [owner, editor, other] = await hre.viem.getWalletClients();

    const maps = await hre.viem.deployContract("Maps", []);
    const aiEncounters = await hre.viem.deployContract("AIEncounters", [
      maps.address,
    ]);

    const editorAIEncounters = await hre.viem.getContractAt(
      "AIEncounters",
      aiEncounters.address,
      { client: { wallet: editor } },
    );
    const otherAIEncounters = await hre.viem.getContractAt(
      "AIEncounters",
      aiEncounters.address,
      { client: { wallet: other } },
    );

    // A real preset map for placement tests to reference.
    await maps.write.createPresetMap([[], MapMode.Both]);

    return {
      maps,
      aiEncounters,
      editorAIEncounters,
      otherAIEncounters,
      owner,
      editor,
      other,
    };
  }

  describe("Encounter editor role", function () {
    it("owner can grant and revoke encounter-editor rights", async function () {
      const { aiEncounters, editor } = await loadFixture(deployFixture);

      expect(await aiEncounters.read.isEncounterEditor([editor.account.address])).to
        .be.false;

      await aiEncounters.write.setEncounterEditor([
        editor.account.address,
        true,
      ]);
      expect(await aiEncounters.read.isEncounterEditor([editor.account.address])).to
        .be.true;

      await aiEncounters.write.setEncounterEditor([
        editor.account.address,
        false,
      ]);
      expect(await aiEncounters.read.isEncounterEditor([editor.account.address])).to
        .be.false;
    });

    it("reverts when a non-owner tries to grant encounter-editor rights", async function () {
      const { otherAIEncounters, other } = await loadFixture(deployFixture);
      await expect(
        otherAIEncounters.write.setEncounterEditor([other.account.address, true]),
      ).to.be.rejected;
    });

    it("reverts when a non-owner, non-editor calls an editor-gated function", async function () {
      const { otherAIEncounters } = await loadFixture(deployFixture);
      await expect(
        otherAIEncounters.write.createAIShipConfig([
          "Test",
          defaultEquipment,
          defaultTraits,
        defaultArchetype,
        ]),
      ).to.be.rejectedWith("NotEncounterEditor");
    });

    it("allows a granted editor (not just the owner) to call editor-gated functions", async function () {
      const { aiEncounters, editorAIEncounters, editor } =
        await loadFixture(deployFixture);
      await aiEncounters.write.setEncounterEditor([
        editor.account.address,
        true,
      ]);

      await expect(
        editorAIEncounters.write.createAIShipConfig([
          "Editor Ship",
          defaultEquipment,
          defaultTraits,
        defaultArchetype,
        ]),
      ).to.not.be.rejected;
    });
  });

  describe("AI ship config registry", function () {
    it("creates configs with sequential ids and stores fields exactly", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);

      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.createAIShipConfig([
        "Bruiser",
        { mainWeapon: 1, armor: 2, shields: 0, special: 1 },
        { ...defaultTraits, variant: 2, accuracy: 1, hull: 2, speed: 1 },
        1, // Aggressor
      ]);

      expect(await aiEncounters.read.aiShipConfigCount()).to.equal(2n);

      const scout = await aiEncounters.read.getAIShipConfig([1n]);
      expect(scout.id).to.equal(1n);
      expect(scout.name).to.equal("Scout");
      expect(scout.equipment.mainWeapon).to.equal(0);
      expect(scout.traits.variant).to.equal(1);

      const bruiser = await aiEncounters.read.getAIShipConfig([2n]);
      expect(bruiser.name).to.equal("Bruiser");
      expect(bruiser.equipment.mainWeapon).to.equal(1);
      expect(bruiser.equipment.armor).to.equal(2);
      expect(bruiser.traits.variant).to.equal(2);
      expect(bruiser.traits.hull).to.equal(2);
      expect(bruiser.archetype).to.equal(1);
    });

    it("emits AIShipConfigCreated", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      const hash = await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
    });

    it("reverts with InvalidTier when accuracy, hull, or speed exceeds 2", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await expect(
        aiEncounters.write.createAIShipConfig([
          "Bad",
          defaultEquipment,
          { ...defaultTraits, accuracy: 3 },
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("InvalidTier");
      await expect(
        aiEncounters.write.createAIShipConfig([
          "Bad",
          defaultEquipment,
          { ...defaultTraits, hull: 3 },
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("InvalidTier");
      await expect(
        aiEncounters.write.createAIShipConfig([
          "Bad",
          defaultEquipment,
          { ...defaultTraits, speed: 3 },
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("InvalidTier");
    });

    it("reverts with InvalidVariant when variant is 0", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await expect(
        aiEncounters.write.createAIShipConfig([
          "Bad",
          defaultEquipment,
          { ...defaultTraits, variant: 0 },
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("InvalidVariant");
    });

    it("updates an existing config in place", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      await aiEncounters.write.updateAIShipConfig([
        1n,
        "Scout Mk2",
        { ...defaultEquipment, mainWeapon: 2 },
        { ...defaultTraits, speed: 2 },
        2, // Sniper
      ]);

      const updated = await aiEncounters.read.getAIShipConfig([1n]);
      expect(updated.name).to.equal("Scout Mk2");
      expect(updated.equipment.mainWeapon).to.equal(2);
      expect(updated.traits.speed).to.equal(2);
      expect(updated.archetype).to.equal(2);
      // id count shouldn't grow from an update
      expect(await aiEncounters.read.aiShipConfigCount()).to.equal(1n);
    });

    it("reverts ConfigNotFound when updating id 0 or a nonexistent id", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await expect(
        aiEncounters.write.updateAIShipConfig([
          0n,
          "X",
          defaultEquipment,
          defaultTraits,
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("ConfigNotFound");
      await expect(
        aiEncounters.write.updateAIShipConfig([
          999n,
          "X",
          defaultEquipment,
          defaultTraits,
          defaultArchetype,
        ]),
      ).to.be.rejectedWith("ConfigNotFound");
    });

    it("reverts ConfigNotFound when reading id 0 or a nonexistent id", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await expect(
        aiEncounters.read.getAIShipConfig([0n]),
      ).to.be.rejectedWith("ConfigNotFound");
      await expect(
        aiEncounters.read.getAIShipConfig([999n]),
      ).to.be.rejectedWith("ConfigNotFound");
    });

    it("getAllAIShipConfigs returns every config in id order", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "First",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.createAIShipConfig([
        "Second",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      const all = await aiEncounters.read.getAllAIShipConfigs();
      expect(all.length).to.equal(2);
      expect(all[0].name).to.equal("First");
      expect(all[1].name).to.equal("Second");
    });

    it("getAIShipConfigsPaginated (GR-02 escape hatch) matches getAllAIShipConfigs when paged in full", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      for (let i = 0; i < 5; i++) {
        await aiEncounters.write.createAIShipConfig([
          `Config ${i}`,
          defaultEquipment,
          defaultTraits,
          defaultArchetype,
        ]);
      }

      const all = await aiEncounters.read.getAllAIShipConfigs();

      const page1 = await aiEncounters.read.getAIShipConfigsPaginated([0n, 2n]);
      const page2 = await aiEncounters.read.getAIShipConfigsPaginated([2n, 2n]);
      const page3 = await aiEncounters.read.getAIShipConfigsPaginated([4n, 2n]);

      expect(page1.length).to.equal(2);
      expect(page2.length).to.equal(2);
      // Last page runs past the end (offset 4, limit 2, only 1 remains) —
      // returns fewer than _limit rather than reverting.
      expect(page3.length).to.equal(1);

      const reassembled = [...page1, ...page2, ...page3];
      expect(reassembled.map((c) => c.name)).to.deep.equal(
        all.map((c) => c.name),
      );
    });

    it("getAIShipConfigsPaginated returns an empty array for an offset past the end", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Only",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      const page = await aiEncounters.read.getAIShipConfigsPaginated([
        50n,
        10n,
      ]);
      expect(page.length).to.equal(0);
    });
  });

  describe("Map placements", function () {
    it("reverts MapNotFound when the map doesn't exist", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await expect(
        aiEncounters.write.setMapPlacement([999n, 0, 13, 1n]),
      ).to.be.rejectedWith("MapNotFound");
    });

    it("reverts InvalidPosition for out-of-window row/col (each bound independently)", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await expect(
        aiEncounters.write.setMapPlacement([1n, -1, 13, 1n]),
      ).to.be.rejectedWith("InvalidPosition");
      await expect(
        aiEncounters.write.setMapPlacement([1n, 11, 13, 1n]),
      ).to.be.rejectedWith("InvalidPosition");
      await expect(
        aiEncounters.write.setMapPlacement([1n, 0, 12, 1n]),
      ).to.be.rejectedWith("InvalidPosition");
      await expect(
        aiEncounters.write.setMapPlacement([1n, 0, 17, 1n]),
      ).to.be.rejectedWith("InvalidPosition");
    });

    // Fixed 2026-10-19: placements used to be hardcoded to the default
    // joiner columns 13-16, so a map with a custom joiner zone couldn't save
    // its AI fleet in the zone's other tiles (seen on Base Sepolia map 67).
    it("follows the map's custom joiner zone instead of the default columns", async function () {
      const { aiEncounters, maps } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await maps.write.setJoinerZone([
        1n,
        [
          { row: 5, col: 10 },
          { row: 4, col: 11 },
          { row: 0, col: 13 },
        ],
      ]);

      await aiEncounters.write.setMapPlacements([
        1n,
        [
          { row: 5, col: 10 },
          { row: 0, col: 13 },
          { row: 4, col: 11 },
        ],
        [1n, 1n, 1n],
      ]);
      // Returned row-major regardless of input order.
      const [positions] = await aiEncounters.read.getMapPlacements([1n]);
      expect(positions).to.deep.equal([
        { row: 0, col: 13 },
        { row: 4, col: 11 },
        { row: 5, col: 10 },
      ]);

      // A default-band tile outside the custom zone is rejected now.
      await expect(
        aiEncounters.write.setMapPlacement([1n, 1, 14, 1n]),
      ).to.be.rejectedWith("InvalidPosition");
    });

    it("can still clear a placement after the zone is edited to exclude it", async function () {
      const { aiEncounters, maps } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacements([
        1n,
        [
          { row: 2, col: 14 },
          { row: 3, col: 15 },
        ],
        [1n, 1n],
      ]);
      await maps.write.setJoinerZone([1n, [{ row: 9, col: 9 }]]);

      await aiEncounters.write.setMapPlacement([1n, 2, 14, 0n]);
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(1n);
      await aiEncounters.write.setMapPlacements([1n, [], []]);
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(0n);
      expect(await aiEncounters.read.mapPlacements([1n, 3, 15])).to.equal(0n);
    });

    it("removing a middle placement keeps the rest intact and in row-major order", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.createAIShipConfig([
        "Bruiser",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacement([1n, 6, 16, 2n]);
      await aiEncounters.write.setMapPlacement([1n, 1, 13, 1n]);
      await aiEncounters.write.setMapPlacement([1n, 3, 14, 1n]);
      await aiEncounters.write.setMapPlacement([1n, 1, 13, 0n]);
      await aiEncounters.write.setMapPlacement([1n, 0, 15, 2n]);

      const [positions, configIds] = await aiEncounters.read.getMapPlacements([1n]);
      expect(positions).to.deep.equal([
        { row: 0, col: 15 },
        { row: 3, col: 14 },
        { row: 6, col: 16 },
      ]);
      expect(configIds).to.deep.equal([2n, 1n, 2n]);
      // The removed cell can be re-added (its index entry was cleared).
      await aiEncounters.write.setMapPlacement([1n, 1, 13, 1n]);
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(4n);
    });

    it("reverts ConfigNotFound when placing a nonexistent config id", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await expect(
        aiEncounters.write.setMapPlacement([1n, 0, 13, 999n]),
      ).to.be.rejectedWith("ConfigNotFound");
    });

    it("sets and reads back a single placement", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacement([1n, 3, 14, 1n]);

      expect(await aiEncounters.read.mapPlacements([1n, 3, 14])).to.equal(1n);
      expect(await aiEncounters.read.mapHasPlacements([1n])).to.be.true;

      const [positions, configIds] = await aiEncounters.read.getMapPlacements([
        1n,
      ]);
      expect(positions.length).to.equal(1);
      expect(positions[0].row).to.equal(3);
      expect(positions[0].col).to.equal(14);
      expect(configIds[0]).to.equal(1n);
    });

    it("clearing a cell (configId 0) decrements the count and mapHasPlacements goes false", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacement([1n, 3, 14, 1n]);
      expect(await aiEncounters.read.mapHasPlacements([1n])).to.be.true;

      await aiEncounters.write.setMapPlacement([1n, 3, 14, 0n]);
      expect(await aiEncounters.read.mapHasPlacements([1n])).to.be.false;
      const [positions] = await aiEncounters.read.getMapPlacements([1n]);
      expect(positions.length).to.equal(0);
    });

    it("overwriting an already-non-zero cell with a different config does not double-count", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.createAIShipConfig([
        "Bruiser",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      await aiEncounters.write.setMapPlacement([1n, 3, 14, 1n]);
      await aiEncounters.write.setMapPlacement([1n, 3, 14, 2n]);

      const [positions, configIds] = await aiEncounters.read.getMapPlacements([
        1n,
      ]);
      expect(positions.length).to.equal(1);
      expect(configIds[0]).to.equal(2n);
    });

    it("batch setMapPlacements reverts ArrayLengthMismatch on mismatched arrays", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await expect(
        aiEncounters.write.setMapPlacements([
          1n,
          [
            { row: 0, col: 13 },
            { row: 1, col: 13 },
          ],
          [1n],
        ]),
      ).to.be.rejectedWith("ArrayLengthMismatch");
    });

    it("batch setMapPlacements writes every cell in one call", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacements([
        1n,
        [
          { row: 0, col: 13 },
          { row: 1, col: 14 },
          { row: 2, col: 15 },
        ],
        [1n, 1n, 1n],
      ]);

      const [positions] = await aiEncounters.read.getMapPlacements([1n]);
      expect(positions.length).to.equal(3);
    });

    it("a second setMapPlacements call replaces the whole fleet rather than upserting on top of it", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      // First deployment: 3 ships.
      await aiEncounters.write.setMapPlacements([
        1n,
        [
          { row: 0, col: 13 },
          { row: 1, col: 13 },
          { row: 2, col: 13 },
        ],
        [1n, 1n, 1n],
      ]);
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(3n);

      // Admin edits the fleet down to 2 ships at different cells and saves
      // — this is exactly the "remove a ship in the editor, hit Save"
      // workflow. The client only sends the new desired deployment; it
      // shouldn't need to know row 0/1/2 col 13 were ever occupied.
      await aiEncounters.write.setMapPlacements([
        1n,
        [
          { row: 4, col: 14 },
          { row: 5, col: 14 },
        ],
        [1n, 1n],
      ]);

      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(2n);
      const [positions, configIds] = await aiEncounters.read.getMapPlacements(
        [1n],
      );
      expect(positions.length).to.equal(2);
      expect(positions).to.deep.equal([
        { row: 4, col: 14 },
        { row: 5, col: 14 },
      ]);
      expect(configIds).to.deep.equal([1n, 1n]);

      // The old cells must be genuinely cleared in storage, not just
      // excluded from getMapPlacements by coincidence.
      expect(await aiEncounters.read.mapPlacements([1n, 0, 13])).to.equal(0n);
      expect(await aiEncounters.read.mapPlacements([1n, 1, 13])).to.equal(0n);
      expect(await aiEncounters.read.mapPlacements([1n, 2, 13])).to.equal(0n);
    });

    it("setMapPlacements with an empty array clears a map's fleet entirely", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await aiEncounters.write.setMapPlacements([
        1n,
        [{ row: 0, col: 13 }],
        [1n],
      ]);

      await aiEncounters.write.setMapPlacements([1n, [], []]);

      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(0n);
      const [positions] = await aiEncounters.read.getMapPlacements([1n]);
      expect(positions.length).to.equal(0);
    });

    it("reverts TooManyPlacements at the 9th distinct cell; the 8th succeeds", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      // Joiner window is rows 0-10, cols 13-16 -> 8 distinct cells across 2 rows.
      for (let row = 0; row < 8; row++) {
        await aiEncounters.write.setMapPlacement([1n, row, 13, 1n]);
      }
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(8n);

      await expect(
        aiEncounters.write.setMapPlacement([1n, 8, 13, 1n]),
      ).to.be.rejectedWith("TooManyPlacements");
    });

    it("defaults maxPlacementsPerMap to 8", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      expect(await aiEncounters.read.maxPlacementsPerMap()).to.equal(8n);
    });

    it("owner can lower maxPlacementsPerMap, and the new cap is enforced", async function () {
      const { aiEncounters } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);

      await aiEncounters.write.setMaxPlacementsPerMap([2n]);
      expect(await aiEncounters.read.maxPlacementsPerMap()).to.equal(2n);

      await aiEncounters.write.setMapPlacement([1n, 0, 13, 1n]);
      await aiEncounters.write.setMapPlacement([1n, 1, 13, 1n]);
      expect(await aiEncounters.read.mapPlacementCount([1n])).to.equal(2n);

      await expect(
        aiEncounters.write.setMapPlacement([1n, 2, 13, 1n]),
      ).to.be.rejectedWith("TooManyPlacements");
    });

    it("reverts when a non-owner tries to call setMaxPlacementsPerMap", async function () {
      const { otherAIEncounters } = await loadFixture(deployFixture);
      await expect(
        otherAIEncounters.write.setMaxPlacementsPerMap([2n]),
      ).to.be.rejected;
    });

    it("placements are scoped per map id", async function () {
      const { aiEncounters, maps } = await loadFixture(deployFixture);
      await aiEncounters.write.createAIShipConfig([
        "Scout",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      await maps.write.createPresetMap([[], MapMode.Both]); // map id 2

      await aiEncounters.write.setMapPlacement([1n, 0, 13, 1n]);

      expect(await aiEncounters.read.mapHasPlacements([1n])).to.be.true;
      expect(await aiEncounters.read.mapHasPlacements([2n])).to.be.false;
    });
  });
});
