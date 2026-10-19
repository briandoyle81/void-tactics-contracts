// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Implemented by any pluggable "on win" effect — bonus currency, extra
// heal, a granted ship, or any future effect kind not yet designed.
// Mode-agnostic: originally built for the roguelike campaign
// (RoguelikeMatch.onGameEnded dispatches to every resolver configured for
// the node just won, via RoguelikeNodeMap.getNodeWinEffects/
// setNodeWinEffects). PvP and Tournament no longer dispatch win effects
// (docs/audit-3.md HA6-27). `contextId`'s meaning is caller-defined — for
// RoguelikeMatch it's the node id. DECBonusWinEffect and
// HealAboveFloorWinEffect ignore it; ShipGrantWinEffect keys its
// per-node reward ship by it (2026-10-19). Each resolver owns its own config/authorization — e.g.
// a DEC-bonus resolver holds its own bonus amount and needs
// DroneEnergyCores.authorizedToMint, a ship-grant resolver needs
// Ships.isAllowedToCreateShips — callers stay completely agnostic to what
// a resolver does, the same way Game.sol's factionAbilityResolvers/
// specialResolvers stay agnostic to what a combat ability does. New effect
// kinds are new resolver contracts, wired in per-caller via each
// resolver's own isAllowedToTrigger allowlist plus whichever list
// (RoguelikeNodeMap's per-node list, PvPMatch.winEffects,
// Tournament.winEffects) assigns it — no caller here ever needs to change
// again to support one.
interface IWinEffect {
    function onWin(address player, uint contextId) external;
}
