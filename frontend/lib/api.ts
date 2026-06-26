import type {
  DriftItem,
  ReconcileRequestItem,
  Resource,
  Run,
  RunEvent,
  SimulateKind,
} from "@orchestrator/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a body — an empty
  // body with content-type: application/json makes Fastify reject it as 400.
  const headers = init?.body ? { "content-type": "application/json" } : undefined;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface StateResponse {
  desired: Resource[];
  actual: Resource[];
}

export interface RunDetail {
  run: Run;
  items: DriftItem[];
  events: RunEvent[];
}

export const api = {
  state: () => request<StateResponse>("/api/state"),
  runs: () => request<Run[]>("/api/runs"),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  startScan: () => request<{ run: Run }>("/api/scans", { method: "POST" }),
  reconcile: (scanId: string, items?: ReconcileRequestItem[]) =>
    request<{ run: Run }>("/api/reconciles", {
      method: "POST",
      body: JSON.stringify({ scanId, items }),
    }),
  simulate: (kind: SimulateKind) =>
    request<{ kind: SimulateKind; address: string; message: string }>("/api/simulate", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),
  reset: () => request<{ ok: boolean }>("/api/reset", { method: "POST" }),
  eventsUrl: (id: string) => `${API_BASE}/api/runs/${id}/events`,
};
