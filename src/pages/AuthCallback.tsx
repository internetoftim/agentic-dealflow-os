import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Lands here from the siwc-auth edge function after a successful
 * Sign in with ChatGPT. The function verified the OpenAI identity and minted a
 * one-time Supabase magic-link token, passed in the URL fragment so it never
 * reaches server logs. Redeem it for a session, then continue to `next`.
 */
export default function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const tokenHash = params.get("token_hash");
    const type = params.get("type") ?? "magiclink";
    const rawNext = params.get("next") ?? "/";
    const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
    if (!tokenHash) {
      setError("Missing sign-in token.");
      return;
    }
    // Clear the fragment so a refresh does not retry a consumed token.
    window.history.replaceState(null, "", window.location.pathname);
    supabase.auth
      .verifyOtp({ token_hash: tokenHash, type: type as "magiclink" })
      .then(({ error }) => {
        if (error) setError(error.message);
        else window.location.replace(next);
      });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      {error ? (
        <div className="max-w-sm text-center">
          <p className="text-[15px] font-semibold text-foreground">Sign-in didn't complete</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">{error}</p>
          <Link to="/login" className="mt-4 inline-block text-[12.5px] underline underline-offset-2 text-muted-foreground hover:text-foreground">
            Back to sign in
          </Link>
        </div>
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
