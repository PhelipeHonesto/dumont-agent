/**
 * WebSocket hook for real-time Mission Control updates.
 * Auto-reconnects with exponential backoff. Supports mock mode.
 * Per spec: communication-layer.md section 3.4.
 */

import { useState, useCallback, useRef, useEffect } from "react";

export interface DashboardEvent {
  type: string;
  [key: string]: unknown;
}

type EventHandler = (event: DashboardEvent) => void;

interface UseWebSocketReturn {
  connected: boolean;
  lastEvent: DashboardEvent | null;
  on: (type: string, handler: EventHandler) => void;
  off: (type: string, handler: EventHandler) => void;
  /** Mock mode: inject an event programmatically. */
  emit: (event: DashboardEvent) => void;
}

/**
 * WebSocket hook with auto-reconnect and typed events.
 * @param url - WebSocket URL (null for mock-only mode).
 */
export function useWebSocket(url: string | null = null): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<DashboardEvent | null>(null);
  const handlers = useRef(new Map<string, Set<EventHandler>>());
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);

  const dispatch = useCallback((event: DashboardEvent) => {
    setLastEvent(event);
    const typeHandlers = handlers.current.get(event.type);
    if (typeHandlers) {
      for (const h of typeHandlers) h(event);
    }
    // Also fire "all" handlers
    const allHandlers = handlers.current.get("*");
    if (allHandlers) {
      for (const h of allHandlers) h(event);
    }
  }, []);

  const connect = useCallback(() => {
    if (!url || typeof WebSocket === "undefined") return;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); retryRef.current = 0; };
      ws.onclose = () => {
        setConnected(false);
        const delay = Math.min(1000 * 2 ** retryRef.current, 30000);
        retryRef.current++;
        setTimeout(connect, delay);
      };
      ws.onmessage = (e) => {
        try { dispatch(JSON.parse(e.data)); } catch { /* malformed */ }
      };
    } catch { /* connection failed — retry handles it */ }
  }, [url, dispatch]);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  const on = useCallback((type: string, handler: EventHandler) => {
    if (!handlers.current.has(type)) handlers.current.set(type, new Set());
    handlers.current.get(type)!.add(handler);
  }, []);

  const off = useCallback((type: string, handler: EventHandler) => {
    handlers.current.get(type)?.delete(handler);
  }, []);

  return { connected, lastEvent, on, off, emit: dispatch };
}
