# Extraction + Deep Research Agent Review and Agents SDK Migration Plan

## Scope reviewed
- `supabase/functions/process-deck/index.ts` (deck ingestion + extraction + metadata extraction)
- `supabase/functions/deep-research/index.ts` (web research + enrichment + people extraction)

## Current implementation strengths
1. **Solid operational workflow in `process-deck`**
   - Good end-to-end step orchestration (`extracting`, `compressing`, `searching-website`) and queue handoff logic.
   - Handles multiple document formats and fallback paths (Slides API → PDF text → PPTX XML).
2. **Pragmatic production fallbacks in `deep-research`**
   - Firecrawl search/scrape fallback paths are resilient.
   - Uses function calling for structured outputs and stores verification artifacts (`research_verification`, `deck_preview`, people rows).
3. **Reasonable data persistence boundaries**
   - Writes source extraction output to `sources` and normalized derived fields to `deals` and `deal_people`.

## Key review findings (high impact)

### 1) Agent logic is duplicated and tightly coupled to HTTP handlers
Both functions embed long, imperative LLM/tool logic inline. This causes:
- Harder testing (logic not unit-testable without full request context)
- Drifting prompts/schemas across stages
- Increased regression risk when changing one step

**Recommendation:** extract orchestration and tool contracts into shared modules (`_shared/agents/*`) and keep edge handlers thin.

### 2) Mixed model APIs and schemas increase fragility
The code mixes `/v1/chat/completions` and `/v1/responses` payload styles in multiple branches and custom parsing paths.

**Recommendation:** standardize on an Agent SDK runner with typed `outputType` schemas to remove ad hoc `JSON.parse` + manual tool-call extraction.

### 3) Determinism + observability gaps
- No run-level trace IDs for each agent stage.
- Sparse metrics around which fallback path produced final values.
- Limited confidence/grounding model for enriched fields.

**Recommendation:** use Agents SDK run events + explicit provenance in output structure (`sources`, `confidence`, `method`).

### 4) Extraction quality bottlenecks
`extractPdfText` is a low-level regex approach and can miss layout/context in modern PDFs.

**Recommendation:** shift extraction to a dedicated extractor agent/tool contract that can combine OCR text, slide text, and page image hints with typed output + confidence.

## Better implementation with OpenAI Agents SDK (recommended architecture)

### Agent topology
1. **Deck Extraction Agent**
   - Input: extracted text + slide previews
   - Output: typed `DeckMetadata`
2. **Company Research Agent**
   - Tools: `web_search`, optional Firecrawl function tool
   - Output: typed `CompanyResearch`
3. **People Agent**
   - Tools: `web_search`
   - Output: typed `KeyPeople`
4. **Coordinator Agent** (optional)
   - Uses sub-agents as tools and merges outputs with provenance.

### Why this is better
- Strong typed outputs (fewer brittle parsers)
- Reusable agents across ingestion and re-research jobs
- Cleaner separation of concerns and easier testability
- Native support for hosted tools (`web_search`) and structured orchestration

## Migration plan (incremental)
1. **Phase 1 (safe):** Add shared Agents SDK module and feature flag without changing existing endpoints.
2. **Phase 2:** Route deep-research company URL + people steps through SDK pipeline.
3. **Phase 3:** Route metadata extraction in `process-deck` through SDK extractor agent.
4. **Phase 4:** Delete legacy prompt/tool-call branches once parity is validated.

## Success criteria
- >= 95% schema-valid outputs (no parser fallback)
- Reduced median deep research runtime variance
- Fewer null critical fields (website/linkedin/stage/sector)
- Improved traceability (per-field provenance + confidence)

## Reference implementation in this repo
A previous reference module (`supabase/functions/_shared/agents_sdk_pipeline.ts`) was removed because the `npm:@openai/agents` import broke edge-function deploys.

### Current fix for edge deploy compatibility
- `supabase/functions/deep-research/deno.json` now isolates the SDK dependency per-function (recommended by Supabase docs).
- `deep-research` now uses an **opt-in** `ENABLE_AGENTS_SDK=true` path that attempts Agents SDK web research and falls back to the legacy implementation on any SDK/runtime failure.
- The SDK import is loaded dynamically so non-SDK environments can still deploy and run the legacy path.
