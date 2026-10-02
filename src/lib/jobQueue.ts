// Browser mirror of supabase/functions/_shared/job-queue.ts (edge functions
// cannot be imported into the app bundle). A regression test keeps them equal.

export const PROCESSING_STATUSES = [
  "uploading", "converting", "compressing", "scraping", "extracting", "searching-website", "syncing",
] as const;

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

export function hasLiveJob(deals: QueueDeal[], now: number = Date.now()): boolean {
  return deals.some((d) => isLiveJob(d, now));
}
