// Per-user processing queue rules. One deck is processed at a time per user;
// others wait as "queued". The lock is "some deal of this user is in a
// processing status" — which is only safe if a dead job cannot hold it forever.
//
// A job that has not touched its deal for JOB_STALE_MS is dead (the edge
// runtime killed it mid-flight, so no failure handler ran). Dead jobs do not
// count as active, and the reaper marks them failed. Without this, three
// zombie deals from July kept every later upload "queued — waiting for active
// job" for ten weeks.
//
// Pure (no Deno/Supabase imports): shared by the edge functions and, through
// the regression suite's parity test, by src/lib/jobQueue.ts.

export const PROCESSING_STATUSES = [
  "uploading", "converting", "compressing", "scraping", "extracting", "searching-website", "syncing",
] as const;

/** Every pipeline stage bumps deals.updated_at; cloud capture is the slowest at a few minutes. */
export const JOB_STALE_MS = 20 * 60 * 1000;

export type QueueDeal = { id: string; status: string; updated_at?: string | null; created_at?: string | null };

export function isProcessingStatus(status: string): boolean {
  return (PROCESSING_STATUSES as readonly string[]).includes(status);
}

/** A job that is really running: in a processing status AND recently active. */
export function isLiveJob(deal: QueueDeal, now: number = Date.now()): boolean {
  if (!isProcessingStatus(deal.status)) return false;
  const touched = Date.parse(deal.updated_at ?? "");
  if (Number.isNaN(touched)) return false;
  return now - touched < JOB_STALE_MS;
}

/** In a processing status but silent for too long: a zombie holding the queue. */
export function isStaleJob(deal: QueueDeal, now: number = Date.now()): boolean {
  return isProcessingStatus(deal.status) && !isLiveJob(deal, now);
}

export function hasLiveJob(deals: QueueDeal[], now: number = Date.now()): boolean {
  return deals.some((d) => isLiveJob(d, now));
}

/** The queued deal to start next: oldest first. */
export function nextQueued<T extends QueueDeal>(deals: T[]): T | undefined {
  return deals
    .filter((d) => d.status === "queued")
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
}

/** What the reaper should do for one user's deals. */
export function planQueueHeal<T extends QueueDeal>(deals: T[], now: number = Date.now()): { failIds: string[]; start?: T } {
  const failIds = deals.filter((d) => isStaleJob(d, now)).map((d) => d.id);
  const start = hasLiveJob(deals, now) ? undefined : nextQueued(deals);
  return { failIds, start };
}
