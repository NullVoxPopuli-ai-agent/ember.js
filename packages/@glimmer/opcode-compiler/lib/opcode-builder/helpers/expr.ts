import type { WireFormat } from '@glimmer/interfaces';
import { PRIMITIVE_REFERENCE_OP } from '@glimmer/runtime/lib/compiled/opcodes/vm';

import type { PushExpressionOp, PushStatementOp } from '../../syntax/compilers';

import { compileSexp } from '../../syntax/compilers';
import { PushPrimitive } from './vm';

export type ExpressionOverride = (
  op: PushExpressionOp,
  expression: WireFormat.TupleExpression
) => boolean;

let override: ExpressionOverride | null = null;

/**
 * Lets a compiler handle expressions itself. The override returns `false`
 * to fall back to the opcode compilers for that expression.
 */
export function withExpressionOverride<T>(fn: ExpressionOverride, block: () => T): T {
  let previous = override;
  override = fn;

  try {
    return block();
  } finally {
    override = previous;
  }
}

export function expr(op: PushExpressionOp, expression: WireFormat.Expression): void {
  if (Array.isArray(expression)) {
    if (override !== null && override(op, expression)) {
      return;
    }

    compileSexp(op as PushStatementOp, expression);
  } else {
    PushPrimitive(op, expression);
    op(PRIMITIVE_REFERENCE_OP);
  }
}
