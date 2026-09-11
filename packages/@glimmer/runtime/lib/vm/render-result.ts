import type {
  AppendingBlock,
  Environment,
  RenderResult,
  SimpleElement,
  SimpleNode,
} from '@glimmer/interfaces';
import { associateDestroyableChild, registerDestructor } from '@glimmer/destroyable';
import { DESTROYABLE_META_KEY } from '@glimmer/util/lib/destroyable-key';

import { clear } from '../bounds';
import type { UpdateInstance } from './update';

import { UpdatingVM } from './update';

export default class RenderResultImpl implements RenderResult {
  [DESTROYABLE_META_KEY]: object | undefined;

  constructor(
    public env: Environment,
    private root: UpdateInstance,
    private bounds: AppendingBlock,
    readonly drop: object
  ) {
    associateDestroyableChild(this, drop);
    registerDestructor(this, () => clear(this.bounds));
  }

  rerender({ alwaysRevalidate = false } = { alwaysRevalidate: false }) {
    let { env, root } = this;
    let vm = new UpdatingVM(env, { alwaysRevalidate });
    vm.execute(root);
  }

  parentElement(): SimpleElement {
    return this.bounds.parentElement();
  }

  firstNode(): SimpleNode {
    return this.bounds.firstNode();
  }

  lastNode(): SimpleNode {
    return this.bounds.lastNode();
  }
}
