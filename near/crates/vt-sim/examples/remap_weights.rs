//! Rewrites saved weights under the current feature list (features the file
//! lacks get weight 0, so the weights play exactly as before).
//!   cargo run -p vt-sim --profile sim --example remap_weights -- <in.json> <out.json>
use vt_sim::eval::Eval;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut e = Eval::load_mapped(std::path::Path::new(&a[1])).unwrap();
    e.provenance = serde_json::json!({
        "remapped_from": a[1],
        "note": "new features added at weight 0 (plays exactly as the source weights)",
        "source_provenance": e.provenance,
    });
    e.save(std::path::Path::new(&a[2])).unwrap();
    println!("-> {}", a[2]);
}
