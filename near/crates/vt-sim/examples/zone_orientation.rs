//! Checks every map deploys the creator left of the joiner (eval role zones
//! are column-based). Prints any map where it doesn't.
use vt_sim::content::Content;
fn main() {
    let c = Content::load();
    let mut keys: Vec<_> = c.maps.keys().cloned().collect();
    keys.sort();
    let mut bad = 0;
    for m in &keys {
        let col = |cr: bool| {
            let t = c.deployment_tiles(Some(m), cr);
            t.iter().map(|p| p.col as f32).sum::<f32>() / t.len().max(1) as f32
        };
        let (a, b) = (col(true), col(false));
        if a >= b - 4.0 {
            bad += 1;
            println!("{m}: creator col {a:.1}, joiner col {b:.1}");
        }
    }
    println!("{} maps, {bad} not creator-left/joiner-right", keys.len());
}
