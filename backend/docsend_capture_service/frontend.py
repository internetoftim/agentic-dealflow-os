import base64
import os
import streamlit as st
import requests

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8080")

st.set_page_config(page_title="DocSend Capture Agent", layout="wide")

if "authenticated" not in st.session_state:
    st.session_state.authenticated = False

if not st.session_state.authenticated:
    pwd = st.text_input("Password", type="password")
    if st.button("Login"):
        if pwd == os.getenv("APP_PASSWORD", "hackmenow"):
            st.session_state.authenticated = True
            st.rerun()
        else:
            st.error("Incorrect password")
    st.stop()

st.title("DocSend Capture Agent")

url_input = st.text_input("Enter DocSend / PandaDoc URL:", key="url_input")


def capture(url, max_pages=100):
    response = requests.post(
        f"{BACKEND_URL}/capture",
        json={"url": url, "max_pages": max_pages},
    )
    if response.status_code == 200:
        return response.json()
    return {"error": f"Request failed: {response.status_code} {response.text}"}


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
                    cols[i % 3].image(shot["data_url"], caption=f"Page {shot['page']}")
    else:
        st.warning("Please enter a URL.")
