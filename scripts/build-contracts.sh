#!/usr/bin/env bash
# Build the test-only contracts for the sandbox tests, and lower them (and the real Sputnik DAO contract) to
# plain WebAssembly. A recent Rust compiler emits sign-extension and bulk-memory instructions that the NEAR VM in
# the local sandbox rejects with `PrepareError::Deserialization`. Needs cargo-near and `wasm-opt` (binaryen).
#
# The Sputnik DAO v2 contract is not built here: set SPUTNIK_WASM to a build of it. By default the copy that
# ships with the Trezu front end is used, if it is next to this repository.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v wasm-opt >/dev/null || { echo "wasm-opt not found: brew install binaryen" >&2; exit 1; }
mkdir -p contracts/target

lower() {
  wasm-opt "$1" -o "$2" \
    --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-multivalue --enable-mutable-globals \
    --signext-lowering --llvm-memory-copy-fill-lowering --llvm-nontrapping-fptoint-lowering -Oz
  echo "lowered $2 ($(wc -c < "$2" | tr -d ' ') bytes)"
}

cargo near build non-reproducible-wasm --no-doc --manifest-path contracts/mock-signer/Cargo.toml
lower contracts/mock-signer/target/near/mock_signer.wasm contracts/target/mock_signer.wasm

SPUTNIK_WASM="${SPUTNIK_WASM:-../../near opensource/near-repos/trezu/nt-fe/public/sputnik_dao_v2.wasm}"
if [ -f "$SPUTNIK_WASM" ]; then
  lower "$SPUTNIK_WASM" contracts/target/sputnik_dao_v2.wasm
else
  echo "no Sputnik DAO wasm at $SPUTNIK_WASM: set SPUTNIK_WASM to run the Sputnik sandbox tests" >&2
fi
