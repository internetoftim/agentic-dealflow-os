/**
 * googlePorts — real Gmail/Drive REST implementations of the pipeline ports.
 *
 * Plain fetch, no SDK, same style as the Supabase edge functions in this
 * repo, so the ports run identically in the browser, Deno, bun, or node.
 * Auth is injected as an async token provider; callers decide where tokens
 * come from (user_settings row, OAuth refresh flow, env var, …).
 */

import {
  decodeBase64Url,
  type DriveFileMeta,
  type DrivePort,
  type GmailMessageFull,
  type GmailPort,
} from "./attachmentPipeline.ts";

export type AccessTokenProvider = () => Promise<string>;

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    body: string
  ) {
    super(`Google API ${status} on ${endpoint}: ${body.slice(0, 300)}`);
    this.name = "GoogleApiError";
  }
}

async function googleFetch(
  getToken: AccessTokenProvider,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getToken();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new GoogleApiError(res.status, url.split("?")[0], await res.text());
  }
  return res;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export function createGmailHttpPort(getToken: AccessTokenProvider): GmailPort {
  return {
    async searchThreads(query: string, maxThreads: number): Promise<string[]> {
      const ids: string[] = [];
      let pageToken: string | undefined;
      while (ids.length < maxThreads) {
        const params = new URLSearchParams({
          q: query,
          maxResults: String(Math.min(maxThreads - ids.length, 100)),
        });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await googleFetch(getToken, `${GMAIL_BASE}/threads?${params}`);
        const data = await res.json();
        for (const t of data.threads ?? []) ids.push(t.id);
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
      return ids.slice(0, maxThreads);
    },

    async getThread(threadId: string): Promise<GmailMessageFull[]> {
      const res = await googleFetch(
        getToken,
        `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}?format=full`
      );
      const data = await res.json();
      return (data.messages ?? []) as GmailMessageFull[];
    },

    async downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
      const res = await googleFetch(
        getToken,
        `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      );
      const data = await res.json();
      if (!data.data) throw new Error(`attachment ${attachmentId} returned no data`);
      return decodeBase64Url(data.data);
    },
  };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export function createDriveHttpPort(getToken: AccessTokenProvider): DrivePort {
  const findChildFolder = async (name: string, parentId: string | null): Promise<string | null> => {
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const parentClause = parentId ? ` and '${parentId}' in parents` : "";
    const q = `name='${escaped}' and mimeType='${FOLDER_MIME}' and trashed=false${parentClause}`;
    const res = await googleFetch(
      getToken,
      `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)`
    );
    const data = await res.json();
    return data.files?.[0]?.id ?? null;
  };

  const createFolder = async (name: string, parentId: string | null): Promise<string> => {
    const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
    if (parentId) body.parents = [parentId];
    const res = await googleFetch(getToken, `${DRIVE_BASE}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()).id;
  };

  return {
    async ensureFolderPath(path: string): Promise<string> {
      const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
      if (segments.length === 0) throw new Error(`invalid Drive folder path: "${path}"`);
      let parentId: string | null = null;
      for (const segment of segments) {
        const existing = await findChildFolder(segment, parentId);
        parentId = existing ?? (await createFolder(segment, parentId));
      }
      return parentId as string;
    },

    async listFiles(folderId: string): Promise<DriveFileMeta[]> {
      const files: DriveFileMeta[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, size, md5Checksum)",
          pageSize: "100",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await googleFetch(getToken, `${DRIVE_BASE}/files?${params}`);
        const data = await res.json();
        for (const f of data.files ?? []) {
          files.push({
            id: f.id,
            name: f.name,
            size: f.size !== undefined ? Number(f.size) : undefined,
            md5Checksum: f.md5Checksum,
          });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      return files;
    },

    async uploadFile({ folderId, name, mimeType, bytes }): Promise<{ id: string; name: string }> {
      const metadata = { name, mimeType, parents: [folderId] };
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append("file", new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: mimeType }));
      const res = await googleFetch(getToken, `${DRIVE_UPLOAD}&fields=id,name`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      return { id: data.id, name: data.name };
    },
  };
}
