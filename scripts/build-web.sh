#!/usr/bin/env bash
# Builds the WebAssembly modules and assembles the static site.
#
# Usage: scripts/build-web.sh [output-dir]   (default: _site)
#
# Two variants of the module are built:
#   pkg/         with GPU kernel autotuning (desktop browsers)
#   pkg-mobile/  without it (phones and tablets; autotune hangs Apple mobile GPUs)
# The page picks one at runtime. Requires the wasm32-unknown-unknown target
# and wasm-bindgen-cli matching the wasm-bindgen version in Cargo.lock.
set -euo pipefail

OUT_DIR="${1:-_site}"
WASM="${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/bassline_web.wasm"

build_variant() {
  local out_subdir="$1"
  shift
  echo "==> Building ${out_subdir} (cargo flags: ${*:-none})"
  cargo build -p bassline-web --release --target wasm32-unknown-unknown "$@"
  wasm-bindgen --target web --out-dir "${OUT_DIR}/${out_subdir}" "${WASM}"
}

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
cp web/index.html web/*.js "${OUT_DIR}/"

build_variant pkg --features autotune
build_variant pkg-mobile

ls -la "${OUT_DIR}" "${OUT_DIR}/pkg" "${OUT_DIR}/pkg-mobile"
