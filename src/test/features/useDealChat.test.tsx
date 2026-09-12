import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Async factory: builds the client stand-in without touching hoisted locals.
vi.mock("@/integrations/supabase/client", async () => {
  const { makeSupabaseMock } = await import("./supabaseMock");
  return { supabase: makeSupabaseMock({}).supabase };
});

import { useDealChat } from "@/hooks/useDealChat";

function sseResponse(text: string) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse("grounded answer")));
});

describe("useDealChat source scoping", () => {
  it("sends the selected source ids so the backend grounds on them", async () => {
    const { result } = renderHook(() => useDealChat("d1", ["s1", "s3"]));
    await act(() => result.current.send("What is NRR?"));
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.dealId).toBe("d1");
    expect(body.sourceIds).toEqual(["s1", "s3"]);
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("grounded answer"));
  });

  it("omits sourceIds when nothing is selected (= all sources)", async () => {
    const { result } = renderHook(() => useDealChat("d1", []));
    await act(() => result.current.send("hi"));
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).not.toHaveProperty("sourceIds");
  });

  it("authenticates with the user's session token", async () => {
    const { result } = renderHook(() => useDealChat("d1"));
    await act(() => result.current.send("hi"));
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe("Bearer jwt-123");
  });
});
