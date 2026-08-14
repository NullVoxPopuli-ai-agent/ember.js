/**
 * SPIKE (runloop removal): the minimal scheduling vocabulary the
 * framework actually needed from the runloop, rebuilt on microtasks.
 * Rendering no longer flushes at runloop end, so "later in this loop"
 * semantics collapse to "on a microtask" -- batched behind the current
 * task's synchronous work, ahead of the scheduler's next tick.
 */

const SCHEDULED_METHODS = new WeakMap<object, Set<PropertyKey>>();

/**
 * Work scheduled here used to sit on a runloop queue, and an exception
 * from a queued item was the runloop's to route -- it reached
 * `Ember.onerror`, or the promise whose flush was running. A bare
 * `queueMicrotask` has no such path: a throw becomes an unhandled global
 * error, invisible to whoever scheduled the work. The work deferred here
 * renders synchronously (`_setOutlets` appends the top-level view), so
 * the layer that owns rendering installs the handler.
 */
let onError: ((error: unknown) => void) | null = null;

export function _setMicrotaskErrorHandler(handler: (error: unknown) => void): void {
  onError = handler;
}

function invoke(fn: () => void): void {
  if (onError === null) {
    fn();
    return;
  }

  try {
    fn();
  } catch (error) {
    onError(error);
  }
}

/**
 * `once(target, method)` replacement: coalesces repeat requests for the
 * same (target, method) until the scheduled microtask runs.
 */
export function scheduleMethodOnce(target: object, method: PropertyKey): void {
  let methods = SCHEDULED_METHODS.get(target);

  if (methods === undefined) {
    methods = new Set();
    SCHEDULED_METHODS.set(target, methods);
  }

  if (methods.has(method)) return;

  methods.add(method);

  queueMicrotask(() => {
    methods.delete(method);
    invoke(() =>
      (target as Record<PropertyKey, unknown> & Record<PropertyKey, () => void>)[method]()
    );
  });
}

export interface CancelableMicrotask {
  cancelled: boolean;
}

/**
 * `scheduleOnce` + `cancel` replacement for one-shot deferred work.
 */
export function scheduleCancelableMicrotask(fn: () => void): CancelableMicrotask {
  const token: CancelableMicrotask = { cancelled: false };

  queueMicrotask(() => {
    if (!token.cancelled) {
      invoke(fn);
    }
  });

  return token;
}
