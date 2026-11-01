// Checks Game's stored per-side live bitmaps (GameData.live, 2026-10-31)
// against the board state the public views report: a cell's bit is set in
// a side's word exactly when one of that side's active ships sits there
// with HP > 0. A missed update in the contracts shows up as wrong
// movement/line-of-sight blocking, never a revert, so tests that drive
// HP and position changes call this to catch it directly.
import { expect } from "chai";
import { getLiveBitmap } from "./gameStorage";

const GRID_WIDTH = 17;

export async function expectLiveBitmapsConsistent(
  game: any,
  gameId: bigint
): Promise<void> {
  const data = await game.read.getGame([gameId]);
  const sides: [boolean, readonly bigint[]][] = [
    [true, data.creatorActiveShipIds],
    [false, data.joinerActiveShipIds],
  ];
  for (const [isCreator, ids] of sides) {
    let expected = 0n;
    for (const id of ids) {
      const attrs = await game.read.getShipAttributes([gameId, id]);
      if (attrs.hullPoints === 0) continue;
      const pos = await game.read.getShipPosition([gameId, id]);
      expected |=
        1n << BigInt(pos.position.row * GRID_WIDTH + pos.position.col);
    }
    const stored = await getLiveBitmap(game.address, gameId, isCreator);
    expect(
      stored.toString(2),
      `${isCreator ? "creator" : "joiner"} live bitmap, game ${gameId}`
    ).to.equal(expected.toString(2));
  }
}
