#!/usr/bin/env bash
# Builds the void-tactics contract WASM with test hooks for the sandbox tests
# (near/tests). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo near build non-reproducible-wasm \
  --manifest-path contracts/void-tactics/Cargo.toml \
  --features test-hooks \
  --out-dir target/near/test-hooks
