"""MCP server for the DocSend Capture Service.

Exposes the /capture endpoint as an MCP tool so LLMs can capture DocSend
(and similar) documents via the running API.

Configuration (env vars):
  DOCSEND_API_URL      Base URL of the capture service  (default: http://localhost:8080)
  SERVICE_API_KEY      API key for the capture service
"""

import os
import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("docsend-capture", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))

_BASE_URL = os.getenv("DOCSEND_API_URL", "http://localhost:8080")
_API_KEY = os.getenv("SERVICE_API_KEY", "")


def _headers() -> dict:
    return {"X-API-Key": _API_KEY, "Content-Type": "application/json"}


@mcp.tool()
async def capture_docsend(
    url: str,
    max_pages: int = 20,
    gate_email: str | None = None,
) -> dict:
    """Capture all slides/pages from a DocSend (or similar) document URL.

    Returns the document title, page count, a base64-encoded PDF, and
    base64 PNG screenshots for each page.

    Args:
        url: The DocSend (or compatible viewer) URL to capture.
        max_pages: Maximum number of pages to capture (1-100, default 20).
        gate_email: Optional email address to submit if the document is gated.
    """
    payload = {"url": url, "max_pages": max_pages}
    if gate_email:
        payload["gate_email"] = gate_email

    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(
            f"{_BASE_URL}/capture",
            json=payload,
            headers=_headers(),
        )
        response.raise_for_status()
        data = response.json()

    # Drop raw screenshot data_urls from the tool response — they're huge and
    # not useful as text. Return metadata + pdf_base64 only.
    return {
        "title": data.get("title"),
        "page_count": data.get("page_count"),
        "pdf_base64": data.get("pdf_base64"),
    }


@mcp.tool()
async def health_check() -> dict:
    """Check whether the DocSend Capture Service is reachable and healthy."""
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(f"{_BASE_URL}/health")
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    # FastMCP reads HOST/PORT from env automatically.
    # Set MCP_TRANSPORT=sse for Cloud Run, defaults to stdio for local clients.
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    mcp.run(transport=transport)
