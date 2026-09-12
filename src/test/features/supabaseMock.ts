import { vi } from "vitest";

/**
 * Minimal chainable stand-in for the Supabase query builder. Any chain method
 * returns the builder; terminal awaits resolve with the configured result for
 * that table. `rpc(name)` resolves from the rpc map.
 */
export function makeSupabaseMock(opts: {
  tables?: Record<string, { data: unknown; error?: unknown }>;
  rpc?: Record<string, { data: unknown; error?: unknown }>;
}) {
  const inserts: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const removedChannels: unknown[] = [];
  const subscribe = vi.fn();

  const builder = (table: string) => {
    const result = opts.tables?.[table] ?? { data: null, error: null };
    const b: any = {};
    const chain = () => b;
    for (const m of ["select", "eq", "is", "order", "limit", "in", "not", "ilike", "or"]) b[m] = vi.fn(chain);
    b.insert = vi.fn((row: unknown) => { (inserts[table] ??= []).push(row); return b; });
    b.update = vi.fn((row: unknown) => { (updates[table] ??= []).push(row); return b; });
    b.delete = vi.fn(chain);
    b.maybeSingle = vi.fn(async () => result);
    b.single = vi.fn(async () => result);
    b.then = (res: (v: unknown) => void) => Promise.resolve(result).then(res);
    return b;
  };

  const channelObj: any = { on: vi.fn(() => channelObj), subscribe: vi.fn(() => { subscribe(); return channelObj; }) };

  const supabase = {
    from: vi.fn(builder),
    rpc: vi.fn(async (name: string) => opts.rpc?.[name] ?? { data: null, error: null }),
    channel: vi.fn(() => channelObj),
    removeChannel: vi.fn((c: unknown) => { removedChannels.push(c); }),
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "jwt-123" } } })) },
  };
  return { supabase, inserts, updates, subscribe, removedChannels };
}
