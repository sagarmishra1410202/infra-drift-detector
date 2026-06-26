"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DriftItem, Run, RunEvent } from "@orchestrator/shared";
import { api } from "./api";

interface StreamMessage {
  type: "run" | "event" | "done" | "error";
  run?: Run;
  event?: RunEvent;
}

/**
 * Live view of a single run. Seeds from REST (so a refresh shows full history),
 * then follows the SSE stream for live status + event tail. Drift-item statuses
 * are re-fetched when a per-resource (address) event arrives and once on done —
 * REST stays the source of truth, the stream is the live nudge.
 */
export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [items, setItems] = useState<DriftItem[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const refreshItems = useCallback(async () => {
    try {
      const detail = await api.run(id);
      setItems(detail.items);
      setRun((prev) => prev ?? detail.run);
    } catch {
      /* transient; stream will catch us up */
    }
  }, [id]);

  useEffect(() => {
    let closed = false;
    setRun(null);
    setItems([]);
    setEvents([]);
    setDone(false);

    // Initial snapshot from REST.
    api
      .run(id)
      .then((detail) => {
        if (closed) return;
        setRun(detail.run);
        setItems(detail.items);
        setEvents(detail.events);
        if (detail.run.status !== "running") setDone(true);
      })
      .catch(() => {});

    // Live tail via SSE.
    const es = new EventSource(api.eventsUrl(id));
    esRef.current = es;
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as StreamMessage;
      if (msg.type === "run" && msg.run) {
        setRun(msg.run);
      } else if (msg.type === "event" && msg.event) {
        const event = msg.event;
        setEvents((prev) =>
          prev.some((x) => x.id === event.id)
            ? prev
            : [...prev, event].sort((a, b) => a.id - b.id),
        );
        // Address-scoped events mean an item's reconcile status just changed.
        if (event.stage.includes(".")) void refreshItems();
      } else if (msg.type === "done" && msg.run) {
        setRun(msg.run);
        setDone(true);
        void refreshItems();
        es.close();
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; if the server already ended the stream
      // (run done), we've closed it ourselves above.
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [id, refreshItems]);

  return { run, items, events, done };
}
