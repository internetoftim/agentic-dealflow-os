// Deal agent — a conversational way to refine one deal's data room, with every
// exchange, change and human judgement logged for later learning.
//
// POST (user JWT), one of:
//   { dealId, messages: [{ role, content }] }
//       → { turnId, reply, actions: [{ tool, ok, summary, revisionId }], changed }
//   { dealId, undoRevisionId }
//       → { ok, summary, revisionId }
//   { dealId, rateTurnId, rating: 1 | -1, comment? }
//       → { ok }
//
// The model (the workspace's configured provider; GLM via NYO by default) gets
// a snapshot of the deal and a small set of tools. Each tool call is executed
// here against THIS deal only, on behalf of its owner. The rules (field
// whitelist, matching, exclusions) are pure functions in
// _shared/deal-agent-tools.ts; the logging rules are in _shared/feedback-log.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveChatProvider, maxTokensParam } from "../_shared/ai-provider.ts";
import {
  AGENT_SYSTEM_PROMPT, AGENT_TOOLS, AGENT_TOOL_NAMES,
  addArticle, applyInvestorChanges, applyMemoEdit, buildSnapshot, findPerson, mergeExclusions,
  normalizeHttpUrl, readExclusions, removeArticles, sanitizeFieldUpdates, trimHistory, withoutExclusion,
  type AgentAction, type Article, type InvestorProfile, type Person,
} from "../_shared/deal-agent-tools.ts";
import {
  AGENT_PROMPT_VERSION, boundedJson, diffPatch, fieldCorrectionFeedback, planUndo, ratingFeedback,
  relevanceFeedback, revertFeedback, type FeedbackEvent, type Revision, type RunRef,
} from "../_shared/feedback-log.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_STEPS = 6;

type ToolResult = { ok: boolean; summary: string; revisionId?: string | null };
type RevisionInput = {
  tool: string; summary: string; target?: "deal" | "person" | "note"; targetId?: string | null;
  before: Record<string, unknown>; after: Record<string, unknown>; actor?: "agent" | "user"; reverts?: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  let admin: any = null;
  let turnId: string | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const dealId = typeof body?.dealId === "string" ? body.dealId : "";
    if (!dealId) return json({ error: "Missing dealId" }, 400);

    admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Only the owner refines a deal. Someone it is shared with can read and chat, not edit.
    const { data: dealRow } = await admin.from("deals").select("*").eq("id", dealId).maybeSingle();
    if (!dealRow) return json({ error: "Deal not found" }, 404);
    if (dealRow.user_id !== user.id) {
      const { data: canAccess } = await admin.rpc("can_access_deal", { _deal_id: dealId, _user_id: user.id });
      return canAccess
        ? json({ error: "Only the deal's owner can change its data" }, 403)
        : json({ error: "Deal not found" }, 404);
    }

    const state: { deal: Record<string, any>; people: Person[]; sources: Array<{ file_name: string; is_primary?: boolean | null }> } = {
      deal: dealRow, people: [], sources: [],
    };
    const feedbackContext = () => ({ name: state.deal.name, sector: state.deal.sector, stage: state.deal.stage });

    // ---------------------------------------------------------------- logging helpers
    const recordRevision = async (r: RevisionInput): Promise<string | null> => {
      const { data, error } = await admin.from("deal_revisions").insert({
        deal_id: dealId, user_id: user.id, turn_id: turnId, actor: r.actor ?? "agent", tool: r.tool,
        target: r.target ?? "deal", target_id: r.targetId ?? null, summary: r.summary.slice(0, 500),
        before: boundedJson(r.before), after: boundedJson(r.after), reverts: r.reverts ?? null,
      }).select("id").single();
      if (error) { console.error("deal-agent: revision not recorded:", error.message); return null; }
      return data.id as string;
    };
    const recordFeedback = async (events: FeedbackEvent[], revisionId?: string | null) => {
      if (events.length === 0) return;
      const { error } = await admin.from("feedback_events").insert(events.map((e) => ({
        deal_id: dealId, user_id: user.id, turn_id: turnId, revision_id: revisionId ?? null,
        kind: e.kind, label: e.label, item: boundedJson(e.item), before: e.before === undefined ? null : boundedJson(e.before),
        after: e.after === undefined ? null : boundedJson(e.after), reason: e.reason ?? null,
        context: feedbackContext(), producer: e.producer,
      })));
      if (error) console.error("deal-agent: feedback not recorded:", error.message);
    };
    /** Write a deal patch; with `rev`, record it as a numbered revision. */
    const saveDeal = async (patch: Record<string, unknown>, rev?: { tool: string; summary: string; actor?: "agent" | "user"; reverts?: string | null }) => {
      const { before, after } = diffPatch(state.deal, patch);
      const { error } = await admin.from("deals")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", dealId).eq("user_id", user.id);
      if (error) throw new Error(error.message);
      Object.assign(state.deal, patch);
      const revisionId = rev && Object.keys(after).length ? await recordRevision({ ...rev, before, after }) : null;
      return { revisionId, before, after };
    };

    // ---------------------------------------------------------------- undo (shared by the button and the tool)
    const undoRevision = async (revisionId: string): Promise<ToolResult> => {
      const { data: rev } = await admin.from("deal_revisions")
        .select("id, target, target_id, tool, summary, before, after, reverts, reverted_at, turn_id")
        .eq("id", revisionId).eq("deal_id", dealId).eq("user_id", user.id).maybeSingle();
      if (!rev) return { ok: false, summary: "That change was not found" };
      const plan = planUndo(rev as Revision);
      if (!plan.op) return { ok: false, summary: plan.error ?? "That change cannot be undone" };

      const summary = `Undid: ${rev.summary}`;
      let undoRevisionId: string | null = null;
      const op = plan.op;
      if (op.kind === "patch_deal") {
        undoRevisionId = (await saveDeal(op.patch, { tool: "undo", summary, actor: "user", reverts: rev.id })).revisionId;
      } else if (op.kind === "delete_person") {
        const { error } = await admin.from("deal_people").delete().eq("id", op.id).eq("deal_id", dealId);
        if (error) throw new Error(error.message);
        undoRevisionId = await recordRevision({ tool: "undo", summary, actor: "user", target: "person", targetId: op.id, before: rev.after, after: {}, reverts: rev.id });
      } else if (op.kind === "insert_person") {
        const row = op.row as Record<string, any>;
        const { data: inserted, error } = await admin.from("deal_people")
          .insert({ deal_id: dealId, user_id: user.id, name: row.name, title: row.title ?? null, linkedin_url: row.linkedin_url ?? null, manual: row.manual ?? false })
          .select("id").single();
        if (error) throw new Error(error.message);
        // Bringing the person back also lets research include them again.
        await saveDeal({ research_exclusions: withoutExclusion(state.deal.research_exclusions, "people", String(row.name ?? "")) });
        undoRevisionId = await recordRevision({ tool: "undo", summary, actor: "user", target: "person", targetId: inserted.id, before: {}, after: rev.before, reverts: rev.id });
      } else if (op.kind === "update_person") {
        const { error } = await admin.from("deal_people").update(op.patch).eq("id", op.id).eq("deal_id", dealId);
        if (error) throw new Error(error.message);
        undoRevisionId = await recordRevision({ tool: "undo", summary, actor: "user", target: "person", targetId: op.id, before: rev.after, after: rev.before, reverts: rev.id });
      } else if (op.kind === "delete_note") {
        const { error } = await admin.from("deal_notes").delete().eq("id", op.id).eq("deal_id", dealId);
        if (error) throw new Error(error.message);
        undoRevisionId = await recordRevision({ tool: "undo", summary, actor: "user", target: "note", targetId: op.id, before: rev.after, after: {}, reverts: rev.id });
      }

      await admin.from("deal_revisions").update({ reverted_at: new Date().toISOString() }).eq("id", rev.id);
      // An undone agent action is the strongest implicit "that was wrong" we get.
      let turn = null;
      if (rev.turn_id) {
        const { data } = await admin.from("agent_turns").select("id, prompt_version, provider, model").eq("id", rev.turn_id).maybeSingle();
        turn = data ?? null;
      }
      await recordFeedback([revertFeedback({ ...(rev as Revision), summary: rev.summary, turn })], rev.id);
      return { ok: true, summary, revisionId: undoRevisionId };
    };

    // ---------------------------------------------------------------- mode: undo button
    if (typeof body?.undoRevisionId === "string") {
      const result = await undoRevision(body.undoRevisionId);
      return json(result, result.ok ? 200 : 409);
    }

    // ---------------------------------------------------------------- mode: rate a turn
    if (typeof body?.rateTurnId === "string") {
      const rating = Number(body.rating);
      if (rating !== 1 && rating !== -1) return json({ error: "rating must be 1 or -1" }, 400);
      const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim().slice(0, 1000) : null;
      const { data: turn } = await admin.from("agent_turns")
        .update({ rating, rating_comment: comment, rated_at: new Date().toISOString() })
        .eq("id", body.rateTurnId).eq("deal_id", dealId).eq("user_id", user.id)
        .select("id, prompt_version, provider, model").maybeSingle();
      if (!turn) return json({ error: "Turn not found" }, 404);
      turnId = turn.id;
      await recordFeedback([ratingFeedback(rating, comment, turn)]);
      return json({ ok: true });
    }

    // ---------------------------------------------------------------- mode: chat
    const history = trimHistory(body?.messages);
    if (history.length === 0 || history[history.length - 1].role !== "user") return json({ error: "Missing user message" }, 400);

    const [{ data: people }, { data: sources }, { data: settings }, { data: runRows }] = await Promise.all([
      admin.from("deal_people").select("id, name, title, linkedin_url, manual").eq("deal_id", dealId).order("created_at", { ascending: true }),
      admin.from("sources").select("file_name, is_primary").eq("deal_id", dealId).order("is_primary", { ascending: false }),
      admin.from("user_settings").select("ai_model").eq("user_id", user.id).maybeSingle(),
      admin.from("pipeline_runs").select("id, stage, version, provider, model").eq("deal_id", dealId).order("created_at", { ascending: false }).limit(30),
    ]);
    state.people = (people ?? []) as Person[];
    state.sources = sources ?? [];
    // Latest run per stage: what a judged item is attributed to.
    const latestRuns: RunRef[] = [];
    for (const r of (runRows ?? []) as RunRef[]) if (!latestRuns.some((x) => x.stage === r.stage)) latestRuns.push(r);

    const provider = resolveChatProvider(settings?.ai_model, (k) => Deno.env.get(k));
    const snapshot = () => buildSnapshot({
      deal: state.deal,
      articles: Array.isArray(state.deal.latest_articles) ? state.deal.latest_articles : [],
      profiles: Array.isArray(state.deal.investor_research) ? state.deal.investor_research : [],
      people: state.people,
      sources: state.sources,
      exclusions: readExclusions(state.deal.research_exclusions),
    });
    const initialSnapshot = snapshot();

    // The turn row exists before any change so every revision can point at it.
    {
      const { data: turnRow, error: turnError } = await admin.from("agent_turns").insert({
        deal_id: dealId, user_id: user.id, prompt_version: AGENT_PROMPT_VERSION, provider: provider.id, model: provider.model,
        user_message: history[history.length - 1].content, history: history.slice(0, -1), snapshot: initialSnapshot,
      }).select("id").single();
      if (turnError) console.error("deal-agent: turn not recorded:", turnError.message);
      turnId = turnRow?.id ?? null;
    }

    const actions: AgentAction[] = [];
    const toolLog: Array<Record<string, unknown>> = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const background: Promise<unknown>[] = [];
    const invoke = (fn: string) => {
      background.push(fetch(`${supabaseUrl}/functions/v1/${fn}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dealId }),
      }).then(async (res) => {
        if (!res.ok) console.error(`deal-agent: ${fn} failed:`, res.status, await res.text().catch(() => ""));
      }).catch((e) => console.error(`deal-agent: ${fn} dispatch failed:`, e)));
    };

    // ---------------------------------------------------------------- tools
    const runTool = async (name: string, args: Record<string, any>): Promise<ToolResult> => {
      switch (name) {
        case "update_deal_fields": {
          const { updates, rejected } = sanitizeFieldUpdates(args.fields);
          if (Object.keys(updates).length === 0) {
            return { ok: false, summary: `No valid fields to update${rejected.length ? ` (rejected: ${rejected.join(", ")})` : ""}` };
          }
          const parts = Object.entries(updates).map(([k, v]) => (v === null ? `cleared ${k}` : `${k} → ${v}`));
          const summary = `Updated ${parts.join(", ")}`;
          const { revisionId, before, after } = await saveDeal(updates, { tool: name, summary });
          if (Object.keys(after).length === 0) return { ok: true, summary: "Those values were already set" };
          await recordFeedback(fieldCorrectionFeedback(before, after, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "remove_articles": {
          const articles: Article[] = Array.isArray(state.deal.latest_articles) ? state.deal.latest_articles : [];
          const { kept, removed } = removeArticles(articles, args);
          if (removed.length === 0) return { ok: false, summary: "No matching article found" };
          const summary = `Removed ${removed.length === 1 ? `article “${removed[0].title}”` : `${removed.length} articles`}`;
          const { revisionId } = await saveDeal({
            latest_articles: kept,
            research_exclusions: mergeExclusions(state.deal.research_exclusions, { articles: removed.map((a) => a.url) }),
          }, { tool: name, summary });
          await recordFeedback(relevanceFeedback("article", removed, "irrelevant", args.reason, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "add_article": {
          const articles: Article[] = Array.isArray(state.deal.latest_articles) ? state.deal.latest_articles : [];
          const result = addArticle(articles, args);
          if (!result.added) return { ok: false, summary: result.error ?? "Could not add the article" };
          const summary = `Added article “${result.added.title}”`;
          const { revisionId } = await saveDeal({
            latest_articles: result.articles,
            research_exclusions: withoutExclusion(state.deal.research_exclusions, "articles", result.added.url),
          }, { tool: name, summary });
          await recordFeedback(relevanceFeedback("article", [result.added], "added", null, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "update_investors": {
          const profiles: InvestorProfile[] = Array.isArray(state.deal.investor_research) ? state.deal.investor_research : [];
          const next = applyInvestorChanges(state.deal.investors, profiles, args);
          if (next.added.length === 0 && next.removed.length === 0) return { ok: false, summary: "No matching investor to add or remove" };
          let exclusions = mergeExclusions(state.deal.research_exclusions, { investors: next.removed });
          for (const n of next.added) exclusions = withoutExclusion(exclusions, "investors", n);
          const parts = [
            next.removed.length ? `removed ${next.removed.join(", ")}` : "",
            next.added.length ? `added ${next.added.join(", ")}` : "",
          ].filter(Boolean);
          const summary = `Investors: ${parts.join("; ")}`;
          const { revisionId } = await saveDeal({ investors: next.investors, investor_research: next.profiles, research_exclusions: exclusions }, { tool: name, summary });
          await recordFeedback([
            ...relevanceFeedback("investor", next.removed.map((n) => ({ name: n })), "irrelevant", args.reason, latestRuns),
            ...relevanceFeedback("investor", next.added.map((n) => ({ name: n })), "added", null, latestRuns),
          ], revisionId);
          return { ok: true, summary, revisionId };
        }
        case "upsert_person": {
          const personName = typeof args.name === "string" ? args.name.trim().slice(0, 160) : "";
          if (personName.length < 2) return { ok: false, summary: "A person's name is required" };
          const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 200) : undefined;
          const linkedin = typeof args.linkedin_url === "string" && args.linkedin_url.trim() ? normalizeHttpUrl(args.linkedin_url.trim()) : undefined;
          if (args.linkedin_url && !linkedin) return { ok: false, summary: "That LinkedIn URL is not valid" };
          const existing = findPerson(state.people, personName);
          if (existing?.id) {
            const patch: Record<string, unknown> = { manual: true };
            if (title !== undefined) patch.title = title;
            if (linkedin !== undefined) patch.linkedin_url = linkedin;
            const { before, after } = diffPatch(existing as Record<string, unknown>, patch);
            const { error } = await admin.from("deal_people").update(patch).eq("id", existing.id).eq("deal_id", dealId);
            if (error) throw new Error(error.message);
            Object.assign(existing, patch);
            const summary = `Updated ${existing.name}${title ? ` — ${title}` : ""}`;
            const revisionId = await recordRevision({ tool: name, summary, target: "person", targetId: existing.id, before, after });
            await recordFeedback([{ kind: "person", label: "corrected", item: { name: existing.name }, before, after, producer: {} }], revisionId);
            return { ok: true, summary, revisionId };
          }
          const { data: inserted, error } = await admin.from("deal_people")
            .insert({ deal_id: dealId, user_id: user.id, name: personName, title: title ?? null, linkedin_url: linkedin ?? null, manual: true })
            .select("id, name, title, linkedin_url, manual").single();
          if (error) throw new Error(error.message);
          state.people.push(inserted as Person);
          await saveDeal({ research_exclusions: withoutExclusion(state.deal.research_exclusions, "people", personName) });
          const summary = `Added ${personName}${title ? `, ${title}` : ""}`;
          const after = { name: inserted.name, title: inserted.title, linkedin_url: inserted.linkedin_url, manual: true };
          const revisionId = await recordRevision({ tool: name, summary, target: "person", targetId: inserted.id, before: {}, after });
          await recordFeedback(relevanceFeedback("person", [after], "added", null, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "remove_person": {
          const existing = findPerson(state.people, args.name);
          if (!existing?.id) return { ok: false, summary: `No person named “${String(args.name ?? "")}” on this deal` };
          const before = { name: existing.name, title: existing.title ?? null, linkedin_url: existing.linkedin_url ?? null, manual: existing.manual ?? false };
          const { error } = await admin.from("deal_people").delete().eq("id", existing.id).eq("deal_id", dealId);
          if (error) throw new Error(error.message);
          state.people = state.people.filter((p) => p.id !== existing.id);
          await saveDeal({ research_exclusions: mergeExclusions(state.deal.research_exclusions, { people: [existing.name] }) });
          const summary = `Removed ${existing.name}`;
          const revisionId = await recordRevision({ tool: name, summary, target: "person", targetId: existing.id, before, after: {} });
          await recordFeedback(relevanceFeedback("person", [before], "irrelevant", args.reason, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "update_memo": {
          const { memo, error } = applyMemoEdit(state.deal.memo_draft, args);
          if (error) return { ok: false, summary: `Memo not changed: ${error}` };
          const summary = args.mode === "replace" ? "Replaced the memo draft" : "Added to the memo draft";
          const { revisionId, before, after } = await saveDeal({ memo_draft: memo }, { tool: name, summary });
          await recordFeedback([{ kind: "memo", label: "corrected", item: { mode: args.mode === "replace" ? "replace" : "append" }, before: before.memo_draft ?? null, after: after.memo_draft ?? null, producer: {} }], revisionId);
          return { ok: true, summary, revisionId };
        }
        case "add_note": {
          const content = typeof args.content === "string" ? args.content.trim().slice(0, 4000) : "";
          if (!content) return { ok: false, summary: "The note is empty" };
          const { data: note, error } = await admin.from("deal_notes")
            .insert({ deal_id: dealId, user_id: user.id, content, author_email: user.email ?? null }).select("id").single();
          if (error) throw new Error(error.message);
          const revisionId = await recordRevision({ tool: name, summary: "Added a note", target: "note", targetId: note.id, before: {}, after: { content } });
          return { ok: true, summary: "Added a note", revisionId };
        }
        case "restore_excluded": {
          const kind = args.kind as "articles" | "investors" | "people";
          const value = typeof args.value === "string" ? args.value.trim() : "";
          if (!["articles", "investors", "people"].includes(kind) || !value) return { ok: false, summary: "Say which article, investor or person to restore" };
          const before = readExclusions(state.deal.research_exclusions);
          const after = withoutExclusion(before, kind, value);
          if (after[kind].length === before[kind].length) return { ok: false, summary: `“${value}” was not marked as not relevant` };
          const summary = `Research may include “${value}” again`;
          const { revisionId } = await saveDeal({ research_exclusions: after }, { tool: name, summary });
          const itemKind = kind === "articles" ? "article" : kind === "investors" ? "investor" : "person";
          await recordFeedback(relevanceFeedback(itemKind, [kind === "articles" ? { url: value } : { name: value }], "relevant", null, latestRuns), revisionId);
          return { ok: true, summary, revisionId };
        }
        case "undo_last_change": {
          const { data: last } = await admin.from("deal_revisions")
            .select("id").eq("deal_id", dealId).eq("user_id", user.id)
            .is("reverts", null).is("reverted_at", null)
            .order("version", { ascending: false }).limit(1).maybeSingle();
          if (!last) return { ok: false, summary: "There is no change to undo" };
          return await undoRevision(last.id);
        }
        case "rerun_research": {
          await saveDeal({ deep_research_status: "researching" });
          invoke("deep-research");
          return { ok: true, summary: "Started deep research in the background" };
        }
        case "generate_memo": {
          invoke("generate-memo");
          return { ok: true, summary: "Started memo generation in the background" };
        }
        default:
          return { ok: false, summary: `Unknown tool: ${name}` };
      }
    };

    // ---------------------------------------------------------------- loop
    const messages: any[] = [
      { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\nCURRENT DEAL SNAPSHOT\n${initialSnapshot}` },
      ...history,
    ];

    let reply = "";
    let steps = 0;
    for (; steps < MAX_STEPS; steps++) {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: provider.headers,
        body: JSON.stringify({ model: provider.model, messages, tools: AGENT_TOOLS, tool_choice: "auto", ...maxTokensParam(provider, 4096) }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("deal-agent LLM error:", provider.id, res.status, errText.slice(0, 500));
        throw new Error(`The model request failed (${provider.id} ${res.status})`);
      }
      const data = await res.json();
      for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) usage[k] += Number(data.usage?.[k] ?? 0);
      const msg = data.choices?.[0]?.message ?? {};
      const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length === 0) {
        reply = typeof msg.content === "string" ? msg.content.trim() : "";
        break;
      }

      messages.push({ role: "assistant", content: typeof msg.content === "string" ? msg.content : "", tool_calls: calls });
      for (const call of calls) {
        const name = String(call.function?.name ?? "");
        let args: Record<string, any> = {};
        try { args = JSON.parse(call.function?.arguments || "{}") ?? {}; } catch { /* treated as empty arguments */ }
        let result: ToolResult;
        try {
          result = (AGENT_TOOL_NAMES as readonly string[]).includes(name) ? await runTool(name, args) : { ok: false, summary: `Unknown tool: ${name}` };
        } catch (e) {
          result = { ok: false, summary: e instanceof Error ? e.message : "The change failed" };
        }
        actions.push({ tool: name, ok: result.ok, summary: result.summary, revisionId: result.revisionId ?? null });
        toolLog.push({ name, arguments: boundedJson(args, 4000), ok: result.ok, summary: result.summary, revision_id: result.revisionId ?? null });
        // Same audit trail as external agents (Settings → AI Agents → Recent agent writes).
        admin.from("mcp_tool_calls").insert({
          user_id: user.id, tool_name: `agent:${name}`, deal_id: dealId, arguments: args,
          success: result.ok, error_message: result.ok ? null : result.summary,
        }).then(() => {});
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, summary: result.summary }) });
      }
      // Let the model see the deal as it now is before it continues or confirms.
      messages.push({ role: "system", content: `UPDATED DEAL SNAPSHOT\n${snapshot()}` });
    }

    if (!reply) {
      const done = actions.filter((a) => a.ok).map((a) => a.summary);
      const failed = actions.filter((a) => !a.ok).map((a) => a.summary);
      reply = [done.length ? `Done: ${done.join("; ")}.` : "", failed.length ? `Not done: ${failed.join("; ")}.` : ""].filter(Boolean).join(" ")
        || "I couldn't work out a change to make. Could you rephrase?";
    }

    const changed = actions.some((a) => a.ok && a.revisionId);
    if (turnId) {
      await admin.from("agent_turns").update({
        tool_calls: toolLog, reply, changed, steps: steps + 1, latency_ms: Date.now() - startedAt, usage,
      }).eq("id", turnId);
    }
    if (background.length) (globalThis as any).EdgeRuntime?.waitUntil?.(Promise.allSettled(background));
    return json({ turnId, reply, actions, changed: actions.some((a) => a.ok) });
  } catch (error) {
    console.error("deal-agent error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    // A failed turn is data too: record what went wrong against it.
    if (admin && turnId) {
      await admin.from("agent_turns").update({ error: message.slice(0, 1000), latency_ms: Date.now() - startedAt }).eq("id", turnId).then(() => {}, () => {});
    }
    return json({ error: message, turnId }, 500);
  }
});
