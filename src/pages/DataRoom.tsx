import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FolderOpen, FileText, Download, Search, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useDeals, useAllSources } from "@/hooks/useDeals";
import { isDeckSource, pickPrimarySource, sourceKind, type DealSource } from "@/lib/deckSources";

/**
 * The Data Room: every deal as a folder holding all the decks and documents
 * linked to it. A deal can hold several decks; the primary one is marked.
 */
export default function DataRoom() {
  const { data: deals, isLoading: dealsLoading } = useDeals();
  const { data: sources, isLoading: sourcesLoading } = useAllSources();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);

  const rooms = useMemo(() => {
    const byDeal = new Map<string, DealSource[]>();
    for (const s of (sources ?? []) as DealSource[]) {
      const list = byDeal.get(s.deal_id) ?? [];
      list.push(s);
      byDeal.set(s.deal_id, list);
    }
    const q = query.trim().toLowerCase();
    return (deals ?? [])
      .map((deal) => {
        const files = byDeal.get(deal.id) ?? [];
        const primaryId = pickPrimarySource(files)?.id;
        // Primary deck first, then other decks, then documents; newest first within each.
        const rank = (s: DealSource) => (s.id === primaryId ? 0 : isDeckSource(s) ? 1 : 2);
        const sorted = [...files].sort((a, b) => rank(a) - rank(b) || (b.created_at ?? "").localeCompare(a.created_at ?? ""));
        return { deal, files: sorted, primaryId, decks: files.filter(isDeckSource).length };
      })
      .filter((r) => r.files.length > 0)
      .filter((r) => !q || r.deal.name.toLowerCase().includes(q) || r.files.some((f) => f.file_name.toLowerCase().includes(q)));
  }, [deals, sources, query]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const download = async (file: DealSource) => {
    if (!file.storage_path) return;
    setDownloading(file.id);
    const { data, error } = await supabase.storage.from("decks").download(file.storage_path);
    setDownloading(null);
    if (error || !data) {
      toast.error("Couldn't download this file");
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.file_name || "deck.pdf";
    a.click();
    URL.revokeObjectURL(url);
  };

  const loading = dealsLoading || sourcesLoading;
  const totalFiles = rooms.reduce((n, r) => n + r.files.length, 0);

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Data Room</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every deal with the decks and documents linked to it.
            {!loading && ` ${rooms.length} deals · ${totalFiles} files.`}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-[5px] border border-input bg-card px-2.5 py-1.5 w-full max-w-xs">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search deals or files…"
            aria-label="Search the data room"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the data room…
        </div>
      ) : rooms.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <FolderOpen className="h-5 w-5 mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">{query ? "Nothing matches that search" : "No files yet"}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {query ? "Try a deal name or a file name." : "Upload a deck in the Deal Workspace; every deck and document you link to a deal shows up here."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rooms.map(({ deal, files, primaryId, decks }) => {
            const isCollapsed = collapsed.has(deal.id);
            return (
              <section key={deal.id} className="rounded-lg border border-border bg-card overflow-hidden" aria-label={`${deal.name} data room`}>
                <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-muted/30">
                  <button onClick={() => toggle(deal.id)} className="flex items-center gap-2 min-w-0 text-left" aria-expanded={!isCollapsed}>
                    {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    <FolderOpen className="h-4 w-4 text-brand shrink-0" />
                    <span className="text-sm font-semibold text-foreground truncate">{deal.name}</span>
                    <span className="text-[11.5px] text-muted-foreground shrink-0">
                      {decks} {decks === 1 ? "deck" : "decks"}
                      {files.length - decks > 0 && ` · ${files.length - decks} ${files.length - decks === 1 ? "document" : "documents"}`}
                    </span>
                  </button>
                  <Link to={`/?deal=${deal.id}`} className="text-[11.5px] text-muted-foreground hover:text-foreground shrink-0 underline underline-offset-2">
                    Open deal
                  </Link>
                </header>
                {!isCollapsed && (
                  <ul>
                    {files.map((file) => {
                      const kind = sourceKind(file, primaryId);
                      return (
                        <li key={file.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-accent/40 transition-colors">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="text-[13px] text-foreground truncate">{file.label ? `${file.label} · ${file.file_name}` : file.file_name}</span>
                            <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ${
                              kind === "Primary deck" ? "bg-brand-muted text-brand" : "bg-muted text-muted-foreground"
                            }`}>
                              {kind}
                            </span>
                          </div>
                          <span className="text-[12px] text-muted-foreground tabular-nums">{file.compressed_size ?? file.original_size ?? "—"}</span>
                          <span className="text-[12px] text-muted-foreground tabular-nums">
                            {file.created_at ? new Date(file.created_at).toLocaleDateString() : "—"}
                          </span>
                          <button
                            onClick={() => download(file)}
                            disabled={!file.storage_path || downloading === file.id}
                            title={file.storage_path ? "Download" : "No stored file"}
                            aria-label={`Download ${file.file_name}`}
                            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          >
                            {downloading === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
