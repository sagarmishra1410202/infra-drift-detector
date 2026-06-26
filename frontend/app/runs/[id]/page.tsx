"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  defaultAction,
  type ReconcileAction,
  type ReconcileRequestItem,
  type Run,
} from "@orchestrator/shared";
import { api } from "@/lib/api";
import { useRun } from "@/lib/useRun";
import { DriftTable } from "@/components/DriftTable";
import { EventConsole } from "@/components/EventConsole";
import { RunStatusBadge } from "@/components/badges";

const SCAN_STAGES = ["load-desired", "refresh-actual", "classify", "summarize"];

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { run, items, events, done } = useRun(id);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unmanagedAction, setUnmanagedAction] = useState<ReconcileAction>("delete");
  const [submitting, setSubmitting] = useState(false);

  const actionable = useMemo(() => items.filter((i) => i.classification !== "in_sync"), [items]);

  const toggle = (address: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(address) ? next.delete(address) : next.add(address);
      return next;
    });

  const buildRequests = (addresses: string[]): ReconcileRequestItem[] =>
    actionable
      .filter((i) => addresses.includes(i.address))
      .map((i) => ({
        address: i.address,
        action: i.classification === "unmanaged" ? unmanagedAction : defaultAction(i.classification),
      }));

  const reconcile = async (addresses: string[]) => {
    if (addresses.length === 0) return;
    setSubmitting(true);
    try {
      const { run: recRun } = await api.reconcile(id, buildRequests(addresses));
      router.push(`/runs/${recRun.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!run) {
    return <div className="text-sm text-slate-400">Loading run…</div>;
  }

  const isScan = run.kind === "scan";
  const live = run.status === "running" && !done;

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-slate-500 hover:underline">
        ← Dashboard
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-xl font-semibold text-slate-900">{run.id}</h1>
            <RunStatusBadge value={run.status} />
            <span className="text-xs uppercase tracking-wide text-slate-400">{run.kind}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            <RunHeadline run={run} />
          </p>
          {run.kind === "reconcile" && run.scanId && (
            <Link href={`/runs/${run.scanId}`} className="text-xs text-sky-600 hover:underline">
              ← from scan {run.scanId}
            </Link>
          )}
        </div>
      </div>

      {/* Scan stage strip */}
      {isScan && <StageStrip events={events} done={done} />}

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Left: drift / reconcile table */}
        <div className="space-y-4 lg:col-span-3">
          {isScan ? (
            <>
              <DriftTable
                items={items}
                selectable
                selected={selected}
                onToggle={toggle}
                showReconcile={items.some((i) => i.reconcileStatus)}
              />
              {actionable.length > 0 && (
                <ReconcilePanel
                  selectedCount={selected.size}
                  actionableCount={actionable.length}
                  unmanagedAction={unmanagedAction}
                  hasUnmanaged={actionable.some((i) => i.classification === "unmanaged")}
                  submitting={submitting}
                  onUnmanagedActionChange={setUnmanagedAction}
                  onReconcileSelected={() => reconcile([...selected])}
                  onReconcileAll={() => reconcile(actionable.map((i) => i.address))}
                />
              )}
            </>
          ) : (
            <DriftTable items={items.filter((i) => i.reconcileStatus)} showReconcile />
          )}
        </div>

        {/* Right: live console */}
        <div className="lg:col-span-2">
          <EventConsole events={events} live={live} />
        </div>
      </div>
    </div>
  );
}

function RunHeadline({ run }: { run: Run }) {
  if (!run.summary) return <span>in progress…</span>;
  if (run.kind === "scan" && "drifted" in run.summary) {
    const s = run.summary;
    return (
      <span>
        {s.total} resources — <b className="text-emerald-600">{s.inSync}</b> in sync,{" "}
        <b className="text-amber-600">{s.drifted}</b> drifted,{" "}
        <b className="text-rose-600">{s.missing}</b> missing,{" "}
        <b className="text-violet-600">{s.unmanaged}</b> unmanaged
      </span>
    );
  }
  if ("reconciled" in run.summary) {
    const s = run.summary;
    return (
      <span>
        {s.total} targeted — <b className="text-emerald-600">{s.reconciled}</b> reconciled,{" "}
        <b className="text-rose-600">{s.failed}</b> failed
        {s.failed > 0 && " (protected resources need a manual change ticket)"}
      </span>
    );
  }
  return <span>—</span>;
}

function StageStrip({
  events,
  done,
}: {
  events: { stage: string }[];
  done: boolean;
}) {
  const seen = new Set(events.map((e) => e.stage));
  const lastSeen = [...SCAN_STAGES].reverse().find((s) => seen.has(s));
  return (
    <div className="flex items-center gap-2">
      {SCAN_STAGES.map((stage, i) => {
        const reached = seen.has(stage);
        const active = !done && stage === lastSeen;
        return (
          <div key={stage} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                active
                  ? "border-sky-300 bg-sky-50 text-sky-700"
                  : reached
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-400"
              }`}
            >
              {active ? (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              ) : reached ? (
                <span>✓</span>
              ) : (
                <span className="text-slate-300">○</span>
              )}
              {stage}
            </div>
            {i < SCAN_STAGES.length - 1 && <span className="text-slate-300">→</span>}
          </div>
        );
      })}
    </div>
  );
}

function ReconcilePanel({
  selectedCount,
  actionableCount,
  unmanagedAction,
  hasUnmanaged,
  submitting,
  onUnmanagedActionChange,
  onReconcileSelected,
  onReconcileAll,
}: {
  selectedCount: number;
  actionableCount: number;
  unmanagedAction: ReconcileAction;
  hasUnmanaged: boolean;
  submitting: boolean;
  onUnmanagedActionChange: (a: ReconcileAction) => void;
  onReconcileSelected: () => void;
  onReconcileAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span>
          {actionableCount} resource{actionableCount === 1 ? "" : "s"} need attention
        </span>
        {hasUnmanaged && (
          <label className="flex items-center gap-1.5">
            <span>unmanaged →</span>
            <select
              value={unmanagedAction}
              onChange={(e) => onUnmanagedActionChange(e.target.value as ReconcileAction)}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs"
            >
              <option value="delete">delete from cloud</option>
              <option value="import">import to desired</option>
            </select>
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onReconcileSelected}
          disabled={submitting || selectedCount === 0}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
        >
          Reconcile selected ({selectedCount})
        </button>
        <button
          onClick={onReconcileAll}
          disabled={submitting}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          Reconcile all →
        </button>
      </div>
    </div>
  );
}
