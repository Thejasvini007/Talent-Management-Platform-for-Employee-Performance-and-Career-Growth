/* Proctored exam runner.
   - Starts in fullscreen (user gesture on the start gate).
   - Tab switch / minimise / fullscreen exit => violation reported to server.
   - Violations 1..MAX show a blocking error overlay (max two warnings).
   - Violation MAX+1 terminates: auto-submit with whatever is answered.
   - Voice exams: TTS question -> record -> Whisper -> AI verdict -> next. */
(function () {
  "use strict";

  const E = window.EXAM;
  const $ = (s, r) => (r || document).querySelector(s);

  const startGate = $("#start-gate"), beginBtn = $("#begin-btn");
  const shell = $("#exam-shell"), timerEl = $("#timer");
  const violOverlay = $("#violation-overlay"), violMsg = $("#violation-msg");
  const violTitle = $("#violation-title"), violResume = $("#violation-resume");
  const violPill = $("#viol-pill"), violCount = $("#viol-count");
  const resultCard = $("#result-card");

  let running = false, finished = false, submitting = false;
  let deadline = 0, timerId = null;
  let violations = 0, overlayOpen = false;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------- fullscreen + proctoring ----------------
  async function enterFullscreen() {
    const el = document.documentElement;
    try { await (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); }
    catch (_e) { /* browser denied — proctoring still watches visibility */ }
  }

  beginBtn.addEventListener("click", async () => {
    await enterFullscreen();
    startGate.classList.remove("open");
    shell.classList.remove("hidden");
    running = true;
    startTimer();
    if (E.isVoice) voiceStart();
  });

  function startTimer() {
    deadline = Date.now() + E.durationMin * 60 * 1000;
    timerId = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      if (left <= 5 * 60 * 1000) timerEl.classList.add("low");
      if (left <= 0) { clearInterval(timerId); finish(false, "time"); }
    }, 500);
  }

  async function reportViolation(reason) {
    if (!running || finished || submitting) return;
    try {
      const r = await fetch(`/api/exams/${E.assignmentId}/violation`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await r.json();
      violations = data.count;
      violPill.classList.remove("hidden");
      violCount.textContent = Math.min(violations, E.maxWarnings);
      if (data.terminate) {
        violTitle.textContent = "Exam terminated";
        violMsg.textContent = data.message;
        violResume.classList.add("hidden");
        violOverlay.classList.add("open");
        finish(true, "violations");
      } else {
        violTitle.textContent = `Violation ${data.count} of ${data.max_warnings}`;
        violMsg.textContent = data.message;
        violResume.classList.remove("hidden");
        violOverlay.classList.add("open");
        overlayOpen = true;
      }
    } catch (_e) { /* network blip — keep the exam usable */ }
  }

  violResume.addEventListener("click", async () => {
    violOverlay.classList.remove("open");
    overlayOpen = false;
    await enterFullscreen();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running && !finished && !overlayOpen) reportViolation("tab switch / minimise");
  });
  window.addEventListener("blur", () => {
    if (running && !finished && !overlayOpen && document.hidden) return; // visibilitychange handles it
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && running && !finished && !overlayOpen) {
      reportViolation("exited fullscreen");
    }
  });
  document.addEventListener("contextmenu", (e) => running && !finished && e.preventDefault());
  document.addEventListener("copy", (e) => running && !finished && e.preventDefault());
  window.addEventListener("beforeunload", (e) => {
    if (running && !finished) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------------- written exam ----------------
  const submitBtn = $("#submit-btn");
  submitBtn && submitBtn.addEventListener("click", () => finish(false, "manual"));

  document.addEventListener("input", (e) => {
    const ta = e.target.closest("textarea.answer");
    if (ta) ta.closest(".q-card").classList.toggle("answered", !!ta.value.trim());
  });

  async function finish(terminated, why) {
    if (finished || submitting) return;
    submitting = true;
    if (E.isVoice) { voiceFinish(terminated); return; }

    const answers = {};
    document.querySelectorAll("textarea.answer").forEach((ta) => { answers[ta.name] = ta.value; });
    if (why === "manual") {
      const blank = Object.values(answers).filter((v) => !v.trim()).length;
      if (blank && !confirm(`${blank} question(s) are unanswered. Submit anyway?`)) {
        submitting = false; return;
      }
    }
    finished = true; running = false;
    clearInterval(timerId);
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "Grading…"; }

    try {
      const r = await fetch(`/api/exams/${E.assignmentId}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, terminated }),
      });
      const data = await r.json();
      showResult(data, terminated);
    } catch (_e) {
      alert("Submission failed — check your connection and try again.");
      finished = false; submitting = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "Submit"; }
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function showResult(data, terminated) {
    violOverlay.classList.remove("open");
    const form = $("#exam-form");
    form && form.classList.add("hidden");
    const color = data.pct >= 70 ? "#057642" : data.pct >= 40 ? "#0A66C2" : "#CC1016";
    resultCard.classList.remove("hidden");
    resultCard.innerHTML = `
      <div class="exam-row">
        <div class="score-ring" style="background: conic-gradient(${color} ${data.pct * 3.6}deg, #E0DFDC 0deg);">
          <div class="sr-in">${Math.round(data.pct)}%</div>
        </div>
        <div class="x-info">
          <h3 style="margin:0">${terminated ? "⛔ Exam terminated — submitted automatically" : "✅ Exam submitted"}</h3>
          <p class="muted">Score <b>${data.total_score.toFixed(1)} / ${data.max_score.toFixed(0)}</b>
             ${data.violations ? ` · ${data.violations} violation(s) recorded` : ""}</p>
          <a class="btn" href="${E.examsUrl}">Back to My Exams</a>
        </div>
      </div>
      <div class="mt-2">${(data.detail || []).map((r, i) => {
        const qp = r.marks ? (r.score || 0) / r.marks : 0;
        const cls = qp >= 0.7 ? "high" : qp >= 0.4 ? "mid" : "danger";
        return `<details class="qa"><summary>Q${i + 1}. ${esc(r.question).slice(0, 110)}
            <span class="pill ${cls}">${(r.score || 0).toFixed(1)}/${r.marks.toFixed(0)}</span></summary>
          <div class="qa-body"><blockquote>${esc(r.answer) || "No answer"}</blockquote>
          ${r.feedback ? `<p>💬 ${esc(r.feedback)}</p>` : ""}</div></details>`;
      }).join("")}</div>`;
    resultCard.scrollIntoView({ behavior: "smooth" });
  }

  // ---------------- voice exam ----------------
  const orb = $("#orb"), orbStatus = $("#orb-status");
  const vqText = $("#vq-text"), vqProgress = $("#vq-progress");
  const vqRecord = $("#vq-record"), vqStop = $("#vq-stop"), vqNext = $("#vq-next");
  const vqFeedback = $("#vq-feedback");
  let vIdx = 0, vResults = [], vRecorder = null, vChunks = [];

  function speak(text, onend) {
    if (!("speechSynthesis" in window)) { onend && onend(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[#*_`>~]/g, " "));
    u.lang = "en-US";
    u.onend = () => onend && onend();
    orb.classList.add("speaking");
    window.speechSynthesis.speak(u);
    u.onend = () => { orb.classList.remove("speaking"); onend && onend(); };
  }

  function voiceStart() {
    vIdx = 0; vResults = [];
    voiceAsk();
  }

  function voiceAsk() {
    const q = E.questions[vIdx];
    vqFeedback.innerHTML = "";
    vqNext.classList.add("hidden");
    vqRecord.classList.remove("hidden");
    vqText.textContent = `Q${vIdx + 1}. ${q.question}`;
    vqProgress.textContent = `Question ${vIdx + 1} of ${E.questions.length}`;
    orbStatus.textContent = "Listen…";
    speak(q.question, () => { orbStatus.textContent = "Tap Answer and speak."; });
  }

  vqRecord.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      vChunks = [];
      vRecorder = new MediaRecorder(stream);
      vRecorder.ondataavailable = (e) => e.data.size && vChunks.push(e.data);
      vRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        orb.classList.remove("listening");
        orbStatus.textContent = "Evaluating…";
        const blob = new Blob(vChunks, { type: vRecorder.mimeType || "audio/webm" });
        const fd = new FormData();
        fd.append("audio", blob, "answer.webm");
        fd.append("question_id", E.questions[vIdx].id);
        try {
          const r = await fetch(`/api/exams/${E.assignmentId}/voice-answer`, { method: "POST", body: fd });
          const data = await r.json();
          if (!data.ok) {
            orbStatus.textContent = data.message || "Please record again.";
            vqRecord.classList.remove("hidden"); vqStop.classList.add("hidden");
            return;
          }
          const q = E.questions[vIdx];
          vResults.push({
            question_id: q.id, answer: data.transcript, verdict: data.verdict,
            score: data.score, feedback: data.feedback, correct_answer: data.correct_answer,
          });
          const label = data.verdict === "correct" ? "✅ Correct"
                      : data.verdict === "partial" ? "◐ Partly correct" : "✗ Incorrect";
          const cls = data.verdict === "correct" ? "high" : data.verdict === "partial" ? "mid" : "danger";
          vqFeedback.innerHTML = `
            <p><b>You said:</b> ${esc(data.transcript)}</p>
            <p><span class="pill ${cls}">${label}</span> ${esc(data.feedback || "")}</p>
            ${data.correct_answer ? `<p class="muted">✅ Expected: ${esc(data.correct_answer)}</p>` : ""}`;
          const spoken = `${label.replace(/[✅◐✗]/g, "")}. ${data.feedback || ""} ${data.correct_answer ? "The correct answer is: " + data.correct_answer : ""}`;
          speak(spoken, () => {});
          orbStatus.textContent = "";
          vqNext.classList.remove("hidden");
          vqNext.innerHTML = vIdx + 1 >= E.questions.length
            ? '<span class="ms">flag</span> Finish exam' : '<span class="ms">arrow_forward</span> Next question';
        } catch (_e) {
          orbStatus.textContent = "Network error — record again.";
          vqRecord.classList.remove("hidden");
        }
      };
      vRecorder.start();
      orb.classList.add("listening");
      orbStatus.textContent = "Listening… speak your answer.";
      vqRecord.classList.add("hidden");
      vqStop.classList.remove("hidden");
    } catch (_e) {
      orbStatus.textContent = "Microphone unavailable — allow access in the browser.";
    }
  });

  vqStop.addEventListener("click", () => {
    vqStop.classList.add("hidden");
    vRecorder && vRecorder.state === "recording" && vRecorder.stop();
  });

  vqNext.addEventListener("click", () => {
    vIdx += 1;
    if (vIdx >= E.questions.length) voiceFinish(false);
    else voiceAsk();
  });

  async function voiceFinish(terminated) {
    finished = true; running = false;
    clearInterval(timerId);
    window.speechSynthesis && window.speechSynthesis.cancel();
    try {
      const r = await fetch(`/api/exams/${E.assignmentId}/voice-submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: vResults, terminated }),
      });
      const data = await r.json();
      $("#voice-stage").classList.add("hidden");
      const box = $("#voice-result");
      const color = data.pct >= 70 ? "#057642" : data.pct >= 40 ? "#0A66C2" : "#CC1016";
      box.classList.remove("hidden");
      box.innerHTML = `
        <div class="exam-row">
          <div class="score-ring" style="background: conic-gradient(${color} ${data.pct * 3.6}deg, #E0DFDC 0deg);">
            <div class="sr-in">${Math.round(data.pct)}%</div>
          </div>
          <div class="x-info">
            <h3 style="margin:0">${terminated ? "⛔ Exam terminated" : "🎙️ Voice exam complete"}</h3>
            <a class="btn mt-1" href="${E.examsUrl}">Back to My Exams</a>
          </div>
        </div>`;
    } catch (_e) { alert("Saving the voice exam failed — please tell your admin."); }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
})();
