import type {
  DriftItem,
  EventLevel,
  Resource,
  Run,
  RunEvent,
} from "@orchestrator/shared";

/**
 * Persistence boundary for the whole system. The engine and API depend only on
 * this interface, never on SQLite directly — so the store is swappable and the
 * engine is testable against any implementation.
 */
export interface Store {
  // --- desired state (the declared config) ---
  listDesired(): Resource[];
  getDesired(address: string): Resource | null;
  upsertDesired(resource: Resource): void;
  deleteDesired(address: string): void;

  // --- actual state (the live mock cloud) ---
  /** Only resources currently present in the cloud. */
  listActual(): Resource[];
  getActual(address: string): Resource | null;
  upsertActual(resource: Resource): void;
  /** Remove a resource from the live cloud (marks it absent). */
  deleteActual(address: string): void;

  // --- runs (scan | reconcile) ---
  createRun(run: Run): void;
  getRun(id: string): Run | null;
  listRuns(): Run[];
  updateRun(id: string, patch: Partial<Pick<Run, "status" | "finishedAt" | "summary">>): void;

  // --- drift items (produced by a scan, mutated by a reconcile) ---
  saveDriftItems(scanId: string, items: DriftItem[]): void;
  listDriftItems(scanId: string): DriftItem[];
  getDriftItem(scanId: string, address: string): DriftItem | null;
  updateDriftItem(scanId: string, address: string, patch: Partial<DriftItem>): void;

  // --- events (append-only progress + audit feed) ---
  appendEvent(
    runId: string,
    level: EventLevel,
    stage: string,
    message: string,
  ): RunEvent;
  listEvents(runId: string): RunEvent[];

  /** Reset desired + actual + runs to a clean seeded baseline. */
  reset(): void;
}
