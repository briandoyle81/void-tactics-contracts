import hre from "hardhat";
import { parseEther } from "viem";
import DeployModule from "../../ignition/modules/DeployAndConfig";

/**
 * Full stack from Ignition DeployModule + UTC mints and user contract handles.
 * Shared by Ships tests and cost/version integration tests.
 */
export async function deployShipsFixture() {
  const [owner, user1, user2, user3] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const {
    ships,
    shipNames,
    droneNames,
    metadataRenderer,
    randomManager,
    imageRenderer,
    imageRendererV2,
    renderSpecial,
    renderAft,
    renderWeapon,
    renderBody,
    renderFore,
    renderSpecial1,
    renderSpecial2,
    renderSpecial3,
    renderAft0,
    renderAft1,
    renderAft2,
    renderWeapon1,
    renderWeapon2,
    renderWeapon3,
    renderShield1,
    renderShield2,
    renderShield3,
    renderArmor1,
    renderArmor2,
    renderArmor3,
    renderFore0,
    renderFore1,
    renderFore2,
    universalCredits,
    droneEnergyCores,
    shipPurchaser,
    shipAttributes,
    droneYard,
    generateNewShip,
    variantPurchaseGate,
    shatteredHiveMedal,
    freeShipClaim,
    droneStorefront,
  } = await hre.ignition.deploy(DeployModule);

  const user1Ships = await hre.viem.getContractAt("Ships", ships.address, {
    client: { wallet: user1 },
  });

  const user2Ships = await hre.viem.getContractAt("Ships", ships.address, {
    client: { wallet: user2 },
  });

  const user3Ships = await hre.viem.getContractAt("Ships", ships.address, {
    client: { wallet: user3 },
  });

  const user1FreeShipClaim = await hre.viem.getContractAt(
    "FreeShipClaim",
    freeShipClaim.address,
    {
      client: { wallet: user1 },
    },
  );
  const user2FreeShipClaim = await hre.viem.getContractAt(
    "FreeShipClaim",
    freeShipClaim.address,
    {
      client: { wallet: user2 },
    },
  );
  const user3FreeShipClaim = await hre.viem.getContractAt(
    "FreeShipClaim",
    freeShipClaim.address,
    {
      client: { wallet: user3 },
    },
  );

  const user1UC = await hre.viem.getContractAt(
    "UniversalCredits",
    universalCredits.address,
    {
      client: { wallet: user1 },
    },
  );
  const user2UC = await hre.viem.getContractAt(
    "UniversalCredits",
    universalCredits.address,
    {
      client: { wallet: user2 },
    },
  );
  const user3UC = await hre.viem.getContractAt(
    "UniversalCredits",
    universalCredits.address,
    {
      client: { wallet: user3 },
    },
  );

  const user1Purchaser = await hre.viem.getContractAt(
    "ShipPurchaser",
    shipPurchaser.address,
    {
      client: { wallet: user1 },
    },
  );
  const user2Purchaser = await hre.viem.getContractAt(
    "ShipPurchaser",
    shipPurchaser.address,
    {
      client: { wallet: user2 },
    },
  );
  const user3Purchaser = await hre.viem.getContractAt(
    "ShipPurchaser",
    shipPurchaser.address,
    {
      client: { wallet: user3 },
    },
  );

  await universalCredits.write.setAuthorizedToMint([
    owner.account.address,
    true,
  ]);

  await universalCredits.write.mint([
    user1.account.address,
    parseEther("1000"),
  ]);
  await universalCredits.write.mint([
    user2.account.address,
    parseEther("1000"),
  ]);
  await universalCredits.write.mint([
    user3.account.address,
    parseEther("1000"),
  ]);

  await user1UC.write.approve([shipPurchaser.address, parseEther("1000")]);
  await user2UC.write.approve([shipPurchaser.address, parseEther("1000")]);
  await user3UC.write.approve([shipPurchaser.address, parseEther("1000")]);

  await user1UC.write.approve([droneYard.address, parseEther("1000")]);
  await user2UC.write.approve([droneYard.address, parseEther("1000")]);
  await user3UC.write.approve([droneYard.address, parseEther("1000")]);

  const user1DroneYard = await hre.viem.getContractAt(
    "DroneYard",
    droneYard.address,
    {
      client: { wallet: user1 },
    },
  );
  const user2DroneYard = await hre.viem.getContractAt(
    "DroneYard",
    droneYard.address,
    {
      client: { wallet: user2 },
    },
  );
  const user3DroneYard = await hre.viem.getContractAt(
    "DroneYard",
    droneYard.address,
    {
      client: { wallet: user3 },
    },
  );

  return {
    ships,
    user1Ships,
    user2Ships,
    user3Ships,
    shipNames,
    droneNames,
    metadataRenderer,
    randomManager,
    imageRenderer,
    imageRendererV2,
    renderSpecial,
    renderAft,
    renderWeapon,
    renderBody,
    renderFore,
    renderSpecial1,
    renderSpecial2,
    renderSpecial3,
    renderAft0,
    renderAft1,
    renderAft2,
    renderWeapon1,
    renderWeapon2,
    renderWeapon3,
    renderShield1,
    renderShield2,
    renderShield3,
    renderArmor1,
    renderArmor2,
    renderArmor3,
    renderFore0,
    renderFore1,
    renderFore2,
    owner,
    user1,
    user2,
    user3,
    publicClient,
    universalCredits,
    droneEnergyCores,
    shipPurchaser,
    shipAttributes,
    user1UC,
    user2UC,
    user3UC,
    user1Purchaser,
    user2Purchaser,
    user3Purchaser,
    droneYard,
    user1DroneYard,
    user2DroneYard,
    user3DroneYard,
    generateNewShip,
    variantPurchaseGate,
    shatteredHiveMedal,
    freeShipClaim,
    user1FreeShipClaim,
    user2FreeShipClaim,
    user3FreeShipClaim,
    droneStorefront,
  };
}
