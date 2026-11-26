// Exports differential ("golden") fixtures from the Solidity contracts for the
// native-NEAR port (near/). The Rust port must reproduce these outputs
// exactly; see near/crates/vt-core/tests/golden.rs.
//
// Runs only on the ephemeral in-process `hardhat` network:
//   npx hardhat run scripts/near-golden/exportGolden.ts
//
// Written 2026-11-13.

import hre from "hardhat";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { keccak256, encodePacked } from "viem";
import { seedVariant1Attributes } from "../../test/fixtures/seedVariant1Attributes";

const OUT_DIR = path.join(__dirname, "../../near/golden");

// JSON-safe: bigint -> decimal string.
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  if (hre.network.name !== "hardhat") {
    throw new Error("exportGolden must run on the ephemeral hardhat network");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const [owner] = await hre.viem.getWalletClients();

  // --- contracts ---
  const shipNames = await hre.viem.deployContract("MockOnchainRandomShipNames");
  const droneNames = await hre.viem.deployContract("DroneNames");
  const generator = await hre.viem.deployContract("GenerateNewShip", [
    shipNames.address,
    droneNames.address,
  ]);
  const maxSlot = await hre.viem.deployContract("MockMaxSpecialSlot");
  await maxSlot.write.setMaxSpecialSlot([1, 3]);
  await maxSlot.write.setMaxSpecialSlot([2, 3]);
  await generator.write.setGameContract([maxSlot.address]);

  // ShipAttributes needs a ships address only for by-id lookups (unused here).
  const shipAttributes = await hre.viem.deployContract("ShipAttributes", [
    owner.account.address,
  ]);
  await seedVariant1Attributes(shipAttributes, owner.account);
  const variant1Attributes = await shipAttributes.read.getVariantAttributes([1, 0]);
  const [, variant1Costs] = await shipAttributes.read.getCosts([1]);

  // --- random bases: deterministic spread plus edge values ---
  const bases: bigint[] = [0n, 1n, 2n, 255n, 256n, (1n << 63n) - 1n, 1n << 63n];
  for (let i = 0; i < 300; i++) {
    const h = BigInt(keccak256(encodePacked(["string", "uint256"], ["near-golden", BigInt(i)])));
    bases.push(h & ((1n << 64n) - 1n));
  }
  // Solidity's checked randomBase++ reverts within ~16 of u64::MAX; keep clear.
  const safeBases = bases.filter((b) => b < (1n << 64n) - 32n);

  const ships: unknown[] = [];
  for (const [i, base] of safeBases.entries()) {
    for (const variant of [1, 2]) {
      const id = BigInt(i + 1);
      const serial = BigInt(1000 + i);
      const ship: any = await generator.read.generateShip([id, serial, base, variant]);
      const entry: any = { randomBase: base, id, serial, variant, ship };
      if (variant === 1) {
        entry.attributes = await shipAttributes.read.calculateShipAttributes([ship]);
        entry.cost = await shipAttributes.read.calculateShipCost([ship]);
      }
      ships.push(entry);
    }
  }

  writeFileSync(
    path.join(OUT_DIR, "generation.json"),
    toJson({
      generatedAt: new Date().toISOString(),
      note: "Variant-1 names come from MockOnchainRandomShipNames ('Mock Ship'); compare all other fields.",
      maxSpecialSlot: { "1": 3, "2": 3 },
      variant1Attributes,
      variant1Costs,
      ships,
    }),
  );
  console.log(`wrote ${ships.length} ship fixtures to ${OUT_DIR}/generation.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
