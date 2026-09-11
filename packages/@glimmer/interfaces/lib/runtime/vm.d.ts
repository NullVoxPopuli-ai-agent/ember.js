import type { GlimmerTreeChanges } from '../dom/changes.js';
import type { Environment } from './environment.js';

export interface UpdatingVM {
  env: Environment;
  dom: GlimmerTreeChanges;
  alwaysRevalidate: boolean;

  /**
   * Set by an assertion opcode when its value changed. The plan walker
   * unwinds to the nearest block and re-renders it.
   */
  thrown: boolean;
  throw(): void;
}

export interface UpdatingOpcode {
  evaluate(vm: UpdatingVM): void;
}

