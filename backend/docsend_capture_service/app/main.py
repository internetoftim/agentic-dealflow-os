import asyncio
import base64
import io
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

from fastapi import BackgroundTasks, FastAPI, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, HttpUrl, Field

API_KEY_NAME = "X-API-Key"
_api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=True)

def _get_api_key() -> str:
    key = os.getenv("SERVICE_API_KEY", "")
    if not key:
        raise RuntimeError("SERVICE_API_KEY not set")
    return key

async def verify_api_key(header_key: str = Security(_api_key_header)) -> None:
    if header_key != _get_api_key():
        raise HTTPException(status_code=403, detail="Invalid API key")
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from playwright.async_api import async_playwright, Page
from playwright_stealth import Stealth

try:
    # AG2 package name depends on distribution; this import works for pyautogen/ag2 installs.
    from autogen import AssistantAgent, UserProxyAgent  # type: ignore
except Exception:  # noqa: BLE001
    AssistantAgent = None
    UserProxyAgent = None


class CaptureRequest(BaseModel):
    url: HttpUrl
    max_pages: int = Field(default=20, ge=1, le=100)


class CaptureAsyncRequest(BaseModel):
    url: HttpUrl
    max_pages: int = Field(default=20, ge=1, le=100)
    callback_url: str
    job_id: str
    deal_id: str
    user_id: str
    service_role_key: str


class ScreenshotItem(BaseModel):
    page: int
    data_url: str


class CaptureResponse(BaseModel):
    title: Optional[str]
    page_count: int
    markdown: str
    screenshots: List[ScreenshotItem]
    pdf_base64: str


@dataclass
class AgentPlan:
    next_selector_candidates: List[str]


class AG2Planner:
    """Minimal AG2 planner that suggests next-page selectors.

    If AG2 is unavailable, it falls back to a static selector list.
    """

    def __init__(self) -> None:
        self.enabled = bool(AssistantAgent and UserProxyAgent and os.getenv("OPENAI_API_KEY"))

    def get_plan(self, html_hint: str) -> AgentPlan:
        defaults = [
            "button[aria-label*='Next']",
            "[data-testid*='next']",
            "button:has-text('Next')",
            ".docsend-viewer-next",
            "button[title*='Next']",
        ]

        if not self.enabled:
            return AgentPlan(next_selector_candidates=defaults)

        try:
            assistant = AssistantAgent(
                name="planner",
                llm_config={
                    "config_list": [{"model": os.getenv("AG2_MODEL", "gpt-4o-mini")}],
                },
                system_message=(
                    "You plan browser navigation on DocSend-like viewers. "
                    "Return strict JSON with key next_selector_candidates as an array of CSS selectors."
                ),
            )
            user = UserProxyAgent(name="user", human_input_mode="NEVER", code_execution_config=False)
            prompt = (
                "Given this limited page HTML, return likely selectors for the next-slide button. "
                f"HTML:\n{html_hint[:4000]}"
            )
            msg = user.initiate_chat(assistant, message=prompt, max_turns=1)
            content = (msg.chat_history[-1].get("content") if msg and msg.chat_history else "") or ""
            parsed = json.loads(content) if isinstance(content, str) and content.strip().startswith("{") else {}
            selectors = parsed.get("next_selector_candidates") or []
            selectors = [s for s in selectors if isinstance(s, str) and s.strip()]
            return AgentPlan(next_selector_candidates=selectors or defaults)
        except Exception:
            return AgentPlan(next_selector_candidates=defaults)


class DocsendWebAgent:
    def __init__(self, max_pages: int = 20) -> None:
        self.max_pages = max_pages
        self.planner = AG2Planner()

    async def _best_next_selector(self, page: Page) -> List[str]:
        html_hint = await page.content()
        plan = self.planner.get_plan(html_hint)
        return plan.next_selector_candidates

    async def _click_next(self, page: Page) -> bool:
        for selector in await self._best_next_selector(page):
            loc = page.locator(selector).first
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(timeout=2000)
                return True

        # keyboard fallback
        await page.keyboard.press("ArrowRight")
        return True

    async def capture(self, url: str) -> Dict[str, Any]:
        screenshots: List[Dict[str, Any]] = []
        notes: List[str] = []
        logger.info("Starting capture: %s (max_pages=%d)", url, self.max_pages)

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1440, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()
            await Stealth().apply_stealth_async(page)
            await page.goto(url, wait_until="domcontentloaded", timeout=120000)
            await page.wait_for_timeout(5000)

            title = await page.title()

            for i in range(1, self.max_pages + 1):
                logger.info("Capturing page %d", i)
                await page.wait_for_timeout(3000)
                text = (await page.locator("body").inner_text())[:6000]
                notes.append(f"## Page {i}\n\n{text.strip()}\n")

                image_bytes = await page.screenshot(full_page=True, type="png")
                data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("utf-8")
                screenshots.append({"page": i, "data_url": data_url})

                if i < self.max_pages:
                    progressed = await self._click_next(page)
                    if not progressed:
                        break

            await context.close()
            await browser.close()

        logger.info("Capture complete: %d pages", len(screenshots))
        pdf_base64 = build_pdf_base64(screenshots)
        markdown = "\n\n".join(notes)

        return {
            "title": title,
            "page_count": len(screenshots),
            "markdown": markdown,
            "screenshots": screenshots,
            "pdf_base64": pdf_base64,
        }


def build_pdf_base64(screenshots: List[Dict[str, Any]]) -> str:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)

    for shot in screenshots:
        data_url = shot.get("data_url", "")
        if not isinstance(data_url, str) or "," not in data_url:
            continue
        raw_b64 = data_url.split(",", 1)[1]
        img_bytes = base64.b64decode(raw_b64)

        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        width, height = image.size

        page_width, page_height = letter
        scale = min(page_width / width, page_height / height)
        draw_w = width * scale
        draw_h = height * scale
        x = (page_width - draw_w) / 2
        y = (page_height - draw_h) / 2

        image_stream = io.BytesIO()
        image.save(image_stream, format="JPEG", quality=90)
        image_stream.seek(0)

        pdf.drawInlineImage(Image.open(image_stream), x, y, draw_w, draw_h)
        pdf.showPage()

    pdf.save()
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ngrok_token = os.getenv("NGROK_AUTHTOKEN")
    if ngrok_token:
        from pyngrok import ngrok, conf
        conf.get_default().auth_token = ngrok_token
        tunnel = ngrok.connect(int(os.getenv("PORT", "8080")))
        logger.info("ngrok tunnel: %s", tunnel.public_url)
    yield
    if ngrok_token:
        from pyngrok import ngrok
        ngrok.kill()

app = FastAPI(title="DocSend Capture Service", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/capture", response_model=CaptureResponse, dependencies=[Security(verify_api_key)])
async def capture_docsend(req: CaptureRequest) -> CaptureResponse:
    try:
        agent = DocsendWebAgent(max_pages=req.max_pages)
        result = await agent.capture(str(req.url))
        return CaptureResponse(**result)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Capture failed: {exc}") from exc


async def _run_capture_and_callback(req: CaptureAsyncRequest) -> None:
    """Background task: run capture and POST results to callback URL."""
    import httpx

    payload: Dict[str, Any] = {
        "job_id": req.job_id,
        "deal_id": req.deal_id,
        "user_id": req.user_id,
        "service_role_key": req.service_role_key,
    }

    try:
        agent = DocsendWebAgent(max_pages=req.max_pages)
        result = await agent.capture(str(req.url))
        payload["pdf_base64"] = result["pdf_base64"]
        payload["markdown"] = result["markdown"]
        payload["page_count"] = result["page_count"]
    except Exception as exc:
        logger.error("Async capture failed for job %s: %s", req.job_id, exc)
        payload["error"] = str(exc)

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(req.callback_url, json=payload)
            logger.info("Callback response for job %s: %s", req.job_id, resp.status_code)
    except Exception as exc:
        logger.error("Failed to send callback for job %s: %s", req.job_id, exc)


@app.post("/capture-async", dependencies=[Security(verify_api_key)])
async def capture_docsend_async(req: CaptureAsyncRequest, background_tasks: BackgroundTasks) -> Dict[str, str]:
    """Accept a capture request and process it in the background. Results are POSTed to callback_url."""
    background_tasks.add_task(_run_capture_and_callback, req)
    logger.info("Queued async capture for job %s (deal %s)", req.job_id, req.deal_id)
    return {"status": "accepted", "job_id": req.job_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")), reload=False)
