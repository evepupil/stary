# STARY Collision WASM

This crate is the fixed Rust `wasm32-unknown-unknown` boundary for the M3 collision kernel. It
implements the LS2012/Genda classification chain, STARY deterministic remnant reconstruction,
material routing, participant-local event-total ledgers, black-hole accretion, batch capacity
checks, and owned JSON buffers behind ABI version `1`.

## Fixed Toolchain

- Rust and Cargo: `1.96.0`
- Target: `wasm32-unknown-unknown`
- Container platform: `linux/amd64`
- Build image: `rust:1.96.0-bookworm`
- Image digest: `sha256:c993d32d95cc146bd12c84d66f0b924a6a96f3988325f39c144f2f9893dea120`
- Rust dependencies: exact direct versions in `Cargo.toml`, full transitive versions in
  `Cargo.lock`

The release profile aborts on panic, checks integer overflow, enables fat LTO, uses one codegen
unit, strips symbols, and does not enable fast-math. The module uses a plain C ABI and does not use
`wasm-bindgen`.

## ABI Ownership

JavaScript asks the Rust ABI to create a monotonic context token, allocates its request buffer,
writes UTF-8 JSON, resolves the same token, then reacquires the response pointer after possible
memory growth. The context owns both buffers and is always destroyed by the adapter. Repeated or
stale token use is rejected without touching newer contexts. Requests are limited to 1 MiB and
responses to 16 MiB.

The success envelope is sorted by UTF-8 event ID and contains complete classic or
`blackHoleAccretion` domain results. Any event failure returns one batch error envelope without
partial results. TypeScript still parses the response, binds it to the original collision input,
and recomputes conservation before Task 5 can commit it.

## Build And Verify

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File crates/stary-collision/scripts/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File crates/stary-collision/scripts/verify.ps1
```

The build requires Docker and network access for the pinned image, Rust target component, and
locked Cargo dependencies. It writes exactly one collision artifact:

```text
crates/stary-collision/dist/stary_collision.wasm
```

`verify.ps1` rebuilds in the pinned container, runs the Rust tests, verifies the WASM header and
artifact lock, compiles and instantiates the module with Node, rejects host imports and extra
callable exports, and exercises the complete token lifecycle. The repository Vitest suite also
compares the real WASM response against the TypeScript reference for merge, hit-and-run,
catastrophic disruption, stable batch ordering, and black-hole accretion.
