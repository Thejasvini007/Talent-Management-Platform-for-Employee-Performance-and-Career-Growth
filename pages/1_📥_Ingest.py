import streamlit as st
from pathlib import Path

from rag.theme import inject_theme
from rag.sidebar import render_sidebar
from rag.auth import require_login

st.set_page_config(
    page_title="Document Ingestion",
    page_icon="📄",
    layout="wide"
)

inject_theme()
require_login()
render_sidebar()

st.title("📄 Document Ingestion")
st.caption("Upload and index knowledge documents for AI-powered search.")

st.markdown("---")

# Upload Card
with st.container(border=True):
    st.subheader("Upload Knowledge Documents")

    uploaded_files = st.file_uploader(
        "Drag and drop PDF files here",
        type=["pdf"],
        accept_multiple_files=True
    )

    col1, col2 = st.columns([1, 5])

    with col1:
        build = st.button(
            "🔨 Build Index",
            use_container_width=True
        )

    with col2:
        if uploaded_files:
            st.success(f"{len(uploaded_files)} file(s) selected.")

if build:
    docs_folder = Path("data/docs")
    docs_folder.mkdir(parents=True, exist_ok=True)

    if uploaded_files:
        for file in uploaded_files:
            with open(docs_folder / file.name, "wb") as f:
                f.write(file.getbuffer())

        st.success("✅ Documents uploaded successfully!")

        with st.spinner("Building search index..."):
            from ingestion.ingest import ingest
            ingest()

        st.success("✅ Knowledge base indexed successfully!")

    else:
        st.warning("Please upload at least one PDF.")

from db.connection import get_db
import os

# -----------------------------
# Load Statistics
# -----------------------------
conn = get_db()

doc_count = conn.execute(
    "SELECT COUNT(*) FROM documents"
).fetchone()[0]

chunk_count = conn.execute(
    "SELECT COUNT(*) FROM chunks"
).fetchone()[0]

docs = conn.execute("""
SELECT
id,
title,
source_path,
indexed_at
FROM documents
ORDER BY indexed_at DESC
""").fetchall()

conn.close()

storage_size = 0
docs_folder = Path("data/docs")

if docs_folder.exists():
    for file in docs_folder.iterdir():
        if file.is_file():
            storage_size += file.stat().st_size

storage_mb = round(storage_size / (1024 * 1024), 2)

st.markdown("## 📊 Overview")

c1, c2, c3 = st.columns(3)

with c1:
    st.metric(
        "📄 Documents",
        doc_count
    )

with c2:
    st.metric(
        "🧩 Total Chunks",
        chunk_count
    )

with c3:
    st.metric(
        "💾 Storage",
        f"{storage_mb} MB"
    )

st.divider()

st.subheader("📚 Indexed Documents")

search = st.text_input(
    "🔍 Search document",
    placeholder="Search by document name..."
)

filtered_docs = []

for d in docs:
    if search.lower() in d["title"].lower():
        filtered_docs.append(d)

if not filtered_docs:
    st.info("No documents found.")

else:

    header = st.table(filtered_docs)

# -----------------------------
# Document Preview
# -----------------------------
from db.connection import get_db
from pathlib import Path
import os

if "selected_doc" in st.session_state:

    conn = get_db()

    document = conn.execute(
        """
        SELECT id,title,summary,source_path,indexed_at
        FROM documents
        WHERE id=?
        """,
        (st.session_state["selected_doc"],)
    ).fetchone()

    chunks = conn.execute(
        """
        SELECT chunk_index,chunk_text
        FROM chunks
        WHERE document_id=?
        ORDER BY chunk_index
        """,
        (document["id"],)
    ).fetchall()

    chunk_count = len(chunks)

    conn.close()

    file_size = "N/A"

    if document["source_path"] and os.path.exists(document["source_path"]):
        size = os.path.getsize(document["source_path"])
        file_size = f"{round(size/1024,2)} KB"

    st.divider()

    st.subheader("📄 Document Preview")

    info1, info2, info3 = st.columns(3)

    info1.metric("🧩 Chunks", chunk_count)
    info2.metric("💾 Size", file_size)