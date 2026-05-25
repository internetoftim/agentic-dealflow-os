import { useState } from "react";
import { Trash2, Loader2, HardDrive, ScanLine } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DUP_NAME_PATTERNS = [/twin\s*path/i, /ppt[-\s]?deck[-\s]?sample/i, /twinpath/i];
const PROCESSED_STATUSES = new Set(["memo-ready", "cancelled", "error", "completed"]);

type FileEntry = { path: string; size: number; deal_id: string | null; fname: string };

async function listAllUnderPrefix(prefix: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const stack: string[] = [prefix];
  while (stack.length) {
    const cur = stack.pop()!;
    const { data, error } = await supabase.storage
      .from("decks")
      .list(cur, { limit: 1000 });
    if (error) throw error;
    for (const item of data || []) {
      const full = cur ? `${cur}/${item.name}` : item.name;
      const isFile = (item as any).id !== null && item.metadata != null;
      if (!isFile) {
        stack.push(full);
      } else {
        const parts = full.split("/");
        results.push({
          path: full,
          size: Number(item.metadata?.size ?? 0),
          deal_id: parts[1] && UUID_RE.test(parts[1]) ? parts[1] : null,
          fname: parts[parts.length - 1],
        });
      }
    }
  }
  return results;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Mode = "orphans" | "redundant_pptx" | "pptx_only" | "duplicate_deals";

type ScanItem = { label: string; paths: string[]; dealIds?: string[]; size: number };

export function StorageCleanupSection({ userId }: { userId?: string }) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [results, setResults] = useState<Partial<Record<Mode, ScanItem>>>({});

  const runScan = async (mode: Mode) => {
    if (!userId) return;
    setBusy(mode);
    try {
      const files = await listAllUnderPrefix(userId);
      const dealIds = Array.from(new Set(files.map((f) => f.deal_id).filter(Boolean) as string[]));

      const existingDeals = new Map<string, { id: string; status: string; name: string }>();
      for (let i = 0; i < dealIds.length; i += 200) {
        const chunk = dealIds.slice(i, i + 200);
        const { data, error } = await supabase
          .from("deals")
          .select("id, status, name")
          .in("id", chunk);
        if (error) throw error;
        for (const d of data || []) existingDeals.set(d.id, d as any);
      }

      let item: ScanItem;
      if (mode === "orphans") {
        const orphans = files.filter((f) => f.deal_id && !existingDeals.has(f.deal_id));
        item = { label: "orphaned file(s)", paths: orphans.map((o) => o.path), size: orphans.reduce((a, b) => a + b.size, 0) };
      } else if (mode === "redundant_pptx") {
        const pdfByDeal = new Set(files.filter((f) => /\.pdf$/i.test(f.fname) && f.deal_id).map((f) => f.deal_id!));
        const redundant = files.filter((f) => /\.pptx?$/i.test(f.fname) && f.deal_id && pdfByDeal.has(f.deal_id));
        item = { label: "redundant .pptx (PDF sibling exists)", paths: redundant.map((r) => r.path), size: redundant.reduce((a, b) => a + b.size, 0) };
      } else if (mode === "pptx_only") {
        const pdfByDeal = new Set(files.filter((f) => /\.pdf$/i.test(f.fname) && f.deal_id).map((f) => f.deal_id!));
        const target = files.filter((f) => {
          if (!/\.pptx?$/i.test(f.fname) || !f.deal_id) return false;
          if (pdfByDeal.has(f.deal_id)) return false;
          const deal = existingDeals.get(f.deal_id);
          return deal && PROCESSED_STATUSES.has(deal.status);
        });
        item = { label: ".pptx on processed/cancelled deals", paths: target.map((t) => t.path), size: target.reduce((a, b) => a + b.size, 0) };
      } else {
        // duplicate_deals: identify deals whose name matches duplicate test patterns
        const targetDealIds = Array.from(existingDeals.values())
          .filter((d) => DUP_NAME_PATTERNS.some((re) => re.test(d.name)))
          .map((d) => d.id);
        const matched = files.filter((f) => f.deal_id && targetDealIds.includes(f.deal_id));
        item = {
          label: `deal(s) matching duplicate test patterns`,
          paths: matched.map((m) => m.path),
          dealIds: targetDealIds,
          size: matched.reduce((a, b) => a + b.size, 0),
        };
      }

      setResults((r) => ({ ...r, [mode]: item }));
      const count = mode === "duplicate_deals" ? item.dealIds?.length ?? 0 : item.paths.length;
      toast.success(`Found ${count} ${item.label} (${fmtSize(item.size)})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async (mode: Mode) => {
    const item = results[mode];
    if (!item) return;

    if (mode === "duplicate_deals") {
      const n = item.dealIds?.length ?? 0;
      if (n === 0) return;
      if (!confirm(`Permanently delete ${n} deal(s) AND their files? This cannot be undone.`)) return;
      setBusy(mode);
      try {
        // Delete files first (RLS allows user own files)
        for (let i = 0; i < item.paths.length; i += 100) {
          const batch = item.paths.slice(i, i + 100);
          const { error } = await supabase.storage.from("decks").remove(batch);
          if (error) throw error;
        }
        // Delete deals (cascading sources via FK if defined; if not, delete sources first)
        if (item.dealIds && item.dealIds.length) {
          await supabase.from("sources").delete().in("deal_id", item.dealIds);
          await supabase.from("deal_people").delete().in("deal_id", item.dealIds);
          await supabase.from("capture_jobs").delete().in("deal_id", item.dealIds);
          const { error } = await supabase.from("deals").delete().in("id", item.dealIds);
          if (error) throw error;
        }
        toast.success(`Deleted ${n} deal(s) and ${item.paths.length} file(s)`);
        setResults((r) => ({ ...r, [mode]: undefined }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
      } finally {
        setBusy(null);
      }
      return;
    }

    if (item.paths.length === 0) return;
    if (!confirm(`Permanently delete ${item.paths.length} file(s)? This cannot be undone.`)) return;
    setBusy(mode);
    try {
      let deleted = 0;
      for (let i = 0; i < item.paths.length; i += 100) {
        const batch = item.paths.slice(i, i + 100);
        const { data, error } = await supabase.storage.from("decks").remove(batch);
        if (error) throw error;
        deleted += data?.length || 0;
      }
      toast.success(`Deleted ${deleted} file(s)`);
      setResults((r) => ({ ...r, [mode]: undefined }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  const rows: { mode: Mode; title: string; desc: string }[] = [
    { mode: "orphans", title: "Orphaned files", desc: "Files in storage whose parent deal no longer exists." },
    { mode: "redundant_pptx", title: "Redundant .pptx originals", desc: "PowerPoint files whose deal already has a converted PDF — safe to remove." },
    { mode: "pptx_only", title: ".pptx on processed/cancelled deals", desc: "Original PowerPoint files on deals that are memo-ready or cancelled. Text already extracted." },
    { mode: "duplicate_deals", title: "Duplicate test deals", desc: "Deals whose name matches obvious duplicate / test patterns (e.g. 'Twin Path Ventures', 'ppt-deck-sample'). Removes the deal rows and their files." },
  ];

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        Storage cleanup
      </h2>
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {rows.map(({ mode, title, desc }) => {
          const res = results[mode];
          const count = res ? (mode === "duplicate_deals" ? res.dealIds?.length ?? 0 : res.paths.length) : null;
          return (
            <div key={mode} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => runScan(mode)}
                    disabled={busy !== null || !userId}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                  >
                    {busy === mode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanLine className="h-3.5 w-3.5" />}
                    Scan
                  </button>
                  {res && count !== null && count > 0 && (
                    <button
                      onClick={() => runDelete(mode)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    >
                      {busy === mode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Delete {count}
                    </button>
                  )}
                </div>
              </div>
              {res && count !== null && (
                <div className="text-xs text-muted-foreground">
                  {count === 0 ? (
                    <span>Nothing to clean — all good.</span>
                  ) : (
                    <span>
                      {count} item(s), {fmtSize(res.size)}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">
        Cleanup runs in your browser using your own permissions — each user only sees & cleans their own files.
      </p>
    </section>
  );
}
