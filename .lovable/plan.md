

## Plan: Fix CI/CD and Backend Deployment

### Issues Found

**1. `deploy.sh` line 18 — Hardcoded macOS path**
```
export PATH="$PATH:/Users/tims/google-cloud-sdk/bin"
```
This breaks in GitHub Actions (Ubuntu). The `setup-gcloud` action already adds gcloud to PATH.

**2. `deploy.sh` lines 4-10 — Requires `.env` file that doesn't exist in CI**
The script reads from `backend/docsend_capture_service/.env` and exits if missing. In GitHub Actions, secrets come via environment variables (set on lines 28-29 of the workflow), but the script never sees them because it fails at the `.env` check first.

### Changes

#### File: `deploy.sh`

1. **Remove hardcoded path** (line 18) — delete entirely.

2. **Make `.env` file optional** (lines 4-10) — Change logic so it tries `.env` but falls back to environment variables if the file doesn't exist. Replace the `exit 1` with a warning:

```bash
ENV_FILE="backend/docsend_capture_service/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
else
  echo "WARN: $ENV_FILE not found, using environment variables"
fi

# Validate required vars
if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: OPENAI_API_KEY not set"; exit 1
fi
```

This way, local runs use `.env`, and CI uses the `env:` block from the workflow.

#### File: `.github/workflows/deploy.yml`

No changes needed — the current workflow correctly passes secrets as env vars and runs `deploy.sh`. Once `deploy.sh` is fixed, this will work.

### Summary

Two small edits to `deploy.sh`: remove the Mac-only PATH line and make the `.env` file optional with a fallback to environment variables.

