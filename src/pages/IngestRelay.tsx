import { useEffect, useState, useRef } from "react";
import { FileText, Wand2, CheckCircle, AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

type RelayState = "waiting" | "receiving" | "uploading" | "success" | "error";

const STATUS_CONFIG: Record<RelayState, { icon: React.ReactNode; text: string; sub: string }> = {
  waiting: {
    icon: <div className="relative"><FileText className="h-16 w-16 text-primary" /><Wand2 className="h-8 w-8 text-accent-foreground absolute -bottom-1 -right-2" /></div>,
    text: "Waiting for bookmarklet payload…",
    sub: "Run the bookmarklet on a DocSend page, then this tab will receive the slides automatically.",
  },
  receiving: {
    icon: <Loader2 className="h-16 w-16 text-primary animate-spin" />,
    text: "Receiving slides from bookmarklet…",
    sub: "Decoding image data.",
  },
  uploading: {
    icon: <Loader2 className="h-16 w-16 text-primary animate-spin" />,
    text: "Uploading to pipeline…",
    sub: "Sending slides to the ingestion edge function.",
  },
  success: {
    icon: <CheckCircle className="h-16 w-16 text-green-500" />,
    text: "Ingestion complete!",
    sub: "Redirecting to Deal Workspace…",
  },
  error: {
    icon: <AlertTriangle className="h-16 w-16 text-destructive" />,
    text: "Something went wrong",
    sub: "",
  },
};

export default function IngestRelay() {
  const [state, setState] = useState<RelayState>("waiting");
  const [errorMsg, setErrorMsg] = useState("");
  const [slideCount, setSlideCount] = useState(0);
  const navigate = useNavigate();
  const { user } = useAuth();
  const processedRef = useRef(false);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Only accept messages from known origins or same-origin
      if (event.data?.type !== "DECK_INGESTION") return;
      if (processedRef.current) return;
      processedRef.current = true;

      const { payload, sourceName, sourceUrl, passcode } = event.data as {
        type: string;
        payload: string[]; // base64 jpeg strings
        sourceName?: string;
        sourceUrl?: string;
        passcode?: string;
      };

      if (!payload || !Array.isArray(payload) || payload.length === 0) {
        setState("error");
        setErrorMsg("Empty payload received from bookmarklet.");
        return;
      }

      setSlideCount(payload.length);
      setState("receiving");

      // Short delay then upload
      setTimeout(() => uploadPayload(payload, sourceName, sourceUrl), 300);
    }

    async function uploadPayload(images: string[], sourceName?: string, sourceUrl?: string) {
      setState("uploading");
      try {
        const { data, error } = await supabase.functions.invoke("ingest-relay", {
          body: {
            images,
            userId: user?.id,
            userEmail: user?.email,
            sourceName: sourceName || "DocSend Deck",
            sourceUrl,
          },
        });

        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        setState("success");
        setTimeout(() => navigate("/"), 2000);
      } catch (e: any) {
        setState("error");
        setErrorMsg(e.message || "Upload failed");
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [user, navigate]);

  const cfg = STATUS_CONFIG[state];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 max-w-md text-center px-6">
        <div className="animate-pulse">{cfg.icon}</div>
        <h1 className="text-2xl font-semibold text-foreground">{cfg.text}</h1>
        <p className="text-muted-foreground text-sm">
          {state === "error" ? errorMsg : cfg.sub}
        </p>
        {slideCount > 0 && state !== "waiting" && (
          <p className="text-xs text-muted-foreground">{slideCount} slides captured</p>
        )}
      </div>
    </div>
  );
}
