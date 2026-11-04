// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./AIBehavior.sol";
import "./IVariantAI.sol";
import "./IShipAttributes.sol";
import "./IHealFactionAbility.sol";

// Variant 2's (faction 2's) AI decision trees. Variant 2 is the heavy,
// slow, tough, short-range faction, so its ships play as BRAWLERS: they can't
// out-run or out-range anyone, so they advance at full speed, shoot from
// wherever they end up, and never retreat — their hull and armor are what
// they trade with. Each tree is written from what faction 2 actually has:
//  - Innate ability: Repair — EVERY ship can heal a nearby friendly ship
//    (range 1), regardless of loadout. Not Ram: variant 2 has no ram, so the
//    Rammer archetype simply plays as a Grunt.
//  - Specials (variant 2's own slots): Slot1 Electric Storm (+1 reactor tick
//    on EVERY ship in a small radius — including the caster and its allies —
//    so it is only used to finish downed enemies when that is safe), Slot2
//    Drone Swarm (ranged single-target damage that ignores line of sight —
//    the brawlers' way to reach past their short guns), Slot3 Additional
//    Thruster (passive movement bonus, already in the ship's stats).
//  - None of its equipped specials heal.
// The repair range is read live from the faction ability resolver that
// enforces it. Every decision is an ordered priority list of cheap checks (see
// decide for the repair/objective priorities every ship shares); the caller
// falls back to a Pass if an action turns out to be illegal.
contract Variant2AI is IVariantAI, Ownable {
    uint16 public constant VARIANT = 2;
    Special public constant STORM = Special.Slot1;
    Special public constant SWARM = Special.Slot2;

    // Variant 2's repair faction ability (RepairResolver).
    IHealFactionAbility public healAbility;
    IShipAttributes public shipAttributes;

    constructor(address _healAbility, address _shipAttributes) Ownable(msg.sender) {
        healAbility = IHealFactionAbility(_healAbility);
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setHealAbilityAddress(address _healAbility) external onlyOwner {
        healAbility = IHealFactionAbility(_healAbility);
    }

    function setShipAttributesAddress(
        address _shipAttributes
    ) external onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    // Every ship has the Repair ability, so every ship follows the same
    // priorities, highest first (the first that applies wins):
    //  1. Repair a friendly ship standing on a scoring tile (moving within
    //     reach of it if needed) when the repair can't wait: it's disabled,
    //     or one enemy shot would destroy it (AIBehavior.healIsUrgent). Any
    //     other on-tile repair waits for a turn that would otherwise end
    //     without an action (2026-11-03: repairing while live enemies were
    //     in range and in sight cost the faction its shots).
    //  Then, below a quarter of its HP and off a scoring tile, stay out of
    //  enemy range (AIBehavior.lowHpEvade).
    //  2. Claim a scoring tile: hold the one it stands on, else head for the
    //     nearest unclaimed one at full speed.
    //  3. Repair a disabled (0 HP) friendly ship — from where it ends up if it
    //     has a tile to claim, moving to reach one otherwise.
    //  ...its archetype's fighting tree (shoot / specials / advance)...
    //  4. Last resort, when nothing above gave it an action: repair itself or
    //     any injured friendly ship within reach of where it ends up.
    function decide(
        AIBehavior.Ctx memory ctx,
        Archetype archetype,
        Special special
    ) external view override returns (AIBehavior.Decision memory) {
        AIBehavior.loadView(ctx);
        uint8 healRange = healAbility.range();
        (AIBehavior.Decision memory onTileHeal, bool canHeal) = AIBehavior
            .healOnScoringTile(ctx, healRange, ActionType.FactionAbility);
        if (canHeal && AIBehavior.healIsUrgent(ctx, onTileHeal.actionTarget)) {
            return onTileHeal;
        }
        (AIBehavior.Decision memory d, bool ok) = AIBehavior.lowHpEvade(ctx);
        if (ok) return d.action == ActionType.Pass ? _repairFrom(ctx, d, healRange) : d;

        d = _claimOrFight(ctx, archetype, special, healRange);
        // A shot at a disabled ship only advances its reactor timer; the
        // waiting repair is worth more.
        if (canHeal && (d.action == ActionType.Pass || AIBehavior.isDisabled(ctx, d.actionTarget))) {
            return onTileHeal;
        }
        if (d.action != ActionType.Pass) return d;

        return _repairFrom(ctx, d, healRange);
    }

    // Priority 4, the last-resort repair: `d` is a move with no action;
    // repair this ship or an injured friendly within reach of where it ends.
    function _repairFrom(
        AIBehavior.Ctx memory ctx,
        AIBehavior.Decision memory d,
        uint8 healRange
    ) internal view returns (AIBehavior.Decision memory) {
        (AIBehavior.Decision memory h, bool healed) = AIBehavior.healAnyFrom(
            ctx,
            Position({row: d.destRow, col: d.destCol}),
            healRange,
            ActionType.FactionAbility
        );
        return healed ? h : d;
    }

    // Priorities 2 and 3 plus the fighting tree; a Pass result is the caller's
    // cue to try the last-resort heal from wherever it ended up.
    function _claimOrFight(
        AIBehavior.Ctx memory ctx,
        Archetype archetype,
        Special special,
        uint8 healRange
    ) internal view returns (AIBehavior.Decision memory) {
        // The Hunter ignores tiles (2026-11-03).
        (Position memory stand, bool objective) = archetype == Archetype.Hunter
            ? (ctx.pos, false)
            : AIBehavior.claimScoringTile(ctx);
        AIBehavior.Decision memory d;
        bool ok;
        if (objective) {
            (d, ok) = AIBehavior.healDisabledFrom(
                ctx,
                stand,
                healRange,
                ActionType.FactionAbility
            );
            if (ok) return d;
            return _fightFrom(ctx, special, stand);
        }
        (d, ok) = AIBehavior.healDisabledWithReach(
            ctx,
            healRange,
            ActionType.FactionAbility
        );
        if (ok) return d;
        return _tree(ctx, archetype, special, healRange);
    }

    // The archetype's own tree, used only when there is no scoring tile to
    // claim (or hold) — otherwise every ship fights from its objective tile.
    function _tree(
        AIBehavior.Ctx memory ctx,
        Archetype archetype,
        Special special,
        uint8 healRange
    ) internal view returns (AIBehavior.Decision memory) {
        if (archetype == Archetype.Support) {
            return _support(ctx, special, healRange);
        }
        if (archetype == Archetype.Turtle) return _turtle(ctx, special);
        if (archetype == Archetype.Runner) return _runner(ctx, special);
        if (archetype == Archetype.Hunter) return _hunter(ctx, special);
        if (archetype == Archetype.Sniper) return _fireSupport(ctx, special);
        // Aggressor never stops to hold an objective; Grunt does. Rammer is
        // faction-1 only (no Ram here), so it plays as a Grunt too.
        return _brawl(ctx, special, archetype != Archetype.Aggressor);
    }

    // ---- trees ----

    // Shoot if anything is in range from here; otherwise (holding an
    // objective it already stands on, if `holdTiles`) advance at full speed
    // toward the nearest enemy (stopping adjacent, never on its tile) and shoot
    // from wherever that lands, reaching
    // with Drone Swarm when the guns still can't.
    function _brawl(
        AIBehavior.Ctx memory ctx,
        Special special,
        bool holdTiles
    ) internal view returns (AIBehavior.Decision memory) {
        (Position memory enemyPos, bool found) = AIBehavior.nearestEnemy(ctx);
        if (!found) return AIBehavior.idleOrSeekTile(ctx);

        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            ctx.pos
        );
        if (used) return d;
        (uint target, bool inRange) = AIBehavior.bestEnemyWithin(
            ctx,
            ctx.pos,
            ctx.attrs.range,
            true
        );
        if (inRange) {
            return AIBehavior.decision(ctx.pos, ActionType.Shoot, target);
        }

        if (
            holdTiles &&
            AIBehavior.onScoringTile(ctx) &&
            AIBehavior.shouldHoldTile(ctx)
        ) {
            return AIBehavior.hold(ctx);
        }

        // A reachable tile with a gun shot this turn beats advancing to one
        // without (line of sight; see AIBehavior.shotWithinReach).
        Position memory shotPos;
        (shotPos, target, inRange) = AIBehavior.shotWithinReach(ctx, false);
        if (inRange) {
            return AIBehavior.decision(shotPos, ActionType.Shoot, target);
        }

        Position memory dest = AIBehavior.advanceToward(
            ctx,
            enemyPos,
            ctx.attrs.movement
        );
        return _fightFrom(ctx, special, dest);
    }

    // Long-gun support: shoots from where it stands if it can, otherwise
    // advances only as far as maximum range (never in to melee, never
    // backing off — slow ships can't run) and shoots from there.
    function _fireSupport(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        (Position memory enemyPos, bool found) = AIBehavior.nearestEnemy(ctx);
        if (!found) return AIBehavior.idleOrSeekTile(ctx);

        Position memory stand = AIBehavior.standoffPosition(
            ctx,
            enemyPos,
            false
        );
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
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
        (used, d) = _swarmFrom(ctx, special, stand);
        if (used) return d;
        if (AIBehavior.onScoringTile(ctx) && AIBehavior.shouldHoldTile(ctx)) {
            return AIBehavior.hold(ctx);
        }
        Position memory shotPos;
        (shotPos, target, inRange) = AIBehavior.shotWithinReach(ctx, false);
        if (inRange) {
            return AIBehavior.decision(shotPos, ActionType.Shoot, target);
        }
        return AIBehavior.approachOrSeekTile(ctx, enemyPos);
    }

    // With no tile to claim: finish downed enemies with a Storm if that is
    // safe, shoot if anything is in range, otherwise shadow the most injured
    // friendly ship — moving just far enough to repair it (its own heal is
    // still below every other action's priority, see decide) — else the shared
    // Support fallback.
    function _support(
        AIBehavior.Ctx memory ctx,
        Special special,
        uint8 healRange
    ) internal view returns (AIBehavior.Decision memory) {
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            ctx.pos
        );
        if (used) return d;
        (uint target, bool inRange) = AIBehavior.bestEnemyWithin(
            ctx,
            ctx.pos,
            ctx.attrs.range,
            true
        );
        if (inRange) {
            return AIBehavior.decision(ctx.pos, ActionType.Shoot, target);
        }
        bool healed;
        (d, healed) = AIBehavior.healWithReach(
            ctx,
            healRange,
            ActionType.FactionAbility
        );
        if (healed) return d;
        return AIBehavior.decideSupportFallback(ctx);
    }

    // Holds objectives like any Turtle; reaches with Drone Swarm when its gun
    // can't, and finishes downed enemies with a Storm when that is safe.
    function _turtle(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            ctx.pos
        );
        if (used) return d;
        (, bool gunReaches) = AIBehavior.bestEnemyWithin(
            ctx,
            ctx.pos,
            ctx.attrs.range,
            true
        );
        if (!gunReaches) {
            (used, d) = _swarmFrom(ctx, special, ctx.pos);
            if (used) return d;
        }
        return AIBehavior.decideTurtle(ctx);
    }

    // The Objective Runner (2026-11-03), once decide's shared claim step
    // found no free tile: closes to gun range of the nearest enemy holding
    // one, whatever the score, shooting tile holders ahead of anything
    // else. With no enemy on a tile it brawls like a Grunt.
    function _runner(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        (Position memory holder, bool held) = AIBehavior.nearestTileHolder(ctx);
        if (!held) return _brawl(ctx, special, true);
        Position memory dest = AIBehavior.withinRangeOf(
            ctx,
            holder,
            ctx.attrs.range
        );
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            dest
        );
        if (used) return d;
        (uint target, bool found) = AIBehavior.holderFirstWithin(ctx, dest);
        if (found) return AIBehavior.decision(dest, ActionType.Shoot, target);
        (used, d) = _swarmFrom(ctx, special, dest);
        if (used) return d;
        return AIBehavior.decision(dest, ActionType.Pass, 0);
    }

    // The Hunter (2026-11-03): goes after the enemy it can destroy soonest
    // (AIBehavior.huntTarget), closing to gun range of it and shooting it
    // when it can, else fighting from there. Skips the claim step.
    function _hunter(
        AIBehavior.Ctx memory ctx,
        Special special
    ) internal view returns (AIBehavior.Decision memory) {
        (uint quarry, Position memory at, bool found) = AIBehavior.huntTarget(
            ctx
        );
        if (!found) return AIBehavior.idleOrSeekTile(ctx);
        Position memory dest = AIBehavior.withinRangeOf(
            ctx,
            at,
            ctx.attrs.range
        );
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            dest
        );
        if (used) return d;
        if (AIBehavior.canShoot(ctx, dest, at)) {
            return AIBehavior.decision(dest, ActionType.Shoot, quarry);
        }
        return _fightFrom(ctx, special, dest);
    }

    // ---- shared pieces ----

    // Act from `dest`: shoot if a gun target is in range, else reach with a
    // Drone Swarm, else just take the move.
    function _fightFrom(
        AIBehavior.Ctx memory ctx,
        Special special,
        Position memory dest
    ) internal view returns (AIBehavior.Decision memory) {
        (bool used, AIBehavior.Decision memory d) = _stormFrom(
            ctx,
            special,
            dest
        );
        if (used) return d;
        (uint target, bool inRange) = AIBehavior.bestEnemyWithin(
            ctx,
            dest,
            ctx.attrs.range,
            true
        );
        if (inRange) {
            return AIBehavior.decision(dest, ActionType.Shoot, target);
        }
        (used, d) = _swarmFrom(ctx, special, dest);
        if (used) return d;
        return AIBehavior.decision(dest, ActionType.Pass, 0);
    }

    // Drone Swarm: ranged single-target damage that ignores line of sight —
    // used when the guns can't reach anyone.
    function _swarmFrom(
        AIBehavior.Ctx memory ctx,
        Special special,
        Position memory from
    ) internal view returns (bool used, AIBehavior.Decision memory d) {
        if (special != SWARM) return (false, d);
        uint8 swarmRange = shipAttributes.getSpecialRangeAt(
            VARIANT,
            ctx.attrs.version,
            SWARM
        );
        (uint target, bool found) = AIBehavior.bestEnemyWithin(
            ctx,
            from,
            swarmRange,
            false
        );
        if (!found) return (false, d);
        return (true, AIBehavior.decision(from, ActionType.Special, target));
    }

    // Electric Storm: +1 reactor tick on EVERY ship in range, the caster and
    // its allies included. Only used to finish downed enemies, and only when
    // it is safe: the caster's own timer can afford a tick, no ally in it is
    // already near destruction, and it doesn't catch more allies than it
    // finishes enemies. Worth it when it finishes 2+ at once, or 1 that the
    // gun can't otherwise reach.
    function _stormFrom(
        AIBehavior.Ctx memory ctx,
        Special special,
        Position memory from
    ) internal view returns (bool used, AIBehavior.Decision memory d) {
        if (special != STORM || ctx.attrs.reactorCriticalTimer >= 2) {
            return (false, d);
        }
        uint8 stormRange = shipAttributes.getSpecialRangeAt(
            VARIANT,
            ctx.attrs.version,
            STORM
        );
        AIBehavior.Sweep memory s = AIBehavior.sweep(ctx, from, stormRange);
        if (
            s.finishableEnemies == 0 ||
            s.alliesAtRisk != 0 ||
            s.allies > s.finishableEnemies
        ) {
            return (false, d);
        }
        bool worthIt = s.finishableEnemies >= 2;
        if (!worthIt) {
            (, bool gunReaches) = AIBehavior.bestEnemyWithin(
                ctx,
                from,
                ctx.attrs.range,
                true
            );
            worthIt = !gunReaches;
        }
        if (!worthIt) return (false, d);
        return (true, AIBehavior.decision(from, ActionType.Special, 0));
    }
}
