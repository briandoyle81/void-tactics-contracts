import { Address } from "viem";

export interface Ship {
  name: string;
  id: bigint;
  equipment: ShipEquipment;
  traits: ShipTraits;
  shipData: ShipData;
  owner: Address;
}

export interface ShipEquipment {
  mainWeapon: number;
  armor: number;
  shields: number;
  special: number;
}

export interface ShipTraits {
  serialNumber: bigint;
  colors: ShipColors;
  variant: number;
  accuracy: number;
  hull: number;
  speed: number;
}

export interface ShipColors {
  h1: number;
  s1: number;
  l1: number;
  h2: number;
  s2: number;
  l2: number;
}

export interface ShipData {
  shipsDestroyed: number;
  costsVersion: number;
  cost: number;
  shiny: boolean;
  constructed: boolean;
  inFleet: boolean;
  isFreeShip: boolean;
  modified: number;
  timestampDestroyed: bigint;
}

export type ShipTuple = [
  string, // name
  bigint, // id
  ShipEquipment, // equipment
  ShipTraits, // traits
  ShipData, // shipData
  Address, // owner
];

export function tupleToShip(tuple: ShipTuple): Ship {
  return {
    name: tuple[0],
    id: tuple[1],
    equipment: tuple[2],
    traits: tuple[3],
    shipData: tuple[4],
    owner: tuple[5],
  };
}

// New types for Game and Lobbies contracts

export enum LobbyStatus {
  Open,
  FleetSelection,
  InGame,
}

export interface LobbyBasic {
  id: bigint;
  creator: Address;
  costLimit: bigint;
  createdAt: bigint;
}

export interface LobbyPlayers {
  joiner: Address;
  creatorFleetId: bigint;
  joinerFleetId: bigint;
  joinedAt: bigint;
  joinerFleetSetAt: bigint;
}

export interface LobbyGameConfig {
  creatorGoesFirst: boolean;
  turnTime: bigint;
  selectedMapId: bigint;
  maxScore: bigint; // Maximum score needed to win the game
}

export interface LobbyState {
  status: LobbyStatus;
  gameStartedAt: bigint;
}

export interface Lobby {
  basic: LobbyBasic;
  players: LobbyPlayers;
  gameConfig: LobbyGameConfig;
  state: LobbyState;
}

export interface Fleet {
  id: bigint;
  lobbyId: bigint;
  owner: Address;
  shipIds: bigint[];
  totalCost: bigint;
  isComplete: boolean;
}

export interface PlayerStats {
  wins: bigint;
  losses: bigint;
}

export interface GameResult {
  gameId: bigint;
  winner: Address;
  loser: Address;
  timestamp: bigint;
}

export interface PlayerLobbyState {
  activeLobbyId: bigint;
  activeLobbiesCount: bigint;
  hasActiveLobby: boolean;
  kickCount: bigint;
  lastKickTime: bigint;
}

export interface Attributes {
  version: number;
  range: number;
  gunDamage: number;
  hullPoints: number;
  maxHullPoints: number;
  movement: number;
  damageReduction: number;
  reactorCriticalTimer: number;
}

export interface GameData {
  gameId: bigint;
  lobbyId: bigint;
  creator: Address;
  joiner: Address;
  creatorFleetId: bigint;
  joinerFleetId: bigint;
  creatorGoesFirst: boolean;
  startedAt: bigint;
  currentTurn: Address;
}

export interface GameMetadata {
  gameId: bigint;
  lobbyId: bigint;
  creator: Address;
  joiner: Address;
  creatorFleetId: bigint;
  joinerFleetId: bigint;
  creatorGoesFirst: boolean;
  startedAt: bigint;
  winner: Address;
  orchestrator: Address;
}

export interface GameTurnState {
  currentTurn: Address;
  turnTime: bigint;
  turnStartTime: bigint;
  currentRound: bigint;
}

export interface GameGridDimensions {
  gridWidth: number;
  gridHeight: number;
}

// Tuple types for contract return values
export type LobbyTuple = [
  bigint, // id
  Address, // creator
  Address, // joiner
  bigint, // costLimit
  number, // status
  bigint, // createdAt
  bigint, // gameStartedAt
  bigint, // creatorFleetId
  bigint, // joinerFleetId
  boolean, // creatorGoesFirst
  bigint, // turnTime
  bigint, // joinedAt
  bigint, // joinerFleetSetAt
  bigint, // selectedMapId
  bigint, // maxScore
];

export type FleetTuple = [
  bigint, // id
  bigint, // lobbyId
  Address, // owner
  bigint[], // shipIds
  bigint, // totalCost
  boolean, // isComplete
];

export type PlayerLobbyStateTuple = [
  bigint, // activeLobbyId
  bigint, // activeLobbiesCount
  boolean, // hasActiveLobby
  bigint, // kickCount
  bigint, // lastKickTime
];

export type GameDataTuple = [
  bigint, // gameId
  bigint, // lobbyId
  Address, // creator
  Address, // joiner
  bigint, // creatorFleetId
  bigint, // joinerFleetId
  boolean, // creatorGoesFirst
  bigint, // startedAt
  Address, // currentTurn
];

// Helper functions to convert tuples to objects
export function tupleToLobby(tuple: LobbyTuple): Lobby {
  return {
    basic: {
      id: tuple[0],
      creator: tuple[1],
      costLimit: tuple[3],
      createdAt: tuple[5],
    },
    players: {
      joiner: tuple[2],
      creatorFleetId: tuple[7],
      joinerFleetId: tuple[8],
      joinedAt: tuple[11],
      joinerFleetSetAt: tuple[12],
    },
    gameConfig: {
      creatorGoesFirst: tuple[9],
      turnTime: tuple[10],
      selectedMapId: tuple[13],
      maxScore: tuple[14],
    },
    state: {
      status: tuple[4],
      gameStartedAt: tuple[6],
    },
  };
}

export function tupleToFleet(tuple: FleetTuple): Fleet {
  return {
    id: tuple[0],
    lobbyId: tuple[1],
    owner: tuple[2],
    shipIds: tuple[3],
    totalCost: tuple[4],
    isComplete: tuple[5],
  };
}

export function tupleToPlayerLobbyState(
  tuple: PlayerLobbyStateTuple,
): PlayerLobbyState {
  return {
    activeLobbyId: tuple[0],
    activeLobbiesCount: tuple[1],
    hasActiveLobby: tuple[2],
    kickCount: tuple[3],
    lastKickTime: tuple[4],
  };
}

export function tupleToGameData(tuple: GameDataTuple): GameData {
  return {
    gameId: tuple[0],
    lobbyId: tuple[1],
    creator: tuple[2],
    joiner: tuple[3],
    creatorFleetId: tuple[4],
    joinerFleetId: tuple[5],
    creatorGoesFirst: tuple[6],
    startedAt: tuple[7],
    currentTurn: tuple[8],
  };
}

export interface Position {
  row: number; // Row position (0 to gridHeight-1)
  col: number; // Column position (0 to gridWidth-1)
}

export interface ShipPosition {
  shipId: bigint;
  position: Position;
  isCreator: boolean;
}

export interface LastMove {
  shipId: bigint;
  oldRow: number;
  oldCol: number;
  newRow: number;
  newCol: number;
  actionType: ActionType;
  targetShipId: bigint;
  timestamp: bigint; // When the move was made
}

export interface GameDataView {
  metadata: GameMetadata;
  turnState: GameTurnState;
  gridDimensions: GameGridDimensions;
  maxScore: bigint; // Maximum score needed to win the game
  creatorScore: bigint; // Current score of the creator player
  joinerScore: bigint; // Current score of the joiner player
  lastMove: LastMove; // Most recent move in the game
  shipAttributes: readonly Attributes[]; // Combined array of all ship attributes indexed by ship ID
  shipPositions: readonly ShipPosition[]; // All ship positions on the grid
  shipIds: readonly bigint[];
  creatorActiveShipIds: readonly bigint[];
  joinerActiveShipIds: readonly bigint[];
  creatorMovedShipIds: readonly bigint[]; // Creator ships that have moved this round
  joinerMovedShipIds: readonly bigint[]; // Joiner ships that have moved this round
}

export enum ActionType {
  Pass,
  Shoot,
  Retreat,
  Assist,
  Special,
  FactionAbility,
}

export enum MapMode {
  PvP,
  PvE,
  Both,
}
