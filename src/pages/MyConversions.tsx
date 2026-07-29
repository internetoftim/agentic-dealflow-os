import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Loader2, AlertCircle, FileText, ExternalLink, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type Job = {
  token: string;
  status: string;
  source_url: string;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
  page_count: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  has_pdf: boolean;
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  pending: { text: "Queued", className: "bg-gray-100 text-gray-700" },
  capturing: { text: "Capturing", className: "bg-blue-50 text-blue-700" },
  processing: { text: "Processing", className: "bg-blue-50 text-blue-700" },
  complete: { text: "Ready", className: "bg-green-50 text-green-700" },
  failed: { text: "Failed", className: "bg-red-50 text-red-700" },
};

export default function MyConversions() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/list-conversions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Lookup failed");
      setJobs(data.jobs ?? []);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <Helmet>
        <title>Your decks · EasyVC</title>
        <meta name="description" content="Look up decks you've converted with EasyVC using your email." />
        <link rel="canonical" href="https://www.onepointsix.ai/my-decks" />
      </Helmet>

      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <Link to="/convert" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to Convert
          </Link>
          <h1 className="text-3xl font-semibold text-gray-900 mt-4">Your decks</h1>
          <p className="text-gray-600 mt-2">
            Enter the email you used when submitting. We'll show every deck you've converted.
          </p>
        </div>

        {!submitted ? (
          <form
            onSubmit={handleSubmit}
            className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1.5">
                Your email
              </label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={loading}
              />
              <p className="text-xs text-gray-500 mt-1">
                No password. We just match the email you submitted with.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Looking up…
                </>
              ) : (
                "Show my decks"
              )}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing decks for <span className="font-medium text-gray-900">{email}</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSubmitted(false);
                  setJobs([]);
                }}
              >
                Use another email
              </Button>
            </div>

            {jobs.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
                <FileText className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-600 mb-4">
                  No decks yet for this email.
                </p>
                <Button asChild>
                  <Link to="/convert">
                    Convert your first deck
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Link>
                </Button>
              </div>
            ) : (
              <ul className="space-y-3">
                {jobs.map((job) => {
                  const label = STATUS_LABEL[job.status] ?? {
                    text: job.status,
                    className: "bg-gray-100 text-gray-700",
                  };
                  const title = job.title || job.company_name || job.source_url;
                  const dashboardUrl = `/converted/${job.token}`;
                  return (
                    <li
                      key={job.token}
                      className="bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${label.className}`}
                            >
                              {label.text}
                            </span>
                            {job.page_count && (
                              <span className="text-xs text-gray-500">
                                {job.page_count} pages
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {title}
                          </p>
                          <a
                            href={job.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-gray-500 hover:text-gray-700 truncate inline-flex items-center gap-1 mt-0.5"
                          >
                            {job.source_url}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <p className="text-xs text-gray-400 mt-2">
                            Submitted {new Date(job.created_at).toLocaleString()}
                          </p>
                        </div>
                        <Button asChild size="sm" variant="outline">
                          <Link to={dashboardUrl}>
                            Open
                            <ArrowRight className="w-3 h-3 ml-1" />
                          </Link>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
