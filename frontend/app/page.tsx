"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  classify,
  summarizeScan,
  type DriftItem,
  type Run,
  type SimulateKind,
} from "@orchestrator/shared";
import { api, type StateResponse } from "@/lib/api";
import { DriftTable } from "@/components/DriftTable";
import { RunStatusBadge } from "@/components/badges";
import { timeAgo } from "@/lib/ui";

/** Build a live, client-side drift snapshot from desired+actual using the shared classifier. */
function buildItems(state: StateResponse): DriftItem[] {
  const desired = new Map(state.desired.map((r) => [r.address, r]));
  const actual = new Map(state.actual.map((r) => [r.address, r]));
  const addresses = [...new Set([...desired.keys(), ...actual.keys()])].sort();
  return addresses.map((address) => {
    const d = desired.get(address) ?? null;
    const a = actual.get(address) ?? null;
    const { classification, diff } = classify(d, a);
    return { address, type: (d ?? a)!.type, classification, desired: d, actual: a, diff };
  });
}

const SIMULATIONS: { kind: SimulateKind; label: string }[] = [
  { kind: "mutate", label: "Mutate a property" },
  { kind: "delete", label: "Delete a resource" },
  { kind: "create", label: "Add untracked resource" },
];

export default function Dashboard() {
  const router = useRouter();
  const [state, setState] = useState<StateResponse | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([api.state(), api.runs()]);
    setState(s);
    setRuns(r);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => (state ? buildItems(state) : []), [state]);
  const summary = useMemo(() => summarizeScan(items), [items]);
  const hasDrift = summary.drifted + summary.missing + summary.unmanaged > 0;

  const onScan = async () => {
    setBusy(true);
    try {
      const { run } = await api.startScan();
      router.push(`/runs/${run.id}`);
    } finally {
      setBusy(false);
    }
  };

  const onSimulate = async (kind: SimulateKind) => {
    setBusy(true);
    try {
      const res = await api.simulate(kind);
      setMessage(res.message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setBusy(true);
    try {
      await api.reset();
      setMessage("State reset to the seeded baseline.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Hero / actions */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Desired vs. actual state</h1>
            <p className="mt-1 text-sm text-slate-500">
              A live comparison of your declared config against the mock cloud. Run a scan to
              record an auditable, streamed run — then reconcile the drift.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onScan}
              disabled={busy}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-50"
            >
              Run scan →
            </button>
            <button
              onClick={onReset}
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </div>

        <SummaryChips summary={summary} />

        {message && (
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            {message}
          </div>
        )}
      </section>

      {/* Simulate drift */}
      <section className="rounded-lg border border-dashed border-slate-300 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Simulate an out-of-band change</h2>
            <p className="text-xs text-slate-500">
              Perturb the live cloud the way a human or a broken automation would, then re-scan to
              watch the new drift appear.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {SIMULATIONS.map((s) => (
              <button
                key={s.kind}
                onClick={() => onSimulate(s.kind)}
                disabled={busy}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Live drift table */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Current drift {hasDrift ? "" : "— all in sync"}
          </h2>
        </div>
        {state ? (
          <DriftTable items={items} />
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-400">
            Loading state…
          </div>
        )}
      </section>

      {/* Run history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Run history</h2>
        {runs.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-400">
            No runs yet. Run a scan to get started.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {runs.map((run) => (
                  <tr key={run.id} className="transition hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link href={`/runs/${run.id}`} className="font-mono text-xs text-slate-700 hover:underline">
                        {run.id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs uppercase tracking-wide text-slate-400">
                      {run.kind}
                    </td>
                    <td className="px-3 py-2">
                      <RunStatusBadge value={run.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      <RunSummaryText run={run} />
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-slate-400">
                      {timeAgo(run.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryChips({ summary }: { summary: ReturnType<typeof summarizeScan> }) {
  const chips = [
    { label: "total", value: summary.total, cls: "text-slate-700" },
    { label: "in sync", value: summary.inSync, cls: "text-emerald-600" },
    { label: "drifted", value: summary.drifted, cls: "text-amber-600" },
    { label: "missing", value: summary.missing, cls: "text-rose-600" },
    { label: "unmanaged", value: summary.unmanaged, cls: "text-violet-600" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {chips.map((c) => (
        <div key={c.label} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className={`text-2xl font-semibold ${c.cls}`}>{c.value}</div>
          <div className="text-xs uppercase tracking-wide text-slate-400">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function RunSummaryText({ run }: { run: Run }) {
  if (!run.summary) return <span>—</span>;
  if (run.kind === "scan" && "drifted" in run.summary) {
    const s = run.summary;
    return (
      <span>
        {s.drifted} drifted · {s.missing} missing · {s.unmanaged} unmanaged
      </span>
    );
  }
  if ("reconciled" in run.summary) {
    const s = run.summary;
    return (
      <span>
        {s.reconciled} reconciled · {s.failed} failed · {s.skipped} skipped
      </span>
    );
  }
  return <span>—</span>;
}
