import type { DriftItem } from "@orchestrator/shared";
import { ClassificationBadge, ReconcileStatusBadge } from "./badges";

function DiffCell({ item }: { item: DriftItem }) {
  if (item.classification === "in_sync") return <span className="text-slate-300">—</span>;
  if (item.classification === "missing")
    return <span className="text-rose-600">declared in desired, absent from cloud</span>;
  if (item.classification === "unmanaged")
    return <span className="text-violet-600">present in cloud, not declared</span>;
  return (
    <div className="space-y-0.5">
      {item.diff.map((d) => (
        <div key={d.key} className="font-mono text-xs">
          <span className="text-slate-500">{d.key}:</span>{" "}
          <span className="text-emerald-600">{String(d.desired)}</span>
          <span className="text-slate-400"> → </span>
          <span className="text-amber-600">{String(d.actual)}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  items: DriftItem[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (address: string) => void;
  showReconcile?: boolean;
}

export function DriftTable({ items, selectable, selected, onToggle, showReconcile }: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            {selectable && <th className="w-8 px-3 py-2" />}
            <th className="px-3 py-2 font-medium">Resource</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Difference</th>
            {showReconcile && <th className="px-3 py-2 font-medium">Reconcile</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => {
            const actionable = item.classification !== "in_sync";
            const isSelected = selected?.has(item.address) ?? false;
            return (
              <tr key={item.address} className={isSelected ? "bg-sky-50/50" : undefined}>
                {selectable && (
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-slate-800 disabled:opacity-30"
                      disabled={!actionable}
                      checked={isSelected}
                      onChange={() => onToggle?.(item.address)}
                    />
                  </td>
                )}
                <td className="px-3 py-2 align-top">
                  <div className="font-mono text-xs font-medium text-slate-800">{item.address}</div>
                  <div className="text-xs text-slate-400">{item.type}</div>
                </td>
                <td className="px-3 py-2 align-top">
                  <ClassificationBadge value={item.classification} />
                </td>
                <td className="px-3 py-2 align-top text-slate-600">
                  <DiffCell item={item} />
                </td>
                {showReconcile && (
                  <td className="px-3 py-2 align-top">
                    {item.reconcileStatus ? (
                      <ReconcileStatusBadge value={item.reconcileStatus} />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
