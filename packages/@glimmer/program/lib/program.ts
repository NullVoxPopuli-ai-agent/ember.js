import type { Program, ProgramConstants, ProgramHeap, VmCore } from '@glimmer/interfaces';
import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';
import { createCore } from '@glimmer/vm/lib/core';
import { MACHINE_MASK } from '@glimmer/vm/lib/flags';

import { RuntimeOpImpl } from './opcode';

/**
 * The Program Heap holds the VM's instructions. The words live in the
 * interpreter's linear memory; this class is the JS view that the compiler
 * writes through. Handles are the indirect way to name a block of
 * instructions: `getaddr` turns a handle into a raw address, and raw addresses
 * are only valid during execution.
 */
export class ProgramHeapImpl implements ProgramHeap {
  readonly core: VmCore = createCore();

  private sizes: number[] | undefined = LOCAL_DEBUG ? [] : undefined;

  get offset(): number {
    return this.core.heapSize();
  }

  entries(): number {
    return this.core.entries();
  }

  pushRaw(value: number): void {
    this.core.heapPush(value);
  }

  pushOp(item: number): void {
    this.core.heapPush(item);
  }

  pushMachine(item: number): void {
    this.core.heapPush(item | MACHINE_MASK);
  }

  getbyaddr(address: number): number {
    return this.core.heapGet(address);
  }

  setbyaddr(address: number, value: number): void {
    this.core.heapSet(address, value);
  }

  malloc(): number {
    return this.core.malloc();
  }

  finishMalloc(handle: number): void {
    if (this.sizes) {
      this.sizes[handle] = this.core.heapSize() - this.core.getaddr(handle);
    }
  }

  size(): number {
    return this.core.heapSize();
  }

  getaddr(handle: number): number {
    return this.core.getaddr(handle);
  }

  sizeof(handle: number): number {
    return this.sizes ? (this.sizes[handle] ?? -1) : -1;
  }
}

export class ProgramImpl implements Program {
  [key: number]: never;

  private _opcode: RuntimeOpImpl;

  constructor(
    public constants: ProgramConstants,
    public heap: ProgramHeap
  ) {
    this._opcode = new RuntimeOpImpl(this.heap);
  }

  opcode(offset: number): RuntimeOpImpl {
    this._opcode.offset = offset;
    return this._opcode;
  }
}
