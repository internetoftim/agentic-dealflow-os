import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Control the gate flag per-test.
const useAgentMode = vi.fn();
vi.mock("@/hooks/useAgentMode", () => ({ useAgentMode: () => useAgentMode() }));

import { AgentRoute } from "./AgentRoute";

function renderGate() {
  return render(
    <MemoryRouter initialEntries={["/agent/deal/abc"]}>
      <AgentRoute>
        <div data-testid="agent-child">agent workspace</div>
      </AgentRoute>
    </MemoryRouter>
  );
}

describe("AgentRoute", () => {
  beforeEach(() => useAgentMode.mockReset());

  it("renders the child when Agent Mode is on", () => {
    useAgentMode.mockReturnValue({ agentMode: true, isLoading: false });
    renderGate();
    expect(screen.getByTestId("agent-child")).toBeInTheDocument();
    expect(screen.queryByText("404")).not.toBeInTheDocument();
  });

  it("renders 404 (NotFound) when Agent Mode is off", () => {
    useAgentMode.mockReturnValue({ agentMode: false, isLoading: false });
    renderGate();
    expect(screen.queryByTestId("agent-child")).not.toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
  });

  it("shows neither the child nor 404 while the flag is loading", () => {
    useAgentMode.mockReturnValue({ agentMode: false, isLoading: true });
    renderGate();
    expect(screen.queryByTestId("agent-child")).not.toBeInTheDocument();
    expect(screen.queryByText("404")).not.toBeInTheDocument();
  });
});
