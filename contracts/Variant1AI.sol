// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./AIBehavior.sol";
import "./IVariantAI.sol";
import "./IShipAttributes.sol";
import "./IRamAbility.sol";

// Variant 1's (faction 1's) AI decision trees. Variant 1 is the light,
// fast, long-range faction, so its ships play as SKIRMISHERS: stay at the
// edge of their own gun range, back away before shooting rather than trade
// blows, and let range and speed do the work. Each tree is written from what
// faction 1 actually has:
//  - Specials (variant 1's own slots): Slot1 EMP (adds a reactor tick to an
//    adjacent enemy — used to finish a doomed one), Slot2 Repair Drones (heal
//    an ally within range), Slot3 Flak Array (self-centered AoE that hurts
//    EVERY ship in range, allies included — used only when no ally is caught).
//  - Innate ability: Ram — evict an adjacent enemy that is already at 0 HP
//    and take its tile, at the cost of one reactor tick on the rammer (three
//    destroy it). EVERY ship rams first thing when a downed enemy is holding
//    a scoring tile and its own timer is low (<= 1); the Rammer archetype
//    additionally hunts downed enemies anywhere.
// Knowledge of which slot means what is legitimately hardcoded here: this
// contract IS variant 1's rules (another faction gets its own contract — see
// Variant2AI). Every decision is an ordered priority list of cheap checks; the
// caller (SinglePlayerMatch / RoguelikeMatch) falls back to a Pass if an
// action turns out to be illegal.
contract Variant1AI is IVariantAI, Ownable {
    uint16 public constant VARIANT = 1;
    Special public constant EMP = Special.Slot1;
    Special public constant HEAL_SPECIAL = Special.Slot2; // Repair Drones
    Special public constant FLAK = Special.Slot3;

    IShipAttributes public shipAttributes;
    IRamAbility public ramAbility;

    constructor(address _shipAttributes, address _ramAbility) Ownable(msg.sender) {
        shipAttributes = IShipAttributes(_shipAttributes);
        ramAbility = IRamAbility(_ramAbility);
    }

    function setShipAttributesAddress(
        address _shipAttributes
    ) external onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setRamAbilityAddress(address _ramAbility) external onlyOwner {
        ramAbility = IRamAbility(_ramAbility);
    }

    function decide(
        AIBehavior.Ctx memory ctx,
        Archetype archetype,
        Special special
    ) external view override returns (AIBehavior.Decision memory) {
        AIBehavior.loadView(ctx);
        // Every ship has Ram: evicting a downed enemy that is holding a
        // scoring tile (and taking the tile) outranks anything else, as long
        // as the tick it costs the rammer's own reactor is affordable.
        if (ctx.attrs.reactorCriticalTimer <= 1) {
            (AIBehavior.Decision memory r, bool rams) = AIBehavior
                .ramOnScoringTile(ctx, ramAbility.range());
            if (rams) return r;
        }
        if (archetype == Archetype.Support) return _support(ctx, special);
        if (archetype == Archetype.Turtle) return _turtle(ctx, special);
        if (archetype == Archetype.Rammer) return _rammer(ctx, special);
        if (archetype == Archetype.Sniper) {
            // Strictest kiter: gives up an objective tile to keep its range.
            return _skirmish(ctx, special, true, true);
        }
        if (archetype == Archetype.Aggressor) {
            // Presses the fight: closes to maximum range but never backs off.
            return _skirmish(ctx, special, false, false);
        }
        // Grunt: keeps its distance, but won't abandon a scoring tile to do it.
        return _skirmish(ctx, special, true, false);
    }

    // ---- trees ----

    // Shoot from the edge of range. `retreat`: back away when an enemy is
    // closer than maximum range; `leaveTiles`: may do that from a scoring
    // tile. Specials are checked from the tile the ship is about to stand on.
    function _skirmish(
        AIBehavior.Ctx memory ctx,
        Special special,
        bool retreat,
        bool leaveTiles
    ) internal view returns (AIBehavior.Decision memory) {
        (Position memory enemyPos, bool found) = AIBehavior.nearestEnemy(ctx);
        if (!found) return AIBehavior.idleOrSeekTile(ctx);

        Position memory stand = AIBehavior.standoffPosition(
            ctx,
            enemyPos,
            retreat && (leaveTiles || !AIBehavior.onScoringTile(ctx))
        );

        (bool used, AIBehavior.Decision memory d) = _specialFrom(
            ctx,
            special,
            stand
        );
        if (used) return d;

        (uint target, bool inRange) = AIBehavior.bestEnemyWithin(
            ctx,
            stand,
            ctx.attrs.range,
            true
        );
        if (inRange) {
            return AIBehavior.decision(stand, ActionType.Shoot, target);
        }
        if (AIBehavior.onScoringTile(ctx) && AIBehavior.shouldHoldTile(ctx)) {
            return AIBehavior.hold(ctx);
        }
        return AIBehavior.approachOrSeekTile(ctx, enemyPos);
    }

    // Heal with Repair Drones if equipped (moving just far enough to bring an
    // injured ally into range), otherwise the shared Support fallback: shoot,
    // hold/seek a scoring tile, or stay near an injured ally.
    function _support(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        if (special == HEAL_SPECIAL) {
            // Read at the acting ship's game-start snapshot version so the
            // AI's heal range matches what the resolver will enforce.
            uint8 healRange = shipAttributes.getSpecialRangeAt(
                VARIANT,
                ctx.attrs.version,
                HEAL_SPECIAL
            );
            (AIBehavior.Decision memory d, bool healed) = AIBehavior
                .healWithReach(ctx, healRange, ActionType.Special);
            if (healed) return d;
        }
        return AIBehavior.decideSupportFallback(ctx);
    }

    // Holds objectives like any Turtle, but lays Flak from its tile when that
    // pays off.
    function _turtle(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        (bool used, AIBehavior.Decision memory d) = _specialFrom(
            ctx,
            special,
            ctx.pos
        );
        if (used) return d;
        return AIBehavior.decideTurtle(ctx);
    }

    // The Ram archetype: hunt a downed enemy — move just far enough to be
    // within Ram's range and evict it — as long as this ship's own reactor
    // timer can afford another tick (each ram adds one; three destroy it).
    // Otherwise it fights like a Grunt.
    function _rammer(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        if (ctx.attrs.reactorCriticalTimer <= 1) {
            (
                uint victim,
                Position memory victimPos,
                bool found
            ) = AIBehavior.nearestDownedEnemy(ctx);
            if (found) {
                uint8 ramRange = ramAbility.range();
                uint16 reach = uint16(ramRange) + ctx.attrs.movement;
                uint16 dist = _distance(ctx.pos, victimPos);
                if (dist <= reach) {
                    Position memory dest = ctx.pos;
                    if (dist > ramRange) {
                        uint16 gap = dist - ramRange;
                        dest = AIBehavior.stepTowardReachable(
                            ctx,
                            victimPos,
                            gap < ctx.attrs.movement
                                ? uint8(gap)
                                : ctx.attrs.movement,
                            0
                        );
                    }
                    return
                        AIBehavior.decision(
                            dest,
                            ActionType.FactionAbility,
                            victim
                        );
                }
            }
        }
        return _skirmish(ctx, special, true, false);
    }

    // ---- specials ----

    // Use an equipped attack special from `from` if it beats shooting:
    //  - Flak Array: self-centered AoE that also hits allies, so only with NO
    //    ally in range — and then when it catches 2+ enemies, or 1 enemy the
    //    gun can't reach.
    //  - EMP: one more reactor tick destroys an enemy already at 2+.
    function _specialFrom(
        AIBehavior.Ctx memory ctx,
        Special special,
        Position memory from
    ) internal view returns (bool used, AIBehavior.Decision memory d) {
        if (special == FLAK) {
            uint8 flakRange = shipAttributes.getSpecialRangeAt(
                VARIANT,
                ctx.attrs.version,
                FLAK
            );
            AIBehavior.Sweep memory s = AIBehavior.sweep(ctx, from, flakRange);
            if (s.allies == 0 && s.enemies > 0) {
                bool worthIt = s.enemies >= 2;
                if (!worthIt) {
                    (, bool gunReaches) = AIBehavior.bestEnemyWithin(
                        ctx,
                        from,
                        ctx.attrs.range,
                        true
                    );
                    worthIt = !gunReaches;
                }
                if (worthIt) {
                    return (
                        true,
                        AIBehavior.decision(from, ActionType.Special, 0)
                    );
                }
            }
        } else if (special == EMP) {
            uint8 empRange = shipAttributes.getSpecialRangeAt(
                VARIANT,
                ctx.attrs.version,
                EMP
            );
            (uint doomed, bool found) = AIBehavior.doomedEnemyWithin(
                ctx,
                from,
                empRange
            );
            if (found) {
                return (
                    true,
                    AIBehavior.decision(from, ActionType.Special, doomed)
                );
            }
        }
    }

    function _distance(
        Position memory a,
        Position memory b
    ) private pure returns (uint16) {
        uint16 rowDiff = a.row > b.row
            ? uint16(a.row - b.row)
            : uint16(b.row - a.row);
        uint16 colDiff = a.col > b.col
            ? uint16(a.col - b.col)
            : uint16(b.col - a.col);
        return rowDiff + colDiff;
    }
}
