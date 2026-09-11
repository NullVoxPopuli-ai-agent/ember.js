import { DEBUG } from '@glimmer/env';
import type {
  AppendingBlock,
  Bounds,
  Environment,
  EvaluationContext,
  GlimmerTreeChanges,
  ResettableBlock,
  SimpleComment,
  UpdatePlan,
  UpdatingOpcode,
  UpdatingVM as IUpdatingVM,
} from '@glimmer/interfaces';
import type { OpaqueIterationItem, OpaqueIterator } from '@glimmer/reference/lib/iterable';
import type { Reference } from '@glimmer/reference/lib/reference';
import {
  PLAN_BLOCK,
  PLAN_CALL,
  PLAN_GUARD,
  PLAN_GUARD_END,
  PLAN_LEAF,
  PLAN_LIST,
  PLAN_MULTI,
} from '@glimmer/constants/lib/update-plan';
import { expect, unwrap } from '@glimmer/debug-util/lib/platform-utils';
import { associateDestroyableChild, destroy, destroyChildren } from '@glimmer/destroyable';
import { DESTROYABLE_META_KEY } from '@glimmer/util/lib/destroyable-key';
import { LOCAL_DEBUG } from '@glimmer/local-debug-flags';
import { updateRef, valueForRef } from '@glimmer/reference/lib/reference';
import { logStep } from '@glimmer/util/lib/debug-steps';
import { debug } from '@glimmer/validator/lib/debug';
import {
  beginTrackFrame,
  consumeTag,
  endTrackFrame,
  resetTracking,
} from '@glimmer/validator/lib/tracking';
import { validateTag } from '@glimmer/validator/lib/validators';

import type { Closure } from './append';
import type { AppendingBlockList } from './element-builder';
import type { Guard } from '../compiled/opcodes/vm';

import { clear, move as moveBounds } from '../bounds';
import { NewTreeBuilder } from './element-builder';

/**
 * One render of a compilation unit or block: the static plan plus the values
 * the append pass recorded into its slots. A slot is `undefined` when the
 * instruction ran but recorded nothing (a constant reference, an untaken
 * branch, a debug-only opcode in production).
 */
export interface UpdateInstance {
  readonly plan: UpdatePlan;
  slots: unknown[];
}

export const EMPTY_PLAN: UpdatePlan = { kinds: [], children: [], links: [], size: 0 };

export function createInstance(plan: UpdatePlan): UpdateInstance {
  return { plan, slots: plan.size === 0 ? [] : new Array<unknown>(plan.size) };
}

export class UpdatingVM implements IUpdatingVM {
  public env: Environment;
  public dom: GlimmerTreeChanges;
  public alwaysRevalidate: boolean;
  public thrown = false;

  constructor(env: Environment, { alwaysRevalidate = false }) {
    this.env = env;
    this.dom = env.getDOM();
    this.alwaysRevalidate = alwaysRevalidate;
  }

  execute(root: UpdateInstance) {
    if (DEBUG) {
      let hasErrored = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
        debug.runInTrackingTransaction!(
          () => walk(this, root.plan, root.slots),
          '- While rendering:'
        );

        // using a boolean here to avoid breaking ergonomics of "pause on uncaught exceptions"
        // which would happen with a `catch` + `throw`
        hasErrored = false;
      } finally {
        if (hasErrored) {
          // eslint-disable-next-line no-console
          console.error(`\n\nError occurred:\n\n${resetTracking()}\n\n`);
        }
      }
    } else {
      walk(this, root.plan, root.slots);
    }
  }

  throw() {
    this.thrown = true;
  }
}

/**
 * Run the updating pass for one instance. Returns early with `vm.thrown` set
 * when an assertion failed; the nearest enclosing block re-renders itself.
 */
export function walk(vm: UpdatingVM, plan: UpdatePlan, slots: unknown[]): void {
  let { kinds, links } = plan;
  let openFrames = 0;

  for (let i = 0; i < kinds.length; i++) {
    let value = slots[i];

    if (value === undefined) continue;

    switch (kinds[i]) {
      case PLAN_LEAF:
        (value as UpdatingOpcode).evaluate(vm);
        break;

      case PLAN_MULTI: {
        let opcodes = value as UpdatingOpcode[];
        for (let j = 0; j < opcodes.length && !vm.thrown; j++) {
          unwrap(opcodes[j]).evaluate(vm);
        }
        break;
      }

      case PLAN_GUARD: {
        let guard = value as Guard;

        if (!vm.alwaysRevalidate && validateTag(guard.tag, guard.lastRevision)) {
          consumeTag(guard.tag);
          i = unwrap(links[i]);
        } else {
          beginTrackFrame(guard.debugLabel);
          openFrames++;
        }
        break;
      }

      case PLAN_GUARD_END:
        openFrames--;
        (value as Guard).didModify(endTrackFrame());
        break;

      case PLAN_BLOCK: {
        let block = value as TryOpcode;
        walk(vm, block.plan, block.slots);

        if (vm.thrown) {
          vm.thrown = false;
          block.handleException();
        }
        break;
      }

      case PLAN_LIST:
        (value as ListBlockOpcode).update(vm);
        break;

      case PLAN_CALL: {
        let callee = value as UpdateInstance;
        walk(vm, callee.plan, callee.slots);
        break;
      }
    }

    if (vm.thrown) {
      // Close the tracking frames this walk opened. The guards keep their
      // previous tag and revalidate on the next update.
      while (openFrames-- > 0) endTrackFrame();
      return;
    }
  }
}

export abstract class BlockOpcode implements UpdateInstance, Bounds {
  [DESTROYABLE_META_KEY]: object | undefined;

  public slots: unknown[];

  protected readonly bounds: AppendingBlock;

  constructor(
    protected state: Closure,
    protected context: EvaluationContext,
    bounds: AppendingBlock,
    public readonly plan: UpdatePlan
  ) {
    this.bounds = bounds;
    this.slots = plan.size === 0 ? [] : new Array<unknown>(plan.size);
  }

  parentElement() {
    return this.bounds.parentElement();
  }

  firstNode() {
    return this.bounds.firstNode();
  }

  lastNode() {
    return this.bounds.lastNode();
  }
}

export class TryOpcode extends BlockOpcode {
  public type = 'try';

  declare protected bounds: ResettableBlock; // Shadows property on base class

  handleException() {
    let {
      state,
      bounds,
      context: { env },
    } = this;

    destroyChildren(this);

    let tree = NewTreeBuilder.resume(env, bounds);
    this.slots = this.plan.size === 0 ? [] : new Array<unknown>(this.plan.size);
    let vm = state.evaluate(tree);

    // The block's own `Exit` pops it again, the same way the initial render did.
    let result = vm.execute((vm) => vm.pushInstance(this));

    associateDestroyableChild(this, result.drop);
  }
}

export class ListItemOpcode extends TryOpcode {
  public retained = false;
  public index = -1;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: ResettableBlock,
    plan: UpdatePlan,
    public key: unknown,
    public memo: Reference,
    public value: Reference
  ) {
    super(state, context, bounds, plan);
  }

  shouldRemove(): boolean {
    return !this.retained;
  }

  reset() {
    this.retained = false;
  }
}

export class ListBlockOpcode extends BlockOpcode {
  public type = 'list-block';
  public children: ListItemOpcode[];

  private opcodeMap = new Map<unknown, ListItemOpcode>();
  private marker: SimpleComment | null = null;
  private lastIterator: OpaqueIterator;

  declare protected readonly bounds: AppendingBlockList;

  constructor(
    state: Closure,
    context: EvaluationContext,
    bounds: AppendingBlockList,
    children: ListItemOpcode[],
    public readonly itemPlan: UpdatePlan,
    private iterableRef: Reference<OpaqueIterator>
  ) {
    super(state, context, bounds, EMPTY_PLAN);
    this.children = children;
    this.lastIterator = valueForRef(iterableRef);
  }

  initializeChild(opcode: ListItemOpcode) {
    opcode.index = this.children.length - 1;
    this.opcodeMap.set(opcode.key, opcode);
  }

  update(vm: UpdatingVM) {
    let iterator = valueForRef(this.iterableRef);

    if (this.lastIterator !== iterator) {
      let { bounds } = this;
      let { dom } = vm;

      let marker = (this.marker = dom.createComment(''));
      dom.insertAfter(
        bounds.parentElement(),
        marker,
        expect(bounds.lastNode(), "can't insert after an empty bounds")
      );

      this.sync(iterator);

      this.parentElement().removeChild(marker);
      this.marker = null;
      this.lastIterator = iterator;
    }

    let { children } = this;

    for (let i = 0; i < children.length; i++) {
      let item = unwrap(children[i]);
      walk(vm, item.plan, item.slots);

      if (vm.thrown) {
        vm.thrown = false;
        item.handleException();
      }
    }
  }

  private sync(iterator: OpaqueIterator) {
    let { opcodeMap: itemMap, children } = this;

    let currentOpcodeIndex = 0;
    let seenIndex = 0;

    this.children = this.bounds.boundList = [];

    while (true) {
      let item = iterator.next();

      if (item === null) break;

      let opcode = children[currentOpcodeIndex];
      let { key } = item;

      // Items that have already been found and moved will already be retained,
      // we can continue until we find the next unretained item
      while (opcode !== undefined && opcode.retained) {
        opcode = children[++currentOpcodeIndex];
      }

      if (opcode !== undefined && opcode.key === key) {
        this.retainItem(opcode, item);
        currentOpcodeIndex++;
      } else if (itemMap.has(key)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
        let itemOpcode = itemMap.get(key)!;

        // The item opcode was seen already, so we should move it.
        if (itemOpcode.index < seenIndex) {
          this.moveItem(itemOpcode, item, opcode);
        } else {
          // Update the seen index, we are going to be moving this item around
          // so any other items that come before it will likely need to move as
          // well.
          seenIndex = itemOpcode.index;

          let seenUnretained = false;

          // iterate through all of the opcodes between the current position and
          // the position of the item's opcode, and determine if they are all
          // retained.
          for (let i = currentOpcodeIndex + 1; i < seenIndex; i++) {
            if (!unwrap(children[i]).retained) {
              seenUnretained = true;
              break;
            }
          }

          // If we have seen only retained opcodes between this and the matching
          // opcode, it means that all the opcodes in between have been moved
          // already, and we can safely retain this item's opcode.
          if (!seenUnretained) {
            this.retainItem(itemOpcode, item);
            currentOpcodeIndex = seenIndex + 1;
          } else {
            this.moveItem(itemOpcode, item, opcode);
            currentOpcodeIndex++;
          }
        }
      } else {
        this.insertItem(item, opcode);
      }
    }

    for (const opcode of children) {
      if (!opcode.retained) {
        this.deleteItem(opcode);
      } else {
        opcode.reset();
      }
    }
  }

  private retainItem(opcode: ListItemOpcode, item: OpaqueIterationItem) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['retain', item.key]);
    }

    let { children } = this;

    updateRef(opcode.memo, item.memo);
    updateRef(opcode.value, item.value);
    opcode.retained = true;

    opcode.index = children.length;
    children.push(opcode);
  }

  private insertItem(item: OpaqueIterationItem, before: ListItemOpcode | undefined) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['insert', item.key]);
    }

    let {
      opcodeMap,
      bounds,
      state,
      children,
      context: { env },
    } = this;
    let { key } = item;
    let nextSibling = before === undefined ? this.marker : before.firstNode();

    let elementStack = NewTreeBuilder.forInitialRender(env, {
      element: bounds.parentElement(),
      nextSibling,
    });

    let vm = state.evaluate(elementStack, this);

    vm.execute((vm) => {
      let opcode = vm.enterItem(item);

      opcode.index = children.length;
      children.push(opcode);
      opcodeMap.set(key, opcode);
      associateDestroyableChild(this, opcode);
    });
  }

  private moveItem(
    opcode: ListItemOpcode,
    item: OpaqueIterationItem,
    before: ListItemOpcode | undefined
  ) {
    let { children } = this;

    updateRef(opcode.memo, item.memo);
    updateRef(opcode.value, item.value);
    opcode.retained = true;

    let currentSibling, nextSibling;

    if (before === undefined) {
      moveBounds(opcode, this.marker);
    } else {
      currentSibling = opcode.lastNode().nextSibling;
      nextSibling = before.firstNode();

      // Items are moved throughout the algorithm, so there are cases where the
      // the items already happen to be siblings (e.g. an item in between was
      // moved before this move happened). Check to see if they are siblings
      // first before doing the move.
      if (currentSibling !== nextSibling) {
        moveBounds(opcode, nextSibling);
      }
    }

    opcode.index = children.length;
    children.push(opcode);

    if (LOCAL_DEBUG) {
      let type = currentSibling && currentSibling === nextSibling ? 'move-retain' : 'move';
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', [type, item.key]);
    }
  }

  private deleteItem(opcode: ListItemOpcode) {
    if (LOCAL_DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      logStep!('list-updates', ['delete', opcode.key]);
    }

    destroy(opcode);
    clear(opcode);
    this.opcodeMap.delete(opcode.key);
  }
}
