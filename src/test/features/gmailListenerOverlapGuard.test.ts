import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  claimLease, releaseLease, decideRun, isLeaseHeld, wantsMailPoll, isServiceCaller,
  GMAIL_LISTENER_LEASE, GMAIL_LISTENER_LEASE_TTL_SECONDS, CRON_HTTP_TIMEOUT_MS,
} from "../../../supabase/functions/_shared/cron-lease";
import { isDeadRefreshGrant, markUserGoogleDead } from "../../../supabase/functions/_shared/google-tokens";

// Regression: during the 2026-10-16/17 database freeze the one-minute
// gmail-listener cron (job 1) kept firing on top of runs that had not
// finished. pg_cron logged dozens of "job startup timeout" per hour and each
// net.http_post waited 20-224 seconds, adding load to a database that was
// already stuck. A run must now be skipped while the previous one is in
// progress, and the HTTP call must give up quickly.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const NOW = Date.parse("2026-10-16T21:30:00Z");
const inSeconds = (s: number) => new Date(NOW + s * 1000).toISOString();

describe("cron lease: one run at a time", () => {
  it("skips while a live lease is held and runs once it has expired", () => {
    expect(decideRun(null, NOW)).toBe("run");
    expect(decideRun({ locked_until: null }, NOW)).toBe("run");
    expect(decideRun({ locked_until: inSeconds(90) }, NOW)).toBe("skip");
    expect(decideRun({ locked_until: inSeconds(-1) }, NOW)).toBe("run");
    expect(isLeaseHeld({ locked_until: "not a date" }, NOW)).toBe(false);
  });

  it("the TTL outlives one edge-function run but bounds a crashed one to minutes", () => {
    expect(GMAIL_LISTENER_LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(150);
    expect(GMAIL_LISTENER_LEASE_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(CRON_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("claimLease asks the database atomically and honours a refused claim", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    expect(await claimLease({ rpc })).toBe(false);
    expect(rpc).toHaveBeenCalledWith("claim_cron_lease", { _name: GMAIL_LISTENER_LEASE, _ttl_seconds: GMAIL_LISTENER_LEASE_TTL_SECONDS });
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await claimLease({ rpc })).toBe(true);
  });

  it("never turns polling off: a failing or missing RPC runs unguarded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await claimLease({ rpc: async () => ({ data: null, error: { message: "function claim_cron_lease does not exist" } }) })).toBe(true);
    expect(await claimLease({ rpc: () => { throw new Error("network"); } })).toBe(true);
    await expect(releaseLease({ rpc: () => { throw new Error("network"); } })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("gmail-listener wires the lease around the whole poll", () => {
  const src = read("supabase/functions/gmail-listener/index.ts");

  it("claims before the queue reaper and answers 200 skipped when refused", () => {
    expect(src).toMatch(/_shared\/cron-lease\.ts/);
    const claim = src.indexOf("await claimLease(adminClient)");
    const reaper = src.indexOf("await healQueues(");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(reaper);
    expect(src).toMatch(/skipped: true[\s\S]*?status: 200/);
  });

  it("releases in a finally so a thrown poll never leaks the lease", () => {
    expect(src).toMatch(/\} finally \{\s*await releaseLease\(adminClient\);/);
  });

  it("the manual retry path (retryDealId) is not gated by the lease", () => {
    expect(src.indexOf("body?.retryDealId")).toBeLessThan(src.indexOf("await claimLease("));
  });

  it("only the service role can start a poll (verify_jwt is off for this function)", () => {
    expect(read("supabase/config.toml")).toMatch(/\[functions\.gmail-listener\]\s*verify_jwt = false/);
    const auth = src.indexOf("isServiceCaller(req.headers.get(\"Authorization\"), supabaseServiceKey)");
    expect(auth).toBeGreaterThan(src.indexOf("body?.retryDealId"));
    expect(auth).toBeLessThan(src.indexOf("await claimLease("));
    expect(src.slice(auth, auth + 300)).toMatch(/status: 401/);
    expect(isServiceCaller("Bearer svc", "svc")).toBe(true);
    expect(isServiceCaller("Bearer anon", "svc")).toBe(false);
    expect(isServiceCaller(null, "svc")).toBe(false);
    expect(isServiceCaller("Bearer ", "")).toBe(false);
  });

  it("heals queues every tick but polls mail only when the tick asks", () => {
    expect(wantsMailPoll({ trigger: "cron", pollMail: false })).toBe(false);
    expect(wantsMailPoll({ trigger: "cron", pollMail: true })).toBe(true);
    expect(wantsMailPoll({ trigger: "manual" })).toBe(true);
    expect(wantsMailPoll(null)).toBe(true);
    const gate = src.indexOf("if (!wantsMailPoll(body))");
    expect(gate).toBeGreaterThan(src.indexOf("await healQueues("));
    expect(gate).toBeGreaterThan(src.indexOf("shared_deals_needing_drive_sync"));
    expect(gate).toBeLessThan(src.indexOf("gmail_label_enabled"));
  });
});

describe("dead Google refresh tokens are not retried every minute", () => {
  it("only 400 invalid_grant is permanent", () => {
    expect(isDeadRefreshGrant(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')).toBe(true);
    expect(isDeadRefreshGrant(400, '{"error":"invalid_request"}')).toBe(false);
    expect(isDeadRefreshGrant(503, "invalid_grant")).toBe(false);
    expect(isDeadRefreshGrant(429, "rate limited")).toBe(false);
  });

  it("switches the user's auto-ingest off and records why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })) };
    await markUserGoogleDead(client, "u1", "400 invalid_grant");
    expect(client.from).toHaveBeenCalledWith("user_settings");
    expect(update).toHaveBeenCalledWith({ gmail_label_enabled: false, google_connection_error: "invalid_grant: 400 invalid_grant" });
    expect(eq).toHaveBeenCalledWith("user_id", "u1");
    warn.mockRestore();
  });

  it("both token owners take the dead path, and a fresh grant clears the record", () => {
    const tok = read("supabase/functions/_shared/google-tokens.ts");
    expect(tok.match(/refreshGoogleAccessTokenDetailed\(refresh\)/g)?.length).toBe(2);
    expect(tok).toMatch(/if \(fresh\.dead\) await markUserGoogleDead\(adminClient, userId, fresh\.reason\)/);
    expect(tok).toMatch(/from\("receiver_accounts"\)\s*\.update\(\{ enabled: false, last_error:/);
    expect(tok).toMatch(/row\.google_connection_error = null/);
    const settings = read("src/pages/SettingsPage.tsx");
    expect(settings).toMatch(/google_connection_error/);
    expect(settings).toMatch(/if \(v && \(!hasGmailScope \|\| googleConnectionError\)\)/);
  });
});

describe("migration contract: cron job 1 is guarded and times out quickly", () => {
  const sql = read("supabase/migrations/20261017120000_gmail_listener_overlap_guard.sql");

  it("claims the lease with one atomic UPDATE guarded by the expiry", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.cron_leases/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_cron_lease\(_name text, _ttl_seconds int/);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO UPDATE[\s\S]*?WHERE l\.locked_until <= now\(\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.release_cron_lease\(_name text\)/);
  });

  it("the tick skips while the lease is held, serialises itself, and caps the HTTP wait", () => {
    const tick = sql.slice(sql.indexOf("FUNCTION public.gmail_listener_tick"));
    expect(tick).toMatch(/pg_try_advisory_xact_lock\(hashtext\('gmail-listener-tick'\)\)/);
    expect(tick).toMatch(/locked_until > now\(\)[\s\S]*?RETURN;/);
    const timeout = tick.match(/timeout_milliseconds := (\d+)/);
    expect(timeout).not.toBeNull();
    expect(Number(timeout![1])).toBe(CRON_HTTP_TIMEOUT_MS);
    expect(tick).toMatch(/functions\/v1\/gmail-listener/);
  });

  it("replaces cron job 1 in place: same name, same every-minute schedule", () => {
    expect(sql).toMatch(/cron\.schedule\('gmail-listener-every-minute', '\* \* \* \* \*', \$\$ SELECT public\.gmail_listener_tick\(\); \$\$\)/);
    expect(sql).not.toMatch(/cron\.unschedule/);
  });

  it("authenticates as the service role from Vault, never with a key in the migration", () => {
    const tick = sql.slice(sql.indexOf("FUNCTION public.gmail_listener_tick"));
    expect(tick).toMatch(/FROM vault\.decrypted_secrets WHERE name = 'gmail_listener_service_key'/);
    expect(tick).toMatch(/'Authorization', 'Bearer ' \|\| _key/);
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // no JWT literal anywhere
    expect(sql).toMatch(/RAISE EXCEPTION 'Vault secret gmail_listener_service_key is missing/);
  });

  it("asks for mail polling every other minute; queue healing is every tick", () => {
    expect(sql).toMatch(/'pollMail', \(extract\(minute from now\(\)\)::int % 2 = 0\)/);
  });

  it("prunes cron.job_run_details once now and daily after", () => {
    expect(sql).toMatch(/^DELETE FROM cron\.job_run_details WHERE end_time < now\(\) - interval '7 days';/m);
    expect(sql).toMatch(/cron\.schedule\('prune-cron-job-run-details', '17 3 \* \* \*',\s*\$\$ DELETE FROM cron\.job_run_details WHERE end_time < now\(\) - interval '7 days'; \$\$\)/);
  });

  it("records a dead Google connection where Settings can read it", () => {
    expect(sql).toMatch(/ALTER TABLE public\.user_settings ADD COLUMN IF NOT EXISTS google_connection_error text/);
    expect(sql).toMatch(/GRANT SELECT \(google_connection_error\) ON public\.user_settings TO authenticated/);
  });

  it("nothing here is callable by clients", () => {
    expect(sql).toMatch(/ALTER TABLE public\.cron_leases ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON public\.cron_leases FROM public, anon, authenticated/);
    for (const fn of ["claim_cron_lease(text, int)", "release_cron_lease(text)", "gmail_listener_tick()"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM public, anon, authenticated`);
    }
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_cron_lease\(text, int\) TO service_role/);
  });
});
