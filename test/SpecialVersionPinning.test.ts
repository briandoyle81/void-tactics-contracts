import { expect } from "chai";
import hre from "hardhat";
import { zeroAddress } from "viem";
import { attributeParams } from "./fixtures/attributeTables";

// Regression tests for "special resolvers read the LIVE attributes table
// while combat stats are snapshotted per game". Each resolver must read
// special range/strength at the ACTING ship's pinned attributes version
// (Attributes.version, stored by Game.calculateShipAttributes at game start),
// so publishing or rolling back a version can't change an in-flight game.
//
// Uses the real ShipAttributes (so versions are real) behind MockGameView (so
// each ship's pinned version is set directly), one resolver at a time.
describe("Special resolvers read the game-pinned attributes version", function () {
  const GAME_ID = 1n;
  const ACTING = 1n;
  const TARGET = 2n;
  const VARIANT = 1;
  const SLOT1 = 1; // Special.Slot1

  // Version 1: wide reach, gentle. Version 2: short reach, strong.
  const V1 = { range: 3, strength: 10 };
  const V2 = { range: 1, strength: 50 };

  function tablesWithSlot1(special: { range: number; strength: number }) {
    return attributeParams({
      variant: VARIANT,
      baseHull: 100,
      baseSpeed: 3,
      foreAccuracy: [0, 0, 0],
      hull: [0, 0, 0],
      engineSpeeds: [0, 0, 0],
      guns: [{ range: 1, damage: 1, movement: 0 }],
      armors: [{ damageReduction: 0, movement: 0 }],
      shields: [{ damageReduction: 0, movement: 0 }],
      specials: [
        { range: 0, strength: 0, movement: 0 },
        { ...special, movement: 0 },
      ],
    });
  }

  function position(
    shipId: bigint,
    col: number,
    isCreator: boolean,
  ): {
    shipId: bigint;
    position: { row: number; col: number };
    isCreator: boolean;
    status: number;
  } {
    return { shipId, position: { row: 0, col }, isCreator, status: 0 };
  }

  function attrsAtVersion(version: number) {
    return {
      version,
      range: 0,
      gunDamage: 0,
      hullPoints: 100,
      maxHullPoints: 100,
      movement: 0,
      damageReduction: 0,
      reactorCriticalTimer: 0,
      statusEffects: [],
    };
  }

  async function setup(resolverName: string, friendlyTarget: boolean) {
    const [owner] = await hre.viem.getWalletClients();
    const shipAttributes = await hre.viem.deployContract("ShipAttributes", [
      zeroAddress,
    ]);
    // v1 then v2 for the variant; v2 is live afterwards.
    await shipAttributes.write.setVariantAttributes([tablesWithSlot1(V1)], {
      account: owner.account,
    });
    await shipAttributes.write.setVariantAttributes([tablesWithSlot1(V2)], {
      account: owner.account,
    });
    expect(
      await shipAttributes.read.getCurrentAttributesVersion([VARIANT]),
    ).to.equal(2);

    const gameView = await hre.viem.deployContract("MockGameView", []);
    const resolver = await hre.viem.deployContract(resolverName as any, [
      shipAttributes.address,
      SLOT1,
    ]);

    // Acting ship at col 0, target two tiles away (inside v1's range of 3,
    // outside v2's range of 1). Enemy targets have the opposite isCreator.
    await gameView.write.setShipPosition([
      GAME_ID,
      ACTING,
      position(ACTING, 0, true),
    ]);
    await gameView.write.setShipPosition([
      GAME_ID,
      TARGET,
      position(TARGET, 2, friendlyTarget),
    ]);
    await gameView.write.setShipAttributes([
      GAME_ID,
      TARGET,
      attrsAtVersion(1),
    ]);

    const pinActingShipTo = (version: number) =>
      gameView.write.setShipAttributes([
        GAME_ID,
        ACTING,
        attrsAtVersion(version),
      ]);

    // resolver.resolveEffect is invoked through gameView (not directly) so
    // the resolver sees gameView.address as msg.sender — see resolvers'
    // engine-agnostic-by-construction comment (2026-09-28): they read live
    // ship state via IGameView(msg.sender), which would otherwise resolve
    // to this test's own account instead of the mock.
    const resolve = () =>
      gameView.read.callResolveEffect([
        resolver.address,
        GAME_ID,
        ACTING,
        VARIANT,
        TARGET,
        0,
        0,
      ]);

    return { pinActingShipTo, resolve };
  }

  describe("single-target resolvers", function () {
    it("EMPResolver uses the acting ship's pinned version, not the live one", async function () {
      const { pinActingShipTo, resolve } = await setup("EMPResolver", false);

      // Pinned to v1 (range 3, strength 10) even though v2 (range 1) is live:
      // the target 2 tiles away is in range, and strength is v1's.
      await pinActingShipTo(1);
      const effects = await resolve();
      expect(effects.length).to.equal(1);
      expect(effects[0].reactorTimerDelta).to.equal(V1.strength);

      // A ship pinned to v2 sees v2's shorter range: the same target is out
      // of range — so the resolver really does follow the ship's own pin.
      await pinActingShipTo(2);
      await expect(resolve()).to.be.rejectedWith("OutOfRange");
    });

    it("RepairDronesResolver uses the acting ship's pinned version", async function () {
      const { pinActingShipTo, resolve } = await setup(
        "RepairDronesResolver",
        true,
      );

      await pinActingShipTo(1);
      const effects = await resolve();
      expect(effects.length).to.equal(1);
      expect(effects[0].hullDelta).to.equal(V1.strength);

      await pinActingShipTo(2);
      await expect(resolve()).to.be.rejectedWith("OutOfRange");
    });

    it("DroneSwarmResolver uses the acting ship's pinned version", async function () {
      const { pinActingShipTo, resolve } = await setup(
        "DroneSwarmResolver",
        false,
      );

      // Target damage reduction is 0, so damage == strength.
      await pinActingShipTo(1);
      const effects = await resolve();
      expect(effects.length).to.equal(1);
      expect(effects[0].hullDelta).to.equal(-V1.strength);

      await pinActingShipTo(2);
      await expect(resolve()).to.be.rejectedWith("OutOfRange");
    });
  });

  describe("area-of-effect resolvers", function () {
    it("FlakArrayResolver hits everything inside the pinned range", async function () {
      const { pinActingShipTo, resolve } = await setup(
        "FlakArrayResolver",
        false,
      );

      // v1: the target 2 tiles away is inside range 3 and takes v1's damage.
      await pinActingShipTo(1);
      const pinnedToV1 = await resolve();
      expect(pinnedToV1.length).to.equal(1);
      expect(pinnedToV1[0].shipId).to.equal(TARGET);
      expect(pinnedToV1[0].hullDelta).to.equal(-V1.strength);

      // v2: range 1 — the same target is out of reach.
      await pinActingShipTo(2);
      expect((await resolve()).length).to.equal(0);
    });

    it("ElectricStormResolver applies the pinned range and strength", async function () {
      const { pinActingShipTo, resolve } = await setup(
        "ElectricStormResolver",
        false,
      );

      // v1: the caster (distance 0) and the target (distance 2) are both in
      // range 3, each getting v1's strength.
      await pinActingShipTo(1);
      const pinnedToV1 = await resolve();
      expect(pinnedToV1.length).to.equal(2);
      for (const effect of pinnedToV1) {
        expect(effect.reactorTimerDelta).to.equal(V1.strength);
      }

      // v2: range 1 — only the caster itself remains, with v2's strength.
      await pinActingShipTo(2);
      const pinnedToV2 = await resolve();
      expect(pinnedToV2.length).to.equal(1);
      expect(pinnedToV2[0].shipId).to.equal(ACTING);
      expect(pinnedToV2[0].reactorTimerDelta).to.equal(V2.strength);
    });
  });
});
