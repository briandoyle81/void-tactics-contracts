// Test-only EVM storage manipulation replacing Game.sol's removed debug
// functions (debugDestroyShip/debugSetHullPointsToZero/debugSetShipPosition
// — see docs/audit-2.md I-01). These write directly to the Hardhat test
// blockchain's storage slots via hardhat-network-helpers' setStorageAt —
// nothing here has any on-chain footprint; it's pure test-side state setup,
// exactly the same kind of technique as Foundry's `vm.store`.
//
// Every slot number/offset below was cross-checked against the Solidity
// compiler's own authoritative storageLayout output (`hardhat.config.ts`
// requests it; see artifacts/build-info/*.json's
// .output.contracts["contracts/Game.sol"].Game.storageLayout) rather than
// hand-derived alone — that check caught a real bug (the `games` mapping is
// slot 10, not 9, because `Game is Ownable` and Ownable's own `_owner`
// occupies slot 0, shifting every one of Game.sol's own declared variables
// up by one). If Game.sol's or Types.sol's state variables / struct fields
// are ever reordered, re-derive against a fresh storageLayout dump before
// trusting these constants again — nothing else would catch a silent slot
// shift except test/GameDebugHelpers.test.ts's equivalence checks.
import {
  concat,
  hexToBigInt,
  keccak256,
  numberToHex,
  type Hex,
} from "viem";
import {
  getStorageAt,
  setStorageAt,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

// ---- Game.sol / Types.sol storage layout constants ----

// Game.sol's own state variables start at slot 1 (slot 0 is Ownable's
// _owner). `games` is the 10th one declared (ships, fleets, shipAttributes,
// maps, isAllowedToStartGames, factionAbilityResolvers, specialResolvers,
// maxSpecialSlot, healCapPercent, games) -> slot 10. Re-verified against a
// fresh storageLayout dump (2026-09-26, after adding maxSpecialSlot) per
// this file's own header note — do the same any time Game.sol's declared
// variables are reordered or a new one is added above `games`.
const GAMES_SLOT = 10n;

// GameData (Types.sol) field offsets, relative to a given game's base slot.
// Re-derived 2026-10-30 after the shipAttributes mapping was folded into
// shipBoard and the moved-ships set became a count plus per-ship rounds,
// and again 2026-10-31 after lastMove shrank from four slots to one and
// the moved count became movedTotal - movedAtRoundStart, and the grid
// mapping became the one-word `occupied` bitmap (same slot), and
// `live[2]` (per-side live-ship bitmaps) was appended, and the lastDamage
// mapping moved into ShipBoardState (every later field shifts down one).
const GD_CURRENT_ROUND = 13n; // turnState (10) + GameTurnState.currentRound (3)
const GD_OCCUPIED = 19n;
// Must match Game.sol's GRID_WIDTH / GRID_HEIGHT.
const GRID_WIDTH = 17;
const GRID_HEIGHT = 11;
const GD_SHIP_BOARD = 20n;
const GD_MOVED_TOTAL = 21n;
const GD_LIVE = 32n; // live[0] = creator, live[1] = joiner
const GD_SHIPS_WITH_ZERO_HP = 23n;

// ShipBoardState (Types.sol, 2026-10-30) packs a ship's board state and
// stats into one slot: row(i16,@0) col(i16,@2) isCreator(bool,@4)
// status(u8,@5) placed(bool,@6) version(u16,@7) range(u8,@9)
// gunDamage(u8,@10) hullPoints(u8,@11) maxHullPoints(u8,@12)
// movement(u8,@13) damageReduction(u8,@14) reactorCriticalTimer(u8,@15)
// movedInRound(u24,@16) zeroedAfterMovingRound(u24,@19) activeIndex(u8,@22)
// variant(u16,@23) special(u8,@25) lastDamager(u48,@26) (2026-10-31).
// Byte offsets are measured from the word's least-significant byte
// (Solidity convention). Checked against the compiler's storageLayout.
const SB_ROW_BYTE_OFFSET = 0;
const SB_COL_BYTE_OFFSET = 2;
const SB_IS_CREATOR_BYTE_OFFSET = 4;
const SB_STATUS_BYTE_OFFSET = 5;
const SB_HULL_POINTS_BYTE_OFFSET = 11;
const SB_REACTOR_TIMER_BYTE_OFFSET = 15;
const SB_MOVED_IN_ROUND_BYTE_OFFSET = 16;

// EnumerableSet.UintSet (OZ 5.3.0): _inner.slot+0 = _values (bytes32[]
// length; data at keccak256(slot)), _inner.slot+1 = _positions (mapping
// bytes32 => uint256, 1-indexed, 0 = not present).
const SET_VALUES_SLOT_OFFSET = 0n;
const SET_POSITIONS_SLOT_OFFSET = 1n;

// ---- low-level slot arithmetic ----

function pad32(value: bigint): Hex {
  const asUint = value < 0n ? (1n << 256n) + value : value;
  return numberToHex(asUint, { size: 32 });
}

// Solidity mapping slot formula: keccak256(pad32(key) . pad32(baseSlot)).
// Works identically for a uint256 key (games[gameId], shipBoard[shipId])
// and a bytes32 key (EnumerableSet's _positions[bytes32(value)]) — a
// uint256 value and its bytes32 cast share the same 32-byte encoding.
function mappingSlot(key: bigint, baseSlot: bigint): bigint {
  return hexToBigInt(keccak256(concat([pad32(key), pad32(baseSlot)])));
}

// Dynamic array data start (Solidity: keccak256(pad32(lengthSlot))).
function arrayDataStart(lengthSlot: bigint): bigint {
  return hexToBigInt(keccak256(pad32(lengthSlot)));
}

async function readWord(address: string, slot: bigint): Promise<bigint> {
  return hexToBigInt((await getStorageAt(address, slot)) as Hex);
}

function readByteRange(
  word: bigint,
  byteOffset: number,
  byteWidth: number
): bigint {
  const mask = (1n << BigInt(byteWidth * 8)) - 1n;
  return (word >> BigInt(byteOffset * 8)) & mask;
}

function writeByteRange(
  word: bigint,
  byteOffset: number,
  byteWidth: number,
  value: bigint
): bigint {
  const mask = (1n << BigInt(byteWidth * 8)) - 1n;
  const cleared = word & ~(mask << BigInt(byteOffset * 8));
  return cleared | ((value & mask) << BigInt(byteOffset * 8));
}

function toInt16(raw: bigint): number {
  const v = Number(raw & 0xffffn);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function fromInt16(value: number): bigint {
  const unsigned = value < 0 ? value + 0x10000 : value;
  return BigInt(unsigned) & 0xffffn;
}

function gameBaseSlot(gameId: bigint): bigint {
  return mappingSlot(gameId, GAMES_SLOT);
}

// A cell's bit in GameData.occupied (row * GRID_WIDTH + col, as in Game.sol).
function cellBit(row: number, col: number): bigint {
  if (row < 0 || col < 0 || row >= GRID_HEIGHT || col >= GRID_WIDTH) {
    throw new Error(`cell (${row}, ${col}) is off the board`);
  }
  return 1n << BigInt(row * GRID_WIDTH + col);
}

// Sets or clears the cell's bit in its side's GameData.live word, given the
// ship's board word (for its side).
async function setLiveBit(
  gameAddress: string,
  gameId: bigint,
  boardWord: bigint,
  row: number,
  col: number,
  isLive: boolean
): Promise<void> {
  const isCreator = readByteRange(boardWord, SB_IS_CREATOR_BYTE_OFFSET, 1) !== 0n;
  const slot = gameBaseSlot(gameId) + GD_LIVE + (isCreator ? 0n : 1n);
  const word = await readWord(gameAddress, slot);
  const bit = cellBit(row, col);
  await setStorageAt(gameAddress, slot, isLive ? word | bit : word & ~bit);
}

function isLiveBoardWord(boardWord: bigint): boolean {
  return (
    readByteRange(boardWord, SB_STATUS_BYTE_OFFSET, 1) === 0n &&
    readByteRange(boardWord, SB_HULL_POINTS_BYTE_OFFSET, 1) !== 0n
  );
}

// Read-only: one side's GameData.live word, straight from storage.
export async function getLiveBitmap(
  gameAddress: string,
  gameId: bigint,
  isCreator: boolean
): Promise<bigint> {
  return readWord(gameAddress, gameBaseSlot(gameId) + GD_LIVE + (isCreator ? 0n : 1n));
}

// Read-only: whether a grid cell is occupied, straight from storage.
export async function isCellOccupied(
  gameAddress: string,
  gameId: bigint,
  row: number,
  col: number
): Promise<boolean> {
  const occupied = await readWord(gameAddress, gameBaseSlot(gameId) + GD_OCCUPIED);
  return (occupied & cellBit(row, col)) !== 0n;
}

// ---- EnumerableSet.UintSet add/remove (faithful OZ 5.3.0 replica) ----

async function enumerableSetAdd(
  address: string,
  setBaseSlot: bigint,
  value: bigint
): Promise<void> {
  const positionsBase = setBaseSlot + SET_POSITIONS_SLOT_OFFSET;
  const posSlot = mappingSlot(value, positionsBase);
  const currentPos = await readWord(address, posSlot);
  if (currentPos !== 0n) return; // already present, matches OZ's no-op-on-duplicate

  const lengthSlot = setBaseSlot + SET_VALUES_SLOT_OFFSET;
  const len = await readWord(address, lengthSlot);
  const dataStart = arrayDataStart(lengthSlot);

  await setStorageAt(address, dataStart + len, value);
  await setStorageAt(address, lengthSlot, len + 1n);
  await setStorageAt(address, posSlot, len + 1n); // 1-indexed
}

async function enumerableSetRemove(
  address: string,
  setBaseSlot: bigint,
  value: bigint
): Promise<void> {
  const positionsBase = setBaseSlot + SET_POSITIONS_SLOT_OFFSET;
  const posSlot = mappingSlot(value, positionsBase);
  const pos = await readWord(address, posSlot);
  if (pos === 0n) return; // not present, matches OZ's no-op

  const valueIndex = pos - 1n;
  const lengthSlot = setBaseSlot + SET_VALUES_SLOT_OFFSET;
  const len = await readWord(address, lengthSlot);
  const lastIndex = len - 1n;
  const dataStart = arrayDataStart(lengthSlot);

  if (valueIndex !== lastIndex) {
    const lastValue = await readWord(address, dataStart + lastIndex);
    await setStorageAt(address, dataStart + valueIndex, lastValue);
    const lastValuePosSlot = mappingSlot(lastValue, positionsBase);
    await setStorageAt(address, lastValuePosSlot, pos);
  }

  await setStorageAt(address, lengthSlot, lastIndex);
  await setStorageAt(address, posSlot, 0n);
}

// ---- purpose-built helpers (these are what test files call) ----

// Replaces debugSetShipPosition. Reads the ship's current position first
// (directly from storage, so this helper has no dependency on a contract
// instance/ABI — just the deployed address) to know which grid cell to
// clear, matching the real function's behavior: clear old grid cell, set
// position and clear status (revive from destroyed/fled if it was) in the
// ship's packed board slot, set new grid cell (bits in `occupied`).
export async function setShipPosition(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint,
  row: number,
  col: number
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const boardSlot = mappingSlot(shipId, gameSlot + GD_SHIP_BOARD);

  const oldWord = await readWord(gameAddress, boardSlot);
  const oldRow = toInt16(readByteRange(oldWord, SB_ROW_BYTE_OFFSET, 2));
  const oldCol = toInt16(readByteRange(oldWord, SB_COL_BYTE_OFFSET, 2));


  // Keeps isCreator and placed; writes row, col and status 0.
  let newWord = writeByteRange(oldWord, SB_ROW_BYTE_OFFSET, 2, fromInt16(row));
  newWord = writeByteRange(newWord, SB_COL_BYTE_OFFSET, 2, fromInt16(col));
  newWord = writeByteRange(newWord, SB_STATUS_BYTE_OFFSET, 1, 0n);
  await setStorageAt(gameAddress, boardSlot, newWord);

  if (isLiveBoardWord(oldWord)) {
    await setLiveBit(gameAddress, gameId, oldWord, oldRow, oldCol, false);
  }
  if (isLiveBoardWord(newWord)) {
    await setLiveBit(gameAddress, gameId, newWord, row, col, true);
  }

  const occupiedSlot = gameSlot + GD_OCCUPIED;
  const occupied = await readWord(gameAddress, occupiedSlot);
  await setStorageAt(
    gameAddress,
    occupiedSlot,
    (occupied & ~cellBit(oldRow, oldCol)) | cellBit(row, col)
  );
}

// Replaces debugSetHullPointsToZero: hullPoints=0, un-mark as moved this
// round, add to shipsWithZeroHP — same three effects as
// _setShipHPToZero plus the debug function's own extra explicit
// moved-flag removal.
export async function setShipHullPointsToZero(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const shipBoardBase = gameSlot + GD_SHIP_BOARD;
  const boardSlot = mappingSlot(shipId, shipBoardBase);

  const boardWord = await readWord(gameAddress, boardSlot);
  let newBoardWord = writeByteRange(
    boardWord,
    SB_HULL_POINTS_BYTE_OFFSET,
    1,
    0n
  );

  // Un-mark it as moved this round (movedInRound == currentRound), as the
  // debug function's removal from the old moved-ships set did.
  const currentRound = await readWord(gameAddress, gameSlot + GD_CURRENT_ROUND);
  if (readByteRange(boardWord, SB_MOVED_IN_ROUND_BYTE_OFFSET, 3) === currentRound) {
    newBoardWord = writeByteRange(newBoardWord, SB_MOVED_IN_ROUND_BYTE_OFFSET, 3, 0n);
    const countSlot = gameSlot + GD_MOVED_TOTAL;
    await setStorageAt(gameAddress, countSlot, (await readWord(gameAddress, countSlot)) - 1n);
  }
  await setStorageAt(gameAddress, boardSlot, newBoardWord);
  await clearLiveBitOf(gameAddress, gameId, boardWord);

  await enumerableSetAdd(
    gameAddress,
    gameSlot + GD_SHIPS_WITH_ZERO_HP,
    shipId
  );
}

// Sets a ship's current hull points to `hp` (an "injured but alive" ship when
// 0 < hp < max). Only the hull byte is written; use setShipHullPointsToZero
// for a downed ship, which also needs the zero-HP bookkeeping.
export async function setShipHullPoints(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint,
  hp: number
): Promise<void> {
  const boardSlot = mappingSlot(
    shipId,
    gameBaseSlot(gameId) + GD_SHIP_BOARD
  );
  const boardWord = await readWord(gameAddress, boardSlot);
  const newWord = writeByteRange(boardWord, SB_HULL_POINTS_BYTE_OFFSET, 1, BigInt(hp));
  await setStorageAt(gameAddress, boardSlot, newWord);
  if (readByteRange(boardWord, SB_STATUS_BYTE_OFFSET, 1) === 0n) {
    await setLiveBit(
      gameAddress,
      gameId,
      boardWord,
      toInt16(readByteRange(boardWord, SB_ROW_BYTE_OFFSET, 2)),
      toInt16(readByteRange(boardWord, SB_COL_BYTE_OFFSET, 2)),
      hp > 0
    );
  }
}

// Byte offsets of ShipBoardState's single-byte stats (Types.sol).
const SB_STAT_BYTE_OFFSET = {
  range: 9,
  gunDamage: 10,
  movement: 13,
  damageReduction: 14,
} as const;

// Overwrites one of a ship's board stats, for scenarios that need exact
// numbers (purchased test ships roll theirs).
export async function setShipStat(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint,
  stat: keyof typeof SB_STAT_BYTE_OFFSET,
  value: number
): Promise<void> {
  const boardSlot = mappingSlot(
    shipId,
    gameBaseSlot(gameId) + GD_SHIP_BOARD
  );
  const boardWord = await readWord(gameAddress, boardSlot);
  await setStorageAt(
    gameAddress,
    boardSlot,
    writeByteRange(boardWord, SB_STAT_BYTE_OFFSET[stat], 1, BigInt(value))
  );
}

// Clears a ship's live bit (it just went to 0 HP), if it is on the board.
async function clearLiveBitOf(
  gameAddress: string,
  gameId: bigint,
  boardWord: bigint
): Promise<void> {
  if (readByteRange(boardWord, SB_STATUS_BYTE_OFFSET, 1) !== 0n) return;
  await setLiveBit(
    gameAddress,
    gameId,
    boardWord,
    toInt16(readByteRange(boardWord, SB_ROW_BYTE_OFFSET, 2)),
    toInt16(readByteRange(boardWord, SB_COL_BYTE_OFFSET, 2)),
    false
  );
}

// Replaces debugDestroyShip — NOT by replicating _removeShipFromGame (too
// cross-cutting: 3 EnumerableSets, a dynamic array push, and cross-contract
// calls into Fleets/Ships plus a conditional orchestrator callback — see
// docs/audit-2.md I-01's resolution). Instead: prime the ship (hullPoints=0
// AND reactorCriticalTimer=2, packed into the same word as one write, plus
// shipsWithZeroHP membership), then the CALLER must drive one real round to
// completion. Game.sol's own existing
// _incrementReactorCriticalTimerForZeroHPShips then increments the timer to
// 3 and calls the real _removeShipFromGame itself — fully correct
// cross-contract cleanup through the actual production code path, not a
// hand-rolled replica. Does not touch the ship's moved flag: round
// completion only needs a ship counted as EITHER moved or in
// shipsWithZeroHP (see Game.sol's _checkRoundComplete), so leaving it
// as-is is harmless.
export async function primeShipForRealDestruction(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const shipBoardBase = gameSlot + GD_SHIP_BOARD;
  const boardSlot = mappingSlot(shipId, shipBoardBase);

  let boardWord = await readWord(gameAddress, boardSlot);
  await clearLiveBitOf(gameAddress, gameId, boardWord);
  boardWord = writeByteRange(boardWord, SB_HULL_POINTS_BYTE_OFFSET, 1, 0n);
  boardWord = writeByteRange(
    boardWord,
    SB_REACTOR_TIMER_BYTE_OFFSET,
    1,
    2n
  );
  await setStorageAt(gameAddress, boardSlot, boardWord);

  await enumerableSetAdd(
    gameAddress,
    gameSlot + GD_SHIPS_WITH_ZERO_HP,
    shipId
  );
}
