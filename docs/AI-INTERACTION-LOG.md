# AI Interaction Log

This project was built collaboratively with an AI engineering assistant (Claude Code).
This document is the **curated decision log**: what was directed vs. delegated, where the
direction changed, and how AI-generated output was iterated on and course-corrected.

> The full raw transcript of the session(s) is available as a separate export and can be
> attached alongside this repo. The git history (`git log`) is the other half of the story —
> each commit corresponds to a deliberate step below.

---

## How the work was directed

**Process, not just prompts.** Rather than asking the AI to "build a tool," the session
started by treating the use-case *choice* as the most important decision (the assessment
weights it heavily) and worked through it as a structured brainstorm — options with
trade-offs and a recommendation — before any code was written.

### 1. Use-case selection (directed by me, with several course-corrections)

- The AI proposed a menu of platform-engineering use cases with a recommendation.
- **First pick:** deployment orchestration + TypeScript end-to-end.
- **Course-correction:** I pushed back — "we want to solve a *practical* infrastructure
  issue" — and asked for more options. The AI produced two further rounds of fresh ideas
  (drift detection, DB migration runner, DR backup-drill, provisioning saga; then rolling
  fleet patching, policy-as-code gates, self-healing, chaos runner).
- **Final decision:** **infrastructure drift detection & reconciliation** — which had been
  the AI's original top recommendation. The lesson the AI took: surface the strongest
  recommendation clearly, but let the human's judgment about "real vs. tutorial" drive.

The AI's design docs and `package.json` were re-pointed from the abandoned
deployment-orchestration framing to drift detection (visible in the git history as an
honest pivot, not a rewrite of history).

### 2. Scoping (directed by me via multiple-choice, recommended by AI)

I made the high-level calls; the AI framed each with a recommendation and rationale:

- **Persistence:** SQLite via Node's built-in `node:sqlite` (zero deps, survives restart) —
  chosen over a JSON file or in-memory because "state management" is explicitly graded.
- **Live updates:** Server-Sent Events (the AI recommended this over WebSockets and I went
  with it).
- **Failure handling:** I declined an artificial "failure-injection toggle." The AI flagged
  that rollback/partial-failure then has nothing to trigger it, and *proposed reframing
  failure as a domain property* — a **protected resource** that legitimately can't be
  auto-reconciled, plus a first-class "simulate out-of-band change." I accepted this; it's a
  more realistic design than a debug switch.

### 3. Architecture & implementation (delegated to AI)

I delegated the system design and all implementation:

- Monorepo layering (`shared` / `backend` / `frontend`), the `Store` interface, the
  `MockCloud` provider, the `EventBus` seam that keeps the engine ignorant of HTTP, the
  scan/reconcile state machines, the REST + SSE API, and the Next.js operator UI.
- The AI worked in **small, meaningful commits** (scaffolding → shared domain → persistence
  → engine + tests → API → frontend → docs), each with a descriptive message.

---

## Where AI output was iterated on / corrected

Three real problems surfaced during the build and were debugged, not papered over:

1. **`node:sqlite` vs. the test runner.** The first test setup used Vitest, which (via Vite)
   didn't recognize the too-new `node:sqlite` builtin and tried to bundle it, failing with
   `Failed to load url sqlite`. After an `external` config attempt didn't take, the AI
   **dropped Vitest entirely** in favor of Node's built-in test runner (`node --test` via
   `tsx`) — which runs in the real Node runtime where `node:sqlite` just works, and is a
   cleaner signal anyway. All 8 tests pass.

2. **Empty-body POST → 400.** The browser walkthrough hit a "Bad Request" runtime error on
   *Run scan*. Root cause: the API client sent `content-type: application/json` on every
   request, but a bodyless POST then has an empty JSON body, which Fastify rejects as 400.
   (The earlier `curl` smoke test passed precisely because curl sent no content-type — a good
   reminder that browser and curl differ.) Fixed by only sending the header when there's a body.

3. **Port already in use.** Port 3000 was held by an unrelated pre-existing server on the dev
   machine. Rather than kill someone else's process, the AI ran the frontend on 3005 for
   verification and left the documented default at 3000 (correct for a clean eval machine).

## How "done" was verified (not asserted)

- **Engine unit tests** (`node:test`): classification of every drift class, exact diffing,
  reconcile convergence, the protected-resource partial failure, `import` vs `delete`, and
  crash recovery.
- **API smoke test** (`curl`): scan → reconcile-all → re-scan, asserting the summaries.
- **Full browser walkthrough** (Playwright): ran the actual UI through scan (live SSE
  progress), reconcile (5 reconciled / 1 protected fails gracefully), convergence on the
  dashboard (5 in sync, 1 still drifted), and simulate-drift (a new unmanaged resource
  appears). Screenshots in [images/](images/).

## Takeaways on the collaboration

- The human's highest-leverage input was **choosing and re-choosing the problem** — the AI's
  job was to make those choices well-informed and then execute thoroughly.
- The AI added the most value in **design framing** (turning "rollback needs a trigger" into a
  realistic domain model) and in **disciplined debugging** (chasing the 400 to its real cause
  rather than working around it).
- Verification was treated as evidence, not vibes: tests, curl, and a real browser session.
