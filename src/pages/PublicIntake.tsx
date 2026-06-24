import { useState, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Upload, Check, AlertCircle, Loader2, FileUp } from "lucide-react";

const INTAKE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Submit your deal to EasyVC",
  url: "https://www.onepointsix.ai/intake",
  description: "Submit your pitch deck or deal materials for review by an EasyVC-powered investor.",
  isPartOf: { "@type": "WebSite", name: "EasyVC", url: "https://www.onepointsix.ai/" },
  breadcrumb: {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.onepointsix.ai/" },
      { "@type": "ListItem", position: 2, name: "Intake", item: "https://www.onepointsix.ai/intake" },
    ],
  },
};
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".pdf", ".pptx", ".ppt"];
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

const REFERRAL_OPTIONS = [
  "LinkedIn",
  "Twitter / X",
  "A founder / friend",
  "An investor",
  "Newsletter",
  "Conference / Event",
  "Search engine",
  "Other",
];

type UploadState = "idle" | "uploading" | "success" | "error";

function getFileExtension(name: string): string {
  return name.toLowerCase().slice(name.lastIndexOf("."));
}

export default function PublicIntake() {
  const { userId } = useParams<{ userId: string }>();
  const [companyName, setCompanyName] = useState("");
  const [submitterName, setSubmitterName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [docsendUrl, setDocsendUrl] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [message, setMessage] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [referralOther, setReferralOther] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = useCallback((f: File): string | null => {
    const ext = getFileExtension(f.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return "Only PDF and PPTX files are accepted.";
    }
    if (f.size > MAX_FILE_SIZE) {
      return "File must be under 20MB.";
    }
    return null;
  }, []);

  const handleFileSelect = useCallback(
    (f: File) => {
      const err = validateFile(f);
      if (err) {
        setErrorMessage(err);
        return;
      }
      setErrorMessage("");
      setFile(f);
    },
    [validateFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFileSelect(f);
    },
    [handleFileSelect]
  );

  const isEmailValid = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const resolvedReferral =
    referralSource === "Other" ? referralOther.trim() : referralSource;

  const canSubmit =
    !!userId &&
    submitterName.trim().length > 0 &&
    isEmailValid(submitterEmail.trim()) &&
    resolvedReferral.length > 0 &&
    uploadState !== "uploading";

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setUploadState("uploading");
    setProgress(10);
    setErrorMessage("");

    try {
      const formData = new FormData();
      if (file) formData.append("file", file);
      formData.append("userId", userId!);
      formData.append("companyName", companyName.trim() || "Unknown");
      formData.append("submitterName", submitterName.trim());
      formData.append("submitterEmail", submitterEmail.trim());
      formData.append("referralSource", resolvedReferral);
      if (docsendUrl.trim()) formData.append("docsendUrl", docsendUrl.trim());
      if (linkedinUrl.trim()) formData.append("linkedinUrl", linkedinUrl.trim());
      if (websiteUrl.trim()) formData.append("websiteUrl", websiteUrl.trim());
      if (message.trim()) formData.append("message", message.trim());

      setProgress(30);

      const res = await fetch(`${SUPABASE_URL}/functions/v1/public-intake`, {
        method: "POST",
        body: formData,
      });

      setProgress(80);

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Submission failed");
      }

      setProgress(100);
      setUploadState("success");
    } catch (err: any) {
      setErrorMessage(err.message || "Something went wrong. Please try again.");
      setUploadState("error");
    }
  };

  const resetForm = () => {
    setFile(null);
    setCompanyName("");
    setSubmitterName("");
    setSubmitterEmail("");
    setDocsendUrl("");
    setLinkedinUrl("");
    setWebsiteUrl("");
    setMessage("");
    setReferralSource("");
    setReferralOther("");
    setUploadState("idle");
    setProgress(0);
    setErrorMessage("");
  };

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Invalid intake link.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Helmet>
        <title>Submit your deal — EasyVC</title>
        <meta name="description" content="Submit your pitch deck or deal materials for review. EasyVC standardizes deal flow and drafts investment memos for venture capital teams." />
        <link rel="canonical" href="https://www.onepointsix.ai/intake" />
        <meta property="og:title" content="Submit your deal — EasyVC" />
        <meta property="og:url" content="https://www.onepointsix.ai/intake" />
        <meta property="og:description" content="Share your pitch deck or links for review." />
        <script type="application/ld+json">{JSON.stringify(INTAKE_JSONLD)}</script>
      </Helmet>
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-primary/10 mb-4">
            <FileUp className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Submit Your Deal</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Share your pitch deck or links for review.
          </p>
        </div>

        {uploadState === "success" ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-success/10 mb-4">
              <Check className="h-7 w-7 text-success" />
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-1">Thank You!</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Your submission has been received. We'll review it shortly.
            </p>
            <Button variant="outline" onClick={resetForm}>
              Submit Another
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-6 space-y-4">
            {/* Required: Name + Email */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Your Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                  placeholder="Jane Doe"
                  maxLength={100}
                  disabled={uploadState === "uploading"}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Your Email <span className="text-destructive">*</span>
                </label>
                <Input
                  value={submitterEmail}
                  onChange={(e) => setSubmitterEmail(e.target.value)}
                  placeholder="jane@acme.com"
                  type="email"
                  maxLength={255}
                  disabled={uploadState === "uploading"}
                />
              </div>
            </div>

            {/* Required: Referral source */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Where did you hear about us? <span className="text-destructive">*</span>
              </label>
              <Select
                value={referralSource}
                onValueChange={setReferralSource}
                disabled={uploadState === "uploading"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an option" />
                </SelectTrigger>
                <SelectContent>
                  {REFERRAL_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {referralSource === "Other" && (
                <Input
                  value={referralOther}
                  onChange={(e) => setReferralOther(e.target.value)}
                  placeholder="Please specify"
                  maxLength={200}
                  disabled={uploadState === "uploading"}
                  className="mt-2"
                />
              )}
            </div>

            {/* Optional: Company */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Company Name
              </label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Corp"
                maxLength={150}
                disabled={uploadState === "uploading"}
              />
            </div>

            {/* Optional: Links */}
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Website URL
                </label>
                <Input
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="https://acme.com"
                  type="url"
                  maxLength={500}
                  disabled={uploadState === "uploading"}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  DocSend URL
                </label>
                <Input
                  value={docsendUrl}
                  onChange={(e) => setDocsendUrl(e.target.value)}
                  placeholder="https://docsend.com/view/..."
                  type="url"
                  maxLength={500}
                  disabled={uploadState === "uploading"}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  LinkedIn
                </label>
                <Input
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  type="url"
                  maxLength={500}
                  disabled={uploadState === "uploading"}
                />
              </div>
            </div>

            {/* Optional: Pitch deck */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Pitch Deck
              </label>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : file
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-accent/50"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.pptx,.ppt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                  }}
                  disabled={uploadState === "uploading"}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileUp className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium text-foreground">{file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      ({(file.size / (1024 * 1024)).toFixed(1)} MB)
                    </span>
                  </div>
                ) : (
                  <>
                    <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">
                      Drag & drop or click to select
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      PDF or PPTX, max 20MB
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Optional: Message */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Message
              </label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Anything else you'd like us to know?"
                maxLength={2000}
                rows={3}
                disabled={uploadState === "uploading"}
              />
            </div>

            {/* Error */}
            {errorMessage && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-destructive">{errorMessage}</p>
              </div>
            )}

            {/* Progress */}
            {uploadState === "uploading" && (
              <Progress value={progress} className="h-2" />
            )}

            {/* Submit */}
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full"
            >
              {uploadState === "uploading" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Submit
                </>
              )}
            </Button>
          </div>
        )}

        <p className="text-xs text-muted-foreground text-center mt-4">
          Powered by EasyVC
        </p>
      </div>
    </div>
  );
}
