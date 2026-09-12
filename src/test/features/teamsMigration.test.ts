import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression guard on the schema contract the frontend and MCP server rely on.
const sql = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20260908090000_teams_and_deal_notes.sql"),
  "utf8",
);

describe("teams migration contract", () => {
  it("creates the three tables with RLS enabled", () => {
    for (const t of ["teams", "team_members", "deal_notes"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${t}`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    }
    expect(sql).toMatch(/ALTER TABLE public\.deals\s+ADD COLUMN IF NOT EXISTS team_id/);
  });

  it("makes new deals inherit the creator's team via trigger", () => {
    expect(sql).toMatch(/CREATE TRIGGER deals_set_team\s+BEFORE INSERT ON public\.deals/);
    expect(sql).toMatch(/IF NEW\.team_id IS NULL THEN/);
  });

  it("extends can_access_deal to teams so existing share policies cover teammates", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.can_access_deal"));
    expect(fn).toMatch(/JOIN public\.team_members tm ON tm\.team_id = d\.team_id/);
    expect(fn).toMatch(/deal_share_access/); // still honours explicit shares
  });

  it("exposes every RPC the frontend calls, and only to authenticated users", () => {
    for (const fn of ["create_team(text)", "join_team(text)", "leave_team()", "remove_team_member(uuid)", "get_team_roster()"]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`);
    }
    for (const fn of ["create_team", "join_team", "leave_team", "remove_team_member"]) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      expect(body).toMatch(/SECURITY DEFINER/);
      expect(body).toMatch(/IF auth\.uid\(\) IS NULL THEN RAISE EXCEPTION/);
    }
  });

  it("enforces one team per user and moves deals on join/leave", () => {
    expect((sql.match(/You are already in a team/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/UPDATE public\.deals SET team_id = t\.id WHERE user_id = auth\.uid\(\) AND team_id IS NULL/);
    expect(sql).toMatch(/UPDATE public\.deals SET team_id = NULL WHERE user_id = auth\.uid\(\) AND team_id = _tid/);
  });

  it("lets note authors edit only their own notes while all deal viewers can read", () => {
    expect(sql).toMatch(/"Deal viewers can read notes"[\s\S]*?USING \(public\.can_access_deal\(deal_id, auth\.uid\(\)\)\)/);
    expect(sql).toMatch(/"Authors can update their notes"[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
    expect(sql).toMatch(/"Authors can delete their notes"[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
  });
});
