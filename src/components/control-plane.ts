"use client";
import { useCallback, useEffect, useState } from "react";
import type { Snapshot } from "../contracts";
const empty: Snapshot = {
  orders: [],
  stock: [],
  totals: {
    total: 0,
    fulfilled: 0,
    cancelled: 0,
    dead: 0,
    processing: 0,
    refunded: 0,
    revenue: 0,
    latency: 0,
  },
  series: Array(48).fill(0),
  services: [],
  provider: "mock",
  faultInjection: false,
  inventoryAvailable: false,
  publishableKey: "",
  time: 0,
};
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
export function useControlPlane(live: boolean, hours: number) {
  const [state, setState] = useState<Snapshot>(empty),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await api<Snapshot>(`state?hours=${hours}`);
      setState(data);
      setError("");
      setConnected(true);
    } catch (e) {
      setError((e as Error).message);
      setConnected(false);
    }
  }, [hours]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!live) return;
    const stream = new EventSource("/api/events");
    let busy = false;
    const change = async () => {
      if (busy) return;
      busy = true;
      await refresh();
      busy = false;
    };
    stream.addEventListener("change", change);
    stream.onerror = () => setConnected(false);
    return () => {
      stream.close();
    };
  }, [live, refresh]);
  return { state, error, connected, refresh };
}
