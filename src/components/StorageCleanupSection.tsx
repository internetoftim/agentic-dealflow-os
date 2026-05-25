import { useState } from "react";
import { Trash2, Loader2, HardDrive } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ScanResult = {
  totalFiles: number;
  orphans: string[];
};

async function listAllUnderPrefix(prefix: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [prefix];
  while (stack.length) {
    const cur = stack.pop()!;
    const { data, error } = await supabase.storage
      .from("decks")
      .list(cur, { limit: 1000 });
    if (error) throw error;
    for (const item of data || []) {
      const full = cur ? `${cur}/${item.name}` : item.name;
      // Folders in supabase storage list show id === null
      if ((item as any).id === null || item.metadata == null) {
        stack.push(full);
      } else {
        results.push(full);
      }
    }
  }
  return results;
}

export function StorageCleanupSection({ userId }: { userId?: string }) {
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);

  const scanForOrphans = async () => {
    if (!userId) return;
    setScanning(true);
    setScan(null);
    try {
      const paths = await listAllUnderPrefix(userId);
      const dealIds = Array.from(
        new Set(
          paths
            .map((p) => p.split("/")[1])
            .filter((d) => d && UUID_RE.test(d))
        )
      );

      let existing = new Set<string>();
      if (dealIds.length) {
        // Chunk in case of many ids
        for (let i = 0; i < dealIds.length; i += 200) {
          const chunk = dealIds.slice(i, i + 200);
          const { data, error } = await supabase
            .from("deals")
            .select("id")
            .in("id", chunk);
          if (error) throw error;
          for (const d of data || []) existing.add(d.id);
        }
      }

      const orphans = paths.filter((p) => {
        const parts = p.split("/");
        return parts.length >= 2 && UUID_RE.test(parts[1]) && !existing.has(parts[1]);
      });

      setScan({ totalFiles: paths.length, orphans });
      toast.success(`Scan complete: ${orphans.length} orphan(s) of ${paths.length} file(s)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const deleteOrphans = async () => {
    if (!scan || scan.orphans.length === 0) return;
    if (!confirm(`Permanently delete ${scan.orphans.length} orphaned file(s)? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      let deleted = 0;
      for (let i = 0; i < scan.orphans.length; i += 100) {
        const batch = scan.orphans.slice(i, i + 100);
        const { data, error } = await supabase.storage.from("decks").remove(batch);
        if (error) throw error;
        deleted += data?.length || 0;
      }
      toast.success(`Deleted ${deleted} file(s)`);
      setScan(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        Storage cleanup
      </h2>
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <p className="text-sm text-muted-foreground">
          Find deck files in storage whose parent deal no longer exists, and delete them to free space.
        </p>

        <div className="flex items-center gap-3">
          <button
            onClick={scanForOrphans}
            disabled={scanning || deleting || !userId}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
            Scan for orphaned files
          </button>

          {scan && scan.orphans.length > 0 && (
            <button
              onClick={deleteOrphans}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete {scan.orphans.length} orphan(s)
            </button>
          )}
        </div>

        {scan && (
          <div className="text-xs text-muted-foreground">
            Found <span className="font-medium text-foreground">{scan.totalFiles}</span> total file(s),{" "}
            <span className="font-medium text-foreground">{scan.orphans.length}</span> orphan(s).
            {scan.orphans.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-[11px]">
                {scan.orphans.map((p) => (
                  <li key={p} className="truncate">{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
