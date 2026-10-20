import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, keccak256, toBytes, getAddress, maxUint256 } from "viem";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";
import { attributeParams, costsParams } from "./fixtures/attributeTables";
import {
  Ship,
  ShipData,
  ShipEquipment,
  ShipTraits,
  ShipTuple,
  tupleToShip,
} from "./types";

describe("Ships", function () {
  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { ships, owner } = await loadFixture(deployShipsFixture);
      const contractOwner = await ships.read.owner();
      expect(contractOwner.toString().toLocaleLowerCase()).to.equal(
        owner.account.address.toLocaleLowerCase(),
      );
    });

    it("Should set the correct initial tier prices", async function () {
      const { ships } = await loadFixture(deployShipsFixture);
      const [shipsPerTier, prices] = await ships.read.getPurchaseInfo();

      // Check tier 0 (5 ships for 4.99 Flow)
      expect(shipsPerTier[0]).to.equal(5);
      expect(prices[0]).to.equal(parseEther("4.99"));

      // Check tier 1 (11 ships for 9.99 Flow)
      expect(shipsPerTier[1]).to.equal(11);
      expect(prices[1]).to.equal(parseEther("9.99"));

      // Check tier 2 (22 ships for 19.99 Flow)
      expect(shipsPerTier[2]).to.equal(22);
      expect(prices[2]).to.equal(parseEther("19.99"));

      // Check tier 3 (40 ships for 34.99 Flow)
      expect(shipsPerTier[3]).to.equal(40);
      expect(prices[3]).to.equal(parseEther("34.99"));

      // Check tier 4 (60 ships for 49.99 Flow)
      expect(shipsPerTier[4]).to.equal(60);
      expect(prices[4]).to.equal(parseEther("49.99"));
    });

    it("Should allow owner to set purchase info", async function () {
      const { ships, owner } = await loadFixture(deployShipsFixture);

      const newShipsPerTier = [5, 10, 15];
      const newPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await ships.write.setPurchaseInfo([newShipsPerTier, newPrices]);

      const [shipsPerTier, prices] = await ships.read.getPurchaseInfo();
      expect(shipsPerTier).to.deep.equal(newShipsPerTier);
      expect(prices).to.deep.equal(newPrices);
    });

    it("Should not allow non-owner to set purchase info", async function () {
      const { ships, user1 } = await loadFixture(deployShipsFixture);

      const newShipsPerTier = [5, 10, 15];
      const newPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await expect(
        ships.write.setPurchaseInfo([newShipsPerTier, newPrices], {
          account: user1.account,
        }),
      ).to.be.rejectedWith(
        'OwnableUnauthorizedAccount("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")',
      );
    });

    it("Should allow owner to set game address", async function () {
      const { ships, owner, user1 } = await loadFixture(deployShipsFixture);

      await ships.write.setConfig([
        user1.account.address, // gameAddress
        "0x0000000000000000000000000000000000000000", // lobbyAddress
        "0x0000000000000000000000000000000000000000", // fleetsAddress
        "0x0000000000000000000000000000000000000000", // shipGenerator
        "0x0000000000000000000000000000000000000000", // randomManager
        "0x0000000000000000000000000000000000000000", // metadataRenderer
        "0x0000000000000000000000000000000000000000", // shipAttributes
        "0x0000000000000000000000000000000000000000", // universalCredits
        "0x0000000000000000000000000000000000000000", // droneEnergyCores
        "0x0000000000000000000000000000000000000000", // purchaseGate
      ]);

      const config = await ships.read.config();
      expect(config[0].toString().toLowerCase()).to.equal(
        user1.account.address.toLowerCase(),
      );
    });
  });

  describe("Minting", function () {
    it("Should purchase tier 0 with correct payment", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      const tx = await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      await publicClient.waitForTransactionReceipt({ hash: tx });

      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(5n);

      // Check all ships are owned by user1
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }

      // Check referral count increased by 5 ships
      const referralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(5n);
    });

    it("Should purchase tier 1 with correct payment", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      const tx = await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      await publicClient.waitForTransactionReceipt({ hash: tx });

      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(11n);

      // Check all ships are owned by user1
      for (let i = 1; i <= 11; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }

      // Check referral count increased by 11 ships
      const referralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(11n);
    });

    it("Should revert tier 0 with invalid payment", async function () {
      const { ships, user1, user2 } = await loadFixture(deployShipsFixture);

      const invalidPayment = parseEther("3.99"); // Pay 1 Flow less than required

      await expect(
        ships.write.purchaseWithFlow(
          [user1.account.address, 0n, user2.account.address, 1],
          { value: invalidPayment },
        ),
      ).to.be.rejectedWith("InvalidPurchase");
    });

    it("Should retain full FLOW for tier 0 when referral is zero address", async function () {
      const { ships, user1, publicClient } = await loadFixture(
        deployShipsFixture,
      );

      const price = parseEther("4.99");
      const initialContractBalance = await publicClient.getBalance({
        address: ships.address,
      });

      const txHash = await ships.write.purchaseWithFlow(
        [
          user1.account.address,
          0n,
          "0x0000000000000000000000000000000000000000",
          1n,
        ],
        { value: price, account: user1.account },
      );
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const finalContractBalance = await publicClient.getBalance({
        address: ships.address,
      });
      expect(finalContractBalance - initialContractBalance).to.equal(price);
    });

    it("Should revert with invalid payment", async function () {
      const { ships, user1, user2 } = await loadFixture(deployShipsFixture);

      await expect(
        ships.write.purchaseWithFlow(
          [user1.account.address, 0n, user2.account.address, 1],
          { value: parseEther("0.5") },
        ),
      ).to.be.rejectedWith("InvalidPurchase");
    });

    it("Should retain full FLOW for higher tier when referral is zero address", async function () {
      const { ships, user1, publicClient } = await loadFixture(
        deployShipsFixture,
      );

      const price = parseEther("19.99");
      const initialContractBalance = await publicClient.getBalance({
        address: ships.address,
      });

      const txHash = await ships.write.purchaseWithFlow(
        [
          user1.account.address,
          2n,
          "0x0000000000000000000000000000000000000000",
          1n,
        ],
        { value: price, account: user1.account },
      );
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const finalContractBalance = await publicClient.getBalance({
        address: ships.address,
      });
      expect(finalContractBalance - initialContractBalance).to.equal(price);
    });

    it("Should purchase 10,000 ships", async function () {
      const [owner, user1, user2] = await hre.viem.getWalletClients();
      const { ships, publicClient } = await loadFixture(deployShipsFixture);

      // Use owner account which has more funds
      const ownerShips = await hre.viem.getContractAt("Ships", ships.address, {
        client: { wallet: owner },
      });

      const targetShipCount = 10000n;
      const tier4ShipsPerPurchase = 60n; // Tier 4 gives 60 ships per purchase
      const tier4Price = parseEther("49.99");
      // Round up to ensure we get at least targetShipCount
      const purchasesNeeded = Math.ceil(
        Number(targetShipCount) / Number(tier4ShipsPerPurchase),
      ); // 167 purchases (167 * 60 = 10020)

      const initialShipCount = await ships.read.shipCount();

      // Purchase tier 4 ships until we reach at least 10,000 ships
      for (let i = 0; i < purchasesNeeded; i++) {
        const tx = await ownerShips.write.purchaseWithFlow(
          [owner.account.address, 4n, user2.account.address, 1],
          { value: tier4Price },
        );
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }

      const finalShipCount = await ships.read.shipCount();
      const expectedShipCount =
        initialShipCount +
        BigInt(purchasesNeeded * Number(tier4ShipsPerPurchase));

      expect(finalShipCount).to.equal(expectedShipCount);

      // Verify the user owns all the ships
      const shipsOwned = await ships.read.getShipIdsOwned([
        owner.account.address,
      ]);
      expect(shipsOwned.length).to.be.greaterThanOrEqual(
        Number(targetShipCount),
      );

      // Verify amountPurchased is correct
      const amountPurchased = await ships.read.amountPurchased([
        owner.account.address,
      ]);
      expect(Number(amountPurchased)).to.be.greaterThanOrEqual(
        Number(targetShipCount),
      );
    });

    it("shipsOwnedCount/shipIdOwnedAt (GR-01 pagination escape hatch) match getShipIdsOwned", async function () {
      const [owner, , user2] = await hre.viem.getWalletClients();
      const { ships, publicClient } = await loadFixture(deployShipsFixture);

      const ownerShips = await hre.viem.getContractAt("Ships", ships.address, {
        client: { wallet: owner },
      });

      const tx = await ownerShips.write.purchaseWithFlow(
        [owner.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });

      const fullList = await ships.read.getShipIdsOwned([
        owner.account.address,
      ]);
      const count = await ships.read.shipsOwnedCount([owner.account.address]);
      expect(count).to.equal(BigInt(fullList.length));

      const paged: bigint[] = [];
      for (let i = 0n; i < count; i++) {
        paged.push(
          await ships.read.shipIdOwnedAt([owner.account.address, i]),
        );
      }
      // EnumerableSet iteration order is consistent between .values() and
      // .at(i) for the same underlying set with no intervening writes, so
      // paging one-at-a-time must reconstruct the exact same list.
      expect(paged.map(String).sort()).to.deep.equal(
        fullList.map(String).sort(),
      );
    });

    it("Should purchase 1,000 ships", async function () {
      const [owner, user1, user2] = await hre.viem.getWalletClients();
      const { ships, publicClient } = await loadFixture(deployShipsFixture);

      // Use owner account which has more funds (default Hardhat account has 10000 ETH)
      const ownerShips = await hre.viem.getContractAt("Ships", ships.address, {
        client: { wallet: owner },
      });

      const targetShipCount = 1000n;
      const tier4ShipsPerPurchase = 60n; // Tier 4 gives 60 ships per purchase
      const tier4Price = parseEther("49.99");
      // Round up to ensure we get at least targetShipCount
      const purchasesNeeded = Math.ceil(
        Number(targetShipCount) / Number(tier4ShipsPerPurchase),
      ); // 17 purchases (17 * 60 = 1020)

      const initialShipCount = await ships.read.shipCount();

      // Purchase tier 4 ships until we reach at least 1,000 ships
      for (let i = 0; i < purchasesNeeded; i++) {
        const tx = await ownerShips.write.purchaseWithFlow(
          [owner.account.address, 4n, user2.account.address, 1],
          { value: tier4Price },
        );
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }

      const finalShipCount = await ships.read.shipCount();
      const expectedShipCount =
        initialShipCount +
        BigInt(purchasesNeeded * Number(tier4ShipsPerPurchase));

      expect(finalShipCount).to.equal(expectedShipCount);

      // Verify the user owns all the ships
      const shipsOwned = await ships.read.getShipIdsOwned([
        owner.account.address,
      ]);
      expect(shipsOwned.length).to.be.greaterThanOrEqual(
        Number(targetShipCount),
      );

      // Verify amountPurchased is correct
      const amountPurchased = await ships.read.amountPurchased([
        owner.account.address,
      ]);
      expect(Number(amountPurchased)).to.be.greaterThanOrEqual(
        Number(targetShipCount),
      );
    });
  });

  describe("Owner Functions", function () {
    it("Should allow owner to set purchase info", async function () {
      const { ships, owner } = await loadFixture(deployShipsFixture);

      const newShipsPerTier = [5, 10, 15];
      const newPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await ships.write.setPurchaseInfo([newShipsPerTier, newPrices]);

      const [shipsPerTier, prices] = await ships.read.getPurchaseInfo();
      expect(shipsPerTier).to.deep.equal(newShipsPerTier);
      expect(prices).to.deep.equal(newPrices);
    });

    it("Should not allow non-owner to set purchase info", async function () {
      const { ships, user1 } = await loadFixture(deployShipsFixture);

      const newShipsPerTier = [5, 10, 15];
      const newPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await expect(
        ships.write.setPurchaseInfo([newShipsPerTier, newPrices], {
          account: user1.account,
        }),
      ).to.be.rejectedWith(
        'OwnableUnauthorizedAccount("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")',
      );
    });

    it("Should allow owner to set game address", async function () {
      const { ships, owner, user1 } = await loadFixture(deployShipsFixture);

      await ships.write.setConfig([
        user1.account.address, // gameAddress
        "0x0000000000000000000000000000000000000000", // lobbyAddress
        "0x0000000000000000000000000000000000000000", // fleetsAddress
        "0x0000000000000000000000000000000000000000", // shipGenerator
        "0x0000000000000000000000000000000000000000", // randomManager
        "0x0000000000000000000000000000000000000000", // metadataRenderer
        "0x0000000000000000000000000000000000000000", // shipAttributes
        "0x0000000000000000000000000000000000000000", // universalCredits
        "0x0000000000000000000000000000000000000000", // droneEnergyCores
        "0x0000000000000000000000000000000000000000", // purchaseGate
      ]);

      const config = await ships.read.config();
      expect(config[0].toString().toLowerCase()).to.equal(
        user1.account.address.toLowerCase(),
      );
    });

    it("Should emit an ERC-4906 BatchMetadataUpdate for every token on setConfig", async function () {
      const { ships, publicClient } = await loadFixture(deployShipsFixture);
      const zero = "0x0000000000000000000000000000000000000000";

      const hash = await ships.write.setConfig([
        zero, zero, zero, zero, zero, zero, zero, zero, zero, zero,
      ]);
      await publicClient.waitForTransactionReceipt({ hash });

      const events = await ships.getEvents.BatchMetadataUpdate();
      expect(events.length).to.equal(1);
      expect(events[0].args._fromTokenId).to.equal(0n);
      expect(events[0].args._toTokenId).to.equal(maxUint256);
    });

    it("Should allow owner to set paused state", async function () {
      const { ships, owner } = await loadFixture(deployShipsFixture);

      await ships.write.setPaused([true]);
      const paused = await ships.read.paused();
      expect(paused).to.be.true;
    });
  });

  describe("Referral System", function () {
    it("Should process referral payment correctly", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await publicClient.getBalance({
        address: user2.account.address,
      });

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const finalBalance = await publicClient.getBalance({
        address: user2.account.address,
      });

      // Check that referral received 0% (below 1000 ships threshold)
      expect(finalBalance - initialBalance).to.equal(0n);

      // Check that referral count increased by 5 ships
      const referralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(5n);
    });

    it("Should process referral payment correctly for tier 0", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await publicClient.getBalance({
        address: user2.account.address,
      });

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const finalBalance = await publicClient.getBalance({
        address: user2.account.address,
      });

      // Check that referral received 0% (below 1000 ships threshold)
      expect(finalBalance - initialBalance).to.equal(0n);

      // Check that referral count increased by 5 ships
      const referralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(5n);
    });

    it("Should update referral count correctly", async function () {
      const { ships, user1, user2 } = await loadFixture(deployShipsFixture);

      // Purchase tier 1 (5 ships)
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Check referral count is 5
      let referralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(5n);

      // Purchase another tier 1
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Check referral count is now 10 (5 + 5)
      referralCount = await ships.read.referralCount([user2.account.address]);
      expect(referralCount).to.equal(10n);
    });
  });

  describe("Ship Construction", function () {
    it("Should allow owner to construct their ship", async function () {
      const { ships, user1, user2, publicClient, randomManager } =
        await loadFixture(deployShipsFixture);

      // Mint a ship first
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get the ship's serial number
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber; // traits is at index 3

      // Fulfill the random request
      await randomManager.write.revealRandomness([serialNumber]);

      // Construct the ship
      await ships.write.constructShip([1n], {
        account: user1.account,
      });

      // Get the ship data
      const constructedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const constructedShip = tupleToShip(constructedShipTuple);

      // Verify construction
      expect(constructedShip.shipData.constructed).to.be.true; // shipData is at index 5
      expect(constructedShip.name).to.equal("Mock Ship"); // name is at index 0
      expect(constructedShip.shipData.costsVersion).to.equal(1); // shipData.costsVersion
      expect(constructedShip.shipData.cost).to.be.greaterThan(0); // shipData.cost
    });

    it("Should allow owner to construct all tier 4 ships at once", async function () {
      const { ships, user1, user2, publicClient, randomManager } =
        await loadFixture(deployShipsFixture);

      // Purchase tier 4 (60 ships)
      await ships.write.purchaseWithFlow(
        [user1.account.address, 4n, user2.account.address, 1],
        { value: parseEther("49.99") },
      );

      // Get all ships' serial numbers and fulfill random requests
      for (let i = 1; i <= 60; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber; // traits is at index 3
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships at once using constructAllMyShips
      await ships.write.constructAllMyShips({
        account: user1.account,
      });

      // Verify all ships are constructed
      for (let i = 1; i <= 60; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.constructed).to.be.true; // shipData is at index 5
        expect(ship.name).to.equal("Mock Ship"); // name is at index 0
        expect(ship.shipData.costsVersion).to.equal(1); // shipData.costsVersion
        expect(ship.shipData.cost).to.be.greaterThan(0); // shipData.cost
      }
    });

    it("Should allow owner to construct multiple ships at once", async function () {
      const { ships, user1, user2, publicClient, randomManager } =
        await loadFixture(deployShipsFixture);

      // Purchase tier 1 (5 ships)
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get all ships' serial numbers
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        const serialNumber = ship.traits.serialNumber; // traits is at index 3
        await randomManager.write.revealRandomness([serialNumber]);
      }

      // Construct all ships at once
      const shipIds = Array.from({ length: 5 }, (_, i) => BigInt(i + 1));
      await ships.write.constructShips([shipIds], {
        account: user1.account,
      });

      // Verify all ships are constructed
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.constructed).to.be.true; // shipData is at index 5
        expect(ship.name).to.equal("Mock Ship"); // name is at index 0
        expect(ship.shipData.costsVersion).to.equal(1); // shipData.costsVersion
        expect(ship.shipData.cost).to.be.greaterThan(0); // shipData.cost
      }
    });

    it("Should not allow non-owner to construct ship", async function () {
      const { ships, user1, user2, randomManager } =
        await loadFixture(deployShipsFixture);

      // Mint a ship first
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get the ship's serial number
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber; // traits is at index 3

      // Fulfill the random request
      await randomManager.write.revealRandomness([serialNumber]);

      // Try to construct as non-owner
      await expect(
        ships.write.constructShip([1n], {
          account: user2.account,
        }),
      ).to.be.rejectedWith("NotYourShip");
    });

    it("Should not allow constructing an already constructed ship", async function () {
      const { ships, user1, user2, randomManager } =
        await loadFixture(deployShipsFixture);

      // Mint a ship first
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get the ship's serial number
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber; // traits is at index 3

      // Fulfill the random request
      await randomManager.write.revealRandomness([serialNumber]);

      // Construct the ship
      await ships.write.constructShip([1n], {
        account: user1.account,
      });

      // Try to construct again
      await expect(
        ships.write.constructShip([1n], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("ShipConstructed");
    });
  });

  describe("Token URI", function () {
    it("Should return valid metadata for a constructed ship", async function () {
      const { ships, user1, user2, publicClient, randomManager } =
        await loadFixture(deployShipsFixture);

      // Mint and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      // Get the ship's serial number
      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber; // traits is at index 3

      // Fulfill the random request
      await randomManager.write.revealRandomness([serialNumber]);

      await ships.write.constructShip([1n], {
        account: user1.account,
      });

      // Get the token URI
      const tokenURI = await ships.read.tokenURI([1n]);

      // Verify it's a base64 encoded data URI
      expect(tokenURI).to.match(/^data:application\/json;base64,/);

      // Decode the base64 content
      const base64Content = tokenURI.replace(
        "data:application/json;base64,",
        "",
      );
      const decodedContent = Buffer.from(base64Content, "base64").toString();
      const metadata = JSON.parse(decodedContent);

      // Verify basic metadata structure
      expect(metadata).to.have.property("name");
      expect(metadata).to.have.property("description");
      expect(metadata).to.have.property("attributes").that.is.an("array");
      expect(metadata).to.have.property("image").that.is.a("string");

      // Decode the image
      const image = metadata.image;
      const imageContent = image.replace("data:image/svg+xml;base64,", "");
      const decodedImage = Buffer.from(imageContent, "base64").toString();
      const svgString = decodedImage;

      // Verify the SVG string is valid
      // Log if the ship is shiny according to the metadata
      // console.log(
      //   "SHIP SHINY STATUS:",
      //   metadata.attributes.find(
      //     (attr: { trait_type: string; value: string | number | boolean }) =>
      //       attr.trait_type === "Shiny"
      //   )?.value
      // );

      // console.log(svgString);

      // Verify name format
      expect(metadata.name).to.match(/^Mock Ship #1$/);

      // Verify description
      expect(metadata.description).to.equal(
        "A unique spaceship in the Void Tactics universe. Each ship has unique traits, equipment, and stats that determine its capabilities in battle.",
      );

      // Verify image format - should now be a base64 encoded SVG
      expect(metadata.image).to.match(/^data:image\/svg\+xml;base64,/);

      // Verify attributes structure
      const attributes = metadata.attributes;
      expect(attributes).to.be.an("array");

      // Create a map of attributes for easier verification
      const attributeMap = new Map(
        attributes.map(
          (attr: { trait_type: string; value: string | number | boolean }) => [
            attr.trait_type,
            attr.value,
          ],
        ),
      );

      // Verify required traits
      expect(attributeMap.has("Serial Number")).to.be.true;
      expect(attributeMap.has("Variant")).to.be.true;
      expect(attributeMap.has("Accuracy")).to.be.true;
      expect(attributeMap.has("Hull")).to.be.true;
      expect(attributeMap.has("Speed")).to.be.true;
      expect(attributeMap.has("Shiny")).to.be.true;
      expect(attributeMap.has("Ships Destroyed")).to.be.true;
      expect(attributeMap.has("Cost")).to.be.true;
      expect(attributeMap.has("Modified")).to.be.true;
      expect(attributeMap.get("Modified")).to.equal("No");

      // Verify equipment traits
      expect(attributeMap.has("Main Weapon")).to.be.true;
      expect(attributeMap.has("Armor")).to.be.true;
      expect(attributeMap.has("Shields")).to.be.true;
      expect(attributeMap.has("Special")).to.be.true;

      // Verify numeric values are actually numbers
      expect(Number(attributeMap.get("Accuracy"))).to.not.be.NaN;
      expect(Number(attributeMap.get("Hull"))).to.not.be.NaN;
      expect(Number(attributeMap.get("Speed"))).to.not.be.NaN;
      expect(Number(attributeMap.get("Ships Destroyed"))).to.not.be.NaN;
      expect(Number(attributeMap.get("Cost"))).to.not.be.NaN;

      // Verify boolean values
      const shinyValue = attributeMap.get("Shiny");
      expect(shinyValue).to.be.oneOf(["Yes", "No"]);

      // Verify equipment values are strings
      expect(attributeMap.get("Main Weapon")).to.be.a("string");
      expect(attributeMap.get("Armor")).to.be.a("string");
      expect(attributeMap.get("Shields")).to.be.a("string");
      expect(attributeMap.get("Special")).to.be.a("string");
    });

    it("Should show variant 2's own weapon/special names, distinct from variant 1's", async function () {
      const { ships, owner, user1 } = await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: owner.account,
      });

      const variant2Ship = {
        name: "Variant 2 Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0, // Generic -> "Medium Mining Laser" for variant 2
          armor: 0,
          shields: 0,
          special: 1, // LighteningField (variant 2's slot 1)
        },
        traits: {
          serialNumber: 999n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 2,
          accuracy: 0,
          hull: 0,
          speed: 0,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: false,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      await ships.write.customizeShip([1n, variant2Ship], {
        account: owner.account,
      });

      const tokenURI = await ships.read.tokenURI([1n]);
      const base64Content = tokenURI.replace(
        "data:application/json;base64,",
        "",
      );
      const decodedContent = Buffer.from(base64Content, "base64").toString();
      const metadata = JSON.parse(decodedContent);
      const attributeMap = new Map(
        metadata.attributes.map(
          (attr: { trait_type: string; value: string | number | boolean }) => [
            attr.trait_type,
            attr.value,
          ],
        ),
      );

      expect(attributeMap.get("Main Weapon")).to.equal("Medium Mining Laser");
      expect(attributeMap.get("Special")).to.equal("Lightening Field");
    });

    it("Should show 'Unknown' for a special name never set for that (variant, slot) pair", async function () {
      const { ships, owner, user1 } = await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: owner.account,
      });

      // Names are keyed by (variant, slot). Slot 4 is unused by both
      // factions (variant 2's specials are its slots 1-3), so a variant-1
      // ship equipped with slot 4 has no configured name for
      // (variant 1, slot 4).
      const variant1SlotFourShip = {
        name: "Variant 1 Slot 4 Ship",
        id: 1n,
        equipment: {
          mainWeapon: 0,
          armor: 0,
          shields: 0,
          special: 4,
        },
        traits: {
          serialNumber: 999n,
          colors: {
            h1: 0,
            s1: 0,
            l1: 0,
            h2: 0,
            s2: 0,
            l2: 0,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 0,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: false,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      await ships.write.customizeShip([1n, variant1SlotFourShip], {
        account: owner.account,
      });

      const tokenURI = await ships.read.tokenURI([1n]);
      const base64Content = tokenURI.replace(
        "data:application/json;base64,",
        "",
      );
      const decodedContent = Buffer.from(base64Content, "base64").toString();
      const metadata = JSON.parse(decodedContent);
      const attributeMap = new Map(
        metadata.attributes.map(
          (attr: { trait_type: string; value: string | number | boolean }) => [
            attr.trait_type,
            attr.value,
          ],
        ),
      );

      expect(attributeMap.get("Special")).to.equal("Unknown");
    });

    it("Should not allow non-owner to set a special name", async function () {
      const { metadataRenderer, user1 } = await loadFixture(deployShipsFixture);

      await expect(
        metadataRenderer.write.setSpecialName([1, 1, "Not Allowed"], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should reflect modified flag changes in metadata", async function () {
      const { ships, owner, user1 } = await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );

      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: owner.account,
      });

      const specificShip = {
        name: "Modified Ship",
        id: 1n,
        equipment: {
          mainWeapon: 1,
          armor: 2,
          shields: 3,
          special: 1,
        },
        traits: {
          serialNumber: 999n,
          colors: {
            h1: 10,
            s1: 20,
            l1: 30,
            h2: 40,
            s2: 50,
            l2: 60,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 2,
          hull: 2,
          speed: 2,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: false,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      await ships.write.customizeShip([1n, specificShip], {
        account: owner.account,
      });

      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.shipData.modified).to.not.equal(0);

      const tokenURI = await ships.read.tokenURI([1n]);
      const base64Content = tokenURI.replace(
        "data:application/json;base64,",
        "",
      );
      const decodedContent = Buffer.from(base64Content, "base64").toString();
      const metadata = JSON.parse(decodedContent);
      const attributes = metadata.attributes;
      const attributeMap = new Map(
        attributes.map(
          (attr: { trait_type: string; value: string | number | boolean }) => [
            attr.trait_type,
            attr.value,
          ],
        ),
      );
      expect(attributeMap.get("Modified")).to.equal("Yes");
    });

    it("Should revert for non-existent token", async function () {
      const { ships } = await loadFixture(deployShipsFixture);

      await expect(ships.read.tokenURI([999n])).to.be.rejectedWith("InvalidId");
    });
  });

  describe("Ownership Changes", function () {
    it("Should not allow transfer without purchasing a tier", async function () {
      const { ships, user1, user2, user3 } =
        await loadFixture(deployShipsFixture);

      // Verify user1 has not purchased enough ships to transfer initially
      const amountPurchased = await ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchased)).to.be.lessThan(10);

      // Mint ships to user1 using tier 1 (which gives 11 ships, enough to transfer)
      await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Verify user1 has now purchased enough ships to transfer (since they purchased tier 1)
      const amountPurchasedAfter = await ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchasedAfter)).to.be.greaterThanOrEqual(10);

      // Try to transfer without purchasing a tier for user3
      await expect(
        ships.write.transferFrom(
          [user1.account.address, user3.account.address, 1],
          { account: user1.account },
        ),
      ).to.be.rejectedWith("InsufficientPurchases");
    });

    it("Should allow owner to transfer their ship after purchasing a tier", async function () {
      const { ships, user1Ships, user2Ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading (gives 11 ships, enough to transfer)
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Mint tier 1 to user2 so they can transfer (gives 11 ships, enough to transfer)
      await user2Ships.write.purchaseWithFlow(
        [user2.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Confirm user1 has purchased enough ships to transfer
      const amountPurchased1 = await user1Ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchased1)).to.be.greaterThanOrEqual(10);

      // Confirm user2 has purchased enough ships to transfer
      const amountPurchased2 = await user2Ships.read.amountPurchased([
        user2.account.address,
      ]);
      expect(Number(amountPurchased2)).to.be.greaterThanOrEqual(10);

      // Transfer the ship from user1 to user2
      await user1Ships.write.transferFrom([
        user1.account.address,
        user2.account.address,
        1n,
      ]);

      // Verify new owner
      const newOwner = await ships.read.ownerOf([1n]);
      expect(newOwner.toString().toLocaleLowerCase()).to.equal(
        user2.account.address.toLocaleLowerCase(),
      );
    });

    it("Should allow approved address to transfer ship after purchasing a tier", async function () {
      const {
        ships,
        user1Ships,
        user2Ships,
        user3Ships,
        user1,
        user2,
        user3,
        publicClient,
      } = await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading for user1 (the owner) - gives 11 ships
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Purchase tier 1 for user3 (the receiver) - gives 11 ships
      await user3Ships.write.purchaseWithFlow(
        [user3.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Confirm user1 has purchased enough ships to transfer
      const amountPurchased1 = await user1Ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchased1)).to.be.greaterThanOrEqual(10);

      // Confirm user3 has purchased enough ships to receive
      const amountPurchased3 = await user3Ships.read.amountPurchased([
        user3.account.address,
      ]);
      expect(Number(amountPurchased3)).to.be.greaterThanOrEqual(10);

      // User1 approves user2 to transfer their ship
      await user1Ships.write.approve([user2.account.address, 1]);

      // User2 transfers the ship to user3
      await user2Ships.write.transferFrom([
        user1.account.address,
        user3.account.address,
        1n,
      ]);

      // Verify new owner
      const newOwner = await ships.read.ownerOf([1n]);
      expect(newOwner.toString().toLocaleLowerCase()).to.equal(
        user3.account.address.toLocaleLowerCase(),
      );
    });

    it("Should allow operator to transfer ship after purchasing a tier", async function () {
      const {
        ships,
        user1Ships,
        user2Ships,
        user3Ships,
        user1,
        user2,
        user3,
        publicClient,
      } = await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading for user1 (the owner) - gives 11 ships
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Purchase tier 1 for user3 (the receiver) - gives 11 ships
      await user3Ships.write.purchaseWithFlow(
        [user3.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Confirm user1 has purchased enough ships to transfer
      const amountPurchased1 = await user1Ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchased1)).to.be.greaterThanOrEqual(10);

      // Confirm user3 has purchased enough ships to receive
      const amountPurchased3 = await user3Ships.read.amountPurchased([
        user3.account.address,
      ]);
      expect(Number(amountPurchased3)).to.be.greaterThanOrEqual(10);

      // User1 sets user2 as operator
      await user1Ships.write.setApprovalForAll([user2.account.address, true]);

      // User2 transfers the ship to user3
      await user2Ships.write.transferFrom([
        user1.account.address,
        user3.account.address,
        1n,
      ]);

      // Verify new owner
      const newOwner = await ships.read.ownerOf([1n]);
      expect(newOwner.toString().toLocaleLowerCase()).to.equal(
        user3.account.address.toLocaleLowerCase(),
      );
    });

    it("Should not allow non-owner to transfer ship even with tier purchase", async function () {
      const {
        ships,
        user1Ships,
        user2Ships,
        user3Ships,
        user1,
        user2,
        user3,
        publicClient,
      } = await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading for user1 (the owner) - gives 11 ships
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Purchase tier 1 for user2 (the non-owner) - gives 11 ships
      await user2Ships.write.purchaseWithFlow(
        [user2.account.address, 1n, user1.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Purchase tier 1 for user3 (the receiver) - gives 11 ships
      await user3Ships.write.purchaseWithFlow(
        [user3.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Confirm all users have purchased enough ships to transfer
      const amountPurchased1 = await user1Ships.read.amountPurchased([
        user1.account.address,
      ]);
      const amountPurchased2 = await user2Ships.read.amountPurchased([
        user2.account.address,
      ]);
      const amountPurchased3 = await user3Ships.read.amountPurchased([
        user3.account.address,
      ]);
      expect(Number(amountPurchased1)).to.be.greaterThanOrEqual(10);
      expect(Number(amountPurchased2)).to.be.greaterThanOrEqual(10);
      expect(Number(amountPurchased3)).to.be.greaterThanOrEqual(10);

      // Try to transfer as non-owner
      await expect(
        user2Ships.write.transferFrom([
          user1.account.address,
          user3.account.address,
          1n,
        ]),
      ).to.be.rejectedWith("ERC721InsufficientApproval");
    });

    it("Should not allow transfer of destroyed ship even with tier purchase", async function () {
      const { ships, user1, user2, owner, publicClient } =
        await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading - gives 11 ships
      await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Note: The first purchase already gives 11 ships, no need for a second purchase

      // Destroy the ship (simulate by setting timestampDestroyed)
      await ships.write.markDestroyed([1n], {
        account: owner.account,
      });

      // Try to transfer destroyed ship
      await expect(
        ships.write.transferFrom(
          [user1.account.address, user2.account.address, 1],
          { account: user1.account },
        ),
      ).to.be.rejectedWith("ShipDestroyed");
    });

    it("Should update shipsOwned mapping on transfer after tier purchase", async function () {
      const { ships, user1Ships, user2Ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading for user1 (the owner) - gives 11 ships
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Purchase tier 1 for user2 (the receiver) - gives 11 ships
      await user2Ships.write.purchaseWithFlow(
        [user2.account.address, 1n, user1.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Confirm both users have purchased enough ships to transfer
      const amountPurchased1 = await user1Ships.read.amountPurchased([
        user1.account.address,
      ]);
      const amountPurchased2 = await user2Ships.read.amountPurchased([
        user2.account.address,
      ]);
      expect(Number(amountPurchased1)).to.be.greaterThanOrEqual(10);
      expect(Number(amountPurchased2)).to.be.greaterThanOrEqual(10);

      // Verify initial state
      const initialUser1Ships = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      expect(initialUser1Ships.length).to.equal(11); // 11 from tier 1

      // Transfer the ship
      const tx = await user1Ships.write.transferFrom([
        user1.account.address,
        user2.account.address,
        1n,
      ]);

      // Wait for the transaction to be mined
      await publicClient.waitForTransactionReceipt({ hash: tx });

      // Check shipsOwned mapping
      const user1ShipsList = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      const user2ShipsList = await ships.read.getShipIdsOwned([
        user2.account.address,
      ]);

      // Verify the ship is only in user2's list after transfer
      expect(user1ShipsList.length).to.equal(10); // Should have 10 ships left
      expect(user2ShipsList.length).to.equal(12); // Should have 11 from tier 1 + 1 transferred
      expect(user2ShipsList[11]).to.equal(1n); // The transferred ship should be id 1

      // Verify the actual owner is user2
      const owner = await ships.read.ownerOf([1n]);
      expect(owner.toString().toLocaleLowerCase()).to.equal(
        user2.account.address.toLocaleLowerCase(),
      );
    });

    it("Should allow owner to approve and revoke approval after tier purchase", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading - gives 11 ships
      await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Note: The first purchase already gives 11 ships, no need for a second purchase

      // Approve user2
      await ships.write.approve([user2.account.address, 1], {
        account: user1.account,
      });

      // Verify approval
      const approved = await ships.read.getApproved([1n]);
      expect(approved.toString().toLocaleLowerCase()).to.equal(
        user2.account.address.toLocaleLowerCase(),
      );

      // Revoke approval
      await ships.write.approve(
        ["0x0000000000000000000000000000000000000000", 1],
        { account: user1.account },
      );

      // Verify approval revoked
      const newApproved = await ships.read.getApproved([1n]);
      expect(newApproved).to.equal(
        "0x0000000000000000000000000000000000000000",
      );
    });

    it("Should allow owner to set and revoke operator after tier purchase", async function () {
      const { ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      // First purchase tier 1 to enable trading - gives 11 ships
      await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Note: The first purchase already gives 11 ships, no need for a second purchase

      // Set user2 as operator
      await ships.write.setApprovalForAll([user2.account.address, true], {
        account: user1.account,
      });

      // Verify operator status
      const isOperator = await ships.read.isApprovedForAll([
        user1.account.address,
        user2.account.address,
      ]);
      expect(isOperator).to.be.true;

      // Revoke operator status
      await ships.write.setApprovalForAll([user2.account.address, false], {
        account: user1.account,
      });

      // Verify operator status revoked
      const isOperatorAfter = await ships.read.isApprovedForAll([
        user1.account.address,
        user2.account.address,
      ]);
      expect(isOperatorAfter).to.be.false;
    });
  });

  describe("Ship Creation", function () {
    it("Should allow authorized address to create ships", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // Authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create 3 ships for user1
      await ships.write.createShips([user1.account.address, 3n, 1, 0, false], {
        account: user1.account,
      });

      // Verify ships were created
      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(3n);

      // Verify all ships are owned by user1
      for (let i = 1; i <= 3; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }
    });

    it("Should not allow unauthorized address to create ships", async function () {
      const { ships, user1, user2 } = await loadFixture(deployShipsFixture);

      // Try to create ships without authorization
      await expect(
        ships.write.createShips([user1.account.address, 3n, 1, 0, false], {
          account: user2.account,
        }),
      ).to.be.rejectedWith("NotAuthorized");
    });

    it("Should allow creating multiple ships in one transaction", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // Authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create 10 ships for user1
      await ships.write.createShips([user1.account.address, 10n, 1, 0, false], {
        account: user1.account,
      });

      // Verify ships were created
      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(10n);

      // Verify all ships are owned by user1
      for (let i = 1; i <= 10; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }
    });

    it("Should allow owner to create ships for any address", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create 5 ships for user1 using owner account
      await ships.write.createShips([user1.account.address, 5n, 1, 0, false], {
        account: user1.account,
      });

      // Verify ships were created
      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(5n);

      // Verify all ships are owned by user1
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }
    });

    it("Should update shipsOwned mapping correctly", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create 3 ships for user1
      await ships.write.createShips([user1.account.address, 3n, 1, 0, false], {
        account: user1.account,
      });

      // Verify shipsOwned mapping
      const user1Ships = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      expect(user1Ships.length).to.equal(3);
      expect(user1Ships[0]).to.equal(1n);
      expect(user1Ships[1]).to.equal(2n);
      expect(user1Ships[2]).to.equal(3n);
    });
  });

  describe("Variant Purchase Gate", function () {
    it("Should reject minting a variant-2 ship without the Shattered Hive medal", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        { account: owner.account },
      );

      await expect(
        ships.write.createShips([user1.account.address, 1n, 2, 0, false], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("GateRequirementNotMet");
    });

    it("Should allow minting a variant-2 ship once the recipient holds the medal", async function () {
      const { ships, shatteredHiveMedal, user1, owner } =
        await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        { account: owner.account },
      );

      await shatteredHiveMedal.write.ownerMint([user1.account.address], {
        account: owner.account,
      });

      await ships.write.createShips([user1.account.address, 1n, 2, 0, false], {
        account: user1.account,
      });

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      expect(ship.traits.variant).to.equal(2);
    });

    it("Should not require the medal for variant-1 ships", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        { account: owner.account },
      );

      await ships.write.createShips([user1.account.address, 1n, 1, 0, false], {
        account: user1.account,
      });

      const shipCount = await ships.read.shipCount();
      expect(shipCount).to.equal(1n);
    });
  });

  describe("Specific Ship Construction", function () {
    it("Should allow authorized address to construct a specific ship", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create a ship first
      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: user1.account,
      });

      const initialShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const initialShip = tupleToShip(initialShipTuple);
      const originalSerialNumber = initialShip.traits.serialNumber;

      // Create a specific ship configuration
      const specificShip = {
        name: "Custom Ship",
        id: 1n,
        equipment: {
          mainWeapon: 2,
          armor: 2,
          shields: 2,
          special: 2,
        },
        traits: {
          serialNumber: 123n,
          colors: {
            h1: 200,
            s1: 40,
            l1: 47,
            h2: 180,
            s2: 50,
            l2: 60,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 2,
          hull: 2,
          speed: 2,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: true,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      // Construct the specific ship
      await ships.write.customizeShip([1n, specificShip], {
        account: user1.account,
      });

      // Verify the ship was constructed with the specific attributes
      const constructedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const constructedShip = tupleToShip(constructedShipTuple);
      expect(constructedShip.name).to.equal("Custom Ship"); // name
      expect(constructedShip.traits.serialNumber).to.equal(
        originalSerialNumber,
      ); // serial number preserved
      expect(constructedShip.traits.variant).to.equal(1); // traits.variant
      expect(constructedShip.traits.accuracy).to.equal(2); // traits.accuracy
      expect(constructedShip.traits.hull).to.equal(2); // traits.hull
      expect(constructedShip.traits.speed).to.equal(2); // traits.speed
      expect(constructedShip.equipment.mainWeapon).to.equal(2); // equipment.mainWeapon
      expect(constructedShip.equipment.armor).to.equal(2); // equipment.armor
      expect(constructedShip.equipment.shields).to.equal(2); // equipment.shields
      expect(constructedShip.equipment.special).to.equal(2); // equipment.special
      expect(constructedShip.shipData.constructed).to.be.true; // shipData.constructed
      expect(constructedShip.shipData.shiny).to.be.true; // shipData.shiny
      expect(constructedShip.shipData.modified).to.not.equal(0); // shipData.modified
    });

    it("Should not allow unauthorized address to construct a specific ship", async function () {
      const { ships, user1, user2, owner } =
        await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create a ship first
      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: user1.account,
      });

      // Create a specific ship configuration
      const specificShip = {
        name: "Custom Ship",
        id: 1n,
        equipment: {
          mainWeapon: 2,
          armor: 2,
          shields: 2,
          special: 2,
        },
        traits: {
          serialNumber: 123n,
          colors: {
            h1: 200,
            s1: 40,
            l1: 47,
            h2: 180,
            s2: 50,
            l2: 60,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 2,
          hull: 2,
          speed: 2,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: true,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      // Try to construct the specific ship as unauthorized user2
      await expect(
        ships.write.customizeShip([1n, specificShip], {
          account: user2.account,
        }),
      ).to.be.rejectedWith("NotAuthorized");
    });

    it("Should not allow constructing an already constructed ship", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create a ship first
      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: user1.account,
      });

      // Create a specific ship configuration
      const specificShip = {
        name: "Custom Ship",
        id: 1n,
        equipment: {
          mainWeapon: 2,
          armor: 2,
          shields: 2,
          special: 2,
        },
        traits: {
          serialNumber: 123n,
          colors: {
            h1: 200,
            s1: 40,
            l1: 47,
            h2: 180,
            s2: 50,
            l2: 60,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 2,
          hull: 2,
          speed: 2,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: true,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      // Construct the specific ship
      await ships.write.customizeShip([1n, specificShip], {
        account: user1.account,
      });

      const afterFirstCustomizeTuple = (await ships.read.ships([
        1n,
      ])) as ShipTuple;
      const afterFirstCustomize = tupleToShip(afterFirstCustomizeTuple);
      const firstModifiedCount = afterFirstCustomize.shipData.modified;

      // Update the configuration to simulate a modification
      const updatedShipConfig = {
        ...specificShip,
        name: "Custom Ship MkII",
        traits: {
          ...specificShip.traits,
          accuracy: 1,
        },
        shipData: {
          ...specificShip.shipData,
          modified: firstModifiedCount,
        },
      };

      // Customize the already constructed ship again
      await ships.write.customizeShip([1n, updatedShipConfig], {
        account: user1.account,
      });

      const afterSecondCustomizeTuple = (await ships.read.ships([
        1n,
      ])) as ShipTuple;
      const afterSecondCustomize = tupleToShip(afterSecondCustomizeTuple);

      expect(afterSecondCustomize.shipData.constructed).to.be.true;
      expect(afterSecondCustomize.shipData.modified).to.be.above(
        firstModifiedCount,
      );
      expect(afterSecondCustomize.name).to.equal("Custom Ship MkII");
    });

    it("Should update ship cost after construction", async function () {
      const { ships, user1, owner } = await loadFixture(deployShipsFixture);

      // First authorize user1 to create ships
      await ships.write.setIsAllowedToCreateShips(
        [user1.account.address, true],
        {
          account: owner.account,
        },
      );

      // Create a ship first
      await ships.write.createShips([user1.account.address, 1, 1, 0, false], {
        account: user1.account,
      });

      // Create a specific ship configuration
      const specificShip = {
        name: "Custom Ship",
        id: 1n,
        equipment: {
          mainWeapon: 2,
          armor: 2,
          shields: 2,
          special: 2,
        },
        traits: {
          serialNumber: 123n,
          colors: {
            h1: 200,
            s1: 40,
            l1: 47,
            h2: 180,
            s2: 50,
            l2: 60,
            h3: 0,
            s3: 0,
            l3: 0,
          },
          variant: 1,
          accuracy: 2,
          hull: 2,
          speed: 2,
        },
        shipData: {
          constructed: false,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
          shiny: true,
          shipsDestroyed: 0,
          costsVersion: 1,
          cost: 0,
        },
        owner: user1.account.address,
      };

      // Construct the specific ship
      await ships.write.customizeShip([1n, specificShip], {
        account: user1.account,
      });

      // Verify the ship cost was updated
      const constructedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const constructedShip = tupleToShip(constructedShipTuple);
      expect(constructedShip.shipData.cost).to.be.greaterThan(0); // shipData.cost should be set
    });
  });

  describe("Token-based Purchasing", function () {
    it("Should purchase tier 0 with UC tokens", async function () {
      const {
        ships,
        user1,
        user2,
        universalCredits,
        shipPurchaser,
        user1Purchaser,
      } = await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await user1Purchaser.write.purchaseWithUC([
        user1.account.address,
        0n,
        user2.account.address,
        1,
      ]);

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const shipCount = await ships.read.shipCount();

      // Check that 4.99 UC tokens were spent
      expect(initialBalance - finalBalance).to.equal(parseEther("4.99"));
      // Check that 5 ships were minted
      expect(shipCount).to.equal(5n);

      // Check all ships are owned by user1
      for (let i = 1; i <= 5; i++) {
        const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }
    });

    it("Should process referral payment correctly with UC tokens", async function () {
      const {
        user1,
        user2,
        universalCredits,
        user1Purchaser,
        user2UC,
        shipPurchaser,
      } = await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user2.account.address,
      ]);

      await user1Purchaser.write.purchaseWithUC([
        user1.account.address,
        0n,
        user2.account.address,
        1,
      ]);

      const finalBalance = await universalCredits.read.balanceOf([
        user2.account.address,
      ]);

      // Check that referral received 0% (below 1000 ships threshold)
      expect(finalBalance - initialBalance).to.equal(0n);

      // Check referral count
      const referralCount = await shipPurchaser.read.referralCount([
        user2.account.address,
      ]);
      expect(referralCount).to.equal(5n);
    });

    it("Should revert with insufficient UC balance", async function () {
      const { user1, user2, universalCredits, user1Purchaser } =
        await loadFixture(deployShipsFixture);

      // Burn all UC tokens from user1
      await universalCredits.write.transfer(
        ["0x000000000000000000000000000000000000dEaD", parseEther("1000")],
        {
          account: user1.account,
        },
      );

      await expect(
        user1Purchaser.write.purchaseWithUC([
          user1.account.address,
          0n,
          user2.account.address,
          1,
        ]),
      ).to.be.rejectedWith("InsufficientFunds");
    });

    it("Should retain full UC when referral is zero address", async function () {
      const { user1, user1Purchaser, universalCredits, shipPurchaser } =
        await loadFixture(deployShipsFixture);

      const price = parseEther("4.99");
      const initialPurchaserUC = await universalCredits.read.balanceOf([
        shipPurchaser.address,
      ]);

      await user1Purchaser.write.purchaseWithUC([
        user1.account.address,
        0n,
        "0x0000000000000000000000000000000000000000",
        1,
      ]);

      const finalPurchaserUC = await universalCredits.read.balanceOf([
        shipPurchaser.address,
      ]);
      expect(finalPurchaserUC - initialPurchaserUC).to.equal(price);
    });

    it("Should allow owner to update purchase info", async function () {
      const { shipPurchaser, owner } = await loadFixture(deployShipsFixture);

      const newShipsPerTier = [5, 10, 15];
      const newPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await shipPurchaser.write.setPurchaseInfo([newShipsPerTier, newPrices], {
        account: owner.account,
      });

      const [shipsPerTier, prices] = await shipPurchaser.read.getPurchaseInfo();
      expect(shipsPerTier).to.deep.equal(newShipsPerTier);
      expect(prices).to.deep.equal(newPrices);
    });

    it("Should not allow non-owner to update purchase info", async function () {
      const { shipPurchaser, user1 } = await loadFixture(deployShipsFixture);

      const updatedShipsPerTier = [5, 10, 15];
      const updatedPrices = [
        parseEther("5.99"),
        parseEther("10.99"),
        parseEther("15.99"),
      ];

      await expect(
        shipPurchaser.write.setPurchaseInfo(
          [updatedShipsPerTier, updatedPrices],
          {
            account: user1.account,
          },
        ),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should allow owner to withdraw UC tokens", async function () {
      const { shipPurchaser, universalCredits, owner, user1 } =
        await loadFixture(deployShipsFixture);

      // Purchase some ships to get UC tokens in the contract
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 0n, owner.account.address, 1],
        {
          account: user1.account,
        },
      );

      const initialBalance = await universalCredits.read.balanceOf([
        owner.account.address,
      ]);
      await shipPurchaser.write.withdrawUC({ account: owner.account });
      const finalBalance = await universalCredits.read.balanceOf([
        owner.account.address,
      ]);

      expect(finalBalance > initialBalance).to.be.true;
    });

    it("Should not allow non-owner to withdraw UC tokens", async function () {
      const { shipPurchaser, user1 } = await loadFixture(deployShipsFixture);

      await expect(
        shipPurchaser.write.withdrawUC({ account: user1.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });
  });

  describe("Recycle System", function () {
    it("Should allow owner to update recycle reward", async function () {
      const { ships, owner } = await loadFixture(deployShipsFixture);

      // Check initial reward
      expect(await ships.read.recycleReward()).to.equal(parseEther("0.1"));

      // Update reward
      await ships.write.setRecycleReward([parseEther("0.5")], {
        account: owner.account,
      });

      // Check new reward
      expect(await ships.read.recycleReward()).to.equal(parseEther("0.5"));
    });

    it("Should not allow non-owner to update recycle reward", async function () {
      const { ships, user1 } = await loadFixture(deployShipsFixture);

      await expect(
        ships.write.setRecycleReward([parseEther("0.5")], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should allow users to recycle their ships and receive UC tokens", async function () {
      const { ships, universalCredits, user1, user2, shipPurchaser } =
        await loadFixture(deployShipsFixture);

      // Purchase some ships for user1 using tier 1 (gives 11 ships, enough to recycle)
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 1n, user2.account.address, 1],
        {
          account: user1.account,
        },
      );

      // Get initial UC balance
      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Get ship IDs owned by user1
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);

      // Recycle all ships
      await ships.write.shipBreaker([shipIds], {
        account: user1.account,
      });

      // Check final UC balance (should have received 0.1 UC per ship)
      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      expect(finalBalance - initialBalance).to.equal(
        parseEther("0.1") * BigInt(shipIds.length),
      );

      // Verify ships are no longer owned by user1
      const remainingShips = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      expect(remainingShips.length).to.equal(0);
    });

    it("Should not allow recycling ships that are in a fleet", async function () {
      const {
        ships,
        universalCredits,
        user1,
        user2,
        shipPurchaser,
        owner,
        randomManager,
        metadataRenderer,
        shipAttributes,
        generateNewShip,
      } = await loadFixture(deployShipsFixture);

      // Set up game address first - use actual deployed contracts
      // Note: The config should already be set by the deployment, but we're overriding it
      // We need to use the actual contract addresses, not zero addresses
      const currentConfig = await ships.read.config();
      await ships.write.setConfig(
        [
          owner.account.address, // gameAddress
          "0x0000000000000000000000000000000000000000", // lobbyAddress
          "0x0000000000000000000000000000000000000000", // fleetsAddress
          currentConfig[3], // shipGenerator - keep existing
          randomManager.address, // randomManager - use actual
          metadataRenderer.address, // metadataRenderer - use actual
          shipAttributes.address, // shipAttributes - use actual
          universalCredits.address, // universalCredits - use actual
          "0x0000000000000000000000000000000000000000", // droneEnergyCores
          "0x0000000000000000000000000000000000000000", // purchaseGate
        ],
        {
          account: owner.account,
        },
      );

      // Purchase some ships for user1 using tier 1 (gives 11 ships, enough to recycle)
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 1n, user2.account.address, 1],
        {
          account: user1.account,
        },
      );

      // Get ship IDs owned by user1
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);

      // Set a ship to be in fleet
      await ships.write.setInFleet([shipIds[0], true], {
        account: owner.account,
      });

      // Try to recycle ships
      await expect(
        ships.write.shipBreaker([shipIds], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("ShipInFleet");
    });

    it("rejects adding a destroyed ship to a fleet (HA2-03)", async function () {
      const {
        ships,
        universalCredits,
        user1,
        user2,
        owner,
        randomManager,
        metadataRenderer,
        shipAttributes,
      } = await loadFixture(deployShipsFixture);

      // Authorize `owner` as gameAddress so this test can call setInFleet
      // directly, same trick the "recycling ships in a fleet" test above uses.
      const currentConfig = await ships.read.config();
      await ships.write.setConfig(
        [
          owner.account.address, // gameAddress
          "0x0000000000000000000000000000000000000000", // lobbyAddress
          "0x0000000000000000000000000000000000000000", // fleetsAddress
          currentConfig[3], // shipGenerator - keep existing
          randomManager.address,
          metadataRenderer.address,
          shipAttributes.address,
          universalCredits.address,
          "0x0000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000",
        ],
        { account: owner.account },
      );

      await ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );
      const shipIds = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);

      // Simulate this ship having died in an earlier game -- the NFT is
      // never burned, user1 still owns it. Before HA2-03's fix, nothing in
      // setInFleet (or Fleets.createFleet's own validation) checked this,
      // so a destroyed ship could be resubmitted into a brand-new fleet and
      // fight normally until anyone tried to remove it there, permanently
      // reverting ShipDestroyed().
      await ships.write.markDestroyed([shipIds[0]], {
        account: owner.account,
      });

      await expect(
        ships.write.setInFleet([shipIds[0], true], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("ShipDestroyed");

      // Only the "add to fleet" direction is guarded -- removing a
      // destroyed ship (e.g. game cleanup routing it out) must still work.
      await ships.write.setInFleet([shipIds[0], false], {
        account: owner.account,
      });
    });

    it("Should not allow recycling ships owned by others", async function () {
      const { ships, universalCredits, user1, user2, shipPurchaser } =
        await loadFixture(deployShipsFixture);

      // Purchase some ships for user1 using tier 1 (gives 11 ships, enough to recycle)
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 1n, user2.account.address, 1],
        {
          account: user1.account,
        },
      );

      // Get ship IDs owned by user1
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);

      // Try to recycle ships as user2
      await expect(
        ships.write.shipBreaker([shipIds], {
          account: user2.account,
        }),
      ).to.be.rejectedWith("NotYourShip");
    });

    it("Should not allow recycling free ships", async function () {
      const { ships, universalCredits, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Claim free ships
      await freeShipClaim.write.claimFreeShips([1], { account: user1.account });

      // Get ship IDs owned by user1 (these are free ships)
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);

      // Verify ships are marked as free
      for (const shipId of shipIds) {
        const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.isFreeShip).to.equal(true);
      }

      // Try to recycle free ships - should fail
      await expect(
        ships.write.shipBreaker([shipIds], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("CannotRecycleFreeShip");
    });

    it("mints to a contract without an onERC721Received callback, so a claim can't re-enter (SP-01, HA6-04)", async function () {
      const { freeShipClaim, ships } = await loadFixture(deployShipsFixture);

      // This mock re-enters claimFreeShips from onERC721Received. Ships now
      // mints with _mint, so that callback never fires: the claim simply
      // succeeds once, and the cooldown (recorded before minting, SP-01)
      // still blocks a second claim.
      const attacker = await hre.viem.deployContract(
        "MockFreeShipClaimReentrant",
        [],
      );
      await attacker.write.setTarget([freeShipClaim.address]);

      await attacker.write.claim([1]);
      const owned = await ships.read.getShipIdsOwned([attacker.address]);
      expect(owned.length).to.be.greaterThan(0);
      // Struct owner and ERC-721 owner agree (HA6-04).
      for (const id of owned) {
        expect(getAddress(await ships.read.ownerOf([id]))).to.equal(
          getAddress(attacker.address),
        );
        expect(
          getAddress((await ships.read.getShip([id])).owner),
        ).to.equal(getAddress(attacker.address));
      }

      await expect(attacker.write.claim([1])).to.be.rejectedWith(
        "ClaimCooldownNotPassed",
      );
    });

    it("Should allow recycling purchased ships but not free ships in the same call", async function () {
      const { ships, universalCredits, user1, user2, shipPurchaser, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Claim free ships first
      await freeShipClaim.write.claimFreeShips([1], { account: user1.account });
      const freeShipIds = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);

      // Purchase some ships
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 1n, user2.account.address, 1],
        {
          account: user1.account,
        },
      );

      // Get all ship IDs (both free and purchased)
      const allShipIds = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);

      // Separate free and purchased ships
      const purchasedShipIds = allShipIds.filter(
        (id) => !freeShipIds.includes(id),
      );

      // Verify purchased ships are not marked as free
      for (const shipId of purchasedShipIds) {
        const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.isFreeShip).to.equal(false);
      }

      // Try to recycle all ships (including free ones) - should fail
      await expect(
        ships.write.shipBreaker([allShipIds], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("CannotRecycleFreeShip");

      // But should be able to recycle only purchased ships
      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await ships.write.shipBreaker([purchasedShipIds], {
        account: user1.account,
      });

      // Check UC balance increased
      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      expect(finalBalance - initialBalance).to.equal(
        parseEther("0.1") * BigInt(purchasedShipIds.length),
      );

      // Verify free ships are still owned
      const remainingShips = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      expect(remainingShips.length).to.equal(freeShipIds.length);
    });
  });

  describe("Free Ship Claiming", function () {
    it("emits FreeShipsClaimed with the claimed amount", async function () {
      const { user1, freeShipClaim } = await loadFixture(deployShipsFixture);

      const hash = await freeShipClaim.write.claimFreeShips([1], {
        account: user1.account,
      });
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const events = await freeShipClaim.getEvents.FreeShipsClaimed(
        undefined,
        { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
      );
      expect(events).to.have.length(1);
      expect(events[0].args.player?.toLowerCase()).to.equal(
        user1.account.address.toLowerCase(),
      );
      // No DroneStorefront wired in this fixture, so amount is the base 10.
      expect(events[0].args.amount).to.equal(10n);
    });

    it("deploy module wires a permissive MockAlwaysEligible by default, so claiming stays open", async function () {
      const { freeShipClaim } = await loadFixture(deployShipsFixture);

      const providerAddress = await freeShipClaim.read.eligibilityProvider();
      expect(providerAddress).to.not.equal(
        "0x0000000000000000000000000000000000000000",
      );
      const provider = await hre.viem.getContractAt(
        "MockAlwaysEligible",
        providerAddress,
      );
      expect(await provider.read.isEligible([providerAddress])).to.equal(
        true,
      );
      // Already exercised by every other test in this block succeeding
      // against the real, unmocked FreeShipClaim.claimFreeShips path.
    });

    it("an explicitly unset eligibilityProvider (address zero) also stays open", async function () {
      const { owner, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      await freeShipClaim.write.setEligibilityProvider(
        ["0x0000000000000000000000000000000000000000"],
        { account: owner.account },
      );
      const asUser1 = await hre.viem.getContractAt(
        "FreeShipClaim",
        freeShipClaim.address,
        { client: { wallet: user1 } },
      );
      await asUser1.write.claimFreeShips([1]);
    });

    it("only the owner can set eligibilityProvider", async function () {
      const { freeShipClaim, user1 } = await loadFixture(deployShipsFixture);

      const provider = await hre.viem.deployContract(
        "SelfieCheckEligibilityProvider",
        [user1.account.address],
      );
      const asUser1 = await hre.viem.getContractAt(
        "FreeShipClaim",
        freeShipClaim.address,
        { client: { wallet: user1 } },
      );
      await expect(
        asUser1.write.setEligibilityProvider([provider.address]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("reverts NotEligible once a provider is wired and the player hasn't been verified", async function () {
      const { owner, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      const provider = await hre.viem.deployContract(
        "SelfieCheckEligibilityProvider",
        [owner.account.address],
      );
      await freeShipClaim.write.setEligibilityProvider([provider.address], {
        account: owner.account,
      });

      const asUser1 = await hre.viem.getContractAt(
        "FreeShipClaim",
        freeShipClaim.address,
        { client: { wallet: user1 } },
      );
      await expect(
        asUser1.write.claimFreeShips([1]),
      ).to.be.rejectedWith("NotEligible");
    });

    it("succeeds once the wired provider marks the player verified", async function () {
      const { ships, owner, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      const provider = await hre.viem.deployContract(
        "SelfieCheckEligibilityProvider",
        [owner.account.address],
      );
      await freeShipClaim.write.setEligibilityProvider([provider.address], {
        account: owner.account,
      });
      await provider.write.setAuthorizedVerifier(
        [owner.account.address, true],
        { account: owner.account },
      );
      const nullifierHash = keccak256(toBytes("test-nullifier"));
      await provider.write.markVerified(
        [user1.account.address, nullifierHash],
        { account: owner.account },
      );

      const asUser1 = await hre.viem.getContractAt(
        "FreeShipClaim",
        freeShipClaim.address,
        { client: { wallet: user1 } },
      );
      await asUser1.write.claimFreeShips([1]);

      const shipIds = await ships.read.getShipIdsOwned([
        user1.account.address,
      ]);
      expect(shipIds.length).to.equal(10);
    });

    it("Should allow users to claim free ships initially", async function () {
      const { ships, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Get initial ship count
      const initialShipCount = await ships.read.shipCount();

      // Claim free ships
      await freeShipClaim.write.claimFreeShips([1], { account: user1.account });

      // Verify ship count increased by 10
      const finalShipCount = await ships.read.shipCount();
      expect(finalShipCount - initialShipCount).to.equal(10n);

      // Verify user received 10 ships
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
      expect(shipIds.length).to.equal(10);

      // Verify all claimed ships are marked as free
      for (const shipId of shipIds) {
        const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.isFreeShip).to.equal(true);
      }

      // Verify lastClaimTimestamp is set
      const lastClaim = await freeShipClaim.read.lastClaimTimestamp([
        user1.account.address,
      ]);
      expect(Number(lastClaim)).to.be.greaterThan(0);
    });

    it("Should block claiming a gated variant without the required NFT, and allow it once held", async function () {
      const { ships, shatteredHiveMedal, freeShipClaim, user1, owner } =
        await loadFixture(deployShipsFixture);

      // Variant 2 is gated to the Shattered Hive medal (see
      // DeployAndConfig.ts's setVariant2GateCall) — claiming it without the
      // medal should revert via VariantPurchaseGate, same as a paid mint.
      await expect(
        freeShipClaim.write.claimFreeShips([2], { account: user1.account }),
      ).to.be.rejectedWith("GateRequirementNotMet");

      // Once the medal is held, the same claim should succeed and mint
      // variant-2 ships.
      await shatteredHiveMedal.write.ownerMint([user1.account.address], {
        account: owner.account,
      });
      await freeShipClaim.write.claimFreeShips([2], { account: user1.account });

      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
      expect(shipIds.length).to.equal(10);
      const shipTuple = (await ships.read.ships([shipIds[0]])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      expect(ship.traits.variant).to.equal(2);
    });

    it("Should not allow claiming again before cooldown period", async function () {
      const { ships, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Claim free ships first time
      await freeShipClaim.write.claimFreeShips([1], { account: user1.account });

      // Try to claim again immediately - should fail
      await expect(
        freeShipClaim.write.claimFreeShips([1], { account: user1.account }),
      ).to.be.rejectedWith("ClaimCooldownNotPassed");
    });

    it("Should grant 10 + droneCoreTier bonus ships once a player has turned in drone cores", async function () {
      const { ships, droneStorefront, droneEnergyCores, freeShipClaim, owner, user1 } =
        await loadFixture(deployShipsFixture);

      // Give user1 tier 1 (10 DEC) on DroneStorefront before claiming.
      await droneEnergyCores.write.setAuthorizedToMint(
        [owner.account.address, true],
        { account: owner.account },
      );
      await droneEnergyCores.write.mint([user1.account.address, 10n], {
        account: owner.account,
      });

      const user1DEC = await hre.viem.getContractAt(
        "DroneEnergyCores",
        droneEnergyCores.address,
        { client: { wallet: user1 } },
      );
      await user1DEC.write.approve([droneStorefront.address, 10n]);

      const user1Storefront = await hre.viem.getContractAt(
        "DroneStorefront",
        droneStorefront.address,
        { client: { wallet: user1 } },
      );
      await user1Storefront.write.turnInCores([10n]);

      const user1FreeShipClaim = await hre.viem.getContractAt(
        "FreeShipClaim",
        freeShipClaim.address,
        { client: { wallet: user1 } },
      );

      const initialShipCount = await ships.read.shipCount();
      await user1FreeShipClaim.write.claimFreeShips([1]);
      const finalShipCount = await ships.read.shipCount();

      expect(finalShipCount - initialShipCount).to.equal(11n);

      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
      expect(shipIds.length).to.equal(11);
    });

    it("Should allow claiming again after cooldown period", async function () {
      const { ships, user1, publicClient, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Claim free ships first time
      const firstTx = await freeShipClaim.write.claimFreeShips([1], {
        account: user1.account,
      });
      const firstReceipt = await publicClient.getTransactionReceipt({
        hash: firstTx,
      });
      const firstBlock = await publicClient.getBlock({
        blockNumber: firstReceipt.blockNumber,
      });
      const firstClaimCount = await ships.read.shipCount();

      // Get the last claim timestamp
      const lastClaim = await freeShipClaim.read.lastClaimTimestamp([
        user1.account.address,
      ]);
      const blockTimestamp =
        typeof firstBlock.timestamp === "bigint"
          ? firstBlock.timestamp
          : BigInt(firstBlock.timestamp);
      expect(lastClaim.toString()).to.equal(blockTimestamp.toString());

      // Get the cooldown period
      const cooldownPeriod = await freeShipClaim.read.claimCooldownPeriod();

      // Fast forward time by cooldown period + 1 second
      await hre.network.provider.send("evm_increaseTime", [
        Number(cooldownPeriod) + 1,
      ]);
      await hre.network.provider.send("evm_mine");

      // Get current block timestamp to verify time increased
      // Get the block number from the last mined block
      const blockNumber = await publicClient.getBlockNumber();
      const currentBlock = await publicClient.getBlock({ blockNumber });
      const currentTimestamp = BigInt(currentBlock.timestamp);
      expect(Number(currentTimestamp)).to.be.greaterThanOrEqual(
        Number(lastClaim + cooldownPeriod),
      );

      // Claim again - should succeed
      await freeShipClaim.write.claimFreeShips([1], { account: user1.account });
      const secondClaimCount = await ships.read.shipCount();

      // Verify ship count increased by another 10
      expect(secondClaimCount - firstClaimCount).to.equal(10n);

      // Verify user now has 20 ships
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
      expect(shipIds.length).to.equal(20);

      // Verify all new ships are also marked as free
      for (const shipId of shipIds) {
        const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.isFreeShip).to.equal(true);
      }

      // Verify lastClaimTimestamp was updated
      const newLastClaim = await freeShipClaim.read.lastClaimTimestamp([
        user1.account.address,
      ]);
      expect(Number(newLastClaim)).to.be.greaterThan(Number(lastClaim));
    });

    it("Should allow owner to modify claim cooldown period", async function () {
      const { ships, owner, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Get initial cooldown period (should be 28 days)
      const initialCooldown = await freeShipClaim.read.claimCooldownPeriod();
      expect(initialCooldown).to.equal(28n * 24n * 60n * 60n); // 28 days in seconds

      // Set new cooldown period (7 days)
      const newCooldown = 7n * 24n * 60n * 60n;
      await freeShipClaim.write.setClaimCooldownPeriod([newCooldown], {
        account: owner.account,
      });

      // Verify cooldown period was updated
      const updatedCooldown = await freeShipClaim.read.claimCooldownPeriod();
      expect(updatedCooldown).to.equal(newCooldown);
    });

    it("Should not allow non-owner to modify claim cooldown period", async function () {
      const { ships, user1, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      const newCooldown = 7n * 24n * 60n * 60n;

      await expect(
        freeShipClaim.write.setClaimCooldownPeriod([newCooldown], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should correctly track lastClaimTimestamp", async function () {
      const { ships, user1, publicClient, freeShipClaim } =
        await loadFixture(deployShipsFixture);

      // Initially, lastClaimTimestamp should be 0
      const initialClaim = await freeShipClaim.read.lastClaimTimestamp([
        user1.account.address,
      ]);
      expect(initialClaim).to.equal(0n);

      // Claim free ships
      const tx = await freeShipClaim.write.claimFreeShips([1], {
        account: user1.account,
      });
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });

      // Get the block to access its timestamp
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });

      // Verify lastClaimTimestamp is set to block timestamp
      const lastClaim = await freeShipClaim.read.lastClaimTimestamp([
        user1.account.address,
      ]);
      expect(Number(lastClaim)).to.be.greaterThan(0);
      const blockTimestamp =
        typeof block.timestamp === "bigint"
          ? block.timestamp
          : BigInt(block.timestamp);
      expect(lastClaim).to.equal(blockTimestamp);
    });

    it("Should verify isFreeShip field for purchased ships", async function () {
      const { ships, universalCredits, user1, user2, shipPurchaser } =
        await loadFixture(deployShipsFixture);

      // Purchase ships
      await universalCredits.write.approve(
        [shipPurchaser.address, parseEther("100")],
        {
          account: user1.account,
        },
      );

      await shipPurchaser.write.purchaseWithUC(
        [user1.account.address, 1n, user2.account.address, 1],
        {
          account: user1.account,
        },
      );

      // Get purchased ship IDs
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);

      // Verify purchased ships are NOT marked as free
      for (const shipId of shipIds) {
        const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.shipData.isFreeShip).to.equal(false);
      }
    });
  });

  describe("Flow-based Purchasing", function () {
    it("Should allow non-owner to purchase ships with Flow (tier 1)", async function () {
      const { ships, user1Ships, user1, user2, publicClient } =
        await loadFixture(deployShipsFixture);

      // Get initial ship count
      const initialShipCount = await ships.read.shipCount();

      // Non-owner (user1) purchases tier 1 with Flow using their contract instance
      await user1Ships.write.purchaseWithFlow(
        [user1.account.address, 1n, user2.account.address, 1],
        { value: parseEther("9.99") },
      );

      // Verify ship count increased by 11 (tier 1 amount)
      const finalShipCount = await ships.read.shipCount();
      expect(finalShipCount - initialShipCount).to.equal(11n);

      // Verify all new ships are owned by user1
      for (let i = initialShipCount + 1n; i <= finalShipCount; i++) {
        const shipTuple = (await ships.read.ships([i])) as ShipTuple;
        const ship = tupleToShip(shipTuple);
        expect(ship.owner.toString().toLocaleLowerCase()).to.equal(
          user1.account.address.toLocaleLowerCase(),
        );
      }

      // Verify user1 has now purchased enough ships to transfer
      const amountPurchased = await ships.read.amountPurchased([
        user1.account.address,
      ]);
      expect(Number(amountPurchased)).to.be.greaterThanOrEqual(10);
    });
  });

  describe("Direct UTC Purchase with Flow", function () {
    it("Should purchase UTC for tier 0 (0.5 UC for 4.99 FLOW, matching 5 ships recycled)", async function () {
      const { shipPurchaser, universalCredits, user1, publicClient } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const initialContractBalance = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 0n],
        { value: parseEther("4.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const finalContractBalance = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      // Check that 0.5 UC was minted (5 ships x 0.1 recycle reward)
      expect(finalBalance - initialBalance).to.equal(parseEther("0.5"));
      // Check that FLOW was received by contract
      expect(finalContractBalance - initialContractBalance).to.equal(
        parseEther("4.99"),
      );
    });

    it("Should purchase UTC for tier 1 (1.1 UC for 9.99 FLOW, matching 11 ships recycled)", async function () {
      const { shipPurchaser, universalCredits, user1 } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 1],
        { value: parseEther("9.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Check that 1.1 UC was minted (11 ships x 0.1 recycle reward)
      expect(finalBalance - initialBalance).to.equal(parseEther("1.1"));
    });

    it("Should purchase UTC for tier 2 (2.2 UC for 19.99 FLOW, matching 22 ships recycled)", async function () {
      const { shipPurchaser, universalCredits, user1 } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 2n],
        { value: parseEther("19.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Check that 2.2 UC was minted (22 ships x 0.1 recycle reward)
      expect(finalBalance - initialBalance).to.equal(parseEther("2.2"));
    });

    it("Should purchase UTC for tier 3 (4 UC for 34.99 FLOW, matching 40 ships recycled)", async function () {
      const { shipPurchaser, universalCredits, user1 } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 3n],
        { value: parseEther("34.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Check that 4 UC was minted (40 ships x 0.1 recycle reward)
      expect(finalBalance - initialBalance).to.equal(parseEther("4"));
    });

    it("Should purchase UTC for tier 4 (6 UC for 49.99 FLOW, matching 60 ships recycled)", async function () {
      const { shipPurchaser, universalCredits, user1 } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 4n],
        { value: parseEther("49.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Check that 6 UC was minted (60 ships x 0.1 recycle reward)
      expect(finalBalance - initialBalance).to.equal(parseEther("6"));
    });

    it("Should mint the same UTC as ship purchase + recycle (tier 4)", async function () {
      const {
        ships,
        shipPurchaser,
        universalCredits,
        user1,
        user2,
        publicClient,
      } = await loadFixture(deployShipsFixture);

      // Method 1: Direct UTC purchase
      const initialBalanceDirect = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const initialContractBalanceDirect = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 4n],
        { value: parseEther("49.99"), account: user1.account },
      );

      const finalBalanceDirect = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const finalContractBalanceDirect = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      const utcReceivedDirect = finalBalanceDirect - initialBalanceDirect;
      const flowReceivedDirect =
        finalContractBalanceDirect - initialContractBalanceDirect;

      // Method 2: Ship purchase + recycle
      // Reset user1 balance
      await universalCredits.write.transfer(
        ["0x000000000000000000000000000000000000dEaD", utcReceivedDirect],
        { account: user1.account },
      );

      const initialBalanceRecycle = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const initialContractBalanceRecycle = await publicClient.getBalance({
        address: ships.address,
      });
      // Get initial balances - check at current block to ensure accuracy
      const initialBlockNumber = await publicClient.getBlockNumber();
      const initialReferrerBalance = await publicClient.getBalance({
        address: user2.account.address,
        blockNumber: initialBlockNumber,
      });

      // Check initial referral count for user2
      const initialReferralCount = await ships.read.referralCount([
        user2.account.address,
      ]);

      // Calculate expected referral percentage based on NEW count (after increment)
      // The referral count is incremented BEFORE checking the percentage in _processReferral
      // So if initialReferralCount is 0, new count is 60, which is still < 1000 (0%)
      const newReferralCount = initialReferralCount + 60n;

      // Determine expected referral percentage based on new count
      // Known stages from contract: [1000, 10000, 50000, 100000]
      // Known percentages from contract: [0%, 10%, 20%, 35%, 50%]
      // Contract logic: 0% for < 1000, then checks stages
      let expectedReferralPercentage = 0n; // Default 0% for < 1000 ships
      if (newReferralCount >= 100000n) {
        expectedReferralPercentage = 50n;
      } else if (newReferralCount >= 50000n) {
        expectedReferralPercentage = 35n;
      } else if (newReferralCount >= 10000n) {
        expectedReferralPercentage = 20n;
      } else if (newReferralCount >= 1000n) {
        expectedReferralPercentage = 10n;
      } else {
        expectedReferralPercentage = 0n; // < 1000 ships
      }

      // Calculate expected referral amount based on the correct percentage
      const expectedReferralAmount =
        (parseEther("49.99") * expectedReferralPercentage) / 100n;

      // Purchase ships with FLOW
      const txHash = await ships.write.purchaseWithFlow(
        [user1.account.address, 4n, user2.account.address, 1],
        { value: parseEther("49.99"), account: user1.account },
      );

      // Wait for transaction to be mined and get receipt
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // Get balance after transaction at the block where it was mined
      const finalBlockNumber = receipt.blockNumber;
      const finalReferrerBalance = await publicClient.getBalance({
        address: user2.account.address,
        blockNumber: finalBlockNumber,
      });

      // Check referral count increased
      const finalReferralCount = await ships.read.referralCount([
        user2.account.address,
      ]);
      expect(finalReferralCount - initialReferralCount).to.equal(60n); // 60 ships for tier 4 (index 4)

      // Calculate what referrer actually received
      const referrerReceived = finalReferrerBalance - initialReferrerBalance;

      // Verify referral was paid - referrer should receive the expected amount
      // This is a critical check - if this fails, the referral payment mechanism is broken
      expect(referrerReceived).to.equal(
        expectedReferralAmount,
        `Referrer should receive ${expectedReferralAmount.toString()} FLOW (${expectedReferralPercentage}% of 49.99), but received ${referrerReceived.toString()}. Initial balance: ${initialReferrerBalance.toString()}, Final balance: ${finalReferrerBalance.toString()}, Initial referral count: ${initialReferralCount.toString()}, New count: ${newReferralCount.toString()}`,
      );

      // Check Ships contract balance after purchase (before recycling)
      // Ships should receive 49.99 FLOW and pay out referral, so balance = 49.99 - referral
      const contractBalanceAfterPurchase = await publicClient.getBalance({
        address: ships.address,
        blockNumber: finalBlockNumber,
      });
      const flowReceivedRecycle =
        contractBalanceAfterPurchase - initialContractBalanceRecycle;

      // Verify Ships contract received the payment minus the referral
      // Ships receives: 49.99 FLOW
      // Ships pays out: expectedReferralAmount FLOW
      // Ships should retain: 49.99 - expectedReferralAmount
      const expectedShipsRetention =
        parseEther("49.99") - expectedReferralAmount;
      expect(flowReceivedRecycle).to.equal(
        expectedShipsRetention,
        `Ships contract should retain ${expectedShipsRetention.toString()} FLOW (49.99 - ${expectedReferralAmount.toString()}), but has ${flowReceivedRecycle.toString()}. Initial: ${initialContractBalanceRecycle.toString()}, Final: ${contractBalanceAfterPurchase.toString()}`,
      );

      // Get ship IDs and recycle them
      const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
      await ships.write.shipBreaker([shipIds], { account: user1.account });

      const finalBalanceRecycle = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      const utcReceivedRecycle = finalBalanceRecycle - initialBalanceRecycle;

      // Direct purchase mints the same UTC a player would net from buying +
      // recycling tier 4's 60 ships (60 x 0.1 UC recycle reward)
      expect(utcReceivedDirect).to.equal(parseEther("6"));
      expect(utcReceivedRecycle).to.equal(parseEther("6"));
      expect(utcReceivedDirect).to.equal(utcReceivedRecycle);

      // Direct purchase gives owner full FLOW (49.99 FLOW)
      expect(flowReceivedDirect).to.equal(parseEther("49.99"));

      // Ship purchase: referrer gets commission, Ships contract retains the rest
      // We've already verified:
      // - Referrer received exactly expectedReferralAmount (0 FLOW for < 1000 ships)
      // - Ships contract retained exactly expectedShipsRetention (49.99 FLOW)
      // Now verify the comparison:
      // Direct purchase: 49.99 FLOW (no referral paid)
      // Ship purchase: 49.99 FLOW (after 0% referral = 0 FLOW paid out)
      // With 0% referral, both should be equal
      if (expectedReferralPercentage > 0n) {
        expect(flowReceivedRecycle < flowReceivedDirect).to.be.true;
      } else {
        expect(flowReceivedRecycle).to.equal(flowReceivedDirect);
      }
    });

    it("Should revert with incorrect payment amount", async function () {
      const { shipPurchaser, user1 } = await loadFixture(deployShipsFixture);

      // Try to purchase tier 4 with wrong amount
      await expect(
        shipPurchaser.write.purchaseUTCWithFlow([user1.account.address, 4n], {
          value: parseEther("50"),
          account: user1.account,
        }),
      ).to.be.rejectedWith("InvalidPurchase");
    });

    it("Should revert with invalid tier", async function () {
      const { shipPurchaser, user1 } = await loadFixture(deployShipsFixture);

      // Try to purchase with invalid tier (tier index 5 doesn't exist, only 0-4)
      await expect(
        shipPurchaser.write.purchaseUTCWithFlow([user1.account.address, 5n], {
          value: parseEther("100"),
          account: user1.account,
        }),
      ).to.be.rejectedWith("InvalidPurchase");
    });

    it("Should allow owner to withdraw FLOW", async function () {
      const { shipPurchaser, universalCredits, user1, owner, publicClient } =
        await loadFixture(deployShipsFixture);

      // Purchase UTC to send FLOW to contract
      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 4n],
        { value: parseEther("49.99"), account: user1.account },
      );

      const initialOwnerBalance = await publicClient.getBalance({
        address: owner.account.address,
      });
      const contractBalance = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      expect(contractBalance).to.equal(parseEther("49.99"));

      // Owner withdraws FLOW
      await shipPurchaser.write.withdrawFlow({ account: owner.account });

      const finalOwnerBalance = await publicClient.getBalance({
        address: owner.account.address,
      });
      const finalContractBalance = await publicClient.getBalance({
        address: shipPurchaser.address,
      });

      // Owner should receive the FLOW (minus gas)
      expect(finalOwnerBalance > initialOwnerBalance).to.be.true;
      // Contract balance should be zero
      expect(finalContractBalance).to.equal(0n);
    });

    it("Should not allow non-owner to withdraw FLOW", async function () {
      const { shipPurchaser, user1 } = await loadFixture(deployShipsFixture);

      await expect(
        shipPurchaser.write.withdrawFlow({ account: user1.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should handle multiple purchases correctly", async function () {
      const { shipPurchaser, universalCredits, user1 } =
        await loadFixture(deployShipsFixture);

      const initialBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Purchase tier 0 twice
      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 0n],
        { value: parseEther("4.99"), account: user1.account },
      );
      await shipPurchaser.write.purchaseUTCWithFlow(
        [user1.account.address, 0n],
        { value: parseEther("4.99"), account: user1.account },
      );

      const finalBalance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);

      // Should have 1 UC total (0.5 + 0.5, tier 0's 5 ships x 0.1 recycle reward, twice)
      expect(finalBalance - initialBalance).to.equal(parseEther("1"));
    });

    it("Should mint UTC to correct address", async function () {
      const { shipPurchaser, universalCredits, user1, user2 } =
        await loadFixture(deployShipsFixture);

      const initialBalanceUser2 = await universalCredits.read.balanceOf([
        user2.account.address,
      ]);

      // User1 purchases but sends UTC to user2
      await shipPurchaser.write.purchaseUTCWithFlow(
        [user2.account.address, 4n],
        { value: parseEther("49.99"), account: user1.account },
      );

      const finalBalanceUser2 = await universalCredits.read.balanceOf([
        user2.account.address,
      ]);

      // User2 should receive the UTC (6 UC for tier 4, 60 ships x 0.1 recycle reward)
      expect(finalBalanceUser2 - initialBalanceUser2).to.equal(
        parseEther("6"),
      );
    });
  });

  describe("ShipAttributes Update Functions", function () {
    it("Should not allow non-owner to update attributes", async function () {
      const { shipAttributes, user1 } = await loadFixture(deployShipsFixture);

      // Try to update attributes version as non-owner
      await expect(
        shipAttributes.write.setCurrentAttributesVersion([1, 1], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");

      // Try to publish attributes as non-owner
      const newGuns = [
        { range: 12, damage: 30, movement: 0 },
        { range: 20, damage: 25, movement: 0 },
        { range: 8, damage: 30, movement: -1 },
        { range: 3, damage: 40, movement: 0 },
      ];
      const newArmors = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 8, movement: 0 },
        { damageReduction: 10, movement: -1 },
        { damageReduction: 15, movement: -2 },
      ];
      const newShields = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 15, movement: 0 },
        { damageReduction: 20, movement: -1 },
        { damageReduction: 30, movement: -2 },
      ];
      const newSpecials = [
        { range: 0, strength: 0, movement: 0 },
        { range: 6, strength: 20, movement: 0 },
        { range: 8, strength: 0, movement: 0 },
        { range: 4, strength: 15, movement: 0 },
      ];
      const newForeAccuracy = [0, 5, 10, 20];
      const newEngineSpeeds = [0, 3, 5, 8];
      const newHull = [0, 10, 20, 30];

      await expect(
        shipAttributes.write.setVariantAttributes(
          [
            attributeParams({
              variant: 1,
              baseHull: 120,
              baseSpeed: 7,
              foreAccuracy: newForeAccuracy,
              hull: newHull,
              engineSpeeds: newEngineSpeeds,
              guns: newGuns,
              armors: newArmors,
              shields: newShields,
              specials: newSpecials,
            }),
          ],
          { account: user1.account },
        ),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should allow owner to update costs", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // Get current costs for variant 1
      const currentCosts = await shipAttributes.read.getCosts([1]);
      expect(currentCosts[0]).to.equal(1n); // version should be 1 (the deploy module's own setCostsVariant1Call is the only seed — nothing in the constructor pre-bumps it)

      // Create new costs
      const newCosts = {
        version: 2,
        baseCost: 60,
        accuracy: [0, 15, 30],
        hull: [0, 15, 30],
        speed: [0, 15, 30],
        mainWeapon: [30, 35, 45, 45],
        armor: [0, 8, 12, 18],
        shields: [0, 12, 24, 36],
        special: [0, 12, 24, 18, 18, 24, 12, 0],
      };

      // Update costs for variant 1
      await shipAttributes.write.setCosts([1, costsParams(newCosts)], {
        account: owner.account,
      });

      // Verify costs were updated
      const updatedCosts = await shipAttributes.read.getCosts([1]);
      expect(updatedCosts[0]).to.equal(2n); // version should be 2
      expect(updatedCosts[1].baseCost).to.equal(60);
      expect(updatedCosts[1].accuracy[1]).to.equal(15); // accuracy tier 1 cost
      expect(updatedCosts[1].mainWeapon[0]).to.equal(30); // laser cost

      // Verify current costs version
      const costsVersion = await shipAttributes.read.getCurrentCostsVersion([
        1,
      ]);
      expect(costsVersion).to.equal(2);
    });

    it("Should not allow non-owner to update costs", async function () {
      const { shipAttributes, user1 } = await loadFixture(deployShipsFixture);

      const newCosts = {
        version: 2,
        baseCost: 60,
        accuracy: [0, 15, 30],
        hull: [0, 15, 30],
        speed: [0, 15, 30],
        mainWeapon: [30, 35, 45, 45],
        armor: [0, 8, 12, 18],
        shields: [0, 12, 24, 36],
        special: [0, 12, 24, 18, 18, 24, 12, 0],
      };

      // Try to update costs as non-owner
      await expect(
        shipAttributes.write.setCosts([1, costsParams(newCosts)], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("Should allow owner to publish a new attributes version for one variant", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      // The deploy module publishes version 1 for each variant.
      expect(await shipAttributes.read.getCurrentAttributesVersion([1])).to.equal(
        1,
      );
      expect(await shipAttributes.read.getLatestAttributesVersion([1])).to.equal(
        1,
      );

      // Define new attributes
      const newGuns = [
        { range: 8, damage: 30, movement: 0 },
        { range: 15, damage: 25, movement: 0 },
        { range: 10, damage: 35, movement: -1 },
        { range: 5, damage: 45, movement: 0 },
      ];
      const newArmors = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 5, movement: 0 },
        { damageReduction: 10, movement: -1 },
        { damageReduction: 15, movement: -2 },
      ];
      const newShields = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 8, movement: 0 },
        { damageReduction: 15, movement: -1 },
        { damageReduction: 25, movement: -2 },
      ];
      const newSpecials = [
        { range: 0, strength: 0, movement: 0 },
        { range: 6, strength: 10, movement: 0 },
        { range: 8, strength: 0, movement: 0 },
        { range: 4, strength: 15, movement: 0 },
      ];
      const newForeAccuracy = [0, 130, 160];
      const newEngineSpeeds = [0, 2, 3];
      const newHull = [0, 10, 20];

      // One call publishes version 2 for variant 1 and makes it live.
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 1,
            baseHull: 120,
            baseSpeed: 4,
            foreAccuracy: newForeAccuracy,
            hull: newHull,
            engineSpeeds: newEngineSpeeds,
            guns: newGuns,
            armors: newArmors,
            shields: newShields,
            specials: newSpecials,
          }),
        ],
        {
          account: owner.account,
        },
      );

      expect(await shipAttributes.read.getCurrentAttributesVersion([1])).to.equal(
        2,
      );
      expect(await shipAttributes.read.getLatestAttributesVersion([1])).to.equal(
        2,
      );

      // The new version's attributes are set correctly...
      const v2 = await shipAttributes.read.getVariantAttributes([1, 2]);
      expect(v2.baseHull).to.equal(120);
      expect(v2.baseSpeed).to.equal(4);

      // ...version 1 is untouched (published versions are immutable)...
      const v1 = await shipAttributes.read.getVariantAttributes([1, 1]);
      expect(v1.baseHull).to.equal(100);
      expect(v1.baseSpeed).to.equal(4);

      // ...and variant 2 is unaffected (versions are per variant).
      expect(await shipAttributes.read.getCurrentAttributesVersion([2])).to.equal(
        1,
      );
    });

    it("caps damageReduction at 100 when armor+shield alone sum above it (HA3-02)", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      const flatGuns = Array(4).fill({ range: 5, damage: 50, movement: 0 });
      const flatSpecials = Array(4).fill({
        range: 0,
        strength: 0,
        movement: 0,
      });
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 1,
            baseHull: 100,
            baseSpeed: 5,
            foreAccuracy: [0, 0, 0],
            hull: [0, 0, 0],
            engineSpeeds: [0, 0, 0],
            guns: flatGuns,
            armors: [
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 70, movement: 0 }, // armor slot 3: 70%
            ],
            shields: [
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 60, movement: 0 }, // shield slot 3: 60% -> 130% combined
            ],
            specials: flatSpecials,
          }),
        ],
        { account: owner.account },
      );

      const testShip: Ship = {
        name: "Test",
        id: 1n,
        equipment: { mainWeapon: 0, armor: 3, shields: 3, special: 0 },
        traits: {
          serialNumber: 1n,
          colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 0,
        },
        shipData: {
          shipsDestroyed: 0, // rank 1 -> 0% rank bonus, isolates the base-sum cap
          costsVersion: 0,
          cost: 0,
          shiny: false,
          constructed: true,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: owner.account.address,
      };

      const attrs = await shipAttributes.read.calculateShipAttributes([
        testShip,
      ]);
      // Without the fix, this would be 130 (70+60) — a value that makes the
      // ship permanently unshootable via Game.sol's damage formula.
      expect(attrs.damageReduction).to.equal(100);
    });

    it("caps damageReduction at 100 even when a sub-100 base is pushed over by the rank-multiplier bonus (HA3-02)", async function () {
      const { shipAttributes, owner } = await loadFixture(deployShipsFixture);

      const flatGuns = Array(4).fill({ range: 5, damage: 50, movement: 0 });
      const flatSpecials = Array(4).fill({
        range: 0,
        strength: 0,
        movement: 0,
      });
      await shipAttributes.write.setVariantAttributes(
        [
          attributeParams({
            variant: 1,
            baseHull: 100,
            baseSpeed: 5,
            foreAccuracy: [0, 0, 0],
            hull: [0, 0, 0],
            engineSpeeds: [0, 0, 0],
            guns: flatGuns,
            armors: [
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 70, movement: 0 }, // base 70% — under 100 alone
            ],
            shields: [
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
              { damageReduction: 0, movement: 0 },
            ],
            specials: flatSpecials,
          }),
        ],
        { account: owner.account },
      );

      const testShip: Ship = {
        name: "Test",
        id: 1n,
        equipment: { mainWeapon: 0, armor: 3, shields: 0, special: 0 },
        traits: {
          serialNumber: 1n,
          colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 },
          variant: 1,
          accuracy: 0,
          hull: 0,
          speed: 0,
        },
        shipData: {
          shipsDestroyed: 1000, // rank 6 -> 50% rank bonus: 70 + 35 = 105
          costsVersion: 0,
          cost: 0,
          shiny: false,
          constructed: true,
          inFleet: false,
          isFreeShip: false,
          modified: 0,
          timestampDestroyed: 0n,
        },
        owner: owner.account.address,
      };

      const attrs = await shipAttributes.read.calculateShipAttributes([
        testShip,
      ]);
      // Without the fix (or with a fix placed only inside
      // _calculateDamageReduction, before the rank bonus is added), this
      // would be 105.
      expect(attrs.damageReduction).to.equal(100);
    });

    it("Should not allow non-owner to update all attributes", async function () {
      const { shipAttributes, user1 } = await loadFixture(deployShipsFixture);

      const newGuns = [
        { range: 8, damage: 30, movement: 0 },
        { range: 15, damage: 25, movement: 0 },
        { range: 10, damage: 35, movement: -1 },
        { range: 5, damage: 45, movement: 0 },
      ];
      const newArmors = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 5, movement: 0 },
        { damageReduction: 10, movement: -1 },
        { damageReduction: 15, movement: -2 },
      ];
      const newShields = [
        { damageReduction: 0, movement: 1 },
        { damageReduction: 8, movement: 0 },
        { damageReduction: 15, movement: -1 },
        { damageReduction: 25, movement: -2 },
      ];
      const newSpecials = [
        { range: 0, strength: 0, movement: 0 },
        { range: 6, strength: 10, movement: 0 },
        { range: 8, strength: 0, movement: 0 },
        { range: 4, strength: 15, movement: 0 },
      ];
      const newForeAccuracy = [0, 130, 160];
      const newEngineSpeeds = [0, 2, 3];
      const newHull = [0, 10, 20];

      await expect(
        shipAttributes.write.setVariantAttributes(
          [
            attributeParams({
              variant: 1,
              baseHull: 120,
              baseSpeed: 4,
              foreAccuracy: newForeAccuracy,
              hull: newHull,
              engineSpeeds: newEngineSpeeds,
              guns: newGuns,
              armors: newArmors,
              shields: newShields,
              specials: newSpecials,
            }),
          ],
          {
            account: user1.account,
          },
        ),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });
  });

  describe("DroneYard", function () {
    it("Should calculate cost to modify a ship", async function () {
      const { ships, user1, user2, randomManager, droneYard, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      // Purchase and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      // Get current ship
      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Create modified ship (change equipment to a different value)
      // Ensure we actually make a change by using a different mainWeapon
      const newMainWeapon = currentShip.equipment.mainWeapon === 0 ? 1 : 0;
      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          mainWeapon: newMainWeapon, // Change from current
        },
      };

      // Calculate cost (1 equipment change = 1 modification)
      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      // Base cost is 1/5 of tier 0 price (4.99 / 5 = 0.998)
      // With 1 modification (existing 0 + new 1 = 1 total), cost = baseCost * 2^1 = 0.998 * 2 = 1.996
      const baseCost = parseEther("4.99") / 5n;
      const expectedCost = baseCost * 2n; // 2^1
      expect(cost).to.equal(expectedCost);
    });

    it("Should modify a ship's equipment", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      // Purchase and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      // Get current ship
      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Calculate cost and ensure user has enough UTC
      // Ensure we actually make a change by using a different mainWeapon
      const newMainWeapon = currentShip.equipment.mainWeapon === 0 ? 1 : 0;
      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          mainWeapon: newMainWeapon,
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      // Ensure user has enough UTC
      const balance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      if (balance < cost) {
        await universalCredits.write.mint([user1.account.address, cost]);
      }

      // Modify the ship
      await user1DroneYard.write.modifyShip([1n, modifiedShip], {
        account: user1.account,
      });

      // Verify the ship was modified
      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.equipment.mainWeapon).to.equal(newMainWeapon);
      expect(updatedShip.shipData.modified).to.not.equal(0);
    });

    it("ignores caller-supplied shipsDestroyed/isFreeShip on modify (HA6-03)", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );
      const ship = tupleToShip((await ships.read.ships([1n])) as ShipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShip = tupleToShip(
        (await ships.read.ships([1n])) as ShipTuple,
      );
      const newMainWeapon = currentShip.equipment.mainWeapon === 0 ? 1 : 0;
      // A real equipment change, plus forged rank / free-ship fields that
      // modifyShip must not price or store.
      const forged: Ship = {
        ...currentShip,
        equipment: { ...currentShip.equipment, mainWeapon: newMainWeapon },
        shipData: {
          ...currentShip.shipData,
          shipsDestroyed: 4294967295, // type(uint32).max
          isFreeShip: !currentShip.shipData.isFreeShip,
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        forged,
      ]);
      await universalCredits.write.mint([user1.account.address, cost]);
      await user1DroneYard.write.modifyShip([1n, forged], {
        account: user1.account,
      });

      const updated = tupleToShip((await ships.read.ships([1n])) as ShipTuple);
      expect(updated.equipment.mainWeapon).to.equal(newMainWeapon);
      expect(updated.shipData.shipsDestroyed).to.equal(
        currentShip.shipData.shipsDestroyed,
      );
      expect(updated.shipData.isFreeShip).to.equal(
        currentShip.shipData.isFreeShip,
      );
    });

    it("Should modify ship traits", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      // Purchase and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      // Get current ship
      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Modify traits (accuracy from 0 to 2 = 2 changes)
      const modifiedShip: Ship = {
        ...currentShip,
        traits: {
          ...currentShip.traits,
          accuracy: 2,
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      const balance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      if (balance < cost) {
        await universalCredits.write.mint([user1.account.address, cost]);
      }

      await user1DroneYard.write.modifyShip([1n, modifiedShip], {
        account: user1.account,
      });

      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.traits.accuracy).to.equal(2);
    });

    it("Should preserve name when modifying ship", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      // Purchase and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      // Get current ship and name
      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);
      const originalName = currentShip.name;

      // Modify ship (name should be preserved)
      const modifiedShip: Ship = {
        ...currentShip,
        traits: {
          ...currentShip.traits,
          accuracy: 1, // Change accuracy
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      const balance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      if (balance < cost) {
        await universalCredits.write.mint([user1.account.address, cost]);
      }

      // Modify ship
      await user1DroneYard.write.modifyShip([1n, modifiedShip], {
        account: user1.account,
      });

      // Verify name was preserved and accuracy changed
      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.name).to.equal(originalName);
      expect(updatedShip.traits.accuracy).to.equal(1);
    });

    it("Should modify shiny status and count as 3 modifications", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      // Purchase and construct a ship
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      // Get current ship
      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Modify shiny status
      const modifiedShip: Ship = {
        ...currentShip,
        shipData: {
          ...currentShip.shipData,
          shiny: !currentShip.shipData.shiny,
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      // Cost should be baseCost * 2^3 (3 modifications for shiny)
      // But we need to account for existing modified value (0) + new (3) = 3 total
      const baseCost = parseEther("4.99") / 5n;
      const totalMods = 0 + 3; // existing (0) + shiny (3)
      let expectedCost = baseCost;
      for (let i = 0; i < totalMods; i++) {
        expectedCost *= 2n;
      }
      expect(cost).to.equal(expectedCost);

      const balance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      if (balance < cost) {
        await universalCredits.write.mint([user1.account.address, cost]);
      }

      await user1DroneYard.write.modifyShip([1n, modifiedShip], {
        account: user1.account,
      });

      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.shipData.shiny).to.equal(!currentShip.shipData.shiny);
    });

    it("Should not allow modifying ship if not owner", async function () {
      const { ships, user1, user2, randomManager, user2DroneYard } =
        await loadFixture(deployShipsFixture);

      // Purchase and construct a ship for user1
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          mainWeapon: 1,
        },
      };

      // user2 tries to modify user1's ship
      await expect(
        user2DroneYard.write.modifyShip([1n, modifiedShip], {
          account: user2.account,
        }),
      ).to.be.rejectedWith("NotShipOwner");
    });

    it("Should not allow modifying unconstructed ship", async function () {
      const { ships, user1, user2, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      // Purchase but don't construct
      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          mainWeapon: 1,
        },
      };

      await expect(
        user1DroneYard.write.modifyShip([1n, modifiedShip], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("ShipNotConstructed");
    });

    it("Should not allow modifying ship with invalid trait values", async function () {
      const { ships, user1, user2, randomManager, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Try to set accuracy to 3 (invalid, must be 0-2)
      const modifiedShip: Ship = {
        ...currentShip,
        traits: {
          ...currentShip.traits,
          accuracy: 3,
        },
      };

      await expect(
        user1DroneYard.write.modifyShip([1n, modifiedShip], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("InvalidTraitValue");
    });

    it("Should not allow both armor and shields to be set", async function () {
      const { ships, user1, user2, randomManager, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Try to set both armor and shields
      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          armor: 1, // Light Armor
          shields: 1, // Light Shields
        },
      };

      await expect(
        user1DroneYard.write.modifyShip([1n, modifiedShip], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("ArmorAndShieldsBothSet");
    });

    it("Should not allow modifying a ship to change its variant", async function () {
      const { ships, user1, user2, randomManager, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Try to convert the variant-1 ship into a variant-2 ship, bypassing
      // the purchase-time medal gate.
      const modifiedShip: Ship = {
        ...currentShip,
        traits: {
          ...currentShip.traits,
          variant: 2,
        },
      };

      await expect(
        user1DroneYard.write.modifyShip([1n, modifiedShip], {
          account: user1.account,
        }),
      ).to.be.rejectedWith("InvalidVariant");
    });

    it("Should preserve name and colors when modifying ship", async function () {
      const {
        ships,
        user1,
        user2,
        randomManager,
        universalCredits,
        user1DroneYard,
      } = await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);
      const originalName = currentShip.name;
      const originalColors = currentShip.traits.colors;

      // Try to change name and colors in the modified ship (should be ignored)
      const modifiedShip: Ship = {
        ...currentShip,
        name: "New Name",
        traits: {
          ...currentShip.traits,
          colors: {
            h1: 100,
            s1: 50,
            l1: 50,
            h2: 200,
            s2: 60,
            l2: 60,
            h3: currentShip.traits.colors.h3,
            s3: currentShip.traits.colors.s3,
            l3: currentShip.traits.colors.l3,
          },
          accuracy: 1, // This should change
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      const balance = await universalCredits.read.balanceOf([
        user1.account.address,
      ]);
      if (balance < cost) {
        await universalCredits.write.mint([user1.account.address, cost]);
      }

      await user1DroneYard.write.modifyShip([1n, modifiedShip], {
        account: user1.account,
      });

      // Verify name and colors preserved, but accuracy changed
      const updatedShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const updatedShip = tupleToShip(updatedShipTuple);
      expect(updatedShip.name).to.equal(originalName);
      expect(updatedShip.traits.colors.h1).to.equal(originalColors.h1);
      expect(updatedShip.traits.accuracy).to.equal(1);
    });

    it("Should calculate cost correctly with multiple modifications", async function () {
      const { ships, user1, user2, randomManager, user1DroneYard } =
        await loadFixture(deployShipsFixture);

      await ships.write.purchaseWithFlow(
        [user1.account.address, 0n, user2.account.address, 1],
        { value: parseEther("4.99") },
      );

      const shipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      const serialNumber = ship.traits.serialNumber;

      await randomManager.write.revealRandomness([serialNumber]);
      await ships.write.constructShip([1n], { account: user1.account });

      const currentShipTuple = (await ships.read.ships([1n])) as ShipTuple;
      const currentShip = tupleToShip(currentShipTuple);

      // Modify multiple things: equipment (1) + traits (accuracy change)
      // Need to check current accuracy value first
      const currentAccuracy = currentShip.traits.accuracy;
      const newAccuracy = currentAccuracy === 0 ? 2 : 0; // Change to opposite
      const accuracyChange = Math.abs(newAccuracy - currentAccuracy);

      const modifiedShip: Ship = {
        ...currentShip,
        equipment: {
          ...currentShip.equipment,
          mainWeapon: currentShip.equipment.mainWeapon === 0 ? 1 : 0, // Change weapon
        },
        traits: {
          ...currentShip.traits,
          accuracy: newAccuracy,
        },
      };

      const cost = await user1DroneYard.read.calculateCostToModify([
        1n,
        modifiedShip,
      ]);

      // Total modifications: existing (0) + equipment (1) + trait (accuracyChange)
      const totalMods = 0 + 1 + accuracyChange; // existing + equipment + trait
      // Cost = baseCost * 2^totalMods
      const baseCost = parseEther("4.99") / 5n;
      let expectedCost = baseCost;
      if (totalMods > 0) {
        for (let i = 0; i < totalMods; i++) {
          expectedCost *= 2n;
        }
      }
      expect(cost).to.equal(expectedCost);
    });
  });
});
