import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../store/sqlite.ts";
import { MockCloud } from "../infra/mockCloud.ts";
import { EventBus } from "../events/bus.ts";
import { seedBaseline } from "../infra/seed.ts";
import { Engine } from "./engine.ts";
import type {
  ReconcileRequestItem,
  ReconcileSummary,
  ScanSummary,
} from "@orchestrator/shared";

/** Build a fully-wired engine over an in-memory DB with no artificial latency. */
function makeEngine() {
  const store = new SqliteStore(":memory:");
  const cloud = new MockCloud(store, 0);
  const bus = new EventBus();
  const engine = new Engine(store, cloud, bus, { stageDelayMs: 0 });
  seedBaseline(store);
  return { store, cloud, bus, engine };
}

async function runScan(engine: Engine) {
  const run = engine.beginScan();
  return engine.executeScan(run.id);
}

describe("scan / classification", () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it("classifies the seeded baseline into every drift class", async () => {
    const run = await runScan(ctx.engine);
    assert.equal(run.status, "completed");

    const summary = run.summary as ScanSummary;
    // 7 resources: 1 in_sync, 4 drifted, 1 missing, 1 unmanaged
    assert.deepEqual(summary, { total: 7, inSync: 1, drifted: 4, missing: 1, unmanaged: 1 });
  });

  it("captures the exact property diff for a drifted resource", async () => {
    const run = await runScan(ctx.engine);
    const items = ctx.store.listDriftItems(run.id);
    const assets = items.find((i) => i.address === "s3_bucket.assets")!;
    assert.equal(assets.classification, "drifted");
    assert.deepEqual(assets.diff, [{ key: "public", desired: false, actual: true }]);
  });

  it("flags an out-of-band resource as unmanaged and a deleted one as missing", async () => {
    const run = await runScan(ctx.engine);
    const items = ctx.store.listDriftItems(run.id);
    assert.equal(items.find((i) => i.address === "security_group.legacy")!.classification, "unmanaged");
    assert.equal(items.find((i) => i.address === "dns_record.www")!.classification, "missing");
  });

  it("writes an append-only event log ending in a summary", async () => {
    const run = await runScan(ctx.engine);
    const events = ctx.store.listEvents(run.id);
    assert.ok(events.length > 5);
    assert.equal(events.at(-1)!.stage, "summarize");
  });
});

describe("reconcile / convergence", () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it("converges drift to in_sync and reports partial failure on a protected resource", async () => {
    const scan = await runScan(ctx.engine);
    const items = ctx.store.listDriftItems(scan.id);

    // Reconcile every non-in_sync item with its default action.
    const requests: ReconcileRequestItem[] = items
      .filter((i) => i.classification !== "in_sync")
      .map((i) => ({
        address: i.address,
        action:
          i.classification === "drifted"
            ? "patch"
            : i.classification === "missing"
              ? "recreate"
              : "delete",
      }));

    const recRun = ctx.engine.beginReconcile(scan.id, requests);
    const finished = await ctx.engine.executeReconcile(recRun.id, scan.id, requests);

    const summary = finished.summary as ReconcileSummary;
    // 6 actionable items; iam_role.deployer is protected → exactly one failure.
    assert.equal(summary.total, 6);
    assert.equal(summary.failed, 1);
    assert.equal(summary.reconciled, 5);

    // The protected item is recorded as failed.
    assert.equal(ctx.store.getDriftItem(scan.id, "iam_role.deployer")!.reconcileStatus, "failed");

    // A fresh scan proves convergence: only the protected resource still drifts.
    const verify = await runScan(ctx.engine);
    const after = verify.summary as ScanSummary;
    assert.equal(after.drifted, 1);
    assert.equal(after.missing, 0);
    assert.equal(after.unmanaged, 0);
  });

  it("recreates a missing resource and deletes an unmanaged one in the live cloud", async () => {
    const scan = await runScan(ctx.engine);
    const requests: ReconcileRequestItem[] = [
      { address: "dns_record.www", action: "recreate" },
      { address: "security_group.legacy", action: "delete" },
    ];
    const rec = ctx.engine.beginReconcile(scan.id, requests);
    await ctx.engine.executeReconcile(rec.id, scan.id, requests);

    assert.ok(ctx.cloud.list().find((r) => r.address === "dns_record.www"));
    assert.ok(!ctx.cloud.list().find((r) => r.address === "security_group.legacy"));
  });

  it("imports an unmanaged resource into desired state instead of deleting it", async () => {
    const scan = await runScan(ctx.engine);
    const requests: ReconcileRequestItem[] = [
      { address: "security_group.legacy", action: "import" },
    ];
    const rec = ctx.engine.beginReconcile(scan.id, requests);
    await ctx.engine.executeReconcile(rec.id, scan.id, requests);

    assert.notEqual(ctx.store.getDesired("security_group.legacy"), null);
    const verify = await runScan(ctx.engine);
    assert.equal(
      ctx.store.getDriftItem(verify.id, "security_group.legacy")!.classification,
      "in_sync",
    );
  });
});

describe("crash recovery", () => {
  it("marks orphaned running runs as failed on boot", () => {
    const { store, engine } = makeEngine();
    engine.beginScan(); // left in `running`, never executed (simulates a crash)
    const recovered = engine.recoverOrphans();
    assert.equal(recovered, 1);
    assert.ok(store.listRuns().every((r) => r.status !== "running"));
  });
});
