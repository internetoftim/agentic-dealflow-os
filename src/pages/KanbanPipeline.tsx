import { mockDeals, sourceConfig, type Deal } from "@/data/mockDeals";

const columns = [
  { key: "inbox" as const, title: "Inbox", count: 0 },
  { key: "extracting" as const, title: "Extracting & Compressing", count: 0 },
  { key: "analysis" as const, title: "Agent Analysis", count: 0 },
  { key: "memo-ready" as const, title: "Memo Ready", count: 0 },
];

function DealCard({ deal }: { deal: Deal }) {
  const source = sourceConfig[deal.source];
  return (
    <div className="rounded-lg border border-border bg-card p-3.5 shadow-surface hover:shadow-surface-md transition-shadow cursor-pointer group">
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-sm font-semibold text-card-foreground group-hover:text-primary transition-colors">
          {deal.name}
        </h3>
        {deal.autoIngested && (
          <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1">
            <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success" />
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-2.5">{deal.stage} · {deal.sector}</p>
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${source.bgClass} ${source.colorClass}`}>
        {source.label}
      </span>
    </div>
  );
}

export default function KanbanPipeline() {
  const grouped = columns.map((col) => ({
    ...col,
    deals: mockDeals.filter((d) => d.status === col.key),
  }));

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Deal Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">Track deals across your ingestion pipeline</p>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {grouped.map((col) => (
          <div key={col.key} className="flex flex-col">
            <div className="flex items-center justify-between mb-3 px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{col.title}</h2>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                {col.deals.length}
              </span>
            </div>
            <div className="flex flex-col gap-2.5 min-h-[200px] rounded-lg bg-muted/50 p-2">
              {col.deals.map((deal) => (
                <DealCard key={deal.id} deal={deal} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
