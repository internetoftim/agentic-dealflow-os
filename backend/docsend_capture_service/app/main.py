"""
Multi-agent backend for Agentic Deal Flow OS. 

Agents:
  OrchestratorAgent  — routes tasks, coordinates swarm
  BrowserAgent       — DocSend/web capture via AG2 BrowserUseTool
  ResearchAgent      — deep company research (Crunchbase, LinkedIn, website)
  MemoAgent          — investment memo generation

Endpoints:
  GET  /health
  POST /capture        — capture DocSend/PandaDoc/Papermark via browser agent
  POST /capture-async  — async capture with callback
  POST /research       — deep company research via browser agent
  POST /memo           — generate investment memo
"""

import asyncio
import base64
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

from fastapi import BackgroundTasks, FastAPI, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, HttpUrl, Field

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as pdf_canvas

import autogen
from autogen import AssistantAgent, UserProxyAgent, LLMConfig
from autogen.tools.experimental import BrowserUseTool

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# LLM config
# ---------------------------------------------------------------------------

def _llm_config() -> dict[str, Any]:
    return {
        "config_list": [{
            "api_type": "openai",
            "model": os.getenv("AG2_MODEL", "gpt-4o-mini"),
            "api_key": os.getenv("OPENAI_API_KEY"),
        }],
        "temperature": 0,
    }

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

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
    screenshots: list[ScreenshotItem]
    pdf_base64: str

class ResearchRequest(BaseModel):
    company_name: str
    sector: Optional[str] = None
    stage: Optional[str] = None
    website: Optional[str] = None

class ResearchResponse(BaseModel):
    website: Optional[str]
    linkedin_url: Optional[str]
    crunchbase_url: Optional[str]
    funding_total: Optional[str]
    last_funding_round: Optional[str]
    num_employees: Optional[str]
    investors: Optional[str]
    people: list[dict[str, Any]]
    summary: str

class MemoRequest(BaseModel):
    deal_id: str
    company_name: str
    sector: Optional[str] = None
    stage: Optional[str] = None
    ask_amount: Optional[str] = None
    valuation: Optional[str] = None
    revenue: Optional[str] = None
    growth: Optional[str] = None
    website: Optional[str] = None
    linkedin_url: Optional[str] = None
    deck_text: Optional[str] = None
    research_summary: Optional[str] = None

class MemoResponse(BaseModel):
    memo: str

# ---------------------------------------------------------------------------
# Browser agent swarm
# ---------------------------------------------------------------------------

class DealFlowAgentSwarm:
    """
    Multi-agent swarm for deal flow processing.

    Agents:
      - orchestrator: routes tasks, synthesizes results
      - browser_agent: executes browser tasks via BrowserUseTool
      - research_agent: structures and interprets research findings
      - memo_agent: writes investment memos
    """

    def __init__(self) -> None:
        self.llm_cfg = _llm_config()
        self.browser_tool = BrowserUseTool(
            llm_config=self.llm_cfg,
            browser_config={"headless": True},
        )

    def _make_agents(self) -> tuple[UserProxyAgent, AssistantAgent, AssistantAgent, AssistantAgent]:
        user_proxy = UserProxyAgent(
            name="user_proxy",
            human_input_mode="NEVER",
            code_execution_config=False,
            max_consecutive_auto_reply=1,
        )

        browser_agent = AssistantAgent(
            name="BrowserAgent",
            llm_config=self.llm_cfg,
            system_message=(
                "You are a browser agent. You use the browser_use tool to navigate websites, "
                "capture document viewers (DocSend, PandaDoc, Papermark), scrape company websites, "
                "and extract structured information. Always return the raw extracted content."
            ),
        )

        research_agent = AssistantAgent(
            name="ResearchAgent",
            llm_config=self.llm_cfg,
            system_message=(
                "You are a VC research analyst. Given raw browser-extracted content, "
                "extract and structure: official website, LinkedIn URL, Crunchbase URL, "
                "total funding, last funding round, employee count, investors, and key people "
                "(name, title, LinkedIn). Return a JSON object with these fields. "
                "Only include fields you are confident about."
            ),
        )

        memo_agent = AssistantAgent(
            name="MemoAgent",
            llm_config=self.llm_cfg,
            system_message=(
                "You are a senior VC analyst. Write concise, data-driven investment memos with sections: "
                "Executive Summary, Market Opportunity, Product & Traction, Team, Business Model, "
                "Competition, Risks & Concerns, Investment Thesis, Recommendation. "
                "Use bullet points. Flag missing information."
            ),
        )

        self.browser_tool.register_for_execution(user_proxy)
        self.browser_tool.register_for_llm(browser_agent)

        return user_proxy, browser_agent, research_agent, memo_agent

    async def capture_document(self, url: str, max_pages: int = 20) -> dict[str, Any]:
        """Use browser agent to capture a DocSend/PandaDoc/Papermark document."""
        user_proxy, browser_agent, _, _ = self._make_agents()

        task = (
            f"Capture the document at {url}. "
            f"1. Navigate to the URL. "
            f"2. If there is an email gate, fill it with 'tim@onepointsix.ai' and submit. "
            f"3. Extract the text content of each page/slide (up to {max_pages} pages). "
            f"4. Navigate to the next page using the Next button or ArrowRight key after each page. "
            f"5. Return all extracted text concatenated with page markers like '## Page N'."
        )

        logger.info("BrowserAgent capturing: %s", url)
        chat_result = await asyncio.to_thread(
            user_proxy.initiate_chat,
            browser_agent,
            message=task,
            max_turns=6,
        )

        # Extract content from chat history
        content = ""
        for msg in chat_result.chat_history:
            if msg.get("role") == "tool" or msg.get("name") == "BrowserAgent":
                content += msg.get("content", "") + "\n"

        # Build response — screenshots not available in text mode, return empty list
        pages = [p.strip() for p in content.split("## Page") if p.strip()]
        markdown = "\n\n".join(f"## Page {i+1}\n\n{p}" for i, p in enumerate(pages)) if pages else content
        page_count = max(len(pages), 1)

        return {
            "title": f"Document from {url}",
            "page_count": page_count,
            "markdown": markdown,
            "screenshots": [],
            "pdf_base64": _build_text_pdf_base64(markdown),
        }

    async def research_company(
        self,
        company_name: str,
        sector: Optional[str] = None,
        stage: Optional[str] = None,
        website: Optional[str] = None,
    ) -> dict[str, Any]:
        """Use browser + research agents to deeply research a company."""
        user_proxy, browser_agent, research_agent, _ = self._make_agents()

        sector_hint = f" ({sector})" if sector else ""
        website_hint = f" Website: {website}." if website else ""

        browse_task = (
            f"Research the company '{company_name}'{sector_hint}.{website_hint} "
            f"1. Search the web for '{company_name} startup official website LinkedIn'. "
            f"2. Find and visit their official website and extract key info. "
            f"3. Search for '{company_name} crunchbase' and extract funding data. "
            f"4. Search for '{company_name} founders CEO LinkedIn' and extract key people. "
            f"Return all raw extracted content."
        )

        logger.info("BrowserAgent researching: %s", company_name)
        browse_result = await asyncio.to_thread(
            user_proxy.initiate_chat,
            browser_agent,
            message=browse_task,
            max_turns=8,
        )

        raw_content = "\n".join(
            msg.get("content", "")
            for msg in browse_result.chat_history
            if msg.get("content")
        )

        # Research agent structures the raw content
        structure_task = (
            f"Given this raw research content about '{company_name}', extract structured data:\n\n"
            f"{raw_content[:8000]}\n\n"
            f"Return a JSON object with: website, linkedin_url, crunchbase_url, funding_total, "
            f"last_funding_round, num_employees, investors, people (array of {{name, title, linkedin_url}}), "
            f"summary (2-3 sentence company overview). Use null for missing fields."
        )

        structure_result = await asyncio.to_thread(
            user_proxy.initiate_chat,
            research_agent,
            message=structure_task,
            max_turns=2,
        )

        # Parse JSON from research agent response
        import json, re
        structured: dict[str, Any] = {}
        for msg in reversed(structure_result.chat_history):
            content = msg.get("content", "")
            json_match = re.search(r"\{[\s\S]+\}", content)
            if json_match:
                try:
                    structured = json.loads(json_match.group())
                    break
                except json.JSONDecodeError:
                    continue

        return {
            "website": structured.get("website"),
            "linkedin_url": structured.get("linkedin_url"),
            "crunchbase_url": structured.get("crunchbase_url"),
            "funding_total": structured.get("funding_total"),
            "last_funding_round": structured.get("last_funding_round"),
            "num_employees": structured.get("num_employees"),
            "investors": structured.get("investors"),
            "people": structured.get("people", []),
            "summary": structured.get("summary", ""),
        }

    async def generate_memo(self, req: MemoRequest) -> str:
        """Use memo agent to generate an investment memo."""
        _, _, _, memo_agent = self._make_agents()
        user_proxy = UserProxyAgent(
            name="user_proxy",
            human_input_mode="NEVER",
            code_execution_config=False,
            max_consecutive_auto_reply=1,
        )

        context = f"""
Company: {req.company_name}
Stage: {req.stage or 'Unknown'}
Sector: {req.sector or 'Unknown'}
Ask Amount: {req.ask_amount or 'Unknown'}
Valuation: {req.valuation or 'Unknown'}
Revenue: {req.revenue or 'Unknown'}
Growth: {req.growth or 'Unknown'}
Website: {req.website or 'Unknown'}
LinkedIn: {req.linkedin_url or 'Unknown'}

Research Summary:
{req.research_summary or 'No research available.'}

Deck Content:
{(req.deck_text or 'No deck content available.')[:20000]}
"""

        result = await asyncio.to_thread(
            user_proxy.initiate_chat,
            memo_agent,
            message=f"Write an investment memo for this deal:\n{context}",
            max_turns=2,
        )

        for msg in reversed(result.chat_history):
            content = msg.get("content", "")
            if content and len(content) > 200 and msg.get("name") == "MemoAgent":
                return content

        return result.chat_history[-1].get("content", "Memo generation failed.")


# ---------------------------------------------------------------------------
# PDF helpers
# ---------------------------------------------------------------------------

def _build_text_pdf_base64(text: str) -> str:
    """Build a simple text PDF from markdown content."""
    buffer = io.BytesIO()
    c = pdf_canvas.Canvas(buffer, pagesize=letter)
    width, height = letter
    margin, y, line_height = 50, height - 50, 14

    for line in text.splitlines():
        if y < margin + line_height:
            c.showPage()
            y = height - margin
        c.drawString(margin, y, line[:100])
        y -= line_height

    c.save()
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def build_pdf_base64(screenshots: list[dict[str, Any]]) -> str:
    buffer = io.BytesIO()
    c = pdf_canvas.Canvas(buffer, pagesize=letter)
    for shot in screenshots:
        data_url = shot.get("data_url", "")
        if not isinstance(data_url, str) or "," not in data_url:
            continue
        raw_b64 = data_url.split(",", 1)[1]
        img_bytes = base64.b64decode(raw_b64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        w, h = image.size
        pw, ph = letter
        scale = min(pw / w, ph / h)
        dw, dh = w * scale, h * scale
        x, y = (pw - dw) / 2, (ph - dh) / 2
        img_stream = io.BytesIO()
        image.save(img_stream, format="JPEG", quality=90)
        img_stream.seek(0)
        c.drawInlineImage(Image.open(img_stream), x, y, dw, dh)
        c.showPage()
    c.save()
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

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


app = FastAPI(title="Deal Flow Agent Service", version="2.0.0", lifespan=lifespan)
_swarm = DealFlowAgentSwarm()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/capture", response_model=CaptureResponse, dependencies=[Security(verify_api_key)])
async def capture_docsend(req: CaptureRequest) -> CaptureResponse:
    try:
        result = await _swarm.capture_document(str(req.url), req.max_pages)
        return CaptureResponse(**result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Capture failed: {exc}") from exc


async def _run_capture_and_callback(req: CaptureAsyncRequest) -> None:
    import httpx
    payload: dict[str, Any] = {
        "job_id": req.job_id,
        "deal_id": req.deal_id,
        "user_id": req.user_id,
        "service_role_key": req.service_role_key,
    }
    try:
        result = await _swarm.capture_document(str(req.url), req.max_pages)
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
async def capture_docsend_async(
    req: CaptureAsyncRequest, background_tasks: BackgroundTasks
) -> dict[str, str]:
    background_tasks.add_task(_run_capture_and_callback, req)
    logger.info("Queued async capture for job %s (deal %s)", req.job_id, req.deal_id)
    return {"status": "accepted", "job_id": req.job_id}


@app.post("/research", response_model=ResearchResponse, dependencies=[Security(verify_api_key)])
async def research_company(req: ResearchRequest) -> ResearchResponse:
    try:
        result = await _swarm.research_company(
            company_name=req.company_name,
            sector=req.sector,
            stage=req.stage,
            website=req.website,
        )
        return ResearchResponse(**result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Research failed: {exc}") from exc


@app.post("/memo", response_model=MemoResponse, dependencies=[Security(verify_api_key)])
async def generate_memo(req: MemoRequest) -> MemoResponse:
    try:
        memo = await _swarm.generate_memo(req)
        return MemoResponse(memo=memo)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Memo generation failed: {exc}") from exc


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")), reload=False)
