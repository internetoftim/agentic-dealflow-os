// Demo-mode screenshots of the EasyVC dashboard for the dashboard reviewer
// agent (managed-agents/agents/dashboard-reviewer.md) and for humans.
//
// It signs in a fake demo user and answers every Supabase request from
// ./fixtures, so it works without credentials and never touches production
// data. Requests to any other non-local host are blocked, except Google Fonts.
//
//   npm run dev                         # Vite on :8080, in another terminal
//   node scripts/ui-review/capture.mjs  # screenshots -> ui-review-output/
//
// Env: UI_REVIEW_BASE_URL (default http://localhost:8080), UI_REVIEW_OUT,
// CHROMIUM_PATH (default /usr/bin/chromium when it exists, else Playwright's own).

import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.UI_REVIEW_BASE_URL ?? "http://localhost:8080";
const OUT = process.env.UI_REVIEW_OUT ?? path.resolve(here, "../../ui-review-output");
const SUPABASE_REF = "fbiigltzcxkqjjadqzgl";
const SUPABASE_HOST = `${SUPABASE_REF}.supabase.co`;
const ROUTES = ["/", "/pipeline", "/data-room", "/settings"];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 375, height: 812 } };
const ALLOWED_EXTERNAL = ["fonts.googleapis.com", "fonts.gstatic.com"];

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "demo@easyvc.example",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Demo Investor" },
  created_at: "2026-01-01T00:00:00Z",
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function fakeSession() {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const accessToken = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: USER.id, role: "authenticated", aud: "authenticated", exp, email: USER.email })}.demo-signature`;
  return { access_token: accessToken, token_type: "bearer", expires_in: 86400, expires_at: exp, refresh_token: "demo-refresh", user: USER };
}

function fixture(table) {
  const file = path.join(here, "fixtures", `${table}.json`);
  if (!existsSync(file)) {
    console.warn(`  no fixture for "${table}" - answering []`);
    return [];
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Applies the simple PostgREST equality filters (col=eq.value) so per-deal queries get their own rows. */
function applyFilters(rows, searchParams) {
  let out = rows;
  for (const [key, value] of searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter((r) => String(r[key]) === value.slice(3));
    else if (value.startsWith("in.(")) {
      const set = new Set(value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")));
      out = out.filter((r) => set.has(String(r[key])));
    }
  }
  const limit = Number(searchParams.get("limit"));
  return limit > 0 ? out.slice(0, limit) : out;
}

async function answerSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (body, status = 200, headers = {}) =>
    route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: JSON.stringify(body) });

  if (req.method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  }
  if (url.pathname.startsWith("/auth/v1/user")) return json(USER);
  if (url.pathname.startsWith("/auth/v1/token")) return json(fakeSession());
  if (url.pathname.startsWith("/auth/v1/")) return json({});
  if (url.pathname.startsWith("/rest/v1/rpc/")) return json(null);
  if (url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.slice("/rest/v1/".length);
    if (req.method() !== "GET" && req.method() !== "HEAD") return json([], 201); // writes are accepted and dropped
    const rows = applyFilters(fixture(table), url.searchParams);
    const range = { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
    if (req.method() === "HEAD") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", ...range } });
    const single = (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
    return json(single ? (rows[0] ?? null) : rows, 200, range);
  }
  if (url.pathname.startsWith("/functions/v1/")) return json({});
  return route.fulfill({ status: 404, body: "" });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const executablePath = process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  const storageKey = `sb-${SUPABASE_REF}-auth-token`;

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await context.addInitScript(([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    }, [storageKey, fakeSession()]);

    await context.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === SUPABASE_HOST) return answerSupabase(route);
      if (host === "localhost" || host === "127.0.0.1" || ALLOWED_EXTERNAL.includes(host)) return route.continue();
      return route.abort();
    });
    // Realtime: accept the socket and never send anything.
    await context.routeWebSocket(/supabase\.co/, () => {});

    const page = await context.newPage();
    page.on("pageerror", (e) => console.warn(`  [${name}] page error: ${e.message}`));
    for (const route of ROUTES) {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const file = path.join(OUT, `${name}${route === "/" ? "-workspace" : route.replaceAll("/", "-")}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      console.log(`${file}${scrollsSideways ? "  (scrolls horizontally)" : ""}${page.url().includes("/login") ? "  (redirected to login - auth fixture failed)" : ""}`);
    }
    await context.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
