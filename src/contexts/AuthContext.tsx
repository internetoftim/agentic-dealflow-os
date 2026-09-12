import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User, Session } from "@supabase/supabase-js";

/** How long a fresh tab waits for the auth lock before offering a retry. */
export const AUTH_BOOT_TIMEOUT_MS = 8_000;

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** True when the initial session lookup timed out (usually a lock held by another tab). */
  bootTimedOut: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootTimedOut, setBootTimedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // getSession() takes supabase-js's cross-tab auth lock. If another tab is
    // holding it (busy backend, slow token refresh) this can stall; bound it so
    // the app renders a recoverable state instead of an endless spinner.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("auth-timeout")), AUTH_BOOT_TIMEOUT_MS),
    );
    Promise.race([supabase.auth.getSession(), timeout])
      .then(({ data: { session } }) => {
        if (cancelled) return;
        setSession(session);
        setUser(session?.user ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e?.message === "auth-timeout") setBootTimedOut(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      setBootTimedOut(false);

      // Persist Google tokens only when they actually arrive (sign-in), and
      // never from inside this callback: awaiting a Supabase call here holds
      // the auth lock and deadlocks other tabs' getSession().
      if (event === "SIGNED_IN" && session?.provider_token) {
        const payload = {
          user_id: session.user.id,
          google_provider_token: session.provider_token,
          google_provider_refresh_token: session.provider_refresh_token ?? null,
        };
        setTimeout(() => {
          supabase.from("user_settings").upsert(payload, { onConflict: "user_id" })
            .then(({ error }) => { if (error) console.warn("Token persist failed:", error.message); });
        }, 0);
      }
    });

    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const signInWithGoogle = async () => {
    if (isInIframe()) {
      // In iframe (preview): use skipBrowserRedirect + popup to avoid cookie issues
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          scopes: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly",
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      if (data?.url) {
        const popup = window.open(data.url, "oauth", "width=500,height=600");

        if (!popup) {
          // Popup blocked — fall back to opening in new tab
          window.open(data.url, "_blank");
          return;
        }

        // Poll for popup close and refresh session
        const timer = setInterval(async () => {
          if (popup.closed) {
            clearInterval(timer);
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              setSession(session);
              setUser(session.user);
            }
          }
        }, 500);
      }
    } else {
      // Normal flow for published app
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          scopes: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly",
          redirectTo: window.location.origin,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, bootTimedOut, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
