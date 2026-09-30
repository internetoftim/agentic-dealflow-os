import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";

// Regression coverage for the agent-native sign-in changes: the MCP consent
// page signs users in inline, /login honours ?next= and explains ChatGPT
// errors, and /auth/callback redeems the fragment token safely.

const auth = vi.hoisted(() => ({
  user: null as null | { id: string },
  loading: false,
  bootTimedOut: false,
  chatgptSignInEnabled: false,
  signInWithGoogle: vi.fn(async () => {}),
  signInWithChatGPT: vi.fn(),
  requestGmailAccess: vi.fn(),
  signOut: vi.fn(),
  session: null,
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));

const verifyOtp = vi.hoisted(() => vi.fn(async () => ({ error: null as null | { message: string } })));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { verifyOtp, getSession: vi.fn(async () => ({ data: { session: { access_token: "jwt" } } })) } },
}));

import McpAuthorize from "@/pages/McpAuthorize";
import LoginPage from "@/pages/LoginPage";
import AuthCallback from "@/pages/AuthCallback";

const CONSENT = "/mcp/authorize?client_id=mcpc_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=abc&state=xyz";

function mount(path: string) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/mcp/authorize" element={<McpAuthorize />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="*" element={<div>APP HOME</div>} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
  auth.chatgptSignInEnabled = false;
  auth.signInWithGoogle.mockClear();
  auth.signInWithChatGPT.mockClear();
  verifyOtp.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("MCP consent page as the agent-native entry point", () => {
  it("signs a signed-out user in on the spot and returns them to the same consent URL", () => {
    window.history.replaceState(null, "", CONSENT);
    mount(CONSENT);
    expect(screen.getByText(/sign in to connect your agent/i)).toBeInTheDocument();
    expect(screen.queryByText(/continue with chatgpt/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/continue with google/i));
    expect(auth.signInWithGoogle).toHaveBeenCalledWith(CONSENT);
  });

  it("offers ChatGPT first when the server reports it configured", () => {
    auth.chatgptSignInEnabled = true;
    window.history.replaceState(null, "", CONSENT);
    mount(CONSENT);
    fireEvent.click(screen.getByText(/continue with chatgpt/i));
    expect(auth.signInWithChatGPT).toHaveBeenCalledWith(CONSENT);
  });

  it("shows the authorize/deny consent once signed in", () => {
    auth.user = { id: "u1" };
    mount(CONSENT);
    expect(screen.getByText(/authorize ai agent/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /authorize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });
});

describe("/login", () => {
  it("passes ?next= through to Google sign-in so the agent flow resumes", () => {
    mount("/login?next=%2Fmcp%2Fauthorize%3Fclient_id%3Dx");
    fireEvent.click(screen.getByText(/continue with google/i));
    expect(auth.signInWithGoogle).toHaveBeenCalledWith("/mcp/authorize?client_id=x");
  });

  it("ignores off-site next targets", () => {
    mount("/login?next=https%3A%2F%2Fevil.example");
    fireEvent.click(screen.getByText(/continue with google/i));
    expect(auth.signInWithGoogle).toHaveBeenCalledWith("/");
  });

  it("sends an already signed-in user on to next", () => {
    auth.user = { id: "u1" };
    mount("/login?next=%2Fpipeline");
    expect(screen.getByText("APP HOME")).toBeInTheDocument();
  });

  it("explains a ChatGPT sign-in failure and hides the ChatGPT button until configured", () => {
    mount("/login?siwc_error=email_required");
    expect(screen.getByText(/didn't share an email address/i)).toBeInTheDocument();
    expect(screen.queryByText(/continue with chatgpt/i)).not.toBeInTheDocument();
  });
});

describe("/auth/callback", () => {
  it("redeems the fragment token, clears it from the URL, and continues to a safe next", async () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "#token_hash=th_1&type=magiclink&next=%2Fsettings", pathname: "/auth/callback", replace },
    });
    mount("/auth/callback");
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "th_1", type: "magiclink" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings"));
  });

  it("never follows an off-site next", async () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "#token_hash=th_1&next=https%3A%2F%2Fevil.example", pathname: "/auth/callback", replace },
    });
    mount("/auth/callback");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("shows the error and a way back when the token is missing or rejected", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "", pathname: "/auth/callback", replace: vi.fn() },
    });
    mount("/auth/callback");
    expect(await screen.findByText(/missing sign-in token/i)).toBeInTheDocument();
    expect(screen.getByText(/back to sign in/i)).toBeInTheDocument();
  });
});
