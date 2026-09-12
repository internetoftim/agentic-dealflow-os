import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { BrandMark } from "@/components/BrandMark";

const APP = "EasyVC";
const COMPANY = "OnePointSix";
const CONTACT = "vc@onepointsix.ai";
const UPDATED = "12 September 2026";

function Shell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{title} — {APP}</title>
        <meta name="description" content={description} />
      </Helmet>
      <div className="mx-auto max-w-2xl px-6 py-14">
        <Link to="/login" className="inline-flex items-center gap-2.5 text-foreground">
          <BrandMark className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight">{APP}</span>
        </Link>
        <h1 className="mt-10 font-serif text-[32px] leading-tight font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-[12px] text-muted-foreground">Last updated {UPDATED} · {COMPANY}</p>
        <div className="memo-prose mt-8">{children}</div>
        <footer className="mt-14 border-t border-border pt-5 text-[12px] text-muted-foreground flex gap-4">
          <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
          <Link to="/terms" className="hover:text-foreground">Terms</Link>
          <a href={`mailto:${CONTACT}`} className="hover:text-foreground">{CONTACT}</a>
        </footer>
      </div>
    </div>
  );
}

/** The exact wording Google's API Services User Data Policy asks apps to publish. */
export const GOOGLE_LIMITED_USE_DISCLOSURE =
  `${APP}'s use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.`;

export function PrivacyPolicy() {
  return (
    <Shell title="Privacy Policy" description={`How ${APP} collects, uses, and protects your data, including data from Google APIs.`}>
      <p>{APP} is a deal-flow workspace for investment teams, operated by {COMPANY}. This policy explains what we collect, why, and the controls you have. It applies to the {APP} web app, its public intake and share pages, and its MCP connector for AI agents.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account:</strong> your name, email address and profile picture from Google Sign-In, used to identify you and your workspace.</li>
        <li><strong>Deal content:</strong> pitch decks and documents you upload, paste as links, forward by email, or that founders submit through your intake link; the text extracted from them; and the research, notes and memos generated around them.</li>
        <li><strong>Team data:</strong> team membership and shared notes, if you create or join a team.</li>
        <li><strong>Usage records:</strong> an ingestion ledger (what arrived, from whom, and what happened to it) and an audit log of actions taken by connected AI agents.</li>
      </ul>

      <h2>Data from Google</h2>
      <p>With your consent, {APP} requests these Google permissions. Each is optional beyond sign-in and can be revoked at any time.</p>
      <ul>
        <li><strong>Google Drive (drive.file):</strong> to save processed decks and memos into a folder you choose. We can only see files {APP} itself created.</li>
        <li><strong>Gmail (gmail.modify), only if you enable Gmail auto-ingest or connect a deal inbox:</strong> to find emails carrying pitch decks, download those attachments, and mark those emails as read. We do not read other emails, send email, or delete anything.</li>
      </ul>
      <p><strong>{GOOGLE_LIMITED_USE_DISCLOSURE}</strong></p>
      <p>Specifically, Google user data is used only to provide the features above; it is never used for advertising, never sold, and never shared with third parties except the sub-processors below acting on our instructions. Humans do not read your Gmail data except with your explicit permission for support, or as required by law.</p>

      <h2>How we protect it</h2>
      <ul>
        <li>Google access and refresh tokens are encrypted at rest (AES-256-GCM) and are readable only by our server-side functions — never by the browser or by other users.</li>
        <li>All data is isolated per workspace with database row-level security; team data is visible only to team members.</li>
        <li>Transport is TLS everywhere. Infrastructure is hosted on Supabase (EU) and Google Cloud.</li>
      </ul>

      <h2>Sub-processors</h2>
      <p>Supabase (database, storage, authentication), Google Cloud (deck rendering service, Drive/Gmail APIs), OpenAI (deck analysis and memo drafting — deck text is sent for processing and not used to train models), Tavily and Firecrawl (company research on public web sources), Resend (transactional email). Each processes data solely to provide the service.</p>

      <h2>Retention and deletion</h2>
      <p>Your data is kept while your account is active. From <em>Settings → Data &amp; privacy</em> you can disconnect Google (we revoke our access at Google and delete the stored tokens immediately) or delete your account, which permanently removes your deals, documents, notes, tokens and profile within minutes. You can also revoke {APP} from your Google Account permissions page at any time.</p>

      <h2>Your rights</h2>
      <p>You can access, export (via Drive sync or the MCP connector), correct, or delete your data. For requests or questions, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>

      <h2>Changes</h2>
      <p>We will post updates here and, for material changes, notify you by email.</p>
    </Shell>
  );
}

export function TermsOfService() {
  return (
    <Shell title="Terms of Service" description={`Terms governing use of ${APP}.`}>
      <p>By using {APP} you agree to these terms. {APP} is provided by {COMPANY} to investment professionals for managing deal flow.</p>
      <h2>Your account</h2>
      <p>Access is by invitation and admin approval. You are responsible for activity under your account and for having the right to upload or forward the materials you bring into the workspace, including decks shared with you in confidence.</p>
      <h2>Your content</h2>
      <p>You retain all rights to your content. You grant {COMPANY} only the licence needed to store, process and display it to you and your team as the service requires. AI-generated research and memos are drafts for your professional judgement; they may contain errors and are not investment advice.</p>
      <h2>Acceptable use</h2>
      <p>Don't use {APP} to process data you aren't entitled to, to violate others' rights, to send unsolicited mail through connected inboxes, or to probe or disrupt the service.</p>
      <h2>Google services</h2>
      <p>Features that use Google Drive or Gmail are subject to Google's terms and to our <Link to="/privacy">Privacy Policy</Link>, including the Google API Services User Data Policy.</p>
      <h2>Availability and liability</h2>
      <p>The service is provided as-is. To the extent permitted by law, {COMPANY} is not liable for indirect or consequential loss, and total liability is limited to the fees paid in the preceding twelve months.</p>
      <h2>Termination</h2>
      <p>You can delete your account at any time from Settings. We may suspend accounts that breach these terms.</p>
      <h2>Contact</h2>
      <p><a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
    </Shell>
  );
}
