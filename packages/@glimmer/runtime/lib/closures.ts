import type { DynamicScope, Owner, Reference, Scope } from '@glimmer/interfaces';
import { DEBUG } from '@glimmer/env';
import { getInternalHelperManager } from '@glimmer/manager/lib/internal/api';
import { createComputeRef, createConstRef, valueForRef } from '@glimmer/reference/lib/reference';
import { createConcatRef } from './compiled/expressions/concat';
import { createCapturedArgs } from './vm/arguments';
import { getProp } from '@glimmer/global-context';

/**
 * The runtime side of expressions compiled to closures. A strict template
 * compiles `this.foo`, `(helper 1)`, and friends to small functions that
 * call these helpers with the current frame, so the VM needs no opcodes
 * for property reads, helper calls, or scope lookups.
 */
export interface Context {
  scope: Scope;
  owner: Owner;
  dynamicScope: DynamicScope;
}

/** The reference behind symbol `index`; 0 is `this`. */
export function symbol(c: Context, index: number): Reference {
  return index === 0 ? c.scope.getSelf() : c.scope.getSymbol(index);
}

/** The current value of symbol `index`; 0 is `this`. */
export function v(c: Context, index: number): unknown {
  return valueForRef(symbol(c, index));
}

/** A tracked property read, through the same global hook the VM uses. */
export function path(obj: unknown, ...keys: string[]): unknown {
  for (let key of keys) {
    if (obj === null || obj === undefined) return undefined;
    obj = getProp(obj, key);
  }

  return obj;
}

export function ref(compute: () => unknown): Reference {
  return createComputeRef(compute);
}

/** A module binding, such as an imported component or helper. */
export function constant(value: unknown, label: string): Reference {
  return createConstRef(value, DEBUG ? label : false);
}

/** An argument: a lazily read value, or a reference from a nested call. */
export type Arg = (() => unknown) | Reference;

function argRef(arg: Arg): Reference {
  return typeof arg === 'function' ? createComputeRef(arg) : arg;
}

/** Invokes a helper definition once and returns its reference. */
export function helper(
  c: Context,
  definition: object,
  positional: Arg[],
  named: Record<string, Arg>
): Reference {
  let namedRefs: Record<string, Reference> = {};

  for (let key in named) {
    namedRefs[key] = argRef(named[key] as Arg);
  }

  let args = createCapturedArgs(namedRefs, positional.map(argRef));
  let managerOrHelper = getInternalHelperManager(definition, true);

  if (managerOrHelper === null) {
    throw new Error(`Attempted to invoke a value as a helper, but it has no helper manager`);
  }

  let invoke =
    typeof managerOrHelper === 'function' ? managerOrHelper : managerOrHelper.getHelper(definition);

  return invoke(args, c.owner, c.dynamicScope);
}

export function concat(parts: Arg[]): Reference {
  return createConcatRef(parts.map(argRef));
}
