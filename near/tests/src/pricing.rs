//! Ship-pack pricing for NEAR deploys, mirroring the EVM deploy module
//! (ignition/modules/DeployAndConfig.ts: TIER_USD_PRICES, getEthUsdPrice,
//! computeTierPricesWei):
//!   - the same "~$1/ship with bulk discount" USD curve;
//!   - a live NEAR/USD price from CoinGecko for real deploys, cached on disk
//!     for 24h (near/.near-price-cache.json) so retries don't re-hit the API;
//!   - a sanity range so a malformed response can't price ships near zero;
//!   - a fixed test price so tests never touch the network.
//!
//! UTC prices stay in UTC (4.99 .. 49.99): only the native-NEAR fields are
//! priced from the market (the 2026-10-23 lesson: never write native-sized
//! numbers into the UTC prices).

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub const TIER_SHIPS: [u8; 5] = [5, 11, 22, 40, 60];
/// USD price per pack; also the UTC price per pack (1 UTC = $1 design).
pub const TIER_USD_PRICES: [f64; 5] = [4.99, 9.99, 19.99, 34.99, 49.99];

/// Fixed NEAR/USD for tests and non-production seeding (deterministic, no
/// network). Never used to price a real deploy.
pub const TEST_NEAR_USD_PRICE: f64 = 2.50;
pub const MIN_SANE_NEAR_USD_PRICE: f64 = 0.10;
pub const MAX_SANE_NEAR_USD_PRICE: f64 = 1_000.0;
const CACHE_TTL_S: u64 = 24 * 60 * 60;

const E18: u128 = 1_000_000_000_000_000_000;
/// Upper bound on one ship's mint-time storage (record + owner index +
/// randomness request + mapping, with account-id headroom), in bytes. A tier
/// priced below its pack's storage can't be bought (the contract enforces
/// it too); seeding refuses such prices.
pub const MAX_BYTES_PER_SHIP: u128 = 600;
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;

#[derive(Clone, Copy, Debug)]
pub enum NearUsd {
    /// TEST_NEAR_USD_PRICE.
    Test,
    /// Live CoinGecko price (cached 24h).
    Live,
    /// An explicit price (e.g. pinned by the operator).
    Fixed(f64),
}

impl NearUsd {
    pub fn resolve(self) -> Result<f64> {
        match self {
            NearUsd::Test => Ok(TEST_NEAR_USD_PRICE),
            NearUsd::Fixed(p) => check_sane(p),
            NearUsd::Live => live_near_usd_price(),
        }
    }
}

fn cache_path() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.near-price-cache.json"))
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn check_sane(price: f64) -> Result<f64> {
    if !price.is_finite() || !(MIN_SANE_NEAR_USD_PRICE..=MAX_SANE_NEAR_USD_PRICE).contains(&price) {
        bail!(
            "NEAR/USD price ${price} is outside the sane range [${MIN_SANE_NEAR_USD_PRICE}, ${MAX_SANE_NEAR_USD_PRICE}]; \
             refusing to price ship tiers off it. Check the API response, or widen the range if NEAR has genuinely moved."
        );
    }
    Ok(price)
}

/// Cached price if present, well-formed and under 24h old. Any problem falls
/// through to a fresh fetch rather than failing the deploy.
fn read_cache() -> Option<f64> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cache_path()).ok()?).ok()?;
    let (price, at) = (v["price"].as_f64()?, v["fetched_at"].as_u64()?);
    (price.is_finite() && now_s().saturating_sub(at) <= CACHE_TTL_S).then_some(price)
}

/// Best effort: a read-only filesystem must not fail a deploy that already
/// has a valid price.
fn write_cache(price: f64) {
    if let Err(e) = std::fs::write(cache_path(), json!({ "price": price, "fetched_at": now_s() }).to_string()) {
        eprintln!("[pricing] failed to write NEAR/USD price cache (non-fatal): {e}");
    }
}

/// Live NEAR/USD from CoinGecko (curl, like the EVM deploy), cached 24h.
pub fn live_near_usd_price() -> Result<f64> {
    if let Some(p) = read_cache() {
        eprintln!("[pricing] using cached NEAR/USD price: ${p} (fetched within the last 24h)");
        return check_sane(p);
    }
    let out = Command::new("curl")
        .args(["-sf", "--max-time", "10", "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd"])
        .output()
        .context("running curl for the NEAR/USD price")?;
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        bail!("failed to fetch the NEAR/USD price (curl exit {:?}). Raw response: {raw}", out.status.code());
    }
    let v: Value = serde_json::from_str(&raw).with_context(|| format!("failed to parse NEAR/USD response: {raw}"))?;
    let price = v["near"]["usd"].as_f64().with_context(|| format!("no usable NEAR/USD price in response: {raw}"))?;
    let price = check_sane(price)?;
    eprintln!("[pricing] using live NEAR/USD price: ${price}");
    write_cache(price);
    Ok(price)
}

/// computeTierPricesWei for NEAR: USD / (NEAR/USD), to micro-NEAR precision.
pub fn usd_to_yocto(usd: f64, near_usd: f64) -> u128 {
    let micro_near = (usd / near_usd * 1_000_000.0).round() as u128;
    micro_near * 1_000_000_000_000_000_000 // 1e18 yocto per micro-NEAR
}

/// The `set_price_tiers` argument at `near_usd`: native-NEAR prices for both
/// ship packs and the UTC peg from the USD curve; UTC prices stay in UTC.
pub fn price_tiers(near_usd: f64) -> Result<Value> {
    let mut rows = Vec::new();
    for (&ships, &usd) in TIER_SHIPS.iter().zip(TIER_USD_PRICES.iter()) {
        let near = usd_to_yocto(usd, near_usd);
        let storage = ships as u128 * MAX_BYTES_PER_SHIP * YOCTO_PER_BYTE;
        if near < storage {
            bail!("tier of {ships} ships priced at {near} yocto is below its storage cost ({storage} yocto) at NEAR=${near_usd}");
        }
        let utc = (usd * 100.0).round() as u128 * E18 / 100;
        rows.push(json!({
            "ships": ships,
            "utc_price": utc.to_string(),
            "near_ship_price": near.to_string(),
            "near_utc_price": near.to_string(),
        }));
    }
    Ok(json!(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_follow_the_usd_curve() {
        let t = price_tiers(2.5).unwrap();
        // $4.99 at $2.50/NEAR = 1.996 NEAR
        assert_eq!(t[0]["near_ship_price"], "1996000000000000000000000");
        assert_eq!(t[0]["utc_price"], "4990000000000000000");
        assert_eq!(t[4]["near_ship_price"], "19996000000000000000000000");
        assert_eq!(t[4]["near_utc_price"], t[4]["near_ship_price"]);
    }

    #[test]
    fn rejects_insane_or_storage_breaking_prices() {
        assert!(NearUsd::Fixed(0.0).resolve().is_err());
        assert!(NearUsd::Fixed(5_000.0).resolve().is_err());
        // At $999/NEAR a 60-ship pack ($49.99) is 0.05 NEAR, below its ~0.36 NEAR storage.
        assert!(price_tiers(999.0).is_err());
    }
}

#[cfg(test)]
mod live {
    /// Network: `cargo test -p integration-tests pricing::live -- --ignored`.
    #[test]
    #[ignore]
    fn fetches_and_caches_live_near_price() {
        let p = super::live_near_usd_price().unwrap();
        assert_eq!(super::live_near_usd_price().unwrap(), p, "second read comes from the cache");
        let tiers = super::price_tiers(p).unwrap();
        eprintln!("NEAR/USD ${p}: tier prices {tiers}");
    }
}
