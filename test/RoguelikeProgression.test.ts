import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import DeployModule from "../ignition/modules/DeployAndConfig";
import roguelikeStarterContent from "../ignition/data/roguelikeStarterContent.json";

// The roguelike campaign's enemy progression: the FIRST THREE MISSIONS on any
// path fight variant 1 ships, and every later mission fights variant 2. A
// node's mission number is the number of Combat nodes from the root to it,
// inclusive (m01 = 1, m02 = 2, ...). This checks the rule against the graph
// and enemy rosters as actually deployed on-chain; the expected node counts
// come from the JSON's root-reachable graph, so nodes orphaned while the
// progression path is being redesigned (2026-10-12) are simply not counted.
describe("Roguelike enemy progression", function () {
  const ROGUELIKE_CAMPAIGN_ID = 1n;
  const VARIANT_1_MISSIONS = 3;
  const COMBAT = 0;

  // Mission number of every root-reachable Combat node in the data file
  // (same shortest-path rule readGraph applies on-chain).
  function expectedMissions() {
    const kindOf = new Map(
      roguelikeStarterContent.nodes.map((n) => [n.key, n.kind]),
    );
    const step = (key: string) => (kindOf.get(key) === "Combat" ? 1 : 0);
    const missionOf = new Map([
      [roguelikeStarterContent.root, step(roguelikeStarterContent.root)],
    ]);
    const queue = [roguelikeStarterContent.root];
    while (queue.length) {
      const from = queue.shift()!;
      for (const e of roguelikeStarterContent.edges) {
        if (e.from !== from) continue;
        const mission = missionOf.get(from)! + step(e.to);
        const best = missionOf.get(e.to);
        if (best === undefined || mission < best) {
          missionOf.set(e.to, mission);
          queue.push(e.to);
        }
      }
    }
    return [...missionOf.entries()]
      .filter(([key]) => kindOf.get(key) === "Combat")
      .map(([, mission]) => mission);
  }

  async function deployAll() {
    return hre.ignition.deploy(DeployModule);
  }

  // Walks the deployed graph from the campaign root, returning each reachable
  // node's mission number (Combat nodes from the root, inclusive) and kind.
  async function readGraph(d: Awaited<ReturnType<typeof deployAll>>) {
    const root = await d.roguelikeNodeMap.read.campaignRootNode([
      ROGUELIKE_CAMPAIGN_ID,
    ]);
    const missionOf = new Map<bigint, number>();
    const nodeOf = new Map<bigint, any>();
    const queue: bigint[] = [];

    const visit = async (id: bigint, mission: number) => {
      const node = await d.roguelikeNodeMap.read.getNode([id]);
      nodeOf.set(id, node);
      const best = missionOf.get(id);
      if (best === undefined || mission < best) {
        missionOf.set(id, mission);
        queue.push(id);
      }
    };

    const rootNode = await d.roguelikeNodeMap.read.getNode([root]);
    await visit(root, rootNode.kind === COMBAT ? 1 : 0);
    while (queue.length) {
      const id = queue.shift()!;
      const here = missionOf.get(id)!;
      const children = await d.roguelikeNodeMap.read.getChildren([id]);
      for (const childId of children) {
        const child = await d.roguelikeNodeMap.read.getNode([childId]);
        await visit(childId, here + (child.kind === COMBAT ? 1 : 0));
      }
    }
    return { missionOf, nodeOf };
  }

  async function enemyVariants(
    d: Awaited<ReturnType<typeof deployAll>>,
    mapId: bigint,
  ) {
    const [, configIds] = await d.aiEncounters.read.getMapPlacements([mapId]);
    expect(configIds.length, `map ${mapId} has an enemy roster`).to.be.greaterThan(
      0,
    );
    const variants = new Set<number>();
    for (const configId of configIds) {
      const cfg = await d.aiEncounters.read.getAIShipConfig([configId]);
      variants.add(Number(cfg.traits.variant));
    }
    return variants;
  }

  it("fights only variant 1 ships in missions 1-3 and only variant 2 ships after", async function () {
    const d = await loadFixture(deployAll);
    const { missionOf, nodeOf } = await readGraph(d);

    let combatNodes = 0;
    let early = 0;
    for (const [id, node] of nodeOf) {
      if (node.kind !== COMBAT) continue;
      combatNodes++;
      const mission = missionOf.get(id)!;
      const variants = await enemyVariants(d, node.mapId);
      const expected = mission <= VARIANT_1_MISSIONS ? 1 : 2;
      if (mission <= VARIANT_1_MISSIONS) early++;
      expect(
        [...variants],
        `node ${id} (mission ${mission}) enemy variants`,
      ).to.deep.equal([expected]);
    }
    // Every reachable seeded fight was checked, early ones included.
    const seeded = expectedMissions();
    expect(combatNodes).to.equal(seeded.length);
    expect(early).to.equal(
      seeded.filter((m) => m <= VARIANT_1_MISSIONS).length,
    );
    expect(early).to.be.greaterThan(0);
  });

  it("starts on mission 1 and reaches mission 4 for the first time on the main spine's fourth fight", async function () {
    const d = await loadFixture(deployAll);
    const { missionOf, nodeOf } = await readGraph(d);
    const missions = [...missionOf.entries()]
      .filter(([id]) => nodeOf.get(id).kind === COMBAT)
      .map(([, m]) => m);
    expect(Math.min(...missions)).to.equal(1);
    // Nothing skips straight past mission 3 into variant 2 territory: the
    // first variant-2 mission anywhere is mission 4.
    expect(missions.filter((m) => m === 4).length).to.be.greaterThan(0);
    expect(missions.filter((m) => m <= 3).length).to.equal(
      expectedMissions().filter((m) => m <= 3).length,
    );
  });

  it("leaves the NodeMap campaign's maps on their original variant 2 rosters", async function () {
    const d = await loadFixture(deployAll);
    // The roguelike's early missions have their own maps, so the shared
    // campaign maps (ids 1-30) must be untouched: all variant 2.
    for (let mapId = 1n; mapId <= 30n; mapId++) {
      expect([...(await enemyVariants(d, mapId))], `campaign map ${mapId}`).to.deep.equal(
        [2],
      );
    }
  });

  it("gives the roguelike's early missions their own maps, not the campaign's", async function () {
    const d = await loadFixture(deployAll);
    const { missionOf, nodeOf } = await readGraph(d);
    for (const [id, node] of nodeOf) {
      if (node.kind !== COMBAT || missionOf.get(id)! > VARIANT_1_MISSIONS) continue;
      expect(
        node.mapId > 30n,
        `node ${id}'s map ${node.mapId} is a roguelike-only map (id > 30)`,
      ).to.equal(true);
    }
  });
});
