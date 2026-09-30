// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

enum MainWeapon {
    Generic,
    Sniper,
    Missile,
    Close,
    future1,
    future2,
    future3,
    future4
}

// Reduces Damage, Does not Provide Hitpoints
enum Armor {
    None,
    Light,
    Medium,
    Heavy,
    future1,
    future2,
    future3,
    future4
}

// Reduces Damage, Does not Provide Hitpoints
enum Shields {
    None,
    Light,
    Medium,
    Heavy,
    future1,
    future2,
    future3,
    future4
}

// A per-faction (traits.variant) LOCAL slot index, not a global item
// identity. Slot 0 (None) always means "no special equipped," the same for
// every faction. Slots 1-7 mean whatever that faction's own
// ShipAttributes.VariantAttributeData.specials/Game.specialResolvers
// configuration says they mean — faction A's slot 1 and faction B's slot 1
// can be (and usually are) completely different specials with different
// resolvers and different display names (RenderMetadata.specialNames).
// This enum is deliberately finished at exactly 8 members forever: no
// faction will ever have more than 8 specials including None, so new
// specials for new factions reuse these same 8 slot numbers rather than
// growing this enum.
enum Special {
    None,
    Slot1,
    Slot2,
    Slot3,
    Slot4,
    Slot5,
    Slot6,
    Slot7
}

// Single-player AI behavior tag, assigned per AIShipConfig (AIEncounters.sol)
// and looked up per minted AI ship (SinglePlayerMatch.shipArchetype) to pick
// which ordered priority-list of rules takeAITurn applies to that ship.
enum Archetype {
    // Each faction's AI (Variant1AI / Variant2AI) writes its own tree per
    // archetype, so the exact tactics differ by variant; these are the shared
    // intents.
    Grunt, // shoot what's in range, else close distance
    Aggressor, // prioritize kills over safety, presses the fight
    Sniper, // long-gun fire support; a skirmisher faction also kites
    Support, // heals the most injured ally (each faction's own way), hangs back
    Turtle, // seeks/holds scoring tiles, fights only opportunistically
    Rammer // faction-1 only: hunts 0-HP enemies to Ram, else shoots
}

// Which game mode(s) a preset map is valid for. Enforced at the point a
// map gets attached to something a player can actually enter — NodeMap
// (campaign nodes, PvE) and Lobbies (createLobby/createLobbyForAddresses,
// PvP) — rather than in Maps.sol itself, which has no notion of lobbies or
// campaigns. Both means the map is valid in either context.
enum MapMode {
    PvP,
    PvE,
    Both
}

// Declarative outcome of a resolver-backed effect — a faction ability or an
// equipped Special (see IEffectResolver) — applied by Game.sol without
// re-validating anything — the resolver owns all pre-dispatch checks for
// its own effect. One entry per affected ship; a resolver may return any
// number of these.
// newRow/newCol double as the "relocate" flag: type(int16).min (an
// unreachable grid coordinate) means "don't move this ship". Fewer, denser
// fields keep the external-call ABI decode/encode Game.sol pays for as
// small as possible — this struct crosses a contract boundary every time.
struct SpecialEffect {
    uint shipId;
    int16 hullDelta; // negative = damage, positive = heal; capped at maxHullPoints
    int8 reactorTimerDelta; // added to reactorCriticalTimer; still auto-removes at >=3
    int16 newRow; // type(int16).min = no relocation
    int16 newCol;
    uint8 removalKind; // 0 = none, 1 = retreat, 2 = destroy (mirrors _removeShipFromGame's retreat/destroy flag)
}

// Raw Traits Will Never Change
struct Traits {
    uint256 serialNumber; // Id for random number in commit reveal
    Colors colors;
    uint16 variant; // Which art to use for the ship
    uint8 accuracy;
    uint8 hull; // Hitpoints
    uint8 speed;
}

struct Colors {
    uint16 h1;
    uint8 s1;
    uint8 l1;
    uint16 h2;
    uint8 s2;
    uint8 l2;
    uint16 h3;
    uint8 s3;
    uint8 l3;
}

struct Equipment {
    MainWeapon mainWeapon;
    Armor armor;
    Shields shields;
    Special special;
}

// Attributes Change on Version
// Attributes will live in the game contract
struct Attributes {
    uint16 version; // Attributes version not cost version
    uint8 range;
    uint8 gunDamage;
    uint8 hullPoints;
    uint8 maxHullPoints;
    uint8 movement;
    uint8 damageReduction;
    uint8 reactorCriticalTimer;
    uint8[] statusEffects;
}

// Grid position structure
struct Position {
    int16 row;
    int16 col;
}

// Scoring position structure with point value
struct ScoringPosition {
    int16 row;
    int16 col;
    uint8 points; // Number of points available on this tile
    bool onlyOnce; // Whether this tile can only be claimed once
}

// Ship position on the grid (including status for replay/visualization)
// status: 0 = alive, 1 = destroyed, 2 = fled
struct ShipPosition {
    uint shipId;
    Position position;
    bool isCreator;
    uint8 status;
}

// Game metadata - basic game identification and players
struct GameMetadata {
    uint gameId;
    uint lobbyId;
    address creator;
    address joiner;
    uint creatorFleetId;
    uint joinerFleetId;
    bool creatorGoesFirst;
    uint startedAt;
    address winner; // Winner of the game (zero address if game is not over OR if it was a draw)
    // True once _endGame has run. winner alone can't distinguish "not over" from
    // "ended in a draw" (both leave winner == address(0)), so this is the one
    // source of truth for "has this game ended." Packs into winner's storage
    // slot (address is 20 bytes, bool is 1), so this costs no extra slot.
    bool ended;
    // The contract that called startGame for this session (e.g. PvPMatch).
    // Only this address may call forceEndSession, and it's who Game.sol
    // calls back into (via IGameOrchestrator.onGameEnded) when the session
    // ends, so each game mode can decide what "ended" means for it without
    // core Game.sol needing to know about leaderboards/results contracts.
    address orchestrator;
}

// Game turn state - turn and timing related data
struct GameTurnState {
    address currentTurn;
    uint turnTime; // Time limit per turn in seconds
    uint turnStartTime; // When current turn started
    uint currentRound;
}

// Game grid dimensions
struct GameGridDimensions {
    int16 gridWidth;
    int16 gridHeight;
}

struct GameData {
    GameMetadata metadata;
    GameTurnState turnState;
    GameGridDimensions gridDimensions;
    uint maxScore; // Maximum score needed to win the game
    uint creatorScore; // Current score of the creator player
    uint joinerScore; // Current score of the joiner player
    LastMove lastMove; // Most recent move in the game
    // Keep all mappings in GameData
    mapping(uint => Attributes) shipAttributes; // shipId => attributes
    // Grid state - grid[row][column] = shipId (0 if empty)
    mapping(int16 row => mapping(int16 column => uint shipId)) grid;
    // Board position and status for each ship (status: 0 = alive, 1 = destroyed, 2 = fled)
    mapping(uint => ShipPosition) shipPositions; // shipId => position + status
    // Kill-credit tracking: target shipId => shipId of its last damager, scoped per
    // game (was a top-level Game.sol mapping shared across all games; a ship id
    // reused in a later game would inherit a stale entry from an earlier one).
    mapping(uint => uint) lastDamage;
    EnumerableSet.UintSet shipMovedThisRound; // movedShipIds in current round
    EnumerableSet.UintSet shipsWithZeroHP; // shipIds with 0 hull points
    // Store active ship IDs for each player to avoid repeated fleet calls
    mapping(address => EnumerableSet.UintSet) playerActiveShipIds; // player => shipIds
    // Round completion: use counts at round start so destroyed/retreated ships don't shrink the threshold
    uint[] goneShipIds; // shipIds that have been destroyed or retreated this round
    uint totalActiveShipsAtRoundStart; // set at start of each round
    uint shipsRemovedThisRound; // destroyed or retreated this round (incremented in _removeShipFromGame)
    // UA-06 fix (2026-09-29): Game.healCapPercent's value snapshotted once
    // at startGame, so a later live change can't retroactively affect an
    // already-active game's heal effects. Not surfaced on GameDataView —
    // internal scheduling detail for SpecialEffectsLib, not player-facing
    // game state.
    uint8 healCapPercentAtStart;
}

struct GameDataView {
    GameMetadata metadata;
    GameTurnState turnState;
    GameGridDimensions gridDimensions;
    uint maxScore; // Maximum score needed to win the game
    uint creatorScore; // Current score of the creator player
    uint joinerScore; // Current score of the joiner player
    LastMove lastMove; // Most recent move in the game
    // Ship data arrays
    uint[] shipIds;
    Attributes[] shipAttributes; // Combined array of all ship attributes indexed by ship ID
    ShipPosition[] shipPositions; // All ship positions on the grid
    // Active ship IDs for each player
    uint[] creatorActiveShipIds;
    uint[] joinerActiveShipIds;
    // Ships that have moved this round
    uint[] creatorMovedShipIds; // Creator ships that have moved this round
    uint[] joinerMovedShipIds; // Joiner ships that have moved this round
}

struct Ship {
    string name;
    uint id;
    Equipment equipment;
    Traits traits;
    ShipData shipData;
    address owner;
}

struct ShipData {
    uint32 shipsDestroyed; // +1 for Frigate, +2 for Destroyer, +3 for Cruiser, +4 for Battleship
    uint16 costsVersion;
    uint16 cost;
    uint16 modified; // 0 = false, anything else = true
    bool shiny;
    bool constructed;
    bool inFleet;
    bool isFreeShip;
    uint timestampDestroyed;
}

// Costs are per-variant (see ShipAttributes.costsByVariant), so this struct
// carries no variant field of its own — a same-struct flat addend would be
// redundant now that every variant has its own full Costs.
struct Costs {
    uint16 version;
    uint8 baseCost;
    uint8[] accuracy;
    uint8[] hull;
    uint8[] speed;
    // accuracy/hull/speed are indexed by trait tier (length 3); mainWeapon/
    // armor/shields/special are indexed by their enum value (length 8 each).
    // Lengths are enforced by ShipAttributes.setCosts.
    uint8[] mainWeapon;
    uint8[] armor;
    uint8[] shields;
    uint8[] special;
}

// Be VERY CAREFUL giving negative movement!
// It can result in ships that can't move

// Each variant keeps its own history of published attribute versions (see
// ShipAttributes), and a game pins the version its ships were calculated
// under, so a later publish never changes an in-flight game.

struct GunData {
    uint8 range;
    uint8 damage;
    int8 movement;
}

struct ArmorData {
    uint8 damageReduction;
    int8 movement;
}

struct ShieldData {
    uint8 damageReduction;
    int8 movement;
}

struct SpecialData {
    uint8 range;
    uint8 strength;
    int8 movement;
}

// Everything a faction (traits.variant) needs to fully differentiate itself:
// base stats, per-tier bonuses, weapon/armor/shield stats, equipped Special
// data, and rank rules. One immutable VariantAttributeData exists per
// (variant, version) in ShipAttributes — a published version is never
// mutated, which is what lets a game pin the version it started with.
struct VariantAttributeData {
    uint8 baseHull;
    uint8 baseSpeed;
    uint8[] foreAccuracy; // "bridge": indexed by traits.accuracy tier (0-2)
    uint8[] hull; // indexed by traits.hull tier (0-2)
    uint8[] engineSpeeds; // "engine": indexed by traits.speed tier (0-2)
    GunData[] guns; // indexed by MainWeapon enum (0-7)
    ArmorData[] armors; // indexed by Armor enum (0-7)
    ShieldData[] shields; // indexed by Shields enum (0-7)
    SpecialData[] specials; // indexed by Special enum (0-7)
    // Kills (ShipData.shipsDestroyed) required to reach ranks 2..6 — length
    // 5, strictly ascending, first entry > 0. rank = 1 + #(thresholds <= kills).
    uint32[] rankThresholds;
    // Stat bonus percent per rank, indexed by rank - 1 (length 6, each <= 100).
    uint8[] rankBonusPct;
}

// Bundled into a struct rather than passed as flat parameters to
// ShipAttributes.setVariantAttributes: it covers every per-variant stat
// (base hull/speed, tier bonuses, weapon/armor/shield stats, specials, rank
// rules), and legacy Solidity codegen runs out of stack slots quickly across
// an external function with this many dynamic-array parameters (hit this
// exact wall building the equipped-Special resolvers earlier this
// session). Declared here (not nested in ShipAttributes) so
// IShipAttributes can reference it too without a circular import. There is
// deliberately no `version` field: setVariantAttributes always publishes
// latest + 1 for the variant (same as setCosts).
struct SetVariantAttributesParams {
    uint16 variant;
    uint8 baseHull;
    uint8 baseSpeed;
    uint8[] foreAccuracy;
    uint8[] hull;
    uint8[] engineSpeeds;
    GunData[] guns;
    ArmorData[] armors;
    ShieldData[] shields;
    SpecialData[] specials;
    uint32[] rankThresholds;
    uint8[] rankBonusPct;
}

enum LobbyStatus {
    Open, // Lobby is open for joining
    FleetSelection, // Both players have joined, selecting fleets
    InGame // Game has started
}

// Basic lobby identification and ownership
struct LobbyBasic {
    uint id;
    address creator;
    uint costLimit;
    uint createdAt;
}

// Player and fleet information
struct LobbyPlayers {
    address joiner;
    address reservedJoiner; // Address of player this lobby is reserved for (if any)
    uint creatorFleetId;
    uint joinerFleetId;
    uint joinedAt;
    uint joinerFleetSetAt;
}

// Game configuration settings
struct LobbyGameConfig {
    bool creatorGoesFirst;
    uint turnTime; // Time in seconds for each turn
    uint selectedMapId; // ID of the preset map to use for this game
    uint maxScore; // Maximum score needed to win the game
    // UA-10 fix (2026-09-29): snapshotted at lobby creation, not read live
    // from Lobbies.pvpMatch at fleet-completion time. Without this, a lobby
    // that's already sat in FleetSelection for a while (one side already
    // committed a fleet, up to MAX_TURN_TIME before the other side submits
    // theirs) could have its game silently start on a DIFFERENT engine than
    // either player implicitly assumed, if the owner repoints
    // Lobbies.pvpMatch mid-window (e.g. rolling out a new engine) —
    // matches the same "pin it at commitment time" discipline this
    // codebase already applies to costLimit/turnTime/selectedMapId/maxScore
    // above. See docs/upgrade-safety-audit-2026-09-29.md UA-10.
    address pvpMatch;
}

// Lobby state and status
struct LobbyState {
    LobbyStatus status;
    uint gameStartedAt;
}

// Main lobby struct composed of smaller components
struct Lobby {
    LobbyBasic basic;
    LobbyPlayers players;
    LobbyGameConfig gameConfig;
    LobbyState state;
}

struct Fleet {
    uint id;
    uint lobbyId;
    address owner;
    uint[] shipIds;
    Position[] startingPositions;
    uint totalCost;
    bool isComplete;
}

struct PlayerLobbyState {
    uint activeLobbyId;
    uint activeLobbiesCount; // Track number of active lobbies
    bool hasActiveLobby;
    uint kickCount;
    uint lastKickTime;
}

enum ActionType {
    Pass,
    Shoot,
    Retreat,
    Assist,
    Special,
    // Innate to every ship of a given faction (traits.variant), independent
    // of loadout — unlike Special, which requires equipping a specific
    // equipment.special slot. Dispatched by faction, not by an equipped item.
    FactionAbility
}

// Last move information stored in game data
struct LastMove {
    uint shipId;
    int16 oldRow;
    int16 oldCol;
    int16 newRow;
    int16 newCol;
    ActionType actionType;
    uint targetShipId;
    uint timestamp; // When the move was made
}

// Player statistics for tracking wins and losses
struct PlayerStats {
    uint wins;
    uint losses;
    uint totalGames;
}

// Game result structure for tracking individual game outcomes
struct GameResult {
    uint gameId;
    address winner;
    address loser;
    uint timestamp;
}
