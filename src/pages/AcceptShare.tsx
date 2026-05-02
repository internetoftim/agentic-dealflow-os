import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, Share2, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { lookupShareToken, acceptShareToken } from "@/hooks/useDealShare";

export default function AcceptShare() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, loading, signInWithGoogle } = useAuth();
  const [info, setInfo] = useState<{ deal_name: string; owner_display_name: string; revoked: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!token) return;
    lookupShareToken(token)
      .then((row) => {
        if (!row) setError("This share link is invalid or has been removed.");
        else setInfo(row);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  // Auto-accept once user is signed in
  useEffect(() => {
    if (!user || !token || !info || info.revoked || accepting) return;
    setAccepting(true);
    acceptShareToken(token)
      .then((dealId) => {
        navigate(`/?deal=${dealId}`, { replace: true });
      })
      .catch((e) => {
        setError(e.message);
        setAccepting(false);
      });
  }, [user, token, info, accepting, navigate]);

  if (loading || (!info && !error)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">Can't open this link</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (info?.revoked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">Link revoked</h1>
          <p className="text-sm text-muted-foreground">The owner has revoked this share link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4 rounded-lg border border-border bg-card p-8">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Share2 className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">
          {info?.owner_display_name} shared a deal with you
        </h1>
        <p className="text-sm text-muted-foreground">
          You've been invited to view <span className="font-medium text-foreground">"{info?.deal_name}"</span> on EasyVC. You'll be able to view all its information and use its chat.
        </p>
        {!user ? (
          <Button onClick={signInWithGoogle} className="w-full">
            Sign in to accept
          </Button>
        ) : (
          <Button disabled className="w-full gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening deal…
          </Button>
        )}
      </div>
    </div>
  );
}
