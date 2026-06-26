import type {
  DriftClassification,
  ReconcileItemStatus,
  RunStatus,
} from "@orchestrator/shared";
import {
  CLASSIFICATION_LABEL,
  CLASSIFICATION_STYLE,
  RECONCILE_STATUS_STYLE,
  RUN_STATUS_STYLE,
} from "@/lib/ui";

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function ClassificationBadge({ value }: { value: DriftClassification }) {
  return <Chip className={CLASSIFICATION_STYLE[value]}>{CLASSIFICATION_LABEL[value]}</Chip>;
}

export function RunStatusBadge({ value }: { value: RunStatus }) {
  return (
    <Chip className={RUN_STATUS_STYLE[value]}>
      {value === "running" && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {value}
    </Chip>
  );
}

export function ReconcileStatusBadge({ value }: { value: ReconcileItemStatus }) {
  return <Chip className={RECONCILE_STATUS_STYLE[value]}>{value}</Chip>;
}
