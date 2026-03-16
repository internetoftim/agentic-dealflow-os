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

  function findCanvas(doc){
    var c = doc.querySelector('canvas');
    if(c) return c;
    var iframes = doc.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
      try {
        var d = iframes[i].contentDocument || iframes[i].contentWindow.document;
        if(d){ var fc = findCanvas(d); if(fc) return fc; }
      } catch(e){}
    }
    return null;
  }

  function findDoc(){
    var iframes = document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
      try {
        var d = iframes[i].contentDocument || iframes[i].contentWindow.document;
        if(d && d.querySelector('canvas')) return d;
      } catch(e){}
    }
    return document;
  }

  var targetDoc = findDoc();
  var canvas = findCanvas(document);
  if (!canvas) { alert('EasyVC: No canvas found. The deck may still be loading, or the viewer uses a non-canvas renderer. Please wait for the deck to fully load and try again.'); return; }

  function findBtn(d){
    var selectors = [
      '[data-testid="next-page-btn"]',
      'button[aria-label="Next page"]',
      'button[aria-label="next page"]',
      '.next-page-button',
      '[class*="next"]',
      '[class*="Next"]'
    ];
    for(var i=0;i<selectors.length;i++){
      var b = d.querySelector(selectors[i]);
      if(b) return b;
    }
    var btns = d.querySelectorAll('button');
    for(var j=0;j<btns.length;j++){
      var txt = (btns[j].textContent||'')+(btns[j].getAttribute('aria-label')||'');
      if(/next/i.test(txt)) return btns[j];
    }
    return null;
  }

  var nextBtn = findBtn(targetDoc) || findBtn(document);

  function getPageInfo(d){
    var el = d.querySelector('[data-testid="page-indicator"]') || d.querySelector('.page-indicator');
    if(!el){
      var spans = d.querySelectorAll('span, div, p');
      for(var i=0;i<spans.length;i++){
        if(/\\d+\\s*(of|\\/|out of)\\s*\\d+/i.test(spans[i].textContent||'')){
          el = spans[i]; break;
        }
      }
    }
    if(el){
      var m = (el.textContent||'').match(/(\\d+)\\s*(?:of|\\/|out of)\\s*(\\d+)/i);
      if(m) return {current:parseInt(m[1],10), total:parseInt(m[2],10)};
    }
    return null;
  }

  function getTotalPages(){
    var info = getPageInfo(targetDoc) || getPageInfo(document);
    return info ? info.total : 999;
  }

  function captureSlide(){
    try {
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      slides.push(dataUrl);
    } catch(e) {
      alert('EasyVC: Canvas is tainted (cross-origin restriction). Cloud fallback required.');
      sendToRelay();
      return;
    }

    var total = getTotalPages();
    if(slides.length >= total || !nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled')==='true'){
      sendToRelay();
      return;
    }

    nextBtn.click();
    setTimeout(captureSlide, 1000);
  }

  function sendToRelay(){
    if(slides.length === 0){ alert('EasyVC: No slides captured.'); return; }
    var w = window.open(RELAY_URL, '_blank');
    if(!w){ alert('EasyVC: Popup blocked. Please allow popups for this site.'); return; }

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
      if(attempts > 30){ clearInterval(timer); alert('EasyVC: Relay page did not respond. Please try again.'); }
    }, 500);

    window.addEventListener('message', function handler(ev){
      if(ev.data && ev.data.type === 'DECK_INGESTION_ACK'){
        clearInterval(timer);
        window.removeEventListener('message', handler);
        alert('EasyVC: ' + slides.length + ' slides sent successfully!');
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
