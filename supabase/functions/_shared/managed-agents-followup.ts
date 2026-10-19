// The one Managed Agents call the MCP server makes: a follow-up message to a
// finished diligence session. Kept apart from managed-agents.ts so mcp-server
// does not pull the whole session toolkit (and its pure helpers) into its bundle.

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";

/** A follow-up question from the investor, answered in the same session so the agents keep their findings. */
export async function sendFollowUp(sessionId: string, text: string): Promise<void> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see managed-agents/README.md)");
  const client = new Anthropic({ apiKey });
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}
