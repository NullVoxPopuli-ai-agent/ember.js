declare const TYPE: unique symbol;
export type TagTypeSymbol = typeof TYPE;

declare const COMPUTE: unique symbol;
export type TagComputeSymbol = typeof COMPUTE;

export type DIRTYABLE_TAG_ID = 0;
export type UPDATABLE_TAG_ID = 1;
export type COMBINATOR_TAG_ID = 2;
export type CONSTANT_TAG_ID = 3;

export type MonomorphicTagId =
  | DIRTYABLE_TAG_ID
  | UPDATABLE_TAG_ID
  | COMBINATOR_TAG_ID
  | CONSTANT_TAG_ID;

export type VOLATILE_TAG_ID = 100;
export type CURRENT_TAG_ID = 101;

export type PolymorphicTagId = VOLATILE_TAG_ID | CURRENT_TAG_ID;

export type TagId = MonomorphicTagId | PolymorphicTagId;

export type Revision = number;

// A Tag is a callable: it returns the current revision and, when called
// inside an alien-signals subscriber, registers a dependency. The [COMPUTE]
// alias is kept only because a few places still write `tag[COMPUTE]()`.
export interface Tag {
  (): Revision;
  readonly [COMPUTE]?: () => Revision;
  readonly subtag?: Tag | Tag[] | null | undefined;
}

export type MonomorphicTag = Tag;
export type UpdatableTag = Tag;
export type DirtyableTag = Tag;
export type ConstantTag = Tag;
export type CombinatorTag = Tag;
