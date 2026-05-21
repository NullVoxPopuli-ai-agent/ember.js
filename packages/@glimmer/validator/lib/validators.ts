import { DEBUG } from '@glimmer/env';
import type {
  COMBINATOR_TAG_ID as ICOMBINATOR_TAG_ID,
  CONSTANT_TAG_ID as ICONSTANT_TAG_ID,
  ConstantTag,
  CURRENT_TAG_ID as ICURRENT_TAG_ID,
  DIRTYABLE_TAG_ID as IDIRTYABLE_TAG_ID,
  DirtyableTag,
  MonomorphicTagId,
  Tag,
  TagComputeSymbol,
  TagTypeSymbol,
  UPDATABLE_TAG_ID as IUPDATABLE_TAG_ID,
  UpdatableTag,
  VOLATILE_TAG_ID as IVOLATILE_TAG_ID,
} from '@glimmer/interfaces';
import { scheduleRevalidate } from '@glimmer/global-context';
import { computed, signal } from 'alien-signals';

import { debug } from './debug';
import { unwrap } from './utils';

//////////

export type Revision = number;

export const CONSTANT: Revision = 0;
export const INITIAL: Revision = 1;
export const VOLATILE: Revision = NaN;

// The one piece of global state: a monotonic counter that lives in a signal.
// Every DIRTY_TAG advances it; CurrentTag/VolatileTag read it so subscribers
// re-run on any mutation.
const tick: { (): Revision; (v: Revision): void } = signal<Revision>(INITIAL);

function next(): Revision {
  const n = tick() + 1;
  tick(n);
  return n;
}

export function bump(): void {
  next();
}

// Kept as an export only because it is part of the historical public API.
// Reads tick() each time so callers see the current value.
export const $REVISION: Revision = INITIAL;

//////////

const DIRYTABLE_TAG_ID: IDIRTYABLE_TAG_ID = 0;
const UPDATABLE_TAG_ID: IUPDATABLE_TAG_ID = 1;
const COMBINATOR_TAG_ID: ICOMBINATOR_TAG_ID = 2;
const CONSTANT_TAG_ID: ICONSTANT_TAG_ID = 3;
const VOLATILE_TAG_ID: IVOLATILE_TAG_ID = 100;
const CURRENT_TAG_ID: ICURRENT_TAG_ID = 101;

const TYPE: TagTypeSymbol = Symbol('TAG_TYPE') as TagTypeSymbol;
export const COMPUTE: TagComputeSymbol = Symbol('TAG_COMPUTE') as TagComputeSymbol;
Reflect.set(globalThis, 'COMPUTE_SYMBOL', COMPUTE);

export let ALLOW_CYCLES: WeakMap<Tag, boolean> | undefined;
if (DEBUG) {
  ALLOW_CYCLES = new WeakMap();
}

// alien-signals silently short-circuits re-entry into its own computeds, which
// would let cycles slip through validation as if everything were fresh. ember's
// computed system relies on the opposite: throw in DEBUG, bump the revision in
// PROD so the cycle eventually breaks. Track which tags are currently being
// computed in a WeakSet — cheap, no per-instance field, no per-call alloc.
const computing = new WeakSet<object>();

//////////

export function valueForTag(tag: Tag): Revision {
  return tag[COMPUTE]();
}

export function validateTag(tag: Tag, snapshot: Revision): boolean {
  return snapshot >= tag[COMPUTE]();
}

//////////

type Sig<T> = { (): T; (v: T): void };

function guard(tag: object, fold: () => Revision): Revision {
  if (computing.has(tag)) {
    if (DEBUG && !(ALLOW_CYCLES === undefined || ALLOW_CYCLES.has(tag as Tag))) {
      throw new Error('Cycles in tags are not allowed');
    }
    return next();
  }
  computing.add(tag);
  try {
    return fold();
  } finally {
    computing.delete(tag);
  }
}

class TagImpl<T extends MonomorphicTagId = MonomorphicTagId> {
  declare [TYPE]: T;
  declare [COMPUTE]: () => Revision;

  declare own: Sig<Revision>;
  declare subRef: Sig<Tag | null>;
  declare subs: Tag[];

  // Updatable only. See the fold body for the contract these encode.
  buffer: Revision | null = null;
  lastValue: Revision = INITIAL;

  constructor(type: T, subs?: Tag[]) {
    this[TYPE] = type;

    if (type === COMBINATOR_TAG_ID) {
      this.subs = subs as Tag[];
      const fold = computed(() => {
        let max: Revision = INITIAL;
        for (const t of this.subs) {
          // Math.max propagates NaN — combinators containing VOLATILE_TAG
          // (which returns NaN) must stay always-stale.
          max = Math.max(max, t[COMPUTE]());
        }
        return max;
      });
      this[COMPUTE] = () => guard(this, fold);
    } else if (type === UPDATABLE_TAG_ID) {
      this.own = signal<Revision>(INITIAL);
      this.subRef = signal<Tag | null>(null);
      const fold = computed(() => {
        const own = this.own();
        const sub = this.subRef();
        if (sub === null) return own;
        const subVal = sub[COMPUTE]();
        // While the subtag is still at the revision it had when UPDATE_TAG
        // adopted it, hide the adoption from validateTag — ember relies on
        // this to keep `get(obj, 'cp')` from dirtying observers on `cp`
        // through chain-tag setup.
        let result: Revision;
        if (subVal === this.buffer) {
          result = Math.max(own, this.lastValue);
        } else {
          this.buffer = null;
          result = Math.max(own, subVal);
        }
        this.lastValue = result;
        return result;
      });
      this[COMPUTE] = () => guard(this, fold);
    } else if (type === DIRYTABLE_TAG_ID) {
      this.own = signal<Revision>(INITIAL);
      this[COMPUTE] = () => this.own();
    } else {
      // CONSTANT_TAG: never stale.
      this[COMPUTE] = () => INITIAL;
    }
  }

  static combine(this: void, tags: Tag[]): Tag {
    switch (tags.length) {
      case 0:
        return CONSTANT_TAG;
      case 1:
        return tags[0] as Tag;
      default:
        return new TagImpl(COMBINATOR_TAG_ID, tags);
    }
  }

  static updateTag(this: void, _tag: UpdatableTag, _subtag: Tag): void {
    if (DEBUG && _tag[TYPE] !== UPDATABLE_TAG_ID) {
      throw new Error('Attempted to update a tag that was not updatable');
    }
    const tag = _tag as unknown as TagImpl;
    if (_subtag === CONSTANT_TAG) {
      tag.buffer = null;
      tag.subRef(null);
    } else {
      tag.buffer = _subtag[COMPUTE]();
      tag.subRef(_subtag);
    }
  }

  static dirtyTag(
    this: void,
    tag: DirtyableTag | UpdatableTag,
    disableConsumptionAssertion?: boolean
  ): void {
    if (DEBUG && !(tag[TYPE] === UPDATABLE_TAG_ID || tag[TYPE] === DIRYTABLE_TAG_ID)) {
      throw new Error('Attempted to dirty a tag that was not dirtyable');
    }
    if (DEBUG && disableConsumptionAssertion !== true) {
      unwrap(debug.assertTagNotConsumed)(tag);
    }
    (tag as unknown as TagImpl).own(next());
    scheduleRevalidate();
  }
}

export const DIRTY_TAG = TagImpl.dirtyTag;
export const UPDATE_TAG = TagImpl.updateTag;
export const combine = TagImpl.combine;

//////////

export function createTag(): DirtyableTag {
  return new TagImpl(DIRYTABLE_TAG_ID);
}

export function createUpdatableTag(): UpdatableTag {
  return new TagImpl(UPDATABLE_TAG_ID);
}

export const CONSTANT_TAG: ConstantTag = new TagImpl(CONSTANT_TAG_ID);

export function isConstTag(tag: Tag): tag is ConstantTag {
  return tag === CONSTANT_TAG;
}

//////////

export class VolatileTag implements Tag {
  readonly [TYPE] = VOLATILE_TAG_ID;
  [COMPUTE](): Revision {
    tick();
    return VOLATILE;
  }
}

export const VOLATILE_TAG = new VolatileTag();

//////////

export class CurrentTag implements Tag {
  readonly [TYPE] = CURRENT_TAG_ID;
  [COMPUTE](): Revision {
    return tick();
  }
}

export const CURRENT_TAG = new CurrentTag();
