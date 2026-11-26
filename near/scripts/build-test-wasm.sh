#!/usr/bin/env bash
# Builds the void-tactics contract WASM with test hooks for the sandbox tests
# (near/tests). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo near build non-reproducible-wasm \
  --manifest-path contracts/void-tactics/Cargo.toml \
  --features test-hooks \
  --out-dir target/near/test-hooks
cargo near build non-reproducible-wasm \
  --manifest-path contracts/test-receiver/Cargo.toml \
  --out-dir target/near/test-hooks
cargo near build non-reproducible-wasm \
  --manifest-path contracts/void-renderer/Cargo.toml \
  --out-dir target/near/test-hooks
# Same game contract plus a probe view, for the upgrade drill.
cargo near build non-reproducible-wasm \
  --manifest-path contracts/void-tactics/Cargo.toml \
  --features test-hooks,upgrade-probe \
  --out-dir target/near/upgrade-probe
