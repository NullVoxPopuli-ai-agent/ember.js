import type { SimpleElement, SimpleNode } from '@simple-dom/interface';

import type { Bounds } from '../dom/bounds.js';
import type { Environment } from './environment.js';

export interface ExceptionHandler {
  handleException(): void;
}

export interface RenderResult extends Bounds, ExceptionHandler {
  readonly env: Environment;
  readonly drop: object;

  rerender(options?: { alwaysRevalidate: false }): void;

  parentElement(): SimpleElement;

  firstNode(): SimpleNode;
  lastNode(): SimpleNode;
}

export interface TemplateIterator {
  sync(): RenderResult;
}
