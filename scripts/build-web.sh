#!/usr/bin/env bash
# Builds the WebAssembly modules and assembles the static site.
#
# Usage: scripts/build-web.sh [output-dir]   (default: _site)
#
# With PREBUILT_PKG set to a directory holding an earlier build's pkg/
# output, the WebAssembly build is skipped and that directory is copied in
# instead (CI does this when no Rust input changed since it was built).
#
# The module is built without GPU kernel autotuning: benchmarking kernel
# variants makes some run past the GPU watchdog (Apple mobile GPUs hang, and
# on macOS the command buffer is killed with a GPU timeout).
# Requires the wasm32-unknown-unknown target and wasm-bindgen-cli matching
# the wasm-bindgen version in Cargo.lock.
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
cp web/*.html web/*.js "${OUT_DIR}/"

# The Google OAuth client for the amp's Drive sync comes from the environment
# (CI: the GOOGLE_CLIENT_ID repository variable) rather than the code; without
# it the site keeps web/drive-config.js, which hides the Drive controls.
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  if [[ ! "${GOOGLE_CLIENT_ID}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "GOOGLE_CLIENT_ID has unexpected characters" >&2
    exit 1
  fi
  echo "export const GOOGLE_CLIENT_ID = \"${GOOGLE_CLIENT_ID}\";" > "${OUT_DIR}/drive-config.js"
fi

if [[ -n "${PREBUILT_PKG:-}" ]]; then
  echo "==> Using the prebuilt WebAssembly modules in ${PREBUILT_PKG}"
  cp -r "${PREBUILT_PKG}" "${OUT_DIR}/pkg"
else
  build_variant pkg
fi

ls -la "${OUT_DIR}" "${OUT_DIR}/pkg"
