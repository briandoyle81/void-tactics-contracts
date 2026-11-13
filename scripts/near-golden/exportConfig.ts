// Exports the rules configuration produced by the real deploy module
// (attribute tables, costs, resolver params, economy knobs) to
// near/seed/config.json, which the NEAR seeder (near/tests/src/seed.rs)
// publishes so both stacks run the same rules.
//
// Ephemeral hardhat network only:
//   npx hardhat run scripts/near-golden/exportConfig.ts
//
// Written 2026-11-13.

import hre from "hardhat";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import DeployModule from "../../ignition/modules/DeployAndConfig";

const OUT = path.join(__dirname, "../../near/seed/config.json");
const big = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("hardhat network only");
  const d: any = await hre.ignition.deploy(DeployModule);
  const at = (name: string, addr: `0x${string}`) => hre.viem.getContractAt(name as any, addr) as any;

  const variants: Record<string, unknown> = {};
  for (const v of [1, 2]) {
    const latest = Number(await d.shipAttributes.read.getLatestAttributesVersion([v]));
    const versions = [];
    for (let ver = 1; ver <= latest; ver++) versions.push(await d.shipAttributes.read.getVariantAttributes([v, ver]));
    const [, costs] = await d.shipAttributes.read.getCosts([v]);
    variants[v] = {
      attributeVersions: versions,
      currentAttributesVersion: Number(await d.shipAttributes.read.getCurrentAttributesVersion([v])),
      costs,
      maxSpecialSlot: Number(await d.game.read.maxSpecialSlot([v])),
    };
  }
  const ram = await at("RamResolver", await d.game.read.factionAbilityResolvers([1]));
  const repair = await at("RepairResolver", await d.game.read.factionAbilityResolvers([2]));

  const tiers: number[] = [];
  for (let i = 0; ; i++) {
    try {
      tiers.push(Number(await d.droneStorefront.read.tierCoreCost([BigInt(i)])));
    } catch {
      break;
    }
  }

  const config = {
    writtenAt: new Date().toISOString(),
    source: "ignition/modules/DeployAndConfig.ts (PRODUCTION=false) on the ephemeral hardhat network",
    variants,
    healCapPercent: Number(await d.game.read.healCapPercent()),
    ram: { range: Number(await ram.read.range()) },
    repair: { range: Number(await repair.read.range()), strength: Number(await repair.read.strength()) },
    // Game.specialResolvers wiring: [variant, slot, resolver kind, data slot]
    specialResolvers: [
      [1, 1, "Emp"],
      [1, 2, "RepairDrones"],
      [1, 3, "FlakArray"],
      [2, 1, "ElectricStorm"],
      [2, 2, "DroneSwarm"],
    ],
    rewardTokens: { "2": "Dec" },
    factionKillReward: (await d.shipsRouter.read.factionKillReward()).toString(),
    storefrontTiers: tiers,
    claimCooldownSeconds: Number(await d.freeShipClaim.read.claimCooldownPeriod()),
    maxVariant: Number(await d.ships.read.maxVariant()),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(big(config), null, 2));
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
