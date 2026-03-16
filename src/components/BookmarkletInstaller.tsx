import { useState } from "react";
import { Bookmark, Copy, CheckCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Generates the bookmarklet JS code.
 * The script runs on a DocSend page, captures all slides via canvas,
 * and relays them to our app via window.postMessage to bypass CSP.
 */
function generateBookmarklet(appOrigin: string): string {
  // The actual bookmarklet code (unminified for readability, will be URI-encoded)
  const code = `
(function(){
  var RELAY_URL = '${appOrigin}/ingest-relay';
  var slides = [];
  var canvas = document.querySelector('canvas');
  if (!canvas) { alert('AgenticVC: No canvas found on this page. Make sure you are viewing a DocSend deck.'); return; }

  var nextBtn = document.querySelector('[data-testid="next-page-btn"]')
    || document.querySelector('button[aria-label="Next page"]')
    || document.querySelector('.next-page-button')
    || (function(){ var btns = document.querySelectorAll('button'); for(var i=0;i<btns.length;i++){if(/next/i.test(btns[i].textContent)||/next/i.test(btns[i].getAttribute('aria-label')||'')){return btns[i];}} return null; })();

  var pageIndicator = document.querySelector('[data-testid="page-indicator"]')
    || document.querySelector('.page-indicator');

  function getTotalPages(){
    if(pageIndicator){
      var m = pageIndicator.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
      if(m) return parseInt(m[2],10);
    }
    return 999;
  }

  function captureSlide(){
    try {
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      slides.push(dataUrl);
    } catch(e) {
      alert('AgenticVC: Canvas is tainted — cross-origin restriction. Cloud fallback required.');
      sendToRelay();
      return;
    }

    var total = getTotalPages();
    if(slides.length >= total || !nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled')==='true'){
      sendToRelay();
      return;
    }

    nextBtn.click();
    setTimeout(captureSlide, 800);
  }

  function sendToRelay(){
    if(slides.length === 0){ alert('AgenticVC: No slides captured.'); return; }
    var w = window.open(RELAY_URL, '_blank');
    if(!w){ alert('AgenticVC: Popup blocked. Please allow popups for this site.'); return; }

    var attempts = 0;
    var timer = setInterval(function(){
      attempts++;
      try {
        w.postMessage({
          type: 'DECK_INGESTION',
          payload: slides,
          sourceName: document.title || 'DocSend Deck',
          sourceUrl: window.location.href
        }, '${appOrigin}');
      } catch(e){}
      if(attempts > 30){ clearInterval(timer); alert('AgenticVC: Relay page did not respond. Please try again.'); }
    }, 500);

    window.addEventListener('message', function handler(ev){
      if(ev.data && ev.data.type === 'DECK_INGESTION_ACK'){
        clearInterval(timer);
        window.removeEventListener('message', handler);
        alert('AgenticVC: ' + slides.length + ' slides sent successfully!');
      }
    });
  }

  var ok = confirm('AgenticVC Bookmarklet\\n\\nReady to capture ' + getTotalPages() + ' slides from this deck.\\n\\nClick OK to start.');
  if(ok) captureSlide();
})();
`.trim();

  return "javascript:" + encodeURIComponent(code);
}

export function BookmarkletInstaller() {
  const [copied, setCopied] = useState(false);
  const appOrigin = window.location.origin;
  const bookmarkletCode = generateBookmarklet(appOrigin);

  const handleCopy = () => {
    navigator.clipboard.writeText(bookmarkletCode);
    setCopied(true);
    toast.success("Bookmarklet code copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Bookmark className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">DocSend Bookmarklet</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Drag the button below to your bookmarks bar, then click it on any DocSend page to capture all slides and ingest them into your pipeline.
      </p>

      <div className="flex items-center gap-3">
        {/* The draggable bookmarklet link */}
        <a
          href={bookmarkletCode}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 cursor-grab active:cursor-grabbing no-underline"
          onClick={(e) => e.preventDefault()}
          title="Drag this to your bookmarks bar"
        >
          <Bookmark className="h-4 w-4" />
          📥 Capture Deck
        </a>

        <Button variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <CheckCircle className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p className="font-medium">How it works:</p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>Open the DocSend link and enter the email gate manually</li>
          <li>Once you see the deck viewer, click the bookmarklet</li>
          <li>It captures each slide screenshot and opens a relay tab</li>
          <li>Slides are sent to your pipeline via postMessage (bypasses CSP)</li>
        </ol>
      </div>
    </div>
  );
}
