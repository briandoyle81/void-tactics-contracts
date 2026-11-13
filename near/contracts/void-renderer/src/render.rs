//! Pure rendering: RenderUtils (shiny color blending), the leaf dispatchers
//! (RenderSpecial/Aft/Weapon/Body/Fore), ImageRenderer(V2) and RenderMetadata,
//! ported byte-for-byte (see tests/golden_render.rs).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use vt_core::types::{Armor, MainWeapon, Shields, Ship, Special};

use crate::art::{VariantArt, V1, V2};

#[derive(Clone, Copy, Debug)]
pub enum Blend {
    /// RenderUtils.blendHSL (variant 1 leaves).
    V1,
    /// RenderUtils.blendHSLV2 (variant 2 leaves).
    V2,
}

/// One piece of a leaf's output: literal path data, or a color that's
/// blended with the ship's primary hue when the ship is shiny.
pub enum Seg {
    Lit(&'static str),
    Color(&'static str, Blend),
}

const BASE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">"#;
const SVG_END: &str = "</svg>";
const IMAGE_PREFIX: &str = "data:image/svg+xml;base64,";

// ------------------------------------------------------------- RenderUtils

fn parse_uint(b: &[u8], start: usize, end: usize) -> u64 {
    let mut r = 0u64;
    for &c in &b[start..end] {
        if c.is_ascii_digit() {
            r = r * 10 + (c - b'0') as u64;
        }
    }
    r
}

/// RenderUtils.parseHSL ("hsl(H, S%, L%)").
pub fn parse_hsl(s: &str) -> (u64, u64, u64) {
    let b = s.as_bytes();
    assert!(b.len() >= 10, "Invalid HSL string format");
    let mut start = 4;
    let mut end = start;
    while end < b.len() && b[end] != b',' {
        end += 1;
    }
    let h = parse_uint(b, start, end);
    start = end + 1;
    while start < b.len() && (b[start] == b' ' || b[start] == b',') {
        start += 1;
    }
    end = start;
    while end < b.len() && b[end] != b'%' {
        end += 1;
    }
    let sat = parse_uint(b, start, end);
    start = end + 1;
    while start < b.len() && (b[start] == b' ' || b[start] == b',') {
        start += 1;
    }
    end = start;
    while end < b.len() && b[end] != b'%' {
        end += 1;
    }
    let l = parse_uint(b, start, end);
    (h, sat, l)
}

pub fn hsl_string(h: u64, s: u64, l: u64) -> String {
    format!("hsl({h}, {s}%, {l}%)")
}

/// RenderUtils.blendHSL.
pub fn blend_hsl(h: u64, s: u64, l: u64, color: &str) -> String {
    let (h2, s2, l2) = parse_hsl(color);
    if s2 <= 40 {
        if l > 50 {
            let l = 50 + ((l - 50) * 35) / 49;
            return hsl_string(h, s, l2 + ((100 - l2) * (l - 50)) / 100);
        }
        return hsl_string(h, s, l2 - (l2 * (50 - l)) / 100);
    }
    hsl_string((h2 * 95 + h * 5) / 100, (s2 * 95 + s * 5) / 100, (l2 * 85 + l * 15) / 100)
}

/// RenderUtils.blendHSLV2 (orange accents keep their lightness only).
pub fn blend_hsl_v2(h: u64, s: u64, l: u64, color: &str) -> String {
    let (h2, s2, l2) = parse_hsl(color);
    if h2 <= 45 && s2 >= 55 {
        return hsl_string(h, s, l2);
    }
    let bh = if s2 > 40 { (h2 * 95 + h * 5) / 100 } else { (h2 * 50 + h * 50) / 100 };
    let bs = if s2 > 40 { (s2 * 95 + s * 5) / 100 } else { (s2 * 35 + s * 65) / 100 };
    let bl = (l2 * 85 + l * 15) / 100;
    hsl_string(bh, bs, bl)
}

// ----------------------------------------------------------------- leaves

fn render_leaf(out: &mut String, segs: &[Seg], ship: &Ship) {
    let c = &ship.traits.colors;
    for seg in segs {
        match seg {
            Seg::Lit(s) => out.push_str(s),
            Seg::Color(col, blend) => {
                if ship.ship_data.shiny {
                    let (h, s, l) = (c.h1 as u64, c.s1 as u64, c.l1 as u64);
                    out.push_str(&match blend {
                        Blend::V1 => blend_hsl(h, s, l, col),
                        Blend::V2 => blend_hsl_v2(h, s, l, col),
                    });
                } else {
                    out.push_str(col);
                }
            }
        }
    }
}

/// RenderBody: shields win over armor; bare hull otherwise. Mirrors the
/// Solidity if-chain exactly (an unknown shield value falls through to the
/// armor checks).
fn body(a: &VariantArt, ship: &Ship) -> &'static [Seg] {
    let e = &ship.equipment;
    if e.shields == Shields::None && e.armor == Armor::None {
        return a.basebody;
    }
    match e.shields {
        Shields::Light => return a.shield1,
        Shields::Medium => return a.shield2,
        Shields::Heavy => return a.shield3,
        _ => {}
    }
    match e.armor {
        Armor::Light => a.armor1,
        Armor::Medium => a.armor2,
        Armor::Heavy => a.armor3,
        _ => a.basebody,
    }
}

/// RenderFore: the "perfect" fore for all-2 traits with heavy defense.
fn fore(a: &VariantArt, ship: &Ship) -> &'static [Seg] {
    let t = &ship.traits;
    let e = &ship.equipment;
    if t.accuracy == 2 && t.hull == 2 && t.speed == 2 && (e.armor == Armor::Heavy || e.shields == Shields::Heavy) {
        return a.foreperfect;
    }
    match t.accuracy {
        0 => a.fore0,
        1 => a.fore1,
        _ => a.fore2,
    }
}

/// ImageRenderer.renderShip / ImageRendererV2.renderShip: an image data URI.
pub fn render_ship_image(ship: &Ship) -> String {
    let a: &VariantArt = if ship.traits.variant == 2 { &V2 } else { &V1 };
    // Destroyed / unconstructed art is stored pre-encoded in base64 chunks.
    let chunks = if ship.ship_data.timestamp_destroyed > 0 {
        Some(a.explosion)
    } else if !ship.ship_data.constructed {
        Some(a.unconstructed)
    } else {
        None
    };
    if let Some(parts) = chunks {
        let mut out = String::from(IMAGE_PREFIX);
        for p in parts {
            render_leaf(&mut out, p, ship);
        }
        return out;
    }
    let mut svg = String::from(BASE_SVG);
    let special = match ship.equipment.special {
        Special::Slot1 => Some(a.special1),
        Special::Slot2 => Some(a.special2),
        Special::Slot3 => Some(a.special3),
        _ => None,
    };
    if let Some(s) = special {
        render_leaf(&mut svg, s, ship);
    }
    let aft = match ship.traits.speed {
        0 => a.aft0,
        1 => a.aft1,
        _ => a.aft2,
    };
    render_leaf(&mut svg, aft, ship);
    let weapon = match ship.equipment.main_weapon {
        MainWeapon::Generic => Some(a.weapon1),
        MainWeapon::Sniper => Some(a.weapon2),
        MainWeapon::Missile => Some(a.weapon3),
        MainWeapon::Close => Some(a.weapon4),
        _ => None,
    };
    if let Some(w) = weapon {
        render_leaf(&mut svg, w, ship);
    }
    render_leaf(&mut svg, body(a, ship), ship);
    render_leaf(&mut svg, fore(a, ship), ship);
    svg.push_str(SVG_END);
    format!("{IMAGE_PREFIX}{}", STANDARD.encode(svg.as_bytes()))
}

/// The per-variant equipment display names RenderMetadata looks up.
pub trait Names {
    fn main_weapon(&self, variant: u16, w: MainWeapon) -> Option<String>;
    fn armor(&self, variant: u16, a: Armor) -> Option<String>;
    fn shields(&self, variant: u16, s: Shields) -> Option<String>;
    fn special(&self, variant: u16, s: Special) -> Option<String>;
}

fn or_unknown(n: Option<String>) -> String {
    n.filter(|s| !s.is_empty()).unwrap_or_else(|| "Unknown".into())
}

/// RenderMetadata.tokenURI: base64 JSON with traits and the image.
pub fn token_uri(ship: &Ship, names: &dyn Names) -> String {
    let t = &ship.traits;
    let d = &ship.ship_data;
    let e = &ship.equipment;
    let v = t.variant;
    let weapon = or_unknown(names.main_weapon(v, e.main_weapon));
    let armor = if e.armor == Armor::None { "No Armor".into() } else { or_unknown(names.armor(v, e.armor)) };
    let shields = if e.shields == Shields::None { "No Shields".into() } else { or_unknown(names.shields(v, e.shields)) };
    let special = if e.special == Special::None { "No Special".into() } else { or_unknown(names.special(v, e.special)) };
    let traits = format!(
        concat!(
            r#"{{"trait_type": "Serial Number", "value": "{}"}},"#,
            r#"{{"trait_type": "Variant", "value": "{}"}},"#,
            r#"{{"trait_type": "Accuracy", "value": {}}},"#,
            r#"{{"trait_type": "Hull", "value": {}}},"#,
            r#"{{"trait_type": "Speed", "value": {}}}"#,
            ",",
            r#"{{"trait_type": "Shiny", "value": "{}"}},"#,
            r#"{{"trait_type": "Ships Destroyed", "value": {}}},"#,
            r#"{{"trait_type": "Cost", "value": {}}},"#,
            r#"{{"trait_type": "Modified", "value": "{}"}}"#,
            ",",
            r#"{{"trait_type": "Main Weapon", "value": "{}"}},"#,
            r#"{{"trait_type": "Armor", "value": "{}"}},"#,
            r#"{{"trait_type": "Shields", "value": "{}"}},"#,
            r#"{{"trait_type": "Special", "value": "{}"}}"#,
        ),
        t.serial_number,
        t.variant,
        t.accuracy,
        t.hull,
        t.speed,
        if d.shiny { "Yes" } else { "No" },
        d.ships_destroyed,
        d.cost,
        if d.modified != 0 { "Yes" } else { "No" },
        weapon,
        armor,
        shields,
        special,
    );
    let json = format!(
        concat!(
            r#"{{"name": "{} #{}","description": "A unique spaceship in the Void Tactics universe. "#,
            r#"Each ship has unique traits, equipment, and stats that determine its capabilities in battle.", "attributes": ["#,
            r#"{}],"image": "{}"}}"#,
        ),
        ship.name,
        ship.id,
        traits,
        render_ship_image(ship),
    );
    format!("data:application/json;base64,{}", STANDARD.encode(json.as_bytes()))
}

/// ShatteredHiveMedal.tokenURI.
pub fn medal_token_uri(token_id: u64) -> String {
    let image = format!("{IMAGE_PREFIX}{}", STANDARD.encode(crate::art::MEDAL_SVG.as_bytes()));
    let json = format!(
        r#"{{"name": "Shattered Hive Campaign Medal #{token_id}","description": "Awarded for completing the Shattered Hive campaign.","image": "{image}"}}"#
    );
    format!("data:application/json;base64,{}", STANDARD.encode(json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_blends_like_render_utils() {
        assert_eq!(parse_hsl("hsl(220, 3%, 52%)"), (220, 3, 52));
        // s2 <= 40, l > 50 branch
        assert_eq!(blend_hsl(100, 50, 80, "hsl(220, 3%, 52%)"), "hsl(100, 50%, 62%)");
        // s2 > 40 branch
        assert_eq!(blend_hsl(100, 50, 80, "hsl(18, 98%, 36%)"), "hsl(22, 95%, 42%)");
        // orange accent in V2 keeps its lightness only
        assert_eq!(blend_hsl_v2(200, 30, 10, "hsl(30, 80%, 40%)"), "hsl(200, 30%, 40%)");
    }
}
