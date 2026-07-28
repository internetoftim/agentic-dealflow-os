import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Loader2, Download, AlertCircle, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type Job = {
  token: string;
  status: string;
  error_message: string | null;
  source_url: string;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
  notes: string | null;
  page_count: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

const TERMINAL = new Set(["complete", "failed"]);
const STORAGE_KEY_EMAIL = "convert:email";

export default function ConversionDashboard() {
  const { token } = useParams<{ token: string }>();
  const [email, setEmail] = useState(() => sessionStorage.getItem(STORAGE_KEY_EMAIL) || "");
  const [unlocked, setUnlocked] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchJob = useCallback(
    async (emailValue: string): Promise<boolean> => {
      if (!token || !emailValue) return false;
      setLoading(true);
      setError("");
      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/get-conversion`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
          },
          body: JSON.stringify({ token, email: emailValue }),
        });
        if (resp.status === 404) {
          setError("That email doesn't match this dashboard. Please check and try again.");
          return false;
        }
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || "Failed to load");
        setJob(data.job);
        setDownloadUrl(data.downloadUrl);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    const ok = await fetchJob(email.trim().toLowerCase());
    if (ok) {
      sessionStorage.setItem(STORAGE_KEY_EMAIL, email.trim().toLowerCase());
      setUnlocked(true);
    }
  }

  // Auto-unlock from session
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY_EMAIL);
    if (stored && !unlocked) {
      fetchJob(stored).then((ok) => {
        if (ok) setUnlocked(true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while non-terminal
  useEffect(() => {
    if (!unlocked || !job) return;
    if (TERMINAL.has(job.status)) return;
    const t = setInterval(() => {
      fetchJob(email.trim().toLowerCase());
    }, 5000);
    return () => clearInterval(t);
  }, [unlocked, job, email, fetchJob]);

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-gray-50 py-12 px-4">
        <Helmet>
          <title>Your conversion · EasyVC</title>
          <meta name="robots" content="noindex" />
        </Helmet>
        <div className="max-w-md mx-auto">
          <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
            <h1 className="text-xl font-medium text-gray-900 mb-2">Confirm your email</h1>
            <p className="text-sm text-gray-600 mb-6">
              Enter the email you used when you submitted this link.
            </p>
            <form onSubmit={handleUnlock} className="space-y-4">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
              />
              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Unlock dashboard"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const statusLabel: Record<string, string> = {
    pending: "Queued",
    capturing: "Capturing slides…",
    complete: "Ready",
    failed: "Failed",
  };

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <Helmet>
        <title>{job?.company_name || "Your deck"} · EasyVC</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">
            {job?.company_name || job?.title || "Your conversion"}
          </h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchJob(email.trim().toLowerCase())}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm mb-6">
          <div className="flex items-center gap-3">
            {job?.status === "complete" ? (
              <div className="w-8 h-8 bg-green-50 rounded-full flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600" />
              </div>
            ) : job?.status === "failed" ? (
              <div className="w-8 h-8 bg-red-50 rounded-full flex items-center justify-center">
                <AlertCircle className="w-4 h-4 text-red-600" />
              </div>
            ) : (
              <div className="w-8 h-8 bg-blue-50 rounded-full flex items-center justify-center">
                <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-gray-900">
                {job ? statusLabel[job.status] || job.status : "Loading…"}
              </p>
              {job?.status === "failed" && job.error_message && (
                <p className="text-xs text-red-600 mt-0.5">{job.error_message}</p>
              )}
              {job?.status === "complete" && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {job.page_count ?? 0} page{(job.page_count ?? 0) === 1 ? "" : "s"} captured
                </p>
              )}
            </div>
          </div>

          {job?.status === "complete" && downloadUrl && (
            <Button asChild className="w-full mt-5">
              <a href={downloadUrl} download>
                <Download className="w-4 h-4 mr-2" />
                Download PDF
              </a>
            </Button>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          <h2 className="text-sm font-medium text-gray-900 mb-4">Submission details</h2>
          <dl className="space-y-3 text-sm">
            <Row label="Source link" value={job?.source_url} isLink />
            <Row label="Company" value={job?.company_name} />
            <Row label="Website" value={job?.website} isLink />
            <Row label="LinkedIn" value={job?.linkedin_url} isLink />
            <Row label="Notes" value={job?.notes} multiline />
            <Row
              label="Submitted"
              value={job?.created_at ? new Date(job.created_at).toLocaleString() : null}
            />
          </dl>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  isLink,
  multiline,
}: {
  label: string;
  value?: string | null;
  isLink?: boolean;
  multiline?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-3 gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`col-span-2 text-gray-900 ${multiline ? "whitespace-pre-wrap" : "truncate"}`}>
        {isLink ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline break-all"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
