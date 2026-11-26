//! Prints each PvP map's scoring tiles with their home/center/enemy ratio
//! r = d(creator home) / (d(creator) + d(joiner)), for ship_roles.rs.
use vt_sim::content::Content;
fn main() {
    let c = Content::load();
    for m in &c.pvp_maps {
        let cen = |cr: bool| {
            let t = c.deployment_tiles(Some(m), cr);
            let n = t.len() as f32;
            (t.iter().map(|p| p.row as f32).sum::<f32>() / n, t.iter().map(|p| p.col as f32).sum::<f32>() / n, t.len())
        };
        let (a, b) = (cen(true), cen(false));
        let g = vt_core::maps::GameMap::from_preset(&c.maps[m]);
        let tiles: Vec<String> = g.scoring.iter().filter(|t| t.points != 0).map(|t| {
            let d = |x: (f32, f32, usize)| (x.0 - t.row as f32).abs() + (x.1 - t.col as f32).abs();
            format!("({},{}) {}pt r={:.2}", t.row, t.col, t.points, d(a) / (d(a) + d(b)))
        }).collect();
        println!("{m}: creator home ({:.1},{:.1}) n={} joiner ({:.1},{:.1}) n={}\n   {}", a.0, a.1, a.2, b.0, b.1, b.2, tiles.join("; "));
    }
}
