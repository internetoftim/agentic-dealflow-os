import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCaptureInput, buildDealInput, dealPatchFromDiligence, DILIGENCE_BUDGET_CENTS, DILIGENCE_RUBRIC, diligenceMetrics,
  failureMessage, idleAction, MAX_INPUT_TEXT_CHARS, newestByFilename, parseCaptureReport, parseDiligence, peopleRowsFromDiligence,
  readSessionKind, sessionMetadata,
} from "../../../supabase/functions/_shared/agent-sessions-core";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

const REPORT = {
  company: {
    name: "NovaStar AI", website: "https://novastar.example", linkedin_url: "https://www.linkedin.com/company/novastar",
    crunchbase_url: "not a url", funding_total: "$3.5M", last_funding_round: "Seed (2025)", num_employees: 18,
    investors: ["Example Ventures", "Excluded Capital", ""],
  },
  founders: [
    { name: "Ada Example", title: "CEO", linkedin_url: "https://www.linkedin.com/in/ada" },
    { name: "Ben Sample", title: "CTO", linkedin_url: null },
    { name: "" },
  ],
  claims: [
    { claim: "$1.2M ARR", slide: 7, verdict: "verified", sources: ["https://news.example/a", "javascript:alert(1)"] },
    { claim: "40 enterprise customers", slide: 8, verdict: "contradicted", sources: ["https://news.example/b"] },
    { claim: "#1 in claims AI", slide: 3, verdict: "maybe", sources: [] },
  ],
  market: { market_definition: "Claims review software for mid-size carriers" },
  competitors: [{ name: "Acme Claims" }, { website: "https://nameless.example" }],
  news: [
    { title: "Seed round", url: "https://news.example/seed", source: "news.example" },
    { title: "Excluded story", url: "https://bad.example/x" },
    { title: "No url" },
  ],
  risks: [{ risk: "Customer count contradicted", severity: "high" }],
  gaps: ["Revenue is private"],
  recommendation: "follow_up",
  summary: "Promising, one contradicted claim.",
};

describe("diligence results map back onto EasyVC's tables", () => {
  const d = parseDiligence(JSON.stringify(REPORT));

  it("parses defensively: drops nameless entries, bad URLs and unknown verdicts", () => {
    expect(d.company.crunchbase_url).toBeNull();
    expect(d.company.num_employees).toBe("18");
    expect(d.company.investors).toEqual(["Example Ventures", "Excluded Capital"]);
    expect(d.founders.map((f) => f.name)).toEqual(["Ada Example", "Ben Sample"]);
    expect(d.claims[0].sources).toEqual(["https://news.example/a"]);
    expect(d.claims[2].verdict).toBe("unverifiable");
    expect(d.competitors).toHaveLength(1);
    expect(d.news).toHaveLength(2);
    expect(d.recommendation).toBe("follow_up");
  });

  it("rejects files that aren't a JSON object", () => {
    expect(() => parseDiligence("not json")).toThrow(/not valid JSON/);
    expect(() => parseDiligence("[1,2]")).toThrow(/not a JSON object/);
  });

  it("counts verdicts for the UI and pipeline_runs", () => {
    expect(diligenceMetrics(d)).toMatchObject({ claims: 3, verified: 1, contradicted: 1, unverifiable: 1, high_risks: 1, sourced_claims: 2 });
  });

  it("fills deal fields like deep-research did, keeping user choices", () => {
    const exclusions = { articles: ["https://bad.example/x"], investors: ["Excluded Capital"], people: [] };
    const patch = dealPatchFromDiligence(d, { website: "https://user-set.example", team_size: null, research_exclusions: exclusions });
    expect(patch.deep_research_status).toBe("completed");
    expect(patch.website).toBeUndefined(); // the user's website wins
    expect(patch.team_size).toBe("18");
    expect(patch.investors).toBe("Example Ventures");
    expect(patch.latest_articles).toEqual([{ title: "Seed round", url: "https://news.example/seed", source: "news.example", preview: null }]);
  });

  it("adds researched people but never duplicates or overrides hand-added ones", () => {
    const rows = peopleRowsFromDiligence(d, ["ada example"], { people: ["Nobody"] }, { dealId: "deal", userId: "user" });
    expect(rows).toEqual([{ deal_id: "deal", user_id: "user", name: "Ben Sample", title: "CTO", linkedin_url: null }]);
  });
});

describe("session inputs", () => {
  it("deal.json carries known fields, people and capped deck text, primary deck first", () => {
    const input = buildDealInput(
      { id: "d1", name: "NovaStar", website: "", stage: "Seed", memo_draft: "not sent" },
      [{ name: "Ada", manual: true }],
      [{ extracted_text: "appendix", is_primary: false }, { extracted_text: "x".repeat(MAX_INPUT_TEXT_CHARS + 10), is_primary: true }],
      ["  ", "Met at demo day"],
    );
    expect(input).toMatchObject({ deal_id: "d1", name: "NovaStar", stage: "Seed", investor_notes: ["Met at demo day"], extracted_text_truncated: true });
    expect(input).not.toHaveProperty("website");
    expect(input).not.toHaveProperty("memo_draft");
    expect(input.people).toEqual([{ name: "Ada", title: null, linkedin_url: null, added_by_user: true }]);
    expect(input.extracted_text.length).toBe(MAX_INPUT_TEXT_CHARS);
    expect(input.extracted_text.startsWith("x")).toBe(true);
  });

  it("capture.json clamps max_pages", () => {
    expect(buildCaptureInput({ url: "https://docsend.com/view/x", maxPages: 500 })).toEqual({ url: "https://docsend.com/view/x", gate_email: null, passcode: null, max_pages: 100 });
  });

  it("the diligence budget is $10 and the rubric covers every section", () => {
    expect(DILIGENCE_BUDGET_CENTS).toBe("1000");
    for (const word of ["founder", "claims", "bottom-up", "top-down", "competitors", "memo.md", "risks"]) {
      expect(DILIGENCE_RUBRIC).toContain(word);
    }
  });
});

describe("capture reports and session lifecycle", () => {
  it("parses capture.json and keeps only preview files the agent was told to write", () => {
    const ok = parseCaptureReport(JSON.stringify({ status: "ok", title: "Deck", page_count: 12.7, previews: ["preview-1.jpg", "../etc/passwd", "preview-2.png"] }));
    expect(ok).toEqual({ status: "ok", title: "Deck", page_count: 12, source_type: null, previews: ["preview-1.jpg", "preview-2.png"], notes: undefined });
    expect(parseCaptureReport(JSON.stringify({ status: "failed", reason: "Needs a passcode." }))).toEqual({ status: "failed", reason: "Needs a passcode." });
    expect(parseCaptureReport("garbage").status).toBe("failed");
  });

  it("unattended sessions deny paused tool calls and collect on end_turn", () => {
    expect(idleAction("end_turn")).toBe("collect");
    expect(idleAction("requires_action")).toBe("deny_pending");
    expect(idleAction("budget_reached")).toBe("budget_reached");
    expect(idleAction("refusal")).toBe("failed");
    expect(failureMessage("budget_reached", "budget_reached")).toMatch(/spending cap/);
  });

  it("output listing keeps the newest file per name (inputs share the session scope)", () => {
    const files = newestByFilename([
      { id: "input", filename: "capture.json", created_at: "2026-10-17T08:40:25Z" },
      { id: "output", filename: "capture.json", created_at: "2026-10-17T08:49:00Z" },
      { id: "pdf", filename: "deck.pdf", created_at: "2026-10-17T08:48:00Z" },
    ]);
    expect(files.map((f) => f.id).sort()).toEqual(["output", "pdf"]);
    expect(read("supabase/functions/_shared/managed-agents.ts")).toContain('mount_path: "/mnt/session/inputs/capture-request.json"');
  });

  it("metadata round-trips the session kind and drops empty ids", () => {
    const meta = sessionMetadata("capture", { job_id: "j1", attach: "", deal_source: null });
    expect(meta).toEqual({ app: "easyvc", kind: "capture", job_id: "j1" });
    expect(readSessionKind(meta)).toBe("capture");
    expect(readSessionKind({ kind: "other" })).toBeNull();
  });
});

describe("wiring", () => {
  it("process-deck starts diligence instead of deep-research only behind the flag", () => {
    const pd = read("supabase/functions/process-deck/index.ts");
    expect(pd).toMatch(/if \(diligenceEnabledFor\(userId\)\) \{[\s\S]*?functions\/v1\/run-diligence[\s\S]*?\} else try \{[\s\S]*?functions\/v1\/deep-research/);
    expect(read("supabase/functions/_shared/agent-flags.ts")).toMatch(/DILIGENCE_AGENT"\) !== "on"\) return false/);
  });

  it("capture defaults to the agent and keeps the Cloud Run path behind CAPTURE_BACKEND", () => {
    const rc = read("supabase/functions/run-docsend-capture/index.ts");
    expect(rc).toMatch(/if \(captureBackend\(\) === "agent"\) \{[\s\S]*?startCaptureSession/);
    expect(rc).toMatch(/completeSessionId[\s\S]*?if \(!isInternalCall\) return jsonResponse\(\{ error: "Unauthorized" \}, 401\)/);
  });

  it("the public converter only runs for internal callers and is capped per hour", () => {
    const rc = read("supabase/functions/run-conversion/index.ts");
    expect(rc).toMatch(/!== `Bearer \$\{Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)\}`/);
    expect(rc).toMatch(/CONVERSION_HOURLY_CAP/);
  });

  it("the webhook verifies signatures and handles idle and terminated sessions", () => {
    const wh = read("supabase/functions/agent-webhook/index.ts");
    expect(wh).toMatch(/unwrapWebhook\(body, req\.headers\)/);
    expect(wh).toMatch(/"session\.status_idled", "session\.status_terminated"/);
    expect(wh).toMatch(/\.in\("status", \["starting", "running"\]\)/); // claim before saving: duplicates are no-ops
  });

  it("the MCP server exposes the diligence tools, gates writes behind Agent Mode, and offers the prompt", () => {
    const mcp = read("supabase/functions/mcp-server/index.ts");
    for (const tool of ["run_diligence", "ask_diligence", "get_diligence_run", "get_diligence_report"]) {
      expect(mcp).toContain(`name: "${tool}"`);
    }
    expect(mcp).toMatch(/case "run_diligence":\s*case "ask_diligence":[\s\S]*?isAgentModeEnabled/);
    expect(mcp).toContain(`name: "deal_diligence"`);
  });

  it("new functions validate callers themselves", () => {
    const config = read("supabase/config.toml");
    expect(config).toMatch(/\[functions\.run-diligence\]\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.agent-webhook\]\nverify_jwt = false/);
  });
});
