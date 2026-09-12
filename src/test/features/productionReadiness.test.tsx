import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

import { PrivacyPolicy, TermsOfService, GOOGLE_LIMITED_USE_DISCLOSURE } from "@/pages/LegalPage";

describe("Google verification artifacts", () => {
  it("privacy policy names every Google scope, the Limited Use disclosure, retention, and deletion", () => {
    render(<HelmetProvider><MemoryRouter><PrivacyPolicy /></MemoryRouter></HelmetProvider>);
    expect(screen.getByText(/drive\.file/)).toBeInTheDocument();
    expect(screen.getByText(/gmail\.modify/)).toBeInTheDocument();
    expect(screen.getByText(GOOGLE_LIMITED_USE_DISCLOSURE)).toBeInTheDocument();
    expect(screen.getByText(/encrypted at rest/)).toBeInTheDocument();
    expect(screen.getByText(/delete your account/)).toBeInTheDocument();
  });

  it("terms page renders and links the privacy policy", () => {
    render(<HelmetProvider><MemoryRouter><TermsOfService /></MemoryRouter></HelmetProvider>);
    expect(screen.getByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Privacy Policy" }).length).toBeGreaterThan(0);
  });

  it("the disclosure uses Google's required wording", () => {
    expect(GOOGLE_LIMITED_USE_DISCLOSURE).toMatch(/Google API Services User Data Policy, including the Limited Use requirements/);
  });

  it("the homepage links privacy + terms and carries the disclosure; routes exist", () => {
    const login = read("src/pages/LoginPage.tsx");
    expect(login).toMatch(/to="\/privacy"/);
    expect(login).toMatch(/to="\/terms"/);
    expect(login).toMatch(/GOOGLE_LIMITED_USE_DISCLOSURE/);
    const app = read("src/App.tsx");
    expect(app).toMatch(/path="\/privacy"/);
    expect(app).toMatch(/path="\/terms"/);
  });
});

describe("scope minimization", () => {
  const auth = read("src/contexts/AuthContext.tsx");
  it("sign-in requests only drive.file; Gmail is incremental and never gmail.readonly", () => {
    expect(auth).toMatch(/BASE_SCOPES = "https:\/\/www\.googleapis\.com\/auth\/drive\.file"/);
    expect(auth).toMatch(/GMAIL_SCOPE = "https:\/\/www\.googleapis\.com\/auth\/gmail\.modify"/);
    expect(auth).not.toMatch(/gmail\.readonly/);
    expect(auth).toMatch(/include_granted_scopes: "true"/);
  });
  it("no function requests gmail.readonly either", () => {
    expect(read("supabase/functions/receiver-oauth/index.ts")).not.toMatch(/gmail\.readonly/);
  });
});

describe("token handling", () => {
  it("the browser never writes Google tokens to the database directly", () => {
    const auth = read("src/contexts/AuthContext.tsx");
    expect(auth).not.toMatch(/google_provider_token/);
    expect(auth).toMatch(/functions\/v1\/store-google-tokens/);
  });
  it("clients are column-revoked from token columns; anon has nothing", () => {
    const sql = read("supabase/migrations/20260912190000_production_hardening.sql");
    expect(sql).toMatch(/REVOKE ALL ON public\.user_settings FROM authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.user_settings FROM anon/);
    const grants = sql.match(/GRANT (SELECT|INSERT|UPDATE) \(([^)]+)\)\s+ON public\.user_settings/g) ?? [];
    expect(grants.length).toBe(3);
    for (const g of grants) expect(g).not.toMatch(/google_provider/);
  });
  it("every Google-calling function goes through the encrypted accessor, none read raw columns", () => {
    for (const fn of ["gmail-listener", "gmail-watch", "gmail-webhook", "process-deck", "generate-memo", "sync-to-drive"]) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/getUserGoogleAccessToken/);
      expect(src, fn).not.toMatch(/settings\??\.google_provider_token/);
      expect(src, fn).not.toMatch(/async function getValidToken/);
    }
  });
  it("token module encrypts with AES-GCM and still accepts legacy plaintext", () => {
    const src = read("supabase/functions/_shared/google-tokens.ts");
    expect(src).toMatch(/AES-GCM/);
    expect(src).toMatch(/enc:v1:/);
    expect(src).toMatch(/if \(!isEncrypted\(v\)\) return v;/);
  });
});

describe("user controls and access gate", () => {
  it("account function supports disconnect and confirmed deletion, and deletes the auth user last", () => {
    const src = read("supabase/functions/account/index.ts");
    expect(src).toMatch(/action === "disconnect_google"/);
    expect(src).toMatch(/confirm !== "DELETE"/);
    expect(src.indexOf("auth.admin.deleteUser")).toBeGreaterThan(src.indexOf('count("profiles")'));
  });
  it("internal SECURITY DEFINER helpers are no longer callable by anon", () => {
    const sql = read("supabase/migrations/20260912190000_production_hardening.sql");
    for (const fn of ["can_access_deal", "is_team_member", "has_role", "is_user_approved", "get_team_roster", "create_team", "join_team"]) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon`));
    }
  });
  it("approval gate is enforced in ProtectedRoute and profiles are created by trigger", () => {
    expect(read("src/components/ProtectedRoute.tsx")).toMatch(/approval_status/);
    const sql = read("supabase/migrations/20260912190000_production_hardening.sql");
    expect(sql).toMatch(/AFTER INSERT ON auth\.users/);
    expect(sql).toMatch(/approval_status = 'approved'/); // backfill
  });
  it("no Lovable staging hostnames leak into user-facing URLs", () => {
    for (const f of ["src/pages/IntakePage.tsx", "src/pages/SettingsPage.tsx"]) {
      expect(read(f), f).not.toMatch(/lovable\.app/);
    }
  });
});
