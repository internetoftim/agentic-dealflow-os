// Keeps a shared deal's Google Drive files in step with who the deal is
// shared with. Idempotent: every call reconciles, so it is safe to call after
// a collaborator joins, after one is revoked, after a new deck or memo lands
// in Drive, and whenever the owner opens the share dialog.
//
//   POST { dealId }                     reconcile (owner, active collaborator, or service role)
//   POST { dealId, revokeAccessId }     owner only: revoke that collaborator, then reconcile
//
// Grants are made with the OWNER's Google token (the files live in the
// owner's Drive; drive.file scope covers files this app created). Each
// (collaborator, file) permission is recorded in deal_share_drive_grants.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getUserGoogleAccessToken } from "../_shared/google-tokens.ts";
import { dealDriveFileIds, needsNotification, planDriveGrants, type DriveGrant, type ShareAccess } from "../_shared/share-drive.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const DRIVE = "https://www.googleapis.com/drive/v3/files";

async function grantReader(token: string, fileId: string, email: string, ownerName: string, dealName: string) {
  const create = (notify: boolean) => {
    const qs = new URLSearchParams({ supportsAllDrives: "true", sendNotificationEmail: String(notify), fields: "id" });
    const body: Record<string, unknown> = { role: "reader", type: "user", emailAddress: email };
    if (notify) qs.set("emailMessage", `${ownerName} shared the deal "${dealName}" with you on EasyVC.`);
    return fetch(`${DRIVE}/${encodeURIComponent(fileId)}/permissions?${qs}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  let res = await create(false);
  if (!res.ok) {
    const text = await res.text();
    if (!needsNotification(res.status, text)) return { ok: false as const, error: `Drive ${res.status}: ${text.slice(0, 300)}` };
    res = await create(true);
    if (!res.ok) return { ok: false as const, error: `Drive ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  const data = await res.json();
  return { ok: true as const, permissionId: String(data.id) };
}

async function removePermission(token: string, fileId: string, permissionId: string) {
  const res = await fetch(`${DRIVE}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // Already gone (file deleted, or the permission was removed in Drive) counts as done.
  if (res.ok || res.status === 404) return { ok: true as const };
  return { ok: false as const, error: `Drive ${res.status}: ${(await res.text()).slice(0, 300)}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No authorization header" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const isService = authHeader === `Bearer ${serviceKey}`;
    let callerId: string | null = null;
    if (!isService) {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error } = await userClient.auth.getUser();
      if (error || !user) return json({ error: "Unauthorized" }, 401);
      callerId = user.id;
    }

    const body = await req.json().catch(() => ({}));
    const dealId = typeof body?.dealId === "string" ? body.dealId : "";
    const revokeAccessId = typeof body?.revokeAccessId === "string" ? body.revokeAccessId : null;
    if (!dealId) return json({ error: "Missing dealId" }, 400);

    const { data: deal } = await admin.from("deals")
      .select("id, name, user_id, gdrive_file_id, memo_gdrive_file_id").eq("id", dealId).maybeSingle();
    if (!deal) return json({ error: "Deal not found" }, 404);
    const isOwner = callerId === deal.user_id;

    const { data: accessRows } = await admin.from("deal_share_access")
      .select("id, user_id, revoked_at").eq("deal_id", dealId);
    const accesses = (accessRows ?? []) as Array<{ id: string; user_id: string; revoked_at: string | null }>;

    if (!isService && !isOwner) {
      // A collaborator may trigger the reconcile (right after joining), nothing more.
      const mine = accesses.some((a) => a.user_id === callerId && !a.revoked_at);
      if (!mine || revokeAccessId) return json({ error: "Forbidden" }, 403);
    }

    if (revokeAccessId) {
      if (!isOwner && !isService) return json({ error: "Forbidden" }, 403);
      const target = accesses.find((a) => a.id === revokeAccessId);
      if (!target) return json({ error: "Access not found" }, 404);
      if (!target.revoked_at) {
        const now = new Date().toISOString();
        const { error } = await admin.from("deal_share_access").update({ revoked_at: now }).eq("id", target.id);
        if (error) throw new Error(`revoke failed: ${error.message}`);
        target.revoked_at = now;
      }
    }

    // Recipient emails come from auth (profiles may lag or be missing).
    const withEmail: ShareAccess[] = [];
    for (const a of accesses) {
      let email: string | null = null;
      if (!a.revoked_at) {
        const { data } = await admin.auth.admin.getUserById(a.user_id);
        email = data?.user?.email ?? null;
      }
      withEmail.push({ ...a, email });
    }

    const { data: sourceRows } = await admin.from("sources").select("gdrive_file_id").eq("deal_id", dealId);
    const fileIds = dealDriveFileIds(deal, sourceRows ?? []);
    const { data: grantRows } = await admin.from("deal_share_drive_grants")
      .select("id, access_id, drive_file_id, permission_id, status").eq("deal_id", dealId);
    const grants = (grantRows ?? []) as DriveGrant[];
    const plan = planDriveGrants(withEmail, fileIds, grants);

    const summary = { dealId, files: fileIds.length, granted: 0, revoked: 0, failed: 0, missingEmail: plan.missingEmail.length, driveConnected: true as boolean, revokedAccessId: revokeAccessId };
    if (plan.grant.length === 0 && plan.revoke.length === 0) return json({ success: true, ...summary });

    const token = await getUserGoogleAccessToken(admin, deal.user_id);
    if (!token) {
      // Owner's Google connection is missing or expired: record the gap so
      // the share dialog can say so, and retry on the next reconcile.
      summary.driveConnected = false;
      const now = new Date().toISOString();
      for (const g of plan.grant) {
        const access = withEmail.find((a) => a.id === g.access_id)!;
        await admin.from("deal_share_drive_grants").upsert({
          access_id: g.access_id, deal_id: dealId, owner_id: deal.user_id, recipient_id: access.user_id,
          recipient_email: g.email, drive_file_id: g.drive_file_id, status: "failed",
          error: "The deal owner's Google Drive is not connected. Reconnect Google in Settings.", updated_at: now,
        }, { onConflict: "access_id,drive_file_id" });
        summary.failed++;
      }
      // Revocations wait for the token too; they stay "granted" and retry.
      summary.failed += plan.revoke.length;
      return json({ success: false, ...summary });
    }

    const { data: ownerProfile } = await admin.from("profiles").select("display_name, email").eq("user_id", deal.user_id).maybeSingle();
    const ownerName = ownerProfile?.display_name || ownerProfile?.email || "A colleague";

    for (const g of plan.grant) {
      const access = withEmail.find((a) => a.id === g.access_id)!;
      const result = await grantReader(token, g.drive_file_id, g.email, ownerName, deal.name);
      const now = new Date().toISOString();
      await admin.from("deal_share_drive_grants").upsert({
        access_id: g.access_id, deal_id: dealId, owner_id: deal.user_id, recipient_id: access.user_id,
        recipient_email: g.email, drive_file_id: g.drive_file_id,
        permission_id: result.ok ? result.permissionId : null,
        status: result.ok ? "granted" : "failed",
        error: result.ok ? null : result.error,
        granted_at: result.ok ? now : null, revoked_at: null, updated_at: now,
      }, { onConflict: "access_id,drive_file_id" });
      if (result.ok) summary.granted++; else summary.failed++;
    }

    for (const g of plan.revoke) {
      const result = g.permission_id ? await removePermission(token, g.drive_file_id, g.permission_id) : { ok: true as const };
      const now = new Date().toISOString();
      await admin.from("deal_share_drive_grants").update(
        result.ok
          ? { status: "revoked", revoked_at: now, error: null, updated_at: now }
          : { error: result.error, updated_at: now },
      ).eq("access_id", g.access_id).eq("drive_file_id", g.drive_file_id);
      if (result.ok) summary.revoked++; else summary.failed++;
    }

    return json({ success: summary.failed === 0, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("deal-share-drive error:", message);
    return json({ error: message }, 500);
  }
});
