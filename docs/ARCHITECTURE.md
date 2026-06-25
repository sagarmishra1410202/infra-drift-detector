# Architecture Overview

## Use case & rationale

**Infrastructure drift detection & reconciliation.**

What's declared in your IaC/config inevitably stops matching what's actually running.
Someone hot-patches a resource in the console, an automation half-fails, a security
group gets opened "just for a minute." This *drift* is invisible until it bites you
during an incident or an audit. Detecting it, understanding exactly what changed, and
safely converging back to the declared state is the literal core of what Terraform,
Pulumi, and GitOps controllers do.

This tool models that loop as a first-class, observable workflow. An operator declares
desired state, **scans** a (mock) cloud to compare it against live reality, sees every
resource classified and diffed, and then **reconciles** — watching the system converge
actual state back to desired, one resource at a time, handling the resource that refuses
to reconcile without corrupting the rest.

It is deliberately **small but complete**: one reconciliation loop, executed thoroughly,
with real state management, real failure handling, and a UI an operator would actually
use. All infrastructure is mocked locally — no cloud account, no API keys.

## Core concepts

- **Desired state** — the declared configuration (the "source of truth"), a set of
  resources with expected properties. Analogous to your IaC.
- **Actual state** — the live mock cloud (`MockCloud`). It can diverge from desired.
- **Resource** — has an `address` (e.g. `s3_bucket.assets`), a `type`, and a bag of
  `properties` (e.g. `{ public: false, versioning: "enabled" }`).
- **Drift classification** — per resource, comparing desired vs actual:
  | Class | Meaning |
  |-------|---------|
  | `in_sync`   | exists in both, properties match |
  | `drifted`   | exists in both, properties differ (we capture the per-key diff) |
  | `missing`   | declared in desired, absent from actual (deleted out-of-band) |
  | `unmanaged` | present in actual, not declared (created out-of-band) |

## The workflow

Everything is a **run** (`kind: scan | reconcile`) — a persisted state machine that
streams progress and records an append-only event log.

**Scan** (detect):
```
load-desired → refresh-actual (per-resource, live) → classify → summarize
```
Produces a set of **drift items** (one per resource that isn't `in_sync`, plus the full
classified inventory) and a summary count.

**Reconcile** (remediate): processes selected drift items, converging actual → desired:
- `drifted`   → patch the live resource's properties back to desired
- `missing`   → recreate the resource in actual
- `unmanaged` → `delete` it from actual, or `import` it into desired (operator's choice)

Reconcile applies each item independently. A **protected** resource fails to apply on
purpose — that item stays drifted and the run reports **partial success**, demonstrating
graceful failure without aborting the whole reconciliation.

**Simulate out-of-band change** — a first-class action that perturbs the live cloud
(flip a property, delete a resource, add an untracked one), so an operator can *create*
drift on demand and re-scan to watch it converge. This is the domain-realistic analog of
failure injection: it's exactly what a human or a broken automation does to live infra.

### Demonstrable paths

| Path | Steps | Outcome |
|------|-------|---------|
| 🔍 Detect | seed has built-in drift → **Scan** | report: in_sync / drifted / missing / unmanaged with diffs |
| ✅ Converge | **Reconcile** the drift | actual patched/recreated/deleted; re-scan shows `in_sync` |
| ⚠️ Partial failure | reconcile includes a protected resource | that item stays drifted, the rest converge |
| 🧪 Live drift | **Simulate out-of-band change** → re-scan | newly-introduced drift appears |

## System design

Clean separation between **UI**, **API**, and **engine**, in an npm-workspaces monorepo:

```
shared/     TypeScript types + classification/diff helpers (imported by both sides)
backend/    Fastify API + drift engine + SQLite store
  domain/   classify() + scan/reconcile run engines (state machine) — pure, unit-tested
  infra/    MockCloud: the live actual-state provider (apply / delete / refresh / perturb)
  store/    Store interface + node:sqlite implementation (swappable)
  events/   in-process EventBus (engine → SSE)
  api/      Fastify routes (REST + SSE)
frontend/   Next.js (App Router) + Tailwind
  /                 dashboard: desired↔actual overview, scan trigger, run history, simulate-drift
  /runs/[id]        live run view: progress, drift table, reconcile controls
```

The **engine is decoupled from HTTP**. It mutates state through the `Store` interface and
announces every transition on an in-process `EventBus`. The HTTP layer is a thin adapter:
REST issues commands / reads state, SSE subscribes to the bus. The core logic is testable
without a server.

### Why these choices

- **Node's built-in `node:sqlite`** — a real relational store, zero native build, zero npm
  dependency, file-based so all state survives restart. The "state management" criterion
  taken seriously: desired + actual inventories, runs, drift items, and an append-only
  event log are all durable.
- **Server-Sent Events** for live progress — one-way server→client streaming is exactly
  what a scan/reconcile progress feed needs, and far simpler than WebSockets. State stays
  fully queryable over REST, so the UI works even if the stream drops.
- **Event replay + live tail** — on SSE connect the server replays the run's persisted
  events, then streams new ones, so a refresh or late subscriber still sees full history.

## Data model (SQLite)

- **desired_resources** — `address, type, properties (json), updated_at`. The declared config.
- **actual_resources** — `address, type, properties (json), present (bool), updated_at`. The
  mock cloud's live state; what reconcile mutates and rollback-of-drift converges.
- **runs** — `id, kind (scan|reconcile), status (running|completed|failed), scan_id (for
  reconciles), started_at, finished_at, summary (json)`.
- **drift_items** — `id, scan_id, address, type, classification, desired (json), actual
  (json), diff (json), reconcile_action, reconcile_status`.
- **events** — append-only feed: `id, run_id, level (info|warn|error), stage, message,
  created_at`. Drives SSE replay *and* the audit trail.

## State management & failure handling

- **Durable runs:** a scan or reconcile is persisted before work starts; progress and
  every event are written as they happen, so the full run is reconstructable from the DB
  alone.
- **Partial-failure reconcile:** each drift item is applied independently. A failure on one
  (the protected resource) marks that item failed and continues; the run ends `completed`
  with a partial summary rather than aborting — the safe behavior for a reconciler.
- **Crash recovery:** on boot, a reconciler marks orphaned `running` runs (server died
  mid-run) as `failed` with an explanatory event.

## Key trade-offs

- **Mocked cloud, real loop.** The value is the detect→diff→reconcile engine, not a real
  provider. `MockCloud` keeps an in-DB live state that genuinely changes, so reconciliation
  and drift are observable and meaningful.
- **Drift as a domain action, not a debug toggle.** "Simulate out-of-band change" mirrors
  what actually causes drift, keeping the demo realistic and operator-driven.
- **Property-bag resources, not a typed provider schema.** Resources are generic
  `type + properties` maps rather than a faithful AWS schema. This keeps classification and
  diffing general and the scope contained, while still modeling real drift scenarios
  (a bucket going public, an instance resized, a rule added).
- **SSE optimization, REST source of truth.** The stream is an optimization; every view can
  be reconstructed from REST alone.

See [README.md](../README.md) for setup and the "what's next" section.
