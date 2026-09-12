import { supabase } from "@/integrations/supabase/client";

const SW_PATH = "/model-cache-sw.js";
const LS_KEY = "easyvc.hfToken";

/** Register the model-cache service worker (idempotent, best-effort). */
export async function registerModelCache(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (e) {
    console.warn("model-cache service worker not registered:", e);
    return null;
  }
}

/** Hand the HF token to the worker so it can authenticate gated downloads it intercepts. */
export async function sendHfTokenToServiceWorker(token: string | null): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  const reg = await registerModelCache();
  const sw = reg?.active ?? navigator.serviceWorker.controller;
  if (!sw) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 2000);
    channel.port1.onmessage = () => { clearTimeout(timer); resolve(true); };
    sw.postMessage({ type: "SET_HF_TOKEN", token }, [channel.port2]);
  });
}

/** User-supplied token, kept only in this browser. */
export const getStoredHfToken = (): string | null => { try { return localStorage.getItem(LS_KEY); } catch { return null; } };
export const setStoredHfToken = (token: string | null) => { try { token ? localStorage.setItem(LS_KEY, token) : localStorage.removeItem(LS_KEY); } catch { /* private mode */ } };

/** Workspace-level token from the get-hf-token function, if the operator configured one. */
export async function fetchServerHfToken(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-hf-token`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()).token ?? null;
  } catch { return null; }
}

/** Prefer the user's own token, then the workspace one. */
export async function resolveHfToken(): Promise<string | null> {
  return getStoredHfToken() ?? (await fetchServerHfToken());
}

export async function modelCacheUsage(): Promise<{ bytes: number; entries: number }> {
  if (typeof caches === "undefined") return { bytes: 0, entries: 0 };
  let bytes = 0, entries = 0;
  for (const name of await caches.keys()) {
    if (!/model|webllm|transformers|mediapipe/i.test(name)) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      entries++;
      const res = await cache.match(req);
      bytes += Number(res?.headers.get("content-length") ?? 0);
    }
  }
  return { bytes, entries };
}

export async function clearModelCache(): Promise<number> {
  if (typeof caches === "undefined") return 0;
  let n = 0;
  for (const name of await caches.keys()) {
    if (/model|webllm|transformers|mediapipe/i.test(name)) { await caches.delete(name); n++; }
  }
  return n;
}
