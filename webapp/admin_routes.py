"""Admin: dashboard analytics, users, document ingestion, exams, announcements."""

from __future__ import annotations

import secrets
import string
from pathlib import Path

from flask import (
    Blueprint,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)

from src import db
from src.auth import hash_password
from src.config import DOCUMENTS_DIR, PROJECT_ROOT
from src.email_service import send_welcome_email
from src.ingest import chunk_pages, extract_pages, file_hash
from src.llm import generate_exam_questions, generate_voice_exam_questions, llm_available
from webapp.security import admin_required

bp = Blueprint("admin", __name__, url_prefix="/admin")

DOMAINS = ["general", "finacle", "fullstack", "datascience"]


def _generate_password(length: int = 10) -> str:
    alphabet = string.ascii_letters + string.digits + "@#$%"
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------


@bp.route("/")
@admin_required
def dashboard():
    summary = db.analytics_summary()
    activity = sorted(db.messages_per_day(30), key=lambda r: r["day"])
    scores = [r["pct"] for r in db.score_distribution() if r["pct"] is not None]
    funnel = db.completion_totals()
    return render_template(
        "dashboard_admin.html",
        summary=summary,
        activity=activity,
        scores=scores,
        funnel=funnel,
        learners=db.users_with_progress()[:8],
    )


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
@bp.route("/users")
@admin_required
def users():
    return render_template(
        "admin_users.html",
        users=db.list_users(role="user"),
        domains=DOMAINS
    )

@bp.route("/users/create", methods=["POST"])
@admin_required
def users_create():
    emp_id = (request.form.get("emp_id") or "").strip()
    name = (request.form.get("name") or "").strip()
    email = (request.form.get("email") or "").strip()
    domain = request.form.get("domain") or "general"
    manual_pw = request.form.get("password") or ""

    if not (emp_id and name and email and "@" in email):
        flash("Please fill Employee ID, name, and a valid email.", "warn")
        return redirect(url_for("admin.users"))

    if manual_pw and len(manual_pw) < 8:
        flash("Manual password must be at least 8 characters.", "warn")
        return redirect(url_for("admin.users"))

    # Use admin-entered password or generate one automatically
    password = manual_pw or _generate_password()

    # Store only the HASHED password in the database
    ok, message = db.create_user(
        emp_id=emp_id,
        name=name,
        email=email,
        password_hash=hash_password(password),
        role="user",
        domain=domain,
    )

    if ok:
        # Change this to the actual URL of your Talent Sphere login page.
        login_url = "http://127.0.0.1:5000/login"

        try:
            send_welcome_email(
                recipient_email=email.lower(),
                name=name,
                employee_id=emp_id,
                password=password,
                login_url=login_url,
            )

            flash(
                f"User created successfully and welcome email sent to {email}.",
                "ok",
            )

        except Exception as exc:
            # User was created, but email failed
            flash(
                f"User created, but the welcome email could not be sent: {exc}",
                "warn",
            )

    else:
        flash(message, "error")

    return redirect(url_for("admin.users"))


@bp.route("/users/<int:user_id>/reset-password", methods=["POST"])
@admin_required
def users_reset_password(user_id: int):
    target = db.get_user(user_id)
    if not target or target["role"] != "user":
        flash("User not found.", "error")
        return redirect(url_for("admin.users"))
    new_pw = _generate_password()
    db.update_user_password(user_id, hash_password(new_pw))
    flash(
        f"Password reset for {target['name']}. New password: {new_pw} "
        "— share now, it cannot be shown again.",
        "credentials",
    )
    return redirect(url_for("admin.users"))


@bp.route("/users/<int:user_id>/delete", methods=["POST"])
@admin_required
def users_delete(user_id: int):
    target = db.get_user(user_id)
    if target and target["role"] == "user":
        db.delete_user(user_id)
        flash(f"Deleted {target['name']} and all their data.", "ok")
    return redirect(url_for("admin.users"))


# ---------------------------------------------------------------------------
# Documents: ingest + dedup + reset
# ---------------------------------------------------------------------------


@bp.route("/documents")
@admin_required
def documents():
    from src.vectorstore import stats

    return render_template(
        "admin_documents.html", documents=db.list_documents(), index=stats()
    )


@bp.route("/documents/upload", methods=["POST"])
@admin_required
def documents_upload():
    from src.embeddings import embed_documents
    from src.vectorstore import add_chunks

    files = request.files.getlist("pdfs")
    docs_dir = Path(DOCUMENTS_DIR)
    if not docs_dir.is_absolute():
        docs_dir = Path(PROJECT_ROOT) / docs_dir
    docs_dir = docs_dir.resolve()
    docs_dir.mkdir(parents=True, exist_ok=True)

    processed, added_total, duplicates, failures = 0, 0, [], []
    for file in files:
        if not file or not file.filename:
            continue
        try:
            data = file.read()
            digest = file_hash(data)
            existing = db.document_by_hash(digest)
            if existing:
                duplicates.append(
                    f"{file.filename} is already indexed (uploaded as "
                    f"{existing['filename']} on {existing['uploaded_at'][:10]})"
                )
                continue
            import io

            pages = extract_pages(io.BytesIO(data))
            if not pages:
                failures.append(f"No extractable text in {file.filename}")
                continue
            chunks = chunk_pages(pages, file.filename)
            embeddings = embed_documents([c["text"] for c in chunks])
            added = add_chunks(chunks, embeddings, digest)

            saved_path = docs_dir / file.filename
            saved_path.write_bytes(data)
            db.add_document(
                filename=file.filename,
                file_hash=digest,
                pages=len(pages),
                chunks=added,
                size_kb=len(data) / 1024,
                file_path=str(saved_path),
                uploaded_by=g.user["email"],
            )
            processed += 1
            added_total += added
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{file.filename}: {exc}")

    if processed:
        flash(f"Ingested {processed} file(s) — {added_total} chunks added.", "ok")
    for message in duplicates:
        flash(f"⚠️ {message} — skipped.", "warn")
    for message in failures:
        flash(f"❌ {message}", "error")
    if not files:
        flash("Choose at least one PDF.", "warn")
    return redirect(url_for("admin.documents"))


@bp.route("/documents/reset", methods=["POST"])
@admin_required
def documents_reset():
    from src.vectorstore import reset_collection

    reset_collection()
    db.clear_documents()
    flash("Knowledge base cleared (stored PDF files kept on disk).", "ok")
    return redirect(url_for("admin.documents"))


# ---------------------------------------------------------------------------
# Exams: create (manual / AI), assign, results
# ---------------------------------------------------------------------------


@bp.route("/exams")
@admin_required
def exams():
    exam_list = db.list_exams()
    selected_id = request.args.get("exam", type=int)
    selected = next((e for e in exam_list if e["id"] == selected_id),
                    exam_list[0] if exam_list else None)
    assignments = db.assignments_for_exam(selected["id"]) if selected else []
    submission_id = request.args.get("submission", type=int)
    detail = db.get_submission_detail(submission_id) if submission_id else None
    return render_template(
        "admin_exams.html",
        exams=exam_list,
        selected=selected,
        assignments=assignments,
        users=db.list_users(role="user"),
        documents=db.list_documents(),
        llm_ready=llm_available(),
        detail=detail,
        detail_submission=submission_id,
    )


@bp.route("/exams/generate", methods=["POST"])
@admin_required
def exams_generate():
    payload = request.get_json(silent=True) or {}
    doc_ids = payload.get("doc_ids") or []
    count = min(int(payload.get("count") or 5), 15)
    marks = float(payload.get("marks") or 10)
    exam_type = str(payload.get("exam_type") or "write")

    wanted = {int(d) for d in doc_ids}
    parts = []
    for doc in db.list_documents():
        if doc["id"] not in wanted:
            continue
        path = db.resolve_document_path(doc)
        if not path:
            continue
        try:
            pages = extract_pages(str(path))
            parts.append(" ".join(p["text"] for p in pages[:8]))
        except Exception:  # noqa: BLE001
            continue
    material = "\n\n".join(parts)
    if not material.strip():
        return jsonify({"error": "Couldn't read any text from the selected documents."}), 400

    if exam_type == "voice":
        questions = generate_voice_exam_questions(material, count)
    else:
        questions = generate_exam_questions(material, count, marks=marks)
    if not questions:
        return jsonify({"error": "AI generation failed — try again or write manually."}), 502
    return jsonify({"questions": questions})


@bp.route("/exams/create", methods=["POST"])
@admin_required
def exams_create():
    title = (request.form.get("title") or "").strip()
    description = (request.form.get("description") or "").strip()
    duration = request.form.get("duration", type=int) or 30
    marks_each = request.form.get("marks", type=float) or 10.0
    exam_type = request.form.get("exam_type") or "write"
    questions_text = request.form.get("questions") or ""

    questions = [
        {"question": line.strip().lstrip("0123456789.)- "), "marks": marks_each}
        for line in questions_text.splitlines()
        if line.strip()
    ]
    if not title or not questions:
        flash("An exam needs a title and at least one question.", "warn")
        return redirect(url_for("admin.exams"))

    exam_id = db.create_exam(title, description, duration, g.user["email"], questions)
    if exam_type == "voice":
        with db.get_conn() as conn:
            conn.execute("UPDATE exams SET exam_type='voice' WHERE id = ?", (exam_id,))
    flash(f"Exam “{title}” created with {len(questions)} question(s).", "ok")
    return redirect(url_for("admin.exams", exam=exam_id))


@bp.route("/exams/<int:exam_id>/assign", methods=["POST"])
@admin_required
def exams_assign(exam_id: int):
    exam = db.get_exam(exam_id)
    if not exam:
        flash("Exam not found.", "error")
        return redirect(url_for("admin.exams"))
    user_ids = [int(u) for u in request.form.getlist("user_ids")]
    due = request.form.get("due_date") or None
    added = db.assign_exam(exam_id, user_ids, due)
    skipped = len(user_ids) - added
    if added:
        db.notify_users(
            user_ids,
            f"New exam assigned: {exam['title']}",
            f"Due {due or 'anytime'}. Open My Exams to start.",
            kind="exam",
            link="/exams",
        )
    flash(
        f"Assigned to {added} user(s)."
        + (f" {skipped} already had this exam — skipped." if skipped else ""),
        "ok" if added else "warn",
    )
    return redirect(url_for("admin.exams", exam=exam_id))


@bp.route("/exams/<int:exam_id>/delete", methods=["POST"])
@admin_required
def exams_delete(exam_id: int):
    db.delete_exam(exam_id)
    flash("Exam deleted.", "ok")
    return redirect(url_for("admin.exams"))


# ---------------------------------------------------------------------------
# Announcements
# ---------------------------------------------------------------------------

CATEGORIES = ["General", "Training", "Exam", "Policy", "Event"]


@bp.route("/announcements")
@admin_required
def announcements():
    return render_template(
        "admin_announcements.html",
        announcements=db.list_announcements(limit=100),
        categories=CATEGORIES,
    )


@bp.route("/announcements/create", methods=["POST"])
@admin_required
def announcements_create():
    title = (request.form.get("title") or "").strip()
    body = (request.form.get("body") or "").strip()
    category = request.form.get("category") or "General"
    if not title or not body:
        flash("Both a title and a message are required.", "warn")
        return redirect(url_for("admin.announcements"))
    db.create_announcement(title, body, category, g.user["email"])
    db.notify_all_users(f"📣 {title}", body[:180], kind="announcement", link="/announcements")
    flash("Announcement published and users notified.", "ok")
    return redirect(url_for("admin.announcements"))


@bp.route("/announcements/<int:announcement_id>/delete", methods=["POST"])
@admin_required
def announcements_delete(announcement_id: int):
    db.delete_announcement(announcement_id)
    flash("Announcement removed.", "ok")
    return redirect(url_for("admin.announcements"))

# ---------------------------------------------------------------------------
# Learning Path Builder
# ---------------------------------------------------------------------------


@bp.route("/learning-path")
@admin_required
def learning_path():
    return render_template(
        "admin_learning_path.html",
        weeks=db.list_learning_paths(),
        documents=db.list_documents(),
    )


@bp.route("/learning-path/create-week", methods=["POST"])
@admin_required
def learning_path_create_week():
    week_no = request.form.get("week_no", type=int) or 1
    title = (request.form.get("title") or f"Week {week_no}").strip()
    db.create_learning_week(week_no, title, g.user["email"])
    flash(f"Week {week_no} created.", "ok")
    return redirect(url_for("admin.learning_path"))


@bp.route("/learning-path/<int:path_id>/add-day", methods=["POST"])
@admin_required
def learning_path_add_day(path_id: int):
    day_no = request.form.get("day_no", type=int) or 1
    topic = (request.form.get("topic") or "").strip()
    document_id = request.form.get("document_id", type=int)
    auto_gen = bool(request.form.get("auto_gen_exam"))
    if not topic:
        flash("A topic is required for the day.", "warn")
        return redirect(url_for("admin.learning_path"))

    day_id = db.add_learning_day(path_id, day_no, topic, document_id, auto_gen)

    if not auto_gen:
        flash(f"Day {day_no} added.", "ok")
        return redirect(url_for("admin.learning_path"))

    if not document_id:
        flash(f"Day {day_no} added, but auto-exam needs a linked document — skipped.", "warn")
        return redirect(url_for("admin.learning_path"))

    doc = next((d for d in db.list_documents() if d["id"] == document_id), None)
    path = db.resolve_document_path(doc) if doc else None
    material = ""
    if path:
        try:
            pages = extract_pages(str(path))
            material = " ".join(p["text"] for p in pages[:8])
        except Exception:  # noqa: BLE001
            material = ""

    if not material.strip():
        flash(f"Day {day_no} added, but couldn't read the document to generate an exam.", "warn")
        return redirect(url_for("admin.learning_path"))

    questions = generate_exam_questions(material, num_questions=5, marks=10)
    if not questions:
        flash(f"Day {day_no} added, but AI exam generation failed — try again from Exams.", "warn")
        return redirect(url_for("admin.learning_path"))

    q_payload = [{"question": q, "marks": 10.0} for q in questions]
    exam_id = db.create_exam(
        f"{topic} — Assessment",
        f"Auto-generated from {doc['filename']}",
        30,
        g.user["email"],
        q_payload,
    )
    db.set_day_exam(day_id, exam_id)

    trainee_ids = [u["id"] for u in db.list_users(role="user")]
    added = db.assign_exam(exam_id, trainee_ids, None) if trainee_ids else 0
    if added:
        db.notify_users(
            trainee_ids,
            f"New exam assigned: {topic} — Assessment",
            f"Part of your learning path. {len(questions)} questions. Open My Exams to start.",
            kind="exam",
            link="/exams",
        )
    flash(
        f"Day {day_no} added with an auto-generated exam "
        f"({len(questions)} questions), assigned to {added} trainee(s).",
        "ok",
    )
    return redirect(url_for("admin.learning_path"))


@bp.route("/learning-path/<int:path_id>/delete", methods=["POST"])
@admin_required
def learning_path_delete(path_id: int):
    db.delete_learning_week(path_id)
    flash("Week deleted.", "ok")
    return redirect(url_for("admin.learning_path"))