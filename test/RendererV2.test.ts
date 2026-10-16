import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseEther, zeroAddress } from "viem";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";
import { ShipTuple, tupleToShip } from "./types";

// Variant 2 (faction 2) has its own real art, generated from
// variant-2-pixel.psd by scripts/renderer-pipeline/ (manifest.variant2.json
// -> check-sizes.js -> gen-combiners.js) and wired into DeployAndConfig.ts
// as ImageRendererV2, distinct from variant 1's ImageRenderer. These tests
// cover the wiring (RenderMetadata dispatches on ship.traits.variant, both
// slots are populated with their own real renderer), not pixel-level art
// content.
describe("RenderMetadata variant dispatch", function () {
  async function mintVariantShip(fixture: any, variant: number) {
    const { ships, shatteredHiveMedal, randomManager, owner, user1 } = fixture;

    if (variant === 2) {
      await shatteredHiveMedal.write.ownerMint([user1.account.address], {
        account: owner.account,
      });
    }

    const countBefore = await ships.read.shipCount();

    await ships.write.purchaseWithFlow(
      [user1.account.address, 0n, user1.account.address, variant],
      { value: parseEther("4.99") },
    );

    const countAfter = await ships.read.shipCount();
    const firstNewId = countBefore + 1n;

    for (let id = firstNewId; id <= countAfter; id++) {
      const shipTuple = (await ships.read.ships([id])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }

    await ships.write.constructAllMyShips({ account: user1.account });

    return firstNewId;
  }

  it("wires distinct variant-1 and variant-2 image renderers into RenderMetadata", async function () {
    const { metadataRenderer, imageRenderer, imageRendererV2 } = await loadFixture(deployShipsFixture);

    const v1 = await metadataRenderer.read.imageRenderer();
    const v2 = await metadataRenderer.read.imageRendererV2();

    expect(v1.toLowerCase()).to.not.equal(zeroAddress);
    expect(v2.toLowerCase()).to.not.equal(zeroAddress);
    expect(v1.toLowerCase()).to.equal(imageRenderer.address.toLowerCase());
    expect(v2.toLowerCase()).to.equal(imageRendererV2.address.toLowerCase());

    // Each faction now has its own real renderer, not a shared placeholder.
    expect(v2.toLowerCase()).to.not.equal(v1.toLowerCase());
  });

  it("renders a valid SVG data URI for a variant-1 ship", async function () {
    const fixture = await loadFixture(deployShipsFixture);
    const { ships } = fixture;

    const id = await mintVariantShip(fixture, 1);
    const ship = tupleToShip((await ships.read.ships([id])) as ShipTuple);
    expect(ship.traits.variant).to.equal(1);

    const uri = await ships.read.tokenURI([id]);
    const json = JSON.parse(
      Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8"),
    );
    expect(json.image).to.match(/^data:image\/svg\+xml;base64,/);

    const svg = Buffer.from(
      json.image.replace("data:image/svg+xml;base64,", ""),
      "base64",
    ).toString("utf8");
    expect(svg).to.match(/^<svg/);
    expect(svg).to.match(/<\/svg>$/);
  });

  it("renders a valid SVG data URI for a variant-2 ship via the wired-in imageRendererV2 path", async function () {
    const fixture = await loadFixture(deployShipsFixture);
    const { ships } = fixture;

    const id = await mintVariantShip(fixture, 2);
    const ship = tupleToShip((await ships.read.ships([id])) as ShipTuple);
    expect(ship.traits.variant).to.equal(2);

    const uri = await ships.read.tokenURI([id]);
    const json = JSON.parse(
      Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8"),
    );
    expect(json.image).to.match(/^data:image\/svg\+xml;base64,/);

    const svg = Buffer.from(
      json.image.replace("data:image/svg+xml;base64,", ""),
      "base64",
    ).toString("utf8");
    expect(svg).to.match(/^<svg/);
    expect(svg).to.match(/<\/svg>$/);
  });

  // 2026-10-16: destroyed and unconstructed ships render on-chain art (per
  // variant, stored pre-base64-encoded in leaves by
  // scripts/renderer-pipeline/svg-to-leaves.js) instead of IPFS images.
  it("renders each variant's on-chain unconstructed and destroyed SVGs", async function () {
    const fixture = await loadFixture(deployShipsFixture);
    const { ships, imageRenderer, imageRendererV2 } = fixture;

    const decode = (image: string) => {
      expect(image).to.match(/^data:image\/svg\+xml;base64,/);
      const svg = Buffer.from(
        image.replace("data:image/svg+xml;base64,", ""),
        "base64",
      ).toString("utf8");
      expect(svg).to.match(/^<svg[^>]*viewBox="0 0 256 256"/);
      expect(svg).to.match(/<\/svg>$/);
      expect((svg.match(/<path /g) || []).length).to.be.greaterThan(5);
      return svg;
    };

    const svgs: string[] = [];
    for (const [variant, renderer] of [
      [1, imageRenderer],
      [2, imageRendererV2],
    ] as const) {
      const countBefore = await ships.read.shipCount();
      if (variant === 2) {
        await fixture.shatteredHiveMedal.write.ownerMint([fixture.user1.account.address], {
          account: fixture.owner.account,
        });
      }
      await ships.write.purchaseWithFlow(
        [fixture.user1.account.address, 0n, fixture.user1.account.address, variant],
        { value: parseEther("4.99") },
      );
      const id = countBefore + 1n;

      // Unconstructed, through the real tokenURI path.
      const uri = await ships.read.tokenURI([id]);
      const json = JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8"),
      );
      svgs.push(decode(json.image));

      // Destroyed.
      const ship = tupleToShip((await ships.read.ships([id])) as ShipTuple);
      ship.shipData.timestampDestroyed = 1n;
      svgs.push(decode(await (renderer as any).read.renderShip([ship])));
    }
    expect(new Set(svgs).size).to.equal(4);
  });
});
