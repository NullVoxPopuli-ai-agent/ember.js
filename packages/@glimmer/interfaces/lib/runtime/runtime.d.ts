import type { ProgramConstants, ProgramHeap } from '../program.js';

export interface Program {
  readonly constants: ProgramConstants;
  readonly heap: ProgramHeap;
}

export interface RuntimeArtifacts {
  readonly constants: ProgramConstants;
  readonly heap: ProgramHeap;
}
