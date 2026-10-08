import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { getAddress } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";
import roguelikeStarterContent from "../ignition/data/roguelikeStarterContent.json";

// Data-driven check of DeployAndConfig.ts's optional `winEffects` node seed
// field (2026-10-02): every roguelike node gets exactly its `winEffects`
// list, and nodes without one get nothing. (Node titles/descriptions used to
// be seeded into NodeContentRegistry and checked here too; that contract was
// removed 2026-10-08 — they're frontend-only display data now.)
type SeedNode = {
  key: string;
  winEffects?: string[];
};

describe("Seeded roguelike node win effects", function () {
  async function deployFixture() {
    return hre.ignition.deploy(DeployModule);
  }

  it("seeds roguelike node win effects in order from the seed file", async function () {
    const deployed = await loadFixture(deployFixture);
    const addressByKey: Record<string, string> = {
      DEC_BONUS_WIN_EFFECT: getAddress(deployed.decBonusWinEffect.address),
      HEAL_ABOVE_FLOOR_WIN_EFFECT: getAddress(deployed.healAboveFloorWinEffect.address),
      SHIP_GRANT_WIN_EFFECT: getAddress(deployed.shipGrantWinEffect.address),
    };
    const nodes = roguelikeStarterContent.nodes as SeedNode[];
    for (const [i, node] of nodes.entries()) {
      const effects = await deployed.roguelikeNodeMap.read.getNodeWinEffects([BigInt(i + 1)]);
      expect(effects.map((a) => getAddress(a)), node.key).to.deep.equal(
        (node.winEffects ?? []).map((k) => addressByKey[k]),
      );
    }
  });
});
