// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * A backend endpoint can answer 404 ("Requested function was not found") while
 * it is mid-deploy. That must never leave the user staring at a blank page.
 */
function Boom({ message }: { message: string }) {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  it("keeps the page usable when a service call fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom message={'Edge function returned 404: Error, {"code":"NOT_FOUND"}'} />
      </ErrorBoundary>,
    );

    expect(await screen.findByText("A service didn't respond")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument();
    spy.mockRestore();
  });

  it("offers a retry that clears the failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("process-deck unavailable");
      return <p>Deal pipeline</p>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    const retry = await screen.findByRole("button", { name: /try again/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText("Deal pipeline")).toBeInTheDocument();
    spy.mockRestore();
  });
});
