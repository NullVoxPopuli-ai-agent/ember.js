import type { Syscall, VmCore, VmHost } from '@glimmer/interfaces';

import { CORE_WASM, SYSCALL_TYPES } from './core-wasm';

/**
 * Syscall handlers by opcode type. `@glimmer/runtime` fills this table when it
 * loads; the interpreter calls through it.
 */
export const SYSCALLS: Syscall[] = [];

function missingSyscall(type: number): Syscall {
  return () => {
    throw new Error(`No handler registered for opcode ${type}`);
  };
}

export function registerSyscall(type: number, syscall: Syscall): void {
  SYSCALLS[type] = syscall;
}

const NO_HOST: VmHost = {
  pushFrame() {
    throw new Error('The interpreter ran without a host VM');
  },
  popFrame(): number {
    throw new Error('The interpreter ran without a host VM');
  },
  invokeVirtual(): number {
    throw new Error('The interpreter ran without a host VM');
  },
  traceCall() {},
  traceReturn() {},
};

/**
 * The VM whose stack the interpreter is running against. Execution is
 * synchronous, so one binding is enough; `enterHost` returns the previous
 * host so a nested execution can restore it.
 */
let CURRENT: VmHost = NO_HOST;

export function enterHost(host: VmHost): VmHost {
  const previous = CURRENT;
  CURRENT = host;
  return previous;
}

export function exitHost(previous: VmHost): void {
  CURRENT = previous;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildImports(): WebAssembly.Imports {
  const env: Record<string, (...args: number[]) => number | void> = {
    pushFrame: (ra: number) => {
      CURRENT.pushFrame(ra);
    },
    popFrame: () => CURRENT.popFrame(),
    invokeVirtual: () => CURRENT.invokeVirtual(),
    traceCall: (handle: number) => {
      CURRENT.traceCall(handle);
    },
    traceReturn: () => {
      CURRENT.traceReturn();
    },
  };

  for (const type of SYSCALL_TYPES) {
    SYSCALLS[type] ??= missingSyscall(type);
    env[`s${type}`] = (op1: number, op2: number, op3: number) => {
      (SYSCALLS[type] as Syscall)(CURRENT, op1, op2, op3);
    };
  }

  return { env };
}

let MODULE: WebAssembly.Module | undefined;
let IMPORTS: WebAssembly.Imports | undefined;

/**
 * Create a fresh interpreter instance. Each program gets its own, so its heap
 * and handle table are isolated from other programs on the page.
 */
export function createCore(): VmCore {
  if (MODULE === undefined) {
    MODULE = new WebAssembly.Module(decode(CORE_WASM));
    IMPORTS = buildImports();
  }

  const instance = new WebAssembly.Instance(MODULE, IMPORTS);
  return instance.exports as unknown as VmCore;
}
