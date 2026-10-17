// Feature flags for the Managed Agents rollout. Kept apart from managed-agents.ts
// so callers like process-deck can check a flag without loading the SDK.

/**
 * Where decks are captured: "agent" runs a Managed Agents sandbox session,
 * "cloud-run" the old service until it is retired. CAPTURE_BACKEND overrides;
 * unset, the agent is used as soon as it is configured, so a deploy that lands
 * before the secrets never breaks capture.
 */
export function captureBackend(): "agent" | "cloud-run" {
  const chosen = Deno.env.get("CAPTURE_BACKEND");
  if (chosen === "agent" || chosen === "cloud-run") return chosen;
  return Deno.env.get("MA_DECK_CAPTURE_AGENT_ID") && Deno.env.get("ANTHROPIC_API_KEY") ? "agent" : "cloud-run";
}

/** Diligence replaces deep-research after process-deck when DILIGENCE_AGENT=on (optionally only for the listed user ids). */
export function diligenceEnabledFor(userId: string): boolean {
  if (Deno.env.get("DILIGENCE_AGENT") !== "on") return false;
  const allow = (Deno.env.get("DILIGENCE_AGENT_USER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allow.length === 0 || allow.includes(userId);
}
