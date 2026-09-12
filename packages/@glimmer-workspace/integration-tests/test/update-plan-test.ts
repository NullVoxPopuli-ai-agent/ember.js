import type { UpdatePlan } from '@glimmer/interfaces';
import {
  PLAN_BLOCK,
  PLAN_CALL,
  PLAN_GUARD,
  PLAN_GUARD_END,
  PLAN_LEAF,
  PLAN_LIST,
  PLAN_MULTI,
} from '@glimmer/constants';
import { expect, unwrapHandle } from '@glimmer/debug-util';
import { jitSuite, JitRenderDelegate, RenderTest, test } from '@glimmer-workspace/integration-tests';

interface Instance {
  plan: UpdatePlan;
  slots: unknown[];
}

const NAMES = {
  [PLAN_LEAF]: 'leaf',
  [PLAN_MULTI]: 'multi',
  [PLAN_GUARD]: 'guard',
  [PLAN_GUARD_END]: 'guard-end',
  [PLAN_BLOCK]: 'block',
  [PLAN_LIST]: 'list',
  [PLAN_CALL]: 'call',
};

/**
 * A compile-time plan: `block` and `list` show their nested plan, `call`
 * cannot (the callee is only known at runtime).
 */
function describePlan(plan: UpdatePlan): string {
  let parts = plan.kinds.map((kind, i) => {
    let child = plan.children[i];
    return child ? `${NAMES[kind]}${describePlan(child)}` : NAMES[kind];
  });

  return `[${parts.join(' ')}]`;
}

/**
 * A rendered instance: a slot that recorded nothing prints as `-`, a
 * `call` prints the callee instance, a `list` prints one instance per item.
 */
function describeInstance({ plan, slots }: Instance): string {
  let parts = plan.kinds.map((kind, i) => {
    let value = slots[i];

    if (value === undefined) return '-';

    switch (kind) {
      case PLAN_BLOCK:
      case PLAN_CALL:
        return `${NAMES[kind]}${describeInstance(value as Instance)}`;
      case PLAN_LIST: {
        let items = (value as { children: Instance[] }).children;
        return `list{${items.map(describeInstance).join(' ')}}`;
      }
      case PLAN_MULTI:
        return `multi(${(value as unknown[]).length})`;
      default:
        return NAMES[kind];
    }
  });

  return `[${parts.join(' ')}]`;
}

class UpdatePlanTest extends RenderTest {
  static suiteName = 'update plan';

  private planFor(template: string): string {
    let delegate = this.delegate as JitRenderDelegate;
    let handle = unwrapHandle(delegate.compileTemplate(template));

    return describePlan(delegate.context.program.heap.planFor(handle));
  }

  private get instance(): string {
    let result = expect(this.renderResult, 'render first') as unknown as { root: Instance };

    return describeInstance(result.root);
  }

  @test
  'a static template has an empty plan'() {
    this.assert.strictEqual(this.planFor('<div>hello</div>'), '[]');
  }

  @test
  'dynamic attributes and text are leaves and calls'() {
    // `{{this.name}}` calls the stdlib append routine; its switch over the
    // content type lives in the callee's plan.
    this.assert.strictEqual(
      this.planFor('<div class={{this.cls}} title={{this.t}}>{{this.name}}</div>'),
      '[leaf leaf call]'
    );
  }

  @test
  'an if block nests its assertion and body'() {
    this.assert.strictEqual(
      this.planFor('{{#if this.a}}<p>x</p>{{else}}<p>y</p>{{/if}}'),
      '[block[leaf call call]]'
    );
  }

  @test
  'an each block nests a per-item plan'() {
    this.assert.strictEqual(
      this.planFor('{{#each this.items as |item|}}<li>{{item}}</li>{{else}}none{{/each}}'),
      '[block[leaf list[call] call]]'
    );
  }

  @test
  'a component invocation is a guarded call'() {
    this.registerComponent('TemplateOnly', 'Foo', '<p>{{@name}}</p>');

    // A template-only component has no instance to create, so there is no
    // update-hook leaf between the guard and the debug render tree slot.
    this.assert.strictEqual(
      this.planFor('<Foo @name={{this.name}} />'),
      '[guard multi call multi guard-end]'
    );
  }

  @test
  'a rendered instance fills only the slots that recorded something'() {
    this.render('<div class={{this.cls}}>{{this.name}}</div>{{#if this.a}}{{this.b}}{{/if}}', {
      cls: 'x',
      name: 'hello',
      a: true,
      b: 'world',
    });

    // The stdlib append routine has one slot per content-type clause. A string
    // fills the content-type assertion and the text leaf; the other clauses
    // stay empty.
    let append = 'call[block[leaf - - - - - - - - - - - leaf]]';

    // The body of the `if` is an inline block, which is a call of its own.
    this.assert.strictEqual(this.instance, `[leaf ${append} block[leaf call[${append}]]]`);

    this.rerender({ a: false });

    // The re-rendered block keeps its assertion; the body call is untaken.
    this.assert.strictEqual(this.instance, `[leaf ${append} block[leaf -]]`);
  }
}

jitSuite(UpdatePlanTest);
