"use client";

import { useEffect, useRef } from "react";
import type { RunEvent } from "@orchestrator/shared";

const LEVEL_COLOR: Record<RunEvent["level"], string> = {
  info: "text-slate-300",
  warn: "text-amber-300",
  error: "text-rose-400",
};

/** Auto-scrolling, terminal-style live log of a run's events. */
export function EventConsole({ events, live }: { events: RunEvent[]; live: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <span className="text-xs font-medium text-slate-400">activity log</span>
        {live && (
          <span className="flex items-center gap-1 text-xs text-sky-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            live
          </span>
        )}
      </div>
      <div className="scroll-thin max-h-72 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {events.length === 0 && <div className="text-slate-500">waiting for events…</div>}
        {events.map((e) => (
          <div key={e.id} className="flex gap-2">
            <span className="shrink-0 text-slate-600">
              {new Date(e.createdAt).toLocaleTimeString()}
            </span>
            <span className="shrink-0 text-slate-500">[{e.stage}]</span>
            <span className={LEVEL_COLOR[e.level]}>{e.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
