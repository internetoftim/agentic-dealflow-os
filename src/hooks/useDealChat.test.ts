import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock the supabase client so the hook doesn't touch the real network/env.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
    },
  },
}));

import { useDealChat } from "./useDealChat";

/** Build a web ReadableStream that emits the given string chunks then closes. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function mockFetchStreaming(...contentTokens: string[]) {
  const frames = contentTokens
    .map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`)
    .concat("data: [DONE]\n");
  return vi.fn(async () => ({
    ok: true,
    body: sseStream(frames),
    text: async () => "",
  }));
}

describe("useDealChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("streams assistant tokens and appends them after the user message", async () => {
    vi.stubGlobal("fetch", mockFetchStreaming("Hello", " world"));

    const { result } = renderHook(() => useDealChat("deal-a"));

    await act(async () => {
      await result.current.send("What is the traction?");
    });

    const msgs = result.current.messages;
    expect(msgs[0].role).toBe("assistant"); // intro
    expect(msgs[1]).toEqual({ role: "user", content: "What is the traction?" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "Hello world" });
    expect(result.current.isStreaming).toBe(false);
  });

  // Regression: the hook previously seeded messages once and never reset them,
  // so selecting a different deal in the sidebar sent Deal A's whole
  // conversation as context to Deal B's chat request.
  it("resets the conversation when the deal id changes (regression)", async () => {
    vi.stubGlobal("fetch", mockFetchStreaming("Answer for A"));

    const { result, rerender } = renderHook(({ id }) => useDealChat(id), {
      initialProps: { id: "deal-a" },
    });

    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.messages.length).toBeGreaterThan(1);

    // Switch deals — history must be cleared back to just the intro message.
    rerender({ id: "deal-b" });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe("assistant");
  });

  it("ignores empty input and does not start a stream", async () => {
    const fetchMock = mockFetchStreaming("x");
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDealChat("deal-a"));

    await act(async () => {
      await result.current.send("   ");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1); // only the intro
  });
});
