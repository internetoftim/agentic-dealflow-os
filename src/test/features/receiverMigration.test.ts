import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260912100000_receiver_accounts.sql"), "utf8");

describe("receiver_accounts migration contract", () => {
  it("creates the table with RLS and a unique mailbox", () => {
    expect(sql).toMatch(/CREATE TABLE public\.receiver_accounts/);
    expect(sql).toMatch(/email text NOT NULL UNIQUE/);
    expect(sql).toMatch(/ALTER TABLE public\.receiver_accounts ENABLE ROW LEVEL SECURITY/);
  });

  it("never exposes Google credentials to clients", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.receiver_accounts FROM authenticated/);
    const grant = sql.match(/GRANT SELECT \(([^)]+)\)\s+ON public\.receiver_accounts TO authenticated/);
    expect(grant).not.toBeNull();
    expect(grant![1]).not.toMatch(/token/);
    expect(sql).toMatch(/GRANT UPDATE \(enabled\) ON public\.receiver_accounts TO authenticated/);
  });

  it("scopes every client policy to the owner", () => {
    for (const p of ["Owners can view their receivers", "Owners can toggle their receivers", "Owners can disconnect their receivers"]) {
      expect(sql).toMatch(new RegExp(`"${p}"[\\s\\S]*?USING \\(user_id = auth\\.uid\\(\\)\\)`));
    }
  });
});

const invitesSql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260912120000_receiver_invites.sql"), "utf8");

describe("receiver_invites migration contract", () => {
  it("stores only a token hash, owner-scoped, unreadable by anon", () => {
    expect(invitesSql).toMatch(/token_hash text NOT NULL UNIQUE/);
    expect(invitesSql).not.toMatch(/\btoken text\b/);
    expect(invitesSql).toMatch(/REVOKE ALL ON public\.receiver_invites FROM anon/);
    const grant = invitesSql.match(/GRANT SELECT \(([^)]+)\)\s+ON public\.receiver_invites TO authenticated/);
    expect(grant![1]).not.toMatch(/token_hash/);
    expect(invitesSql).toMatch(/"Owners can revoke their invites"[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
  });
});
