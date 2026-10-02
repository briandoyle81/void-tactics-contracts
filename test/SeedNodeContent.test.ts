import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { getAddress } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";
import starterContent from "../ignition/data/singlePlayerStarterContent.json";
import roguelikeStarterContent from "../ignition/data/roguelikeStarterContent.json";

// Data-driven check of DeployAndConfig.ts's optional node seed fields
// (2026-10-02): every node that carries `title`/`description` in the seed
// files gets that content in NodeContentRegistry, every roguelike node gets
// exactly its `winEffects` list, and nodes without them get nothing. Passes
// trivially on seed files with none of these fields; meaningful once the
// frontend's mission seed export writes them.
type SeedNode = {
  key: string;
  title?: string;
  description?: string;
  winEffects?: string[];
};

describe("Seeded node content and win effects", function () {
  async function deployFixture() {
    return hre.ignition.deploy(DeployModule);
  }

  it("seeds campaign node titles/descriptions from the seed file", async function () {
    const { nodeContentRegistry } = await loadFixture(deployFixture);
    const nodes = starterContent.campaignNodes as SeedNode[];
    for (const [i, node] of nodes.entries()) {
      const [title, description] = await nodeContentRegistry.read.getNodeContent([
        false,
        BigInt(i + 1),
      ]);
      expect(title, node.key).to.equal(node.title ?? "");
      expect(description, node.key).to.equal(node.description ?? "");
    }
  });

  it("seeds roguelike node titles/descriptions from the seed file", async function () {
    const { nodeContentRegistry } = await loadFixture(deployFixture);
    const nodes = roguelikeStarterContent.nodes as SeedNode[];
    for (const [i, node] of nodes.entries()) {
      const [title, description] = await nodeContentRegistry.read.getNodeContent([
        true,
        BigInt(i + 1),
      ]);
      expect(title, node.key).to.equal(node.title ?? "");
      expect(description, node.key).to.equal(node.description ?? "");
    }
  });

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
