//! Rule errors. Variant names deliberately match the Solidity custom-error
//! names (`InvalidMove`, `ShipAlreadyMoved`, ...) so ported tests and the
//! frontend can keep matching on the same strings.

use core::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    // Engine (Game.sol)
    GameNotFound,
    ShipNotFound,
    ShipNotOwned,
    ShipAlreadyMoved,
    InvalidMove,
    ShipDestroyed,
    GameAlreadyExists,
    InvalidHealCapPercent,
    // Maps.sol
    InvalidPosition,
    MapNotFound,
    // ShipAttributes.sol
    InvalidAttributesVersion,
    InvalidCostsVersion,
    VariantNotConfigured,
    InvalidArrayLength,
    InvalidRankConfig,
    // SpecialEffectsLib.sol
    RelocationDestinationOccupied,
    RelocationOutOfBounds,
    // Resolvers
    InvalidRamTarget,
    OutOfRange,
    TargetNotFound,
    TargetNotFriendly,
    TargetNotEnemy,
    // Solidity checked-arithmetic panic (0x11)
    ArithmeticOverflow,
}

impl Error {
    pub fn name(&self) -> &'static str {
        match self {
            Error::GameNotFound => "GameNotFound",
            Error::ShipNotFound => "ShipNotFound",
            Error::ShipNotOwned => "ShipNotOwned",
            Error::ShipAlreadyMoved => "ShipAlreadyMoved",
            Error::InvalidMove => "InvalidMove",
            Error::ShipDestroyed => "ShipDestroyed",
            Error::GameAlreadyExists => "GameAlreadyExists",
            Error::InvalidHealCapPercent => "InvalidHealCapPercent",
            Error::InvalidPosition => "InvalidPosition",
            Error::MapNotFound => "MapNotFound",
            Error::InvalidAttributesVersion => "InvalidAttributesVersion",
            Error::InvalidCostsVersion => "InvalidCostsVersion",
            Error::VariantNotConfigured => "VariantNotConfigured",
            Error::InvalidArrayLength => "InvalidArrayLength",
            Error::InvalidRankConfig => "InvalidRankConfig",
            Error::RelocationDestinationOccupied => "RelocationDestinationOccupied",
            Error::RelocationOutOfBounds => "RelocationOutOfBounds",
            Error::InvalidRamTarget => "InvalidRamTarget",
            Error::OutOfRange => "OutOfRange",
            Error::TargetNotFound => "TargetNotFound",
            Error::TargetNotFriendly => "TargetNotFriendly",
            Error::TargetNotEnemy => "TargetNotEnemy",
            Error::ArithmeticOverflow => "ArithmeticOverflow",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

pub type Result<T> = core::result::Result<T, Error>;

/// Checked u8 add mirroring Solidity 0.8 overflow reverts.
pub(crate) fn add_u8(a: u8, b: u8) -> Result<u8> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}
