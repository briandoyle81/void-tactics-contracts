//! The 17x11 board and its one-bit-per-cell bitmaps.
//!
//! Bit index = row * GRID_WIDTH + col, identical to Maps.sol/Game.sol, so a
//! Solidity uint256 bitmap and a `Bitmap` hold the same bits (187 of 192 used).

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

pub const GRID_WIDTH: i16 = 17; // columns
pub const GRID_HEIGHT: i16 = 11; // rows
pub const TOTAL_CELLS: usize = (GRID_WIDTH as usize) * (GRID_HEIGHT as usize);

#[inline]
pub fn in_bounds(row: i16, col: i16) -> bool {
    row >= 0 && row < GRID_HEIGHT && col >= 0 && col < GRID_WIDTH
}

/// Callers must bounds-check first (an out-of-range cell would alias another).
#[inline]
pub fn bit_index(row: i16, col: i16) -> usize {
    (row as usize) * (GRID_WIDTH as usize) + (col as usize)
}

/// 192-bit cell set; limb 0 holds bits 0..63.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub struct Bitmap(pub [u64; 3]);

impl Bitmap {
    pub const EMPTY: Bitmap = Bitmap([0; 3]);

    #[inline]
    pub fn get(&self, idx: usize) -> bool {
        (self.0[idx / 64] >> (idx % 64)) & 1 == 1
    }
    #[inline]
    pub fn set(&mut self, idx: usize) {
        self.0[idx / 64] |= 1u64 << (idx % 64);
    }
    #[inline]
    pub fn clear(&mut self, idx: usize) {
        self.0[idx / 64] &= !(1u64 << (idx % 64));
    }
    #[inline]
    pub fn cell(row: i16, col: i16) -> Bitmap {
        let mut b = Bitmap::EMPTY;
        b.set(bit_index(row, col));
        b
    }
    #[inline]
    pub fn has_cell(&self, row: i16, col: i16) -> bool {
        self.get(bit_index(row, col))
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0 == [0; 3]
    }
    pub fn count(&self) -> u32 {
        self.0.iter().map(|l| l.count_ones()).sum()
    }
    /// Cells in ascending bit order, as (row, col).
    pub fn cells(&self) -> Vec<(i16, i16)> {
        (0..TOTAL_CELLS)
            .filter(|&i| self.get(i))
            .map(|i| ((i / GRID_WIDTH as usize) as i16, (i % GRID_WIDTH as usize) as i16))
            .collect()
    }
    /// Left shift within 192 bits. (Solidity shifts in 256 bits, but every AI
    /// use masks to the 187-cell board afterwards, so the result is the same.)
    pub fn shl(&self, n: u32) -> Bitmap {
        let mut out = [0u64; 3];
        for (i, &limb) in self.0.iter().enumerate() {
            for b in 0..64 {
                if (limb >> b) & 1 == 1 {
                    let idx = i as u32 * 64 + b + n;
                    if idx < 192 {
                        out[(idx / 64) as usize] |= 1 << (idx % 64);
                    }
                }
            }
        }
        Bitmap(out)
    }
    pub fn shr(&self, n: u32) -> Bitmap {
        let mut out = [0u64; 3];
        for (i, &limb) in self.0.iter().enumerate() {
            for b in 0..64 {
                if (limb >> b) & 1 == 1 {
                    let idx = i as u32 * 64 + b;
                    if idx >= n {
                        let j = idx - n;
                        out[(j / 64) as usize] |= 1 << (j % 64);
                    }
                }
            }
        }
        Bitmap(out)
    }
    /// Index of the lowest set bit (caller ensures non-empty).
    pub fn lowest(&self) -> usize {
        for (i, &l) in self.0.iter().enumerate() {
            if l != 0 {
                return i * 64 + l.trailing_zeros() as usize;
            }
        }
        0
    }
    pub fn single(idx: usize) -> Bitmap {
        let mut b = Bitmap::EMPTY;
        b.set(idx);
        b
    }
    /// All 187 board cells (AIBehavior.BOARD_MASK).
    pub fn board_mask() -> Bitmap {
        let mut b = Bitmap::EMPTY;
        for i in 0..TOTAL_CELLS {
            b.set(i);
        }
        b
    }
    /// Column-0 cells (AIBehavior.COL_FIRST) / column-16 cells (COL_LAST).
    pub fn col_mask(col: i16) -> Bitmap {
        let mut b = Bitmap::EMPTY;
        for r in 0..GRID_HEIGHT {
            b.set(bit_index(r, col));
        }
        b
    }

    /// From a Solidity uint256 bitmap given as 32 big-endian bytes.
    pub fn from_u256_be(bytes: &[u8; 32]) -> Bitmap {
        let limb = |i: usize| {
            // limb i = bits 64i..64i+63 = bytes [32-8(i+1), 32-8i)
            let start = 32 - 8 * (i + 1);
            u64::from_be_bytes(bytes[start..start + 8].try_into().unwrap())
        };
        Bitmap([limb(0), limb(1), limb(2)])
    }
}

impl core::ops::BitOr for Bitmap {
    type Output = Bitmap;
    fn bitor(self, o: Bitmap) -> Bitmap {
        Bitmap([self.0[0] | o.0[0], self.0[1] | o.0[1], self.0[2] | o.0[2]])
    }
}
impl core::ops::BitAnd for Bitmap {
    type Output = Bitmap;
    fn bitand(self, o: Bitmap) -> Bitmap {
        Bitmap([self.0[0] & o.0[0], self.0[1] & o.0[1], self.0[2] & o.0[2]])
    }
}
impl core::ops::BitXorAssign for Bitmap {
    fn bitxor_assign(&mut self, o: Bitmap) {
        for i in 0..3 {
            self.0[i] ^= o.0[i];
        }
    }
}
impl core::ops::BitOrAssign for Bitmap {
    fn bitor_assign(&mut self, o: Bitmap) {
        for i in 0..3 {
            self.0[i] |= o.0[i];
        }
    }
}
impl core::ops::BitAndAssign for Bitmap {
    fn bitand_assign(&mut self, o: Bitmap) {
        for i in 0..3 {
            self.0[i] &= o.0[i];
        }
    }
}
impl core::ops::Not for Bitmap {
    type Output = Bitmap;
    fn not(self) -> Bitmap {
        Bitmap([!self.0[0], !self.0[1], !self.0[2]])
    }
}

/// Manhattan distance, truncated to u8 like Game._manhattanDistance (on-board
/// distances are at most 26).
pub fn manhattan(a: (i16, i16), b: (i16, i16)) -> u8 {
    ((a.0 - b.0).unsigned_abs() + (a.1 - b.1).unsigned_abs()) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_layout_matches_solidity() {
        assert_eq!(bit_index(0, 0), 0);
        assert_eq!(bit_index(10, 16), 186);
        let mut b = Bitmap::EMPTY;
        b.set(186);
        assert!(b.has_cell(10, 16));
        assert_eq!(b.cells(), vec![(10, 16)]);
    }

    #[test]
    fn u256_conversion() {
        let mut bytes = [0u8; 32];
        bytes[31] = 0b101; // bits 0 and 2
        bytes[23] = 1; // bit 64
        let b = Bitmap::from_u256_be(&bytes);
        assert!(b.get(0) && !b.get(1) && b.get(2) && b.get(64));
        assert_eq!(b.count(), 3);
    }
}
