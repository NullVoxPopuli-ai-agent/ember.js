import { DEBUG } from '@glimmer/env';
import type {
  ConstantTag,
  DirtyableTag,
  Tag,
  TagComputeSymbol,
  UpdatableTag,
} from '@glimmer/interfaces';
import { scheduleRevalidate } from '@glimmer/global-context';
import { computed, signal } from 'alien-signals';

import { debug } from './debug';
import { unwrap } from './utils';

// A Tag is just a function: call it to get the current revision (and, when
// called inside an alien-signals subscriber, register a dependency).
// Everything below is sugar over that.

export type Revision = number;
export const CONSTANT: Revision = 0;
export const INITIAL: Revision = 1;
export const VOLATILE: Revision = NaN;

// Kept as a Symbol export so the type from @glimmer/interfaces still resolves.
// Internal code does not go through it — it calls the tag directly.
export const COMPUTE: TagComputeSymbol = Symbol('TAG_COMPUTE') as TagComputeSymbol;
Reflect.set(globalThis, 'COMPUTE_SYMBOL', COMPUTE);

const $tick = signal<Revision>(INITIAL);
const advance = (): Revision => {
  const n = $tick() + 1;
  $tick(n);
  return n;
};
export const bump = (): void => {
  advance();
};

// Private map from a tag's read fn to its underlying writable signal.
// Only dirtyable tags are registered here.
const dirtyHandles = new WeakMap<Tag, (v: Revision) => void>();
// Private map for updatable tags whose subtag can be re-pointed via updateTag.
const subRefs = new WeakMap<Tag, (sub: Tag | null) => void>();

const asTag = (fn: () => Revision): Tag => {
  const tag = fn as unknown as Tag;
  // Maintain the [COMPUTE] property shape for the type system.
  (tag as unknown as Record<symbol, () => Revision>)[COMPUTE] = fn;
  return tag;
};

export function createTag(): DirtyableTag {
  const s = signal<Revision>(INITIAL);
  const tag = asTag(() => s());
  dirtyHandles.set(tag, s);
  return tag;
}

// An "updatable" tag is a dirtyable tag with one additional capability: a
// subtag pointer that can be re-pointed via updateTag.
//
// Two pieces of bookkeeping survive on top of the alien-signals signals,
// both of them required by ember's contract (verified by removing each and
// watching specific tests fail):
//
// 1. A cycle guard. ember's CP set/get both call updateTag(propertyTag,
//    depsChain), which sets up `barTag.sub → fooTag` and
//    `fooTag.sub → barTag` when foo/bar depend on each other. alien-signals
//    has no cycle handling that maps to ember's ALLOW_CYCLES contract, so
//    a re-entrance check returns the tag's last-seen revision and advances
//    the global tick (forcing other caches to revalidate).
// 2. An adoption "buffer". When updateTag adopts a subtag whose revision is
//    already higher than the parent's, naive `max(own, sub())` makes the
//    parent's revision jump. That would fire observers on the parent
//    without anything they care about having changed (see
//    `computed - observer interop: observers that do not consume computed
//    properties still work`). The buffer hides the adoption-time jump
//    until the subtag is itself dirtied past its adoption value.
const computing = new WeakSet<Tag>();
interface UpdatableState {
  buffer: Revision | null;
  last: Revision;
}
const updatableState = new WeakMap<Tag, UpdatableState>();

export function createUpdatableTag(): UpdatableTag {
  const ownSig = signal<Revision>(INITIAL);
  const subSig = signal<Tag | null>(null);
  const state: UpdatableState = { buffer: null, last: INITIAL };
  const tag = asTag(() => {
    if (computing.has(tag)) {
      advance();
      return state.last;
    }
    computing.add(tag);
    try {
      const o = ownSig();
      const sub = subSig();
      if (sub === null) {
        state.last = o;
        return o;
      }
      const sv = sub();
      const r =
        sv === state.buffer ? Math.max(o, state.last) : ((state.buffer = null), Math.max(o, sv));
      state.last = r;
      return r;
    } finally {
      computing.delete(tag);
    }
  });
  dirtyHandles.set(tag, ownSig);
  subRefs.set(tag, subSig);
  updatableState.set(tag, state);
  return tag;
}

export function updateTag(tag: UpdatableTag, sub: Tag): void {
  const ref = subRefs.get(tag);
  const state = updatableState.get(tag);
  if (ref === undefined || state === undefined) {
    if (DEBUG) throw new Error('Attempted to update a tag that was not updatable');
    return;
  }
  if (sub === CONSTANT_TAG) {
    state.buffer = null;
    ref(null);
  } else {
    state.buffer = sub();
    ref(sub);
  }
}
export const UPDATE_TAG = updateTag;

export function combine(tags: Tag[]): Tag {
  if (tags.length === 0) return CONSTANT_TAG;
  if (tags.length === 1) return tags[0] as Tag;
  return asTag(
    computed(() => {
      let max: Revision = INITIAL;
      // Math.max propagates NaN, keeping any combinator that includes
      // VOLATILE_TAG always-stale (validateTag is `snapshot >= NaN`).
      for (const t of tags) max = Math.max(max, t());
      return max;
    })
  );
}

export const CONSTANT_TAG: ConstantTag = asTag(() => INITIAL);

export const isConstTag = (tag: Tag): tag is ConstantTag => tag === CONSTANT_TAG;

export const VOLATILE_TAG: Tag = asTag(() => {
  $tick();
  return VOLATILE;
});

export const CURRENT_TAG: Tag = asTag(() => $tick());

export function dirtyTag(tag: DirtyableTag, skipAssertion?: boolean): void {
  const s = dirtyHandles.get(tag);
  if (s === undefined) {
    if (DEBUG) throw new Error('Attempted to dirty a tag that was not dirtyable');
    return;
  }
  if (DEBUG && skipAssertion !== true) {
    unwrap(debug.assertTagNotConsumed)(tag);
  }
  s(advance());
  scheduleRevalidate();
}
export const DIRTY_TAG = dirtyTag;

export const valueForTag = (tag: Tag): Revision => tag();
export const validateTag = (tag: Tag, snapshot: Revision): boolean => snapshot >= tag();
