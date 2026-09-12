import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const createTeam = { mutateAsync: vi.fn(), isPending: false };
const joinTeam = { mutateAsync: vi.fn(), isPending: false };
const leaveTeam = { mutateAsync: vi.fn(), isPending: false };
const removeMember = { mutateAsync: vi.fn(), isPending: false };
let teamState: any = null;
let isOwnerState = false;
const members = [
  { user_id: "me", role: "owner", joined_at: "", email: "me@fund.com", display_name: "Tim" },
  { user_id: "ana", role: "member", joined_at: "", email: "ana@fund.com", display_name: null },
];

vi.mock("@/hooks/useTeam", () => ({
  useTeam: () => ({
    team: teamState, members: teamState ? members : [], isOwner: isOwnerState, isLoading: false,
    createTeam, joinTeam, leaveTeam, removeMember, memberLabel: () => null,
  }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", email: "me@fund.com" } }) }));
// mutateAsync is a bare vi.fn() here, so toast.promise must tolerate non-promises
vi.mock("sonner", () => ({ toast: { promise: (p: unknown) => Promise.resolve(p).catch(() => {}) } }));

import { TeamSection } from "@/components/TeamSection";

beforeEach(() => { vi.clearAllMocks(); teamState = null; isOwnerState = false; });

describe("TeamSection — no team", () => {
  it("offers create and join, gated on valid input", () => {
    render(<TeamSection />);
    const create = screen.getByText("Create team");
    const join = screen.getByText("Join team");
    expect(create).toBeDisabled();
    expect(join).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/OnePointSix/), { target: { value: "Fund" } });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);
    expect(createTeam.mutateAsync).toHaveBeenCalledWith("Fund");

    fireEvent.change(screen.getByPlaceholderText(/invite code/), { target: { value: "abc" } });
    expect(join).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/invite code/), { target: { value: "  a1b2c3d4e5  " } });
    fireEvent.click(join);
    expect(joinTeam.mutateAsync).toHaveBeenCalledWith("a1b2c3d4e5");
  });
});

describe("TeamSection — in a team", () => {
  beforeEach(() => { teamState = { id: "t1", name: "Fund I", owner_id: "me", invite_code: "code-xyz", created_at: "" }; });

  it("shows name, roster, invite code, and marks the caller and the owner", () => {
    render(<TeamSection />);
    expect(screen.getByText("Fund I")).toBeInTheDocument();
    expect(screen.getByText("code-xyz")).toBeInTheDocument();
    expect(screen.getByText(/2 members/)).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    // member without display_name falls back to email
    expect(screen.getByText("ana@fund.com")).toBeInTheDocument();
  });

  it("lets only the owner remove other members, never themselves", () => {
    const { unmount } = render(<TeamSection />);
    expect(screen.queryByTitle("Remove from team")).not.toBeInTheDocument();
    unmount();

    isOwnerState = true;
    render(<TeamSection />);
    const buttons = screen.getAllByTitle("Remove from team");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(removeMember.mutateAsync).toHaveBeenCalledWith("ana");
  });

  it("leaves the team", () => {
    render(<TeamSection />);
    fireEvent.click(screen.getByText("Leave"));
    expect(leaveTeam.mutateAsync).toHaveBeenCalled();
  });
});
