// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { parseEther } from "viem";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import starterContent from "../data/singlePlayerStarterContent.json";
import roguelikeStarterContent from "../data/roguelikeStarterContent.json";
import pvpStarterContent from "../data/pvpStarterContent.json";

// Set to true only for a real production deploy, and flip it back to false
// immediately afterward — do not leave it committed as true. Every test
// fixture deploys this same module via hre.ignition.deploy(DeployModule),
// and steps gated behind this flag (e.g. pointing at hardcoded real-network
// addresses instead of test mocks, and transferring contract ownership away
// from the deployer) silently break the entire test suite if this is left
// true, with no error at the call site that changed it — the deploy itself
// "succeeds" against real/hardcoded addresses and only surfaces as mass,
// seemingly-unrelated test failures elsewhere (confirmed 2026-08-26: this
// was left true after the last real deploy and broke every test using the
// shared deploy fixture). Before running `npx hardhat test`, confirm this
// is false — this is a plain build-time boolean (not an Ignition
// parameter) so gated m.call(...) invocations are simply never added to the
// deployment graph when false, rather than being skipped at execution time.
const PRODUCTION = false;

// Whether a PRODUCTION deploy wires the Selfie Check eligibility provider into
// FreeShipClaim/TutorialClaim (2026-09-28: off for now, per explicit
// direction). When false, neither contract's provider is ever set, so both
// stay at the unset default (address(0)) = no verification at all, exactly
// what scripts/disableClaimEligibility.ts does to an already-deployed pair.
// The real SelfieCheckEligibilityProvider is still deployed (and its verifier
// authorized) so verification can be turned back on later, with no redeploy,
// via `setEligibilityProvider(<provider address>)` on each claim contract
// from MAP_EDITOR. Non-production deploys (the test fixture) ignore this and
// always wire the always-eligible mock, so tests still exercise the
// provider-wired code path.
const CLAIM_ELIGIBILITY_VERIFICATION_ENABLED = false;

// Address allowed to mint ships from the Firebase Flow backend, with the same
// rights as ShipPurchaser.
const FIREBASE_FLOW_MINTER = "0x7f9dc2D68FF842EC79DA722B68E3ca7e5aa31CCb";

// Address allowed to create/edit preset maps (in addition to the owner). Lets
// map editing be done from a wallet other than the deployer/owner. Exported
// so standalone post-deploy scripts (e.g. scripts/deployUTCLotteryPool.ts)
// can reference the same real owner address instead of hardcoding a second,
// driftable copy of it.
export const MAP_EDITOR = "0x69a5B3aE8598fC5A5419eaa1f2A59Db2D052e346";

// groupId 1 == Orb (the only credential type supported for on-chain verification).
const TOURNAMENT_WORLD_ID_GROUP = 1n;

// externalNullifier = hashToField(abi.encodePacked(hashToField(appId), action)),
// matching what IDKit uses in the frontend. Computed from:
//   app_id = "app_b2739b54eb71ceb8c76380c60c20ce22"
//   action = "join-tournament"
// (see scripts/computeExternalNullifier.ts for the derivation). If the app_id or action
// changes, recompute and update this, or call Tournament.setExternalNullifier(...).
const TOURNAMENT_EXTERNAL_NULLIFIER =
  318078722027557965998987370672697888390534537434722412480399796468873891570n;

// Ship-pack tiers, shared between Ships.sol's tierPrices and
// ShipPurchaser.sol's flowTierPrices (both native-token prices; a production
// deploy writes these into both). TIER_USD_PRICES is the "~$1/ship with bulk
// discount" curve documented in docs/UTC_Price_Prediction_10k_Players.md —
// both contracts' constructors hardcode these same numbers as raw
// `X.XX ether` literals, which only prices ships near $1 each if 1 native
// token ≈ $1 USD (true-ish for FLOW, false for ETH on Base).
const TIER_SHIPS = [5, 11, 22, 40, 60];
const TIER_USD_PRICES = [4.99, 9.99, 19.99, 34.99, 49.99];

// RoguelikeResupply repair price in UTC wei per hull point: 1 UTC per 100 HP.
const REPAIR_COST_PER_HP = parseEther("1") / 100n;

// Fixed ETH/USD price used only for tests / non-production deploys, so the
// test suite stays deterministic and never makes a network call. This is
// never used to actually price a real deploy — see getEthUsdPrice() below.
const TEST_ETH_USD_PRICE = 2490;

// Reject a fetched ETH/USD price outside this range rather than silently
// pricing every ship tier off a malformed/empty API response (near-zero
// tier prices would let ships be minted for almost nothing).
const MIN_SANE_ETH_USD_PRICE = 100;
const MAX_SANE_ETH_USD_PRICE = 50_000;

// On-disk cache for the fetched ETH/USD price, so repeated deploy attempts
// within the same day (e.g. retrying after an unrelated failure, or after a
// transient CoinGecko error/rate-limit — see the curl failure this was added
// for, 2026-09-17) don't re-hit the API every time. An in-memory cache
// wouldn't help here: each `npx hardhat ...` invocation is a fresh process,
// so the cache has to survive across processes.
const ETH_PRICE_CACHE_PATH = path.join(
  __dirname,
  "..",
  ".eth-price-cache.json",
);
const ETH_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface EthPriceCache {
  price: number;
  fetchedAt: number;
}

// Returns the cached price only if the cache file exists, parses, has a
// sane shape, and isn't older than the TTL — any failure of those falls
// through to undefined (triggering a fresh fetch) rather than throwing, so a
// missing/corrupted cache file is never itself a deploy blocker.
function readCachedEthUsdPrice(): number | undefined {
  if (!existsSync(ETH_PRICE_CACHE_PATH)) return undefined;

  try {
    const cache = JSON.parse(
      readFileSync(ETH_PRICE_CACHE_PATH, "utf-8"),
    ) as Partial<EthPriceCache>;
    if (
      typeof cache.price !== "number" ||
      !Number.isFinite(cache.price) ||
      typeof cache.fetchedAt !== "number"
    ) {
      return undefined;
    }
    if (Date.now() - cache.fetchedAt > ETH_PRICE_CACHE_TTL_MS) {
      return undefined;
    }
    return cache.price;
  } catch {
    return undefined;
  }
}

// Best-effort only -- failing to write the cache (e.g. read-only fs) should
// never fail a deploy that already has a valid, freshly-fetched price.
function writeCachedEthUsdPrice(price: number): void {
  try {
    const cache: EthPriceCache = { price, fetchedAt: Date.now() };
    writeFileSync(ETH_PRICE_CACHE_PATH, JSON.stringify(cache));
  } catch (err) {
    console.warn(
      `[DeployAndConfig] Failed to write ETH/USD price cache (non-fatal): ${err}`,
    );
  }
}

// Fetches the live ETH/USD price for a real deploy so ship tier prices
// track the current market instead of a hardcoded constant that goes stale
// the next time ETH moves (see docs/UTC_Price_Prediction_10k_Players.md,
// action item 1 — the previous TOKEN_PRICE_USD = 3000 literal in an earlier,
// now-removed version of this file's tier-pricing block was exactly that
// kind of stale constant). Ignition's buildModule callback runs
// synchronously, so this shells out to curl (blocking) rather than using
// async/await — deploy-time is not latency-sensitive. Cached on disk for 24
// hours (see readCachedEthUsdPrice/writeCachedEthUsdPrice above) so repeated
// deploy attempts in the same day don't hit the API — or its rate limit —
// every single time.
//
// Only ever called when PRODUCTION is true; tests use TEST_ETH_USD_PRICE
// and never reach this function, so they never depend on network access.
export function getEthUsdPrice(): number {
  const cached = readCachedEthUsdPrice();
  if (cached !== undefined) {
    console.log(
      `[DeployAndConfig] Using cached ETH/USD price: $${cached} (fetched within the last 24h)`,
    );
    return cached;
  }

  const raw = execSync(
    "curl -sf --max-time 10 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'",
    { encoding: "utf-8" },
  );

  let price: unknown;
  try {
    price = JSON.parse(raw)?.ethereum?.usd;
  } catch {
    throw new Error(
      `Failed to parse ETH/USD price response for tier pricing. Raw response: ${raw}`,
    );
  }

  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error(
      `Failed to fetch a usable ETH/USD price for tier pricing. Raw response: ${raw}`,
    );
  }
  if (price < MIN_SANE_ETH_USD_PRICE || price > MAX_SANE_ETH_USD_PRICE) {
    throw new Error(
      `Fetched ETH/USD price $${price} is outside the sane range ` +
        `[$${MIN_SANE_ETH_USD_PRICE}, $${MAX_SANE_ETH_USD_PRICE}] — refusing ` +
        `to price ship tiers off of it. Check the API response, or widen ` +
        `this range if ETH has genuinely moved outside it.`,
    );
  }

  console.log(`[DeployAndConfig] Using live ETH/USD price: $${price}`);
  writeCachedEthUsdPrice(price);
  return price;
}

// Converts the shared TIER_USD_PRICES curve into wei amounts at the given
// ETH/USD price.
function computeTierPricesWei(ethUsdPrice: number): bigint[] {
  return TIER_USD_PRICES.map((usdPrice) =>
    parseEther((usdPrice / ethUsdPrice).toFixed(18)),
  );
}

const DeployModule = buildModule("DeployModule", (m) => {
  // Deploy helper contracts first
  const randomManager = m.contract("RandomManager");

  // Deploy all sub-renderers
  const renderSpecial1 = m.contract("RenderSpecial1");
  const renderSpecial2 = m.contract("RenderSpecial2");
  const renderSpecial3 = m.contract("RenderSpecial3");

  const renderAft0 = m.contract("RenderAft0");
  const renderAft1 = m.contract("RenderAft1");
  const renderAft2 = m.contract("RenderAft2");

  const renderWeapon1 = m.contract("RenderWeapon1");
  const renderWeapon2 = m.contract("RenderWeapon2");
  const renderWeapon3 = m.contract("RenderWeapon3");
  const renderWeapon4 = m.contract("RenderWeapon4");

  const renderFore0 = m.contract("RenderFore0");
  const renderFore1 = m.contract("RenderFore1");
  const renderFore2 = m.contract("RenderFore2");
  const renderForePerfect = m.contract("RenderForePerfect");
  const renderShield1 = m.contract("RenderShield1");
  const renderShield2 = m.contract("RenderShield2");
  const renderShield3 = m.contract("RenderShield3");

  const renderArmor1 = m.contract("RenderArmor1");
  const renderArmor2 = m.contract("RenderArmor2");
  const renderArmor3 = m.contract("RenderArmor3");

  const renderBaseBody = m.contract("RenderBaseBody");

  // Deploy main renderers that combine sub-renderers
  const renderSpecial = m.contract("RenderSpecial", [
    [renderSpecial1, renderSpecial2, renderSpecial3],
  ]);

  const renderAft = m.contract("RenderAft", [
    [renderAft0, renderAft1, renderAft2],
  ]);

  const renderWeapon = m.contract("RenderWeapon", [
    [renderWeapon1, renderWeapon2, renderWeapon3, renderWeapon4],
  ]);

  const renderBody = m.contract("RenderBody", [
    [
      renderBaseBody,
      renderShield1,
      renderShield2,
      renderShield3,
      renderArmor1,
      renderArmor2,
      renderArmor3,
    ],
  ]);

  const renderFore = m.contract("RenderFore", [
    [renderFore0, renderFore1, renderFore2, renderForePerfect],
  ]);

  // Destroyed-ship (explosion) and unconstructed-ship art, split into
  // leaves by scripts/renderer-pipeline/svg-to-leaves.js. Order matters:
  // the image renderer concatenates them in array order.
  const renderExplosion1 = m.contract("RenderExplosion1");
  const renderExplosion2 = m.contract("RenderExplosion2");
  const renderUnconstructed = [1, 2].map((n) =>
    m.contract(`RenderUnconstructed${n}`),
  );

  // Deploy ImageRenderer with all main renderers
  const imageRenderer = m.contract("ImageRenderer", [
    renderSpecial,
    renderAft,
    renderWeapon,
    renderBody,
    renderFore,
    [renderExplosion1, renderExplosion2],
    renderUnconstructed,
  ]);

  // Deploy variant 2 (faction 2)'s own renderer set, generated from the real
  // variant-2-pixel.psd by scripts/renderer-pipeline/ (manifest.variant2.json
  // -> check-sizes.js -> gen-combiners.js). Same shape as variant 1's
  // sub-renderer/combiner/ImageRenderer deploy above, just against
  // contracts/RenderersV2 and ImageRendererV2.sol.
  const renderSpecial1V2 = m.contract("RenderSpecial1V2");
  const renderSpecial2V2 = m.contract("RenderSpecial2V2");
  const renderSpecial3V2 = m.contract("RenderSpecial3V2");

  const renderAft0V2 = m.contract("RenderAft0V2");
  const renderAft1V2 = m.contract("RenderAft1V2");
  const renderAft2V2 = m.contract("RenderAft2V2");

  const renderWeapon1V2 = m.contract("RenderWeapon1V2");
  const renderWeapon2V2 = m.contract("RenderWeapon2V2");
  const renderWeapon3V2 = m.contract("RenderWeapon3V2");
  const renderWeapon4V2 = m.contract("RenderWeapon4V2");

  const renderFore0V2 = m.contract("RenderFore0V2");
  const renderFore1V2 = m.contract("RenderFore1V2");
  const renderFore2V2 = m.contract("RenderFore2V2");
  const renderForePerfectV2 = m.contract("RenderForePerfectV2");
  const renderShield1V2 = m.contract("RenderShield1V2");
  const renderShield2V2 = m.contract("RenderShield2V2");
  const renderShield3V2 = m.contract("RenderShield3V2");

  const renderArmor1V2 = m.contract("RenderArmor1V2");
  const renderArmor2V2 = m.contract("RenderArmor2V2");
  const renderArmor3V2 = m.contract("RenderArmor3V2");

  const renderBaseBodyV2 = m.contract("RenderBaseBodyV2");

  const renderSpecialV2 = m.contract("RenderSpecialV2", [
    [renderSpecial1V2, renderSpecial2V2, renderSpecial3V2],
  ]);

  const renderAftV2 = m.contract("RenderAftV2", [
    [renderAft0V2, renderAft1V2, renderAft2V2],
  ]);

  const renderWeaponV2 = m.contract("RenderWeaponV2", [
    [renderWeapon1V2, renderWeapon2V2, renderWeapon3V2, renderWeapon4V2],
  ]);

  const renderBodyV2 = m.contract("RenderBodyV2", [
    [
      renderBaseBodyV2,
      renderShield1V2,
      renderShield2V2,
      renderShield3V2,
      renderArmor1V2,
      renderArmor2V2,
      renderArmor3V2,
    ],
  ]);

  const renderForeV2 = m.contract("RenderForeV2", [
    [renderFore0V2, renderFore1V2, renderFore2V2, renderForePerfectV2],
  ]);

  const renderExplosion1V2 = m.contract("RenderExplosion1V2");
  const renderExplosion2V2 = m.contract("RenderExplosion2V2");
  const renderExplosion3V2 = m.contract("RenderExplosion3V2");
  const renderUnconstructedV2 = [1, 2, 3, 4, 5].map((n) =>
    m.contract(`RenderUnconstructed${n}V2`),
  );

  const imageRendererV2 = m.contract("ImageRendererV2", [
    renderSpecialV2,
    renderAftV2,
    renderWeaponV2,
    renderBodyV2,
    renderForeV2,
    [renderExplosion1V2, renderExplosion2V2, renderExplosion3V2],
    renderUnconstructedV2,
  ]);

  // Deploy MetadataRenderer with both factions' image renderers.
  const metadataRenderer = m.contract("RenderMetadata", [
    imageRenderer,
    imageRendererV2,
  ]);

  let shipNames: any;
  if (!PRODUCTION) {
    // Mock for local/tests — Ignition + viem require a contract future, not a string address.
    shipNames = m.contract("MockOnchainRandomShipNames");
  } else {
    // For Flow testnet use
    // shipNames = "0x9E433A07D283d56E8243EA25b7358521b1922df5";

    // For Ronin Saigon testnet use
    // shipNames = "0x3866a81241Ec61414a3A7A99486f6652fFd0743C";

    // For XAI testnet use
    // shipNames = "0xe7266c681ce3F8CD8853141139574F2CA70AA165";

    // For Base Sepolia testnet use
    shipNames = "0x2b6C2e73D7D8B9dd49aF848B7A19FF003ED0d779";
  }

  // DroneNames (variant-2's own deterministic name generator, distinct from
  // variant 1's real-world-style shipNames) is fully self-contained --
  // pure, no owner-configurable state -- so unlike shipNames it's always
  // deployed directly rather than pointed at an external address.
  const droneNames = m.contract("DroneNames");

  // Deploy GenerateNewShip with ship names
  const generateNewShip = m.contract("GenerateNewShip", [
    shipNames,
    droneNames,
  ]);

  // Deploy UniversalCredits token
  const universalCredits = m.contract("UniversalCredits");

  // Deploy DroneEnergyCores ("DEC"): freely transferable ERC20 reward token
  // minted when a player destroys an AI-owned ship
  // (Ships.setTimestampDestroyed via DestroyRewardLib), instead of UTC. Not
  // soulbound on purpose — see DroneEnergyCores.sol's header comment.
  const droneEnergyCores = m.contract("DroneEnergyCores");

  // Deploy DroneStorefront: where players turn in DEC for a permanent
  // free-ship claim bonus (see DroneStorefront.turnInCores).
  const droneStorefront = m.contract("DroneStorefront", [droneEnergyCores]);

  // Deploy DestroyRewardLib: decides UTC vs DEC for a kill reward, split
  // out for bytecode headroom (same reasoning as SpecialEffectsLib below)
  // — linked into ShipsRouter at deploy time, since that's the only
  // contract that can see both ships' owners regardless of whether they're
  // human (Ships.sol) or AI (AIShips.sol).
  const destroyRewardLib = m.library("DestroyRewardLib");

  // Finally deploy Ships with all dependencies
  const ships = m.contract("Ships", [metadataRenderer]);

  // Generic per-variant purchase gate registry (variant -> required NFT,
  // address(0) == ungated). Ships.sol calls into this unconditionally and
  // stays ignorant of which variants are gated or on what — future gated
  // variants (e.g. a third faction with its own campaign medal) only need
  // a setRequiredNft call here, not a Ships.sol change. Wired to require
  // the Shattered Hive Campaign medal for variant 2 further below, once
  // that medal contract (and the campaign's final node id) exist.
  const variantPurchaseGate = m.contract("VariantPurchaseGate");

  // Generic per-AI-faction-variant reward token registry (variant -> reward
  // token, address(0) == no reward token registered for that variant yet,
  // in which case DestroyRewardLib pays nothing rather than reverting).
  // DestroyRewardLib/ShipsRouter stay ignorant of which variants have a
  // token or what it is — a future AI faction's token only needs a
  // setRewardToken call here, not a ShipsRouter/DestroyRewardLib redeploy.
  // Wired to pay DEC for variant 2 further below; variant 1 intentionally
  // has no token registered yet.
  const factionRewardTokenRegistry = m.contract("FactionRewardTokenRegistry");

  // Deploy AIShips: non-NFT, poolable store for single-player AI ships,
  // sitting behind ShipsRouter below instead of Ships.sol. AI ships are
  // never owned/traded by players, so this has no ERC-721/mint machinery —
  // allocateShip reuses a slot released by a previously-finished match when
  // one is available (see ShipsRouter/AIShips.sol header comments).
  const aiShips = m.contract("AIShips");

  // Deploy ShipAttributes contract (constructor arg stays Ships.sol's own
  // address; repointed at ShipsRouter below once it's deployed, since
  // single-player fleet-attribute lookups need to resolve both human and
  // AI ship ids)
  const shipAttributes = m.contract("ShipAttributes", [ships]);

  const setAiShipsShipAttributesCall = m.call(
    aiShips,
    "setShipAttributesAddress",
    [shipAttributes],
  );

  // Deploy ShipsRouter: the facade Game.sol/Fleets.sol/ShipAttributes talk
  // to instead of Ships.sol directly, so a single shipId space can resolve
  // against both Ships.sol (human) and AIShips.sol (AI) — see the
  // contract's header comment.
  const shipsRouter = m.contract(
    "ShipsRouter",
    [ships, aiShips, universalCredits, factionRewardTokenRegistry],
    { libraries: { DestroyRewardLib: destroyRewardLib } },
  );

  const setAiShipsRouterCall = m.call(aiShips, "setRouter", [shipsRouter]);

  const setShipAttributesShipsAddressCall = m.call(
    shipAttributes,
    "setShipsAddress",
    [shipsRouter],
  );

  // Deploy ShipPurchaser
  const shipPurchaser = m.contract("ShipPurchaser", [ships, universalCredits]);

  // Deploy DroneYard
  const droneYard = m.contract("DroneYard", [
    ships,
    universalCredits,
    shipPurchaser,
    shipNames,
  ]);

  // Deploy Maps contract
  const maps = m.contract("Maps");

  // Deploy AIEncounters: admin-curated single-player AI ship configs +
  // per-preset-map row/col placements, consumed by SinglePlayerMatch to
  // build the AI's fleet instead of a hardcoded template.
  const aiEncounters = m.contract("AIEncounters", [maps]);

  // Deploy NodeMap: admin-curated campaign graph for vs-AI matches — each
  // node curates its own map/costLimit/turnTime/maxScore/creatorGoesFirst,
  // with ANY-of prerequisite unlock semantics so branches/shortcuts are
  // possible. Entry point is SinglePlayerMatch.startNodeMatch; no Lobbies
  // involved.
  const nodeMap = m.contract("NodeMap", [maps]);

  // Deploy GameResults contract
  const gameResults = m.contract("GameResults");

  // Deploy SpecialEffectsLib: resolver-backed special dispatch + the
  // RepairDrones/EMP/FlakArray arithmetic, split out of Game.sol purely for
  // bytecode headroom (see the library's header comment). Linked into Game
  // at deploy time.
  const specialEffectsLib = m.library("SpecialEffectsLib");

  // Deploy Game contract with ShipAttributes. `ships` arg points at
  // ShipsRouter (not Ships.sol directly) so shipId resolution covers both
  // human and AI ships — Game.sol itself needs no source changes for this,
  // since it was already IShips-typed.
  const game = m.contract("Game", [shipsRouter, shipAttributes], {
    libraries: { SpecialEffectsLib: specialEffectsLib },
  });

  // Deploy Fleets contract, also pointed at ShipsRouter for the same reason
  const fleets = m.contract("Fleets", [shipsRouter]);

  // Deploy Lobbies contract
  const lobbies = m.contract("Lobbies", [ships]);

  // Deploy PvPMatch: the PvP-specific orchestration split out of Game.sol
  // (human forfeit/timeout, PvP leaderboard recording). Core Game.sol stays
  // mode-agnostic; this is what Lobbies talks to for starting/ending matches.
  const pvpMatch = m.contract("PvPMatch", [game, gameResults]);

  // Deploy SinglePlayerMatch: plays single-player matches as an on-chain AI
  // opponent, entered via NodeMap's campaign graph (startNodeMatch) — no
  // Lobbies involved. `lobbies` is kept as a legacy constructor arg only
  // (see the contract's header comment). First arg is AIShips.sol, not
  // Ships.sol — this contract's AI fleets are allocated from AIShips' pool.
  // Trailing 0 is engineIndex (HA4-01 fix, 2026-09-28) — this is engine 0
  // (the first/only one), so it reproduces the exact nodeMatchCount-based
  // gameId numbering every existing test already depends on. A future
  // second SinglePlayerMatch (a new gameplay-rules "engine") would deploy
  // with a distinct index instead — see SinglePlayerMatch.sol's own
  // engineIndex comment and the engine-registry plan.
  const singlePlayerMatch = m.contract("SinglePlayerMatch", [
    aiShips,
    lobbies,
    game,
    aiEncounters,
    maps,
    nodeMap,
    fleets,
    0,
  ]);

  // ---- Roguelike campaign mode ------------------------------------------
  // Sits alongside NodeMap/SinglePlayerMatch (the existing, replayable
  // campaign) — a completely independent graph/run/orchestration stack, not
  // a replacement. A player commits a fleet once (RoguelikeMatch.startRun);
  // it persists — with accumulated damage — across RoguelikeNodeMap's
  // parent-lists-children mission graph until the run is won or ends.
  // Reuses AIShips/Fleets/Game/AIEncounters/ShipAttributes exactly as-is,
  // via the additive permission grants below.
  const roguelikeNodeMap = m.contract("RoguelikeNodeMap", [maps]);

  const roguelikeRun = m.contract("RoguelikeRun");
  // Stateless read-only aggregate views for the frontend (see GameLens.sol)
  // — no wiring/permissions needed, and safe to redeploy on its own.
  const gameLens = m.contract("GameLens", [
    ships,
    roguelikeRun,
    roguelikeNodeMap,
  ]);
  // Central variant -> AI-contract lookup shared by SinglePlayerMatch and
  // RoguelikeMatch (see AIBehaviorRegistry.sol). Each faction's AI contract
  // is deployed and registered further down, next to that faction's
  // resolvers (Variant2AI needs the repair resolver).
  const aiBehaviorRegistry = m.contract("AIBehaviorRegistry");
  // Trailing 0 is engineIndex (HA4-01 fix, 2026-09-28) — same reasoning as
  // singlePlayerMatch's own comment above.
  const roguelikeMatch = m.contract("RoguelikeMatch", [
    aiShips,
    ships,
    game,
    fleets,
    aiEncounters,
    maps,
    shipAttributes,
    roguelikeNodeMap,
    roguelikeRun,
    aiBehaviorRegistry,
    0,
  ]);
  // Resupply-node actions (repair, roster changes) split into their own
  // contract purely for size — see RoguelikeResupply.sol's header comment.
  const roguelikeResupply = m.contract("RoguelikeResupply", [
    ships,
    fleets,
    shipAttributes,
    universalCredits,
    roguelikeNodeMap,
    roguelikeRun,
  ]);
  // 1 UTC per 100 hull points repaired. The contract defaults to 0 (free).
  const setRepairCostPerHPCall = m.call(
    roguelikeResupply,
    "setRepairCostPerHP",
    [REPAIR_COST_PER_HP],
    { id: "SetRepairCostPerHP" },
  );

  // UA-05 fix (2026-09-29): lets RoguelikeNodeMap.removeChild refuse to
  // remove a node's last remaining child while an active run is actually
  // standing there — see RoguelikeNodeMap.sol's own comment on
  // runLedger/removeChild.
  const setRoguelikeRunLedgerCall = m.call(
    roguelikeNodeMap,
    "setRunLedgerAddress",
    [roguelikeRun],
  );

  // Pluggable roguelike win effects (see IRoguelikeWinEffect.sol) — none
  // are assigned to any node by default (RoguelikeNodeMap.setNodeWinEffects
  // is opt-in, empty until an editor configures it, same as
  // campaignAutoHealPercent defaulting to 0/unset). Deployed + granted here
  // so they're ready to be wired onto specific nodes later without a
  // redeploy. Default config values (bonus amount, heal-to percent, ship
  // variant/tier) are placeholders — tune via each contract's own setters.
  const decBonusWinEffect = m.contract("DECBonusWinEffect", [
    droneEnergyCores,
    20, // bonusAmount placeholder — tune via setBonusAmount
  ]);
  const healAboveFloorWinEffect = m.contract("HealAboveFloorWinEffect", [
    roguelikeRun,
    shipAttributes,
    100, // healToPercent placeholder (full heal) — tune via setHealToPercent
  ]);
  // Grants nothing until a ship is configured per node via setGrant.
  const shipGrantWinEffect = m.contract("ShipGrantWinEffect", [ships]);

  // ShipsRouter.lobbyAddress used to point straight at SinglePlayerMatch,
  // whose isSinglePlayerOrchestrator is a hardcoded `== address(this)`
  // check — a second AI-owning orchestrator (RoguelikeMatch) wouldn't be
  // recognized, so its kills would silently pay UTC instead of DEC. This
  // registry replaces that single-address check with an owner-settable
  // one; see setShipsRouterLobbyAddressCall below for where ShipsRouter
  // gets repointed at it.
  const singlePlayerOrchestratorRegistry = m.contract(
    "SinglePlayerOrchestratorRegistry",
  );
  const registerSinglePlayerMatchOrchestratorCall = m.call(
    singlePlayerOrchestratorRegistry,
    "setOrchestrator",
    [singlePlayerMatch, true],
    { id: "RegisterSinglePlayerMatchOrchestrator" },
  );
  const registerRoguelikeMatchOrchestratorCall = m.call(
    singlePlayerOrchestratorRegistry,
    "setOrchestrator",
    [roguelikeMatch, true],
    { id: "RegisterRoguelikeMatchOrchestrator" },
  );

  const allowRoguelikeMatchToStartGamesCall = m.call(
    game,
    "setIsAllowedToStartGames",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToStartGames" },
  );
  const allowRoguelikeMatchToManageFleetsCall = m.call(
    fleets,
    "setIsAllowedToManageFleets",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToManageFleets" },
  );
  const allowRoguelikeResupplyToManageFleetsCall = m.call(
    fleets,
    "setIsAllowedToManageFleets",
    [roguelikeResupply, true],
    { id: "AllowRoguelikeResupplyToManageFleets" },
  );
  const allowRoguelikeMatchToCreateAIShipsCall = m.call(
    aiShips,
    "setIsAllowedToCreateShips",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToCreateAIShips" },
  );
  const allowRoguelikeMatchToModifyRunsCall = m.call(
    roguelikeRun,
    "setIsAllowedToModifyRuns",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToModifyRuns" },
  );
  const allowRoguelikeResupplyToModifyRunsCall = m.call(
    roguelikeRun,
    "setIsAllowedToModifyRuns",
    [roguelikeResupply, true],
    { id: "AllowRoguelikeResupplyToModifyRuns" },
  );

  // Win-effect wiring: each resolver needs (1) RoguelikeMatch authorized
  // to actually trigger it, and (2) whatever grant lets it perform its own
  // effect on the contract it targets.
  const allowRoguelikeMatchToTriggerDecBonusCall = m.call(
    decBonusWinEffect,
    "setIsAllowedToTrigger",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToTriggerDecBonus" },
  );
  const authorizeDecBonusWinEffectToMintDecCall = m.call(
    droneEnergyCores,
    "setAuthorizedToMint",
    [decBonusWinEffect, true],
    { id: "AuthorizeDecBonusWinEffectToMintDec" },
  );
  const allowRoguelikeMatchToTriggerHealAboveFloorCall = m.call(
    healAboveFloorWinEffect,
    "setIsAllowedToTrigger",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToTriggerHealAboveFloor" },
  );
  const allowHealAboveFloorWinEffectToModifyRunsCall = m.call(
    roguelikeRun,
    "setIsAllowedToModifyRuns",
    [healAboveFloorWinEffect, true],
    { id: "AllowHealAboveFloorWinEffectToModifyRuns" },
  );
  const allowRoguelikeMatchToTriggerShipGrantCall = m.call(
    shipGrantWinEffect,
    "setIsAllowedToTrigger",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToTriggerShipGrant" },
  );
  const allowShipGrantWinEffectToCreateShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [shipGrantWinEffect, true],
    { id: "AllowShipGrantWinEffectToCreateShips" },
  );

  // Win effects are PvE-only (docs/audit-3.md HA6-27): PvPMatch and
  // Tournament are deliberately NOT authorized to trigger any of them.

  const allowRoguelikeNodeEditorCall = m.call(
    roguelikeNodeMap,
    "setNodeEditor",
    [MAP_EDITOR, true],
    { id: "AllowRoguelikeNodeEditor" },
  );

  const tutorialClaim = m.contract("TutorialClaim", [ships, gameResults]);

  // Deploy FreeShipClaim: the recurring (28-day) free-ship claim, split out
  // of Ships.sol entirely (no bytecode headroom left there) — mints through
  // Ships' existing isAllowedToCreateShips allowlist, same as
  // DroneYard/ShipPurchaser/TutorialClaim.
  const freeShipClaim = m.contract("FreeShipClaim", [ships]);

  // Deploy RamResolver: the faction 1 innate ability (traits.variant == 1),
  // resolver-backed per IEffectResolver and dispatched via
  // ActionType.FactionAbility rather than the old
  // automatic-side-effect-of-movement ramming mechanic. No Game address in
  // the constructor (2026-09-28): resolvers now read live ship state via
  // IGameView(msg.sender) — see RamResolver.sol's header comment — so the
  // same deployed instance is reusable by every future engine with no
  // rewiring, which is the whole point of the engine-registry work.
  const ramResolver = m.contract("RamResolver", []);

  // Deploy RepairResolver: the faction 2 innate ability (traits.variant ==
  // 2), same shape as RamResolver above -- every variant-2 ship can heal a
  // nearby friendly ship regardless of loadout (range 1, heals 50 hull).
  const repairResolver = m.contract("RepairResolver", []);

  // Deploy the equipped-Special resolvers: EMP/RepairDrones/FlakArray are
  // dispatched via Game.specialResolvers[variant][slot] (IEffectResolver),
  // the same resolver-backed pattern as RamResolver above, migrated off
  // their old hardcoded Game.sol/SpecialEffectsLib.sol branches so future
  // factions can add their own equipped Special without spending Game.sol
  // bytecode. Each reads range/strength from the shared per-variant
  // SpecialData table via shipAttributes, so numbers stay retunable via
  // ShipAttributes.setVariantAttributes without redeploying a resolver.
  // Special is a per-faction local slot (0-7), not a global identity, so
  // each resolver is told its own slot at deploy time (second constructor
  // arg) — these three are faction 1's slots 1/2/3. A slot's behavior and
  // strength are looked up by variant first, then slot, so faction 2's
  // slots 1/2/3 below are unrelated to these.
  const empResolver = m.contract("EMPResolver", [shipAttributes, 1]);
  const repairDronesResolver = m.contract("RepairDronesResolver", [
    shipAttributes,
    2,
  ]);
  const flakArrayResolver = m.contract("FlakArrayResolver", [
    shipAttributes,
    3,
  ]);

  // Faction 2's equipped-Special resolvers: Electric Storm and Drone Swarm,
  // deployed the same way as faction 1's EMP/RepairDrones/FlakArray above —
  // faction 2's slots 1/2 (faction 2's own numbering, independent of
  // faction 1's slots 1/2). Additional Thruster (the third variant-2
  // special, slot 3) is deliberately never registered as a resolver — it's
  // a pure passive movement bonus (SpecialData.movement), so
  // Game.specialResolvers[2][Slot3] staying unset is what makes trying to
  // *use* it as an action revert.
  const electricStormResolver = m.contract("ElectricStormResolver", [
    shipAttributes,
    1,
  ]);
  const droneSwarmResolver = m.contract("DroneSwarmResolver", [
    shipAttributes,
    2,
  ]);

  // Set all config values in a single call. gameAddress/fleetsAddress are
  // ShipsRouter's address, not Game.sol's/Fleets.sol's directly — Game.sol
  // and Fleets.sol now call ShipsRouter instead of Ships.sol, so Ships.sol
  // only ever gets called BY the router post-migration, and must whitelist
  // it accordingly (see markDestroyed/recordKill/setInFleet's auth checks).
  const setShipsConfigCall = m.call(ships, "setConfig", [
    shipsRouter, // gameAddress
    singlePlayerMatch, // lobbyAddress — DestroyRewardLib uses this purely to
    // identify the AI orchestrator address for kill-reward routing (UTC vs
    // DEC); see Ships.sol's comment on this param and
    // SinglePlayerMatch.isSinglePlayerOrchestrator.
    shipsRouter, // fleetsAddress
    generateNewShip,
    randomManager,
    metadataRenderer,
    shipAttributes, // shipAttributes
    universalCredits, // universalCredits
    droneEnergyCores, // droneEnergyCores
    variantPurchaseGate, // purchaseGate
  ]);

  // ShipsRouter's own auth config: isAllowedGame/fleetsAddress gate its
  // setTimestampDestroyed/setInFleet the same way Ships.sol used to gate
  // them directly against Game.sol/Fleets.sol. lobbyAddress feeds
  // DestroyRewardLib the same way it did when called from inside Ships.sol.
  // isAllowedGame is an allowlist (2026-09-28) — see ShipsRouter.sol's own
  // comment and the engine-registry plan.
  const setShipsRouterGameAddressCall = m.call(
    shipsRouter,
    "setIsAllowedGame",
    [game, true],
  );
  const setShipsRouterFleetsAddressCall = m.call(
    shipsRouter,
    "setFleetsAddress",
    [fleets],
  );
  const setShipsRouterLobbyAddressCall = m.call(
    shipsRouter,
    "setLobbyAddress",
    [singlePlayerOrchestratorRegistry],
  );

  // Set all addresses in Game contract (Fleets/Maps/ShipAttributes stay core
  // dependencies; Lobbies/GameResults moved to PvPMatch). `ships` here is
  // redundant with the constructor arg today, but folding it into this
  // existing bulk setter (rather than a new standalone function) is what
  // lets a future ShipsRouter be swapped in later without spending scarce
  // Game.sol bytecode on a dedicated setter — see AI_SHIP_ID_OFFSET's
  // comment in AIShips.sol for why that matters.
  const setGameAddressesCall = m.call(game, "setAddresses", [
    maps,
    fleets,
    shipAttributes,
    shipsRouter,
  ]);

  // Authorize PvPMatch and SinglePlayerMatch to start/force-end sessions on
  // core Game.sol
  const allowPvPMatchToStartGamesCall = m.call(
    game,
    "setIsAllowedToStartGames",
    [pvpMatch, true],
    { id: "AllowPvPMatchToStartGames" },
  );
  const allowSinglePlayerMatchToStartGamesCall = m.call(
    game,
    "setIsAllowedToStartGames",
    [singlePlayerMatch, true],
    { id: "AllowSinglePlayerMatchToStartGames" },
  );

  // Wire RamResolver/RepairResolver in as the faction ability resolvers for
  // factions 1/2. Whether a faction's ability heals is not recorded on Game:
  // each faction's own AI contract (Variant1AI/Variant2AI, registered in
  // AIBehaviorRegistry) knows what its faction can do.
  const setFactionAbilityResolverCall = m.call(
    game,
    "setFactionAbilityResolver",
    [1, ramResolver],
  );
  const setFaction2AbilityResolverCall = m.call(
    game,
    "setFactionAbilityResolver",
    [2, repairResolver],
    { id: "SetFaction2AbilityResolver" },
  );

  // Wire the equipped-Special resolvers in — keyed by (variant, slot), since
  // Special is a per-faction local slot (0-7), not a global identity.
  // Faction 1: Slot1=EMP, Slot2=RepairDrones, Slot3=FlakArray. Faction 2:
  // Slot1=ElectricStorm, Slot2=DroneSwarm, Slot3=AdditionalThruster (no
  // resolver — passive-only). Slots 4-7 are unused for both factions.
  const setEMPResolverCall = m.call(
    game,
    "setSpecialResolver",
    [1, 1, empResolver],
    { id: "SetEMPResolver" },
  );
  const setRepairDronesResolverCall = m.call(
    game,
    "setSpecialResolver",
    [1, 2, repairDronesResolver],
    { id: "SetRepairDronesResolver" },
  );
  const setFlakArrayResolverCall = m.call(
    game,
    "setSpecialResolver",
    [1, 3, flakArrayResolver],
    { id: "SetFlakArrayResolver" },
  );
  const setElectricStormResolverCall = m.call(
    game,
    "setSpecialResolver",
    [2, 1, electricStormResolver],
    { id: "SetElectricStormResolver" },
  );
  const setDroneSwarmResolverCall = m.call(
    game,
    "setSpecialResolver",
    [2, 2, droneSwarmResolver],
    { id: "SetDroneSwarmResolver" },
  );

  // Declare each variant's highest REAL special slot — separate from the
  // resolver wiring above because a slot can be real without a resolver
  // (variant 2's Slot3 AdditionalThruster is a passive read straight out of
  // ShipAttributes, never dispatched through a resolver). Read by
  // GenerateNewShip (constrains its random roll) and DroneYard (rejects
  // customizing onto an inert slot) — see maxSpecialSlot's own comment on
  // Game.sol. Both factions currently top out at Slot3.
  const setMaxSpecialSlotVariant1Call = m.call(
    game,
    "setMaxSpecialSlot",
    [1, 3],
    { id: "SetMaxSpecialSlotVariant1" },
  );
  const setMaxSpecialSlotVariant2Call = m.call(
    game,
    "setMaxSpecialSlot",
    [2, 3],
    { id: "SetMaxSpecialSlotVariant2" },
  );

  // Wire Game's address into GenerateNewShip/DroneYard so they can read
  // maxSpecialSlot above — set post-deploy since Game doesn't exist yet when
  // either contract is constructed (Game depends on Ships, which depends on
  // GenerateNewShip).
  const setGenerateNewShipGameContractCall = m.call(
    generateNewShip,
    "setGameContract",
    [game],
    { id: "SetGenerateNewShipGameContract" },
  );
  const setDroneYardGameContractCall = m.call(
    droneYard,
    "setGameContract",
    [game],
    { id: "SetDroneYardGameContract" },
  );

  // Per-faction AI decision contracts, registered by variant in
  // AIBehaviorRegistry (looked up by SinglePlayerMatch and RoguelikeMatch).
  // Each is built around what its own faction has: Variant1AI knows healing
  // is an equipped special (variant 1's slot 2) and has no ram logic;
  // Variant2AI knows every ship has the repair faction ability (heal range
  // read from repairResolver) and no ram. Upgrading a faction's AI later =
  // deploy the new contract and registry.setVariantAI(variant, newAddress).
  const variant1AI = m.contract("Variant1AI", [shipAttributes, ramResolver]);
  const variant2AI = m.contract("Variant2AI", [repairResolver, shipAttributes]);
  const setVariant1AICall = m.call(
    aiBehaviorRegistry,
    "setVariantAI",
    [1, variant1AI],
    { id: "SetVariant1AI" },
  );
  const setVariant2AICall = m.call(
    aiBehaviorRegistry,
    "setVariantAI",
    [2, variant2AI],
    { id: "SetVariant2AI" },
  );
  const setSinglePlayerMatchAIRegistryCall = m.call(
    singlePlayerMatch,
    "setAIRegistryAddress",
    [aiBehaviorRegistry],
    { id: "SetSinglePlayerMatchAIRegistry" },
  );

  // Display names for each faction's real specials — RenderMetadata.
  // specialNames, keyed by (variant, slot) since a slot's meaning (and so
  // its name) is per-faction. Slot 0 (None) needs no entry — RenderMetadata
  // hardcodes "No Special" for it universally. Unset (variant, slot) pairs
  // (e.g. slots 4-7 for either faction) fall back to "Unknown" — those
  // slots are either inert or unused for that faction.
  const setEMPNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [1, 1, "EMP"],
    { id: "SetEMPName" },
  );
  const setRepairDronesNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [1, 2, "Repair Drones"],
    { id: "SetRepairDronesName" },
  );
  const setFlakArrayNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [1, 3, "Flak Array"],
    { id: "SetFlakArrayName" },
  );
  const setElectricStormNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [2, 1, "Lightening Field"],
    { id: "SetElectricStormName" },
  );
  const setDroneSwarmNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [2, 2, "Attack Drones"],
    { id: "SetDroneSwarmName" },
  );
  const setAdditionalThrusterNameCall = m.call(
    metadataRenderer,
    "setSpecialName",
    [2, 3, "Aux Engine"],
    { id: "SetAdditionalThrusterName" },
  );

  // Display names for MainWeapon/Armor/Shields — RenderMetadata.
  // mainWeaponNames/armorNames/shieldsNames, keyed by (variant, enum value)
  // for the same reason as the special names above: each faction reskins
  // the same mechanical enum with its own flavor text. Variant 1 is the
  // "real" faction names; variant 2 reskins the same mechanical weapons as
  // mining/industrial equipment (see Ships.test.ts's variant-2 tokenURI
  // test). Armor.None/Shields.None need no entry — RenderMetadata hardcodes
  // "No Armor"/"No Shields" for them universally.
  const setLaserNameV1Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [1, 0, "Laser"],
    { id: "SetLaserNameV1" },
  );
  const setRailgunNameV1Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [1, 1, "Railgun"],
    { id: "SetRailgunNameV1" },
  );
  const setMissileLauncherNameV1Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [1, 2, "Missile Launcher"],
    { id: "SetMissileLauncherNameV1" },
  );
  const setPlasmaCannonNameV1Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [1, 3, "Plasma Cannon"],
    { id: "SetPlasmaCannonNameV1" },
  );
  const setLaserNameV2Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [2, 0, "Medium Mining Laser"],
    { id: "SetLaserNameV2" },
  );
  const setRailgunNameV2Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [2, 1, "Linear Accelerator"],
    { id: "SetRailgunNameV2" },
  );
  const setMissileLauncherNameV2Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [2, 2, "Torpedo Launcher"],
    { id: "SetMissileLauncherNameV2" },
  );
  const setPlasmaCannonNameV2Call = m.call(
    metadataRenderer,
    "setMainWeaponName",
    [2, 3, "Mining Drill"],
    { id: "SetPlasmaCannonNameV2" },
  );

  const setLightArmorNameV1Call = m.call(
    metadataRenderer,
    "setArmorName",
    [1, 1, "Light Armor"],
    { id: "SetLightArmorNameV1" },
  );
  const setMediumArmorNameV1Call = m.call(
    metadataRenderer,
    "setArmorName",
    [1, 2, "Medium Armor"],
    { id: "SetMediumArmorNameV1" },
  );
  const setHeavyArmorNameV1Call = m.call(
    metadataRenderer,
    "setArmorName",
    [1, 3, "Heavy Armor"],
    { id: "SetHeavyArmorNameV1" },
  );
  const setLightArmorNameV2Call = m.call(
    metadataRenderer,
    "setArmorName",
    [2, 1, "Light Armor"],
    { id: "SetLightArmorNameV2" },
  );
  const setMediumArmorNameV2Call = m.call(
    metadataRenderer,
    "setArmorName",
    [2, 2, "Medium Armor"],
    { id: "SetMediumArmorNameV2" },
  );
  const setHeavyArmorNameV2Call = m.call(
    metadataRenderer,
    "setArmorName",
    [2, 3, "Heavy Armor"],
    { id: "SetHeavyArmorNameV2" },
  );

  const setLightShieldsNameV1Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [1, 1, "Light Shields"],
    { id: "SetLightShieldsNameV1" },
  );
  const setMediumShieldsNameV1Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [1, 2, "Medium Shields"],
    { id: "SetMediumShieldsNameV1" },
  );
  const setHeavyShieldsNameV1Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [1, 3, "Heavy Shields"],
    { id: "SetHeavyShieldsNameV1" },
  );
  const setLightShieldsNameV2Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [2, 1, "Light Shields"],
    { id: "SetLightShieldsNameV2" },
  );
  const setMediumShieldsNameV2Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [2, 2, "Medium Shields"],
    { id: "SetMediumShieldsNameV2" },
  );
  const setHeavyShieldsNameV2Call = m.call(
    metadataRenderer,
    "setShieldsName",
    [2, 3, "Heavy Shields"],
    { id: "SetHeavyShieldsNameV2" },
  );

  // Costs and attributes are both per-variant and versioned the same way
  // (ShipAttributes.costsByVariant / _attributesByVariant) — each variant
  // needs its own setCosts + setVariantAttributes call, and neither is
  // seeded in the constructor: every variant, including 1, is unconfigured
  // (fails loud) until these calls run. Each call PUBLISHES a complete new
  // version for that variant (version 1 here) and makes it live; the
  // contract picks the version number itself. This IS variant 1's and
  // variant 2's data, not an override of some default — edit the numbers
  // here directly to rebalance either faction. Variant 1 and variant 2 each
  // have their own fully separate set of consts below (deliberately not
  // shared) so they can be given different initial values independently.
  //
  // Array lengths are validated on publish (ShipAttributes reverts
  // InvalidArrayLength otherwise): weapon/armor/shield/special tables are
  // indexed by enum value, so all 8 slots must exist — slots 4-7 are the
  // `future*` enum values. GenerateNewShip never rolls them, but
  // customizeShip/DroneYard/prize ships can equip any enum value, so they
  // get inert filler (zero-stat gear; cost = the cheapest real entry so a
  // future slot is never free-and-strong). Trait-tier arrays have 3 entries.
  // Every array below is a full table, not a delta.

  // ---- Variant 1 ----
  // Costs.special is indexed by the raw Special enum value, per variant —
  // this faction's own None/EMP/RepairDrones/FlakArray in slots 0-3; slots
  // 4-7 are unused (inert) for it, so they cost nothing. Retune this array on
  // its own anytime; it shares nothing with variant 2's.
  const variant1SpecialCosts = [0, 10, 20, 15, 0, 0, 0, 0];
  const variant1Guns = [
    { range: 3, damage: 50, movement: 0 }, // Laser
    { range: 6, damage: 40, movement: 0 }, // Railgun
    { range: 4, damage: 60, movement: -1 }, // MissileLauncher
    { range: 2, damage: 80, movement: 0 }, // PlasmaCannon
    { range: 0, damage: 0, movement: 0 }, // future1 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future2 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future3 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future4 (inert filler)
  ];
  // Movement from defensive gear counts only for an EQUIPPED piece, and the
  // "None" bonus (+1: lighter with nothing bolted on) is counted ONCE, for a
  // ship carrying neither armor nor shields — taken from the ARMOR table's
  // None entry (ShipAttributes._calculateMovement). A ship carries armor OR
  // shields, so it gets its equipped piece's movement and nothing from the
  // other, empty slot. The shields table's None movement is therefore never
  // read; it is set to 0.
  const variant1Armors = [
    { damageReduction: 0, movement: 1 }, // None (the once-only no-gear bonus)
    { damageReduction: 15, movement: 0 }, // Light
    { damageReduction: 30, movement: -1 }, // Medium
    { damageReduction: 45, movement: -2 }, // Heavy
    { damageReduction: 0, movement: 0 }, // future1 (inert filler)
    { damageReduction: 0, movement: 0 }, // future2 (inert filler)
    { damageReduction: 0, movement: 0 }, // future3 (inert filler)
    { damageReduction: 0, movement: 0 }, // future4 (inert filler)
  ];
  const variant1Shields = [
    { damageReduction: 0, movement: 0 }, // None (movement never read — see variant1Armors)
    { damageReduction: 15, movement: 1 }, // Light
    { damageReduction: 30, movement: 0 }, // Medium
    { damageReduction: 45, movement: -1 }, // Heavy
    { damageReduction: 0, movement: 0 }, // future1 (inert filler)
    { damageReduction: 0, movement: 0 }, // future2 (inert filler)
    { damageReduction: 0, movement: 0 }, // future3 (inert filler)
    { damageReduction: 0, movement: 0 }, // future4 (inert filler)
  ];
  // Kills needed for ranks 2..6, and stat bonus % for ranks 1..6 (applied to
  // range/damage/hull/movement/damage-reduction). Thresholds must be
  // strictly ascending; bonuses are capped at 100 by the contract.
  // GenerateNewShip seeds prize-ship kill counts in ranges aligned to these
  // thresholds (1-9 / 10-29 / 30-99 / 100-299), and TutorialClaim assumes
  // 10 kills = rank 2 — retuning the thresholds shifts which rank those
  // land on.
  const variant1RankThresholds = [10, 30, 100, 300, 1000];
  const variant1RankBonusPct = [0, 10, 20, 30, 40, 50];

  const setCostsVariant1Call = m.call(
    shipAttributes,
    "setCosts",
    [
      1, // variant
      {
        version: 0, // ignored by setCosts, which always computes version+1 itself
        baseCost: 50,
        accuracy: [0, 10, 25],
        hull: [0, 10, 25],
        speed: [0, 10, 25],
        // Slots 4-7 are the inert `future*` filler (see header note).
        mainWeapon: [25, 30, 40, 40, 25, 25, 25, 25],
        armor: [0, 5, 10, 15, 0, 0, 0, 0],
        shields: [0, 10, 20, 30, 0, 0, 0, 0],
        special: variant1SpecialCosts,
      },
    ],
    { id: "SetCostsVariant1" },
  );

  const setVariant1AttributesCall = m.call(
    shipAttributes,
    "setVariantAttributes",
    [
      {
        variant: 1,
        baseHull: 100,
        baseSpeed: 4,
        foreAccuracy: [0, 25, 50],
        hull: [0, 10, 20],
        engineSpeeds: [0, 1, 2],
        guns: variant1Guns,
        armors: variant1Armors,
        shields: variant1Shields,
        rankThresholds: variant1RankThresholds,
        rankBonusPct: variant1RankBonusPct,
        specials: [
          { range: 0, strength: 0, movement: 0 }, // None
          { range: 1, strength: 1, movement: 0 }, // EMP
          { range: 3, strength: 40, movement: 0 }, // RepairDrones
          { range: 3, strength: 30, movement: 0 }, // FlakArray
          { range: 0, strength: 0, movement: 0 }, // Slot4 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot5 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot6 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot7 (unused)
        ],
      },
    ],
    { id: "SetVariant1Attributes" },
  );

  // ---- Variant 2 ----
  // Costs.special is indexed by this faction's own slot numbers: slot 1 =
  // ElectricStorm, 2 = DroneSwarm, 3 = AdditionalThruster; slots 4-7 are
  // unused (inert, free). Point-costs for its three specials are
  // placeholders (loosely mirroring FlakArray/EMP/a cheap passive tier) —
  // retune anytime via another setCosts call.
  const variant2SpecialCosts = [0, 15, 20, 10, 0, 0, 0, 0];
  // Variant 2 is the heavy faction: compared with variant 1 its ships have
  // ~25% more hull (base 125 vs 100, tiers 12/25 vs 10/20), one less base
  // speed (3 vs 4), guns with ~1 less range but ~20% more damage, and
  // heavier, tougher gear (armor/shields reduce ~33% more damage —
  // 20/40/60% vs 15/30/45% — and the Heavy tier costs one more movement).
  // Costs are identical to variant 1's, so overall strength is meant to match
  // at equal fleet cost — the numbers were calibrated with a skirmish
  // simulation (see docs/variant-balance.md and scripts/balance-sim/) that
  // plays random equal-cost fleets against each other; re-run it after any
  // retune. Damage reduction tops out at 60% per piece: DroneYard only allows
  // armor OR shields (never both), so a ship's total stays at 60% (90% at rank
  // 6's +50% bonus), safely below the 100% cap (which would make a ship immune).
  // Indexed by MainWeapon enum value (Generic/Sniper/Missile/Close); the
  // comments use variant 2's own weapon names (see the setMainWeaponName
  // calls above), with variant 1's equivalent numbers for comparison.
  const variant2Guns = [
    { range: 2, damage: 60, movement: 0 }, // Medium Mining Laser (v1 Laser: range 3, damage 50)
    { range: 5, damage: 50, movement: 0 }, // Linear Accelerator (v1 Railgun: range 6, damage 40)
    { range: 3, damage: 70, movement: -1 }, // Torpedo Launcher (v1 Missile Launcher: range 4, damage 60)
    { range: 1, damage: 95, movement: 0 }, // Mining Drill (v1 Plasma Cannon: range 2, damage 80) — range 1 is deliberate (decided 2026-09-21): adjacent-only, so the bridge accuracy bonus never helps it
    { range: 0, damage: 0, movement: 0 }, // future1 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future2 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future3 (inert filler)
    { range: 0, damage: 0, movement: 0 }, // future4 (inert filler)
  ];
  const variant2Armors = [
    { damageReduction: 0, movement: 1 }, // None (v1: 0% / move +1, unchanged; the once-only no-gear bonus)
    { damageReduction: 20, movement: 0 }, // Light (v1: 15% / move 0)
    { damageReduction: 40, movement: -1 }, // Medium (v1: 30% / move -1)
    { damageReduction: 60, movement: -3 }, // Heavy (v1: 45% / move -2)
    { damageReduction: 0, movement: 0 }, // future1 (inert filler)
    { damageReduction: 0, movement: 0 }, // future2 (inert filler)
    { damageReduction: 0, movement: 0 }, // future3 (inert filler)
    { damageReduction: 0, movement: 0 }, // future4 (inert filler)
  ];
  const variant2Shields = [
    { damageReduction: 0, movement: 0 }, // None (v1: 0% / move 0, unchanged; movement never read — see variant1Armors)
    { damageReduction: 20, movement: 0 }, // Light (v1: 15% / move +1)
    { damageReduction: 40, movement: -1 }, // Medium (v1: 30% / move 0)
    { damageReduction: 60, movement: -2 }, // Heavy (v1: 45% / move -1)
    { damageReduction: 0, movement: 0 }, // future1 (inert filler)
    { damageReduction: 0, movement: 0 }, // future2 (inert filler)
    { damageReduction: 0, movement: 0 }, // future3 (inert filler)
    { damageReduction: 0, movement: 0 }, // future4 (inert filler)
  ];
  // Kills needed for ranks 2..6, and stat bonus % for ranks 1..6 (applied to
  // range/damage/hull/movement/damage-reduction). Thresholds must be
  // strictly ascending; bonuses are capped at 100 by the contract.
  // GenerateNewShip seeds prize-ship kill counts in ranges aligned to these
  // thresholds (1-9 / 10-29 / 30-99 / 100-299), and TutorialClaim assumes
  // 10 kills = rank 2 — retuning the thresholds shifts which rank those
  // land on.
  const variant2RankThresholds = [10, 30, 100, 300, 1000];
  const variant2RankBonusPct = [0, 10, 20, 30, 40, 50];

  const setCostsVariant2Call = m.call(
    shipAttributes,
    "setCosts",
    [
      2, // variant
      {
        version: 0,
        baseCost: 50,
        accuracy: [0, 10, 25],
        hull: [0, 10, 25],
        speed: [0, 10, 25],
        // Slots 4-7 are the inert `future*` filler (see header note).
        mainWeapon: [25, 30, 40, 40, 25, 25, 25, 25],
        armor: [0, 5, 10, 15, 0, 0, 0, 0],
        shields: [0, 10, 20, 30, 0, 0, 0, 0],
        special: variant2SpecialCosts,
      },
    ],
    { id: "SetCostsVariant2" },
  );

  const setVariant2AttributesCall = m.call(
    shipAttributes,
    "setVariantAttributes",
    [
      {
        variant: 2,
        baseHull: 125,
        baseSpeed: 3,
        foreAccuracy: [0, 25, 50],
        hull: [0, 12, 25],
        engineSpeeds: [0, 1, 2],
        guns: variant2Guns,
        armors: variant2Armors,
        shields: variant2Shields,
        rankThresholds: variant2RankThresholds,
        rankBonusPct: variant2RankBonusPct,
        specials: [
          { range: 0, strength: 0, movement: 0 }, // None
          { range: 2, strength: 1, movement: 0 }, // Slot1: ElectricStorm
          { range: 5, strength: 40, movement: 0 }, // Slot2: DroneSwarm
          { range: 0, strength: 0, movement: 3 }, // Slot3: AdditionalThruster
          { range: 0, strength: 0, movement: 0 }, // Slot4 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot5 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot6 (unused)
          { range: 0, strength: 0, movement: 0 }, // Slot7 (unused)
        ],
      },
    ],
    { id: "SetVariant2Attributes" },
  );

  // Authorize PvPMatch to record results into GameResults (PvPMatch
  // records PvP results, not core Game.sol). Widened to an allowlist
  // (2026-09-28) — see GameResults.sol's isAllowedRecorder comment and the
  // engine-registry plan.
  const setGameResultsGameContractCall = m.call(
    gameResults,
    "setIsAllowedRecorder",
    [pvpMatch, true],
  );

  // Set Game address in Maps contract
  // Widened to an allowlist (2026-09-28) — see Maps.sol's isAllowedGame
  // comment and the engine-registry plan.
  const setMapsGameAddressCall = m.call(maps, "setIsAllowedGame", [
    game,
    true,
  ]);

  // Allow the designated map editor wallet to create/edit preset maps
  const allowMapEditorCall = m.call(maps, "setMapEditor", [MAP_EDITOR, true], {
    id: "AllowMapEditor",
  });

  // Reuse the same map-editor wallet as the AI-encounters content admin
  const allowAIEncounterEditorCall = m.call(
    aiEncounters,
    "setEncounterEditor",
    [MAP_EDITOR, true],
    { id: "AllowAIEncounterEditor" },
  );

  // Reuse the same map-editor wallet as the campaign-node graph admin
  const allowNodeEditorCall = m.call(
    nodeMap,
    "setNodeEditor",
    [MAP_EDITOR, true],
    { id: "AllowNodeEditor" },
  );

  // Let SinglePlayerMatch record node completions on a human win
  const allowSinglePlayerMatchToCompleteNodesCall = m.call(
    nodeMap,
    "setIsAllowedToCompleteNodes",
    [singlePlayerMatch, true],
    { id: "AllowSinglePlayerMatchToCompleteNodes" },
  );

  // --- Starter single-player content --------------------------------------
  // Neither preset maps nor AIEncounters ship configs are otherwise seeded
  // anywhere — both are meant to be curated post-deploy by the MAP_EDITOR
  // wallet via the permission calls just above. Without at least one of
  // each, a fresh deployment has zero maps and zero AI configs, so
  // single-player is unusable (setupAIFleet always reverts with
  // NoAIPlacementsConfigured) until someone manually creates content. The
  // actual content (maps, AI ship configs, placements, campaign nodes)
  // lives in ignition/data/singlePlayerStarterContent.json so it can be
  // edited without touching this file; this block just walks that data and
  // issues the same calls the old hardcoded version did. MAP_EDITOR can
  // still add/replace maps and configs post-deploy — this isn't exclusive
  // of that.
  //
  // No AI Rammer config in the JSON: the AI has no decision path for
  // Archetype.Rammer (SinglePlayerMatch._decideMove falls through to the
  // default engage-or-approach logic for it, same as any unhandled
  // archetype) — player-controlled Rammer ships and RamResolver are
  // unaffected.

  // createPresetScoringMap/createFullPresetMap rather than the overloaded
  // createPresetMap: Hardhat Ignition can't disambiguate an overload whose
  // signature contains a struct/tuple array (its function-name validator
  // rejects the nested parens before it ever reaches ABI resolution), and
  // there's nothing to disambiguate here anyway since each of these is the
  // only function with that name.
  //
  // Neither call emits its new id and neither is a view function, so
  // there's no event/staticCall to read an id from — but each map's id is
  // safe to compute as its 1-indexed position in the JSON array, since
  // these are the only map-creation calls in this module, mapCount starts
  // at 0 on a fresh Maps deployment, and each call is forced (via `after`)
  // to run strictly after the previous one so they can't land out of order.
  // Types.sol's MapMode enum, mirrored here so the JSON can use readable
  // strings instead of magic numbers — keep in sync if MapMode changes.
  const MAP_MODE: Record<string, number> = { PvP: 0, PvE: 1, Both: 2 };

  // Every roguelike Combat node has its own dedicated map (2026-09-23 pass)
  // — none share a campaign map's data any more, though several still share
  // that map's AI roster (same configKeys, different terrain; see
  // roguelikeStarterContent.json's mapPlacements). PvP maps (pvpStarterContent.json)
  // aren't attached to any campaign/roguelike node — they're only ever
  // selected directly via Lobbies.createLobby's mapId, so they need no
  // mapPlacements (no AI ships in PvP) and no node/edge wiring at all. All
  // three lists are appended in this fixed order so the "id is 1-indexed
  // array position" guess below stays trustworthy for all of them. Keys
  // must be unique across all three lists.
  const allMaps: any[] = [
    ...starterContent.maps,
    ...roguelikeStarterContent.maps,
    ...pvpStarterContent.maps,
  ];
  const allMapPlacements: any[] = [
    ...starterContent.mapPlacements,
    ...roguelikeStarterContent.mapPlacements,
  ];
  const mapCalls: Record<string, ReturnType<typeof m.call>> = {};
  const mapIds: Record<string, bigint> = {};
  allMaps.forEach((map, i) => {
    const mapId = BigInt(i + 1);
    const previousMapCall = i > 0 ? mapCalls[allMaps[i - 1].key] : undefined;
    const mode = MAP_MODE[map.mode];
    const call =
      map.type === "scoring"
        ? m.call(maps, "createPresetScoringMap", [map.scoringTiles, mode], {
            id: `Create${map.key[0].toUpperCase()}${map.key.slice(1)}Map`,
            ...(previousMapCall ? { after: [previousMapCall] } : {}),
          })
        : m.call(
            maps,
            "createFullPresetMap",
            [
              map.blockedTiles ?? [],
              map.impassableTiles ?? [],
              map.scoringTiles,
              mode,
            ],
            {
              id: `Create${map.key[0].toUpperCase()}${map.key.slice(1)}Map`,
              ...(previousMapCall ? { after: [previousMapCall] } : {}),
            },
          );
    mapCalls[map.key] = call;
    mapIds[map.key] = mapId;
  });

  // Custom deployment-zone shape, per map (2026-09-23 pass). Additive
  // setters on an already-created map (Maps.sol's setCreatorZone/
  // setJoinerZone), not creation params, so each only needs
  // `after: [its own map's creation call]` — none of them create a new map,
  // so unlike the loop above they carry no risk to the "id is array
  // position" guess and can run in any order relative to each other. An
  // empty creatorZone/joinerZone means "use the engine default column
  // band" (Maps.sol's own convention), so those calls are skipped entirely
  // rather than sent as a no-op empty-array write.
  allMaps.forEach((map) => {
    const capitalizedKey = `${map.key[0].toUpperCase()}${map.key.slice(1)}`;
    if (map.creatorZone?.length) {
      m.call(maps, "setCreatorZone", [mapIds[map.key], map.creatorZone], {
        id: `SetCreatorZone${capitalizedKey}`,
        after: [mapCalls[map.key]],
      });
    }
    if (map.joinerZone?.length) {
      m.call(maps, "setJoinerZone", [mapIds[map.key], map.joinerZone], {
        id: `SetJoinerZone${capitalizedKey}`,
        after: [mapCalls[map.key]],
      });
    }
  });

  const aiConfigCalls: ReturnType<typeof m.call>[] = [];
  const aiConfigIds: Record<
    string,
    ReturnType<typeof m.readEventArgument>
  > = {};
  for (const config of starterContent.aiShipConfigs) {
    const capitalizedKey = `${config.key[0].toUpperCase()}${config.key.slice(1)}`;
    const call = m.call(
      aiEncounters,
      "createAIShipConfig",
      [
        config.name,
        config.equipment,
        {
          serialNumber: 0n,
          colors: starterContent.aiShipColors,
          ...config.traits,
        },
        config.archetype,
      ],
      { id: `Create${capitalizedKey}AIShipConfig` },
    );
    aiConfigCalls.push(call);
    aiConfigIds[config.key] = m.readEventArgument(
      call,
      "AIShipConfigCreated",
      "configId",
      { emitter: aiEncounters, id: `Read${capitalizedKey}ConfigId` },
    );
  }

  // Default cap is 8; the hardest campaign nodes (asteroidField,
  // warlordsRedoubt, gauntlet, bastion) need up to 14 ships to actually
  // reach their intended difficulty within the available config levels
  // (I-V), so raise the live knob once here before placing any fleet.
  const setMaxPlacementsPerMapCall = m.call(
    aiEncounters,
    "setMaxPlacementsPerMap",
    [14n],
  );

  const placementCalls: ReturnType<typeof m.call>[] = [];
  for (const placement of allMapPlacements) {
    const capitalizedKey = `${placement.mapKey[0].toUpperCase()}${placement.mapKey.slice(1)}`;
    placementCalls.push(
      m.call(
        aiEncounters,
        "setMapPlacements",
        [
          mapIds[placement.mapKey],
          placement.positions,
          placement.configKeys.map((k: string) => aiConfigIds[k]),
        ],
        {
          id: `Place${capitalizedKey}AIFleet`,
          after: [mapCalls[placement.mapKey], setMaxPlacementsPerMapCall],
        },
      ),
    );
  }

  // Campaigns are just a grouping label for nodes (see NodeMap.sol's
  // header comment) — created first, in JSON order, so nodes below can
  // reference their campaign's id. campaignId is 1-indexed position, same
  // "no event to read" reasoning as maps/nodes elsewhere in this file.
  const campaignCalls: Record<string, ReturnType<typeof m.call>> = {};
  const campaignIds: Record<string, bigint> = {};
  starterContent.campaigns.forEach((campaign, i) => {
    const capitalizedKey = `${campaign.key[0].toUpperCase()}${campaign.key.slice(1)}`;
    // Chained to the previous campaign call for the same reason node
    // creation is below: keeps the "id is array position" guess trustworthy
    // even though createCampaign calls have no other dependency between
    // them that would otherwise force this order.
    const previousCampaignCall =
      i > 0 ? campaignCalls[starterContent.campaigns[i - 1].key] : undefined;
    const call = m.call(nodeMap, "createCampaign", [], {
      id: `Create${capitalizedKey}Campaign`,
      ...(previousCampaignCall ? { after: [previousCampaignCall] } : {}),
    });
    campaignCalls[campaign.key] = call;
    campaignIds[campaign.key] = BigInt(i + 1);
  });

  // The Shattered Hive campaign (mainCampaign) fields variant-2 AI fleets
  // (see docs/faction-2.md section 8) but is a variant-1 human story — a
  // human fleet must be all variant-1 ships to enter any of its nodes.
  // Enforced in SinglePlayerMatch.startNodeMatch, not here (see NodeMap.
  // setCampaignRequiredVariant's comment); this call just configures it.
  const setMainCampaignRequiredVariantCall = m.call(
    nodeMap,
    "setCampaignRequiredVariant",
    [campaignIds["mainCampaign"], 1],
    {
      id: "SetMainCampaignRequiredVariant",
      after: [campaignCalls["mainCampaign"]],
    },
  );

  // Seeds the campaign graph so the frontend has a real unlock graph out of
  // the box: nodes are created in the JSON's order, each node's id is its
  // 1-indexed position (same "no event to read" reasoning as the maps
  // above), and "prerequisites" references other nodes by key, which
  // requires the JSON to list a node after everything it depends on (same
  // requirement the old hardcoded version had). MAP_EDITOR can add more
  // nodes/branches afterward via NodeMap.createNode/addPrerequisite.
  // costLimit/turnTime/maxScore are curated here rather than player-chosen
  // — see NodeMap.sol's header comment for why.
  // The "id is 1-indexed array position" trick only holds if createNode
  // calls actually execute on-chain in that same order. With branching
  // (a dead end and a shortcut both hanging off an early node, as below),
  // Ignition is otherwise free to interleave independent branches' calls
  // however its scheduler likes — confirmed this by deploying a 30-node
  // graph and finding two adjacent branches' node ids swapped relative to
  // array position. Forcing every node to also depend on the previous
  // node in array order (same trick already used for maps below) makes
  // execution strictly sequential regardless of the *logical* prerequisite
  // graph, so the array-position id guess stays trustworthy.
  const nodeCalls: Record<string, ReturnType<typeof m.call>> = {};
  const nodeIds: Record<string, bigint> = {};
  starterContent.campaignNodes.forEach((node, i) => {
    const capitalizedKey = `${node.key[0].toUpperCase()}${node.key.slice(1)}`;
    const prerequisiteIds = node.prerequisites.map((k) => nodeIds[k]);
    const previousNodeCall =
      i > 0 ? nodeCalls[starterContent.campaignNodes[i - 1].key] : undefined;
    const call = m.call(
      nodeMap,
      "createNode",
      [
        campaignIds[node.campaignKey],
        mapIds[node.mapKey],
        prerequisiteIds,
        node.costLimit,
        node.turnTime,
        node.maxScore,
        node.creatorGoesFirst,
      ],
      {
        id: `Create${capitalizedKey}`,
        after: [
          campaignCalls[node.campaignKey],
          mapCalls[node.mapKey],
          ...node.prerequisites.map((k) => nodeCalls[k]),
          ...(previousNodeCall ? [previousNodeCall] : []),
        ],
      },
    );
    nodeCalls[node.key] = call;
    nodeIds[node.key] = BigInt(i + 1);
  });

  // ---- Roguelike campaign -------------------------------------------------
  // RoguelikeNodeMap is deployed with zero content by default (unlike
  // NodeMap above) — without at least one campaign + root Combat node,
  // RoguelikeMatch.startRun always reverts CampaignNotFound/
  // CampaignHasNoRoot, so a player could never begin a run. Seeds a 35-node
  // graph (30 Combat + 5 Resupply) shaped like the existing NodeMap
  // campaign — same map layouts and turnTime/maxScore/creatorGoesFirst per
  // map, same main-spine (m01-m15) /
  // dead-end-branch (d01-d06) / shortcut-branch (s01-s03) / finale-spine
  // (f01-f06) shape — but translated into RoguelikeNodeMap's parent-lists-
  // children + branch-lockout model instead of NodeMap's ANY-of-prerequisite
  // model: the branch choice at m02 (continue / dead-end / shortcut) is a
  // real one-way commitment here, not a freely-replayable side path, and
  // f01 is a child of both m15 and s03 (whichever path reconverges there
  // first) mirroring NodeMap's ['m15','s03'] OR-prerequisite the same way.
  // Resupply nodes are new here (NodeMap has no such thing) — inserted at
  // one checkpoint per branch, since a 15-hop main spine with zero repair
  // opportunity would be unplayable given roguelike damage persists across
  // the whole run. See ignition/data/roguelikeStarterContent.json for the
  // full node/edge data; MAP_EDITOR can extend the graph further afterward.
  //
  // ENEMY PROGRESSION: the first three missions on any path fight variant 1
  // ships; every later mission fights variant 2. A node's mission number is
  // the count of Combat nodes from the root to it, inclusive (m01 = 1, m02 = 2,
  // then m03 / d01 / s01 = 3 on their respective branches, everything deeper
  // is 4+). Nodes m01, m02, m03, d01 and s01 therefore use the roguelike-only
  // maps (rlM01, rlM02, rlM03, rlD01, rlS01) with variant-1 rosters; the rest
  // share the campaign maps, whose rosters are variant 2. Killing variant-1
  // ships pays no DEC (only variant 2 has a reward token registered). See
  // docs/roguelike-progression.md, and test/RoguelikeProgression.test.ts,
  // which checks this rule against the deployed graph.
  const roguelikeContent = roguelikeStarterContent;

  const createRoguelikeCampaignCall = m.call(
    roguelikeNodeMap,
    "createCampaign",
    [],
    { id: "CreateRoguelikeCampaign" },
  );
  const roguelikeCampaignId = 1n;

  const setRoguelikeInitialCostCapCall = m.call(
    roguelikeNodeMap,
    "setCampaignInitialCostCap",
    [roguelikeCampaignId, BigInt(roguelikeContent.campaign.initialCostCap)],
    {
      id: "SetRoguelikeInitialCostCap",
      after: [createRoguelikeCampaignCall],
    },
  );
  const setRoguelikeAutoHealPercentCall = m.call(
    roguelikeNodeMap,
    "setCampaignAutoHealPercent",
    [roguelikeCampaignId, roguelikeContent.campaign.autoHealPercent],
    {
      id: "SetRoguelikeAutoHealPercent",
      after: [createRoguelikeCampaignCall],
    },
  );
  const setRoguelikeRequiredVariantCall = m.call(
    roguelikeNodeMap,
    "setCampaignRequiredVariant",
    [roguelikeCampaignId, roguelikeContent.campaign.requiredVariant],
    {
      id: "SetRoguelikeRequiredVariant",
      after: [createRoguelikeCampaignCall],
    },
  );

  // RoguelikeNodeKind mirrored here so this file doesn't need a Solidity
  // import — keep in sync if RoguelikeNodeMap.sol's enum changes.
  const ROGUELIKE_NODE_KIND: Record<string, number> = {
    Combat: 0,
    Resupply: 1,
  };

  // Same "id is 1-indexed array position" reasoning as NodeMap's node loop
  // above — each createNode call is forced (via `after`) to run strictly
  // after the previous one, so Ignition's scheduler can't interleave these
  // and desync the id guess from creation order (see this file's own
  // comment on the NodeMap loop, and the hardhat-ignition-execution-order
  // Cursor rule / CLAUDE.md section for the incident that taught us this).
  const roguelikeNodeCalls: Record<string, ReturnType<typeof m.call>> = {};
  const roguelikeNodeIds: Record<string, bigint> = {};
  roguelikeContent.nodes.forEach((node: any, i: number) => {
    const capitalizedKey = `${node.key[0].toUpperCase()}${node.key.slice(1)}`;
    const previousNodeCall =
      i > 0 ? roguelikeNodeCalls[roguelikeContent.nodes[i - 1].key] : undefined;
    const isCombat = node.kind === "Combat";
    const call = m.call(
      roguelikeNodeMap,
      "createNode",
      [
        roguelikeCampaignId,
        ROGUELIKE_NODE_KIND[node.kind],
        isCombat ? mapIds[node.mapKey] : 0n,
        isCombat ? BigInt(node.turnTime) : 0n,
        isCombat ? BigInt(node.maxScore) : 0n,
        isCombat ? node.creatorGoesFirst : false,
        isCombat ? 0n : BigInt(node.costCapOverride),
      ],
      {
        id: `CreateRoguelike${capitalizedKey}Node`,
        after: [
          createRoguelikeCampaignCall,
          ...(isCombat ? [mapCalls[node.mapKey], ...placementCalls] : []),
          ...(previousNodeCall ? [previousNodeCall] : []),
        ],
      },
    );
    roguelikeNodeCalls[node.key] = call;
    roguelikeNodeIds[node.key] = BigInt(i + 1);
  });

  const setRoguelikeRootCall = m.call(
    roguelikeNodeMap,
    "setCampaignRoot",
    [roguelikeCampaignId, roguelikeNodeIds[roguelikeContent.root]],
    {
      id: "SetRoguelikeRoot",
      after: [roguelikeNodeCalls[roguelikeContent.root]],
    },
  );

  // Edges only need both endpoints to already exist (order among edges
  // themselves doesn't affect any id-guessing), but each is still chained
  // to the previous edge call purely to keep this loop's `after` lists
  // short — every edge already depends on the full node-creation loop via
  // its `from`/`to` node calls.
  const roguelikeEdgeCalls: ReturnType<typeof m.call>[] = [];
  roguelikeContent.edges.forEach((edge: any, i: number) => {
    const call = m.call(
      roguelikeNodeMap,
      "addChild",
      [roguelikeNodeIds[edge.from], roguelikeNodeIds[edge.to]],
      {
        id: `AddRoguelikeEdge${i + 1}`,
        after: [
          roguelikeNodeCalls[edge.from],
          roguelikeNodeCalls[edge.to],
          ...(i > 0 ? [roguelikeEdgeCalls[i - 1]] : []),
        ],
      },
    );
    roguelikeEdgeCalls.push(call);
  });

  // ---- Roguelike win effects ---------------------------------------------
  // Optional seed field (2026-10-02), written by the frontend's mission seed
  // export (void-tactics-fe app/utils/missionSeedExport.ts): `winEffects`
  // (catalog keys, run in order) on roguelike nodes. Nodes without it are
  // skipped, so seed files without this field deploy exactly as before.
  // Map names and node titles/descriptions are frontend-only display data
  // (removed from the contracts 2026-10-08) — the seed files may still
  // carry them, but nothing here writes them on-chain.

  // Catalog keys match the frontend's WIN_EFFECT_CATALOG (app/hooks/useWinEffects.ts).
  const WIN_EFFECTS_BY_KEY: Record<
    string,
    | typeof decBonusWinEffect
    | typeof healAboveFloorWinEffect
    | typeof shipGrantWinEffect
  > = {
    DEC_BONUS_WIN_EFFECT: decBonusWinEffect,
    HEAL_ABOVE_FLOOR_WIN_EFFECT: healAboveFloorWinEffect,
    SHIP_GRANT_WIN_EFFECT: shipGrantWinEffect,
  };
  const roguelikeWinEffectCalls: ReturnType<typeof m.call>[] = [];
  roguelikeContent.nodes.forEach((node: any) => {
    const effectKeys: string[] = node.winEffects ?? [];
    if (effectKeys.length === 0) return;
    const effects = effectKeys.map((k) => {
      const effect = WIN_EFFECTS_BY_KEY[k];
      if (!effect) {
        throw new Error(`Roguelike node "${node.key}" lists unknown win effect "${k}"`);
      }
      return effect;
    });
    const capitalizedKey = `${node.key[0].toUpperCase()}${node.key.slice(1)}`;
    roguelikeWinEffectCalls.push(
      m.call(
        roguelikeNodeMap,
        "setNodeWinEffects",
        [roguelikeNodeIds[node.key], effects],
        {
          id: `SetRoguelike${capitalizedKey}WinEffects`,
          after: [roguelikeNodeCalls[node.key]],
        },
      ),
    );
  });

  // Shattered Hive Campaign medal: soulbound, awarded via player-initiated
  // claimMedal() once the campaign's true final node (f06 — the end of the
  // reconverged m/s/f storyline, not d06's dead-end branch; see
  // singlePlayerStarterContent.json) has been completed. Deployed after the
  // node-seeding loop above so nodeIds["f06"] is populated; the constructor
  // arg is just a JS-side number by this point (createNode's own `after`
  // chaining is what makes nodeIds trustworthy in the first place), but the
  // deploy is still ordered after f06's own createNode call for good measure.
  const shatteredHiveMedal = m.contract(
    "ShatteredHiveMedal",
    [nodeMap, nodeIds["f06"]],
    { after: [nodeCalls["f06"]] },
  );

  // On-chain art for the medal, referenced via an owner-settable address
  // (not a constructor param) so it can be swapped later without
  // redeploying ShatteredHiveMedal itself — see ShatteredHiveMedal.sol's
  // `art` field / setArtAddress.
  const shatteredHiveMedalArt = m.contract("ShatteredHiveMedalArt");
  const setShatteredHiveMedalArtCall = m.call(
    shatteredHiveMedal,
    "setArtAddress",
    [shatteredHiveMedalArt],
    { id: "SetShatteredHiveMedalArt" },
  );

  // Gate variant-2 purchases on holding the medal.
  const setVariant2GateCall = m.call(variantPurchaseGate, "setRequiredNft", [
    2,
    shatteredHiveMedal,
  ]);
  // Node reward ships go to any winner, whatever the variant (2026-10-19).
  const exemptShipGrantWinEffectCall = m.call(
    variantPurchaseGate,
    "setExemptMinter",
    [shipGrantWinEffect, true],
    { id: "ExemptShipGrantWinEffectFromVariantGate" },
  );

  // Variant 2 AI kills pay DEC. Variant 1 intentionally has no reward token
  // registered yet — DestroyRewardLib pays nothing for those kills until one
  // is added here later, with no ShipsRouter/DestroyRewardLib redeploy.
  const setVariant2RewardTokenCall = m.call(
    factionRewardTokenRegistry,
    "setRewardToken",
    [2, droneEnergyCores],
  );

  // Set PvPMatch address in Lobbies contract
  const setLobbiesPvpMatchAddressCall = m.call(lobbies, "setPvpMatchAddress", [
    pvpMatch,
  ]);

  // Set Lobbies address in PvPMatch contract
  const setPvpMatchLobbiesAddressCall = m.call(pvpMatch, "setLobbiesAddress", [
    lobbies,
  ]);

  // Allow SinglePlayerMatch to allocate AI ships from AIShips' pool (it no
  // longer touches Ships.sol at all — its fleets live entirely in AIShips)
  const allowSinglePlayerMatchToCreateAIShipsCall = m.call(
    aiShips,
    "setIsAllowedToCreateShips",
    [singlePlayerMatch, true],
    { id: "AllowSinglePlayerMatchToCreateAIShips" },
  );

  // Set Fleets address in Lobbies contract
  const setLobbiesFleetsAddressCall = m.call(lobbies, "setFleetsAddress", [
    fleets,
  ]);

  // Set Maps address in Lobbies contract
  const setLobbiesMapsAddressCall = m.call(lobbies, "setMapsAddress", [maps]);

  // Set UniversalCredits address in Lobbies contract
  const setLobbiesUniversalCreditsAddressCall = m.call(
    lobbies,
    "setUniversalCreditsAddress",
    [universalCredits],
  );

  // Authorize Lobbies (PvP) and SinglePlayerMatch (vs-AI node matches) to
  // create/clear fleets
  const allowLobbiesToManageFleetsCall = m.call(
    fleets,
    "setIsAllowedToManageFleets",
    [lobbies, true],
    { id: "AllowLobbiesToManageFleets" },
  );
  const allowSinglePlayerMatchToManageFleetsCall = m.call(
    fleets,
    "setIsAllowedToManageFleets",
    [singlePlayerMatch, true],
    { id: "AllowSinglePlayerMatchToManageFleets" },
  );

  // Authorize Game itself to manage fleets directly (removeShipFromFleet/
  // clearFleet, for ship-destruction/game-end cleanup) — folded into the
  // same allowlist as the orchestrators above (2026-09-28) rather than a
  // dedicated single-address `gameAddress` slot, so a future engine's own
  // Game instance can be authorized the same way without touching Fleets
  // again. See the engine-registry plan.
  const allowGameToManageFleetsCall = m.call(
    fleets,
    "setIsAllowedToManageFleets",
    [game, true],
    { id: "AllowGameToManageFleets" },
  );

  // Set ShipAttributes address in Fleets contract
  const setFleetsShipAttributesCall = m.call(fleets, "setShipAttributes", [
    shipAttributes,
  ]);

  // Set Maps address in Fleets contract — lets createFleet validate
  // starting positions against a map's own deployment zone (falls back to
  // the historical hardcoded column rule for any map with no custom zone).
  const setFleetsMapsAddressCall = m.call(fleets, "setMapsAddress", [maps]);

  // Allow ShipPurchaser to create ships
  const allowShipPurchaserToCreateShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [shipPurchaser, true],
  );

  // Allow DroneYard to modify ships
  const allowDroneYardToModifyShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [droneYard, true],
    { id: "AllowDroneYardToModifyShips" },
  );

  const allowTutorialClaimToCreateShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [tutorialClaim, true],
    { id: "AllowTutorialClaimToCreateShips" },
  );

  // Allow the Firebase Flow backend minter to create ships (same as ShipPurchaser)
  const allowFirebaseFlowMinterToCreateShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [FIREBASE_FLOW_MINTER, true],
    { id: "AllowFirebaseFlowMinterToCreateShips" },
  );

  const setTutorialClaimOnGameResultsCall = m.call(
    gameResults,
    "setTutorialClaimContract",
    [tutorialClaim],
    { id: "SetTutorialClaimOnGameResults" },
  );

  // Only 2 variants exist: variant 1 (default/tutorial faction) and
  // variant 2 (the new faction); default maxVariant is 1
  const setMaxVariantForTutorialShipsCall = m.call(
    ships,
    "setMaxVariant",
    [2],
    {
      id: "SetMaxVariantForTutorialShips",
    },
  );

  // ---- Roguelike reward ships ----------------------------------------------
  // Optional seed field (2026-10-20), written by the frontend's mission seed
  // export: `shipGrant` on a roguelike node is its ShipGrantWinEffect.ShipGrant
  // (the ship a win there mints). Nodes without it get no grant. After
  // setMaxVariant, since setGrant rejects variants above Ships.maxVariant().
  const roguelikeShipGrantCalls: ReturnType<typeof m.call>[] = [];
  roguelikeContent.nodes.forEach((node: any) => {
    const g = node.shipGrant;
    if (!g) return;
    const capitalizedKey = `${node.key[0].toUpperCase()}${node.key.slice(1)}`;
    roguelikeShipGrantCalls.push(
      m.call(
        shipGrantWinEffect,
        "setGrant",
        [
          roguelikeNodeIds[node.key],
          {
            name: g.name,
            equipment: g.equipment,
            colors: g.colors,
            variant: g.variant,
            accuracy: g.accuracy,
            hull: g.hull,
            speed: g.speed,
            shipsDestroyed: g.shipsDestroyed,
            shiny: g.shiny,
            isFreeShip: g.isFreeShip,
            oncePerAddress: g.oncePerAddress,
          },
        ],
        {
          id: `SetRoguelike${capitalizedKey}ShipGrant`,
          after: [roguelikeNodeCalls[node.key], setMaxVariantForTutorialShipsCall],
        },
      ),
    );
  });

  // Enable minting for UniversalCredits
  const setMintIsActiveCall = m.call(universalCredits, "setMintIsActive", [
    true,
  ]);

  // Allow ShipPurchaser and Ships to mint UniversalCredits (Ships still
  // mints UTC directly for shipBreaker, unrelated to destroy rewards)
  const authorizeShipPurchaserToMintCall = m.call(
    universalCredits,
    "setAuthorizedToMint",
    [shipPurchaser, true],
    { id: "AuthorizeShipPurchaserToMint" },
  );
  const authorizeShipsToMintCall = m.call(
    universalCredits,
    "setAuthorizedToMint",
    [ships, true],
    { id: "AuthorizeShipsToMint" },
  );
  // ShipsRouter now performs the DestroyRewardLib call itself (it's the
  // only place that can see both ships' owners regardless of which backing
  // contract holds them), so it — not Ships.sol — needs UTC minting rights
  // for the AI-destroys-human reward direction.
  const authorizeShipsRouterToMintUtcCall = m.call(
    universalCredits,
    "setAuthorizedToMint",
    [shipsRouter, true],
    { id: "AuthorizeShipsRouterToMintUtc" },
  );

  // Enable minting for DroneEnergyCores and allow ShipsRouter (via
  // DestroyRewardLib, now called from the router instead of Ships.sol) to
  // mint it
  const setDecMintIsActiveCall = m.call(droneEnergyCores, "setMintIsActive", [
    true,
  ]);
  const authorizeShipsRouterToMintDecCall = m.call(
    droneEnergyCores,
    "setAuthorizedToMint",
    [shipsRouter, true],
    { id: "AuthorizeShipsRouterToMintDec" },
  );

  // FreeShipClaim.claimFreeShips reads a player's bonus directly from
  // DroneStorefront.droneCoreTier (1 tier = +1 ship).
  const setFreeShipClaimDroneStorefrontCall = m.call(
    freeShipClaim,
    "setDroneStorefront",
    [droneStorefront],
  );

  // eligibilityProvider mirrors the shipNames/worldId mock-vs-real split:
  // local/test deploys wire a mock that's always permissive, keeping
  // FreeShipClaim.claimFreeShips's/TutorialClaim's provider-wired code path
  // exercised by the shared fixture without depending on the real Selfie
  // Check backend-relay infrastructure (which has no on-chain verification
  // path of its own — see SelfieCheckEligibilityProvider.sol).
  //
  // Decided (2026-09-11): ONE eligibilityProvider instance is shared by both
  // FreeShipClaim and TutorialClaim, not one each — verifying once makes a
  // player eligible for both for the same 90-day window.
  //
  // Production (2026-09-11): deploys the real SelfieCheckEligibilityProvider,
  // owned by the deployer initially and handed to MAP_EDITOR in the
  // ownership-handover block below, same as every other Ownable contract in
  // this module. Reuses FIREBASE_FLOW_MINTER as the authorized verifier too
  // (per explicit direction) — the same backend wallet already trusted to
  // mint ships directly now also relays Selfie Check verification, rather
  // than provisioning a second backend signer just for this. Note:
  // FIREBASE_FLOW_MINTER/MAP_EDITOR are today's dev-time placeholder
  // addresses, not final production keys — see docs/pre-audit.md's
  // "Addendum — Admin/Backend Key Separation for Production Deploy" for the
  // plan to replace all of these with distinct, purpose-specific keys before
  // a real deploy.
  let eligibilityProvider: any;
  let setSelfieCheckAuthorizedVerifierCall: any;
  if (!PRODUCTION) {
    eligibilityProvider = m.contract("MockAlwaysEligible");
  } else {
    eligibilityProvider = m.contract("SelfieCheckEligibilityProvider", [
      m.getAccount(0),
    ]);
    setSelfieCheckAuthorizedVerifierCall = m.call(
      eligibilityProvider,
      "setAuthorizedVerifier",
      [FIREBASE_FLOW_MINTER, true],
      { id: "SetSelfieCheckAuthorizedVerifier" },
    );
  }
  // Skipped entirely on a production deploy with verification disabled (see
  // CLAIM_ELIGIBILITY_VERIFICATION_ENABLED) — an unset provider is "off".
  const wireEligibilityProvider =
    !PRODUCTION || CLAIM_ELIGIBILITY_VERIFICATION_ENABLED;
  const setFreeShipClaimEligibilityProviderCall = wireEligibilityProvider
    ? m.call(freeShipClaim, "setEligibilityProvider", [eligibilityProvider], {
        id: "SetFreeShipClaimEligibilityProvider",
      })
    : undefined;
  const setTutorialClaimEligibilityProviderCall = wireEligibilityProvider
    ? m.call(tutorialClaim, "setEligibilityProvider", [eligibilityProvider], {
        id: "SetTutorialClaimEligibilityProvider",
      })
    : undefined;

  // FreeShipClaim mints through Ships' existing authorized-minter allowlist,
  // same as DroneYard/ShipPurchaser/TutorialClaim.
  const allowFreeShipClaimToCreateShipsCall = m.call(
    ships,
    "setIsAllowedToCreateShips",
    [freeShipClaim, true],
    { id: "AllowFreeShipClaimToCreateShips" },
  );

  // Seed the drone-core turn-in tier ladder: cumulative cost to reach tier N
  // grants +N to a player's permanent free-ship bonus (see
  // DroneStorefront.turnInCores / FreeShipClaim.claimFreeShips). Costs ramp
  // ~1.76x per tier so tier 1 is reachable in a handful of AI kills while
  // the top tier takes a very long time to earn — tune via addTier
  // post-deploy. DEC is a freely transferable ERC20 (not soulbound), so a
  // player can also just buy cores from someone else's grind instead of
  // earning them directly — see DroneEnergyCores.sol.
  const droneCoreTierCosts = [10, 20, 30, 55, 95, 170, 300, 525, 925, 1625];
  const addTierCalls: ReturnType<typeof m.call>[] = [];
  droneCoreTierCosts.forEach((cost, index) => {
    const previousAddTierCall = index > 0 ? addTierCalls[index - 1] : undefined;
    const call = m.call(droneStorefront, "addTier", [cost], {
      id: `AddDroneCoreTier${index + 1}`,
      ...(previousAddTierCall ? { after: [previousAddTierCall] } : {}),
    });
    addTierCalls.push(call);
  });

  // Let SinglePlayerMatch withdraw the UTC it accumulates whenever the AI
  // (owner of its own ships) destroys a human ship — DestroyRewardLib only
  // pays DEC for the reverse case (a player destroying an AI ship).
  const setSinglePlayerMatchUniversalCreditsAddressCall = m.call(
    singlePlayerMatch,
    "setUniversalCreditsAddress",
    [universalCredits],
  );

  // Lets startNodeMatch read a human fleet's variant (against
  // NodeMap.campaignRequiredVariant) before starting a match — distinct
  // from `ships` on SinglePlayerMatch, which is AIShips (the AI's own pool).
  const setSinglePlayerMatchHumanShipsAddressCall = m.call(
    singlePlayerMatch,
    "setHumanShipsAddress",
    [ships],
  );

  // WARNING: This works for deploying but breaks the tests for some reason.
  // Purchase tier 4 for the deployer
  // m.call(
  //   ships,
  //   "purchaseWithFlow",
  //   [
  //     "0x69a5B3aE8598fC5A5419eaa1f2A59Db2D052e346",
  //     4,
  //     "0x69a5B3aE8598fC5A5419eaa1f2A59Db2D052e346",
  //   ],
  //   { value: parseEther("99.99") }
  // );

  // m.call(ships, "constructAllMyShips");

  // Re-price ship tiers in ETH for a real Base deploy, using a live ETH/USD
  // price fetched at deploy time (see getEthUsdPrice()/computeTierPricesWei()
  // above and docs/UTC_Price_Prediction_10k_Players.md). Both Ships.sol and
  // ShipPurchaser.sol default to the same stale "4.99/9.99/... ether"
  // constructor literal, which only prices ships near $1 each if 1 native
  // token ≈ $1 USD — false for ETH on Base. Gated to PRODUCTION only:
  // applying this unconditionally would move tier prices out from under
  // every existing test that pays an exact parseEther("4.99")-style amount
  // against the constructor defaults.
  let setShipsPurchaseInfoCall: any;
  let setShipPurchaserPurchaseInfoCall: any;
  if (PRODUCTION) {
    const tierPricesWei = computeTierPricesWei(getEthUsdPrice());

    setShipsPurchaseInfoCall = m.call(
      ships,
      "setPurchaseInfo",
      [TIER_SHIPS, tierPricesWei],
      { id: "SetShipsPurchaseInfo" },
    );

    // ETH prices go only into ShipPurchaser's native-token array
    // (purchaseUTCWithFlow). Its UTC prices (purchaseWithUTC) keep the
    // constructor's 4.99/9.99/... UTC: writing ETH-sized numbers there, as
    // this used to via setPurchaseInfo, sold 5 ships for ~0.002 UTC, which
    // recycle for 0.5 UTC (found 2026-10-23).
    setShipPurchaserPurchaseInfoCall = m.call(
      shipPurchaser,
      "setFlowTierPrices",
      [tierPricesWei],
      { id: "SetShipPurchaserFlowTierPrices" },
    );
  }

  // World ID router. Toggle between the two lines below (same pattern as
  // `shipNames` above):
  //   - Local / tests: deploy the mock (no real proofs available).
  //   - Real network:  comment the mock, uncomment the router address so the
  let worldId: any;
  //                     Tournament is deployed pointing at the real router.
  // Base Sepolia (chain 84532) testnet WorldIDRouter, verified against World ID docs.
  if (!PRODUCTION) {
    worldId = m.contract("MockWorldID");
  } else {
    worldId = "0x42FF98C4E85212a5D31358ACbFe76a621b50fC02";
  }
  // const worldId = "0x42FF98C4E85212a5D31358ACbFe76a621b50fC02";

  const tournament = m.contract("Tournament", [
    worldId,
    TOURNAMENT_WORLD_ID_GROUP,
    TOURNAMENT_EXTERNAL_NULLIFIER,
    gameResults,
    game,
    m.getAccount(0), // feeRecipient (protocol fee sink) == deployer
    randomManager, // backs the round-1 pairing shuffle in buildBracket()
  ]);

  // Deploy GameBlobRegistry — stores Walrus blobId per player per completed game
  const gameBlobRegistry = m.contract("GameBlobRegistry", [
    gameResults,
    FIREBASE_FLOW_MINTER,
  ]);

  // GameEngineRegistry (2026-09-28): registers this deploy's `game` as the
  // first "engine" and authorizes its three orchestrators to record each
  // new game they start — see GameEngineRegistry.sol/the engine-registry
  // plan for the full rationale. A future gameplay-rules upgrade deploys a
  // new Game + orchestrators, registers that as a new engine here, and
  // points setEngineRegistry/currentEngine at it, without touching
  // anything deployed in this module again.
  const gameEngineRegistry = m.contract("GameEngineRegistry");
  const registerFirstEngineCall = m.call(
    gameEngineRegistry,
    "registerEngine",
    [game, "v1", true],
    { id: "RegisterFirstEngine" },
  );
  const allowPvPMatchToRecordCall = m.call(
    gameEngineRegistry,
    "setIsAllowedToRecord",
    [pvpMatch, true],
    { id: "AllowPvPMatchToRecord" },
  );
  const allowSinglePlayerMatchToRecordCall = m.call(
    gameEngineRegistry,
    "setIsAllowedToRecord",
    [singlePlayerMatch, true],
    { id: "AllowSinglePlayerMatchToRecord" },
  );
  const allowRoguelikeMatchToRecordCall = m.call(
    gameEngineRegistry,
    "setIsAllowedToRecord",
    [roguelikeMatch, true],
    { id: "AllowRoguelikeMatchToRecord" },
  );
  const setPvpMatchEngineRegistryCall = m.call(
    pvpMatch,
    "setEngineRegistry",
    [gameEngineRegistry],
    { id: "SetPvpMatchEngineRegistry" },
  );
  const setSinglePlayerMatchEngineRegistryCall = m.call(
    singlePlayerMatch,
    "setEngineRegistry",
    [gameEngineRegistry],
    { id: "SetSinglePlayerMatchEngineRegistry" },
  );
  const setRoguelikeMatchEngineRegistryCall = m.call(
    roguelikeMatch,
    "setEngineRegistry",
    [gameEngineRegistry],
    { id: "SetRoguelikeMatchEngineRegistry" },
  );
  // UA-12 fix (2026-09-29): lets Maps.setBlockedTile/setImpassableTile/
  // setScoringTile refuse a debug tile edit against an already-ended game —
  // see Maps.sol's own comment on engineRegistry/_gameHasEnded.
  const setMapsEngineRegistryCall = m.call(
    maps,
    "setEngineRegistry",
    [gameEngineRegistry],
    { id: "SetMapsEngineRegistry" },
  );

  if (PRODUCTION) {
    // --- Ownership handover ------------------------------------------------
    // Every Ownable contract above defaults to Ownable(msg.sender) — the
    // deployer. As the very last step of a real deploy, transfer owner() on
    // all of them to the designated production wallet (reusing MAP_EDITOR's
    // address). Ignition does not guarantee execution order between
    // independent calls on the same contract — only real dependency edges do
    // (see PlaceStarterAIFleet's `after` above) — so each transferOwnership
    // call explicitly depends on every owner-gated call already made against
    // that contract, guaranteeing it lands after all of them instead of
    // racing in the same batch.
    //
    // Note: RamResolver has its own hand-rolled owner (not OpenZeppelin's
    // Ownable) and has no setOwner/transferOwnership function at all, so it
    // can't be included here — its ownership isn't transferable in the
    // contract as written.
    m.call(ships, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShipsOwnership",
      after: [
        setShipsConfigCall,
        allowShipPurchaserToCreateShipsCall,
        allowDroneYardToModifyShipsCall,
        allowTutorialClaimToCreateShipsCall,
        allowFirebaseFlowMinterToCreateShipsCall,
        setMaxVariantForTutorialShipsCall,
        allowFreeShipClaimToCreateShipsCall,
        allowShipGrantWinEffectToCreateShipsCall,
        setShipsPurchaseInfoCall,
      ],
    });

    m.call(aiShips, "transferOwnership", [MAP_EDITOR], {
      id: "TransferAIShipsOwnership",
      after: [
        setAiShipsShipAttributesCall,
        setAiShipsRouterCall,
        allowSinglePlayerMatchToCreateAIShipsCall,
        allowRoguelikeMatchToCreateAIShipsCall,
      ],
    });

    m.call(shipsRouter, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShipsRouterOwnership",
      after: [
        setShipsRouterGameAddressCall,
        setShipsRouterFleetsAddressCall,
        setShipsRouterLobbyAddressCall,
      ],
    });

    m.call(shipAttributes, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShipAttributesOwnership",
      after: [
        setShipAttributesShipsAddressCall,
        setCostsVariant1Call,
        setCostsVariant2Call,
        setVariant1AttributesCall,
        setVariant2AttributesCall,
      ],
    });

    m.call(metadataRenderer, "transferOwnership", [MAP_EDITOR], {
      id: "TransferMetadataRendererOwnership",
      after: [
        setEMPNameCall,
        setRepairDronesNameCall,
        setFlakArrayNameCall,
        setElectricStormNameCall,
        setDroneSwarmNameCall,
        setAdditionalThrusterNameCall,
        setLaserNameV1Call,
        setRailgunNameV1Call,
        setMissileLauncherNameV1Call,
        setPlasmaCannonNameV1Call,
        setLaserNameV2Call,
        setRailgunNameV2Call,
        setMissileLauncherNameV2Call,
        setPlasmaCannonNameV2Call,
        setLightArmorNameV1Call,
        setMediumArmorNameV1Call,
        setHeavyArmorNameV1Call,
        setLightArmorNameV2Call,
        setMediumArmorNameV2Call,
        setHeavyArmorNameV2Call,
        setLightShieldsNameV1Call,
        setMediumShieldsNameV1Call,
        setHeavyShieldsNameV1Call,
        setLightShieldsNameV2Call,
        setMediumShieldsNameV2Call,
        setHeavyShieldsNameV2Call,
      ],
    });

    m.call(shipPurchaser, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShipPurchaserOwnership",
      after: [setShipPurchaserPurchaseInfoCall],
    });

    m.call(generateNewShip, "transferOwnership", [MAP_EDITOR], {
      id: "TransferGenerateNewShipOwnership",
      after: [setGenerateNewShipGameContractCall],
    });

    m.call(droneYard, "transferOwnership", [MAP_EDITOR], {
      id: "TransferDroneYardOwnership",
      after: [setDroneYardGameContractCall],
    });

    m.call(maps, "transferOwnership", [MAP_EDITOR], {
      id: "TransferMapsOwnership",
      after: [
        setMapsGameAddressCall,
        allowMapEditorCall,
        setMapsEngineRegistryCall,
        ...Object.values(mapCalls),
      ],
    });

    m.call(aiEncounters, "transferOwnership", [MAP_EDITOR], {
      id: "TransferAIEncountersOwnership",
      after: [allowAIEncounterEditorCall, ...aiConfigCalls, ...placementCalls],
    });

    m.call(gameResults, "transferOwnership", [MAP_EDITOR], {
      id: "TransferGameResultsOwnership",
      after: [
        setGameResultsGameContractCall,
        setTutorialClaimOnGameResultsCall,
      ],
    });

    m.call(game, "transferOwnership", [MAP_EDITOR], {
      id: "TransferGameOwnership",
      after: [
        setGameAddressesCall,
        allowPvPMatchToStartGamesCall,
        allowSinglePlayerMatchToStartGamesCall,
        allowRoguelikeMatchToStartGamesCall,
        setFactionAbilityResolverCall,
        setFaction2AbilityResolverCall,
        setEMPResolverCall,
        setRepairDronesResolverCall,
        setFlakArrayResolverCall,
        setElectricStormResolverCall,
        setDroneSwarmResolverCall,
        setMaxSpecialSlotVariant1Call,
        setMaxSpecialSlotVariant2Call,
      ],
    });

    m.call(fleets, "transferOwnership", [MAP_EDITOR], {
      id: "TransferFleetsOwnership",
      after: [
        allowLobbiesToManageFleetsCall,
        allowSinglePlayerMatchToManageFleetsCall,
        allowRoguelikeMatchToManageFleetsCall,
        allowRoguelikeResupplyToManageFleetsCall,
        allowGameToManageFleetsCall,
        setFleetsShipAttributesCall,
        setFleetsMapsAddressCall,
      ],
    });

    m.call(lobbies, "transferOwnership", [MAP_EDITOR], {
      id: "TransferLobbiesOwnership",
      after: [
        setLobbiesPvpMatchAddressCall,
        setLobbiesFleetsAddressCall,
        setLobbiesMapsAddressCall,
        setLobbiesUniversalCreditsAddressCall,
      ],
    });

    m.call(pvpMatch, "transferOwnership", [MAP_EDITOR], {
      id: "TransferPvPMatchOwnership",
      after: [setPvpMatchLobbiesAddressCall, setPvpMatchEngineRegistryCall],
    });

    m.call(singlePlayerMatch, "transferOwnership", [MAP_EDITOR], {
      id: "TransferSinglePlayerMatchOwnership",
      after: [
        setSinglePlayerMatchUniversalCreditsAddressCall,
        setSinglePlayerMatchHumanShipsAddressCall,
        setSinglePlayerMatchAIRegistryCall,
        setSinglePlayerMatchEngineRegistryCall,
      ],
    });

    // The registry and both variant AIs are Ownable (registry: who can point
    // a faction at a new AI; AIs: their config addresses) — hand them to the
    // same editor wallet as everything else, after the registrations above.
    m.call(aiBehaviorRegistry, "transferOwnership", [MAP_EDITOR], {
      id: "TransferAIBehaviorRegistryOwnership",
      after: [setVariant1AICall, setVariant2AICall],
    });

    // RandomManager is Ownable only for retargetExpired (re-targeting ship
    // rolls that missed the 256-block window — docs/audit-3.md HA6-19).
    m.call(randomManager, "transferOwnership", [MAP_EDITOR], {
      id: "TransferRandomManagerOwnership",
    });

    m.call(variant1AI, "transferOwnership", [MAP_EDITOR], {
      id: "TransferVariant1AIOwnership",
    });

    m.call(variant2AI, "transferOwnership", [MAP_EDITOR], {
      id: "TransferVariant2AIOwnership",
    });

    m.call(nodeMap, "transferOwnership", [MAP_EDITOR], {
      id: "TransferNodeMapOwnership",
      after: [
        allowNodeEditorCall,
        allowSinglePlayerMatchToCompleteNodesCall,
        setMainCampaignRequiredVariantCall,
        ...Object.values(nodeCalls),
      ],
    });

    m.call(roguelikeNodeMap, "transferOwnership", [MAP_EDITOR], {
      id: "TransferRoguelikeNodeMapOwnership",
      after: [
        allowRoguelikeNodeEditorCall,
        setRoguelikeInitialCostCapCall,
        setRoguelikeAutoHealPercentCall,
        setRoguelikeRequiredVariantCall,
        setRoguelikeRootCall,
        setRoguelikeRunLedgerCall,
        ...roguelikeEdgeCalls,
        ...roguelikeWinEffectCalls,
      ],
    });

    m.call(roguelikeRun, "transferOwnership", [MAP_EDITOR], {
      id: "TransferRoguelikeRunOwnership",
      after: [
        allowRoguelikeMatchToModifyRunsCall,
        allowRoguelikeResupplyToModifyRunsCall,
        allowHealAboveFloorWinEffectToModifyRunsCall,
      ],
    });

    m.call(roguelikeMatch, "transferOwnership", [MAP_EDITOR], {
      id: "TransferRoguelikeMatchOwnership",
      after: [setRoguelikeMatchEngineRegistryCall],
    });

    m.call(gameEngineRegistry, "transferOwnership", [MAP_EDITOR], {
      id: "TransferGameEngineRegistryOwnership",
      after: [
        registerFirstEngineCall,
        allowPvPMatchToRecordCall,
        allowSinglePlayerMatchToRecordCall,
        allowRoguelikeMatchToRecordCall,
      ],
    });

    m.call(roguelikeResupply, "transferOwnership", [MAP_EDITOR], {
      id: "TransferRoguelikeResupplyOwnership",
      after: [setRepairCostPerHPCall],
    });

    m.call(decBonusWinEffect, "transferOwnership", [MAP_EDITOR], {
      id: "TransferDecBonusWinEffectOwnership",
      after: [
        allowRoguelikeMatchToTriggerDecBonusCall,
      ],
    });

    m.call(healAboveFloorWinEffect, "transferOwnership", [MAP_EDITOR], {
      id: "TransferHealAboveFloorWinEffectOwnership",
      after: [
        allowRoguelikeMatchToTriggerHealAboveFloorCall,
      ],
    });

    m.call(shipGrantWinEffect, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShipGrantWinEffectOwnership",
      after: [
        allowRoguelikeMatchToTriggerShipGrantCall,
        ...roguelikeShipGrantCalls,
      ],
    });

    m.call(
      singlePlayerOrchestratorRegistry,
      "transferOwnership",
      [MAP_EDITOR],
      {
        id: "TransferSinglePlayerOrchestratorRegistryOwnership",
        after: [
          registerSinglePlayerMatchOrchestratorCall,
          registerRoguelikeMatchOrchestratorCall,
        ],
      },
    );

    m.call(variantPurchaseGate, "transferOwnership", [MAP_EDITOR], {
      id: "TransferVariantPurchaseGateOwnership",
      after: [setVariant2GateCall, exemptShipGrantWinEffectCall],
    });

    m.call(factionRewardTokenRegistry, "transferOwnership", [MAP_EDITOR], {
      id: "TransferFactionRewardTokenRegistryOwnership",
      after: [setVariant2RewardTokenCall],
    });

    m.call(shatteredHiveMedal, "transferOwnership", [MAP_EDITOR], {
      id: "TransferShatteredHiveMedalOwnership",
      after: [setShatteredHiveMedalArtCall],
    });

    m.call(universalCredits, "transferOwnership", [MAP_EDITOR], {
      id: "TransferUniversalCreditsOwnership",
      after: [
        setMintIsActiveCall,
        authorizeShipPurchaserToMintCall,
        authorizeShipsToMintCall,
        authorizeShipsRouterToMintUtcCall,
      ],
    });

    m.call(droneEnergyCores, "transferOwnership", [MAP_EDITOR], {
      id: "TransferDroneEnergyCoresOwnership",
      after: [
        setDecMintIsActiveCall,
        authorizeShipsRouterToMintDecCall,
        authorizeDecBonusWinEffectToMintDecCall,
      ],
    });

    m.call(droneStorefront, "transferOwnership", [MAP_EDITOR], {
      id: "TransferDroneStorefrontOwnership",
      after: [...addTierCalls],
    });

    m.call(tournament, "transferOwnership", [MAP_EDITOR], {
      id: "TransferTournamentOwnership",
    });

    m.call(gameBlobRegistry, "transferOwnership", [MAP_EDITOR], {
      id: "TransferGameBlobRegistryOwnership",
    });

    // FreeShipClaim/TutorialClaim were missing from this handover (found
    // 2026-09-22): the map admin is supposed to be able to turn free-ship
    // eligibility gating on/off (setEligibilityProvider) the same way it
    // controls everything else, but without these two calls both contracts
    // stayed owned by the deployer forever.
    // The eligibility-provider set calls are undefined when verification is
    // disabled (CLAIM_ELIGIBILITY_VERIFICATION_ENABLED), so drop them from
    // the dependency lists rather than depending on a call that doesn't exist.
    m.call(freeShipClaim, "transferOwnership", [MAP_EDITOR], {
      id: "TransferFreeShipClaimOwnership",
      after: [
        setFreeShipClaimDroneStorefrontCall,
        ...(setFreeShipClaimEligibilityProviderCall
          ? [setFreeShipClaimEligibilityProviderCall]
          : []),
      ],
    });

    m.call(tutorialClaim, "transferOwnership", [MAP_EDITOR], {
      id: "TransferTutorialClaimOwnership",
      after: setTutorialClaimEligibilityProviderCall
        ? [setTutorialClaimEligibilityProviderCall]
        : [],
    });

    m.call(eligibilityProvider, "transferOwnership", [MAP_EDITOR], {
      id: "TransferSelfieCheckEligibilityProviderOwnership",
      after: [
        ...(setFreeShipClaimEligibilityProviderCall
          ? [setFreeShipClaimEligibilityProviderCall]
          : []),
        ...(setTutorialClaimEligibilityProviderCall
          ? [setTutorialClaimEligibilityProviderCall]
          : []),
        setSelfieCheckAuthorizedVerifierCall,
      ],
    });
  }

  return {
    randomManager,
    gameLens,
    renderSpecial1,
    renderSpecial2,
    renderSpecial3,
    renderAft0,
    renderAft1,
    renderAft2,
    renderWeapon1,
    renderWeapon2,
    renderWeapon3,
    renderWeapon4,
    renderShield1,
    renderShield2,
    renderShield3,
    renderArmor1,
    renderArmor2,
    renderArmor3,
    renderFore0,
    renderFore1,
    renderFore2,
    renderForePerfect,
    renderSpecial,
    renderAft,
    renderWeapon,
    renderBody,
    renderFore,
    imageRenderer,
    renderSpecial1V2,
    renderSpecial2V2,
    renderSpecial3V2,
    renderAft0V2,
    renderAft1V2,
    renderAft2V2,
    renderWeapon1V2,
    renderWeapon2V2,
    renderWeapon3V2,
    renderWeapon4V2,
    renderFore0V2,
    renderFore1V2,
    renderFore2V2,
    renderForePerfectV2,
    renderShield1V2,
    renderShield2V2,
    renderShield3V2,
    renderArmor1V2,
    renderArmor2V2,
    renderArmor3V2,
    renderBaseBodyV2,
    renderSpecialV2,
    renderAftV2,
    renderWeaponV2,
    renderBodyV2,
    renderForeV2,
    imageRendererV2,
    metadataRenderer,
    shipNames,
    droneNames,
    generateNewShip,
    ships,
    aiShips,
    shipsRouter,
    shipAttributes,
    universalCredits,
    droneEnergyCores,
    droneStorefront,
    shipPurchaser,
    droneYard,
    maps,
    gameResults,
    game,
    gameEngineRegistry,
    pvpMatch,
    singlePlayerMatch,
    fleets,
    lobbies,
    nodeMap,
    roguelikeNodeMap,
    roguelikeRun,
    aiBehaviorRegistry,
    variant1AI,
    variant2AI,
    roguelikeMatch,
    roguelikeResupply,
    decBonusWinEffect,
    healAboveFloorWinEffect,
    shipGrantWinEffect,
    singlePlayerOrchestratorRegistry,
    variantPurchaseGate,
    factionRewardTokenRegistry,
    shatteredHiveMedal,
    shatteredHiveMedalArt,
    tutorialClaim,
    freeShipClaim,
    eligibilityProvider,
    worldId,
    tournament,
    gameBlobRegistry,
    specialEffectsLib,
    destroyRewardLib,
    ramResolver,
    repairResolver,
    empResolver,
    repairDronesResolver,
    flakArrayResolver,
    electricStormResolver,
    droneSwarmResolver,
    aiEncounters,
  };
});

export default DeployModule;
