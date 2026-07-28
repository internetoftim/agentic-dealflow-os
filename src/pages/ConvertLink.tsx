import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Loader2, Check, AlertCircle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type SubmitState = "idle" | "submitting" | "success" | "error";

export default function ConvertLink() {
  const [email, setEmail] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [dashboardUrl, setDashboardUrl] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage("");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErrorMessage("Please enter a valid email address.");
      return;
    }
    if (!/^https?:\/\//i.test(sourceUrl.trim())) {
      setErrorMessage("Please enter a valid DocSend or Papermark link.");
      return;
    }

    setState("submitting");
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/submit-conversion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
        body: JSON.stringify({
          email: email.trim(),
          sourceUrl: sourceUrl.trim(),
          companyName: companyName.trim() || null,
          website: website.trim() || null,
          linkedinUrl: linkedinUrl.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Submission failed");
      setDashboardUrl(data.dashboardUrl);
      setState("success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Submission failed");
      setState("error");
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(dashboardUrl);
    toast.success("Link copied");
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <Helmet>
        <title>Convert a DocSend or Papermark link to PDF · EasyVC</title>
        <meta
          name="description"
          content="Paste a DocSend or Papermark link, get a downloadable PDF emailed to you. Free, no account needed."
        />
        <link rel="canonical" href="https://www.onepointsix.ai/convert" />
      </Helmet>

      <div className="max-w-xl mx-auto">
        <div className="text-center mb-8">
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-900">
            ← EasyVC
          </Link>
          <h1 className="text-3xl font-semibold text-gray-900 mt-4">
            Convert a DocSend or Papermark link to PDF
          </h1>
          <p className="text-gray-600 mt-3">
            We'll capture every slide and email you a PDF when it's ready. No account needed.
          </p>
        </div>

        {state === "success" ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-green-50 rounded-full flex items-center justify-center">
                <Check className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h2 className="text-lg font-medium">You're in the queue</h2>
                <p className="text-sm text-gray-500">
                  We'll email {email} when the PDF is ready.
                </p>
              </div>
            </div>
            <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                Your dashboard
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm text-gray-900 truncate">{dashboardUrl}</code>
                <Button size="sm" variant="outline" onClick={copyLink}>
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Bookmark this. You'll enter {email} once to unlock it.
              </p>
            </div>
            <div className="mt-6 flex gap-3">
              <Button asChild variant="outline" className="flex-1">
                <a href={dashboardUrl}>Open dashboard</a>
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  setEmail("");
                  setSourceUrl("");
                  setCompanyName("");
                  setWebsite("");
                  setLinkedinUrl("");
                  setNotes("");
                  setDashboardUrl("");
                  setState("idle");
                }}
              >
                Convert another
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm space-y-5"
          >
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1.5">
                Your email <span className="text-red-500">*</span>
              </label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={state === "submitting"}
              />
              <p className="text-xs text-gray-500 mt-1">
                We'll notify you here and use it to unlock your dashboard.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1.5">
                DocSend or Papermark link <span className="text-red-500">*</span>
              </label>
              <Input
                type="url"
                required
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://docsend.com/view/..."
                disabled={state === "submitting"}
              />
            </div>

            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-3">
                Optional details
              </p>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-700 mb-1.5">Company name</label>
                  <Input
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    disabled={state === "submitting"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1.5">Website</label>
                  <Input
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://"
                    disabled={state === "submitting"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1.5">LinkedIn</label>
                  <Input
                    type="url"
                    value={linkedinUrl}
                    onChange={(e) => setLinkedinUrl(e.target.value)}
                    placeholder="https://linkedin.com/in/..."
                    disabled={state === "submitting"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1.5">Notes</label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    disabled={state === "submitting"}
                  />
                </div>
              </div>
            </div>

            {errorMessage && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={state === "submitting"}
            >
              {state === "submitting" ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting…
                </>
              ) : (
                "Convert to PDF"
              )}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
