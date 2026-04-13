import asyncio
import base64
import hashlib
import io
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Security
from fastapi.responses import StreamingResponse
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
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from playwright.async_api import async_playwright, Page
from playwright_stealth import Stealth

try:
    from autogen import AssistantAgent, UserProxyAgent  # type: ignore
except Exception:  # noqa: BLE001
    AssistantAgent = None
    UserProxyAgent = None


class CaptureRequest(BaseModel):
    url: HttpUrl
    max_pages: int = Field(default=20, ge=1, le=100)
    gate_email: Optional[str] = Field(default=None, description="Optional email for gated viewers")


class ScreenshotItem(BaseModel):
    page: int
    data_url: str


class CaptureResponse(BaseModel):
    title: Optional[str]
    page_count: int
    screenshots: List[ScreenshotItem]
    pdf_base64: str


@dataclass
class AgentPlan:
    next_selector_candidates: List[str]
    email_selector_candidates: List[str]
    gate_submit_selector_candidates: List[str]
    cookie_dismiss_selector_candidates: List[str]


class AG2Planner:
    def __init__(self) -> None:
        self.enabled = bool(AssistantAgent and UserProxyAgent and os.getenv("OPENAI_API_KEY"))

    def get_plan(self, html_hint: str) -> AgentPlan:
        next_defaults = [
            "button[aria-label*='Next']",
            "button[aria-label*='next']",
            "button[aria-label*='Forward']",
            "[data-testid*='next']",
            "button:has-text('Next')",
            "button:has-text('Continue')",
            "button:has-text('View next')",
            ".docsend-viewer-next",
            ".react-pdf__Page ~ button",
            ".pagination-next",
            "button[title*='Next']",
            "[class*='next']",
        ]
        email_defaults = [
            "input[type='email']",
            "input[name='email']",
            "input[id*='email']",
            "input[placeholder*='email' i]",
        ]
        gate_submit_defaults = [
            "button[type='submit']",
            "button:has-text('View')",
            "button:has-text('Continue')",
            "button:has-text('Access')",
            "button:has-text('Submit')",
            "button:has-text('Enter')",
            "input[type='submit']",
        ]
        cookie_dismiss_defaults = [
            "button:has-text('Accept all')",
            "button:has-text('Accept All')",
            "button:has-text('Accept cookies')",
            "button:has-text('Accept')",
            "button:has-text('Agree')",
            "button:has-text('I agree')",
            "button:has-text('Got it')",
            "button:has-text('OK')",
            "button:has-text('Close')",
            "[id*='cookie'] button",
            "[class*='cookie'] button",
            "[id*='consent'] button",
            "[class*='consent'] button",
            "[aria-label*='cookie' i]",
            "[aria-label*='consent' i]",
        ]

        if not self.enabled:
            return AgentPlan(
                next_selector_candidates=next_defaults,
                email_selector_candidates=email_defaults,
                gate_submit_selector_candidates=gate_submit_defaults,
                cookie_dismiss_selector_candidates=cookie_dismiss_defaults,
            )

        try:
            assistant = AssistantAgent(
                name="planner",
                llm_config={
                    "config_list": [{"model": os.getenv("AG2_MODEL", "gpt-4o-mini")}],
                },
                system_message=(
                    "You plan browser navigation on DocSend-like viewers. "
                    "Return strict JSON with keys: "
                    "next_selector_candidates, email_selector_candidates, gate_submit_selector_candidates, cookie_dismiss_selector_candidates. "
                    "Each key must map to an array of CSS selectors."
                ),
            )
            user = UserProxyAgent(name="user", human_input_mode="NEVER", code_execution_config=False)
            prompt = (
                "Given this limited page HTML, return likely selectors for the next-slide button, "
                "email gate, submit gate, and cookie/consent banner dismiss button. "
                f"HTML:\n{html_hint[:4000]}"
            )
            msg = user.initiate_chat(assistant, message=prompt, max_turns=1)
            content = (msg.chat_history[-1].get("content") if msg and msg.chat_history else "") or ""
            parsed = json.loads(content) if isinstance(content, str) and content.strip().startswith("{") else {}
            return AgentPlan(
                next_selector_candidates=[s for s in parsed.get("next_selector_candidates") or [] if isinstance(s, str)] or next_defaults,
                email_selector_candidates=[s for s in parsed.get("email_selector_candidates") or [] if isinstance(s, str)] or email_defaults,
                gate_submit_selector_candidates=[s for s in parsed.get("gate_submit_selector_candidates") or [] if isinstance(s, str)] or gate_submit_defaults,
                cookie_dismiss_selector_candidates=[s for s in parsed.get("cookie_dismiss_selector_candidates") or [] if isinstance(s, str)] or cookie_dismiss_defaults,
            )
        except Exception:
            return AgentPlan(
                next_selector_candidates=next_defaults,
                email_selector_candidates=email_defaults,
                gate_submit_selector_candidates=gate_submit_defaults,
                cookie_dismiss_selector_candidates=cookie_dismiss_defaults,
            )


class DocsendWebAgent:
    def __init__(self, max_pages: int = 20) -> None:
        self.max_pages = max_pages
        self.planner = AG2Planner()

    async def _get_plan(self, page: Page) -> AgentPlan:
        return self.planner.get_plan(await page.content())

    async def _click_next(self, page: Page) -> bool:
        plan = await self._get_plan(page)
        for selector in plan.next_selector_candidates:
            loc = page.locator(selector).first
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(timeout=2000, force=True)
                return True
        for key in ("ArrowRight", "PageDown", "Space"):
            try:
                await page.keyboard.press(key)
                return True
            except Exception:
                continue
        return False

    async def _dismiss_cookie_banner(self, page: Page) -> None:
        plan = await self._get_plan(page)
        for selector in plan.cookie_dismiss_selector_candidates:
            loc = page.locator(selector).first
            try:
                if await loc.count() > 0 and await loc.is_visible():
                    await loc.click(timeout=2000, force=True)
                    logger.info("Dismissed cookie banner via selector: %s", selector)
                    await page.wait_for_timeout(1000)
                    return
            except Exception:
                continue

    async def _submit_gate_if_present(self, page: Page, gate_email: Optional[str]) -> None:
        email_value = gate_email or os.getenv("DOC_VIEWER_GATE_EMAIL") or os.getenv("CAPTURE_GATE_EMAIL")
        plan = await self._get_plan(page)
        if email_value:
            for selector in plan.email_selector_candidates:
                loc = page.locator(selector).first
                if await loc.count() > 0 and await loc.is_visible():
                    await loc.fill(email_value)
                    logger.info("Filled email gate via selector: %s", selector)
                    break
        for selector in plan.gate_submit_selector_candidates:
            loc = page.locator(selector).first
            if await loc.count() > 0 and await loc.is_visible():
                try:
                    await loc.click(timeout=2000, force=True)
                    logger.info("Submitted gate via selector: %s", selector)
                    await page.wait_for_timeout(2500)
                    return
                except Exception:
                    continue

    async def _wait_for_viewer_ready(self, page: Page, gate_email: Optional[str]) -> None:
        await page.wait_for_timeout(3000)
        await self._dismiss_cookie_banner(page)
        await self._submit_gate_if_present(page, gate_email)
        await page.wait_for_timeout(2000)

    async def capture(self, url: str, gate_email: Optional[str] = None, progress_queue: Optional[asyncio.Queue] = None) -> Dict[str, Any]:
        screenshots: List[Dict[str, Any]] = []
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
            await self._wait_for_viewer_ready(page, gate_email)

            title = await page.title()
            previous_fingerprint: Optional[str] = None
            stale_steps = 0

            for i in range(1, self.max_pages + 1):
                logger.info("Capturing page %d", i)
                if progress_queue is not None:
                    await progress_queue.put({"event": "page", "page": i})
                await page.wait_for_timeout(1800)

                image_bytes = await page.screenshot(full_page=True, type="png")
                image_bytes = _crop_whitespace(image_bytes)
                fingerprint = hashlib.sha256(image_bytes).hexdigest()
                data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("utf-8")
                screenshots.append({"page": i, "data_url": data_url})

                if previous_fingerprint and fingerprint == previous_fingerprint:
                    stale_steps += 1
                else:
                    stale_steps = 0
                previous_fingerprint = fingerprint

                if i < self.max_pages:
                    progressed = await self._click_next(page)
                    if not progressed or stale_steps >= 2:
                        logger.info("Stopping capture at page %d (progressed=%s, stale_steps=%d)", i, progressed, stale_steps)
                        break

            await context.close()
            await browser.close()

        logger.info("Capture complete: %d pages", len(screenshots))
        pdf_base64 = build_pdf_base64(screenshots)
        result = {
            "title": title,
            "page_count": len(screenshots),
            "screenshots": screenshots,
            "pdf_base64": pdf_base64,
        }

        if progress_queue is not None:
            await progress_queue.put({"event": "done", **result})

        return result


def _crop_whitespace(image_bytes: bytes, threshold: int = 240) -> bytes:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    bg = Image.new("RGB", image.size, image.getpixel((0, 0)))
    diff = Image.fromarray(
        np.abs(np.array(image, dtype=int) - np.array(bg, dtype=int)).astype("uint8")
    )
    mask = diff.convert("L").point(lambda p: 255 if p > (255 - threshold) else 0)
    bbox = mask.getbbox()
    if bbox:
        image = image.crop(bbox)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def build_pdf_base64(screenshots: List[Dict[str, Any]]) -> str:
    buffer = io.BytesIO()
    pdf = None
    for shot in screenshots:
        data_url = shot.get("data_url", "")
        if not isinstance(data_url, str) or "," not in data_url:
            continue
        img_bytes = base64.b64decode(data_url.split(",", 1)[1])
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        w, h = image.size
        if pdf is None:
            pdf = canvas.Canvas(buffer, pagesize=(w, h))
        else:
            pdf.setPageSize((w, h))
        image_stream = io.BytesIO()
        image.save(image_stream, format="JPEG", quality=90)
        image_stream.seek(0)
        pdf.drawImage(ImageReader(image_stream), 0, 0, w, h)
        pdf.showPage()
    if pdf is None:
        pdf = canvas.Canvas(buffer)
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
        result = await agent.capture(str(req.url), gate_email=req.gate_email)
        return CaptureResponse(**result)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Capture failed: {exc}") from exc


@app.post("/capture/stream", dependencies=[Security(verify_api_key)])
async def capture_docsend_stream(req: CaptureRequest) -> StreamingResponse:
    queue: asyncio.Queue = asyncio.Queue()

    async def run():
        try:
            agent = DocsendWebAgent(max_pages=req.max_pages)
            await agent.capture(str(req.url), gate_email=req.gate_email, progress_queue=queue)
        except Exception as exc:
            await queue.put({"event": "error", "detail": str(exc)})

    async def event_stream():
        task = asyncio.create_task(run())
        while True:
            msg = await queue.get()
            yield f"data: {json.dumps(msg)}\n\n"
            if msg["event"] in ("done", "error"):
                break
        await task

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")), reload=False)
