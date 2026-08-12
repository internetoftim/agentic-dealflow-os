import { useAuth } from "@/contexts/AuthContext";
import { Navigate, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Inbox, FileText, Sparkles, KanbanSquare, ShieldCheck, Workflow, FileDown, ArrowRight, Send } from "lucide-react";


const LOGIN_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Sign in — EasyVC",
  url: "https://www.onepointsix.ai/login",
  description: "Sign in to EasyVC, the autonomous OS for VC analysts.",
  isPartOf: { "@type": "WebSite", name: "EasyVC", url: "https://www.onepointsix.ai/" },
  breadcrumb: {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://www.onepointsix.ai/" },
      { "@type": "ListItem", position: 2, name: "Sign in", item: "https://www.onepointsix.ai/login" },
    ],
  },
};

const features = [
  {
    icon: Inbox,
    title: "Automated ingestion",
    desc: "Forward pitch decks or share your intake link. Gmail, DocSend, and Papermark decks flow in automatically.",
  },
  {
    icon: Workflow,
    title: "Deep research agent",
    desc: "Every deal is enriched with founder profiles, funding history, and market context — verified, not guessed.",
  },
  {
    icon: FileText,
    title: "One-click memos",
    desc: "Generate structured investment memos from deck, research, and your notes. Exported straight to Drive.",
  },
  {
    icon: KanbanSquare,
    title: "Deal Desk",
    desc: "A single deal desk for partners, VCs, and analysts — pipeline, workspace, and notes in one place, not a generic CRM.",
  },
];

export default function LoginPage() {
  const { user, loading, signInWithGoogle } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin-slow h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Sign in — EasyVC</title>
        <meta name="description" content="Sign in to EasyVC — the autonomous OS for VC analysts. Ingest deal flow, run deep research, and draft investment memos." />
        <link rel="canonical" href="https://www.onepointsix.ai/login" />
        <meta property="og:title" content="Sign in — EasyVC" />
        <meta property="og:url" content="https://www.onepointsix.ai/login" />
        <meta property="og:description" content="Sign in to EasyVC — the autonomous OS for VC analysts." />
        <script type="application/ld+json">{JSON.stringify(LOGIN_JSONLD)}</script>
      </Helmet>
      <div className="mx-auto max-w-6xl px-6 py-12 lg:py-20">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
          {/* Left: Product pitch */}
          <div className="space-y-8">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                The autonomous OS for investors
              </div>
              <h1 className="text-4xl lg:text-5xl font-semibold tracking-tight text-foreground">
                EasyVC
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Ingest deal flow, standardize it in a workspace built for investment teams,
                and generate investment memos — all in one place.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              {features.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-foreground">
                    <Icon className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-medium">{title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
              <ShieldCheck className="h-3.5 w-3.5" />
              Invite-only. New sign-ups require admin approval.
            </div>
          </div>

          {/* Right: Sign-in card */}
          <div className="lg:pl-8">
            <div className="w-full max-w-md mx-auto rounded-xl border border-border bg-card p-8">
              <h2 className="text-xl font-semibold text-foreground mb-1">Sign in</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Continue with Google to access your deal pipeline.
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
                Continue with Google
              </button>
              <div className="mt-6 space-y-2 text-xs text-muted-foreground">
                <p>• Grants Drive access for deck sync</p>
                <p>• Auto-processes emails with a dedicated Gmail label, or inbound submissions to a dedicated mailbox</p>
              </div>
            </div>

            <Link
              to="/convert"
              className="mt-6 block w-full max-w-md mx-auto rounded-xl border border-border bg-card p-5 hover:border-primary/40 hover:bg-accent/40 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                  <FileDown className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">
                      No account? Convert a DocSend or Papermark link
                    </p>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Paste a link, get a downloadable PDF emailed to you. Free, no sign-in.
                  </p>
                </div>
              </div>
            </Link>
            <Link
              to="/intake/easyvc"
              className="mt-4 block w-full max-w-md mx-auto rounded-xl border border-border bg-card p-5 hover:border-primary/40 hover:bg-accent/40 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                  <Send className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">
                      Do you have a deal? Send it to our resident VC
                    </p>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Share your deck, DocSend link, or company details — reviewed by Tim Santos.
                  </p>
                </div>
              </div>
            </Link>

          </div>

        </div>
      </div>
    </div>
  );
}
