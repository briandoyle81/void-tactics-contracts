import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";
import { attributeParams, costsParams } from "./fixtures/attributeTables";
import { ShipTuple, tupleToShip } from "./types";

/** Same Ignition module as Ships tests; builds lobby + constructed free ships for fleet rules. */
async function deployLobbyFleetFixture() {
  const [owner, creator, joiner] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deployed = await hre.ignition.deploy(DeployModule);

  const ships = deployed.ships;
  const freeShipClaim = deployed.freeShipClaim;
  const randomManager = deployed.randomManager;
  const shipAttributes = deployed.shipAttributes;

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

  await freeShipClaim.write.claimFreeShips([1], { account: creator.account });
  await freeShipClaim.write.claimFreeShips([1], { account: joiner.account });

  const fulfillRandomnessForPlayer = async (address: `0x${string}`) => {
    const shipIds = await ships.read.getShipIdsOwned([address]);
    for (const shipId of shipIds) {
      const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    return shipIds;
  };

  await fulfillRandomnessForPlayer(creator.account.address);
  await fulfillRandomnessForPlayer(joiner.account.address);

  await ships.write.constructAllMyShips({ account: creator.account });
  await ships.write.constructAllMyShips({ account: joiner.account });

  const creatorShipIds = await ships.read.getShipIdsOwned([
    creator.account.address,
  ]);

  return {
    owner,
    creator,
    joiner,
    publicClient,
    ships,
    shipAttributes,
    randomManager,
    creatorLobbies,
    joinerLobbies,
    creatorShipIds,
  };
}

function sampleCostsV2() {
  return costsParams({
    version: 2,
    baseCost: 60,
    accuracy: [0, 15, 30],
    hull: [0, 15, 30],
    speed: [0, 15, 30],
    mainWeapon: [30, 35, 45, 45],
    armor: [0, 8, 12, 18],
    shields: [0, 12, 24, 36],
    // Special is a per-faction local slot 0-7 (8 members) — costs.special
    // must cover the full range, since GenerateNewShip rolls across all 8
    // slots now, not just the first 4.
    special: [0, 12, 24, 18, 18, 24, 12, 0],
  });
}

// Default gun/armor/shield data — matches ShipAttributes' constructor
// seed. setVariantAttributes now fully replaces a variant's guns/armors/
// shields on every call (delete + re-push), so tests that only care about
// hull/specials still need to supply the full baseline for these to avoid
// wiping them.
function defaultGunsArmorsShields() {
  return {
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
  };
}

function sampleSetAllAttributesArgs() {
  const newGuns = [
    { range: 8, damage: 30, movement: 0 },
    { range: 15, damage: 25, movement: 0 },
    { range: 10, damage: 35, movement: -1 },
    { range: 5, damage: 45, movement: 0 },
  ];
  const newArmors = [
    { damageReduction: 0, movement: 1 },
    { damageReduction: 5, movement: 0 },
    { damageReduction: 10, movement: -1 },
    { damageReduction: 15, movement: -2 },
  ];
  const newShields = [
    { damageReduction: 0, movement: 1 },
    { damageReduction: 8, movement: 0 },
    { damageReduction: 15, movement: -1 },
    { damageReduction: 25, movement: -2 },
  ];
  const newSpecials = [
    { range: 0, strength: 0, movement: 0 },
    { range: 6, strength: 10, movement: 0 },
    { range: 8, strength: 0, movement: 0 },
    { range: 4, strength: 15, movement: 0 },
  ];
  const newForeAccuracy = [0, 130, 160];
  const newEngineSpeeds = [0, 2, 3];
  const newHull = [0, 10, 20];
  return {
    newGuns,
    newArmors,
    newShields,
    newSpecials,
    newForeAccuracy,
    newEngineSpeeds,
    newHull,
  };
}

// A full variant table (short-form arrays are padded to 8 slots by
// attributeParams). Its Slot1 special (range 5, strength 99) is deliberately
// unlike either faction's deployed Slot1, so tests can tell a publish apart
// from the deployed defaults; tests that need other specials override
// `specials`.
function baselineAttributes(
  variant: number,
  overrides: Record<string, unknown> = {},
) {
  return attributeParams({
    variant,
    baseHull: 100,
    baseSpeed: 3,
    foreAccuracy: [0, 25, 50],
    hull: [0, 10, 20],
    engineSpeeds: [0, 1, 2],
    ...defaultGunsArmorsShields(),
    specials: [
      { range: 0, strength: 0, movement: 0 },
      { range: 5, strength: 99, movement: 0 },
      { range: 3, strength: 40, movement: 0 },
      { range: 3, strength: 30, movement: 0 },
    ],
    ...overrides,
  });
}

// A plain constructed ship literal for calculateShipAttributes/Cost reads.
function makeShip(
  variant: number,
  shipsDestroyed = 0,
  equipment = { mainWeapon: 0, armor: 0, shields: 0, special: 0 },
) {
  return {
    name: "",
    id: 1n,
    equipment,
    traits: {
      serialNumber: 1n,
      colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0 },
      variant,
      accuracy: 0,
      hull: 0,
      speed: 0,
    },
    shipData: {
      shipsDestroyed,
      costsVersion: 0,
      cost: 0,
      modified: 0,
      shiny: false,
      constructed: true,
      inFleet: false,
      isFreeShip: false,
      timestampDestroyed: 0n,
    },
    owner: zeroAddress,
  };
}

describe("Ship costs, versions, and fleets", function () {
  describe("ShipAttributes — per-variant attributes versions", function () {
    it("publishes a new version for one variant without touching another variant", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // The deploy module publishes version 1 for each variant.
      for (const variant of [1, 2]) {
        expect(
          await shipAttributes.read.getCurrentAttributesVersion([variant]),
        ).to.equal(1);
        expect(
          await shipAttributes.read.getLatestAttributesVersion([variant]),
        ).to.equal(1);
      }

      const {
        newGuns,
        newArmors,
        newShields,
        newSpecials,
        newForeAccuracy,
        newEngineSpeeds,
        newHull,
      } = sampleSetAllAttributesArgs();

      // One call publishes v2 for variant 1 and makes it live.
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 1,
            baseHull: 120,
            baseSpeed: 4,
            foreAccuracy: newForeAccuracy,
            hull: newHull,
            engineSpeeds: newEngineSpeeds,
            guns: newGuns,
            armors: newArmors,
            shields: newShields,
            specials: newSpecials,
          }),
        ],
        { account: owner.account },
      );

      expect(
        await shipAttributes.read.getCurrentAttributesVersion([1]),
      ).to.equal(2);
      expect(
        await shipAttributes.read.getLatestAttributesVersion([1]),
      ).to.equal(2);
      expect((await shipAttributes.read.getVariantAttributes([1, 2])).baseHull).to.equal(120);

      // Variant 2 is completely untouched.
      expect(
        await shipAttributes.read.getCurrentAttributesVersion([2]),
      ).to.equal(1);
      expect(
        await shipAttributes.read.getLatestAttributesVersion([2]),
      ).to.equal(1);
      // Still variant 2's own deployed table (base hull 125 — the heavy
      // faction), not variant 1's, and not the value just published for
      // variant 1.
      expect((await shipAttributes.read.getVariantAttributes([2, 0])).baseHull).to.equal(125);
    });

    it("lets owner roll a variant back and forward; older versions stay readable and immutable", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      await shipAttributes.write.setVariantAttributes(
        [baselineAttributes(1, { baseHull: 120 })],
        { account: owner.account },
      );
      expect(
        await shipAttributes.read.getCurrentAttributesVersion([1]),
      ).to.equal(2);

      // Roll back to v1: new calculations use v1's numbers again.
      await shipAttributes.write.setCurrentAttributesVersion([1, 1], {
        account: owner.account,
      });
      expect(
        await shipAttributes.read.getCurrentAttributesVersion([1]),
      ).to.equal(1);
      // latest is unaffected by a rollback.
      expect(
        await shipAttributes.read.getLatestAttributesVersion([1]),
      ).to.equal(2);
      const attrsRolledBack = await shipAttributes.read.calculateShipAttributes(
        [makeShip(1)],
      );
      expect(attrsRolledBack.version).to.equal(1);
      expect(attrsRolledBack.hullPoints).to.equal(100);

      // Both versions remain readable, exactly as published.
      expect((await shipAttributes.read.getVariantAttributes([1, 1])).baseHull).to.equal(100);
      expect((await shipAttributes.read.getVariantAttributes([1, 2])).baseHull).to.equal(120);
      // version 0 means "current".
      expect((await shipAttributes.read.getVariantAttributes([1, 0])).baseHull).to.equal(100);

      // Roll forward again.
      await shipAttributes.write.setCurrentAttributesVersion([1, 2], {
        account: owner.account,
      });
      const attrsForward = await shipAttributes.read.calculateShipAttributes([
        makeShip(1),
      ]);
      expect(attrsForward.version).to.equal(2);
      expect(attrsForward.hullPoints).to.equal(120);
    });

    it("rejects rolling a variant to version 0 or beyond its latest published version", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      await expect(
        shipAttributes.write.setCurrentAttributesVersion([1, 0], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("InvalidAttributesVersion");
      await expect(
        shipAttributes.write.setCurrentAttributesVersion([1, 2], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("InvalidAttributesVersion");
      // A never-configured variant has nothing to roll to.
      await expect(
        shipAttributes.write.setCurrentAttributesVersion([99, 1], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("InvalidAttributesVersion");
    });

    it("exposes every array, including tier arrays and rank rules, via getVariantAttributes", async function () {
      const { shipAttributes } = await loadFixture(deployShipsFixture);

      const data = await shipAttributes.read.getVariantAttributes([1, 0]);
      expect(data.baseHull).to.equal(100);
      expect(data.baseSpeed).to.equal(4);
      expect([...data.foreAccuracy]).to.deep.equal([0, 25, 50]);
      expect([...data.hull]).to.deep.equal([0, 10, 20]);
      expect([...data.engineSpeeds]).to.deep.equal([0, 1, 2]);
      expect(data.guns.length).to.equal(8);
      expect(data.armors.length).to.equal(8);
      expect(data.shields.length).to.equal(8);
      expect(data.specials.length).to.equal(8);
      expect([...data.rankThresholds]).to.deep.equal([10, 30, 100, 300, 1000]);
      expect([...data.rankBonusPct]).to.deep.equal([0, 10, 20, 30, 40, 50]);
    });

    it("reverts VariantNotConfigured (not an opaque panic) for an unconfigured variant", async function () {
      const { shipAttributes } = await loadFixture(deployShipsFixture);

      await expect(
        shipAttributes.read.calculateShipAttributes([makeShip(99)]),
      ).to.be.rejectedWith("VariantNotConfigured");
      await expect(
        shipAttributes.read.getSpecialRange([1, 99]),
      ).to.be.rejectedWith("VariantNotConfigured");
      await expect(
        shipAttributes.read.getGunData([0, 99]),
      ).to.be.rejectedWith("VariantNotConfigured");
      await expect(
        shipAttributes.read.getVariantAttributes([99, 0]),
      ).to.be.rejectedWith("VariantNotConfigured");
      await expect(
        shipAttributes.read.getRank([99, 5n]),
      ).to.be.rejectedWith("VariantNotConfigured");
    });

    it("rejects wrong-length tables on publish (setVariantAttributes and setCosts)", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);
      const good = baselineAttributes(1);

      const bad: Record<string, unknown>[] = [
        { guns: good.guns.slice(0, 4) },
        { armors: good.armors.slice(0, 4) },
        { shields: good.shields.slice(0, 4) },
        { specials: good.specials.slice(0, 4) },
        { foreAccuracy: [0, 25] },
        { hull: [0, 10, 20, 30] },
        { engineSpeeds: [0] },
        { rankThresholds: [10, 30, 100, 300] },
        { rankBonusPct: [0, 10, 20, 30, 40] },
      ];
      for (const override of bad) {
        await expect(
          shipAttributes.write.setVariantAttributes(
            [{ ...good, ...override }],
            { account: owner.account },
          ),
          JSON.stringify(Object.keys(override)),
        ).to.be.rejectedWith("InvalidArrayLength");
      }
      // Nothing was published by any rejected call.
      expect(
        await shipAttributes.read.getLatestAttributesVersion([1]),
      ).to.equal(1);

      const goodCosts = sampleCostsV2();
      const badCosts: Record<string, unknown>[] = [
        { accuracy: [0, 15] },
        { hull: [0, 15, 30, 45] },
        { speed: [0] },
        { mainWeapon: [30, 35, 45, 45] },
        { armor: [0, 8, 12, 18] },
        { shields: [0, 12, 24, 36] },
        { special: [0, 12, 24, 18] },
      ];
      for (const override of badCosts) {
        await expect(
          shipAttributes.write.setCosts([1, { ...goodCosts, ...override }], {
            account: owner.account,
          }),
          JSON.stringify(Object.keys(override)),
        ).to.be.rejectedWith("InvalidArrayLength");
      }
      // The cost version didn't move either.
      expect(
        await shipAttributes.read.getCurrentCostsVersion([1]),
      ).to.equal(1);
    });

    it("rejects invalid rank rules on publish", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      const invalidRankConfigs: Record<string, unknown>[] = [
        // first threshold must be > 0
        { rankThresholds: [0, 30, 100, 300, 1000] },
        // must be strictly ascending
        { rankThresholds: [10, 30, 30, 300, 1000] },
        { rankThresholds: [10, 30, 100, 90, 1000] },
        // bonus capped at 100%
        { rankBonusPct: [0, 10, 20, 30, 40, 101] },
      ];
      for (const override of invalidRankConfigs) {
        await expect(
          shipAttributes.write.setVariantAttributes(
            [baselineAttributes(1, override)],
            { account: owner.account },
          ),
          JSON.stringify(override),
        ).to.be.rejectedWith("InvalidRankConfig");
      }
    });

    it("reports rank from the variant's configured thresholds", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Today's thresholds: 10 / 30 / 100 / 300 / 1000.
      const expected: [bigint, number][] = [
        [0n, 1],
        [9n, 1],
        [10n, 2],
        [29n, 2],
        [30n, 3],
        [99n, 3],
        [100n, 4],
        [299n, 4],
        [300n, 5],
        [999n, 5],
        [1000n, 6],
        [1000000n, 6],
      ];
      for (const [kills, rank] of expected) {
        expect(await shipAttributes.read.getRank([1, kills])).to.equal(rank);
      }

      // Retune variant 1 only.
      await shipAttributes.write.setVariantAttributes(
        [baselineAttributes(1, { rankThresholds: [1, 2, 3, 4, 5] })],
        { account: owner.account },
      );
      expect(await shipAttributes.read.getRank([1, 0n])).to.equal(1);
      expect(await shipAttributes.read.getRank([1, 1n])).to.equal(2);
      expect(await shipAttributes.read.getRank([1, 5n])).to.equal(6);
      // Variant 2 still uses its own (unchanged) thresholds.
      expect(await shipAttributes.read.getRank([2, 5n])).to.equal(1);
    });

    it("applies the configured rank bonus to computed stats", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Today's rules: rank 2 (10 kills) is +10% — baseHull 100 -> 110.
      expect(
        (await shipAttributes.read.calculateShipAttributes([makeShip(1, 0)]))
          .hullPoints,
      ).to.equal(100);
      expect(
        (await shipAttributes.read.calculateShipAttributes([makeShip(1, 10)]))
          .hullPoints,
      ).to.equal(110);

      // Retune: rank 2 at a single kill for +100%; rank 1 stays +0%.
      await shipAttributes.write.setVariantAttributes(
        [
          baselineAttributes(1, {
            rankThresholds: [1, 30, 100, 300, 1000],
            rankBonusPct: [0, 100, 100, 100, 100, 100],
          }),
        ],
        { account: owner.account },
      );
      expect(
        (await shipAttributes.read.calculateShipAttributes([makeShip(1, 0)]))
          .hullPoints,
      ).to.equal(100);
      expect(
        (await shipAttributes.read.calculateShipAttributes([makeShip(1, 1)]))
          .hullPoints,
      ).to.equal(200);
    });

    it("floors a ship's final range and movement at 1", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Movement modifiers that sum below zero (base 0, gun -1, armor -2,
      // shields -2) and an inert range-0 gun: without floors this ship could
      // neither move nor shoot.
      await shipAttributes.write.setVariantAttributes(
        [
          baselineAttributes(1, {
            baseSpeed: 0,
            engineSpeeds: [0, 0, 0],
            guns: [{ range: 0, damage: 10, movement: -1 }],
            armors: [{ damageReduction: 0, movement: -2 }],
            shields: [{ damageReduction: 0, movement: -2 }],
          }),
        ],
        { account: owner.account },
      );

      const attrs = await shipAttributes.read.calculateShipAttributes([
        makeShip(1),
      ]);
      expect(attrs.movement).to.equal(1);
      expect(attrs.range).to.equal(1);

      // Bonuses scale the true (zero) base, so a top-rank ship isn't inflated
      // past the floor either.
      const topRank = await shipAttributes.read.calculateShipAttributes([
        makeShip(1, 1000),
      ]);
      expect(topRank.movement).to.equal(1);
      expect(topRank.range).to.equal(1);
    });

    it("leaves range and movement untouched when they are already at or above 1", async function () {
      const { shipAttributes } = await loadFixture(deployShipsFixture);

      // Variant 1's deployed defaults: Laser range 3; movement = base speed 4
      // + the None bonus once (+1, a bare ship; tier-0 engine, Laser 0) = 5.
      // The floors change nothing.
      const attrs = await shipAttributes.read.calculateShipAttributes([
        makeShip(1),
      ]);
      expect(attrs.range).to.equal(3);
      expect(attrs.movement).to.equal(5);
    });

    it("counts the None (no defensive gear) movement bonus once, not once per slot", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // base speed 3, tier-0 engine, Generic gun 0. Armor: None +1, Light 0,
      // Heavy -2. Shields: None +5 (a deliberately absurd value that must
      // never be read), Light +1.
      await shipAttributes.write.setVariantAttributes(
        [
          baselineAttributes(1, {
            baseSpeed: 3,
            engineSpeeds: [0, 0, 0],
            guns: [{ range: 3, damage: 50, movement: 0 }],
            armors: [
              { damageReduction: 0, movement: 1 },
              { damageReduction: 15, movement: 0 },
              { damageReduction: 30, movement: -1 },
              { damageReduction: 45, movement: -2 },
            ],
            shields: [
              { damageReduction: 0, movement: 5 },
              { damageReduction: 15, movement: 1 },
            ],
          }),
        ],
        { account: owner.account },
      );

      const move = async (armor: number, shields: number) =>
        (
          await shipAttributes.read.calculateShipAttributes([
            makeShip(1, 0, { mainWeapon: 0, armor, shields, special: 0 }),
          ])
        ).movement;

      // No defensive gear: the None bonus applies once (armor table's +1);
      // the shields table's None entry is never read.
      expect(await move(0, 0)).to.equal(4);
      // Armor only: just the armor's own movement — no None bonus from the
      // unused shields slot.
      expect(await move(1, 0)).to.equal(3); // Light armor: 3 + 0
      expect(await move(3, 0)).to.equal(1); // Heavy armor: 3 - 2
      // Shields only: just the shields' own movement — no None bonus from the
      // unused armor slot.
      expect(await move(0, 1)).to.equal(4); // Light shields: 3 + 1
    });

    it("reads special data at a specific published version, independent of the live one", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Variant 2's Slot1 is ElectricStorm in the deploy module
      // (v1: range 2, strength 1).
      await shipAttributes.write.setVariantAttributes(
        [baselineAttributes(2)], // v2: Slot1 range 5, strength 99
        { account: owner.account },
      );

      // Live getters follow the current version...
      expect(await shipAttributes.read.getSpecialStrength([1, 2])).to.equal(99);
      // ...while pinned reads return exactly what each version published.
      expect(await shipAttributes.read.getSpecialStrengthAt([2, 1, 1])).to.equal(1);
      expect(await shipAttributes.read.getSpecialRangeAt([2, 1, 1])).to.equal(2);
      expect(await shipAttributes.read.getSpecialStrengthAt([2, 2, 1])).to.equal(99);
      expect(await shipAttributes.read.getSpecialRangeAt([2, 2, 1])).to.equal(5);

      // Rolling the live pointer back doesn't change what v2 says.
      await shipAttributes.write.setCurrentAttributesVersion([2, 1], {
        account: owner.account,
      });
      expect(await shipAttributes.read.getSpecialStrength([1, 2])).to.equal(1);
      expect(await shipAttributes.read.getSpecialStrengthAt([2, 2, 1])).to.equal(99);

      // Version 0 and unpublished versions are rejected.
      await expect(
        shipAttributes.read.getSpecialRangeAt([2, 0, 1]),
      ).to.be.rejectedWith("InvalidAttributesVersion");
      await expect(
        shipAttributes.read.getSpecialRangeAt([2, 3, 1]),
      ).to.be.rejectedWith("InvalidAttributesVersion");
    });

    it("prices ships totalling more than 255 instead of overflowing", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Every cost entry is a uint8, and the sum used to be computed in uint8
      // arithmetic, so any ship totalling over 255 reverted.
      await shipAttributes.write.setCosts(
        [
          1,
          costsParams({
            version: 0,
            baseCost: 200,
            accuracy: [0, 0, 0],
            hull: [0, 0, 0],
            speed: [0, 0, 0],
            mainWeapon: [60, 0, 0, 0],
            armor: [10, 0, 0, 0],
            shields: [0, 0, 0, 0],
            special: [0, 0, 0, 0, 0, 0, 0, 0],
          }),
        ],
        { account: owner.account },
      );

      expect(await shipAttributes.read.calculateShipCost([makeShip(1)])).to.equal(
        270,
      );
    });
  });

  describe("Per-variant ship attributes and specials", function () {
    it("gives ships of different variants different hull points and special data", async function () {
      const { ships, shipAttributes, randomManager, owner, user1, shatteredHiveMedal } =
        await loadFixture(deployShipsFixture);

      // Configure variant 2 with much higher hull bonuses and a much
      // stronger/longer-range EMP than the constructor's variant 1 baseline
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 2,
            baseHull: 100,
            baseSpeed: 3,
            foreAccuracy: [0, 25, 50],
            hull: [0, 50, 100],
            engineSpeeds: [0, 1, 2],
            ...defaultGunsArmorsShields(),
            // 8 entries, not 4: GenerateNewShip.sol rolls equipment.special
            // as `% 8` (unlike mainWeapon/armor/shields, which are `% 4`),
            // so any ship can randomly land on slot 4-7. Configuring only
            // 4 here caused this test to flake — ship 6 (the variant-2 ship
            // under test) intermittently rolled special 4-7, and
            // ShipAttributes.calculateShipAttributes's specials[special]
            // lookup panicked out-of-bounds on a 4-length array (this is
            // the same underlying array-bounds shape as pre-audit.md's
            // M-04, here hitting test data rather than production config).
            // Slots 4-7 are unused by this test's assertions (only slot 1
            // and ship 6's own rolled slot are checked), so they're filled
            // with the same inert zero values slot 0 uses.
            specials: [
              { range: 0, strength: 0, movement: 0 },
              { range: 5, strength: 99, movement: 0 },
              { range: 3, strength: 40, movement: 0 },
              { range: 3, strength: 30, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
            ],
          }),
        ],
        { account: owner.account },
      );

      // Tier 0 mints 5 ships per purchase, so ship 1 is the first ship of the
      // variant-1 purchase and ship 6 is the first ship of the variant-2
      // purchase
      await shatteredHiveMedal.write.ownerMint([user1.account.address], {
        account: owner.account,
      });

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 2],
        { value: parseEther("4.99") },
      );

      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: user1.account });

      const variant1Ship = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      const variant2Ship = tupleToShip(
        (await ships.read.ships([6n])) as ShipTuple,
      );
      expect(variant1Ship.traits.variant).to.equal(1);
      expect(variant2Ship.traits.variant).to.equal(2);

      const attrs2 = await shipAttributes.read.calculateShipAttributesById([
        6n,
      ]);

      // Compare against variant 2's configured hull bonus for whichever hull
      // tier this ship actually rolled (tiers are randomly assigned per ship,
      // so comparing two ships' hullPoints directly isn't reliable — only
      // the bonus at a given ship's own tier is deterministic)
      const variant2HullBonus = [0, 50, 100][variant2Ship.traits.hull];
      expect(attrs2.hullPoints).to.equal(100 + variant2HullBonus);

      const empRange1 = await shipAttributes.read.getSpecialRange([1, 1]);
      const empStrength1 = await shipAttributes.read.getSpecialStrength([
        1, 1,
      ]);
      const empRange2 = await shipAttributes.read.getSpecialRange([1, 2]);
      const empStrength2 = await shipAttributes.read.getSpecialStrength([
        1, 2,
      ]);

      expect(empStrength2).to.be.greaterThan(empStrength1);
      expect(empRange2).to.be.greaterThan(empRange1);
    });

    it("gives ships of different variants different weapon/armor/shield stats", async function () {
      const { ships, shipAttributes, randomManager, owner, user1, shatteredHiveMedal } =
        await loadFixture(deployShipsFixture);

      // Configure variant 2 with a much stronger Laser and heavier armor
      // than the constructor's variant 1 baseline. guns/armors/shields are
      // per-variant now (VariantAttributeData), not shared globally.
      const { guns: v1Guns, armors: v1Armors, shields: v1Shields } =
        defaultGunsArmorsShields();
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 2,
            baseHull: 100,
            baseSpeed: 3,
            foreAccuracy: [0, 25, 50],
            hull: [0, 10, 20],
            engineSpeeds: [0, 1, 2],
            guns: [
              { range: 10, damage: 150, movement: 0 }, // Generic, boosted
              v1Guns[1],
              v1Guns[2],
              v1Guns[3],
            ],
            armors: [
              { damageReduction: 0, movement: 1 },
              { damageReduction: 60, movement: 0 }, // Light, boosted
              v1Armors[2],
              v1Armors[3],
            ],
            shields: v1Shields,
            // 8 entries, not 4 — see the identical comment in the previous
            // test above; equipment.special rolls 0-7 (GenerateNewShip.sol
            // uses `% 8` for it, unlike mainWeapon/armor/shields' `% 4`),
            // and this test also calls calculateShipAttributesById on ship
            // 6 below, which panics out-of-bounds if that ship's random
            // special roll lands on an unconfigured slot 4-7.
            specials: [
              { range: 0, strength: 0, movement: 0 },
              { range: 1, strength: 1, movement: 0 },
              { range: 3, strength: 40, movement: 0 },
              { range: 3, strength: 30, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
              { range: 0, strength: 0, movement: 0 },
            ],
          }),
        ],
        { account: owner.account },
      );

      const gunVariant1 = await shipAttributes.read.getGunData([0, 1]); // Generic
      const gunVariant2 = await shipAttributes.read.getGunData([0, 2]);
      expect(gunVariant2.range).to.be.greaterThan(gunVariant1.range);
      expect(gunVariant2.damage).to.be.greaterThan(gunVariant1.damage);

      const armorVariant1 = await shipAttributes.read.getArmorData([1, 1]); // Light
      const armorVariant2 = await shipAttributes.read.getArmorData([1, 2]);
      expect(armorVariant2.damageReduction).to.be.greaterThan(
        armorVariant1.damageReduction,
      );

      await shatteredHiveMedal.write.ownerMint([user1.account.address], {
        account: owner.account,
      });

      // Tier 0 mints 5 ships per purchase, so ship 1 is the first ship of the
      // variant-1 purchase and ship 6 is the first ship of the variant-2
      // purchase
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 1],
        { value: parseEther("4.99") },
      );
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 2],
        { value: parseEther("4.99") },
      );

      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([
          ship.traits.serialNumber,
        ]);
      }
      await ships.write.constructAllMyShips({ account: user1.account });

      // Force both ships onto the same weapon (Laser) so the only variable
      // left is which variant's gun stats got applied.
      const ship1 = tupleToShip((await ships.read.ships([1n])) as ShipTuple);
      const ship6 = tupleToShip((await ships.read.ships([6n])) as ShipTuple);
      expect(ship1.traits.variant).to.equal(1);
      expect(ship6.traits.variant).to.equal(2);

      if (ship1.equipment.mainWeapon === 0 && ship6.equipment.mainWeapon === 0) {
        const attrs1 = await shipAttributes.read.calculateShipAttributesById([
          1n,
        ]);
        const attrs6 = await shipAttributes.read.calculateShipAttributesById([
          6n,
        ]);
        expect(attrs6.gunDamage).to.be.greaterThan(attrs1.gunDamage);
      }
    });

    it("changing variant 2's costs leaves variant 1's cost version and fleet eligibility untouched", async function () {
      const {
        owner,
        shipAttributes,
        creatorLobbies,
        joinerLobbies,
        creatorShipIds,
      } = await loadFixture(deployLobbyFleetFixture);

      // All ships from claimFreeShips are variant 1 (TutorialClaim mints
      // every fixed reward ship as variant 1).
      const variant1VersionBefore =
        await shipAttributes.read.getCurrentCostsVersion([1]);

      await shipAttributes.write.setCosts([2, sampleCostsV2()], {
        account: owner.account,
      });

      const variant1VersionAfter =
        await shipAttributes.read.getCurrentCostsVersion([1]);
      expect(variant1VersionAfter).to.equal(variant1VersionBefore);

      const costLimit = 1000n;
      const turnTime = 300n;
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      // A variant-1 ship's stored costsVersion is still current — creating
      // a fleet with it must not revert ShipCostVersionMismatch, even
      // though variant 2's costs version was just bumped.
      await creatorLobbies.write.createFleet([
        1n,
        [creatorShipIds[0]],
        [{ row: 0, col: 0 }],
      ]);
    });

    it("reverts (fails loud) when reading an unconfigured variant", async function () {
      const { shipAttributes } = await loadFixture(deployShipsFixture);

      await expect(
        shipAttributes.read.getSpecialRange([1, 99]),
      ).to.be.rejectedWith("VariantNotConfigured");
    });

    it("gives variant 2 a genuinely different baseCost than variant 1", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Costs are per-variant now (ShipAttributes.costsByVariant) — set
      // variant 2's baseCost 50 higher than variant 1's constructor-seeded
      // default (50), leaving variant 1 untouched.
      const variant2Costs = costsParams({
        version: 0,
        baseCost: 100,
        accuracy: [0, 10, 25],
        hull: [0, 10, 25],
        speed: [0, 10, 25],
        mainWeapon: [25, 30, 40, 40],
        armor: [0, 5, 10, 15],
        shields: [0, 10, 20, 30],
        special: [0, 10, 20, 15, 15, 20, 10, 0],
      });
      await shipAttributes.write.setCosts([2, variant2Costs], {
        account: owner.account,
      });

      const baseShip = {
        name: "",
        id: 0n,
        equipment: { mainWeapon: 0, armor: 0, shields: 0, special: 0 },
        traits: {
          serialNumber: 0n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 0,
        },
        shipData: {
          shipsDestroyed: 0,
          costsVersion: 0,
          cost: 0,
          modified: 0,
          shiny: false,
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          timestampDestroyed: 0n,
        },
        owner: zeroAddress,
      };

      const costVariant1 = await shipAttributes.read.calculateShipCost([
        baseShip,
      ]);
      const costVariant2 = await shipAttributes.read.calculateShipCost([
        { ...baseShip, traits: { ...baseShip.traits, variant: 2 } },
      ]);

      expect(costVariant2 - costVariant1).to.equal(50);
    });
  });

  describe("Ships.setCostOfShip", function () {
    it("rejects non-owner non-game callers", async function () {
      const { ships, user1, randomManager } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      await expect(
        ships.write.setCostOfShip([1n], { account: user1.account }),
      ).to.be.rejectedWith("NotAuthorized");
    });

    it("after setCosts, owner syncs ship cost and costsVersion to match live tables", async function () {
      const { ships, shipAttributes, owner, user1, randomManager } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTupleBefore = (await ships.read.ships([1n])) as ShipTuple;
      const s0 = tupleToShip(shipTupleBefore);
      await randomManager.write.revealRandomness([s0.traits.serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const vBefore = await shipAttributes.read.getCurrentCostsVersion([1]);
      const shipBefore = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      expect(Number(shipBefore.shipData.costsVersion)).to.equal(
        Number(vBefore),
      );

      await shipAttributes.write.setCosts([1, sampleCostsV2()], {
        account: owner.account,
      });

      const vAfter = await shipAttributes.read.getCurrentCostsVersion([1]);
      expect(Number(vAfter)).to.equal(Number(vBefore) + 1);

      const stale = tupleToShip((await ships.read.ships([1n])) as ShipTuple);
      expect(stale.shipData.costsVersion).to.equal(vBefore);

      await ships.write.setCostOfShip([1n], { account: owner.account });

      const shipMem = await ships.read.getShip([1n]);
      const expectedCost =
        await shipAttributes.read.calculateShipCost([shipMem]);

      const updated = tupleToShip((await ships.read.ships([1n])) as ShipTuple);
      expect(Number(updated.shipData.costsVersion)).to.equal(Number(vAfter));
      expect(BigInt(updated.shipData.cost)).to.equal(BigInt(expectedCost));
    });

    it("syncShipCosts is permissionless and updates multiple ships", async function () {
      const { ships, shipAttributes, owner, user1, user2, randomManager } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user1.account.address, 1],
        { value: parseEther("4.99") },
      );

      for (const id of [1n, 2n] as const) {
        const shipTuple = (await ships.read.ships([id])) as ShipTuple;
        const s = tupleToShip(shipTuple);
        await randomManager.write.revealRandomness([s.traits.serialNumber]);
        await ships.write.constructShip([id], { account: user1.account });
      }

      await shipAttributes.write.setCosts([1, sampleCostsV2()], {
        account: owner.account,
      });

      const vAfter = await shipAttributes.read.getCurrentCostsVersion([1]);

      await ships.write.syncShipCosts([[1n, 2n]], { account: user2.account });

      for (const id of [1n, 2n] as const) {
        const shipMem = await ships.read.getShip([id]);
        const expectedCost =
          await shipAttributes.read.calculateShipCost([shipMem]);
        const updated = tupleToShip((await ships.read.ships([id])) as ShipTuple);
        expect(Number(updated.shipData.costsVersion)).to.equal(Number(vAfter));
        expect(BigInt(updated.shipData.cost)).to.equal(BigInt(expectedCost));
      }
    });

    it("reverts ShipInFleet while ship is in a lobby fleet", async function () {
      const {
        owner,
        creator,
        joiner,
        ships,
        shipAttributes,
        creatorLobbies,
        joinerLobbies,
        creatorShipIds,
      } = await loadFixture(deployLobbyFleetFixture);

      const costLimit = 1000n;
      const turnTime = 300n;

      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      const shipId = creatorShipIds[0];
      await creatorLobbies.write.createFleet([
        1n,
        [shipId],
        [{ row: 0, col: 0 }],
      ]);

      await expect(
        ships.write.syncShipCosts([[shipId]], { account: joiner.account }),
      ).to.be.rejectedWith("ShipInFleet");

      await expect(
        ships.write.setCostOfShip([shipId], { account: owner.account }),
      ).to.be.rejectedWith("ShipInFleet");

      await shipAttributes.write.setCosts([1, sampleCostsV2()], {
        account: owner.account,
      });

      await expect(
        ships.write.setCostOfShip([shipId], { account: owner.account }),
      ).to.be.rejectedWith("ShipInFleet");
    });

    it("allows setCostOfShip after creator fleet is cleared (creator leaves)", async function () {
      const {
        owner,
        creator,
        joiner,
        ships,
        shipAttributes,
        creatorLobbies,
        joinerLobbies,
        creatorShipIds,
      } = await loadFixture(deployLobbyFleetFixture);

      const costLimit = 1000n;
      const turnTime = 300n;

      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      const shipId = creatorShipIds[0];
      await creatorLobbies.write.createFleet([
        1n,
        [shipId],
        [{ row: 0, col: 0 }],
      ]);

      await creatorLobbies.write.leaveLobby([1n]);

      await shipAttributes.write.setCosts([1, sampleCostsV2()], {
        account: owner.account,
      });

      await ships.write.setCostOfShip([shipId], { account: owner.account });

      const v = await shipAttributes.read.getCurrentCostsVersion([1]);
      const updated = tupleToShip((await ships.read.ships([shipId])) as ShipTuple);
      expect(Number(updated.shipData.costsVersion)).to.equal(Number(v));

      const shipMem = await ships.read.getShip([shipId]);
      const expectedCost =
        await shipAttributes.read.calculateShipCost([shipMem]);
      expect(BigInt(updated.shipData.cost)).to.equal(BigInt(expectedCost));
    });
  });

  describe("Fleets cost version guard", function () {
    it("reverts createFleet with ShipCostVersionMismatch when ship lags global costs version", async function () {
      const {
        owner,
        creator,
        joiner,
        ships,
        shipAttributes,
        creatorLobbies,
        joinerLobbies,
        creatorShipIds,
      } = await loadFixture(deployLobbyFleetFixture);

      await shipAttributes.write.setCosts([1, sampleCostsV2()], {
        account: owner.account,
      });

      const costLimit = 1000n;
      const turnTime = 300n;

      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      const shipId = creatorShipIds[0];

      await expect(
        creatorLobbies.write.createFleet([
          1n,
          [shipId],
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("ShipCostVersionMismatch");

      await ships.write.setCostOfShip([shipId], { account: owner.account });

      await creatorLobbies.write.createFleet([
        1n,
        [shipId],
        [{ row: 0, col: 0 }],
      ]);
    });
  });

  describe("Fleets variant guard", function () {
    it("reverts createFleet when ship variants are mixed", async function () {
      const {
        owner,
        creator,
        ships,
        shipAttributes,
        creatorLobbies,
        joinerLobbies,
        creatorShipIds,
      } = await loadFixture(deployLobbyFleetFixture);

      // Mint a second, plain variant-1 ship (ungated, unlike variant 2
      // which requires holding ShatteredHiveMedal — irrelevant to this
      // test), then overwrite it in place to variant 2 via customizeShip.
      // customizeShip fully replaces the stored struct and doesn't call
      // VariantPurchaseGate.checkGate (that only runs on the _mintShip
      // path), so it's the simplest way to get a fleet-eligible variant-2
      // ship for this test without needing to actually hold the medal.
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.createShips(
        [creator.account.address, 1, 1, 0, false],
        { account: owner.account },
      );

      const ownedAfter = await ships.read.getShipIdsOwned([
        creator.account.address,
      ]);
      const variant2ShipId = ownedAfter[ownedAfter.length - 1];

      const variant2CostsVersion =
        await shipAttributes.read.getCurrentCostsVersion([2]);

      await ships.write.customizeShip(
        [
          variant2ShipId,
          {
            name: "Variant 2 Test Ship",
            id: variant2ShipId,
            equipment: { mainWeapon: 0, armor: 0, shields: 0, special: 0 },
            traits: {
              serialNumber: 999999n,
              colors: {
                h1: 0,
                s1: 0,
                l1: 0,
                h2: 0,
                s2: 0,
                l2: 0,
              },
              variant: 2,
              accuracy: 0,
              hull: 0,
              speed: 0,
            },
            shipData: {
              constructed: true,
              inFleet: false,
              isFreeShip: false,
              modified: 0,
              timestampDestroyed: 0n,
              shiny: false,
              shipsDestroyed: 0,
              costsVersion: variant2CostsVersion,
              cost: 0,
            },
            owner: creator.account.address,
          },
        ],
        { account: owner.account },
      );

      const costLimit = 1000n;
      const turnTime = 300n;
      await creatorLobbies.write.createLobby([
        costLimit,
        turnTime,
        true,
        0n,
        100n,
        zeroAddress,
      ]);
      await joinerLobbies.write.joinLobby([1n]);

      await expect(
        creatorLobbies.write.createFleet([
          1n,
          [creatorShipIds[0], variant2ShipId],
          [
            { row: 0, col: 0 },
            { row: 0, col: 1 },
          ],
        ]),
      ).to.be.rejectedWith("MixedVariantFleet");
    });
  });
});
