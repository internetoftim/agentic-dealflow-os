import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const connect = { mutateAsync: vi.fn(), isPending: false };
const setEnabled = { mutateAsync: vi.fn().mockResolvedValue(undefined) };
const disconnect = { mutateAsync: vi.fn().mockResolvedValue(undefined) };
let accountsState: any[] = [];
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), promise: (p: unknown) => Promise.resolve(p).catch(() => {}) }));

vi.mock("@/hooks/useReceiverAccounts", () => ({
  useReceiverAccounts: () => ({ accounts: accountsState, isLoading: false, connect, setEnabled, disconnect }),
}));
vi.mock("sonner", () => ({ toast }));

import { ReceiverInboxSection } from "@/components/ReceiverInboxSection";

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><ReceiverInboxSection /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); accountsState = []; });

describe("ReceiverInboxSection", () => {
  it("shows the empty state and a connect button", () => {
    renderAt("/settings");
    expect(screen.getByText(/No deal inbox connected/)).toBeInTheDocument();
    expect(screen.getByText("Connect a receiver Gmail")).toBeInTheDocument();
  });

  it("lists connected inboxes with status, last-check time, and errors", () => {
    accountsState = [
      { id: "r1", email: "deals@fund.com", enabled: true, last_polled_at: new Date().toISOString(), last_error: null, created_at: "" },
      { id: "r2", email: "old@fund.com", enabled: false, last_polled_at: null, last_error: "Google token expired — reconnect this inbox", created_at: "" },
    ];
    renderAt("/settings");
    expect(screen.getByText("deals@fund.com")).toBeInTheDocument();
    expect(screen.getByText(/Listening · last checked just now/)).toBeInTheDocument();
    expect(screen.getByText(/Paused · last checked never/)).toBeInTheDocument();
    expect(screen.getByText(/Google token expired/)).toBeInTheDocument();
  });

  it("pauses and disconnects an inbox", () => {
    accountsState = [{ id: "r1", email: "deals@fund.com", enabled: true, last_polled_at: null, last_error: null, created_at: "" }];
    renderAt("/settings");
    fireEvent.click(screen.getByRole("switch"));
    expect(setEnabled.mutateAsync).toHaveBeenCalledWith({ id: "r1", enabled: false });
    fireEvent.click(screen.getByLabelText("Disconnect deals@fund.com"));
    expect(disconnect.mutateAsync).toHaveBeenCalledWith("r1");
  });

  it("starts the connect flow with the settings page as the return URL", () => {
    connect.mutateAsync.mockResolvedValue("https://accounts.google.com/x");
    renderAt("/settings");
    fireEvent.click(screen.getByText("Connect a receiver Gmail"));
    expect(connect.mutateAsync).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/));
  });

  it("toasts the OAuth result carried in the return URL and clears it", () => {
    renderAt("/settings?receiver=connected&email=deals%40fund.com");
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("deals@fund.com"));
  });

  it("toasts failures with the reason", () => {
    renderAt("/settings?receiver=error&reason=Google%20token%20exchange%20failed");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Google token exchange failed"));
  });
});
