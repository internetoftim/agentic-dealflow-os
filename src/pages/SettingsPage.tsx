import { useState } from "react";
import { Sparkles, Check, Mail, HardDrive, Shield } from "lucide-react";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-card shadow-sm transition-transform ${
        checked ? "translate-x-4" : "translate-x-0"
      }`} />
    </button>
  );
}

export default function SettingsPage() {
  const [gmailLabel, setGmailLabel] = useState(true);
  const [driveSync, setDriveSync] = useState(true);
  const [spamFilter, setSpamFilter] = useState(true);
  const [namingTab, setNamingTab] = useState<"auto" | "manual">("auto");
  const [patternDetected, setPatternDetected] = useState(false);

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground mb-6">Settings</h1>

      {/* Section A */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Workspace Auth
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <button className="flex items-center gap-3 rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="h-4 w-4" />
            Connect Google Workspace
          </button>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Listen to Gmail label: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">deck</code></p>
              <p className="text-xs text-muted-foreground">Auto-ingest decks tagged with this label</p>
            </div>
            <Toggle checked={gmailLabel} onChange={setGmailLabel} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Sync Memos to Drive</p>
              <p className="text-xs text-muted-foreground">Automatically upload completed memos</p>
            </div>
            <Toggle checked={driveSync} onChange={setDriveSync} />
          </div>
        </div>
      </section>

      {/* Section B */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          Firm Deal Desk
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <button className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-accent transition-colors">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            Connect Shared Inbox
          </button>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Enable AI Spam & Relevance Filtering</p>
              <p className="text-xs text-muted-foreground">AI Gatekeeper blocks vendor emails</p>
            </div>
            <Toggle checked={spamFilter} onChange={setSpamFilter} />
          </div>
          <div className="flex gap-6 pt-2">
            <div>
              <span className="text-2xl font-semibold text-foreground">142</span>
              <p className="text-xs text-muted-foreground">Pitches Processed</p>
            </div>
            <div>
              <span className="text-2xl font-semibold text-foreground">89</span>
              <p className="text-xs text-muted-foreground">Spam Blocked</p>
            </div>
          </div>
        </div>
      </section>

      {/* Section C */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          Naming Conventions
        </h2>
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex gap-0 mb-4 border-b border-border">
            {(["auto", "manual"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setNamingTab(t)}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  namingTab === t
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "auto" ? "Auto-Detect (AI)" : "Manual Builder"}
              </button>
            ))}
          </div>

          {namingTab === "auto" ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Paste a recent filename example"
                  defaultValue="2024-01-15 - NovaStar AI - Series A - AI_ML.pdf"
                  className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={() => setPatternDetected(true)}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Detect Pattern
                </button>
              </div>
              {patternDetected && (
                <div className="rounded-md bg-success-muted p-3 flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Pattern detected!</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <code className="bg-muted rounded px-1">[Date]</code> — <code className="bg-muted rounded px-1">[Startup]</code> — <code className="bg-muted rounded px-1">[Stage]</code> — <code className="bg-muted rounded px-1">[Sector]</code>.pdf
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Drag and arrange naming variables to build your convention.</p>
          )}
        </div>
      </section>
    </div>
  );
}
