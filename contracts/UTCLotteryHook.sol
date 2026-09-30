// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import "./IShips.sol";
import "./IRandomManager.sol";
import "./Types.sol";

// UTCLotteryHook — the pool + lottery half of the Uniswap pick
// (docs/eth-global-remote-strategy-v2.md, Pick 3). No fee-to-treasury, no
// active peg defense — both were considered and rejected on their own
// merits (see the strategy doc). This hook does exactly one thing: every
// UTC->native ("sell") swap on the one pool it's bound to earns the seller
// weighted entry into a periodic drawing for a prize ship, funded by nothing
// but chance — no funds are taken, no swap economics are altered.
//
// Direction: currency0 is always the native token (Currency.wrap(address(0))
// sorts below every real token address per CurrencyLibrary's convention), so
// `!params.zeroForOne` unambiguously means "trader is providing UTC to the
// pool" — a sell. This is deliberately the *only* direction that earns
// entries: it's also exactly the trade direction that already defends the
// existing passive mint-arbitrage price ceiling (ShipPurchaser.tierPrices),
// so this reinforces that mechanic instead of competing with it, and does
// nothing for the (intentionally undefended) floor.
//
// Single-pool lock: a hook address is permissionless to reference from *any*
// pool someone else creates, not just the one this project intends — an
// attacker could otherwise point a throwaway pool (two tokens they fully
// control) at this same hook address and farm lottery entries for free,
// completely decoupled from real UTC/ETH activity. beforeInitialize is
// implemented purely to close that: it locks onto the first pool that
// initializes with this hook (and only if its currencies actually match the
// configured UTC/native pair), and reverts every later initialize attempt
// for any other pool. afterSwap independently re-checks the pool id anyway —
// cheap, and makes the invariant explicit at the point it actually matters.
contract UTCLotteryHook is BaseHook, Ownable {
    using BalanceDeltaLibrary for BalanceDelta;

    IShips public ships;
    IRandomManager public randomManager;
    address public immutable utcToken;

    bool public poolLocked;
    PoolId public lockedPoolId;

    // Minimum ETH proceeds (native-token side of the swap) a single sell
    // must clear to earn an entry, denominated in wei — deliberately in ETH,
    // not UTC, so a period of low UTC price can't make entries artificially
    // cheap. Owner-configurable; defaults to 0.01 ETH.
    uint256 public minEntryThresholdWei = 0.01 ether;

    // Ceiling on how much weight a single qualifying sell can credit toward
    // one address's entry, independent of the real (uncapped) ETH proceeds
    // — bounds how much a single trade (flash-loaned or genuinely funded)
    // can inflate one address's odds (see docs/audit-2.md HA2-06). Only
    // caps recorded *weight*; the qualifying-threshold check above still
    // uses the real, uncapped proceeds. Owner-configurable; defaults to
    // 100x minEntryThresholdWei's default.
    uint256 public maxWeightPerEntryWei = 1 ether;

    // Floors resolveDraw's random-pick denominator at
    // maxWinProbabilityDenominator * maxWeightPerEntryWei, so no single
    // address's (already-capped) weight can ever exceed a
    // 1/maxWinProbabilityDenominator share of a draw — regardless of how
    // few other participants show up. A random pick landing beyond the
    // real participants' cumulative weight means nobody wins that specific
    // draw (see DrawResolvedNoWinner below); the next qualifying sell just
    // starts accumulating toward the next draw as usual, no special
    // "rollover" needed. Owner-configurable; defaults to 10 (never better
    // than a 1-in-10 chance).
    uint256 public maxWinProbabilityDenominator = 10;

    // A draw only starts once ALL of these hold: at least drawInterval has
    // elapsed since the last draw started, AND the draw has accumulated at
    // least minParticipants distinct qualifying sellers, AND at least
    // minTotalWeightWei total qualifying volume. Time alone is deliberately
    // not enough — if a draw hasn't reached eligibility once drawInterval
    // has passed, it simply keeps running (no state changes, no reset)
    // until it does, checked again on each subsequent qualifying swap. All
    // three are owner-configurable.
    uint256 public drawInterval = 24 hours;
    uint256 public minParticipants = 3;
    uint256 public minTotalWeightWei;
    uint256 public lastDrawTime;
    uint256 public currentDrawId;

    // Weight = ETH proceeds of a qualifying sell (not raw UTC amount) — the
    // same figure the entry threshold is checked against, so a manipulated
    // or crashed UTC price can't inflate weight independent of real value
    // contributed. One entry per address per draw, sized to that address's
    // single best (highest) qualifying sell in the period — not a sum
    // across all their trades — see _recordSell.
    mapping(uint256 => address[]) public drawParticipants;
    mapping(uint256 => mapping(address => bool)) public hasParticipated;
    mapping(uint256 => mapping(address => uint256)) public weightInDraw;
    mapping(uint256 => uint256) public totalWeightInDraw;
    mapping(uint256 => uint256) public drawRandomRequestId;
    mapping(uint256 => bool) public drawResolved;

    // "1-of-a-kind" resolved: the owner can queue up to MAX_QUEUE_SIZE
    // hand-crafted ship templates (queuePrizeTemplate); each resolved draw
    // dequeues the oldest one (FIFO) and mints it via Ships.createSpecificShip
    // (not the generic random-rolled createShips every other mint path
    // uses), so a queued prize is a genuinely distinct template, not just a
    // random ship sharing a common variant/tier with ones sold elsewhere.
    // Provenance/distinctiveness across repeated draws also comes from the
    // name, which embeds the draw id ("Legendary Draw #N") — see
    // _buildPrizeShip.
    //
    // If the queue is empty when a draw resolves, the prize falls back to a
    // single random "4-star" ship instead — concretely, Ships.createShips's
    // own existing tier-based rank logic: calling createShips(winner, 1,
    // fallbackVariant, 4, false) gives amount=1 the tier-4 rank count's
    // *first* (i==0) slot, which is rank 5 — the same top rank the first
    // ship in a real tier-4 pack purchase gets via _getKillsForRank — using
    // the ordinary random-generation path (constructShip still reveals its
    // actual stats later, same as any other purchased ship), not a
    // hand-crafted template. No new generation logic needed — this reuses
    // Ships.sol's existing, already-authorized rank mechanism exactly as
    // purchaseWithFlow does for a tier-4 pack's best slot.
    struct PrizeTemplate {
        uint16 variant;
        Colors colors;
        uint8 accuracy;
        uint8 hull;
        uint8 speed;
        MainWeapon mainWeapon;
        Armor armor;
        Shields shields;
        Special special;
    }

    uint256 public constant MAX_QUEUE_SIZE = 5;
    mapping(uint256 => PrizeTemplate) public prizeQueue;
    uint256 public queueHead;
    uint256 public queueTail;

    // Variant used only for the random-4-star fallback path (createShips
    // still requires one). Owner-configurable, defaults to 1 (present in
    // every fixture/deploy this repo uses).
    uint16 public fallbackVariant = 1;

    event SellRecorded(
        uint256 indexed drawId,
        address indexed player,
        uint256 ethProceeds,
        uint256 playerWeightInDraw
    );
    event DrawStarted(uint256 indexed drawId, uint256 requestId, uint256 totalWeight);
    event DrawResolved(uint256 indexed drawId, address indexed winner);
    event DrawResolvedNoWinner(uint256 indexed drawId);
    // HA4-02 fix (2026-09-28): emitted instead of DrawResolved when the
    // picked winner can't actually receive the prize (e.g. a contract that
    // reverts in onERC721Received) — see resolveDraw's own comment.
    event PrizeMintFailed(uint256 indexed drawId, address indexed winner);
    event PrizeQueued(uint256 indexed queueIndex);
    event PrizeQueueCleared();

    error NotOurPool();
    error PoolAlreadyLocked();
    error DrawAlreadyResolved(uint256 drawId);
    error DrawNotStarted(uint256 drawId);
    error NoParticipants(uint256 drawId);
    error InvalidPrizeVariant(uint16 variant);
    error ArmorAndShieldsBothSet();
    error InvalidPrizeStatTier();
    error PrizeQueueFull();

    constructor(
        IPoolManager _poolManager,
        address _ships,
        address _randomManager,
        address _utcToken,
        address _initialOwner
    ) BaseHook(_poolManager) Ownable(_initialOwner) {
        ships = IShips(_ships);
        randomManager = IRandomManager(_randomManager);
        utcToken = _utcToken;
        lastDrawTime = block.timestamp;
        // Queue starts empty — no seeded default template. An empty queue
        // is a fully-defined, intentional state (the random-4-star
        // fallback), not something that needs a placeholder to avoid.
    }

    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    function _beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160
    ) internal override returns (bytes4) {
        // `sender` is the real, original caller of PoolManager.initialize()
        // (PoolManager.initialize forwards its own msg.sender here — see
        // Hooks.beforeInitialize in @uniswap/v4-core), NOT this contract's
        // own msg.sender (which would be PoolManager itself, since it calls
        // the hook directly). Without this check, PoolManager.initialize is
        // fully permissionless on the real network, so any third party who
        // notices this hook deployed (before this project's own deploy
        // script gets to call initialize) could permanently lock it to a
        // bogus, liquidity-free pool with no on-chain recovery — see
        // docs/audit-2.md HA2-02. Reuses Ownable's own error for
        // consistency with every other access-control revert in this
        // contract.
        if (sender != owner()) revert OwnableUnauthorizedAccount(sender);
        if (poolLocked) {
            revert PoolAlreadyLocked();
        }
        if (
            Currency.unwrap(key.currency0) != address(0) ||
            Currency.unwrap(key.currency1) != utcToken
        ) {
            revert NotOurPool();
        }
        lockedPoolId = key.toId();
        poolLocked = true;
        return BaseHook.beforeInitialize.selector;
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        if (!poolLocked || PoolId.unwrap(key.toId()) != PoolId.unwrap(lockedPoolId)) {
            revert NotOurPool();
        }

        // Only the UTC->native direction earns entries. Buys (native->UTC)
        // are deliberately never recorded — see the file header.
        if (!params.zeroForOne) {
            (address player, bool valid) = _extractPlayer(hookData);
            if (valid) {
                _recordSell(player, delta);
            }
            // Deliberately not an error/revert if hookData is missing or
            // malformed: the swap itself must never fail because of this.
            // Worst case with no valid player, the trade just earns no
            // lottery entry — which is also exactly what happens before the
            // frontend/router is updated to pass hookData at all. See the
            // header comment on _extractPlayer for why sender/tx.origin are
            // deliberately not used as a fallback here.
        }

        _maybeStartDraw();

        return (BaseHook.afterSwap.selector, 0);
    }

    // The `sender` PoolManager passes to afterSwap is whatever contract
    // called swap() directly — in practice a router (e.g. Uniswap's
    // UniversalRouter), not the end trader, so it's useless for attributing
    // an entry to a real person. tx.origin was considered and rejected: it
    // misattributes any trade made through a smart-contract wallet (this
    // project already uses Dynamic for wallet auth, so that's a real case,
    // not a hypothetical), and is a well-known phishing-adjacent anti-pattern
    // besides. hookData is v4's own mechanism for exactly this — the
    // swap-initiating call (frontend via its router) is expected to pass the
    // real trader's address as `abi.encode(address)`, 32 bytes exactly.
    function _extractPlayer(
        bytes calldata hookData
    ) internal pure returns (address player, bool valid) {
        if (hookData.length != 32) {
            return (address(0), false);
        }
        player = abi.decode(hookData, (address));
        valid = player != address(0);
    }

    function _recordSell(address _player, BalanceDelta _delta) internal {
        int128 rawAmount0 = _delta.amount0();
        uint256 ethProceeds = uint256(
            uint128(rawAmount0 < 0 ? -rawAmount0 : rawAmount0)
        );

        if (ethProceeds < minEntryThresholdWei) {
            return;
        }

        uint256 drawId = currentDrawId;
        if (!hasParticipated[drawId][_player]) {
            hasParticipated[drawId][_player] = true;
            drawParticipants[drawId].push(_player);
        }

        // Weight actually credited toward lottery odds is capped at
        // maxWeightPerEntryWei, independent of the real (uncapped)
        // ethProceeds reported in the event below — see docs/audit-2.md
        // HA2-06. Bounds how much a single sell (flash-loaned or genuine)
        // can inflate one address's odds; the qualifying-threshold check
        // above already ran against the real, uncapped proceeds.
        uint256 cappedProceeds = ethProceeds > maxWeightPerEntryWei
            ? maxWeightPerEntryWei
            : ethProceeds;

        // Ticket size is the player's single best qualifying sell in the
        // draw, not a running sum — a newer, higher-value sell replaces it;
        // a newer but lower (or equal) one leaves the existing ticket alone.
        // This is deliberate: summing would let an address inflate its odds
        // by splitting one large sell into many smaller ones instead of one
        // trade actually being bigger.
        uint256 previousWeight = weightInDraw[drawId][_player];
        if (cappedProceeds > previousWeight) {
            totalWeightInDraw[drawId] =
                totalWeightInDraw[drawId] -
                previousWeight +
                cappedProceeds;
            weightInDraw[drawId][_player] = cappedProceeds;
        }

        emit SellRecorded(drawId, _player, ethProceeds, weightInDraw[drawId][_player]);
    }

    function _maybeStartDraw() internal {
        uint256 drawId = currentDrawId;
        // totalWeightInDraw[drawId] == 0 is checked explicitly, not just
        // implied by minTotalWeightWei/minParticipants, since both of those
        // are owner-configurable down to 0 — this floor always applies
        // regardless of configuration, so a draw can never start with
        // nothing in it.
        if (
            block.timestamp < lastDrawTime + drawInterval ||
            totalWeightInDraw[drawId] == 0 ||
            totalWeightInDraw[drawId] < minTotalWeightWei ||
            drawParticipants[drawId].length < minParticipants
        ) {
            return;
        }

        uint256 requestId = randomManager.requestRandomness();
        drawRandomRequestId[drawId] = requestId;
        lastDrawTime = block.timestamp;
        currentDrawId = drawId + 1;

        emit DrawStarted(drawId, requestId, totalWeightInDraw[drawId]);
    }

    // Permissionless, like Tournament.buildBracket — anyone can trigger
    // resolution once RandomManager's entropy window has opened; reverts
    // TooSoonToReveal (from RandomManager itself) if called too early.
    function resolveDraw(uint256 _drawId) external {
        if (drawResolved[_drawId]) {
            revert DrawAlreadyResolved(_drawId);
        }
        uint256 requestId = drawRandomRequestId[_drawId];
        if (requestId == 0) {
            revert DrawNotStarted(_drawId);
        }
        uint256 totalWeight = totalWeightInDraw[_drawId];
        address[] storage participants = drawParticipants[_drawId];
        if (totalWeight == 0 || participants.length == 0) {
            revert NoParticipants(_drawId);
        }

        uint64 randomness = randomManager.fulfillRandomRequest(requestId);

        // Floors the pick's denominator so no single address's (already
        // capped, see _recordSell) weight can ever exceed a
        // 1/maxWinProbabilityDenominator share of this draw, regardless of
        // how thin real participation is (see docs/audit-2.md HA2-06). A
        // target landing beyond the real participants' cumulative weight
        // (only possible when real weight is thin relative to the floor)
        // means nobody wins this draw — the next qualifying sell simply
        // starts accumulating toward the next draw as usual.
        uint256 effectiveTotalWeight = maxWinProbabilityDenominator *
            maxWeightPerEntryWei;
        if (totalWeight > effectiveTotalWeight) {
            effectiveTotalWeight = totalWeight;
        }
        uint256 target = uint256(randomness) % effectiveTotalWeight;

        drawResolved[_drawId] = true;

        if (target >= totalWeight) {
            emit DrawResolvedNoWinner(_drawId);
            return;
        }

        address winner = participants[participants.length - 1];
        uint256 cumulative;
        for (uint256 i = 0; i < participants.length; i++) {
            cumulative += weightInDraw[_drawId][participants[i]];
            if (target < cumulative) {
                winner = participants[i];
                break;
            }
        }

        // HA4-02 fix (2026-09-28): the mint is wrapped in try/catch instead
        // of called bare. `drawResolved[_drawId] = true` above still isn't
        // enough on its own — a revert here unwinds the ENTIRE transaction,
        // including that write — so without this, a picked winner that's a
        // contract reverting on ERC-721 receipt (trivial and cheap for any
        // participant to arrange for themselves via `hookData`, see
        // _extractPlayer) would permanently brick this exact draw forever:
        // fulfillRandomRequest returns the same fixed value on every retry,
        // so the same winner gets picked every time. Falling through to
        // PrizeMintFailed instead lets the draw resolve either way — the
        // only one who loses out is the winner who made themselves
        // unable to receive it, not every other honest participant.
        // A queued curated template is only dequeued on success, so a
        // failed mint doesn't burn it — it stays queued for the next draw.
        if (queueTail > queueHead) {
            PrizeTemplate memory t = prizeQueue[queueHead];
            try ships.createSpecificShip(winner, _buildPrizeShip(_drawId, t)) returns (uint) {
                delete prizeQueue[queueHead];
                queueHead++;
                emit DrawResolved(_drawId, winner);
            } catch {
                emit PrizeMintFailed(_drawId, winner);
            }
        } else {
            // Random 4-star fallback — see the PrizeTemplate comment above
            // for exactly why tier 4 + amount 1 produces this.
            try ships.createShips(winner, 1, fallbackVariant, 4, false) {
                emit DrawResolved(_drawId, winner);
            } catch {
                emit PrizeMintFailed(_drawId, winner);
            }
        }
    }

    // Hand-crafts this draw's prize from a dequeued template, rather than
    // going through the generic random-rolled createShips path every other
    // mint route in this repo uses — see the PrizeTemplate comment above for
    // why. The name embeds the draw id so winners across different draws
    // are provably distinct from each other, not just from ordinary ships.
    function _buildPrizeShip(
        uint256 _drawId,
        PrizeTemplate memory t
    ) internal pure returns (Ship memory) {
        return
            Ship({
                name: string.concat(
                    "Legendary Draw #",
                    Strings.toString(_drawId)
                ),
                id: 0, // ignored by createSpecificShip — real id assigned internally
                equipment: Equipment({
                    mainWeapon: t.mainWeapon,
                    armor: t.armor,
                    shields: t.shields,
                    special: t.special
                }),
                traits: Traits({
                    serialNumber: 0, // ignored by createSpecificShip/_applyShipCustomization
                    colors: t.colors,
                    variant: t.variant,
                    accuracy: t.accuracy,
                    hull: t.hull,
                    speed: t.speed
                }),
                shipData: ShipData({
                    shipsDestroyed: 0,
                    costsVersion: 0, // recomputed internally via _setCostOfShip
                    cost: 0, // recomputed internally via _setCostOfShip
                    modified: 0, // recomputed internally via _calculateModifications
                    shiny: true, // the whole point is that it's not an ordinary ship
                    constructed: false, // set true internally by _applyShipCustomization
                    inFleet: false,
                    isFreeShip: false,
                    timestampDestroyed: 0
                }),
                owner: address(0) // ignored — real owner is createSpecificShip's `_to` param
            });
    }

    /**
     * @dev OWNER
     */

    function setMinEntryThresholdWei(uint256 _minEntryThresholdWei) external onlyOwner {
        minEntryThresholdWei = _minEntryThresholdWei;
    }

    function setDrawInterval(uint256 _drawInterval) external onlyOwner {
        drawInterval = _drawInterval;
    }

    function setMinParticipants(uint256 _minParticipants) external onlyOwner {
        minParticipants = _minParticipants;
    }

    function setMinTotalWeightWei(uint256 _minTotalWeightWei) external onlyOwner {
        minTotalWeightWei = _minTotalWeightWei;
    }

    function setMaxWeightPerEntryWei(uint256 _maxWeightPerEntryWei) external onlyOwner {
        maxWeightPerEntryWei = _maxWeightPerEntryWei;
    }

    function setMaxWinProbabilityDenominator(uint256 _maxWinProbabilityDenominator) external onlyOwner {
        maxWinProbabilityDenominator = _maxWinProbabilityDenominator;
    }

    // Appends one hand-crafted template to the back of the queue (FIFO —
    // see the PrizeTemplate comment above). Reverts PrizeQueueFull once
    // MAX_QUEUE_SIZE (5) templates are already queued; call clearPrizeQueue
    // or wait for draws to consume entries first.
    function queuePrizeTemplate(
        PrizeTemplate calldata _template
    ) external onlyOwner {
        if (queueTail - queueHead >= MAX_QUEUE_SIZE) {
            revert PrizeQueueFull();
        }
        _validatePrizeTemplate(_template);
        prizeQueue[queueTail] = _template;
        emit PrizeQueued(queueTail);
        queueTail++;
    }

    // O(1): just advances the head past every currently-queued entry,
    // rather than deleting each one individually — stale mapping data left
    // behind is harmless since resolveDraw only ever reads at-or-after
    // queueHead.
    function clearPrizeQueue() external onlyOwner {
        queueHead = queueTail;
        emit PrizeQueueCleared();
    }

    function queueLength() external view returns (uint256) {
        return queueTail - queueHead;
    }

    function setFallbackVariant(uint16 _variant) external onlyOwner {
        if (_variant == 0 || _variant > ships.maxVariant()) {
            revert InvalidPrizeVariant(_variant);
        }
        fallbackVariant = _variant;
    }

    function setShips(address _ships) external onlyOwner {
        ships = IShips(_ships);
    }

    function setRandomManager(address _randomManager) external onlyOwner {
        randomManager = IRandomManager(_randomManager);
    }

    // Validates what Ships.createSpecificShip doesn't itself enforce — see
    // the inline comments on each check.
    function _validatePrizeTemplate(
        PrizeTemplate calldata _template
    ) internal view {
        if (_template.variant == 0 || _template.variant > ships.maxVariant()) {
            revert InvalidPrizeVariant(_template.variant);
        }
        // A ship can only have one of armor/shields, never both — see
        // DroneYard.sol's ArmorAndShieldsBothSet check, which this
        // contract re-validates since Ships.createSpecificShip doesn't
        // enforce it itself.
        if (_template.armor != Armor.None && _template.shields != Shields.None) {
            revert ArmorAndShieldsBothSet();
        }
        if (_template.accuracy > 2 || _template.hull > 2 || _template.speed > 2) {
            revert InvalidPrizeStatTier();
        }
    }
}
