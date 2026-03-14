import { useState, useCallback } from "react";
import { Upload, Link, Cog, Check, Search, Send, FileText, Globe, Layers } from "lucide-react";
import { useDeals, useSources, useCreateDealWithUpload } from "@/hooks/useDeals";
import { toast } from "sonner";

const quickActions = ["Extract Cap Table", "Calculate Burn Rate", "Team Background", "Market Size"];

const chatMessages = [
  { role: "assistant" as const, content: "Upload a deck to get started. I'll analyze it and extract key data points automatically." },
];

export default function DealWorkspace() {
  const [activeTab, setActiveTab] = useState<"chat" | "data" | "memo">("chat");
  const [chatInput, setChatInput] = useState("");
  const [selectedDealId, setSelectedDealId] = useState<string | undefined>();

  const { data: deals } = useDeals();
  const { data: sources } = useSources(selectedDealId);
  const createDeal = useCreateDealWithUpload();

  const activeDeal = deals?.find((d) => d.id === selectedDealId) ?? deals?.[0];

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const name = file.name.replace(/\.(pdf|pptx?|ppt)$/i, "").replace(/[_-]/g, " ");
      toast.promise(createDeal.mutateAsync({ file, name }), {
        loading: `Uploading ${file.name}…`,
        success: "Deal created & syncing to Drive!",
        error: (err) => `Upload failed: ${err.message}`,
      });
    },
    [createDeal]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const name = file.name.replace(/\.(pdf|pptx?|ppt)$/i, "").replace(/[_-]/g, " ");
      toast.promise(createDeal.mutateAsync({ file, name }), {
        loading: `Uploading ${file.name}…`,
        success: "Deal created & syncing to Drive!",
        error: (err) => `Upload failed: ${err.message}`,
      });
    },
    [createDeal]
  );

  const tabs = [
    { key: "chat" as const, label: "Chat", icon: Send },
    { key: "data" as const, label: "Structured Data", icon: Layers },
    { key: "memo" as const, label: "Memo", icon: FileText },
  ];

  const loadedSources = sources ?? [];

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* LEFT PANEL */}
      <div className="w-[30%] border-r border-border p-5 flex flex-col gap-5 overflow-auto">
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Ingest Sources</h2>
          {/* Drop zone */}
          <label
            className="rounded-lg border-2 border-dashed border-border hover:border-primary/40 transition-colors p-6 text-center cursor-pointer group mb-3 block"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
          >
            <Upload className="h-5 w-5 mx-auto text-muted-foreground group-hover:text-primary transition-colors mb-2" />
            <p className="text-xs text-muted-foreground">
              {createDeal.isPending ? "Uploading…" : "Upload Deck (PDF/PPT)"}
            </p>
            <input
              type="file"
              accept=".pdf,.ppt,.pptx"
              className="hidden"
              onChange={handleFileSelect}
            />
          </label>
          {/* URL input */}
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-md border border-input bg-card px-3 py-2">
              <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Paste DocSend / PandaDoc URL"
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </div>
            <button className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity">
              Fetch
            </button>
          </div>
        </div>

        {/* Loaded sources */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Loaded Sources</h3>
          <div className="flex flex-col gap-2">
            {loadedSources.length === 0 && (
              <p className="text-xs text-muted-foreground">No sources uploaded yet.</p>
            )}
            {loadedSources.map((src: any) => (
              <div key={src.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground truncate">{src.file_name}</span>
                </div>
                {src.processing_status === "uploaded" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2 py-0.5 text-[11px] font-medium text-success">
                    <Check className="h-3 w-3" />
                    {src.original_size} uploaded ⚡
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Cog className="h-3 w-3 animate-spin-slow" />
                    Processing…
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Deal selector */}
        {deals && deals.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Deals</h3>
            <div className="flex flex-col gap-1">
              {deals.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSelectedDealId(d.id)}
                  className={`text-left rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    activeDeal?.id === d.id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Quick Facts bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-card shrink-0 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
            <FileText className="h-3 w-3 text-muted-foreground" /> Pages: {activeDeal?.pages ?? "—"}
          </span>
          {activeDeal?.website ? (
            <a
              href={activeDeal.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-info-muted px-2.5 py-1 text-xs font-medium text-info hover:underline"
            >
              <Globe className="h-3 w-3" /> {activeDeal.website.replace("https://", "")}
            </a>
          ) : activeDeal?.website_searching ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
              <Search className="h-3 w-3 animate-pulse" /> Deep searching web…
            </span>
          ) : null}
          {activeDeal?.gdrive_file_id && (
            <a
              href={`https://drive.google.com/file/d/${activeDeal.gdrive_file_id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2.5 py-1 text-xs font-medium text-success hover:underline"
            >
              <Check className="h-3 w-3" /> Synced to Drive
            </a>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0 px-5 border-b border-border bg-card shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 flex flex-col overflow-auto">
          {activeTab === "chat" && (
            <div className="flex-1 flex flex-col">
              <div className="flex-1 p-5 space-y-4 overflow-auto">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`max-w-[80%] ${msg.role === "assistant" ? "" : "ml-auto"}`}>
                    <div className={`rounded-lg p-3.5 text-sm leading-relaxed ${
                      msg.role === "assistant"
                        ? "bg-muted text-foreground"
                        : "bg-primary text-primary-foreground"
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 pb-2 flex gap-2 flex-wrap">
                {quickActions.map((a) => (
                  <button
                    key={a}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="px-5 pb-5">
                <div className="flex items-center gap-2 rounded-lg border border-input bg-card px-3 py-2.5">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about the deck…"
                    className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                  />
                  <button className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity">
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeTab === "data" && (
            <div className="p-5">
              <div className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-4">Extracted Data</h3>
                {activeDeal ? (
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      ["Company", activeDeal.name],
                      ["Stage", activeDeal.stage],
                      ["Ask", activeDeal.ask_amount ?? "—"],
                      ["Valuation", activeDeal.valuation ?? "—"],
                      ["Revenue", activeDeal.revenue ?? "—"],
                      ["Growth", activeDeal.growth ?? "—"],
                      ["NRR", activeDeal.nrr ?? "—"],
                      ["Team Size", activeDeal.team_size ?? "—"],
                    ].map(([k, v]) => (
                      <div key={k} className="flex flex-col">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">{k}</span>
                        <span className="text-sm font-medium text-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No deal selected.</p>
                )}
              </div>
            </div>
          )}
          {activeTab === "memo" && (
            <div className="p-5">
              <div className="rounded-lg border border-border bg-card p-5 prose prose-sm max-w-none">
                <h3 className="text-sm font-semibold text-foreground mb-3">Investment Memo Draft</h3>
                {activeDeal?.memo_draft ? (
                  <p className="text-sm text-muted-foreground leading-relaxed">{activeDeal.memo_draft}</p>
                ) : (
                  <p className="text-sm text-muted-foreground leading-relaxed italic">
                    No memo generated yet. Upload a deck to get started.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
