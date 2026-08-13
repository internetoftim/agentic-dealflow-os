/**
 * Drift guard: the Supabase edge functions can only bundle code that lives
 * under supabase/functions/, so the attachment-pipeline engine is deployed
 * from verbatim copies in supabase/functions/_shared/. The canonical,
 * tested source lives in src/lib/. This test fails the suite the moment a
 * copy diverges from its original, so the two can never drift silently.
 *
 * The only permitted difference is Deno-style explicit ".ts" extensions on
 * relative imports in the _shared copies.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** Normalize Deno-style relative imports back to extensionless form. */
const stripTsExtensions = (source: string) =>
  source.replace(/(from\s+"\.[^"]*)\.ts(")/g, "$1$2");

describe("supabase/functions/_shared engine copies", () => {
  it("attachmentPipeline.ts matches src/lib exactly", () => {
    expect(read("supabase/functions/_shared/attachmentPipeline.ts")).toBe(
      read("src/lib/attachmentPipeline.ts")
    );
  });

  it("googlePorts.ts matches src/lib (modulo .ts import extensions)", () => {
    expect(stripTsExtensions(read("supabase/functions/_shared/googlePorts.ts"))).toBe(
      read("src/lib/googlePorts.ts")
    );
  });
});
