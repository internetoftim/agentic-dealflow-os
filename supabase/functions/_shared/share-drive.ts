// Which Google Drive permissions a shared deal should have. Pure (no Deno or
// Supabase imports) so the regression suite can import it.
//
// Every active collaborator gets "reader" on every Drive file of the deal:
// each deck's copy (sources.gdrive_file_id), the deal-level copy of the
// primary deck (deals.gdrive_file_id, for decks synced before per-deck ids),
// and the memo PDF (deals.memo_gdrive_file_id). A revoked collaborator loses
// every permission that was granted to them.

export type ShareAccess = { id: string; user_id: string; revoked_at: string | null; email: string | null };
export type DriveGrant = {
  id?: string;
  access_id: string;
  drive_file_id: string;
  permission_id: string | null;
  status: "pending" | "granted" | "failed" | "revoked";
};

export function dealDriveFileIds(
  deal: { gdrive_file_id?: string | null; memo_gdrive_file_id?: string | null } | null,
  sources: Array<{ gdrive_file_id?: string | null }>,
): string[] {
  const ids = [
    ...sources.map((s) => s.gdrive_file_id),
    deal?.gdrive_file_id,
    deal?.memo_gdrive_file_id,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return [...new Set(ids)];
}

export type DrivePlan = {
  grant: Array<{ access_id: string; email: string; drive_file_id: string }>;
  revoke: DriveGrant[];
  /** Active collaborators with no email on record: cannot be shared with. */
  missingEmail: string[];
};

export function planDriveGrants(accesses: ShareAccess[], fileIds: string[], grants: DriveGrant[]): DrivePlan {
  const plan: DrivePlan = { grant: [], revoke: [], missingEmail: [] };
  const byKey = new Map(grants.map((g) => [`${g.access_id}|${g.drive_file_id}`, g]));
  const active = new Set<string>();
  for (const a of accesses) {
    if (a.revoked_at) continue;
    active.add(a.id);
    if (!a.email) {
      plan.missingEmail.push(a.id);
      continue;
    }
    for (const f of fileIds) {
      const g = byKey.get(`${a.id}|${f}`);
      // Grant when never granted, previously failed, or revoked and re-shared.
      if (!g || g.status !== "granted") plan.grant.push({ access_id: a.id, email: a.email, drive_file_id: f });
    }
  }
  for (const g of grants) {
    if (g.status === "granted" && !active.has(g.access_id)) plan.revoke.push(g);
  }
  return plan;
}

/** Drive refuses a silent share to a non-Google address; retry with a notification. */
export function needsNotification(status: number, body: string): boolean {
  return status === 400 && /notif|invalidSharingRequest|no Google account/i.test(body);
}
