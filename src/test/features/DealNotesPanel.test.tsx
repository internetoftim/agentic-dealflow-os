import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const addNote = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const togglePin = { mutate: vi.fn() };
const deleteNote = { mutate: vi.fn() };
let notesState: any[] = [];

vi.mock("@/hooks/useDealNotes", () => ({
  useDealNotes: () => ({ notes: notesState, isLoading: false, addNote, togglePin, deleteNote }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@fund.com" } }),
}));
vi.mock("sonner", () => ({
  toast: { promise: (p: Promise<unknown>) => p, error: vi.fn(), success: vi.fn() },
}));

import { DealNotesPanel } from "@/components/DealNotesPanel";

const memberLabel = (id: string) => (id === "ana" ? "Ana" : null);

beforeEach(() => {
  vi.clearAllMocks();
  notesState = [
    { id: "n1", deal_id: "d1", user_id: "ana", author_email: "ana@fund.com", content: "Pinned insight", pinned: true, created_at: new Date().toISOString(), updated_at: "" },
    { id: "n2", deal_id: "d1", user_id: "me", author_email: "me@fund.com", content: "My own note", pinned: false, created_at: new Date().toISOString(), updated_at: "" },
    { id: "n3", deal_id: "d1", user_id: "ghost", author_email: "ghost@else.com", content: "Left the team", pinned: false, created_at: new Date().toISOString(), updated_at: "" },
  ];
});

describe("DealNotesPanel", () => {
  it("attributes notes to You, a teammate label, or the email local-part", () => {
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} />);
    expect(screen.getByText("Notes · 3")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("ghost")).toBeInTheDocument();
  });

  it("only offers delete on the caller's own notes", () => {
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} />);
    expect(screen.getAllByTitle("Delete note")).toHaveLength(1);
    fireEvent.click(screen.getByTitle("Delete note"));
    expect(deleteNote.mutate).toHaveBeenCalledWith("n2");
  });

  it("pins and unpins", () => {
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} />);
    fireEvent.click(screen.getByTitle("Unpin"));
    expect(togglePin.mutate).toHaveBeenCalledWith({ id: "n1", pinned: false });
    fireEvent.click(screen.getAllByTitle("Pin")[0]);
    expect(togglePin.mutate).toHaveBeenCalledWith({ id: "n2", pinned: true });
  });

  it("saves a note from the composer and clears the draft", () => {
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} />);
    const box = screen.getByPlaceholderText(/Add a note/) as HTMLTextAreaElement;
    const save = screen.getByText("Save note");
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: "  Diligence call tomorrow  " } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(addNote.mutate).toHaveBeenCalledWith("Diligence call tomorrow", expect.anything());
    expect(box.value).toBe("");
  });

  it("saves with ⌘↵ from the textarea", () => {
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} />);
    const box = screen.getByPlaceholderText(/Add a note/);
    fireEvent.change(box, { target: { value: "quick" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(addNote.mutate).toHaveBeenCalledWith("quick", expect.anything());
  });

  it("pushes a note into the memo via the callback when provided", async () => {
    const onAppendToMemo = vi.fn().mockResolvedValue(undefined);
    render(<DealNotesPanel dealId="d1" memberLabel={memberLabel} onAppendToMemo={onAppendToMemo} />);
    fireEvent.click(screen.getAllByTitle("Append to memo")[0]);
    expect(onAppendToMemo).toHaveBeenCalledWith("Pinned insight");
  });

  it("disables the composer without a deal and shows the empty state", () => {
    notesState = [];
    render(<DealNotesPanel memberLabel={memberLabel} />);
    expect(screen.getByPlaceholderText(/Add a note/)).toBeDisabled();
    expect(screen.getByText(/shared with your whole team/)).toBeInTheDocument();
  });
});
