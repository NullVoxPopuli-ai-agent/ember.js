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

export let $REVISION = INITIAL;

// Global "current revision" signal. Every mutation bumps it; reads inside an
// alien-signals subscriber register a dependency on "any mutation since".
const tick: { (): Revision; (v: Revision): void } = signal<Revision>(INITIAL);

function advance(): Revision {
  tick(++$REVISION);
  return $REVISION;
}

export function bump(): void {
  advance();
}

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

function allowsCycles(tag: Tag): boolean {
  return ALLOW_CYCLES === undefined || ALLOW_CYCLES.has(tag);
}

//////////

export function valueForTag(tag: Tag): Revision {
  return tag[COMPUTE]();
}

export function validateTag(tag: Tag, snapshot: Revision): boolean {
  return snapshot >= tag[COMPUTE]();
}

//////////

type Sig<T> = { (): T; (v: T): void };

/**
 * Every tag (dirtyable, updatable, combinator, constant) is one of these.
 * The whole "revision counter + lastChecked cache + subtagBufferCache" state
 * machine that used to live here has been replaced by alien-signals: each
 * tag's dirty state is a signal write, and folds across subtags are
 * memoized `computed`s that alien-signals invalidates automatically.
 */
class TagImpl<T extends MonomorphicTagId = MonomorphicTagId> {
  declare [TYPE]: T;
  declare [COMPUTE]: () => Revision;

  // Dirtyable/updatable only: the revision at which this tag was last dirtied.
  declare own: Sig<Revision>;

  // Updatable only: pointer to the current subtag. Writing it invalidates
  // every subscriber of this tag's [COMPUTE].
  declare subRef: Sig<Tag | null>;

  // Updatable only: snapshot of subtag's revision at UPDATE_TAG time. While
  // the subtag stays at this revision, the parent reports its pre-adoption
  // value instead of jumping to the subtag's (possibly higher) revision.
  buffer: Revision | null = null;
  lastValue: Revision = INITIAL;

  // Combinator only: immutable list of subtags.
  declare subs: Tag[];

  // Re-entrance flag for the small amount of cycle handling alien-signals
  // doesn't give us for free.
  computing = false;

  constructor(type: T, subs?: Tag[]) {
    this[TYPE] = type;

    if (type === COMBINATOR_TAG_ID) {
      this.subs = subs as Tag[];
      const fold = computed(() => {
        let max: Revision = INITIAL;
        for (const t of this.subs) {
          // Math.max propagates NaN, which keeps combinators containing
          // VOLATILE_TAG always-stale (validateTag tests `snapshot >= NaN`,
          // which is false).
          max = Math.max(max, t[COMPUTE]());
        }
        return max;
      });
      this[COMPUTE] = () => this.guard(fold);
    } else if (type === UPDATABLE_TAG_ID) {
      this.own = signal<Revision>(INITIAL);
      this.subRef = signal<Tag | null>(null);
      const fold = computed(() => {
        const own = this.own();
        const sub = this.subRef();
        let result: Revision;
        if (sub === null) {
          result = own;
        } else {
          const subVal = sub[COMPUTE]();
          // While subtag hasn't been dirtied since adoption, hide the
          // bookkeeping jump that UPDATE_TAG would otherwise cause. Once the
          // subtag is dirtied, clear the buffer so future reads track it.
          if (subVal === this.buffer) {
            result = Math.max(own, this.lastValue);
          } else {
            this.buffer = null;
            result = Math.max(own, subVal);
          }
        }
        this.lastValue = result;
        return result;
      });
      this[COMPUTE] = () => this.guard(fold);
    } else if (type === DIRYTABLE_TAG_ID) {
      this.own = signal<Revision>(INITIAL);
      this[COMPUTE] = () => this.own();
    } else {
      // CONSTANT_TAG: never stale.
      this[COMPUTE] = () => INITIAL;
    }
  }

  // Cycle detection: alien-signals short-circuits its own re-entry to avoid
  // infinite recursion, but we still need to surface the cycle to ember's
  // ALLOW_CYCLES contract. Run the check before alien-signals' computed
  // wrapper short-circuits us.
  private guard(fold: () => Revision): Revision {
    if (this.computing) {
      if (DEBUG && !allowsCycles(this)) {
        throw new Error('Cycles in tags are not allowed');
      }
      return advance();
    }
    this.computing = true;
    try {
      return fold();
    } finally {
      this.computing = false;
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
    (tag as unknown as TagImpl).own(advance());
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
    // Read tick so an enclosing subscriber re-runs on every mutation.
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

//////////

// Warm

let tag1 = createUpdatableTag();
let tag2 = createUpdatableTag();
let tag3 = createUpdatableTag();

valueForTag(tag1);
DIRTY_TAG(tag1);
valueForTag(tag1);
UPDATE_TAG(tag1, combine([tag2, tag3]));
valueForTag(tag1);
DIRTY_TAG(tag2);
valueForTag(tag1);
DIRTY_TAG(tag3);
valueForTag(tag1);
UPDATE_TAG(tag1, tag3);
valueForTag(tag1);
DIRTY_TAG(tag3);
valueForTag(tag1);
