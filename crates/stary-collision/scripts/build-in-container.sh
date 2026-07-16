#!/usr/bin/env bash
set -euo pipefail

readonly expected_rustc="rustc 1.96.0 (ac68faa20 2026-05-25)"
readonly expected_cargo="cargo 1.96.0 (30a34c682 2026-05-25)"
readonly target="wasm32-unknown-unknown"
readonly rustup_dist_server="https://rsproxy.cn"

export RUSTUP_DIST_SERVER="${rustup_dist_server}"
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL="sparse"
test "$(rustc --version)" = "${expected_rustc}"
test "$(cargo --version)" = "${expected_cargo}"
rustup target add --toolchain 1.96.0 "${target}"

if [[ "${STARY_COLLISION_RUN_TESTS:-0}" == "1" ]]; then
  cargo test --locked --release
fi

rm -rf dist "target/${target}/release"
mkdir -p dist

CARGO_INCREMENTAL=0 \
SOURCE_DATE_EPOCH=0 \
RUSTFLAGS="-C target-cpu=mvp --remap-path-prefix=/work=." \
  cargo build --locked --release --target "${target}"

install -m 0644 \
  "target/${target}/release/stary_collision.wasm" \
  dist/stary_collision.wasm
