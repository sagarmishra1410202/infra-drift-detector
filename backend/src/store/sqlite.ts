import { DatabaseSync } from "node:sqlite";
import type {
  DriftItem,
  EventLevel,
  Resource,
  ResourceType,
  Run,
  RunEvent,
  RunKind,
  RunStatus,
} from "@orchestrator/shared";
import type { Store } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desired_resources (
  address    TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  properties TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS actual_resources (
  address    TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  properties TEXT NOT NULL,
  present    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  scan_id     TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  summary     TEXT
);
CREATE TABLE IF NOT EXISTS drift_items (
  scan_id          TEXT NOT NULL,
  address          TEXT NOT NULL,
  type             TEXT NOT NULL,
  classification   TEXT NOT NULL,
  desired          TEXT,
  actual           TEXT,
  diff             TEXT NOT NULL,
  reconcile_action TEXT,
  reconcile_status TEXT,
  PRIMARY KEY (scan_id, address)
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  level      TEXT NOT NULL,
  stage      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, id);
`;

// --- row shapes (as returned by node:sqlite) ---------------------------------

interface ResourceRow {
  address: string;
  type: string;
  properties: string;
}
interface RunRow {
  id: string;
  kind: string;
  status: string;
  scan_id: string | null;
  started_at: number;
  finished_at: number | null;
  summary: string | null;
}
interface DriftRow {
  scan_id: string;
  address: string;
  type: string;
  classification: string;
  desired: string | null;
  actual: string | null;
  diff: string;
  reconcile_action: string | null;
  reconcile_status: string | null;
}
interface EventRow {
  id: number;
  run_id: string;
  level: string;
  stage: string;
  message: string;
  created_at: number;
}

function rowToResource(row: ResourceRow): Resource {
  return {
    address: row.address,
    type: row.type as ResourceType,
    properties: JSON.parse(row.properties),
  };
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    scanId: row.scan_id ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    summary: row.summary ? JSON.parse(row.summary) : undefined,
  };
}

function rowToDriftItem(row: DriftRow): DriftItem {
  return {
    address: row.address,
    type: row.type as ResourceType,
    classification: row.classification as DriftItem["classification"],
    desired: row.desired ? JSON.parse(row.desired) : null,
    actual: row.actual ? JSON.parse(row.actual) : null,
    diff: JSON.parse(row.diff),
    reconcileAction: (row.reconcile_action as DriftItem["reconcileAction"]) ?? undefined,
    reconcileStatus: (row.reconcile_status as DriftItem["reconcileStatus"]) ?? undefined,
  };
}

/** node:sqlite-backed Store. Pass `:memory:` for tests, a file path otherwise. */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  // --- desired ---------------------------------------------------------------

  listDesired(): Resource[] {
    return (this.db.prepare("SELECT * FROM desired_resources ORDER BY address").all() as ResourceRow[]).map(
      rowToResource,
    );
  }

  getDesired(address: string): Resource | null {
    const row = this.db.prepare("SELECT * FROM desired_resources WHERE address = ?").get(address) as
      | ResourceRow
      | undefined;
    return row ? rowToResource(row) : null;
  }

  upsertDesired(r: Resource): void {
    this.db
      .prepare(
        `INSERT INTO desired_resources (address, type, properties, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET type = excluded.type,
           properties = excluded.properties, updated_at = excluded.updated_at`,
      )
      .run(r.address, r.type, JSON.stringify(r.properties), Date.now());
  }

  deleteDesired(address: string): void {
    this.db.prepare("DELETE FROM desired_resources WHERE address = ?").run(address);
  }

  // --- actual ----------------------------------------------------------------

  listActual(): Resource[] {
    return (
      this.db
        .prepare("SELECT * FROM actual_resources WHERE present = 1 ORDER BY address")
        .all() as ResourceRow[]
    ).map(rowToResource);
  }

  getActual(address: string): Resource | null {
    const row = this.db
      .prepare("SELECT * FROM actual_resources WHERE address = ? AND present = 1")
      .get(address) as ResourceRow | undefined;
    return row ? rowToResource(row) : null;
  }

  upsertActual(r: Resource): void {
    this.db
      .prepare(
        `INSERT INTO actual_resources (address, type, properties, present, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(address) DO UPDATE SET type = excluded.type,
           properties = excluded.properties, present = 1, updated_at = excluded.updated_at`,
      )
      .run(r.address, r.type, JSON.stringify(r.properties), Date.now());
  }

  deleteActual(address: string): void {
    this.db
      .prepare("UPDATE actual_resources SET present = 0, updated_at = ? WHERE address = ?")
      .run(Date.now(), address);
  }

  // --- runs ------------------------------------------------------------------

  createRun(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, scan_id, started_at, finished_at, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.kind,
        run.status,
        run.scanId ?? null,
        run.startedAt,
        run.finishedAt ?? null,
        run.summary ? JSON.stringify(run.summary) : null,
      );
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as RunRow[]).map(
      rowToRun,
    );
  }

  updateRun(id: string, patch: Partial<Pick<Run, "status" | "finishedAt" | "summary">>): void {
    const current = this.getRun(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?")
      .run(next.status, next.finishedAt ?? null, next.summary ? JSON.stringify(next.summary) : null, id);
  }

  // --- drift items -----------------------------------------------------------

  saveDriftItems(scanId: string, items: DriftItem[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO drift_items
         (scan_id, address, type, classification, desired, actual, diff, reconcile_action, reconcile_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scan_id, address) DO UPDATE SET
         classification = excluded.classification, desired = excluded.desired,
         actual = excluded.actual, diff = excluded.diff`,
    );
    for (const item of items) {
      stmt.run(
        scanId,
        item.address,
        item.type,
        item.classification,
        item.desired ? JSON.stringify(item.desired) : null,
        item.actual ? JSON.stringify(item.actual) : null,
        JSON.stringify(item.diff),
        item.reconcileAction ?? null,
        item.reconcileStatus ?? null,
      );
    }
  }

  listDriftItems(scanId: string): DriftItem[] {
    return (
      this.db
        .prepare("SELECT * FROM drift_items WHERE scan_id = ? ORDER BY address")
        .all(scanId) as DriftRow[]
    ).map(rowToDriftItem);
  }

  getDriftItem(scanId: string, address: string): DriftItem | null {
    const row = this.db
      .prepare("SELECT * FROM drift_items WHERE scan_id = ? AND address = ?")
      .get(scanId, address) as DriftRow | undefined;
    return row ? rowToDriftItem(row) : null;
  }

  updateDriftItem(scanId: string, address: string, patch: Partial<DriftItem>): void {
    const current = this.getDriftItem(scanId, address);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "UPDATE drift_items SET reconcile_action = ?, reconcile_status = ? WHERE scan_id = ? AND address = ?",
      )
      .run(next.reconcileAction ?? null, next.reconcileStatus ?? null, scanId, address);
  }

  // --- events ----------------------------------------------------------------

  appendEvent(runId: string, level: EventLevel, stage: string, message: string): RunEvent {
    const createdAt = Date.now();
    const res = this.db
      .prepare("INSERT INTO events (run_id, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, level, stage, message, createdAt);
    return { id: Number(res.lastInsertRowid), runId, level, stage, message, createdAt };
  }

  listEvents(runId: string): RunEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id").all(runId) as EventRow[]
    ).map((row) => ({
      id: row.id,
      runId: row.run_id,
      level: row.level as EventLevel,
      stage: row.stage,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  reset(): void {
    for (const table of ["events", "drift_items", "runs", "actual_resources", "desired_resources"]) {
      this.db.exec(`DELETE FROM ${table};`);
    }
  }
}
