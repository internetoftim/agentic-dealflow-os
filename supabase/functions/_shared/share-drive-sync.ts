// Internal trigger for deal-share-drive: after a new Drive file lands for a
// deal (a deck copy or the memo PDF), make sure every collaborator the deal
// is shared with can view it. Best effort; never breaks the caller.

export async function syncSharedDriveAccess(supabaseUrl: string, serviceKey: string, dealId: string): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/deal-share-drive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dealId }),
    });
    if (!res.ok) console.warn("shared Drive access not synced:", res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.warn("shared Drive access not synced:", e instanceof Error ? e.message : e);
  }
}
