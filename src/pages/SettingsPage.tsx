import { useState, useEffect } from "react";
import { Sparkles, Check, Mail, HardDrive, Shield, Bot, Search, RotateCcw, Loader2, FolderOpen, FileText, Link2, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
// import { BookmarkletInstaller } from "@/components/BookmarkletInstaller";

const DEFAULT_PATTERN = "<WEBSITE> deck <MonthYYYY> p<pages>.pdf";
const DEFAULT_RECAP_PATTERN = "<WEBSITE> recap <MonthYYYY> p<pages>";

const DEFAULT_MEMO_PROMPT = `You are a VC analyst writing an internal investment memo. Given the extracted deck content and any deep research data, produce a structured memo with the following sections:

1. **Executive Summary** — One paragraph overview of the company, what they do, and why it matters.
2. **Market Opportunity** — TAM/SAM/SOM if available, market trends, and timing thesis.
3. **Product & Traction** — What the product does, key metrics (ARR, growth, NRR, users), and competitive moat.
4. **Team** — Founders' backgrounds, relevant experience, and team composition.
5. **Business Model** — How they make money, unit economics, and pricing strategy.
6. **Competition** — Key competitors and differentiation.
7. **Risks & Concerns** — Red flags, market risks, execution risks.
8. **Investment Thesis** — Bull case and bear case for investing.
9. **Recommendation** — Pass / Follow-up / Invest, with reasoning.

Be concise, data-driven, and flag any missing information. Use bullet points where appropriate.`;

const AI_MODELS = [
  { value: "gpt-5.4", label: "GPT-5.4", description: "Latest & most capable — default", disabled: false },
  { value: "gpt-5-mini", label: "GPT-5 Mini", description: "Fast & cost-effective", disabled: false },
  { value: "gpt-oss-202b", label: "GPT-OSS 202B", description: "SapinsapinAI Sovereign AI stack", disabled: true },
  { value: "gpt-4o", label: "GPT-4o", description: "Best multimodal, strong reasoning", disabled: true },
  { value: "gpt-5", label: "GPT-5", description: "Most capable, complex tasks", disabled: true },
  { value: "local-florence2", label: "Local — Gemma 3n E2B", description: "In-browser multimodal via MediaPipe WebGPU (~3.4GB)", disabled: true },
] as const;

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
  const { user } = useAuth();
  const [gmailLabel, setGmailLabel] = useState(true);
  const [driveSync, setDriveSync] = useState(true);
  const [spamFilter, setSpamFilter] = useState(true);
  const [namingTab, setNamingTab] = useState<"auto" | "manual">("auto");
  const [namingPattern, setNamingPattern] = useState(DEFAULT_PATTERN);
  const [sampleFilename, setSampleFilename] = useState("novastar.ai deck Mar2026 p24.pdf");
  const [detectingPattern, setDetectingPattern] = useState(false);
  const [patternDetected, setPatternDetected] = useState(false);
  const [aiModel, setAiModel] = useState("gpt-5.4");
  const [deepResearchProvider, setDeepResearchProvider] = useState<"custom" | "firecrawl">("custom");
  const [driveFolder, setDriveFolder] = useState("My Drive/WAIT ROOM");
  const [memoPrompt, setMemoPrompt] = useState(DEFAULT_MEMO_PROMPT);
  const [recapPattern, setRecapPattern] = useState(DEFAULT_RECAP_PATTERN);
  const [savingModel, setSavingModel] = useState(false);
  const [intakeSlug, setIntakeSlug] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);

  // Load settings from DB
  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_settings")
      .select("ai_model, gmail_label_enabled, drive_sync_enabled, spam_filter_enabled, deep_research_provider, naming_pattern, naming_mode, drive_folder, memo_prompt, recap_naming_pattern, intake_slug")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setAiModel(data.ai_model ?? "gpt-5.4");
          setGmailLabel(data.gmail_label_enabled ?? true);
          setDriveSync(data.drive_sync_enabled ?? true);
          setSpamFilter(data.spam_filter_enabled ?? true);
          setDeepResearchProvider((data as any).deep_research_provider ?? "custom");
          setDriveFolder((data as any).drive_folder ?? "My Drive/WAIT ROOM");
          if ((data as any).memo_prompt) setMemoPrompt((data as any).memo_prompt);
          if (data.naming_pattern) {
            setNamingPattern(data.naming_pattern);
          }
          if (data.naming_mode) {
            setNamingTab(data.naming_mode as "auto" | "manual");
          }
          if ((data as any).recap_naming_pattern) {
            setRecapPattern((data as any).recap_naming_pattern);
          }
          if ((data as any).intake_slug) {
            setIntakeSlug((data as any).intake_slug);
          }
        }
      });
  }, [user]);

  const handleModelChange = async (model: string) => {
    if (!user) return;
    setAiModel(model);
    setSavingModel(true);
    const updates: Record<string, unknown> = { user_id: user.id, ai_model: model };
    const { error } = await supabase
      .from("user_settings")
      .upsert(updates as any, { onConflict: "user_id" });
    setSavingModel(false);
    if (error) {
      toast.error("Failed to save model preference");
    } else {
      const label = AI_MODELS.find((m) => m.value === model)?.label;
      toast.success(`Model set to ${label}`);
    }
  };

  const saveNamingPattern = async (pattern: string) => {
    if (!user) return;
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: user.id, naming_pattern: pattern, naming_mode: namingTab }, { onConflict: "user_id" });
    if (error) {
      toast.error("Failed to save naming pattern");
    }
  };

  const handleDetectPattern = async () => {
    if (!sampleFilename.trim()) {
      toast.error("Please enter a sample filename");
      return;
    }
    setDetectingPattern(true);
    setPatternDetected(false);
    try {
      const { data, error } = await supabase.functions.invoke("detect-pattern", {
        body: { sampleFilename: sampleFilename.trim() },
      });
      if (error) throw error;
      if (data?.pattern) {
        setNamingPattern(data.pattern);
        setPatternDetected(true);
        await saveNamingPattern(data.pattern);
        toast.success("Pattern detected and saved!");
      } else {
        toast.error("Could not detect a pattern");
      }
    } catch (e) {
      console.error("Pattern detection failed:", e);
      toast.error("Pattern detection failed");
    } finally {
      setDetectingPattern(false);
    }
  };

  const handleResetPattern = async () => {
    setNamingPattern(DEFAULT_PATTERN);
    setPatternDetected(false);
    await saveNamingPattern(DEFAULT_PATTERN);
    toast.success("Pattern reset to default");
  };

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground mb-6">Settings</h1>

      {/* AI Model Selection */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          AI Model
        </h2>
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground mb-3">Select the OpenAI model used for deck analysis, chat, and memo generation.</p>
          <div className="grid grid-cols-2 gap-2">
            {AI_MODELS.map((model) => (
              <button
                key={model.value}
                onClick={() => !model.disabled && handleModelChange(model.value)}
                disabled={savingModel || model.disabled}
                className={`text-left rounded-lg border p-3 transition-colors ${
                  aiModel === model.value
                    ? "border-primary bg-primary/5"
                    : model.disabled
                      ? "border-border bg-muted/30 opacity-50 cursor-not-allowed"
                      : "border-border hover:border-primary/40 hover:bg-accent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${model.disabled ? "text-muted-foreground" : "text-foreground"}`}>
                    {model.label}
                  </span>
                  {aiModel === model.value && <Check className="h-3.5 w-3.5 text-primary ml-auto" />}
                  {model.disabled && aiModel !== model.value && (
                    <span className="ml-auto text-[9px] font-medium uppercase tracking-wider text-muted-foreground bg-muted rounded px-1 py-0.5">
                      Soon
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{model.description}</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Public Intake Link */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          Public Intake Link
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            Share this link with founders so they can submit their pitch decks directly into your pipeline.
          </p>
          {user && (
            <>
              {/* Current link display + copy */}
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  readOnly
                  value={`https://easyvc.lovable.app/intake/${intakeSlug || user.id}`}
                  className="flex-1 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm font-mono outline-none text-muted-foreground select-all"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`https://easyvc.lovable.app/intake/${intakeSlug || user.id}`);
                    toast.success("Intake link copied!");
                  }}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>

              {/* Custom slug editor */}
              <div>
                <label className="text-xs font-medium text-foreground mb-1 block">Custom Slug</label>
                <div className="flex gap-2 items-center">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">/intake/</span>
                  <input
                    type="text"
                    value={intakeSlug}
                    onChange={(e) => setIntakeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder={user.id}
                    className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={async () => {
                      if (!user) return;
                      setSavingSlug(true);
                      const slugValue = intakeSlug.trim() || null;
                      const { error } = await supabase
                        .from("user_settings")
                        .upsert({ user_id: user.id, intake_slug: slugValue } as any, { onConflict: "user_id" });
                      setSavingSlug(false);
                      if (error) {
                        if (error.message?.includes("duplicate") || error.code === "23505") {
                          toast.error("This slug is already taken. Try another one.");
                        } else {
                          toast.error("Failed to save slug");
                        }
                      } else {
                        toast.success(slugValue ? `Slug set to "${slugValue}"` : "Slug removed, using default UUID");
                      }
                    }}
                    disabled={savingSlug}
                    className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    {savingSlug ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Save
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Letters, numbers, and dashes only. Leave blank to use your default ID.
                </p>
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Decks submitted via this link appear in your pipeline with source <code className="bg-muted rounded px-1">inbound</code>.
          </p>
        </div>
      </section>

      {/* Naming Conventions */}
      <section className="mb-8">
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
                  value={sampleFilename}
                  onChange={(e) => setSampleFilename(e.target.value)}
                  className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={handleDetectPattern}
                  disabled={detectingPattern}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {detectingPattern ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {detectingPattern ? "Detecting…" : "Detect Pattern"}
                </button>
              </div>

              {/* Current pattern display */}
              <div className="rounded-md bg-muted/50 p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-medium text-muted-foreground">Current Pattern</p>
                  {namingPattern !== DEFAULT_PATTERN && (
                    <button
                      onClick={handleResetPattern}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset to default
                    </button>
                  )}
                </div>
                <code className="text-sm text-foreground">{namingPattern}</code>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Default: <code className="bg-muted rounded px-1">{DEFAULT_PATTERN}</code>
                </p>
              </div>

              {patternDetected && (
                <div className="rounded-md bg-success-muted p-3 flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Pattern detected & saved!</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      This pattern will be used when syncing files to Google Drive.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Edit the naming pattern directly using tokens.</p>
              <input
                type="text"
                value={namingPattern}
                onChange={(e) => setNamingPattern(e.target.value)}
                onBlur={() => saveNamingPattern(namingPattern)}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-1.5">
                  {["<WEBSITE>", "<NAME>", "<MonthYYYY>", "<pages>", "<SECTOR>", "<STAGE>"].map((token) => (
                    <button
                      key={token}
                      onClick={() => {
                        setNamingPattern((p) => p + " " + token);
                      }}
                      className="rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      {token}
                    </button>
                  ))}
                </div>
                {namingPattern !== DEFAULT_PATTERN && (
                  <button
                    onClick={handleResetPattern}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Default: <code className="bg-muted rounded px-1">{DEFAULT_PATTERN}</code>
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Recap Naming Pattern */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Recap File Naming
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            Pattern used when uploading generated memos to Google Drive. Same tokens as deck naming but defaults to "recap" instead of "deck".
          </p>
          <input
            type="text"
            value={recapPattern}
            onChange={(e) => setRecapPattern(e.target.value)}
            onBlur={async () => {
              if (!user) return;
              const { error } = await supabase
                .from("user_settings")
                .upsert({ user_id: user.id, recap_naming_pattern: recapPattern.trim() || DEFAULT_RECAP_PATTERN } as any, { onConflict: "user_id" });
              if (error) toast.error("Failed to save recap pattern");
              else toast.success("Recap naming pattern saved");
            }}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-1.5">
              {["<WEBSITE>", "<NAME>", "<MonthYYYY>", "<pages>", "<SECTOR>", "<STAGE>"].map((token) => (
                <button
                  key={token}
                  onClick={() => setRecapPattern((p) => p + " " + token)}
                  className="rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  {token}
                </button>
              ))}
            </div>
            {recapPattern !== DEFAULT_RECAP_PATTERN && (
              <button
                onClick={async () => {
                  setRecapPattern(DEFAULT_RECAP_PATTERN);
                  if (!user) return;
                  await supabase
                    .from("user_settings")
                    .upsert({ user_id: user.id, recap_naming_pattern: DEFAULT_RECAP_PATTERN } as any, { onConflict: "user_id" });
                  toast.success("Recap pattern reset to default");
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Default: <code className="bg-muted rounded px-1">{DEFAULT_RECAP_PATTERN}</code>
          </p>
        </div>
      </section>

      {/* Google Drive Folder */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          Drive Folder
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            Files synced to Google Drive will be saved inside this folder. It will be created automatically if it doesn't exist.
          </p>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={driveFolder}
              onChange={(e) => setDriveFolder(e.target.value)}
              onBlur={async () => {
                if (!user) return;
                const { error } = await supabase
                  .from("user_settings")
                  .upsert({ user_id: user.id, drive_folder: driveFolder.trim() || "My Drive/WAIT ROOM" } as any, { onConflict: "user_id" });
                if (error) toast.error("Failed to save folder");
                else toast.success("Drive folder saved");
              }}
              placeholder="My Drive/WAIT ROOM"
              className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
            {driveFolder !== "My Drive/WAIT ROOM" && (
              <button
                onClick={async () => {
                  setDriveFolder("My Drive/WAIT ROOM");
                  if (!user) return;
                  await supabase
                    .from("user_settings")
                    .upsert({ user_id: user.id, drive_folder: "My Drive/WAIT ROOM" } as any, { onConflict: "user_id" });
                  toast.success("Folder reset to default");
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Default: <code className="bg-muted rounded px-1">My Drive/WAIT ROOM</code>
          </p>
        </div>
      </section>

      {/* Memo Summarisation Prompt */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Memo Summarisation Prompt
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            This prompt is sent to the AI when generating investment memos from deck data. Customise it to match your firm's memo format.
          </p>
          <textarea
            value={memoPrompt}
            onChange={(e) => setMemoPrompt(e.target.value)}
            onBlur={async () => {
              if (!user) return;
              const { error } = await supabase
                .from("user_settings")
                .upsert({ user_id: user.id, memo_prompt: memoPrompt.trim() || null } as any, { onConflict: "user_id" });
              if (error) toast.error("Failed to save memo prompt");
              else toast.success("Memo prompt saved");
            }}
            rows={14}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring resize-y"
            placeholder="Enter your memo generation prompt..."
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Changes are saved automatically on blur.
            </p>
            {memoPrompt !== DEFAULT_MEMO_PROMPT && (
              <button
                onClick={async () => {
                  setMemoPrompt(DEFAULT_MEMO_PROMPT);
                  if (!user) return;
                  await supabase
                    .from("user_settings")
                    .upsert({ user_id: user.id, memo_prompt: null } as any, { onConflict: "user_id" });
                  toast.success("Memo prompt reset to default");
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to default
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Deep Research Provider */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          Deep Research Agent
        </h2>
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground mb-3">Choose which engine powers company deep research after deck extraction.</p>
          <div className="grid grid-cols-2 gap-2">
            {([
              { value: "custom" as const, label: "Custom Agent", description: "Uses your selected AI model + Firecrawl search", disabled: false },
              { value: "firecrawl" as const, label: "Firecrawl Only", description: "Firecrawl search + scrape, no LLM extraction", disabled: true },
            ]).map((opt) => (
              <button
                key={opt.value}
                onClick={async () => {
                  if (!user || opt.disabled) return;
                  setDeepResearchProvider(opt.value);
                  const { error } = await supabase
                    .from("user_settings")
                    .upsert({ user_id: user.id, deep_research_provider: opt.value } as any, { onConflict: "user_id" });
                  if (error) toast.error("Failed to save preference");
                  else toast.success(`Deep research set to ${opt.label}`);
                }}
                disabled={opt.disabled}
                className={`text-left rounded-lg border p-3 transition-colors ${
                  opt.disabled
                    ? "opacity-50 cursor-not-allowed border-border bg-muted/30"
                    : deepResearchProvider === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-accent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{opt.label}</span>
                  {opt.disabled && <span className="ml-auto text-[9px] rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">Soon</span>}
                  {!opt.disabled && deepResearchProvider === opt.value && <Check className="h-3.5 w-3.5 text-primary ml-auto" />}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Google Email & Drive Sync */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Google Email & Drive Sync
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Gmail Auto-Ingest</p>
              <p className="text-xs text-muted-foreground">Listen to Gmail label <code className="rounded bg-muted px-1.5 py-0.5 text-xs">deck</code> and auto-ingest attached decks</p>
            </div>
            <Toggle checked={gmailLabel} onChange={async (v) => {
              if (!user) return;
              setGmailLabel(v);
              const { error } = await supabase
                .from("user_settings")
                .upsert({ user_id: user.id, gmail_label_enabled: v } as any, { onConflict: "user_id" });
              if (error) toast.error("Failed to save");
              else toast.success(v ? "Gmail auto-ingest enabled" : "Gmail auto-ingest disabled");
            }} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Drive Sync</p>
              <p className="text-xs text-muted-foreground">Automatically sync processed decks and memos to Google Drive</p>
            </div>
            <Toggle checked={driveSync} onChange={async (v) => {
              if (!user) return;
              setDriveSync(v);
              const { error } = await supabase
                .from("user_settings")
                .upsert({ user_id: user.id, drive_sync_enabled: v } as any, { onConflict: "user_id" });
              if (error) toast.error("Failed to save");
              else toast.success(v ? "Drive sync enabled" : "Drive sync disabled");
            }} />
          </div>
        </div>
      </section>

      {/* Firm Deal Desk */}
      <section className="mb-8 opacity-40 pointer-events-none select-none">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          Firm Deal Desk
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted rounded px-1.5 py-0.5">Coming Soon</span>
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <button className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium" disabled>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            Connect Shared Inbox
          </button>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">Enable AI Spam & Relevance Filtering</p>
              <p className="text-xs text-muted-foreground">AI Gatekeeper blocks vendor emails</p>
            </div>
            <Toggle checked={spamFilter} onChange={() => {}} />
          </div>
          <div className="flex gap-6 pt-2">
            <div>
              <span className="text-2xl font-semibold text-foreground">—</span>
              <p className="text-xs text-muted-foreground">Pitches Processed</p>
            </div>
            <div>
              <span className="text-2xl font-semibold text-foreground">—</span>
              <p className="text-xs text-muted-foreground">Spam Blocked</p>
            </div>
          </div>
        </div>
      </section>

      <StorageCleanupSection userId={user?.id} />

      {/* DocSend Bookmarklet - DISABLED */}
      {/* <section className="mb-8">
        <h2 className="text-sm font-semibold text-foreground mb-4">DocSend Ingestion</h2>
        <BookmarkletInstaller />
      </section> */}
    </div>
  );
}
