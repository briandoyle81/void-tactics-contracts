//! Play the standard PvP match against a simulated player in the terminal
//! (added 2026-11-25). `vt-sim play --help` for usage.
//!
//! Fleets are random (as in the price fit and training), both deployed by
//! purpose, with the joiner seeing the creator's fleet. The game runs on the
//! simulator's engine (`vt_core`, the same rules as on chain).

use std::collections::BTreeMap;
use std::io::{BufRead, Write};

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use vt_core::engine::{GameState, MoveInput, Rules, Side, STATUS_ALIVE, STATUS_DESTROYED, STATUS_FLED};
use vt_core::grid::{GRID_HEIGHT, GRID_WIDTH};
use vt_core::types::ActionType;

use crate::arena::{PvpScenario, ScenarioOpts};
use crate::content::Content;
use vt_core::maps::PresetMap;
use crate::eval::Eval;
use crate::movegen;
use crate::purpose::assign_in_game;
use crate::rules::Config;
use crate::tactics::{Level, TacticsConfig};

pub struct PlayOpts {
    pub level: Level,
    pub human_creator: bool,
    pub seed: u64,
    pub cap: Option<u64>,
}

pub const HELP: &str = "\
Commands (ship letters are case-insensitive; rows and columns as on the board):
  A                      show where ship A can move ('+') and what it can hit
  A 5 3                  move A to row 5, column 3, then pass
  A 5 3 shoot b          move, then shoot enemy b   (also: A shoot b, staying put)
  A 5 3 special [x]      move, then use A's special (on ship x, if it needs a target)
  A 5 3 ability [x]      move, then use the faction ability (ram / repair) on x
  A pass                 stay and pass
  A retreat              withdraw A from the match
  hint                   what the same bot would play in your place
  ships | board | help | quit";

fn level_name(l: Level) -> &'static str {
    match l {
        Level::Poor => "Poor",
        Level::Average => "Average",
        Level::Excellent => "Excellent",
    }
}

struct View<'a> {
    map: Option<&'a PresetMap>,
    letter: BTreeMap<u64, char>,
    by_letter: BTreeMap<char, u64>,
    human: Side,
}

impl View<'_> {
    fn l(&self, id: u64) -> char {
        self.letter.get(&id).copied().unwrap_or('?')
    }

    fn board(&self, g: &GameState, marks: &[(i16, i16)]) -> String {
        let (h, w) = (GRID_HEIGHT as usize, GRID_WIDTH as usize);
        let mut grid = vec![vec!['.'; w]; h];
        if let Some(m) = self.map {
            for (r, c) in m.blocked.cells() {
                grid[r as usize][c as usize] = '#';
            }
            for (r, c) in m.impassable.cells() {
                grid[r as usize][c as usize] = 'X';
            }
            for s in &m.scoring {
                if s.points > 0 {
                    grid[s.row as usize][s.col as usize] = '*';
                }
            }
        }
        for &(r, c) in marks {
            let cell = &mut grid[r as usize][c as usize];
            *cell = if *cell == '*' { '%' } else { '+' };
        }
        for (&id, b) in &g.board {
            if on_board(b) {
                grid[b.row as usize][b.col as usize] = self.l(id);
            }
        }
        let mut s = String::from("\n      ");
        for c in 0..w {
            s += &format!("{:>3}", c);
        }
        s.push('\n');
        for (r, row) in grid.iter().enumerate() {
            s += &format!("  {r:>3} ");
            for ch in row {
                s += &format!("{ch:>3}");
            }
            s.push('\n');
        }
        s += "  * scoring tile   # blocks line of sight (can move through)   X impassable";
        if !marks.is_empty() {
            s += "   + reachable   % reachable scoring tile";
        }
        s.push('\n');
        s
    }

    fn side_name(&self, creator: bool) -> &'static str {
        if (self.human == Side::Creator) == creator {
            "you"
        } else {
            "bot"
        }
    }

    fn status(&self, g: &GameState) -> String {
        let tiles: Vec<String> = self
            .map
            .map(|m| m.scoring.iter().filter(|s| s.points > 0).collect::<Vec<_>>())
            .unwrap_or_default()
            .iter()
            .map(|s| {
                let who = g
                    .board
                    .iter()
                    .find(|(_, b)| on_board(b) && (b.row, b.col) == (s.row as i16, s.col as i16))
                    .map_or('-', |(&id, _)| self.l(id));
                let zone = match crate::eval::zone_of(s.col as i16, self.human == Side::Creator) {
                    crate::eval::Zone::Home => "your home",
                    crate::eval::Zone::Center => "center",
                    crate::eval::Zone::Enemy => "bot home",
                };
                format!("({},{}) {zone} {}pt: {who}", s.row, s.col, s.points)
            })
            .collect();
        format!(
            "Tiles: {}\nRound {} | score: you {} - bot {} (first to {})",
            tiles.join(" | "),
            g.current_round,
            if self.human == Side::Creator { g.creator_score } else { g.joiner_score },
            if self.human == Side::Creator { g.joiner_score } else { g.creator_score },
            g.max_score,
        )
    }

    fn roster(&self, g: &GameState, cfg: &Config, sc: &PvpScenario) -> String {
        let ships: BTreeMap<u64, &vt_core::types::Ship> =
            sc.pools.iter().flatten().map(|s| (s.id, s)).collect();
        let mut s = String::new();
        for creator in [self.human == Side::Creator, self.human != Side::Creator] {
            let asg = assign_in_game(g, creator);
            s += &format!(
                "\n{} ({}):\n",
                if self.side_name(creator) == "you" { "Your fleet" } else { "Bot fleet" },
                if creator { "creator, deployed left" } else { "joiner, deployed right" }
            );
            for (&id, b) in g.board.iter().filter(|(_, b)| b.is_creator == creator && b.placed) {
                let state = match b.status {
                    STATUS_DESTROYED => "destroyed".to_string(),
                    STATUS_FLED => "retreated".to_string(),
                    _ if b.hull_points == 0 => format!("DISABLED (reactor {})", b.reactor_critical_timer),
                    _ if g.has_moved(id) => "moved".to_string(),
                    _ => "ready".to_string(),
                };
                let eq = ships.get(&id).map_or(String::new(), |sh| {
                    format!(
                        "{:?}/{:?}/{:?}",
                        sh.equipment.main_weapon, sh.equipment.armor, sh.equipment.shields
                    )
                });
                let special = cfg
                    .rules
                    .special_resolver(b.variant, b.special)
                    .map_or("-".to_string(), |r| resolver_name(&format!("{r:?}")));
                let purpose = asg
                    .iter()
                    .find(|a| a.id == id)
                    .map_or(String::new(), |a| format!("{:?}", a.purpose));
                s += &format!(
                    "  {} ({},{})  hp {:>3}/{:<3} move {} range {} dmg {:>2} DR {:>2}%  {:<24} special {:<13} {:<8} {}\n",
                    self.l(id),
                    b.row,
                    b.col,
                    b.hull_points,
                    b.max_hull_points,
                    b.movement,
                    b.range,
                    b.gun_damage,
                    b.damage_reduction,
                    eq,
                    special,
                    purpose,
                    state,
                );
            }
        }
        s
    }

    /// HP, status and score changes between two positions.
    fn changes(&self, a: &GameState, b: &GameState) -> String {
        let mut parts = Vec::new();
        for (id, y) in &b.board {
            let Some(x) = a.board.get(id) else { continue };
            let l = self.l(*id);
            if x.hull_points != y.hull_points {
                parts.push(format!("{l} hp {}->{}", x.hull_points, y.hull_points));
                if y.hull_points == 0 && x.hull_points > 0 {
                    parts.push(format!("{l} DISABLED"));
                }
            }
            if x.status != y.status {
                parts.push(format!(
                    "{l} {}",
                    match y.status {
                        STATUS_DESTROYED => "DESTROYED",
                        STATUS_FLED => "retreated",
                        _ => "status changed",
                    }
                ));
            }
        }
        if (a.creator_score, a.joiner_score) != (b.creator_score, b.joiner_score) {
            let (ya, yb, ba, bb) = if self.human == Side::Creator {
                (a.creator_score, b.creator_score, a.joiner_score, b.joiner_score)
            } else {
                (a.joiner_score, b.joiner_score, a.creator_score, b.creator_score)
            };
            parts.push(format!("score you {ya}->{yb}, bot {ba}->{bb}"));
        }
        if b.current_round != a.current_round {
            parts.push(format!("round {} begins", b.current_round));
        }
        parts.join(", ")
    }

    fn describe(&self, g: &GameState, mv: &MoveInput) -> String {
        let b = g.ship(mv.ship_id);
        let who = self.l(mv.ship_id);
        let tgt = if mv.target_ship_id != 0 {
            format!(" {}", self.l(mv.target_ship_id))
        } else {
            String::new()
        };
        let act = match mv.action {
            ActionType::Pass => "passes".to_string(),
            ActionType::Shoot => format!("shoots{tgt}"),
            ActionType::Retreat => return format!("{who} retreats"),
            ActionType::Special => format!("uses its special{tgt}"),
            ActionType::FactionAbility => format!("uses its faction ability{tgt}"),
            ActionType::Assist => format!("assists{tgt}"),
        };
        if (mv.new_row, mv.new_col) == (b.row, b.col) {
            format!("{who} stays at ({},{}) and {act}", b.row, b.col)
        } else {
            format!(
                "{who} moves ({},{}) -> ({},{}) and {act}",
                b.row, b.col, mv.new_row, mv.new_col
            )
        }
    }
}

fn resolver_name(dbg: &str) -> String {
    dbg.split([' ', '{', '(']).next().unwrap_or(dbg).to_string()
}

fn on_board(b: &vt_core::engine::ShipBoard) -> bool {
    b.placed && b.status != STATUS_DESTROYED && b.status != STATUS_FLED
}

enum Cmd {
    Move(MoveInput),
    Show(u64),
    Hint,
    Ships,
    Board,
    Help,
    Quit,
}

fn parse(line: &str, v: &View, g: &GameState) -> Result<Cmd, String> {
    let t: Vec<String> = line.split_whitespace().map(|s| s.to_lowercase()).collect();
    let Some(first) = t.first() else {
        return Err(String::new());
    };
    match first.as_str() {
        // Full words only: single letters are ship names.
        "hint" => return Ok(Cmd::Hint),
        "ships" => return Ok(Cmd::Ships),
        "board" => return Ok(Cmd::Board),
        "help" | "?" => return Ok(Cmd::Help),
        "quit" | "exit" => return Ok(Cmd::Quit),
        _ => {}
    }
    let letter = |s: &str, own: bool| -> Result<u64, String> {
        let mut c = s.chars();
        let (Some(ch), None) = (c.next(), c.next()) else {
            return Err(format!("'{s}' isn't a ship letter"));
        };
        let ch = if own { own_letter(ch, v) } else { enemy_or_any(ch, v) };
        v.by_letter.get(&ch).copied().ok_or(format!("no ship '{ch}'"))
    };
    let id = letter(first, true)?;
    let b = g.ship(id);
    if t.len() == 1 {
        return Ok(Cmd::Show(id));
    }
    let mut i = 1;
    let (mut row, mut col) = (b.row, b.col);
    if let (Some(r), Some(c)) = (
        t.get(1).and_then(|s| s.parse::<i16>().ok()),
        t.get(2).and_then(|s| s.parse::<i16>().ok()),
    ) {
        (row, col) = (r, c);
        i = 3;
    }
    let action = match t.get(i).map(String::as_str) {
        None | Some("pass") | Some("p") => ActionType::Pass,
        Some("shoot") | Some("fire") | Some("attack") => ActionType::Shoot,
        Some("special") | Some("sp") => ActionType::Special,
        Some("ability") | Some("ram") | Some("repair") | Some("ab") => ActionType::FactionAbility,
        Some("retreat") => ActionType::Retreat,
        Some(x) => return Err(format!("unknown action '{x}' (type help)")),
    };
    let target = match t.get(i + 1) {
        Some(s) => letter(s, false)?,
        None if action == ActionType::Shoot => return Err("shoot which ship?".into()),
        None => 0,
    };
    if action == ActionType::Retreat {
        (row, col) = (b.row, b.col);
    }
    Ok(Cmd::Move(MoveInput {
        ship_id: id,
        new_row: row,
        new_col: col,
        action,
        target_ship_id: target,
    }))
}

/// Your ships are one case, the bot's the other: a letter typed in either
/// case maps to your ship when it names one.
fn own_letter(ch: char, v: &View) -> char {
    let upper = v.human == Side::Creator;
    if upper {
        ch.to_ascii_uppercase()
    } else {
        ch.to_ascii_lowercase()
    }
}

fn enemy_or_any(ch: char, v: &View) -> char {
    // Targets are usually enemies; a repair targets a friend. Exact case
    // first, then the enemy's case.
    if v.by_letter.contains_key(&ch) {
        return ch;
    }
    if v.human == Side::Creator {
        ch.to_ascii_lowercase()
    } else {
        ch.to_ascii_uppercase()
    }
}

pub fn run(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    tc: &TacticsConfig,
    o: &PlayOpts,
) -> std::io::Result<()> {
    let mut opts = ScenarioOpts::default();
    if let Some(c) = o.cap {
        opts.cost_caps = vec![c];
    }
    let mut sc = PvpScenario::random(content, cfg, o.seed, &opts);
    sc.deploy_by_purpose(content, cfg, &[0, 1]);
    // Fleet 0 is yours; start(.., fa) makes fleet fa the creator.
    let mut g = sc.start(cfg, content, if o.human_creator { 0 } else { 1 });
    let human = if o.human_creator { Side::Creator } else { Side::Joiner };
    let bot = tc.make(o.level, eval);
    let helper = tc.make(o.level, eval);
    let mut rng = ChaCha8Rng::seed_from_u64(o.seed ^ 0x5eed);

    let mut letter = BTreeMap::new();
    let mut counts = [0u8; 2];
    for (&id, b) in g.board.iter().filter(|(_, b)| b.placed) {
        let k = if b.is_creator { 0 } else { 1 };
        let base = if k == 0 { b'A' } else { b'a' };
        letter.insert(id, (base + counts[k] % 26) as char);
        counts[k] += 1;
    }
    let by_letter = letter.iter().map(|(&id, &c)| (c, id)).collect();
    let v = View {
        map: content.maps.get(&sc.map),
        letter,
        by_letter,
        human,
    };

    println!(
        "Void Tactics: standard match (map {}, first to {}), you vs the {} bot. Seed {}.",
        sc.map,
        g.max_score,
        level_name(o.level),
        o.seed
    );
    println!(
        "You are the {} ({} letters, deployed on the {}). Both fleets were deployed by purpose.",
        if o.human_creator { "creator" } else { "joiner" },
        if o.human_creator { "UPPERCASE" } else { "lowercase" },
        if o.human_creator { "left" } else { "right" },
    );
    println!("{HELP}");
    print!("{}", v.roster(&g, cfg, &sc));

    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut moves = 0;
    let mut shown_turn = false;
    while !g.ended && moves < 2000 {
        let side = g.current_turn;
        if side != human {
            let Some(mv) = bot.choose(&g, &cfg.rules, side, &mut rng) else {
                println!("The bot has no move.");
                break;
            };
            let desc = v.describe(&g, &mv);
            let before = g.clone();
            if let Err(e) = g.move_ship(side, &mv, &cfg.rules, 0) {
                println!("bot move rejected by the engine: {e:?}");
                break;
            }
            moves += 1;
            let ch = v.changes(&before, &g);
            println!("  bot: {desc}{}", if ch.is_empty() { String::new() } else { format!("  [{ch}]") });
            shown_turn = false;
            continue;
        }
        if movegen::legal_moves(&g, &cfg.rules, side, movegen::Targets::Pruned).is_empty() {
            println!("You have no legal move.");
            break;
        }
        if !shown_turn {
            print!("{}", v.board(&g, &[]));
            println!("{}", v.status(&g));
            let ready: Vec<String> = movegen::actors(&g, side).iter().map(|&id| v.l(id).to_string()).collect();
            println!("Your move. Ready ships: {}", if ready.is_empty() { "none (you may retreat)".into() } else { ready.join(" ") });
            shown_turn = true;
        }
        print!("> ");
        std::io::stdout().flush()?;
        let Some(line) = lines.next() else { break };
        let line = line?;
        match parse(&line, &v, &g) {
            Err(e) if e.is_empty() => {}
            Err(e) => println!("  {e}"),
            Ok(Cmd::Help) => println!("{HELP}"),
            Ok(Cmd::Quit) => return Ok(()),
            Ok(Cmd::Ships) => print!("{}", v.roster(&g, cfg, &sc)),
            Ok(Cmd::Board) => {
                print!("{}", v.board(&g, &[]));
                println!("{}", v.status(&g));
            }
            Ok(Cmd::Hint) => match helper.choose(&g, &cfg.rules, side, &mut rng) {
                Some(mv) => println!("  hint: {}", v.describe(&g, &mv)),
                None => println!("  no hint"),
            },
            Ok(Cmd::Show(id)) => {
                let b = g.ship(id);
                if b.is_creator != (human == Side::Creator) {
                    println!(
                        "  {} (bot): hp {}/{}, move {}, range {}, dmg {}",
                        v.l(id), b.hull_points, b.max_hull_points, b.movement, b.range, b.gun_damage
                    );
                    continue;
                }
                if g.has_moved(id) || b.hull_points == 0 || b.status != STATUS_ALIVE {
                    println!("  {} can't act this round (moved or disabled); it can still retreat.", v.l(id));
                    continue;
                }
                let dests = movegen::destinations(&g, id);
                print!("{}", v.board(&g, &dests[1..]));
                // Every legal shot (the engine checks range and line of
                // sight), grouped by target: from here, and from which cells.
                let mut shots: BTreeMap<u64, (bool, Vec<(i16, i16)>, u8)> = BTreeMap::new();
                for c in movegen::ship_moves(&g, &cfg.rules, side, id, movegen::Targets::Pruned) {
                    if c.mv.action != ActionType::Shoot {
                        continue;
                    }
                    let t = c.mv.target_ship_id;
                    let e = shots.entry(t).or_insert((false, Vec::new(), u8::MAX));
                    let here = (c.mv.new_row, c.mv.new_col) == (b.row, b.col);
                    e.0 |= here;
                    if !here {
                        e.1.push((c.mv.new_row, c.mv.new_col));
                    }
                    e.2 = e.2.min(c.next.ship(t).hull_points);
                }
                println!(
                    "  {} at ({},{}), move {}, range {}, dmg {}.",
                    v.l(id), b.row, b.col, b.movement, b.range, b.gun_damage
                );
                if shots.is_empty() {
                    println!("  No enemy can be shot this turn.");
                }
                for (t, (here, cells, hp_after)) in &shots {
                    let tb = g.ship(*t);
                    let cells: Vec<String> = cells.iter().take(6).map(|(r, c)| format!("({r},{c})")).collect();
                    println!(
                        "  can shoot {} (hp {} -> {}){}{}",
                        v.l(*t),
                        tb.hull_points,
                        hp_after,
                        if *here { ", from here" } else { "" },
                        if cells.is_empty() { String::new() } else { format!(", from e.g. {}", cells.join(" ")) },
                    );
                }
            }
            Ok(Cmd::Move(mv)) => {
                let desc = v.describe(&g, &mv);
                let before = g.clone();
                let mut next = g.clone();
                match next.move_ship(side, &mv, &cfg.rules, 0) {
                    Ok(_) => {
                        g = next;
                        moves += 1;
                        let ch = v.changes(&before, &g);
                        println!("  you: {desc}{}", if ch.is_empty() { String::new() } else { format!("  [{ch}]") });
                    }
                    Err(e) => println!("  not allowed: {e:?}"),
                }
            }
        }
    }
    print!("{}", v.board(&g, &[]));
    println!("{}", v.status(&g));
    match g.winner {
        Some(w) if w == human => println!("You win."),
        Some(_) => println!("The bot wins."),
        None => println!("Draw (or stopped)."),
    }
    Ok(())
}
