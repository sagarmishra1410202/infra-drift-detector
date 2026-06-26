import {
  classify,
  summarizeScan,
  type DriftItem,
  type EventLevel,
  type ReconcileRequestItem,
  type ReconcileSummary,
  type Resource,
  type Run,
  type ScanSummary,
} from "@orchestrator/shared";
import type { Store } from "../store/types.ts";
import type { MockCloud } from "../infra/mockCloud.ts";
import type { EventBus } from "../events/bus.ts";

const shortId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export interface EngineOptions {
  /** Small pause between high-level stages so progress is readable. 0 in tests. */
  stageDelayMs?: number;
}

/**
 * The drift engine. Owns the two workflows — scan (detect) and reconcile
 * (remediate) — as persisted state machines. Each is split into a synchronous
 * `begin*` (create the durable run, return immediately) and an async `execute*`
 * (do the work, stream events). The API fires execute without awaiting; tests
 * await it. The engine never touches HTTP — it persists via Store and announces
 * via EventBus.
 */
export class Engine {
  private stageDelayMs: number;

  constructor(
    private store: Store,
    private cloud: MockCloud,
    private bus: EventBus,
    opts: EngineOptions = {},
  ) {
    this.stageDelayMs = opts.stageDelayMs ?? 500;
  }

  // --- shared plumbing -------------------------------------------------------

  private emit(runId: string, level: EventLevel, stage: string, message: string): void {
    const event = this.store.appendEvent(runId, level, stage, message);
    this.bus.publish(runId, { type: "event", event });
  }

  private finish(run: Run, status: Run["status"], summary: ScanSummary | ReconcileSummary): Run {
    this.store.updateRun(run.id, { status, finishedAt: Date.now(), summary });
    const finished = this.store.getRun(run.id)!;
    this.bus.publish(run.id, { type: "done", run: finished });
    return finished;
  }

  // --- scan (detect) ---------------------------------------------------------

  /** Create the scan run and return it; work happens in `executeScan`. */
  beginScan(): Run {
    const run: Run = { id: shortId("scan"), kind: "scan", status: "running", startedAt: Date.now() };
    this.store.createRun(run);
    this.bus.publish(run.id, { type: "run", run });
    return run;
  }

  async executeScan(runId: string): Promise<Run> {
    const run = this.store.getRun(runId)!;
    try {
      // 1. load desired
      this.emit(runId, "info", "load-desired", "Loading desired state…");
      const desired = this.store.listDesired();
      const desiredByAddr = new Map(desired.map((r) => [r.address, r]));
      await sleep(this.stageDelayMs);
      this.emit(runId, "info", "load-desired", `Loaded ${desired.length} declared resources`);

      // 2. refresh actual (per-resource, with provider latency → visible progress)
      this.emit(runId, "info", "refresh-actual", "Refreshing live cloud state…");
      const addresses = [
        ...new Set([...desiredByAddr.keys(), ...this.cloud.list().map((r) => r.address)]),
      ].sort();
      const actualByAddr = new Map<string, Resource>();
      for (const address of addresses) {
        const live = await this.cloud.refresh(address);
        if (live) {
          actualByAddr.set(address, live);
          this.emit(runId, "info", "refresh-actual", `✓ refreshed ${address}`);
        } else {
          this.emit(runId, "warn", "refresh-actual", `✗ ${address} not found in cloud`);
        }
      }

      // 3. classify
      this.emit(runId, "info", "classify", "Classifying resources against desired state…");
      await sleep(this.stageDelayMs);
      const items: DriftItem[] = addresses.map((address) => {
        const d = desiredByAddr.get(address) ?? null;
        const a = actualByAddr.get(address) ?? null;
        const { classification, diff } = classify(d, a);
        if (classification !== "in_sync") {
          this.emit(
            runId,
            classification === "drifted" || classification === "unmanaged" ? "warn" : "warn",
            "classify",
            `${address}: ${classification}${diff.length ? ` (${diff.map((x) => x.key).join(", ")})` : ""}`,
          );
        }
        return { address, type: (d ?? a)!.type, classification, desired: d, actual: a, diff };
      });
      this.store.saveDriftItems(runId, items);

      // 4. summarize
      const summary = summarizeScan(items);
      this.emit(
        runId,
        summary.drifted + summary.missing + summary.unmanaged > 0 ? "warn" : "info",
        "summarize",
        `Scan complete — ${summary.inSync} in sync, ${summary.drifted} drifted, ${summary.missing} missing, ${summary.unmanaged} unmanaged`,
      );
      return this.finish(run, "completed", summary);
    } catch (err) {
      this.emit(runId, "error", "scan", `Scan failed: ${(err as Error).message}`);
      return this.finish(run, "failed", summarizeScan(this.store.listDriftItems(runId)));
    }
  }

  // --- reconcile (remediate) -------------------------------------------------

  /** Record reconcile intent on the scan's drift items and create the run. */
  beginReconcile(scanId: string, requestItems: ReconcileRequestItem[]): Run {
    const run: Run = {
      id: shortId("rec"),
      kind: "reconcile",
      status: "running",
      scanId,
      startedAt: Date.now(),
    };
    this.store.createRun(run);
    for (const item of requestItems) {
      this.store.updateDriftItem(scanId, item.address, {
        reconcileAction: item.action,
        reconcileStatus: "pending",
      });
    }
    this.bus.publish(run.id, { type: "run", run });
    return run;
  }

  async executeReconcile(
    runId: string,
    scanId: string,
    requestItems: ReconcileRequestItem[],
  ): Promise<Run> {
    const run = this.store.getRun(runId)!;
    let reconciled = 0;
    let failed = 0;
    let skipped = 0;

    this.emit(runId, "info", "reconcile", `Reconciling ${requestItems.length} resource(s)…`);

    for (const req of requestItems) {
      const item = this.store.getDriftItem(scanId, req.address);
      if (!item || req.action === "none") {
        skipped++;
        this.store.updateDriftItem(scanId, req.address, { reconcileStatus: "skipped" });
        continue;
      }
      this.store.updateDriftItem(scanId, req.address, { reconcileStatus: "applying" });
      this.emit(runId, "info", req.address, `Applying ${req.action} → ${req.address}…`);
      try {
        await this.applyAction(item, req.action);
        this.store.updateDriftItem(scanId, req.address, { reconcileStatus: "reconciled" });
        this.emit(runId, "info", req.address, `✓ ${req.address} reconciled`);
        reconciled++;
      } catch (err) {
        this.store.updateDriftItem(scanId, req.address, { reconcileStatus: "failed" });
        this.emit(runId, "error", req.address, `✗ ${req.address}: ${(err as Error).message}`);
        failed++;
      }
    }

    const summary: ReconcileSummary = { total: requestItems.length, reconciled, failed, skipped };
    const status: Run["status"] = reconciled === 0 && failed > 0 ? "failed" : "completed";
    this.emit(
      runId,
      failed > 0 ? "warn" : "info",
      "summarize",
      `Reconcile complete — ${reconciled} reconciled, ${failed} failed, ${skipped} skipped`,
    );
    return this.finish(run, status, summary);
  }

  /** Translate a chosen action into a mutation of the live cloud / desired state. */
  private async applyAction(item: DriftItem, action: ReconcileRequestItem["action"]): Promise<void> {
    switch (action) {
      case "patch": // drifted → push desired properties back
      case "recreate": // missing → recreate from desired
        if (!item.desired) throw new Error("no desired state to converge to");
        await this.cloud.apply(item.desired);
        return;
      case "delete": // unmanaged → remove from the cloud
        await this.cloud.remove(item.address);
        return;
      case "import": // unmanaged → adopt into desired state
        if (!item.actual) throw new Error("no actual state to import");
        this.store.upsertDesired(item.actual);
        return;
      case "none":
        return;
    }
  }

  // --- crash recovery --------------------------------------------------------

  /** Mark runs left `running` by a crashed server as failed. */
  recoverOrphans(): number {
    const orphans = this.store.listRuns().filter((r) => r.status === "running");
    for (const run of orphans) {
      this.emit(run.id, "error", "recovery", "Run was interrupted by a server restart");
      this.store.updateRun(run.id, { status: "failed", finishedAt: Date.now() });
    }
    return orphans.length;
  }
}
