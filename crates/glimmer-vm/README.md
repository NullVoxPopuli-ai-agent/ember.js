# glimmer-vm (Rust core)

The Glimmer bytecode interpreter. It is compiled to a WebAssembly module and
embedded in `@glimmer/vm/lib/core-wasm.ts` as base64.

The module owns:

- the program heap (the instruction words) and the handle table
- the machine registers `pc` and `ra`
- instruction decode and the dispatch loop
- the machine opcodes (frames, jumps, calls, returns)

JS owns the evaluation stack, the syscall registers, and every syscall handler,
because those hold JS values.

## Build

```
node bin/build-vm-wasm.mjs
```

The script runs `cargo build --release --target wasm32-unknown-unknown`,
shrinks the module with `wasm-opt -Oz` from the `binaryen` package, and
rewrites `packages/@glimmer/vm/lib/core-wasm.ts`. The generated file is
committed, so a JS-only checkout builds without a Rust toolchain.
