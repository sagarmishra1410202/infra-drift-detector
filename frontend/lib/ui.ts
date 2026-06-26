import type {
  DriftClassification,
  ReconcileItemStatus,
  RunStatus,
} from "@orchestrator/shared";

/** Tailwind classes for a drift classification chip. */
export const CLASSIFICATION_STYLE: Record<DriftClassification, string> = {
  in_sync: "bg-emerald-100 text-emerald-700 border-emerald-200",
  drifted: "bg-amber-100 text-amber-800 border-amber-200",
  missing: "bg-rose-100 text-rose-700 border-rose-200",
  unmanaged: "bg-violet-100 text-violet-700 border-violet-200",
};

export const CLASSIFICATION_LABEL: Record<DriftClassification, string> = {
  in_sync: "in sync",
  drifted: "drifted",
  missing: "missing",
  unmanaged: "unmanaged",
};

export const RUN_STATUS_STYLE: Record<RunStatus, string> = {
  running: "bg-sky-100 text-sky-700 border-sky-200",
  completed: "bg-emerald-100 text-emerald-700 border-emerald-200",
  failed: "bg-rose-100 text-rose-700 border-rose-200",
};

export const RECONCILE_STATUS_STYLE: Record<ReconcileItemStatus, string> = {
  pending: "bg-slate-100 text-slate-500 border-slate-200",
  applying: "bg-sky-100 text-sky-700 border-sky-200",
  reconciled: "bg-emerald-100 text-emerald-700 border-emerald-200",
  failed: "bg-rose-100 text-rose-700 border-rose-200",
  skipped: "bg-slate-100 text-slate-400 border-slate-200",
};

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatProps(props: Record<string, unknown>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}
