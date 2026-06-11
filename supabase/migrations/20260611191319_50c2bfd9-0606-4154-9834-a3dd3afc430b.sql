-- Personal access tokens for MCP / programmatic access
CREATE TABLE public.mcp_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_access_tokens TO authenticated;
GRANT ALL ON public.mcp_access_tokens TO service_role;

ALTER TABLE public.mcp_access_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own MCP tokens"
  ON public.mcp_access_tokens FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users create own MCP tokens"
  ON public.mcp_access_tokens FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users revoke own MCP tokens"
  ON public.mcp_access_tokens FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own MCP tokens"
  ON public.mcp_access_tokens FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_mcp_tokens_user ON public.mcp_access_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_mcp_tokens_hash ON public.mcp_access_tokens(token_hash) WHERE revoked_at IS NULL;

-- OAuth 2.1 dynamic client registration (for Claude/ChatGPT one-click connect)
CREATE TABLE public.mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris JSONB NOT NULL,
  grant_types JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mcp_oauth_clients TO service_role;
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
-- No user policies: only service role accesses this table.

-- OAuth authorization codes + refresh tokens
CREATE TABLE public.mcp_oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mcp_oauth_codes TO service_role;
ALTER TABLE public.mcp_oauth_codes ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.mcp_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  client_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mcp_oauth_tokens TO service_role;
ALTER TABLE public.mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_mcp_oauth_tokens_access ON public.mcp_oauth_tokens(access_token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_mcp_oauth_tokens_refresh ON public.mcp_oauth_tokens(refresh_token_hash) WHERE revoked_at IS NULL;