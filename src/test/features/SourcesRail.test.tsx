import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SourcesRail } from "@/components/SourcesRail";

const sources = [
  { id: "s1", file_name: "deck.pdf" },
  { id: "s2", file_name: "model.xlsx" },
  { id: "s3", file_name: "market.pdf" },
];

describe("SourcesRail", () => {
  it("renders every source with a count and explains scoping", () => {
    render(<SourcesRail sources={sources} selected={new Set()} onToggle={() => {}} onToggleAll={() => {}} />);
    expect(screen.getByText("Sources · 3")).toBeInTheDocument();
    for (const s of sources) expect(screen.getByText(s.file_name)).toBeInTheDocument();
    expect(screen.getByText(/Nothing checked = all sources/)).toBeInTheDocument();
  });

  it("toggles a single source on click", () => {
    const onToggle = vi.fn();
    render(<SourcesRail sources={sources} selected={new Set()} onToggle={onToggle} onToggleAll={() => {}} />);
    fireEvent.click(screen.getByText("model.xlsx"));
    expect(onToggle).toHaveBeenCalledWith("s2");
  });

  it("offers All when not everything is selected and Clear when it is", () => {
    const onToggleAll = vi.fn();
    const { rerender } = render(
      <SourcesRail sources={sources} selected={new Set(["s1"])} onToggle={() => {}} onToggleAll={onToggleAll} />,
    );
    fireEvent.click(screen.getByText("All"));
    expect(onToggleAll).toHaveBeenCalledTimes(1);

    rerender(
      <SourcesRail sources={sources} selected={new Set(["s1", "s2", "s3"])} onToggle={() => {}} onToggleAll={onToggleAll} />,
    );
    expect(screen.getByText("Clear")).toBeInTheDocument();
  });

  it("hides the bulk toggle with a single source and shows the empty state with none", () => {
    const { rerender } = render(
      <SourcesRail sources={[sources[0]]} selected={new Set()} onToggle={() => {}} onToggleAll={() => {}} />,
    );
    expect(screen.queryByText("All")).not.toBeInTheDocument();

    rerender(<SourcesRail sources={[]} selected={new Set()} onToggle={() => {}} onToggleAll={() => {}} />);
    expect(screen.getByText(/No sources yet/)).toBeInTheDocument();
  });
});
