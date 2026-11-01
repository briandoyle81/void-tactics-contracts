import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { keccak256, toBytes, zeroAddress } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";

// Variant 2's gun table, its display names, and its weapon art are three
// separate lists all indexed by the MainWeapon enum (Generic, Sniper, Missile,
// Close). A mismatch is silent — the wrong art or name would just show up on a
// ship — so this checks all three agree, for each weapon, on the real deploy.
describe("Variant 2 weapon order: guns, names and art agree", function () {
  // MainWeapon enum order -> variant 2's name and gun (range, damage)
  const EXPECTED = [
    { weapon: 0, name: "Medium Mining Laser", range: 2, damage: 60 }, // Generic
    { weapon: 1, name: "Linear Accelerator", range: 5, damage: 50 }, // Sniper
    { weapon: 2, name: "Torpedo Launcher", range: 3, damage: 70 }, // Missile
    { weapon: 3, name: "Mining Drill", range: 1, damage: 95 }, // Close
  ];

  function shipWithWeapon(mainWeapon: number) {
    return {
      name: "",
      id: 1n,
      equipment: { mainWeapon, armor: 0, shields: 0, special: 0 },
      traits: {
        serialNumber: 1n,
        colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0 },
        variant: 2,
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
        constructed: true,
        inFleet: false,
        isFreeShip: false,
        timestampDestroyed: 0n,
      },
      owner: zeroAddress,
    };
  }

  async function deployAll() {
    return hre.ignition.deploy(DeployModule);
  }

  it("has the same weapon at each enum index in the gun table and the display names", async function () {
    const d = await loadFixture(deployAll);
    for (const e of EXPECTED) {
      expect(
        await d.metadataRenderer.read.mainWeaponNames([2, e.weapon]),
        `name for weapon ${e.weapon}`,
      ).to.equal(e.name);
      const gun = await d.shipAttributes.read.getGunData([e.weapon, 2]);
      expect([gun.range, gun.damage], `gun for ${e.name}`).to.deep.equal([
        e.range,
        e.damage,
      ]);
    }
  });

  it("renders each weapon with the art leaf wired to its enum slot", async function () {
    const d = await loadFixture(deployAll);
    // RenderWeaponV2's constructor order is [Weapon1..Weapon4] = enum 0..3, and
    // the pipeline manifest maps medium-mining-laser -> RenderWeapon1V2,
    // linear-accelerator -> 2, torpedo-launcher -> 3, mining-drill -> 4.
    const leaves = [
      d.renderWeapon1V2,
      d.renderWeapon2V2,
      d.renderWeapon3V2,
      d.renderWeapon4V2,
    ];
    const hashes = new Set<string>();
    for (const e of EXPECTED) {
      const ship = shipWithWeapon(e.weapon);
      const viaCombiner = await d.renderWeaponV2.read.render([ship]);
      const viaLeaf = await leaves[e.weapon].read.render([ship]);
      expect(viaCombiner.length, `${e.name} art is non-empty`).to.be.greaterThan(0);
      expect(viaCombiner, `${e.name} uses leaf ${e.weapon + 1}`).to.equal(viaLeaf);
      hashes.add(keccak256(toBytes(viaCombiner)));
    }
    // and the four weapons each have their own art
    expect(hashes.size).to.equal(4);
  });
});
