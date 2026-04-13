import base64
import json
import os
import streamlit as st
import requests

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8080")
SERVICE_API_KEY = os.getenv("SERVICE_API_KEY", "")

st.set_page_config(page_title="DocSend Capture Agent", layout="wide")

st.title("DocSend Capture Agent")

url_input = st.text_input("Enter DocSend / PandaDoc URL:", key="url_input")


def capture(url, max_pages=100):
    status_area = st.empty()
    result_data = None

    with requests.post(
        f"{BACKEND_URL}/capture/stream",
        json={"url": url, "max_pages": max_pages},
        headers={"X-API-Key": SERVICE_API_KEY},
        stream=True,
        timeout=600,
    ) as resp:
        if resp.status_code != 200:
            return {"error": f"Request failed: {resp.status_code} {resp.text}"}

        buf = ""
        for chunk in resp.iter_content(chunk_size=None):
            buf += chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.rstrip("\r")
                if not line.startswith("data: "):
                    continue
                msg = json.loads(line[6:])
            if msg["event"] == "page":
                status_area.info(f"📸 Capturing page {msg['page']}...")
            elif msg["event"] == "done":
                status_area.success(f"✅ Captured {msg['page_count']} pages")
                result_data = {k: v for k, v in msg.items() if k != "event"}
            elif msg["event"] == "error":
                status_area.error(f"❌ {msg['detail']}")
                return {"error": msg["detail"]}

    return result_data or {"error": "No result received"}


if st.button("Capture"):
    if url_input:
        loading = st.empty()
        loading.subheader("🌐 Capturing...")

        result = capture(url_input, 100)
        loading.empty()

        if "error" in result:
            st.error(result["error"])
        else:
            st.subheader(f"📄 {result.get('title', 'Untitled')} — {result['page_count']} pages")

            st.subheader("📝 Extracted Text")
            st.code(result.get("markdown", ""), language="markdown", height=400)

            pdf_b64 = result.get("pdf_base64", "")
            if pdf_b64:
                pdf_bytes = base64.b64decode(pdf_b64)
                st.download_button(
                    label="⬇️ Download PDF",
                    data=pdf_bytes,
                    file_name="capture.pdf",
                    mime="application/pdf",
                )

            screenshots = result.get("screenshots", [])
            if screenshots:
                st.subheader("🖼️ Screenshots")
                cols = st.columns(3)
                for i, shot in enumerate(screenshots):
                    img_bytes = base64.b64decode(shot["data_url"].split(",", 1)[1])
                    cols[i % 3].image(img_bytes, caption=f"Page {shot['page']}")
    else:
        st.warning("Please enter a URL.")
