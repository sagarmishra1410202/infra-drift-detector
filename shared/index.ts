/**
 * @orchestrator/shared
 *
 * The vocabulary of the drift-detection domain, shared verbatim by the backend
 * engine, the API, and the frontend. Pure types plus the classification/diff
 * helpers — no I/O, no dependencies — so the same logic that the engine runs is
 * the logic the tests assert and the UI renders.
 */

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Primitive property values a resource can carry. */
export type PropertyValue = string | number | boolean;

export type Properties = Record<string, PropertyValue>;

/** Resource types we model in the mock cloud. Kept open-ended on purpose. */
export type ResourceType =
  | "s3_bucket"
  | "security_group"
  | "compute_instance"
  | "dns_record"
  | "iam_role";

/** A single resource, in either desired or actual state. */
export interface Resource {
  /** Stable identity, e.g. "s3_bucket.assets". */
  address: string;
  type: ResourceType;
  properties: Properties;
}

// ---------------------------------------------------------------------------
// Drift classification
// ---------------------------------------------------------------------------

export type DriftClassification =
  | "in_sync" // exists in both, properties match
  | "drifted" // exists in both, properties differ
  | "missing" // declared in desired, absent from actual
  | "unmanaged"; // present in actual, not declared

/** One property that differs between desired and actual. */
export interface PropertyDiff {
  key: string;
  desired: PropertyValue | null;
  actual: PropertyValue | null;
}

export type ReconcileAction = "patch" | "recreate" | "delete" | "import" | "none";

export type ReconcileItemStatus =
  | "pending"
  | "applying"
  | "reconciled"
  | "failed"
  | "skipped";

/** The unit of a scan result: one resource, classified, with its diff. */
export interface DriftItem {
  address: string;
  type: ResourceType;
  classification: DriftClassification;
  desired: Resource | null;
  actual: Resource | null;
  diff: PropertyDiff[];
  /** Chosen remediation (populated when part of a reconcile). */
  reconcileAction?: ReconcileAction;
  reconcileStatus?: ReconcileItemStatus;
}

// ---------------------------------------------------------------------------
// Runs (scan | reconcile)
// ---------------------------------------------------------------------------

export type RunKind = "scan" | "reconcile";
export type RunStatus = "running" | "completed" | "failed";

export interface ScanSummary {
  total: number;
  inSync: number;
  drifted: number;
  missing: number;
  unmanaged: number;
}

export interface ReconcileSummary {
  total: number;
  reconciled: number;
  failed: number;
  skipped: number;
}

export interface Run {
  id: string;
  kind: RunKind;
  status: RunStatus;
  /** For reconcile runs: the scan whose drift items are being remediated. */
  scanId?: string;
  startedAt: number;
  finishedAt?: number;
  summary?: ScanSummary | ReconcileSummary;
}

export type EventLevel = "info" | "warn" | "error";

/** Append-only progress/audit record; drives SSE replay + live tail. */
export interface RunEvent {
  id: number;
  runId: string;
  level: EventLevel;
  /** Logical step the event belongs to, e.g. "refresh-actual" or an address. */
  stage: string;
  message: string;
  createdAt: number;
}

/** What an SSE consumer receives. `done` lets the client close the stream. */
export type StreamMessage =
  | { type: "event"; event: RunEvent }
  | { type: "run"; run: Run }
  | { type: "done"; run: Run };

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

export interface ScanDetail {
  run: Run;
  items: DriftItem[];
}

export interface ReconcileRequestItem {
  address: string;
  action: ReconcileAction;
}

export interface ReconcileDetail {
  run: Run;
  items: DriftItem[];
}

export type SimulateKind = "mutate" | "delete" | "create";

// ---------------------------------------------------------------------------
// Pure helpers — the heart of detection, shared by engine, tests, and UI
// ---------------------------------------------------------------------------

function valuesEqual(a: PropertyValue, b: PropertyValue): boolean {
  return a === b;
}

/**
 * Compute the per-property diff between a desired and an actual resource.
 * Returns one entry per key that differs or is present on only one side.
 */
export function diffProperties(
  desired: Properties,
  actual: Properties,
): PropertyDiff[] {
  const keys = new Set([...Object.keys(desired), ...Object.keys(actual)]);
  const diffs: PropertyDiff[] = [];
  for (const key of [...keys].sort()) {
    const d = key in desired ? desired[key] : null;
    const a = key in actual ? actual[key] : null;
    if (d === null || a === null || !valuesEqual(d, a)) {
      diffs.push({ key, desired: d, actual: a });
    }
  }
  return diffs;
}

/**
 * Classify a single resource by comparing its desired and actual states.
 * `actual === null` means the resource is absent from the live cloud.
 */
export function classify(
  desired: Resource | null,
  actual: Resource | null,
): { classification: DriftClassification; diff: PropertyDiff[] } {
  if (desired && !actual) return { classification: "missing", diff: [] };
  if (!desired && actual) return { classification: "unmanaged", diff: [] };
  if (desired && actual) {
    const diff = diffProperties(desired.properties, actual.properties);
    return {
      classification: diff.length === 0 ? "in_sync" : "drifted",
      diff,
    };
  }
  // Neither present — shouldn't happen, but classify as in_sync (nothing to do).
  return { classification: "in_sync", diff: [] };
}

/** The remediation the reconciler defaults to for a given classification. */
export function defaultAction(classification: DriftClassification): ReconcileAction {
  switch (classification) {
    case "drifted":
      return "patch";
    case "missing":
      return "recreate";
    case "unmanaged":
      return "delete";
    case "in_sync":
      return "none";
  }
}

export function emptyScanSummary(): ScanSummary {
  return { total: 0, inSync: 0, drifted: 0, missing: 0, unmanaged: 0 };
}

/** Roll a list of classified items into a scan summary. */
export function summarizeScan(items: DriftItem[]): ScanSummary {
  const s = emptyScanSummary();
  s.total = items.length;
  for (const item of items) {
    if (item.classification === "in_sync") s.inSync++;
    else if (item.classification === "drifted") s.drifted++;
    else if (item.classification === "missing") s.missing++;
    else if (item.classification === "unmanaged") s.unmanaged++;
  }
  return s;
}
