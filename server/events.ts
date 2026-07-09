import type { RunEvent } from "../shared/contracts";
import { RunStore } from "./store";

type EventListener = (event: RunEvent) => void;

export interface RunEventFeed {
  next(): Promise<RunEvent | null>;
  close(): void;
}

interface WritableRunEventFeed extends RunEventFeed {
  push(event: RunEvent): void;
}

function createFeed(afterId: number, onClose: () => void): WritableRunEventFeed {
  const queue: RunEvent[] = [];
  let closed = false;
  let lastEventId = Math.max(0, Math.floor(afterId));
  let waiter: ((event: RunEvent | null) => void) | null = null;

  return {
    push(event) {
      if (closed || event.id <= lastEventId) return;
      lastEventId = event.id;

      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(event);
      } else {
        queue.push(event);
      }
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      if (waiter) return Promise.reject(new Error("Solo puede haber una lectura pendiente por feed."));

      return new Promise<RunEvent | null>((resolve) => {
        waiter = resolve;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
      waiter?.(null);
      waiter = null;
      queue.length = 0;
    },
  };
}

export class RunEventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly store: RunStore,
    readonly heartbeatMs = 15_000,
  ) {}

  publish(event: RunEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  subscribe(runId: string, listener: EventListener): () => void {
    const runListeners = this.listeners.get(runId) ?? new Set<EventListener>();
    runListeners.add(listener);
    this.listeners.set(runId, runListeners);

    return () => {
      runListeners.delete(listener);
      if (runListeners.size === 0) this.listeners.delete(runId);
    };
  }

  async openFeed(runId: string, afterId = 0): Promise<RunEventFeed> {
    const pending: RunEvent[] = [];
    let enqueue: (event: RunEvent) => void = (event) => {
      pending.push(event);
    };
    const unsubscribe = this.subscribe(runId, (event) => enqueue(event));

    try {
      const replay = await this.store.getEvents(runId, afterId);
      const feed = createFeed(afterId, unsubscribe);
      for (const event of [...replay, ...pending].sort((left, right) => left.id - right.id)) feed.push(event);
      enqueue = (event) => feed.push(event);
      return feed;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }
}
