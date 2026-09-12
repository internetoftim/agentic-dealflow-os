// Model-cache service worker.
//  1. Caches model weights (Cache API) so a second load is instant and offline.
//  2. Injects a Hugging Face token on gated downloads — Gemma builds are gated
//     and the MediaPipe runtime fetches them itself, outside our code.
const CACHE = "easyvc-model-cache-v1";
const CACHEABLE_HOSTS = ["huggingface.co", "hf.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "mlc.ai", "raw.githubusercontent.com", "storage.googleapis.com", "cdn.jsdelivr.net"];
const CACHEABLE_EXT = [".bin", ".json", ".wasm", ".params", ".safetensors", ".task", ".onnx", ".onnx_data"];
const HF_HOSTS = ["huggingface.co", "hf.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co"];
const MAX_CACHE_ENTRY = 2 * 1024 * 1024 * 1024;
let hfToken = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  if (e.data?.type === "SET_HF_TOKEN") {
    hfToken = e.data.token || null;
    e.ports?.[0]?.postMessage({ ok: true });
  }
});

const onHost = (hostname, hosts) => hosts.some((h) => hostname === h || hostname.endsWith("." + h));
const cacheable = (u) => /^https?:$/.test(u.protocol) && onHost(u.hostname, CACHEABLE_HOSTS) && CACHEABLE_EXT.some((x) => u.pathname.toLowerCase().endsWith(x));
const isLiteRt = (u) => u.pathname.toLowerCase().endsWith(".litertlm");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const streamOnly = isLiteRt(url); // multi-GB: pass through with auth, never cache
  if (!cacheable(url) && !streamOnly) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!streamOnly) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    let req = request;
    if (hfToken && onHost(url.hostname, HF_HOSTS)) {
      // no-cors requests drop Authorization; rebuild as a CORS GET keeping Range etc.
      const headers = new Headers(request.headers);
      headers.set("Authorization", "Bearer " + hfToken);
      req = new Request(request.url, { method: "GET", headers, mode: "cors", credentials: "omit", redirect: "follow" });
    }
    const res = await fetch(req);
    if (res.ok && !streamOnly) {
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      if (len > 0 && len < MAX_CACHE_ENTRY) cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  })());
});
