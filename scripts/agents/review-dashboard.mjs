// Starts one dashboard simplicity review: a Claude Managed Agents session with
// this repository mounted. The agent screenshots the app in demo mode
// (scripts/ui-review/), judges it against the rubric below, and opens a pull
// request with its fixes. The session runs on Anthropic's side; this script
// only starts it and prints where to watch.
//
//   node scripts/agents/review-dashboard.mjs
//
// Env: ANTHROPIC_API_KEY (or an `ant auth login` profile), UI_REVIEW_GITHUB_TOKEN
// (fine-grained PAT for this repo: contents read/write - used for the clone and
// the push). Agent, environment and vault IDs are read from
// managed-agents/claude-lock.json unless MA_DASHBOARD_REVIEWER_AGENT_ID,
// MA_DASHBOARD_ENV_ID and MA_DASHBOARD_VAULT_ID are set.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_URL = "https://github.com/internetoftim/agentic-dealflow-os";
const BUDGET_CENTS = "1000"; // $10 hard cap per review

// Starter rubric - tune it with the eval.
const RUBRIC = `# Dashboard simplicity review rubric (starter)
- Screenshots of /, /pipeline, /data-room and /settings at 1440x900 and 375x812 were taken with scripts/ui-review/capture.mjs, before and after the changes, and none shows the login page, an error or an endless spinner.
- Every finding names the screen, the viewport, what was wrong and which simplicity criterion it breaks.
- Each change is focused (layout, spacing, hierarchy, duplicate status, responsive behaviour, labels) and changes no behaviour, data flow, dependency, supabase/ file or generated file.
- At 375px no screen scrolls horizontally after the changes.
- npm test passes and npx tsc --noEmit -p tsconfig.app.json reports no new errors.
- A branch named ui-review/<date> was pushed (never main) and a pull request against main exists, with the findings, before/after screenshots under docs/ui-review/<date>/, and a list of what was found but not changed and why.
- /mnt/session/outputs/review.md contains the findings and the pull request URL.
`;

function lockId(key) {
  const lockFile = path.resolve(here, "../../managed-agents/claude-lock.json");
  if (!existsSync(lockFile)) return undefined;
  return JSON.parse(readFileSync(lockFile, "utf8")).resources?.[key]?.id;
}

function required(name, value) {
  if (!value) {
    console.error(`${name} is not set (see managed-agents/README.md)`);
    process.exit(1);
  }
  return value;
}

const agentId = required("MA_DASHBOARD_REVIEWER_AGENT_ID", process.env.MA_DASHBOARD_REVIEWER_AGENT_ID ?? lockId("./agents/dashboard-reviewer.md"));
const environmentId = required("MA_DASHBOARD_ENV_ID", process.env.MA_DASHBOARD_ENV_ID ?? lockId("./environments/easyvc-dashboard-review.yaml"));
const vaultId = required("MA_DASHBOARD_VAULT_ID", process.env.MA_DASHBOARD_VAULT_ID ?? lockId("./vaults/easyvc-dashboard-review.yaml"));
const githubToken = required("UI_REVIEW_GITHUB_TOKEN", process.env.UI_REVIEW_GITHUB_TOKEN);

const client = new Anthropic();
const today = new Date().toISOString().slice(0, 10);
const session = await client.beta.sessions.create({
  agent: agentId,
  environment_id: environmentId,
  title: `Dashboard review ${today}`,
  metadata: { app: "easyvc", kind: "dashboard-review" },
  vault_ids: [vaultId],
  resources: [{
    type: "github_repository",
    url: REPO_URL,
    authorization_token: githubToken,
    mount_path: "/workspace/easyvc",
    checkout: { type: "branch", name: "main" },
  }],
  budget: { type: "limit", max_list_cost: { amount: BUDGET_CENTS, currency: "USD" } },
  initial_events: [{
    type: "user.define_outcome",
    description: `Review the EasyVC dashboard for visual simplicity on ${today}, fix what you find, and open a pull request from ui-review/${today}.`,
    rubric: { type: "text", content: RUBRIC },
    max_iterations: 3,
  }],
});

const workspace = process.env.ANTHROPIC_WORKSPACE_ID ?? "default";
console.log(`Started ${session.id}`);
console.log(`Watch: https://platform.claude.com/workspaces/${workspace}/sessions/${session.id}`);
