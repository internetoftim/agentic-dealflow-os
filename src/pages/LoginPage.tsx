import { useAuth } from "@/contexts/AuthContext";
import { Navigate, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Inbox, FileText, Sparkles, KanbanSquare, ShieldCheck, Workflow, FileDown, ArrowRight, Send } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";


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
      <div className="mx-auto max-w-6xl px-6 py-14 lg:py-24">
        <div className="grid gap-14 lg:grid-cols-[1.1fr_0.9fr] lg:gap-20 items-start">
          {/* Left: Product pitch */}
          <div>
            <div className="flex items-center gap-2.5">
              <BrandMark className="h-8 w-8" />
              <span className="text-[15px] font-semibold tracking-tight text-foreground">EasyVC</span>
              <span className="ml-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand">
                <Sparkles className="h-3 w-3" />
                Deal OS
              </span>
            </div>

            <h1 className="mt-10 font-serif text-[40px] lg:text-[52px] leading-[1.05] font-semibold tracking-tight text-foreground">
              The deal desk for
              <br />
              investment teams.
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
              Ingest deal flow, standardise it in a workspace built for investors, and
              generate investment memos — all in one place.
            </p>

            <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 border-t border-border pt-10">
              {features.map(({ icon: Icon, title, desc }) => (
                <div key={title}>
                  <div className="flex items-center gap-2 text-foreground">
                    <Icon className="h-[15px] w-[15px] text-brand" />
                    <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
                  </div>
                  <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>

            <div className="mt-10 flex items-center gap-2 text-[12px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Invite-only. New sign-ups require admin approval.
            </div>
          </div>

          {/* Right: Sign-in */}
          <div className="w-full max-w-md lg:sticky lg:top-24">
            <div className="rounded-md border border-border bg-card p-7">
              <h2 className="text-[17px] font-semibold tracking-tight text-foreground">Sign in</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Continue with Google to access your deal pipeline.
              </p>
              <button
                onClick={() => signInWithGoogle()}
                className="mt-6 flex items-center justify-center gap-3 w-full rounded-[5px] bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 transition-opacity"
              >
                <img
                  src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                  alt=""
                  className="h-4 w-4"
                />
                Continue with Google
              </button>
              <ul className="mt-6 space-y-2 text-[12px] text-muted-foreground border-t border-border pt-5">
                <li className="flex gap-2">
                  <span className="text-brand shrink-0">—</span>
                  Grants Drive access for deck sync
                </li>
                <li className="flex gap-2">
                  <span className="text-brand shrink-0">—</span>
                  Auto-processes emails via a dedicated Gmail label, or inbound submissions to a
                  dedicated mailbox
                </li>
              </ul>
            </div>

            <div className="mt-3 rounded-md border border-border bg-card divide-y divide-border overflow-hidden">
              {[
                {
                  to: "/convert",
                  icon: FileDown,
                  title: "No account? Convert a DocSend or Papermark link",
                  desc: "Paste a link, get a downloadable PDF emailed to you. Free, no sign-in.",
                },
                {
                  to: "/intake/easyvc",
                  icon: Send,
                  title: "Have a deal? Send it to our resident VC",
                  desc: "Share your deck, DocSend link, or company details — reviewed by our resident VC.",
                },
              ].map(({ to, icon: Icon, title, desc }) => (
                <Link key={to} to={to} className="flex items-start gap-3 p-5 hover:bg-accent/50 transition-colors group">
                  <Icon className="h-4 w-4 text-brand shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13px] font-medium text-foreground">{title}</p>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                    </div>
                    <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
