# Architecture Overview

## Use case & rationale

**Deployment orchestration with promotion + rollback.**

Promoting a new version of a service to production is the single most common place
operators cause outages. The pain isn't running a deploy command — it's the lack of
*visibility* (what step are we on? why did it fail?), the lack of a *safe gate* before
the irreversible jump to prod, and the lack of *automatic recovery* when a bad build
slips through. Most teams paper over this with a pile of opaque shell scripts.

This tool models that workflow as a first-class, observable **state machine**: an
operator triggers a deployment, watches every stage advance live, approves the
production promotion by hand, and — when a broken build fails its smoke test — watches
the system automatically roll the environment back to the last known-good version.

It is deliberately **small but complete**: one workflow, executed thoroughly, with real
state management, real failure handling, and a UI an operator would actually use. All
infrastructure is mocked locally — no cloud account, no API keys.

## The workflow

A fixed **promotion pipeline** runs as an ordered state machine:

```
build → test → deploy(staging) → smoke(staging) → [approval gate] → promote(prod) → smoke(prod)
```

- Stages run one at a time, each emitting streamed log lines and taking a realistic
  moment so progress is *visibly* observable.
- At the **approval gate** the engine suspends (durably, in the DB) until an operator
  approves or rejects.
- A version can be a **broken build**. A broken build fails `smoke(staging)`, which
  triggers a **compensating rollback**: the environment's live state is reverted to the
  `previous_version` captured before the deploy, and the run ends as `rolled_back`.

### Three demonstrable paths

| Path | Trigger | Outcome |
|------|---------|---------|
| ✅ Success | deploy a healthy version, approve the gate | promoted to prod, `succeeded` |
| 🔁 Rollback | deploy a broken version | staging smoke fails → auto-revert → `rolled_back` |
| 🛑 Rejection | deploy a healthy version, reject the gate | `rejected`, staging left on the new healthy version |

## System design

Clean separation between **UI**, **API**, and **engine**, in an npm-workspaces monorepo:

```
shared/     TypeScript types + pipeline stage constants (imported by both sides)
backend/    Fastify API + orchestration engine + SQLite store
  domain/   pipeline definition + the state machine (engine) — pure, unit-tested
  infra/    MockInfra: per-environment live state, deploy() / healthCheck()
  store/    Store interface + node:sqlite implementation (swappable)
  events/   in-process EventBus (engine → SSE)
  api/      Fastify routes (REST + SSE)
frontend/   Next.js (App Router) + Tailwind
  /             dashboard: trigger, live env state, deployment history
  /deployments/[id]   live pipeline stepper, streamed logs, approval controls
```

The **engine is decoupled from HTTP**. It mutates state through the `Store` interface
and announces every transition on an in-process `EventBus`. The HTTP layer is a thin
adapter: REST endpoints issue commands and read state; the SSE endpoint subscribes to
the bus. This keeps the core logic testable without spinning up a server.

### Why these choices

- **Node's built-in `node:sqlite`** for persistence — a real relational store with zero
  native build and zero npm dependency, file-based so state survives restarts. This is
  the "state management" criterion taken seriously: deployment runs, per-stage status,
  an append-only event log, and the mock infra's live state are all durable.
- **Server-Sent Events** for live progress — one-way server→client streaming is exactly
  what a progress feed needs, and it's far simpler than WebSockets. State remains fully
  queryable over REST, so the UI works even if the stream drops.
- **Event replay + live tail** — on SSE connect the server replays persisted events for
  the run, then streams new ones. A late subscriber (or a page refresh) still sees the
  full history, not just events that happened to fire after connecting.

## Data model (SQLite)

- **deployments** — `id, service_id, version, status, current_stage, previous_version,
  created_at, started_at, finished_at`.
  `status ∈ pending | running | awaiting_approval | succeeded | failed | rolled_back | rejected`
- **stage_runs** — one row per stage instance: `deployment_id, key, status, started_at,
  finished_at, attempts`.
- **events** — append-only audit/log feed: `deployment_id, stage_key, type
  (log | transition | status), message, created_at`. Drives SSE replay *and* the audit trail.
- **env_state** — the mock infra source of truth: `(environment, service_id) → version,
  healthy`. This is what rollback reverts.

## State management & failure handling

- **Suspend / resume across requests:** the approval gate persists `awaiting_approval`
  and stops the loop. A later `POST /approve` resumes the state machine from the gate;
  `POST /reject` terminates it. The pause survives a full server restart.
- **Compensating rollback:** failures *after* an environment mutation revert that
  environment to its previous version. Failures *before* any mutation (build/test) simply
  end as `failed` — there is nothing to compensate.
- **Crash recovery:** on boot a reconciler marks orphaned `running` deployments (a server
  died mid-run) as `failed` with an explanatory event. `awaiting_approval` runs are a
  legitimate durable state and are left intact.

## Key trade-offs

- **Mocked infra, real workflow.** The value is the orchestration engine, not a real
  deployer. `MockInfra` keeps an in-DB live state that genuinely changes, so rollback is
  observable and meaningful.
- **Failure as a domain property, not a debug toggle.** Rather than an artificial
  "force-fail" switch, a *version* can be a broken build — operators really do ship bad
  RC builds. This keeps the failure path realistic and operator-driven.
- **Fixed pipeline.** A single staging→prod promotion pipeline, not a configurable DAG.
  A user-defined workflow engine is a much larger problem; one well-modeled pipeline
  demonstrates the same state/failure/visibility concerns without the sprawl.
- **Polling-free UI via SSE, but REST is the source of truth.** The stream is an
  optimization; every view can be reconstructed from REST alone.

See [README.md](../README.md) for setup and the "what's next" section.
