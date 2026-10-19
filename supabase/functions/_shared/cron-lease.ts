// Cron run lease. The gmail-listener is invoked every minute by pg_cron; when
// the database or the function is slow, runs must not pile up on top of each
// other. The function claims a named lease on entry (one atomic UPDATE, with a
// TTL so a crashed run cannot hold it forever) and releases it on exit.
//
// Pure decision logic lives here so it can be unit-tested; the RPCs are in
// supabase/migrations/20261017120000_gmail_listener_overlap_guard.sql.

export const GMAIL_LISTENER_LEASE = "gmail-listener";

/** Longest a single run may hold the lease. Must exceed the edge runtime's
 *  wall-clock limit so a live run is never overtaken, and be short enough that
 *  a crashed run delays polling by only a few minutes. */
export const GMAIL_LISTENER_LEASE_TTL_SECONDS = 180;

/** Time (ms) the cron SQL waits on the HTTP call before giving up on it. */
export const CRON_HTTP_TIMEOUT_MS = 5_000;

/**
 * Whether a cron tick body asks for mail polling. The SQL tick sets pollMail
 * every other minute; queue healing is not gated by it. Any caller that does
 * not say (manual trigger, older cron command) gets a full poll.
 */
export function wantsMailPoll(body: unknown): boolean {
  return !(body && typeof body === "object" && (body as { pollMail?: unknown }).pollMail === false);
}

/** Only the service role may start a poll: the cron sends it, nobody else should. */
export function isServiceCaller(authorization: string | null | undefined, serviceKey: string): boolean {
  const bearer = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return bearer.length > 0 && bearer === serviceKey;
}

export type LeaseRow = { locked_until: string | null };

/** Whether a lease row is still live at `now` (another run is in progress). */
export function isLeaseHeld(row: LeaseRow | null | undefined, now: number = Date.now()): boolean {
  if (!row?.locked_until) return false;
  const until = Date.parse(row.locked_until);
  return Number.isFinite(until) && until > now;
}

/** Decision for one tick: a missing or expired lease means run; a live one means skip. */
export function decideRun(row: LeaseRow | null | undefined, now: number = Date.now()): "run" | "skip" {
  return isLeaseHeld(row, now) ? "skip" : "run";
}

type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * Claim the lease. Returns false when a previous run still holds it. If the
 * RPC itself fails (for example the migration is not applied yet) the run
 * proceeds, so the guard can never turn polling off: it only ever adds safety.
 */
export async function claimLease(client: Rpc, name = GMAIL_LISTENER_LEASE, ttlSeconds = GMAIL_LISTENER_LEASE_TTL_SECONDS): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("claim_cron_lease", { _name: name, _ttl_seconds: ttlSeconds });
    if (error) {
      console.warn(`cron-lease: claim failed (${error.message}); running unguarded`);
      return true;
    }
    return data !== false;
  } catch (e) {
    console.warn("cron-lease: claim threw; running unguarded", e);
    return true;
  }
}

/** Release the lease. Best effort: an expired lease releases itself. */
export async function releaseLease(client: Rpc, name = GMAIL_LISTENER_LEASE): Promise<void> {
  try {
    const { error } = await client.rpc("release_cron_lease", { _name: name });
    if (error) console.warn(`cron-lease: release failed (${error.message})`);
  } catch (e) {
    console.warn("cron-lease: release threw", e);
  }
}
