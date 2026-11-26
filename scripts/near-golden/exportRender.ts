// Exports render goldens from the Solidity renderer stack (RenderMetadata ->
// ImageRenderer/ImageRendererV2 -> leaves, plus the Shattered Hive medal)
// for the NEAR renderer's parity test
// (near/contracts/void-renderer/tests/golden_render.rs).
//
// Ephemeral hardhat network only:
//   npx hardhat run scripts/near-golden/exportRender.ts
//
// Written 2026-11-13.

import hre from "hardhat";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import DeployModule from "../../ignition/modules/DeployAndConfig";

const OUT = path.join(__dirname, "../../near/golden/render.json");
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("hardhat network only");
  const d: any = await hre.ignition.deploy(DeployModule);
  const [owner] = await hre.viem.getWalletClients();
  const meta = await hre.viem.getContractAt("RenderMetadata", await d.ships.read.config().then((c: any) => c[3]));

  // Equipment display names, per variant and enum index.
  const names: unknown[] = [];
  for (const variant of [1, 2]) {
    for (let i = 0; i < 8; i++) {
      names.push({ variant, kind: "MainWeapon", index: i, name: await meta.read.mainWeaponNames([variant, i]) });
      names.push({ variant, kind: "Armor", index: i, name: await meta.read.armorNames([variant, i]) });
      names.push({ variant, kind: "Shields", index: i, name: await meta.read.shieldsNames([variant, i]) });
      names.push({ variant, kind: "Special", index: i, name: await meta.read.specialNames([variant, i]) });
    }
  }

  // Deterministic, varied ships.
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const ships: any[] = [];
  for (const variant of [1, 2]) {
    for (let i = 0; i < 90; i++) {
      const useArmor = i % 3 === 0;
      const defense = (i >> 2) % 4;
      ships.push({
        name: i % 17 === 0 ? "Vαngυɑrd Ω" : `Ship ${variant}-${i}`,
        id: BigInt(1 + variant * 1000 + i),
        equipment: {
          mainWeapon: i % 4,
          armor: useArmor ? defense : 0,
          shields: useArmor ? 0 : defense,
          special: (i >> 1) % 4,
        },
        traits: {
          serialNumber: BigInt(rnd(1_000_000)),
          colors: { h1: rnd(360), s1: rnd(100), l1: rnd(100), h2: rnd(360), s2: rnd(100), l2: rnd(100) },
          variant,
          accuracy: i % 3,
          hull: (i >> 1) % 3,
          speed: (i >> 2) % 3,
        },
        shipData: {
          shipsDestroyed: rnd(1000),
          costsVersion: 1,
          cost: rnd(300),
          modified: i % 5 === 0 ? 2 : 0,
          shiny: i % 2 === 1,
          constructed: true,
          inFleet: false,
          isFreeShip: false,
          timestampDestroyed: 0n,
        },
        owner: owner.account.address,
      });
    }
    // Perfect fore (all traits 2 + heavy defense), destroyed, unconstructed,
    // and out-of-range enum values (future weapon / future shields + armor).
    const base = ships[ships.length - 1];
    const variants = [
      { traits: { ...base.traits, accuracy: 2, hull: 2, speed: 2 }, equipment: { ...base.equipment, armor: 3, shields: 0 } },
      { traits: { ...base.traits, accuracy: 2, hull: 2, speed: 2 }, equipment: { ...base.equipment, armor: 0, shields: 3 } },
      { shipData: { ...base.shipData, timestampDestroyed: 123n } },
      { shipData: { ...base.shipData, constructed: false } },
      { equipment: { ...base.equipment, mainWeapon: 5, special: 6 } },
      { equipment: { ...base.equipment, shields: 4, armor: 1 } },
    ];
    variants.forEach((o, k) => ships.push({ ...base, id: base.id + BigInt(100 + k), ...o }));
  }

  const out: any[] = [];
  for (const [k, ship] of ships.entries()) {
    const uri: string = await meta.read.tokenURI([ship]);
    out.push({
      ship: JSON.parse(JSON.stringify(ship, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      sha256: sha(uri),
      length: uri.length,
      full: k % 60 === 0 ? uri : undefined,
    });
  }

  await d.shatteredHiveMedal.write.ownerMint([owner.account.address]);
  const medal: string = await d.shatteredHiveMedal.read.tokenURI([1n]);

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ writtenAt: new Date().toISOString(), names, ships: out, medal: { tokenId: 1, sha256: sha(medal), length: medal.length } }),
  );
  console.log(`wrote ${out.length} render goldens to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
