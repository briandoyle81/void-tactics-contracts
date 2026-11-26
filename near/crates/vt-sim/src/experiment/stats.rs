//! Small statistics helpers for the report: logistic regression with
//! standard errors, Bradley–Terry ratings, and binomial intervals.

/// Solves A x = b (dense, partial pivoting).
pub fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n)
            .max_by(|&i, &j| a[i][c].abs().partial_cmp(&a[j][c].abs()).unwrap())
            .unwrap();
        a.swap(c, p);
        b.swap(c, p);
        if a[c][c].abs() < 1e-300 {
            continue;
        }
        for r in c + 1..n {
            let f = a[r][c] / a[c][c];
            if f == 0.0 {
                continue;
            }
            for k in c..n {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for c in (0..n).rev() {
        if a[c][c].abs() < 1e-300 {
            continue;
        }
        x[c] = (b[c] - (c + 1..n).map(|k| a[c][k] * x[k]).sum::<f64>()) / a[c][c];
    }
    x
}

/// Diagonal of A^-1 (solving for each unit vector).
pub fn inverse_diagonal(a: &[Vec<f64>]) -> Vec<f64> {
    let n = a.len();
    (0..n)
        .map(|i| {
            let mut e = vec![0.0; n];
            e[i] = 1.0;
            solve(a.to_vec(), e)[i]
        })
        .collect()
}

pub struct LogitFit {
    /// Coefficients; index 0 is the intercept when `rows` include a 1.
    pub w: Vec<f64>,
    pub se: Vec<f64>,
    pub logloss: f64,
}

/// L2-regularized logistic regression by Newton's method on rows (x, y),
/// y in [0, 1] (draws as 0.5). Standard errors from the inverse Hessian.
/// `l2` applies to every coefficient except index 0.
pub fn logistic(rows: &[(Vec<f64>, f64)], l2: f64) -> LogitFit {
    let k = rows.first().map_or(0, |r| r.0.len());
    let mut w = vec![0.0; k];
    let hessian = |w: &[f64]| -> (Vec<f64>, Vec<Vec<f64>>) {
        let mut g = vec![0.0; k];
        let mut h = vec![vec![0.0; k]; k];
        for (x, y) in rows {
            let z: f64 = x.iter().zip(w).map(|(a, b)| a * b).sum();
            let p = 1.0 / (1.0 + (-z).exp());
            let q = p * (1.0 - p);
            for i in 0..k {
                if x[i] == 0.0 {
                    continue;
                }
                g[i] += (p - y) * x[i];
                for j in 0..k {
                    if x[j] != 0.0 {
                        h[i][j] += q * x[i] * x[j];
                    }
                }
            }
        }
        for i in 0..k {
            if i > 0 {
                g[i] += l2 * w[i];
                h[i][i] += l2;
            }
            h[i][i] += 1e-9;
        }
        (g, h)
    };
    for _ in 0..60 {
        let (g, h) = hessian(&w);
        let step = solve(h, g);
        for i in 0..k {
            w[i] -= step[i];
        }
        if step.iter().map(|s| s.abs()).fold(0.0, f64::max) < 1e-9 {
            break;
        }
    }
    let (_, h) = hessian(&w);
    let se = inverse_diagonal(&h)
        .into_iter()
        .map(|v| v.max(0.0).sqrt())
        .collect();
    let logloss = rows
        .iter()
        .map(|(x, y)| {
            let z: f64 = x.iter().zip(&w).map(|(a, b)| a * b).sum();
            let p = (1.0 / (1.0 + (-z).exp())).clamp(1e-12, 1.0 - 1e-12);
            -(y * p.ln() + (1.0 - y) * (1.0 - p).ln())
        })
        .sum::<f64>()
        / rows.len().max(1) as f64;
    LogitFit { w, se, logloss }
}

/// Bradley–Terry ratings from games (i, j, points for i in [0, 1]):
/// P(i beats j) = sigmoid(s_i - s_j). Returned as Elo (400 / ln 10 scale),
/// mean 1500. A small prior keeps unbeaten players finite.
pub fn bradley_terry_elo(n: usize, games: &[(usize, usize, f64)]) -> Vec<f64> {
    let mut s = vec![0.0f64; n];
    for _ in 0..2000 {
        let mut g = vec![0.0; n];
        let mut h = vec![1e-3; n];
        for &(i, j, y) in games {
            let p = 1.0 / (1.0 + (-(s[i] - s[j])).exp());
            g[i] += y - p;
            g[j] -= y - p;
            h[i] += p * (1.0 - p);
            h[j] += p * (1.0 - p);
        }
        let mut moved = 0.0f64;
        for i in 0..n {
            let step = (g[i] - 0.01 * s[i]) / h[i];
            s[i] += step;
            moved = moved.max(step.abs());
        }
        if moved < 1e-10 {
            break;
        }
    }
    let mean = s.iter().sum::<f64>() / n.max(1) as f64;
    s.iter()
        .map(|x| 1500.0 + (x - mean) * 400.0 / std::f64::consts::LN_10)
        .collect()
}

/// Mean and 95% half-width (normal approximation) of points in [0, 1].
pub fn mean_ci(pts: &[f64]) -> (f64, f64) {
    let n = pts.len() as f64;
    if n == 0.0 {
        return (f64::NAN, f64::NAN);
    }
    let m = pts.iter().sum::<f64>() / n;
    let v = pts.iter().map(|p| (p - m).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    (m, 1.96 * (v / n).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logistic_recovers_a_known_coefficient() {
        // y = 1 exactly when x > 0, softened: coefficient sign and size.
        let rows: Vec<(Vec<f64>, f64)> = (0..400)
            .map(|i| {
                let x = (i as f64 - 200.0) / 100.0;
                let p = 1.0 / (1.0 + (-(2.0 * x)).exp());
                (vec![1.0, x], p)
            })
            .collect();
        let f = logistic(&rows, 0.0);
        assert!((f.w[1] - 2.0).abs() < 1e-3, "{:?}", f.w);
        assert!(f.w[0].abs() < 1e-3);
        assert!(f.se[1] > 0.0);
    }

    #[test]
    fn bradley_terry_orders_players() {
        // 0 beats 1 75%, 1 beats 2 75%.
        let mut g = Vec::new();
        for _ in 0..30 {
            g.extend([
                (0, 1, 1.0),
                (0, 1, 1.0),
                (0, 1, 1.0),
                (0, 1, 0.0),
                (1, 2, 1.0),
                (1, 2, 1.0),
                (1, 2, 1.0),
                (1, 2, 0.0),
            ]);
        }
        let e = bradley_terry_elo(3, &g);
        assert!(e[0] > e[1] && e[1] > e[2], "{e:?}");
        // log-odds 3 per step -> ~191 Elo.
        assert!(((e[0] - e[1]) - 191.0).abs() < 15.0, "{e:?}");
    }
}
