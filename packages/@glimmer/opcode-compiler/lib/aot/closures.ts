import type { BlockMetadata, WireFormat } from '@glimmer/interfaces';
import { opcodes as Op } from '@glimmer/wire-format/lib/opcodes';

export const CLOSURES_MODULE = '@glimmer/runtime/lib/closures';

export interface JsImport {
  local: string;
  module: string;
  name: string;
}

/** Placeholder local names; the printer binds them to real imports. */
const LOCAL = {
  symbol: '__x_symbol',
  v: '__x_v',
  path: '__x_path',
  ref: '__x_ref',
  constant: '__x_constant',
  helper: '__x_helper',
  concat: '__x_concat',
};

export function closureImports(source: string): JsImport[] {
  let imports: JsImport[] = [];

  for (const [name, local] of Object.entries(LOCAL)) {
    if (source.includes(local)) {
      imports.push({ local, module: CLOSURES_MODULE, name });
    }
  }

  return imports;
}

function lit(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function keys(path: string[] | undefined): string {
  return path === undefined || path.length === 0 ? '' : ',' + path.map(lit).join(',');
}

/**
 * Prints a strict mode expression as a closure that builds its reference
 * from the current frame, or returns `null` when the expression still
 * needs the VM's expression opcodes.
 */
export function closureSource(
  expression: WireFormat.Expression,
  meta: BlockMetadata
): string | null {
  let body = refSource(expression, meta);
  return body === null ? null : `(c)=>${body}`;
}

function lexicalName(index: number, meta: BlockMetadata): string | null {
  return meta.symbols.lexical?.[index] ?? null;
}

/** A value expression, read eagerly inside a tracking frame. */
function valueSource(expression: WireFormat.Expression, meta: BlockMetadata): string | null {
  if (!Array.isArray(expression)) return lit(expression);

  switch (expression[0]) {
    case Op.Undefined:
      return 'undefined';
    case Op.GetSymbol: {
      let [, symbol, path] = expression;
      let value = `${LOCAL.v}(c,${symbol})`;
      return path === undefined || path.length === 0
        ? value
        : `${LOCAL.path}(${value}${keys(path)})`;
    }
    case Op.GetLexicalSymbol: {
      let [, index, path] = expression;
      let name = lexicalName(index, meta);
      if (name === null) return null;
      return path === undefined || path.length === 0 ? name : `${LOCAL.path}(${name}${keys(path)})`;
    }
    default:
      return null;
  }
}

/** A Reference-producing expression. */
function refSource(expression: WireFormat.Expression, meta: BlockMetadata): string | null {
  if (!Array.isArray(expression)) return null;

  switch (expression[0]) {
    case Op.GetSymbol: {
      let [, symbol, path] = expression;
      if (path === undefined || path.length === 0) return `${LOCAL.symbol}(c,${symbol})`;
      return `${LOCAL.ref}(()=>${valueSource(expression, meta)})`;
    }
    case Op.GetLexicalSymbol: {
      let [, index, path] = expression;
      let name = lexicalName(index, meta);
      if (name === null) return null;
      if (path === undefined || path.length === 0) return `${LOCAL.constant}(${name},${lit(name)})`;
      return `${LOCAL.ref}(()=>${valueSource(expression, meta)})`;
    }
    case Op.Call: {
      let [, callee, positional, named] = expression;
      let calleeSource = valueSource(callee, meta);
      if (calleeSource === null || calleeSource === 'undefined') return null;
      let args = argsSource(positional, named, meta);
      if (args === null) return null;
      return `${LOCAL.helper}(c,${calleeSource},${args})`;
    }
    case Op.Concat: {
      let [, parts] = expression;
      let entries = parts.map((part) => argSource(part, meta));
      if (entries.some((entry) => entry === null)) return null;
      return `${LOCAL.concat}([${entries.join(',')}])`;
    }
    default:
      return null;
  }
}

/** An argument: a thunk for a value, or a reference for a nested call. */
function argSource(expression: WireFormat.Expression, meta: BlockMetadata): string | null {
  if (!Array.isArray(expression)) return `()=>${lit(expression)}`;

  switch (expression[0]) {
    case Op.Undefined:
    case Op.GetSymbol:
    case Op.GetLexicalSymbol: {
      let value = valueSource(expression, meta);
      return value === null ? null : `()=>${value}`;
    }
    case Op.Call:
    case Op.Concat:
      return refSource(expression, meta);
    default:
      return null;
  }
}

function argsSource(
  positional: WireFormat.Core.Params,
  named: WireFormat.Core.Hash,
  meta: BlockMetadata
): string | null {
  let entries: string[] = [];

  for (const param of positional ?? []) {
    let source = argSource(param, meta);
    if (source === null) return null;
    entries.push(source);
  }

  let pairs: string[] = [];

  if (named !== null) {
    let [names, values] = named;

    for (let i = 0; i < names.length; i++) {
      let source = argSource(values[i], meta);
      if (source === null) return null;
      pairs.push(`${lit(names[i])}:${source}`);
    }
  }

  return `[${entries.join(',')}],{${pairs.join(',')}}`;
}
