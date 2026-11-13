//! Phase 2 ports: Ships.test.ts (purchasing, referrals, construction,
//! transfers, variant gate, specific ships, UTC purchasing, recycling, free
//! claims, direct UTC purchase, DroneYard), TutorialClaim.test.ts,
//! ShatteredHiveMedal.test.ts, SelfieCheckEligibilityProvider.test.ts,
//! DroneStorefront.test.ts, DroneEnergyCores.test.ts, ECON01_PoC.test.ts.
//! EVM-only cases (ERC-721 approve/operator, ERC-4906, onERC721Received
//! re-entrancy, deploy-module wiring) have no NEAR counterpart.

use super::*;
use near_sdk::json_types::{U128, U64};
use vt_core::attributes::referral_pct;

const P0: u128 = 499 * ONE_NEAR / 100;
const U0: u128 = 499 * E18 / 100;
const RECYCLE: u128 = E18 / 10;
const NULL_A: &str = "0x00000000000000000000000000000000000000000000000000000000000000aa";

fn h_with(who: &[&str]) -> H {
    let mut h = H::new();
    for w in who {
        h.register(w, 2);
    }
    h
}

fn medal(h: &mut H, who: &str) {
    h.ctx(OWNER, 0);
    h.c.owner_mint_medal(acc(who));
}

// ------------------------------------------------------------- minting

#[test]
fn purchase_tier0_with_correct_payment() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0);
    let ids = h.c.purchase_ships_with_near(0, None, 1);
    assert_eq!(ids.len(), 5);
    // Rank preset: the first tier+1 ships carry rank kills (tier 0 => rank 1).
    assert_eq!(h.ship(ids[0].0).ship.ship_data.ships_destroyed, 1);
    assert_eq!(h.ship(ids[1].0).ship.ship_data.ships_destroyed, 0);
    assert_eq!(h.c.accounts.get(&acc("alice.near")).unwrap().amount_purchased, 5);
}

#[test]
fn purchase_tier1_presets_ranks_two_and_one() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", 999 * ONE_NEAR / 100);
    let ids = h.c.purchase_ships_with_near(1, None, 1);
    assert_eq!(ids.len(), 11);
    assert_eq!(h.ship(ids[0].0).ship.ship_data.ships_destroyed, 10); // rank 2
    assert_eq!(h.ship(ids[1].0).ship.ship_data.ships_destroyed, 1); // rank 1
    assert_eq!(h.ship(ids[2].0).ship.ship_data.ships_destroyed, 0);
}

#[test]
#[should_panic(expected = "InvalidPurchase")]
fn revert_tier0_with_invalid_payment() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0 - 1);
    h.c.purchase_ships_with_near(0, None, 1);
}

#[test]
#[should_panic(expected = "InvalidTier")]
fn revert_with_invalid_tier() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(9, None, 1);
}

#[test]
fn near_purchase_pays_its_own_storage_and_keeps_the_rest_as_revenue() {
    let mut h = h_with(&[]);
    // alice was never registered: the pack registers her and covers its bytes.
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(0, None, 1);
    let a = h.c.accounts.get(&acc("alice.near")).cloned().unwrap();
    let storage = a.used_bytes as u128 * near_sdk::env::storage_byte_cost().as_yoctonear();
    assert_eq!(a.deposit.as_yoctonear(), storage, "deposit covers exactly the bytes");
    assert_eq!(h.c.config.revenue_near, P0 - storage, "no referral: the rest is revenue");
}

#[test]
fn constructs_purchased_ships_once_randomness_resolves() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 4, 1);
    assert_eq!(ids.len(), 60);
    for id in ids {
        let s = h.ship(id).ship;
        assert!(s.ship_data.constructed && s.ship_data.cost > 0 && !s.ship_data.is_free_ship);
    }
    // Requests are freed once baked into ships.
    assert!(h.c.random_requests.get(&1).is_none());
}

#[test]
fn ships_owned_pagination_matches_full_listing() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 1, 1);
    let page1 = h.c.get_ships_for_owner(acc("alice.near"), Some(0), Some(6));
    let page2 = h.c.get_ships_for_owner(acc("alice.near"), Some(6), Some(6));
    let got: Vec<u64> = page1.iter().chain(page2.iter()).map(|v| v.ship.id).collect();
    assert_eq!(got, ids);
}

#[test]
#[should_panic(expected = "MintPaused")]
fn paused_blocks_minting() {
    let mut h = h_with(&[]);
    h.ctx(OWNER, 0);
    h.c.set_mint_paused(true);
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(0, None, 1);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn non_owner_cannot_set_purchase_info() {
    let mut h = h_with(&[]);
    h.ctx("mallory.near", 0);
    h.c.set_price_tiers(default_tiers());
}

// ------------------------------------------------------------ referrals

#[test]
fn referral_ladder_is_shared_by_both_purchase_paths() {
    // 10/20/35/50 at 1k/10k/50k/100k (ShipPurchaser's offset 0/10/20/35 table
    // was a bug; fixed for NEAR 2026-11-13).
    assert_eq!([999, 1_000, 10_000, 50_000, 100_000].map(referral_pct), [0, 10, 20, 35, 50]);
}

#[test]
fn utc_purchase_referral_pays_from_the_shared_ladder() {
    let mut h = h_with(&["alice.near", "ref.near"]);
    h.c.utc_referrals.insert(acc("ref.near"), 995); // +5 ships => 1,000: the 10% stage
    h.mint("alice.near", TokenKind::Utc, U0);
    h.ctx("alice.near", 0);
    h.c.purchase_ships_with_utc(0, Some(acc("ref.near")), 1);
    assert_eq!(h.utc("ref.near"), U0 / 10);
    assert_eq!(h.c.config.treasury_utc, U0 - U0 / 10);
}

#[test]
fn referral_count_updates_and_pays_nothing_below_first_stage() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(0, Some(acc("ref.near")), 1);
    assert_eq!(h.c.ship_referrals.get(&acc("ref.near")).copied(), Some(5));
    let a = h.c.accounts.get(&acc("alice.near")).cloned().unwrap();
    let storage = a.used_bytes as u128 * near_sdk::env::storage_byte_cost().as_yoctonear();
    // The referral map entry is part of the buyer's storage; revenue keeps the rest.
    assert_eq!(h.c.config.revenue_near, P0 - storage);
}

// ----------------------------------------------------- UTC purchasing / peg

#[test]
fn purchase_tier0_with_utc() {
    let mut h = h_with(&["alice.near"]);
    h.mint("alice.near", TokenKind::Utc, U0);
    h.ctx("alice.near", 0);
    let ids = h.c.purchase_ships_with_utc(0, None, 1);
    assert_eq!(ids.len(), 5);
    assert_eq!(h.utc("alice.near"), 0);
    assert_eq!(h.c.config.treasury_utc, U0);
}

#[test]
#[should_panic(expected = "InsufficientFunds")]
fn revert_with_insufficient_utc_balance() {
    let mut h = h_with(&["alice.near"]);
    h.mint("alice.near", TokenKind::Utc, U0 - 1);
    h.ctx("alice.near", 0);
    h.c.purchase_ships_with_utc(0, None, 1);
}

#[test]
fn utc_and_native_prices_are_separate_fields() {
    let mut h = h_with(&["alice.near"]);
    let mut tiers = default_tiers();
    tiers[0].near_ship_price = U128(7 * ONE_NEAR);
    tiers[0].near_utc_price = U128(3 * ONE_NEAR);
    h.ctx(OWNER, 0);
    h.c.set_price_tiers(tiers);
    let t = &h.c.get_price_tiers()[0];
    assert_eq!((t.utc_price.0, t.near_ship_price.0, t.near_utc_price.0), (U0, 7 * ONE_NEAR, 3 * ONE_NEAR));
    h.ctx("alice.near", 3 * ONE_NEAR);
    assert_eq!(h.c.buy_utc_with_near(0).0, U0, "the peg mints the pack's UTC price");
}

#[test]
fn buy_utc_with_near_mints_each_tiers_utc_price() {
    let mut h = h_with(&["alice.near"]);
    let tiers = h.c.get_price_tiers();
    let mut expected = 0;
    for (i, t) in tiers.iter().enumerate() {
        h.ctx("alice.near", t.near_utc_price.0);
        h.c.buy_utc_with_near(i as u8);
        expected += t.utc_price.0;
        assert_eq!(h.utc("alice.near"), expected);
    }
}

#[test]
#[should_panic(expected = "InvalidPurchase")]
fn buy_utc_reverts_on_wrong_amount() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", P0 + 1);
    h.c.buy_utc_with_near(0);
}

#[test]
fn owner_withdraws_only_revenue_and_collected_utc() {
    let mut h = h_with(&["alice.near", "bob.near"]);
    h.ctx("alice.near", P0);
    h.c.buy_utc_with_near(0);
    h.ctx(OWNER, 0);
    let _ = h.c.withdraw_near(U128(P0), acc(OWNER));
    assert_eq!(h.c.config.revenue_near, 0);
    h.mint("bob.near", TokenKind::Utc, U0);
    h.ctx("bob.near", 0);
    h.c.purchase_ships_with_utc(0, None, 1);
    h.ctx(OWNER, 0);
    h.c.withdraw_utc(U128(U0), acc("alice.near"));
    assert_eq!(h.utc("alice.near"), 2 * U0);
}

#[test]
#[should_panic(expected = "ExceedsRevenue")]
fn owner_cannot_withdraw_storage_deposits() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    let _ = h.c.withdraw_near(U128(1), acc(OWNER));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn non_owner_cannot_withdraw_utc() {
    let mut h = h_with(&[]);
    h.ctx("mallory.near", 0);
    h.c.withdraw_utc(U128(1), acc("mallory.near"));
}

// ------------------------------------------------------------ transfers

#[test]
#[should_panic(expected = "InsufficientPurchases")]
fn no_transfer_without_purchasing_ten() {
    let mut h = h_with(&["bob.near"]);
    let ids = h.buy_and_build("alice.near", 0, 1); // 5 < 10
    h.ctx("alice.near", 1);
    h.c.nft_transfer(acc("bob.near"), ids[0].to_string(), None, None);
}

#[test]
#[should_panic(expected = "InsufficientPurchases")]
fn no_transfer_to_receiver_without_ten_purchases() {
    let mut h = h_with(&["bob.near"]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.ctx("alice.near", 1);
    h.c.nft_transfer(acc("bob.near"), ids[0].to_string(), None, None);
}

#[test]
fn transfer_after_purchasing_moves_ship_index_and_storage_deposit() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.buy_and_build("bob.near", 0, 2);
    let bob_avail_before = h.c.accounts.get(&acc("bob.near")).unwrap().available();
    h.ctx("alice.near", 1);
    h.c.nft_transfer(acc("bob.near"), ids[3].to_string(), None, None);
    assert_eq!(h.ship(ids[3]).owner, acc("bob.near"));
    assert!(h.owned("bob.near").contains(&ids[3]));
    assert!(!h.owned("alice.near").contains(&ids[3]));
    assert_eq!(h.owned("alice.near").len(), 9);
    // The receiver's spendable storage balance is untouched: the deposit
    // for the ship's bytes came with it.
    assert_eq!(h.c.accounts.get(&acc("bob.near")).unwrap().available(), bob_avail_before);
}

#[test]
#[should_panic(expected = "NotYourShip")]
fn non_owner_cannot_transfer() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.buy_and_build("mallory.near", 0, 2);
    h.ctx("mallory.near", 1);
    h.c.nft_transfer(acc("mallory.near"), ids[0].to_string(), None, None);
}

#[test]
#[should_panic(expected = "ShipDestroyed")]
fn destroyed_ship_cannot_transfer() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.buy_and_build("bob.near", 0, 2);
    h.c.mark_destroyed(ids[0], h.now_s);
    h.ctx("alice.near", 1);
    h.c.nft_transfer(acc("bob.near"), ids[0].to_string(), None, None);
}

#[test]
#[should_panic(expected = "ShipInFleet")]
fn in_fleet_ship_cannot_transfer() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.buy_and_build("bob.near", 0, 2);
    h.c.set_in_fleet(ids[0], true);
    h.ctx("alice.near", 1);
    h.c.nft_transfer(acc("bob.near"), ids[0].to_string(), None, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 2);
    h.ctx("alice.near", 0);
    h.c.nft_transfer(acc("bob.near"), ids[0].to_string(), None, None);
}

// --------------------------------------------------------- variant gate

#[test]
#[should_panic(expected = "GateRequirementNotMet")]
fn rejects_variant2_mint_without_medal() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(0, None, 2);
}

#[test]
fn allows_variant2_mint_once_recipient_holds_medal_and_variant1_is_ungated() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", P0);
    h.c.purchase_ships_with_near(0, None, 1);
    medal(&mut h, "alice.near");
    h.ctx("alice.near", P0);
    let ids = h.c.purchase_ships_with_near(0, None, 2);
    assert_eq!(h.ship(ids[0].0).ship.traits.variant, 2);
}

#[test]
#[should_panic(expected = "GateRequirementNotMet")]
fn free_claim_of_gated_variant_needs_medal() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.claim_free_ships(2);
}

// ------------------------------------------------------------ recycling

#[test]
fn recycle_pays_utc_and_refunds_storage() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 1);
    let used = h.c.accounts.get(&acc("alice.near")).unwrap().used_bytes;
    h.ctx("alice.near", 0);
    let paid = h.c.recycle_ships(vec![U64(ids[0]), U64(ids[1])]);
    assert_eq!(paid.0, 2 * RECYCLE);
    assert_eq!(h.utc("alice.near"), 2 * RECYCLE);
    assert!(h.c.accounts.get(&acc("alice.near")).unwrap().used_bytes < used, "burned ships free their bytes");
    assert!(h.c.ships.get(&ids[0]).is_none());
    assert_eq!(h.owned("alice.near").len(), 3);
}

#[test]
fn recycling_a_destroyed_ship_pays_half() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 1);
    h.c.mark_destroyed(ids[0], h.now_s);
    h.ctx("alice.near", 0);
    assert_eq!(h.c.recycle_ships(vec![U64(ids[0])]).0, RECYCLE / 2);
}

#[test]
#[should_panic(expected = "ShipInFleet")]
fn cannot_recycle_ship_in_fleet() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 1);
    h.c.set_in_fleet(ids[0], true);
    h.ctx("alice.near", 0);
    h.c.recycle_ships(vec![U64(ids[0])]);
}

#[test]
#[should_panic(expected = "ShipDestroyed")]
fn rejects_adding_destroyed_ship_to_fleet_ha2_03() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 1);
    h.c.mark_destroyed(ids[0], h.now_s);
    h.c.set_in_fleet(ids[0], true);
}

#[test]
#[should_panic(expected = "NotYourShip")]
fn cannot_recycle_others_ships() {
    let mut h = h_with(&[]);
    let ids = h.buy_and_build("alice.near", 0, 1);
    h.ctx("mallory.near", 0);
    h.c.recycle_ships(vec![U64(ids[0])]);
}

#[test]
#[should_panic(expected = "CannotRecycleFreeShip")]
fn cannot_recycle_free_ships() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    let ids = h.c.claim_free_ships(1);
    h.resolve_all();
    h.ctx("alice.near", 0);
    h.c.recycle_ships(vec![ids[0]]);
}

#[test]
fn econ01_referral_plus_recycle_is_unprofitable_at_the_peg() {
    // Buy UTC at the peg, buy the biggest pack with UTC under the top (50%) referral
    // to yourself, recycle everything: you must end with less UTC.
    let mut h = h_with(&["alice.near"]);
    h.c.utc_referrals.insert(acc("alice.near"), 100_000); // top (50%) stage
    let t4 = h.c.get_price_tiers()[4].clone();
    h.ctx("alice.near", t4.near_utc_price.0);
    h.c.buy_utc_with_near(4);
    h.ctx(OWNER, 0);
    // treasury must be able to pay the referral
    h.ctx("alice.near", 0);
    let ids = h.c.purchase_ships_with_utc(4, Some(acc("alice.near")), 1);
    h.resolve_all();
    h.ctx("alice.near", 0);
    h.c.recycle_ships(ids);
    assert!(h.utc("alice.near") < t4.utc_price.0, "arbitrage must lose UTC: {}", h.utc("alice.near"));
}

// ----------------------------------------------------------- free claims

#[test]
fn free_claim_gives_ten_free_ships_then_cooldown_then_tier_bonus() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    assert_eq!(h.c.claim_free_ships(1).len(), 10);
    h.resolve_all();
    assert!(h.owned("alice.near").iter().all(|&id| h.ship(id).ship.ship_data.is_free_ship));
    assert_eq!(h.c.accounts.get(&acc("alice.near")).unwrap().amount_purchased, 0, "free ships aren't purchases");
    // Tier up, wait out the cooldown, claim 11.
    h.mint("alice.near", TokenKind::Dec, 10);
    h.ctx("alice.near", 0);
    h.c.turn_in_cores(U128(10));
    h.now_s += 28 * 24 * 3600;
    h.ctx("alice.near", 0);
    assert_eq!(h.c.claim_free_ships(1).len(), 11);
}

#[test]
#[should_panic(expected = "ClaimCooldownNotPassed")]
fn free_claim_blocked_before_cooldown() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.claim_free_ships(1);
    h.now_s += 28 * 24 * 3600 - 1;
    h.ctx("alice.near", 0);
    h.c.claim_free_ships(1);
}

#[test]
#[should_panic(expected = "NotEligible")]
fn free_claim_requires_verification_when_enabled() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_verification_requirements(true, false, true);
    h.ctx("alice.near", 0);
    h.c.claim_free_ships(1);
}

#[test]
fn free_claim_succeeds_once_verified() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_verification_requirements(true, false, true);
    h.c.set_role(acc("verifier.near"), crate::roles::VERIFIER);
    h.ctx("verifier.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into());
    h.ctx("alice.near", 0);
    assert_eq!(h.c.claim_free_ships(1).len(), 10);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn non_owner_cannot_modify_claim_cooldown() {
    let mut h = h_with(&[]);
    h.ctx("mallory.near", 0);
    h.c.set_claim_config(0, 10);
}

// --------------------------------------------------------- DroneYard

fn yard(h: &mut H) -> u64 {
    let ids = h.buy_and_build("alice.near", 0, 1);
    h.mint("alice.near", TokenKind::Utc, 1_000_000 * E18);
    ids[1] // no preset kills
}

#[test]
fn modify_cost_doubles_per_modification() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    let s = h.ship(id).ship;
    let base = U0 / 5;
    let same = h.c.get_modification_cost(U64(id), s.equipment.clone(), s.traits.accuracy, s.traits.hull, s.traits.speed, 1, s.ship_data.shiny);
    assert_eq!(same.0, base, "no-op costs the base");
    let mut eq = s.equipment.clone();
    eq.main_weapon = if eq.main_weapon == MainWeapon::Sniper { MainWeapon::Generic } else { MainWeapon::Sniper };
    let one = h.c.get_modification_cost(U64(id), eq, s.traits.accuracy, s.traits.hull, s.traits.speed, 1, s.ship_data.shiny);
    assert_eq!(one.0, base * 2);
    let shiny = h.c.get_modification_cost(U64(id), s.equipment.clone(), s.traits.accuracy, s.traits.hull, s.traits.speed, 1, !s.ship_data.shiny);
    assert_eq!(shiny.0, base * 8, "shiny counts as 3");
}

#[test]
fn modify_preserves_name_colors_kills_and_free_and_accumulates() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    let before = h.ship(id).ship;
    let mut eq = before.equipment.clone();
    eq.main_weapon = if eq.main_weapon == MainWeapon::Sniper { MainWeapon::Generic } else { MainWeapon::Sniper };
    let utc0 = h.utc("alice.near");
    h.ctx("alice.near", 0);
    h.c.modify_ship(U64(id), eq.clone(), before.traits.accuracy, before.traits.hull, before.traits.speed, 1, before.ship_data.shiny);
    let after = h.ship(id).ship;
    assert_eq!(after.equipment.main_weapon, eq.main_weapon);
    assert_eq!((after.name, after.traits.colors, after.ship_data.ships_destroyed, after.ship_data.is_free_ship),
               (before.name, before.traits.colors, before.ship_data.ships_destroyed, before.ship_data.is_free_ship));
    assert_eq!(after.ship_data.modified, 1);
    assert_eq!(utc0 - h.utc("alice.near"), U0 / 5 * 2);
    // Next modification starts from modified = 1.
    let next = h.c.get_modification_cost(U64(id), after.equipment.clone(), after.traits.accuracy, after.traits.hull, after.traits.speed, 1, after.ship_data.shiny);
    assert_eq!(next.0, U0 / 5 * 2);
}

#[test]
#[should_panic(expected = "NotShipOwner")]
fn modify_rejects_non_owner() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    let s = h.ship(id).ship;
    h.ctx("mallory.near", 0);
    h.c.modify_ship(U64(id), s.equipment, 0, 0, 0, 1, false);
}

#[test]
#[should_panic(expected = "ShipNotConstructed")]
fn modify_rejects_unconstructed() {
    let mut h = h_with(&[]);
    h.ctx("alice.near", P0);
    let ids = h.c.purchase_ships_with_near(0, None, 1);
    h.ctx("alice.near", 0);
    h.c.modify_ship(ids[0], Equipment::default(), 0, 0, 0, 1, false);
}

#[test]
#[should_panic(expected = "InvalidTraitValue")]
fn modify_rejects_invalid_trait() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    h.ctx("alice.near", 0);
    h.c.modify_ship(U64(id), Equipment::default(), 3, 0, 0, 1, false);
}

#[test]
#[should_panic(expected = "ArmorAndShieldsBothSet")]
fn modify_rejects_armor_and_shields() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    h.ctx("alice.near", 0);
    let eq = Equipment { armor: Armor::Light, shields: Shields::Light, ..Default::default() };
    h.c.modify_ship(U64(id), eq, 0, 0, 0, 1, false);
}

#[test]
#[should_panic(expected = "InvalidVariant")]
fn modify_rejects_variant_change() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    h.ctx("alice.near", 0);
    h.c.modify_ship(U64(id), Equipment::default(), 0, 0, 0, 2, false);
}

#[test]
#[should_panic(expected = "InvalidSpecial")]
fn modify_rejects_inert_special_slot() {
    let mut h = h_with(&[]);
    let id = yard(&mut h);
    h.ctx("alice.near", 0);
    let eq = Equipment { special: Special::Slot5, ..Default::default() };
    h.c.modify_ship(U64(id), eq, 0, 0, 0, 1, false);
}

// ------------------------------------------------------------- tutorial

#[test]
fn tutorial_win_path_mints_two_and_records_win() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    let ids = h.c.complete_tutorial(true);
    assert_eq!(ids.len(), 2);
    let names: Vec<String> = ids.iter().map(|i| h.ship(i.0).ship.name).collect();
    assert_eq!(names, ["Vigilant", "Sentinel"]);
    assert!(ids.iter().all(|i| { let s = h.ship(i.0).ship; s.ship_data.constructed && s.ship_data.is_free_ship && s.ship_data.cost > 0 }));
    assert_eq!(h.c.accounts.get(&acc("alice.near")).unwrap().wins, 1);
}

#[test]
fn tutorial_loss_path_mints_three_and_records_loss() {
    let mut h = h_with(&["alice.near", "bob.near"]);
    h.ctx("alice.near", 0);
    let ids = h.c.complete_tutorial(false);
    assert_eq!(ids.len(), 3);
    let resolute = h.ship(ids[0].0).ship;
    assert_eq!((resolute.name.as_str(), resolute.ship_data.ships_destroyed, resolute.ship_data.shiny), ("Resolute", 10, true));
    assert_eq!(h.c.accounts.get(&acc("alice.near")).unwrap().losses, 1);
    // Independent per address.
    h.ctx("bob.near", 0);
    assert_eq!(h.c.complete_tutorial(true).len(), 2);
}

#[test]
#[should_panic(expected = "TutorialAlreadyCompleted")]
fn tutorial_second_completion_reverts() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.complete_tutorial(true);
    h.ctx("alice.near", 0);
    h.c.complete_tutorial(false);
}

#[test]
#[should_panic(expected = "NotEligible")]
fn tutorial_requires_verification_when_enabled() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_verification_requirements(false, true, true);
    h.ctx("alice.near", 0);
    h.c.complete_tutorial(true);
}

// ----------------------------------------------------------------- medal

fn complete_final(h: &mut H, who: &str, node: u64) {
    h.ctx(OWNER, 0);
    h.c.set_medal_final_node(U64(node));
    h.c.sp.completed.insert((acc(who), node), true);
}

#[test]
#[should_panic(expected = "CampaignNotCompleted")]
fn medal_reverts_before_final_node_completed() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_medal_final_node(U64(30));
    h.ctx("alice.near", 0);
    h.c.claim_medal();
}

#[test]
fn medal_mints_exactly_once_after_completion() {
    let mut h = h_with(&["alice.near"]);
    complete_final(&mut h, "alice.near", 30);
    h.ctx("alice.near", 0);
    h.c.claim_medal();
    assert_eq!(h.c.mt_balance_of(acc("alice.near"), "hive_medal".into()).0, 1);
    assert_eq!(h.c.mt_supply("hive_medal".into()).unwrap().0, 1);
}

#[test]
#[should_panic(expected = "AlreadyClaimed")]
fn medal_second_claim_reverts() {
    let mut h = h_with(&["alice.near"]);
    complete_final(&mut h, "alice.near", 30);
    h.ctx("alice.near", 0);
    h.c.claim_medal();
    h.c.claim_medal();
}

#[test]
#[should_panic(expected = "CampaignNotCompleted")]
fn completing_a_different_node_does_not_satisfy_medal() {
    let mut h = h_with(&["alice.near"]);
    complete_final(&mut h, "alice.near", 29);
    h.ctx(OWNER, 0);
    h.c.set_medal_final_node(U64(30));
    h.ctx("alice.near", 0);
    h.c.claim_medal();
}

#[test]
#[should_panic(expected = "NotOwner")]
fn medal_owner_mint_is_owner_only() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.owner_mint_medal(acc("alice.near"));
}

#[test]
#[should_panic(expected = "Soulbound")]
fn medal_is_soulbound() {
    let mut h = h_with(&["alice.near", "bob.near"]);
    medal(&mut h, "alice.near");
    h.ctx("alice.near", 1);
    h.c.mt_transfer(acc("bob.near"), "hive_medal".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn medal_final_node_is_owner_only() {
    let mut h = h_with(&[]);
    h.ctx("mallory.near", 0);
    h.c.set_medal_final_node(U64(1));
}

// ----------------------------------------------------------- eligibility

#[test]
fn verification_renews_for_same_wallet_and_release_ends_it() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_role(acc("verifier.near"), crate::roles::VERIFIER);
    h.ctx("verifier.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into());
    h.now_s += 100;
    h.ctx("verifier.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into()); // renew: same human, same wallet
    assert!(h.c.is_eligible(acc("alice.near")));
    h.ctx(OWNER, 0);
    h.c.release_nullifier(NULL_A.into());
    assert!(!h.c.is_eligible(acc("alice.near")));
}

#[test]
#[should_panic(expected = "NullifierAlreadyUsed")]
fn same_human_cannot_verify_a_second_wallet() {
    let mut h = h_with(&["alice.near", "alice2.near"]);
    h.ctx(OWNER, 0);
    h.c.set_role(acc("verifier.near"), crate::roles::VERIFIER);
    h.ctx("verifier.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into());
    h.c.mark_verified(acc("alice2.near"), NULL_A.into());
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn only_verifiers_mark_verified() {
    let mut h = h_with(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into());
}

#[test]
fn verification_expires_after_ninety_days() {
    let mut h = h_with(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_role(acc("verifier.near"), crate::roles::VERIFIER);
    h.ctx("verifier.near", 0);
    h.c.mark_verified(acc("alice.near"), NULL_A.into());
    h.now_s += 90 * 24 * 3600;
    h.ctx("alice.near", 0);
    assert!(!h.c.is_eligible(acc("alice.near")));
}

// ------------------------------------------------------- storefront / DEC

#[test]
fn storefront_tiers_seeded_and_advance_in_sequence() {
    let mut h = h_with(&["alice.near"]);
    assert_eq!(h.c.get_storefront_tiers(), [10, 20, 30, 55, 95, 170, 300, 525, 925, 1625]);
    h.mint("alice.near", TokenKind::Dec, 60);
    for (i, cost) in [10u128, 20, 30].into_iter().enumerate() {
        h.ctx("alice.near", 0);
        h.c.turn_in_cores(U128(cost));
        assert_eq!(h.c.accounts.get(&acc("alice.near")).unwrap().drone_core_tier as usize, i + 1);
    }
    assert_eq!(h.c.mt_balance_of(acc("alice.near"), "dec".into()).0, 0);
}

#[test]
#[should_panic(expected = "WrongAmount")]
fn storefront_rejects_wrong_amount() {
    let mut h = h_with(&["alice.near"]);
    h.mint("alice.near", TokenKind::Dec, 100);
    h.ctx("alice.near", 0);
    h.c.turn_in_cores(U128(11));
}

#[test]
#[should_panic(expected = "MaxTierReached")]
fn storefront_max_tier() {
    let mut h = h_with(&["alice.near"]);
    h.mint("alice.near", TokenKind::Dec, 10_000);
    for cost in h.c.get_storefront_tiers() {
        h.ctx("alice.near", 0);
        h.c.turn_in_cores(U128(cost as u128));
    }
    h.ctx("alice.near", 0);
    h.c.turn_in_cores(U128(1));
}

#[test]
fn owner_can_add_storefront_tiers() {
    let mut h = h_with(&[]);
    h.ctx(OWNER, 0);
    h.c.add_storefront_tier(3000);
    assert_eq!(*h.c.get_storefront_tiers().last().unwrap(), 3000);
}

#[test]
fn dec_transfers_wallet_to_wallet() {
    let mut h = h_with(&["alice.near", "bob.near"]);
    h.mint("alice.near", TokenKind::Dec, 7);
    h.ctx("alice.near", 1);
    h.c.mt_transfer(acc("bob.near"), "dec".into(), U128(5), None, None);
    assert_eq!(h.c.mt_balance_of(acc("bob.near"), "dec".into()).0, 5);
    assert_eq!(h.c.mt_balance_of(acc("alice.near"), "dec".into()).0, 2);
}

#[test]
#[should_panic(expected = "ReceiverNotRegistered")]
fn dec_transfer_requires_registered_receiver() {
    let mut h = h_with(&["alice.near"]);
    h.mint("alice.near", TokenKind::Dec, 7);
    h.ctx("alice.near", 1);
    h.c.mt_transfer(acc("nobody.near"), "dec".into(), U128(5), None, None);
}

// ------------------------------------------------------------ sponsoring

#[test]
fn sponsored_storage_is_spendable_but_not_withdrawable() {
    let mut h = h_with(&[]);
    h.ctx(OWNER, ONE_NEAR);
    h.c.fund_sponsor_pool();
    h.c.set_role(acc("sponsor.near"), crate::roles::SPONSOR);
    h.ctx("sponsor.near", 0);
    h.c.sponsor_storage(acc("newbie.near"), U128(ONE_NEAR / 10));
    // Can play (claim) on sponsored storage...
    h.ctx("newbie.near", 0);
    assert_eq!(h.c.claim_free_ships(1).len(), 10);
    // ...but can't cash it out.
    h.ctx("newbie.near", 1);
    let b = h.c.storage_withdraw(None);
    assert_eq!(b.total.as_yoctonear(), ONE_NEAR / 10);
}

#[test]
#[should_panic(expected = "SponsorCapReached")]
fn sponsorship_is_capped_per_account() {
    let mut h = h_with(&[]);
    h.ctx(OWNER, ONE_NEAR);
    h.c.fund_sponsor_pool();
    h.c.set_role(acc("sponsor.near"), crate::roles::SPONSOR);
    h.ctx("sponsor.near", 0);
    h.c.sponsor_storage(acc("newbie.near"), U128(ONE_NEAR / 10));
    h.c.sponsor_storage(acc("newbie.near"), U128(1));
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn only_sponsor_role_sponsors() {
    let mut h = h_with(&[]);
    h.ctx(OWNER, ONE_NEAR);
    h.c.fund_sponsor_pool();
    h.ctx("mallory.near", 0);
    h.c.sponsor_storage(acc("mallory2.near"), U128(ONE_NEAR / 10));
}
