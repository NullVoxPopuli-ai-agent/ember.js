import { DEBUG } from '@glimmer/env';
import type {
  COMBINATOR_TAG_ID as ICOMBINATOR_TAG_ID,
  CONSTANT_TAG_ID as ICONSTANT_TAG_ID,
  ConstantTag,
  CURRENT_TAG_ID as ICURRENT_TAG_ID,
  DIRTYABLE_TAG_ID as IDIRTYABLE_TAG_ID,
  DirtyableTag,
  Tag,
  TagComputeSymbol,
  TagTypeSymbol,
  UPDATABLE_TAG_ID as IUPDATABLE_TAG_ID,
  UpdatableTag,
  VOLATILE_TAG_ID as IVOLATILE_TAG_ID,
} from '@glimmer/interfaces';
import { scheduleRevalidate } from '@glimmer/global-context';
import { signal } from 'alien-signals';

import { debug } from './debug';
import { unwrap } from './utils';

export type Revision = number;
export const CONSTANT: Revision = 0;
export const INITIAL: Revision = 1;
export const VOLATILE: Revision = NaN;

const TYPE: TagTypeSymbol = Symbol('TAG_TYPE') as TagTypeSymbol;
export const COMPUTE: TagComputeSymbol = Symbol('TAG_COMPUTE') as TagComputeSymbol;
Reflect.set(globalThis, 'COMPUTE_SYMBOL', COMPUTE);

const DIRTYABLE: IDIRTYABLE_TAG_ID = 0;
const UPDATABLE: IUPDATABLE_TAG_ID = 1;
const COMBINATOR: ICOMBINATOR_TAG_ID = 2;
const CONST: ICONSTANT_TAG_ID = 3;
const VOLATILE_ID: IVOLATILE_TAG_ID = 100;
const CURRENT_ID: ICURRENT_TAG_ID = 101;

// The one piece of shared state. Every DIRTY_TAG advances the tick; readers
// inside an alien-signals subscriber pick up a dependency on "any mutation
// happened since" through CurrentTag/VolatileTag.
const $tick = signal<Revision>(INITIAL);
const advance = (): Revision => {
  const n = $tick() + 1;
  $tick(n);
  return n;
};
export const bump = (): void => {
  advance();
};

export let ALLOW_CYCLES: WeakMap<Tag, boolean> | undefined;
if (DEBUG) ALLOW_CYCLES = new WeakMap();

// Cycle handling. alien-signals silently short-circuits re-entry; ember's CP
// system intentionally constructs cycles between property tags and expects
// either a throw (DEBUG) or a stable cached value with the global revision
// advanced (production), so that other caches invalidate on the next read.
const inFlight = new WeakSet<object>();
const safeCompute = (tag: ReadonlyTag, fold: () => Revision): Revision => {
  if (inFlight.has(tag)) {
    if (DEBUG && !(ALLOW_CYCLES === undefined || ALLOW_CYCLES.has(tag as unknown as Tag))) {
      throw new Error('Cycles in tags are not allowed');
    }
    advance();
    return tag.lastValue;
  }
  inFlight.add(tag);
  try {
    return fold();
  } finally {
    inFlight.delete(tag);
  }
};

type Sig<T> = { (): T; (v: T): void };
interface ReadonlyTag {
  lastValue: Revision;
}

export const valueForTag = (tag: Tag): Revision => tag[COMPUTE]();
export const validateTag = (tag: Tag, snapshot: Revision): boolean => snapshot >= tag[COMPUTE]();

export function createTag(): DirtyableTag {
  const own = signal<Revision>(INITIAL);
  return {
    [TYPE]: DIRTYABLE,
    [COMPUTE]: () => own(),
    own,
    lastValue: INITIAL,
  } as unknown as DirtyableTag;
}

interface UpdatableInternals extends Tag, ReadonlyTag {
  own: Sig<Revision>;
  sub: Sig<Tag | null>;
  buffer: Revision | null;
}

export function createUpdatableTag(): UpdatableTag {
  const own = signal<Revision>(INITIAL);
  const sub = signal<Tag | null>(null);
  const tag: UpdatableInternals = {
    [TYPE]: UPDATABLE,
    own,
    sub,
    buffer: null,
    lastValue: INITIAL,
    [COMPUTE]: () => safeCompute(tag, fold),
  };
  // The buffer/lastValue pair preserves ember's "adopting a subtag with a
  // higher revision doesn't immediately invalidate snapshots taken before
  // the adoption" contract — see updateTag below and the explicit test in
  // test/validators-test.ts. While `subVal === buffer` (i.e. the subtag is
  // still at the revision captured at UPDATE_TAG time), the parent reports
  // its pre-adoption value instead of jumping to the subtag's value.
  const fold = (): Revision => {
    const o = own();
    const s = sub();
    if (s === null) {
      tag.lastValue = o;
      return o;
    }
    const sv = s[COMPUTE]();
    const r =
      sv === tag.buffer ? Math.max(o, tag.lastValue) : ((tag.buffer = null), Math.max(o, sv));
    tag.lastValue = r;
    return r;
  };
  return tag as unknown as UpdatableTag;
}

interface CombinatorInternals extends Tag, ReadonlyTag {}

export function combine(tags: Tag[]): Tag {
  if (tags.length === 0) return CONSTANT_TAG;
  if (tags.length === 1) return tags[0] as Tag;
  const tag: CombinatorInternals = {
    [TYPE]: COMBINATOR,
    lastValue: INITIAL,
    [COMPUTE]: () =>
      safeCompute(tag, () => {
        let max: Revision = INITIAL;
        // Math.max propagates NaN, which keeps combinators containing
        // VOLATILE_TAG always-stale (validateTag tests `snapshot >= NaN`).
        for (const t of tags) max = Math.max(max, t[COMPUTE]());
        tag.lastValue = max;
        return max;
      }),
  };
  return tag;
}

export const CONSTANT_TAG: ConstantTag = {
  [TYPE]: CONST,
  [COMPUTE]: () => INITIAL,
};

export const isConstTag = (tag: Tag): tag is ConstantTag => tag === CONSTANT_TAG;

export const VOLATILE_TAG: Tag = {
  [TYPE]: VOLATILE_ID,
  [COMPUTE]: () => {
    $tick();
    return VOLATILE;
  },
};

export const CURRENT_TAG: Tag = {
  [TYPE]: CURRENT_ID,
  [COMPUTE]: () => $tick(),
};

export function updateTag(tag: UpdatableTag, sub: Tag): void {
  if (DEBUG && tag[TYPE] !== UPDATABLE) {
    throw new Error('Attempted to update a tag that was not updatable');
  }
  const t = tag as unknown as UpdatableInternals;
  if (sub === CONSTANT_TAG) {
    t.buffer = null;
    t.sub(null);
  } else {
    t.buffer = sub[COMPUTE]();
    t.sub(sub);
  }
}
export const UPDATE_TAG = updateTag;

export function dirtyTag(tag: DirtyableTag | UpdatableTag, skipAssertion?: boolean): void {
  if (DEBUG && tag[TYPE] !== UPDATABLE && tag[TYPE] !== DIRTYABLE) {
    throw new Error('Attempted to dirty a tag that was not dirtyable');
  }
  if (DEBUG && skipAssertion !== true) {
    unwrap(debug.assertTagNotConsumed)(tag);
  }
  (tag as unknown as UpdatableInternals).own(advance());
  scheduleRevalidate();
}
export const DIRTY_TAG = dirtyTag;
