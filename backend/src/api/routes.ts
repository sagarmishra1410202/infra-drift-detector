import type { FastifyInstance } from "fastify";
import {
  defaultAction,
  type ReconcileRequestItem,
  type SimulateKind,
} from "@orchestrator/shared";
import type { Store } from "../store/types.ts";
import type { Engine } from "../domain/engine.ts";
import type { MockCloud } from "../infra/mockCloud.ts";
import type { EventBus, BusMessage } from "../events/bus.ts";
import { seedBaseline } from "../infra/seed.ts";

export interface RouteDeps {
  store: Store;
  engine: Engine;
  cloud: MockCloud;
  bus: EventBus;
}

const VALID_SIMULATE: SimulateKind[] = ["mutate", "delete", "create"];

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, engine, cloud, bus } = deps;

  app.get("/api/health", async () => ({ ok: true }));

  // Current desired vs actual inventory (drives the dashboard overview).
  app.get("/api/state", async () => ({
    desired: store.listDesired(),
    actual: cloud.list(),
  }));

  // Run history.
  app.get("/api/runs", async () => store.listRuns());

  // Full run detail: the run, its scan's drift items, and the event log.
  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const scanId = run.kind === "scan" ? run.id : run.scanId!;
    return { run, items: store.listDriftItems(scanId), events: store.listEvents(id) };
  });

  // Start a scan; work runs in the background, client follows via SSE.
  app.post("/api/scans", async () => {
    const run = engine.beginScan();
    void engine.executeScan(run.id).catch((err) => app.log.error(err));
    return { run };
  });

  // Start a reconcile. Body: { scanId, items?: ReconcileRequestItem[] }.
  // When items are omitted, reconcile every non-in_sync resource with its default action.
  app.post("/api/reconciles", async (req, reply) => {
    const body = (req.body ?? {}) as { scanId?: string; items?: ReconcileRequestItem[] };
    if (!body.scanId) return reply.code(400).send({ error: "scanId is required" });
    const scan = store.getRun(body.scanId);
    if (!scan || scan.kind !== "scan") return reply.code(400).send({ error: "unknown scanId" });

    const driftItems = store.listDriftItems(body.scanId);
    const items: ReconcileRequestItem[] =
      body.items && body.items.length > 0
        ? body.items
        : driftItems
            .filter((i) => i.classification !== "in_sync")
            .map((i) => ({ address: i.address, action: defaultAction(i.classification) }));

    if (items.length === 0) return reply.code(400).send({ error: "nothing to reconcile" });
    const known = new Set(driftItems.map((i) => i.address));
    const unknown = items.find((i) => !known.has(i.address));
    if (unknown) return reply.code(400).send({ error: `address not in scan: ${unknown.address}` });

    const run = engine.beginReconcile(body.scanId, items);
    void engine.executeReconcile(run.id, body.scanId, items).catch((err) => app.log.error(err));
    return { run };
  });

  // Introduce out-of-band drift on demand (demo affordance).
  app.post("/api/simulate", async (req, reply) => {
    const body = (req.body ?? {}) as { kind?: SimulateKind };
    const kind = body.kind ?? "mutate";
    if (!VALID_SIMULATE.includes(kind)) return reply.code(400).send({ error: "invalid kind" });
    return cloud.simulate(kind);
  });

  // Reset desired + actual + runs back to the seeded baseline.
  app.post("/api/reset", async () => {
    store.reset();
    seedBaseline(store);
    return { ok: true };
  });

  // ---- SSE: live progress for a run -----------------------------------------
  // Replays the run's persisted events, then tails live ones. Subscribing before
  // replay (and de-duping by event id) closes the race where an event fires
  // between the replay read and the subscription.
  app.get("/api/runs/:id/events", (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    if (!run) {
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "run not found" })}\n\n`);
      reply.raw.end();
      return;
    }

    const seen = new Set<number>();
    const write = (msg: BusMessage | { type: string }) =>
      reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
    const sendEvent = (e: { id: number }) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      write({ type: "event", event: e } as BusMessage);
    };

    // Terminal run: replay everything and close.
    if (run.status !== "running") {
      write({ type: "run", run });
      for (const e of store.listEvents(id)) sendEvent(e);
      write({ type: "done", run });
      reply.raw.end();
      return;
    }

    // Live run: subscribe first, buffer until replay completes, then flush + tail.
    let live = false;
    const buffer: BusMessage[] = [];
    const deliver = (msg: BusMessage) => {
      if (msg.type === "event") sendEvent(msg.event);
      else if (msg.type === "run") write(msg);
      else if (msg.type === "done") {
        write(msg);
        cleanup();
      }
    };
    const onMsg = (msg: BusMessage) => (live ? deliver(msg) : buffer.push(msg));
    const unsub = bus.subscribe(id, onMsg);
    function cleanup() {
      unsub();
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    }
    req.raw.on("close", unsub);

    write({ type: "run", run });
    for (const e of store.listEvents(id)) sendEvent(e);
    live = true;
    for (const msg of buffer) deliver(msg);
  });
}
