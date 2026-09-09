import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';

export interface EvaluationStack {
  /** Index of the top of the stack. */
  sp: number;
  /** Index of the base of the current frame. */
  fp: number;

  push(value: unknown): void;
  dup(position?: number): void;
  copy(from: number, to: number): void;
  pop<T>(n?: number): T;
  peek<T>(offset?: number): T;
  get<T>(offset: number, base?: number): T;
  set(value: unknown, offset: number, base?: number): void;
  slice<T = unknown>(start: number, end: number): T[];
  capture(items: number): unknown[];
  reset(): void;

  snapshot?(): unknown[];
}

/**
 * The evaluation stack holds JS values (references, arguments, scopes), so it
 * stays on the JS side of the interpreter. `sp` and `fp` live here too; the
 * machine opcodes reach them through the host callbacks.
 */
export default class EvaluationStackImpl implements EvaluationStack {
  static restore(snapshot: unknown[]): EvaluationStackImpl {
    return new this(snapshot.slice(), snapshot.length - 1);
  }

  sp: number;
  fp = -1;

  constructor(
    private stack: unknown[] = [],
    sp = -1
  ) {
    this.sp = sp;

    if (LOCAL_DEBUG) {
      this.snapshot = () => {
        const fp = this.fp === -1 ? 0 : this.fp;
        return this.stack.slice(fp, this.sp + 1);
      };
      Object.seal(this);
    }
  }

  push(value: unknown): void {
    this.stack[++this.sp] = value;
  }

  dup(position = this.sp): void {
    this.stack[++this.sp] = this.stack[position];
  }

  copy(from: number, to: number): void {
    this.stack[to] = this.stack[from];
  }

  pop<T>(n = 1): T {
    let top = this.stack[this.sp] as T;
    this.sp -= n;
    return top;
  }

  peek<T>(offset = 0): T {
    return this.stack[this.sp - offset] as T;
  }

  get<T>(offset: number, base = this.fp): T {
    return this.stack[base + offset] as T;
  }

  set(value: unknown, offset: number, base = this.fp) {
    this.stack[base + offset] = value;
  }

  slice<T = unknown>(start: number, end: number): T[] {
    return this.stack.slice(start, end) as T[];
  }

  capture(items: number): unknown[] {
    let end = this.sp + 1;
    let start = end - items;
    return this.stack.slice(start, end);
  }

  reset() {
    this.stack.length = 0;
  }

  declare snapshot?: (this: EvaluationStackImpl) => unknown[];
}
