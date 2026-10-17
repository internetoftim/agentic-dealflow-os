# UI review harness (demo mode)

Screenshots of the EasyVC dashboard without a login and without real data. Used by the
dashboard reviewer agent (`managed-agents/agents/dashboard-reviewer.md`) and handy for humans.

```bash
npm run dev
node scripts/ui-review/capture.mjs
```

Screenshots of `/`, `/pipeline`, `/data-room` and `/settings` at 1440x900 and 375x812 land in
`ui-review-output/` (git-ignored).

How it works:

- A fake session for a demo user is written to localStorage before the app loads, so the
  `ProtectedRoute` lets it in.
- Every request to the Supabase project is answered locally. `GET /rest/v1/<table>` returns
  `fixtures/<table>.json`, with simple `col=eq.value` and `in.(...)` filters applied; writes are
  accepted and dropped; edge functions return `{}`; realtime sockets stay silent.
- Any other non-local request is blocked, except Google Fonts.

When a screen is empty or broken, the console prints `no fixture for "<table>"`. Add a JSON file
for that table with realistic rows. Use fictional companies and people only, and `.example`
domains.
