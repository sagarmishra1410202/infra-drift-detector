import { EventEmitter } from "node:events";
import type { Run, RunEvent } from "@orchestrator/shared";

/** A message broadcast about a run as it executes. */
export type BusMessage =
  | { type: "event"; event: RunEvent }
  | { type: "run"; run: Run }
  | { type: "done"; run: Run };

/**
 * In-process pub/sub keyed by run id. The engine publishes here as it works;
 * the SSE route subscribes. This is the seam that keeps the engine ignorant of
 * HTTP — it just announces progress, and whoever cares can listen.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Many SSE clients may watch the same popular run; lift the warning cap.
    this.emitter.setMaxListeners(0);
  }

  publish(runId: string, message: BusMessage): void {
    this.emitter.emit(runId, message);
  }

  /** Subscribe to a run's messages; returns an unsubscribe function. */
  subscribe(runId: string, listener: (message: BusMessage) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
