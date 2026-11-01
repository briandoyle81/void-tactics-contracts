// Checks the AI turn's data path (2026-10-31) against getGame, which the
// orchestrators used to decode in full before every AI move:
// - AIBehavior.unpackBoard(Game.getAIBoard) rebuilds exactly the active
//   ships, creator side first, with entry i of every array describing the
//   same ship (AIBehavior relies on that, G-01), and the stats and
//   positions getGame reports;
// - the board header's bitmaps match Game's occupied/live state;
// - AIBehavior.turnState picks the same next ship the old
//   _findUnmovedShip did (first joiner ship, in active-list order, that
//   hasn't moved this round and has HP > 0) and agrees on the rest.
import hre from "hardhat";
import { expect } from "chai";
import { getLiveBitmap, isCellOccupied } from "./gameStorage";

const GRID_WIDTH = 17;

export async function expectAIViewsConsistent(game: any, gameId: bigint): Promise<void> {
  const harness = await hre.viem.deployContract("AIBoardHarness");
  const g = await game.read.getGame([gameId]);
  const board = await game.read.getAIBoard([gameId]);
  const v = await harness.read.unpack([board]);

  const activeIds = [...g.creatorActiveShipIds, ...g.joinerActiveShipIds];
  expect(v.shipIds).to.deep.equal(activeIds);
  expect(v.shipAttributes).to.deep.equal(g.shipAttributes);
  let occupied = 0n;
  for (let i = 0; i < activeIds.length; i++) {
    const sp = g.shipPositions.find((p: any) => p.shipId === activeIds[i]);
    expect(v.shipPositions[i]).to.deep.equal(sp);
    occupied |= 1n << BigInt(sp.position.row * GRID_WIDTH + sp.position.col);
    expect(await isCellOccupied(game.address, gameId, sp.position.row, sp.position.col)).to.equal(true);
  }
  expect(board[0]).to.equal(occupied);
  expect(board[1]).to.equal(await getLiveBitmap(game.address, gameId, true));
  expect(board[2]).to.equal(await getLiveBitmap(game.address, gameId, false));

  const moved = new Set(g.joinerMovedShipIds.map(String));
  const base = g.creatorActiveShipIds.length;
  let expectedNext = 0n;
  let expectedPos = { row: 0, col: 0 };
  for (let i = 0; i < g.joinerActiveShipIds.length; i++) {
    const id = g.joinerActiveShipIds[i];
    if (moved.has(String(id)) || g.shipAttributes[base + i].hullPoints === 0) continue;
    expectedNext = id;
    expectedPos = g.shipPositions.find((p: any) => p.shipId === id).position;
    break;
  }
  const hasLive = g.joinerActiveShipIds.some(
    (_: bigint, i: number) => g.shipAttributes[base + i].hullPoints > 0,
  );
  const [ended, currentTurn, creator, hasLiveShip, nextShipId, nextPosition] =
    await harness.read.turnState([board]);
  expect(ended).to.equal(g.metadata.ended);
  expect(currentTurn).to.equal(g.turnState.currentTurn);
  expect(creator).to.equal(g.metadata.creator);
  expect(hasLiveShip).to.equal(hasLive);
  expect(nextShipId).to.equal(expectedNext);
  if (expectedNext !== 0n) expect(nextPosition).to.deep.equal(expectedPos);
}
