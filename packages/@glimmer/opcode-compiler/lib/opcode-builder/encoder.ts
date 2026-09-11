import { DEBUG } from '@glimmer/env';
import type {
  BlockMetadata,
  BuilderOp,
  BuilderOpcode,
  CompileTimeConstants,
  Dict,
  Encoder,
  EncoderError,
  EvaluationContext,
  HandleResult,
  HighLevelOp,
  InstructionEncoder,
  Operand,
  ProgramHeap,
  SingleBuilderOperand,
  STDLib,
  UpdatePlan,
  UpdatePlanKind,
} from '@glimmer/interfaces';
import { encodeHandle } from '@glimmer/constants/lib/immediate';
import {
  isMachineOp,
  VM_INVOKE_STATIC_OP,
  VM_INVOKE_VIRTUAL_OP,
  VM_RETURN_OP,
} from '@glimmer/constants/lib/vm-ops';
import {
  VM_APPEND_TEXT_OP,
  VM_ASSERT_SAME_OP,
  VM_BEGIN_COMPONENT_TRANSACTION_OP,
  VM_COMMIT_COMPONENT_TRANSACTION_OP,
  VM_CONTENT_TYPE_OP,
  VM_CREATE_COMPONENT_OP,
  VM_DID_RENDER_LAYOUT_OP,
  VM_DYNAMIC_ATTR_OP,
  VM_DYNAMIC_CONTENT_TYPE_OP,
  VM_DYNAMIC_MODIFIER_OP,
  VM_ENTER_LIST_OP,
  VM_ENTER_OP,
  VM_EXIT_LIST_OP,
  VM_EXIT_OP,
  VM_FLUSH_ELEMENT_OP,
  VM_GET_COMPONENT_SELF_OP,
  VM_INVOKE_COMPONENT_LAYOUT_OP,
  VM_INVOKE_YIELD_OP,
  VM_ITERATE_OP,
  VM_JUMP_UNLESS_OP,
  VM_MODIFIER_OP,
  VM_PRIMITIVE_OP,
  VM_PUSH_REMOTE_ELEMENT_OP,
  VM_PUT_COMPONENT_OPERATIONS_OP,
} from '@glimmer/constants/lib/syscall-ops';
import {
  PLAN_BLOCK,
  PLAN_CALL,
  PLAN_GUARD,
  PLAN_GUARD_END,
  PLAN_LEAF,
  PLAN_LIST,
  PLAN_MULTI,
} from '@glimmer/constants/lib/update-plan';
import { expect } from '@glimmer/debug-util/lib/platform-utils';
import { isPresentArray } from '@glimmer/debug-util/lib/present';
import assert from '@glimmer/debug-util/lib/assert';
import { InstructionEncoderImpl } from '@glimmer/encoder/lib/encoder';
import { dict, StackImpl as Stack } from '@glimmer/util/lib/collections';
import { ARG_SHIFT, MACHINE_MASK, TYPE_SIZE } from '@glimmer/vm/lib/flags';

import { compilableBlock } from '../compilable-template';
import {
  resolveComponent,
  resolveComponentOrHelper,
  resolveHelper,
  resolveModifier,
  resolveOptionalComponentOrHelper,
} from './helpers/resolution';
import { HighLevelBuilderOpcodes, HighLevelResolutionOpcodes } from './opcodes';
import { HighLevelOperands } from './operands';

export class Labels {
  labels: Dict<number> = dict();
  targets: Array<{ at: number; target: string }> = [];

  label(name: string, index: number) {
    this.labels[name] = index;
  }

  target(at: number, target: string) {
    this.targets.push({ at, target });
  }

  patch(heap: ProgramHeap): void {
    let { targets, labels } = this;

    for (const { at, target } of targets) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
      let address = labels[target]! - at;

      assert(heap.getbyaddr(at) === -1, 'Expected heap to contain a placeholder, but it did not');

      heap.setbyaddr(at, address);
    }
  }
}

export function encodeOp(
  encoder: Encoder,
  context: EvaluationContext,
  meta: BlockMetadata,
  op: BuilderOp | HighLevelOp
): void {
  let {
    program: { constants },
    resolver,
  } = context;

  if (isBuilderOpcode(op[0])) {
    let [type, ...operands] = op;
    encoder.push(constants, type, ...(operands as SingleBuilderOperand[]));
  } else {
    switch (op[0]) {
      case HighLevelBuilderOpcodes.Label:
        return encoder.label(op[1]);
      case HighLevelBuilderOpcodes.StartLabels:
        return encoder.startLabels();
      case HighLevelBuilderOpcodes.StopLabels:
        return encoder.stopLabels();
      case HighLevelBuilderOpcodes.EndItem:
        return encoder.endItem();
      case HighLevelResolutionOpcodes.Component:
        return resolveComponent(resolver, constants, meta, op);
      case HighLevelResolutionOpcodes.Modifier:
        return resolveModifier(resolver, constants, meta, op);
      case HighLevelResolutionOpcodes.Helper:
        return resolveHelper(resolver, constants, meta, op);
      case HighLevelResolutionOpcodes.ComponentOrHelper:
        return resolveComponentOrHelper(resolver, constants, meta, op);
      case HighLevelResolutionOpcodes.OptionalComponentOrHelper:
        return resolveOptionalComponentOrHelper(resolver, constants, meta, op);

      case HighLevelResolutionOpcodes.Local: {
        let [, freeVar, andThen] = op;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- @fixme
        let name = expect(
          meta.symbols.upvars,
          'BUG: attempted to resolve value but no upvars found'
        )[freeVar]!;

        andThen(name, meta.moduleName);

        break;
      }

      case HighLevelResolutionOpcodes.TemplateLocal: {
        let [, valueIndex, then] = op;
        let value = expect(
          meta.scopeValues,
          'BUG: Attempted to get a template local, but template does not have any'
        )[valueIndex];

        then(constants.value(value));

        break;
      }

      default:
        throw new Error(`Unexpected high level opcode ${op[0]}`);
    }
  }
}

class UpdatePlanImpl implements UpdatePlan {
  readonly kinds: UpdatePlanKind[] = [];
  readonly children: (UpdatePlan | null)[] = [];
  readonly links: number[] = [];
  size = 0;

  add(kind: UpdatePlanKind, child: UpdatePlan | null = null, link = -1): number {
    this.kinds.push(kind);
    this.children.push(child);
    this.links.push(link);
    return this.size++;
  }
}

/**
 * Derives the update plan of a compilation unit from the instructions the
 * encoder emits. Every instruction whose handler can record an updating opcode
 * gets a slot; block, list, and call instructions open nested plans that the
 * append VM mirrors with its updating stack.
 */
class PlanBuilder {
  readonly root = new UpdatePlanImpl();
  private readonly regions = new Stack<UpdatePlanImpl>();
  private readonly items = new Stack<UpdatePlanImpl>();
  private readonly guards: number[] = [];
  private componentOperations = false;

  constructor() {
    this.regions.push(this.root);
  }

  private get current(): UpdatePlanImpl {
    return expect(this.regions.current, 'bug: update plan region stack is empty');
  }

  visit(heap: ProgramHeap, type: number, address: number): void {
    switch (type) {
      case VM_JUMP_UNLESS_OP:
      case VM_ASSERT_SAME_OP:
      case VM_CONTENT_TYPE_OP:
      case VM_DYNAMIC_CONTENT_TYPE_OP:
      case VM_APPEND_TEXT_OP:
      case VM_DYNAMIC_ATTR_OP:
      case VM_CREATE_COMPONENT_OP:
        heap.setSlotAt(address, this.current.add(PLAN_LEAF));
        return;

      case VM_PUSH_REMOTE_ELEMENT_OP:
      case VM_MODIFIER_OP:
      case VM_DYNAMIC_MODIFIER_OP:
      case VM_GET_COMPONENT_SELF_OP:
      case VM_DID_RENDER_LAYOUT_OP:
        heap.setSlotAt(address, this.current.add(PLAN_MULTI));
        return;

      case VM_PUT_COMPONENT_OPERATIONS_OP:
        this.componentOperations = true;
        return;

      case VM_FLUSH_ELEMENT_OP:
        if (this.componentOperations) {
          this.componentOperations = false;
          heap.setSlotAt(address, this.current.add(PLAN_MULTI));
        }
        return;

      case VM_INVOKE_STATIC_OP:
      case VM_INVOKE_VIRTUAL_OP:
      case VM_INVOKE_YIELD_OP:
      case VM_INVOKE_COMPONENT_LAYOUT_OP:
        heap.setSlotAt(address, this.current.add(PLAN_CALL));
        return;

      case VM_BEGIN_COMPONENT_TRANSACTION_OP: {
        let index = this.current.add(PLAN_GUARD);
        heap.setSlotAt(address, index);
        this.guards.push(index);
        return;
      }

      case VM_COMMIT_COMPONENT_TRANSACTION_OP: {
        let begin = expect(this.guards.pop(), 'bug: commit without begin component transaction');
        let plan = this.current;
        let end = plan.add(PLAN_GUARD_END, null, begin);
        plan.links[begin] = end;
        heap.setSlotAt(address, end);
        return;
      }

      case VM_ENTER_OP: {
        let child = new UpdatePlanImpl();
        heap.setSlotAt(address, this.current.add(PLAN_BLOCK, child));
        this.regions.push(child);
        return;
      }

      case VM_EXIT_OP:
        this.regions.pop();
        return;

      case VM_ENTER_LIST_OP: {
        let item = new UpdatePlanImpl();
        let plan = this.current;
        heap.setSlotAt(address, plan.add(PLAN_LEAF));
        plan.add(PLAN_LIST, item);
        this.items.push(item);
        return;
      }

      case VM_ITERATE_OP:
        this.regions.push(expect(this.items.current, 'bug: iterate outside of a list'));
        return;

      case VM_EXIT_LIST_OP:
        this.items.pop();
        return;
    }
  }

  endItem(): void {
    this.regions.pop();
  }

  finish(): UpdatePlan {
    assert(this.regions.current === this.root, 'bug: unbalanced update plan regions');
    assert(this.guards.length === 0, 'bug: unbalanced component transactions');
    return this.root;
  }
}

export class EncoderImpl implements Encoder {
  private labelsStack = new Stack<Labels>();
  private encoder: InstructionEncoder = new InstructionEncoderImpl([]);
  private errors: EncoderError[] = [];
  private handle: number;
  private plan = new PlanBuilder();

  constructor(
    private heap: ProgramHeap,
    private meta: BlockMetadata,
    private stdlib?: STDLib
  ) {
    this.handle = heap.malloc();
  }

  endItem(): void {
    this.plan.endItem();
  }

  error(error: EncoderError): void {
    this.encoder.encode(VM_PRIMITIVE_OP, 0);
    this.errors.push(error);
  }

  commit(size: number): HandleResult {
    let handle = this.handle;

    this.heap.pushMachine(VM_RETURN_OP);
    this.heap.finishMalloc(handle, size);
    this.heap.setPlan(handle, this.plan.finish());

    if (isPresentArray(this.errors)) {
      return { errors: this.errors, handle };
    } else {
      return handle;
    }
  }

  push(
    constants: CompileTimeConstants,
    type: BuilderOpcode,
    ...args: SingleBuilderOperand[]
  ): void {
    let { heap } = this;

    if (DEBUG && (type as number) > TYPE_SIZE) {
      throw new Error(`Opcode type over 8-bits. Got ${type}.`);
    }

    let machine = isMachineOp(type) ? MACHINE_MASK : 0;
    let first = type | machine | (args.length << ARG_SHIFT);

    this.plan.visit(heap, type, heap.offset);
    heap.pushRaw(first);

    for (let i = 0; i < args.length; i++) {
      let op = args[i];
      heap.pushRaw(this.operand(constants, op));
    }
  }

  private operand(constants: CompileTimeConstants, operand: SingleBuilderOperand): Operand {
    if (typeof operand === 'number') {
      return operand;
    }

    if (typeof operand === 'object' && operand !== null) {
      if (Array.isArray(operand)) {
        return encodeHandle(constants.array(operand));
      } else {
        switch (operand.type) {
          case HighLevelOperands.Label:
            this.currentLabels.target(this.heap.offset, operand.value);
            return -1;

          case HighLevelOperands.IsStrictMode:
            return encodeHandle(constants.value(this.meta.isStrictMode));

          case HighLevelOperands.DebugSymbols:
            return encodeHandle(constants.value(operand.value));

          case HighLevelOperands.Block:
            return encodeHandle(constants.value(compilableBlock(operand.value, this.meta)));

          case HighLevelOperands.StdLib:
            return expect(
              this.stdlib,
              'attempted to encode a stdlib operand, but the encoder did not have a stdlib. Are you currently building the stdlib?'
            )[operand.value];

          case HighLevelOperands.NonSmallInt:
          case HighLevelOperands.SymbolTable:
          case HighLevelOperands.Layout:
            return constants.value(operand.value);
        }
      }
    }

    return encodeHandle(constants.value(operand));
  }

  private get currentLabels(): Labels {
    return expect(this.labelsStack.current, 'bug: not in a label stack');
  }

  label(name: string) {
    this.currentLabels.label(name, this.heap.offset + 1);
  }

  startLabels() {
    this.labelsStack.push(new Labels());
  }

  stopLabels() {
    let label = expect(this.labelsStack.pop(), 'unbalanced push and pop labels');
    label.patch(this.heap);
  }
}

function isBuilderOpcode(op: number): op is BuilderOpcode {
  return op < HighLevelBuilderOpcodes.Start;
}
