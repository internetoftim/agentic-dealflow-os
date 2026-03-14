import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Navigate } from "react-router-dom";

export default function LoginPage() {
  const { user, loading, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState("");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin-slow h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">AgenticVC</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Sign in to access your deal pipeline
        </p>
        <button
          onClick={() => signInWithGoogle()}
          className="flex items-center justify-center gap-3 w-full rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent transition-colors"
        >
          <img
            src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            alt="Google"
            className="h-5 w-5"
          />
          Sign in with Google
        </button>
        <button
          onClick={() => signInWithGoogle(email || undefined)}
          className="flex items-center justify-center gap-3 w-full rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent transition-colors"
        >
          <img
            src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            alt="Google"
            className="h-5 w-5"
          />
          Sign in with Google
        </button>
        <p className="text-xs text-muted-foreground mt-4">
          Grants access to Google Drive for deck sync
        </p>
      </div>
    </div>
  );
}
