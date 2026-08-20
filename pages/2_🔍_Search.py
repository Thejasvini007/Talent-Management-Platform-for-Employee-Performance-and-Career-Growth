"""Knowledge Search — direct semantic search over the document index.

Unlike the AI Assistant, this page shows exactly which chunks the retriever
chooses, with scores, so users can verify the source.
"""
import streamlit as st

from rag.theme import inject_theme
from rag.sidebar import render_sidebar
from rag.auth import require_login
from rag.retriever import Retriever

inject_theme()
render_sidebar()
require_login()
st.set_page_config(page_title="Knowledge Search · Talent Sphere", page_icon="🔍")

st.title("🔍 Knowledge Search")
st.caption("Direct semantic search over the document index — see exactly what the AI retrieves.")

query = st.text_input(
    "Search query",
    placeholder='e.g. "purpose of GS1 Supply Chain Visibility White Paper"',
)
top_k = st.slider("Top-K chunks", 1, 10, 5)

if not query.strip():
    st.info("Type a query above to search the knowledge base.")
    st.stop()

results = Retriever().search(query, top_k=top_k)
if not results:
    st.warning("No matching chunks found. Try ingesting more documents first.")
    st.stop()

st.subheader(f"🎯 Top {len(results)} results for: *“{query}”*")
seen_docs: set[int] = set()
for rank, (score, meta, text) in enumerate(results, 1):
    seen_docs.add(meta["document_id"])
    with st.container(border=True):
        st.markdown(
            f"**#{rank} · {meta['document_title']}** · "
            f"`chunk#{meta['chunk_id']}` · **score {score:.3f}**"
        )
        st.write(text)
        st.caption(meta["preview"] + "…")

st.success(f"Searched across {len(seen_docs)} document(s).")