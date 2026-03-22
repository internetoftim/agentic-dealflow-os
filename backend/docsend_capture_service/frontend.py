import base64
import streamlit as st
import requests

st.set_page_config(page_title="DocSend Capture Agent", layout="wide")

st.title("DocSend Capture Agent")

url_input = st.text_input("Enter DocSend / PandaDoc URL:", key="url_input")
max_pages = st.slider("Max pages", min_value=1, max_value=100, value=20)


def capture(url, max_pages):
    response = requests.post(
        "http://127.0.0.1:8080/capture",
        json={"url": url, "max_pages": max_pages},
    )
    if response.status_code == 200:
        return response.json()
    return {"error": f"Request failed: {response.status_code} {response.text}"}


if st.button("Capture"):
    if url_input:
        loading = st.empty()
        loading.subheader("🌐 Capturing...")

        result = capture(url_input, max_pages)
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
