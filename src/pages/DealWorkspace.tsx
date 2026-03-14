import { useState } from "react";
import { Upload, Link, Cog, Check, Search, Send, FileText, Globe, Layers } from "lucide-react";
import { mockDeals, sourceConfig } from "@/data/mockDeals";

const loadedSources = [
  { name: "NovaStar_Deck.pdf", originalSize: "45MB", compressedSize: "3.1MB", done: true },
  { name: "GreenLeaf_Pitch.pdf", originalSize: "32MB", compressedSize: "2.8MB", done: true },
  { name: "QuantumEdge_Overview.pdf", originalSize: "58MB", compressedSize: undefined, done: false },
];

const chatMessages = [
  { role: "assistant" as const, content: "I've analyzed the NovaStar AI deck. They're raising a $12M Series A with a $50M pre-money valuation. Key highlights include 3x YoY revenue growth and 142% net revenue retention. What would you like to explore?" },
];

const quickActions = ["Extract Cap Table", "Calculate Burn Rate", "Team Background", "Market Size"];

export default function DealWorkspace() {
  const [activeTab, setActiveTab] = useState<"chat" | "data" | "memo">("chat");
  const [chatInput, setChatInput] = useState("");
  const activeDeal = mockDeals[0];

  const tabs = [
    { key: "chat" as const, label: "Chat", icon: Send },
    { key: "data" as const, label: "Structured Data", icon: Layers },
    { key: "memo" as const, label: "Memo", icon: FileText },
  ];

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* LEFT PANEL */}
      <div className="w-[30%] border-r border-border p-5 flex flex-col gap-5 overflow-auto">
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Ingest Sources</h2>
          {/* Drop zone */}
          <div className="rounded-lg border-2 border-dashed border-border hover:border-primary/40 transition-colors p-6 text-center cursor-pointer group mb-3">
            <Upload className="h-5 w-5 mx-auto text-muted-foreground group-hover:text-primary transition-colors mb-2" />
            <p className="text-xs text-muted-foreground">Upload Deck (PDF/PPT)</p>
          </div>
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
            {loadedSources.map((src) => (
              <div key={src.name} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground truncate">{src.name}</span>
                </div>
                {src.done ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2 py-0.5 text-[11px] font-medium text-success">
                    <Check className="h-3 w-3" />
                    {src.originalSize} → {src.compressedSize} ⚡
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Cog className="h-3 w-3 animate-spin-slow" />
                    Compressing & renaming payload…
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Quick Facts bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-card shrink-0 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
            <FileText className="h-3 w-3 text-muted-foreground" /> Pages: {activeDeal.pages ?? "—"}
          </span>
          {activeDeal.website ? (
            <a
              href={activeDeal.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-info-muted px-2.5 py-1 text-xs font-medium text-info hover:underline"
            >
              <Globe className="h-3 w-3" /> {activeDeal.website.replace("https://", "")}
            </a>
          ) : activeDeal.websiteSearching ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
              <Search className="h-3 w-3 animate-pulse" /> Deep searching web…
            </span>
          ) : null}
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
              {/* Quick actions */}
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
              {/* Input */}
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
                <div className="grid grid-cols-2 gap-4">
                  {[
                    ["Company", "NovaStar AI"],
                    ["Stage", "Series A"],
                    ["Ask", "$12M"],
                    ["Valuation", "$50M pre-money"],
                    ["Revenue", "$2.4M ARR"],
                    ["Growth", "3x YoY"],
                    ["NRR", "142%"],
                    ["Team Size", "28 FTEs"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex flex-col">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">{k}</span>
                      <span className="text-sm font-medium text-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {activeTab === "memo" && (
            <div className="p-5">
              <div className="rounded-lg border border-border bg-card p-5 prose prose-sm max-w-none">
                <h3 className="text-sm font-semibold text-foreground mb-3">Investment Memo Draft</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  <strong>NovaStar AI</strong> is building an autonomous data labeling platform leveraging proprietary foundation models.
                  The company is raising a <strong>$12M Series A</strong> at a <strong>$50M pre-money valuation</strong>.
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed mt-3">
                  Key thesis drivers include 3x year-over-year revenue growth to $2.4M ARR, exceptional net revenue retention of 142%,
                  and a founding team with prior exits in the ML infrastructure space. Primary risks include competitive dynamics from
                  well-funded incumbents and concentration in the enterprise segment.
                </p>
                <p className="text-xs text-muted-foreground/60 mt-4 italic">— Draft generated by Agent Framework. Review and edit before circulation.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
