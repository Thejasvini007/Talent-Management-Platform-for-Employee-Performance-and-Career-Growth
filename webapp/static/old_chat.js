/* AI Assistant: sessions, NDJSON streaming, markdown+mermaid rendering,
   voice dictation + spoken conversation, follow-ups, admin wizards,
   and the spoken mock interview. */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const scroller = $("#chat-scroll"), inner = $("#chat-inner"), empty = $("#chat-empty");
  const listEl = $("#cs-list"), newBtn = $("#new-chat");
  const input = $("#ci-input"), sendBtn = $("#ci-send"), micBtn = $("#ci-mic");
  const speakerBtn = $("#ci-speaker"), speakerIco = $("#ci-speaker-ico");
  const langSel = $("#voice-lang");

  let sessions = [], activeId = null, busy = false;
  let speakAloud = false;          // voice conversation mode
  let interview = null;            // {history:[], topic, count, language}

  mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "neutral" });
  marked.setOptions({ gfm: true, breaks: true });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ render
  function renderMarkdown(el, text) {
    const html = DOMPurify.sanitize(marked.parse(text || ""), {
      ADD_TAGS: ["pre"], ADD_ATTR: ["class"],
    });
    el.innerHTML = html;
    el.querySelectorAll("pre code.language-mermaid").forEach((code, i) => {
      const pre = code.closest("pre");
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      pre.replaceWith(div);
    });
    try { mermaid.run({ nodes: el.querySelectorAll(".mermaid") }); } catch (_e) {}
  }

  function addMessage(role, contentText, sources) {
    empty && empty.classList.add("hidden");
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    wrap.innerHTML = `
      <div class="m-avatar"><span class="ms">${role === "user" ? "person" : "smart_toy"}</span></div>
      <div class="m-body"></div>`;
    inner.appendChild(wrap);
    const body = wrap.querySelector(".m-body");
    if (role === "user") body.textContent = contentText;
    else renderMarkdown(body, contentText);
    if (sources && sources.length) attachSources(body, sources);
    scrollDown();
    return body;
  }

  function attachSources(body, sources) {
    const det = document.createElement("details");
    det.className = "m-sources";
    det.innerHTML = `<summary>📚 Sources (${sources.length})</summary>` +
      sources.map((s) => `<div class="src-row">📄 <b>${esc(s.source)}</b> · page ${esc(s.page)} · relevance ${(+s.score).toFixed(3)}</div>`).join("");
    body.appendChild(det);
  }

  function scrollDown() { scroller.scrollTop = scroller.scrollHeight; }

  function clearChips() { document.querySelectorAll(".followups.dyn, .wizard-card").forEach((n) => n.remove()); }

  function showFollowups(items) {
    if (!items || !items.length) return;
    const div = document.createElement("div");
    div.className = "followups dyn";
    div.innerHTML = items.map((q) => `<button class="fu-chip">${esc(q)}</button>`).join("");
    div.addEventListener("click", (e) => {
      const chip = e.target.closest(".fu-chip");
      if (chip) send(chip.textContent.trim());
    });
    inner.appendChild(div);
    scrollDown();
  }

  // ------------------------------------------------------------------ voice
  function plainForSpeech(md) {
    return (md || "")
      .replace(/```[\s\S]*?```/g, " . ")
      .replace(/\|.*\|/g, " ")
      .replace(/[#*_`>~\[\]()]/g, " ")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ").trim().slice(0, 1200);
  }

  function speak(text, onend) {
    if (!("speechSynthesis" in window)) { onend && onend(); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = langSel.value || "en-US";
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.lang === utter.lang) ||
                  voices.find((v) => v.lang.startsWith(utter.lang.split("-")[0]));
    if (match) utter.voice = match;
    utter.onend = () => onend && onend();
    window.speechSynthesis.speak(utter);
  }

  let mediaRecorder = null, chunks = [];
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
        micBtn.classList.remove("recording");
        if (blob.size < 1200) return; // too short — ignore
        setHint("Transcribing…");
        const fd = new FormData();
        fd.append("audio", blob, "speech.webm");
        try {
          const r = await fetch("/api/voice/transcribe", { method: "POST", body: fd });
          const data = await r.json();
          setHint();
          if (data.text) {
            if (interview) { interviewAnswer(data.text); }
            else { input.value = data.text; send(); }
          } else setHint("I couldn't hear that — try again.", true);
        } catch (_e) { setHint("Transcription failed — try again.", true); }
      };
      mediaRecorder.start();
      micBtn.classList.add("recording");
      setHint("Listening… tap the mic again to stop.");
    } catch (_e) {
      setHint("Microphone unavailable — allow mic access in your browser.", true);
    }
  }
  function stopRecording() { mediaRecorder && mediaRecorder.state === "recording" && mediaRecorder.stop(); }

  micBtn.addEventListener("click", () => {
    if (micBtn.classList.contains("recording")) stopRecording();
    else startRecording();
  });

  speakerBtn.addEventListener("click", () => {
    speakAloud = !speakAloud;
    speakerIco.textContent = speakAloud ? "volume_up" : "volume_off";
    speakerBtn.style.color = speakAloud ? "var(--ls-primary)" : "";
    if (!speakAloud) window.speechSynthesis && window.speechSynthesis.cancel();
    setHint(speakAloud ? "Voice conversation on — answers will be read aloud." : "");
  });

  const hintEl = $("#ci-hint"), hintDefault = hintEl.textContent;
  function setHint(text, isError) {
    hintEl.textContent = text || hintDefault;
    hintEl.style.color = isError ? "var(--ls-danger)" : "";
  }

  // ------------------------------------------------------------------ sessions
  async function loadSessions(selectFirst) {
    const r = await fetch("/api/chat/sessions");
    sessions = (await r.json()).sessions;
    if (selectFirst && sessions.length && activeId == null) activeId = sessions[0].id;
    paintSessions();
  }

  function paintSessions() {
    listEl.innerHTML = sessions.map((s) => `
      <div class="cs-item ${s.id === activeId ? "active" : ""}" data-id="${s.id}">
        <span class="ms" style="font-size:1rem">chat_bubble</span>
        <span class="cs-name">${esc(s.name)}</span>
        <button class="cs-menu" data-menu="${s.id}" title="Options">⋮</button>
      </div>`).join("") || '<div class="dd-empty">No chats yet — start one!</div>';
  }

  listEl.addEventListener("click", async (e) => {
    const menu = e.target.closest(".cs-menu");
    const item = e.target.closest(".cs-item");
    if (menu) {
      e.stopPropagation();
      const id = +menu.dataset.menu;
      const s = sessions.find((x) => x.id === id);
      const choice = prompt(`Rename this chat (or type DELETE to remove):`, s.name);
      if (choice == null) return;
      if (choice.trim().toUpperCase() === "DELETE") {
        await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
        if (activeId === id) { activeId = null; resetThread(); }
      } else if (choice.trim()) {
        await fetch(`/api/chat/sessions/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: choice.trim() }),
        });
      }
      await loadSessions(false);
      return;
    }
    if (item) { activeId = +item.dataset.id; paintSessions(); await openSession(activeId); }
  });

  newBtn.addEventListener("click", async () => {
    const r = await fetch("/api/chat/sessions", { method: "POST" });
    activeId = (await r.json()).id;
    await loadSessions(false);
    resetThread();
    input.focus();
  });

  function resetThread() {
    inner.querySelectorAll(".msg, .followups.dyn, .wizard-card").forEach((n) => n.remove());
    empty && empty.classList.remove("hidden");
  }

  async function openSession(id) {
    resetThread();
    const r = await fetch(`/api/chat/sessions/${id}/messages`);
    if (!r.ok) return;
    const msgs = (await r.json()).messages;
    if (msgs.length) empty.classList.add("hidden");
    msgs.forEach((m) => addMessage(m.role, m.content, m.role === "assistant" ? m.sources : null));
  }

  // ------------------------------------------------------------------ send + stream
  async function send(textArg) {
    if (busy) return;
    const text = (textArg != null ? textArg : input.value).trim();
    if (!text) return;
    if (interview) { interviewAnswer(text); input.value = ""; return; }
    busy = true; sendBtn.disabled = true;
    input.value = ""; autosize();
    clearChips();
    addMessage("user", text);

    const botBody = addMessage("assistant", "");
    botBody.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

    let acc = "";
    try {
      const resp = await fetch("/api/chat/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: activeId }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (_e) { continue; }
          if (evt.type === "start") { activeId = evt.session_id; }
          else if (evt.type === "delta") {
            acc += evt.text;
            botBody.textContent = acc; // fast plain text while streaming
            scrollDown();
          } else if (evt.type === "done") {
            renderMarkdown(botBody, acc);
            if (evt.sources && evt.sources.length) attachSources(botBody, evt.sources);
            if (evt.title) loadSessions(false); else paintSessions();
            handleSignals(evt.signals || {});
            if (!(evt.signals && evt.signals.start_mock_interview)) showFollowups(evt.followups);
            if (speakAloud) {
              speak(plainForSpeech(acc), () => { /* conversation continues on demand */ });
            }
          }
        }
      }
    } catch (_e) {
      botBody.innerHTML = '<span style="color:var(--ls-danger)">⚠️ The assistant is unreachable — please try again.</span>';
    } finally {
      busy = false; sendBtn.disabled = false;
      scrollDown();
      await loadSessions(false);
    }
  }

  sendBtn.addEventListener("click", () => send());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  input.addEventListener("input", autosize);

  $("#starter-chips") && $("#starter-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".fu-chip");
    if (chip) send(chip.textContent.replace(/^[^\s]+\s/, ""));
  });

  // ------------------------------------------------------------------ signals
  function handleSignals(signals) {
    if (signals.start_exam_wizard && window.TS_IS_ADMIN) examWizard(signals.exam_title);
    if (signals.start_announcement_wizard && window.TS_IS_ADMIN)
      announcementWizard(signals.announcement_title, signals.announcement_category);
    if (signals.start_mock_interview) startInterview(signals.interview_topic);
  }

  // ------------------------------------------------------------------ wizards
  function wizardShell(title) {
    const card = document.createElement("div");
    card.className = "wizard-card";
    card.innerHTML = `
      <div class="wz-head"><span>${esc(title)}</span><button title="Cancel">✕</button></div>
      <div class="wz-body"></div>`;
    inner.appendChild(card);
    scrollDown();
    return card;
  }
  const wzApi = (url) => async (payload) => {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.json();
  };

  async function examWizard(prefillTitle) {
    const api = wzApi("/api/wizard/exam");
    const card = wizardShell("📝 Guided exam builder");
    const body = card.querySelector(".wz-body");
    card.querySelector(".wz-head button").onclick = async () => { await api({ action: "cancel" }); card.remove(); };

    let data = await api({ action: "start", title: prefillTitle || "" });
    paint();

    function steps(step) {
      const order = ["ask_title", "pick_docs", "configure", "review", "assign", "confirm", "done"];
      const i = order.indexOf(step);
      return `<div class="wz-steps">${order.slice(0, 6).map((_, k) =>
        `<i class="${k <= i ? "done" : ""}"></i>`).join("")}</div>`;
    }

    function paint() {
      const st = data.state, op = data.options || {};
      if (!st) { card.remove(); return; }
      let html = steps(st.step);
      if (st.error) html += `<div class="wz-error">${esc(st.error)}</div>`;

      if (st.step === "ask_title") {
        html += `<label class="f-label">Exam title</label>
          <input class="f-input" id="wz-title" value="${esc(st.title)}" placeholder="Module 1 — Fundamentals Assessment">
          <label class="f-label">Instructions (optional)</label>
          <input class="f-input" id="wz-desc" placeholder="Answer in your own words.">
          <button class="btn mt-2" id="wz-next">Continue</button>`;
      } else if (st.step === "pick_docs") {
        const docs = op.documents || [];
        html += docs.length
          ? `<label class="f-label">Source documents</label>
             <div class="check-list">${docs.map((d) =>
               `<label><input type="checkbox" value="${d.id}"> 📄 ${esc(d.filename)} <span class="muted">(${d.pages} pages)</span></label>`).join("")}</div>
             <button class="btn mt-2" id="wz-next">Continue</button>`
          : `<p class="muted">No documents ingested yet — upload PDFs first.</p>`;
      } else if (st.step === "configure") {
        html += `<div class="f-row">
            <div><label class="f-label">Questions</label>
              <select class="f-select" id="wz-count">${(op.question_counts || [3,5,8,10,15]).map((n) =>
                `<option ${n === st.num_questions ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div><label class="f-label">Marks each</label>
              <select class="f-select" id="wz-marks">${(op.marks_options || [5,10,15]).map((n) =>
                `<option ${n === st.marks_per_question ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div><label class="f-label">Duration (min)</label>
              <input class="f-input" id="wz-duration" type="number" min="5" max="240" value="${st.duration}"></div>
          </div>
          <button class="btn mt-2" id="wz-next">✨ Generate questions</button>`;
      } else if (st.step === "review") {
        html += `<label class="f-label">Review the AI-drafted questions (one per line — edit freely)</label>
          <textarea class="f-textarea" id="wz-questions" style="min-height:170px">${esc((st.questions || []).join("\n"))}</textarea>
          <button class="btn mt-2" id="wz-next">Looks good — choose trainees</button>`;
      } else if (st.step === "assign") {
        const users = op.users || [];
        html += users.length
          ? `<label class="f-label">Assign to</label>
             <div class="check-list">${users.map((u) =>
               `<label><input type="checkbox" value="${u.id}"> ${esc(u.name)} <span class="muted">(${esc(u.email)})</span></label>`).join("")}</div>
             <label class="f-label">Due date (optional)</label>
             <input class="f-input" id="wz-due" type="date">
             <button class="btn mt-2" id="wz-next">Review summary</button>`
          : `<p class="muted">No trainees yet — the exam will be saved unassigned.</p>
             <button class="btn mt-2" id="wz-next">Review summary</button>`;
      } else if (st.step === "confirm") {
        const s = op.summary || {};
        html += `<h3 style="margin:.2rem 0 .6rem">Confirm &amp; create</h3>
          <div class="table-wrap"><table class="data">
            <tr><th>Title</th><td>${esc(s.title)}</td></tr>
            <tr><th>Documents</th><td>${esc((s.documents || []).join(", ") || "—")}</td></tr>
            <tr><th>Questions</th><td>${s.num_questions} × ${s.marks_each} marks = <b>${s.total_marks}</b></td></tr>
            <tr><th>Duration</th><td>${s.duration} min</td></tr>
            <tr><th>Recipients</th><td>${esc((s.recipients || []).join(", ") || "none")}</td></tr>
            <tr><th>Due</th><td>${esc(s.due_date)}</td></tr>
          </table></div>
          <button class="btn mt-2" id="wz-next">✅ Create exam</button>`;
      } else if (st.step === "done") {
        html += `<p>✅ ${esc(data.message || "Exam created.")}</p>`;
        body.innerHTML = html;
        setTimeout(() => card.remove(), 6000);
        addMessage("assistant", data.message || "Exam created and assigned.");
        return;
      }
      body.innerHTML = html;
      const next = $("#wz-next", body);
      next && next.addEventListener("click", async () => {
        next.disabled = true;
        if (st.step === "ask_title") {
          data = await api({ action: "title", title: $("#wz-title", body).value, description: $("#wz-desc", body).value });
        } else if (st.step === "pick_docs") {
          const ids = [...body.querySelectorAll("input:checked")].map((i) => +i.value);
          data = await api({ action: "documents", doc_ids: ids });
        } else if (st.step === "configure") {
          next.innerHTML = "Generating…";
          data = await api({
            action: "configure",
            num_questions: +$("#wz-count", body).value,
            marks_per_question: +$("#wz-marks", body).value,
            duration: +$("#wz-duration", body).value,
          });
        } else if (st.step === "review") {
          data = await api({ action: "questions", questions: $("#wz-questions", body).value.split("\n") });
        } else if (st.step === "assign") {
          const ids = [...body.querySelectorAll(".check-list input:checked")].map((i) => +i.value);
          const due = $("#wz-due", body) ? $("#wz-due", body).value : "";
          data = await api({ action: "assign", user_ids: ids, due_date: due || null });
        } else if (st.step === "confirm") {
          data = await api({ action: "confirm" });
        }
        paint();
        scrollDown();
      });
    }
  }

  async function announcementWizard(prefillTitle, prefillCategory) {
    const api = wzApi("/api/wizard/announcement");
    const card = wizardShell("📣 Announcement composer");
    const body = card.querySelector(".wz-body");
    card.querySelector(".wz-head button").onclick = async () => { await api({ action: "cancel" }); card.remove(); };

    let data = await api({ action: "start", title: prefillTitle || "", category: prefillCategory || "" });
    paint();

    function paint() {
      const st = data.state, op = data.options || {};
      if (!st) { card.remove(); return; }
      let html = "";
      if (st.error) html += `<div class="wz-error">${esc(st.error)}</div>`;
      if (st.step === "ask_title") {
        html += `<label class="f-label">Title</label>
          <input class="f-input" id="wz-a-title" value="${esc(st.title)}">
          <button class="btn mt-2" id="wz-next">Continue</button>`;
      } else if (st.step === "ask_body") {
        html += `<label class="f-label">Message</label>
          <textarea class="f-textarea" id="wz-a-body">${esc(st.body)}</textarea>
          <button class="btn mt-2" id="wz-next">Continue</button>`;
      } else if (st.step === "ask_category") {
        html += `<label class="f-label">Category</label>
          <select class="f-select" id="wz-a-cat">${(op.categories || []).map((c) =>
            `<option ${c === st.category ? "selected" : ""}>${c}</option>`).join("")}</select>
          <button class="btn mt-2" id="wz-next">Review</button>`;
      } else if (st.step === "confirm") {
        const s = op.summary || {};
        html += `<h3 style="margin:.2rem 0 .6rem">Confirm &amp; publish</h3>
          <p><b>${esc(s.title)}</b> <span class="pill outline">${esc(s.category)}</span></p>
          <p class="muted" style="white-space:pre-wrap">${esc(s.body)}</p>
          <button class="btn mt-2" id="wz-next">📣 Publish to all trainees</button>`;
      } else if (st.step === "done") {
        body.innerHTML = `<p>✅ ${esc(data.message || "Published.")}</p>`;
        setTimeout(() => card.remove(), 6000);
        addMessage("assistant", data.message || "Announcement published.");
        return;
      }
      body.innerHTML = html;
      const next = $("#wz-next", body);
      next && next.addEventListener("click", async () => {
        next.disabled = true;
        if (st.step === "ask_title") data = await api({ action: "title", title: $("#wz-a-title", body).value });
        else if (st.step === "ask_body") data = await api({ action: "body", body: $("#wz-a-body", body).value });
        else if (st.step === "ask_category") data = await api({ action: "category", category: $("#wz-a-cat", body).value });
        else if (st.step === "confirm") data = await api({ action: "confirm" });
        paint(); scrollDown();
      });
    }
  }

  // ------------------------------------------------------------------ mock interview
  async function startInterview(topic) {
    interview = { history: [], topic: topic || "", count: 0,
                  language: langSel.options[langSel.selectedIndex].text };
    setHint("🎙️ Mock interview in progress — answer by voice (mic) or text.");
    await interviewTurn();
  }

  async function interviewTurn() {
    const r = await fetch("/api/interview/turn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(interview),
    });
    const data = await r.json();
    interview.history.push({ role: "assistant", content: data.reply });
    addMessage("assistant", data.reply);
    speak(plainForSpeech(data.reply), () => {});
    if (data.is_final) {
      if (data.score != null) addMessage("assistant", `🏁 **Interview score: ${data.score}/10**`);
      interview = null;
      setHint();
    }
  }

  async function interviewAnswer(text) {
    addMessage("user", text);
    interview.history.push({ role: "user", content: text });
    interview.count += 1;
    await interviewTurn();
  }

  // ---------------------------------------------- voice conversation (ChatGPT-style)
  // A full-screen mode: continuous live speech-to-text, auto-send after a 3s
  // pause, spoken replies, and an optional live transcript. Reuses the same
  // /api/chat/send backend and TTS as the text chat, so turns persist to the
  // thread and show up when the overlay is closed.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SILENCE_MS = 3000;

  const overlay = $("#voice-overlay");
  const orb = $("#vo-orb"), voStatus = $("#vo-status");
  const capBtn = $("#vo-captions"), capPanel = $("#vo-caption-panel");
  const voMic = $("#vo-mic"), voClose = $("#vo-close"), voInput = $("#vo-input"), voPlus = $("#vo-plus");
  const voiceBtn = $("#ci-voice");

  let recog = null;
  let voiceOn = false;     // overlay open
  let listening = false;   // recogniser is actively capturing
  let muted = false;       // user paused the mic
  let voiceBusy = false;   // thinking / speaking — don't listen
  let showText = false;    // captions visible
  let silenceTimer = null, finalTx = "", interimTx = "", liveEl = null;

  function setOrb(state) {
    orb.classList.remove("listening", "thinking", "speaking");
    if (state) orb.classList.add(state);
  }
  function setVoStatus(t) { voStatus.textContent = t; }

  function capTurn(role, text) {
    const row = document.createElement("div");
    row.className = "vo-cap " + role;
    row.textContent = text;
    capPanel.appendChild(row);
    capPanel.scrollTop = capPanel.scrollHeight;
    return row;
  }
  function updateLive(text) {
    if (!liveEl) { liveEl = document.createElement("div"); liveEl.className = "vo-cap user live"; capPanel.appendChild(liveEl); }
    liveEl.textContent = text;
    capPanel.scrollTop = capPanel.scrollHeight;
  }
  function clearLive() { if (liveEl) { liveEl.remove(); liveEl = null; } }

  function startListening() {
    if (!voiceOn || muted || voiceBusy) return;
    if (!SR) { setVoStatus("Live voice input isn't supported here — type below."); return; }
    try { recog = new SR(); } catch (_e) { return; }
    recog.lang = (langSel && langSel.value) || "en-US";
    recog.continuous = true;
    recog.interimResults = true;
    finalTx = ""; interimTx = "";
    listening = true;
    setOrb("listening");
    setVoStatus("Listening…");
    recog.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalTx += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      interimTx = interim;
      updateLive((finalTx + interim).trim());
      armSilence();
    };
    recog.onerror = (e) => {
      // Fatal permission errors: stop the loop and tell the user.
      if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
        listening = false;
        setOrb(null);
        setVoStatus("Microphone blocked — allow mic access, or type below.");
      }
      /* no-speech / aborted / network are transient — onend restarts */
    };
    recog.onend = () => {
      // Browsers stop the recogniser on pauses; keep it alive until we finalise.
      if (listening && voiceOn && !muted) { try { recog.start(); } catch (_e) {} }
    };
    try { recog.start(); } catch (_e) {}
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    if (!(finalTx + interimTx).trim()) return;   // only count silence after real speech
    silenceTimer = setTimeout(finalizeUtterance, SILENCE_MS);
  }

  function stopListening() {
    listening = false;
    clearTimeout(silenceTimer);
    if (recog) { try { recog.stop(); } catch (_e) {} }
  }

  function finalizeUtterance() {
    const text = (finalTx + interimTx).trim();
    stopListening();
    if (text) handleUtterance(text);
    else if (voiceOn && !muted) startListening();
  }

  async function handleUtterance(text) {
    voiceBusy = true;
    clearLive();
    capTurn("user", text);
    addMessage("user", text);            // mirror into the persistent thread
    setOrb("thinking");
    setVoStatus("Thinking…");

    const botBody = addMessage("assistant", "");
    botBody.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    const capBot = capTurn("assistant", "");

    let acc = "";
    try {
      const resp = await fetch("/api/chat/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: activeId }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line); } catch (_e) { continue; }
          if (evt.type === "start") { activeId = evt.session_id; }
          else if (evt.type === "delta") {
            acc += evt.text;
            botBody.textContent = acc;
            capBot.textContent = acc;
            capPanel.scrollTop = capPanel.scrollHeight;
            scrollDown();
          } else if (evt.type === "done") {
            renderMarkdown(botBody, acc);
            if (evt.sources && evt.sources.length) attachSources(botBody, evt.sources);
            if (evt.title) loadSessions(false); else paintSessions();
          }
        }
      }
    } catch (_e) {
      acc = acc || "Sorry — I couldn't reach the assistant. Please try again.";
      capBot.textContent = acc;
    }
    await loadSessions(false);

    // Speak the reply, then hand the turn back to the microphone.
    const speech = plainForSpeech(acc);
    const resume = () => {
      voiceBusy = false;
      if (voiceOn && !muted) startListening();
      else if (voiceOn) { setOrb(null); setVoStatus("Muted — tap the mic to talk"); }
    };
    if (speech) {
      setOrb("speaking");
      setVoStatus("Speaking…");
      speak(speech, resume);
    } else resume();
  }

  function enterVoice() {
    voiceOn = true; muted = false; voiceBusy = false;
    capPanel.innerHTML = ""; liveEl = null;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("voice-open");
    updateMicBtn();
    setOrb(null);
    setVoStatus(SR ? "Listening…" : "Type below — live voice isn't supported in this browser.");
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    startListening();
  }

  function exitVoice() {
    voiceOn = false;
    stopListening();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("voice-open");
    setOrb(null);
  }

  function updateMicBtn() {
    voMic.classList.toggle("muted", muted);
    voMic.querySelector(".ms").textContent = muted ? "mic_off" : "mic";
    voMic.title = muted ? "Unmute" : "Mute";
  }

  if (voiceBtn) voiceBtn.addEventListener("click", enterVoice);
  if (voClose) voClose.addEventListener("click", exitVoice);
  if (voMic) voMic.addEventListener("click", () => {
    muted = !muted;
    updateMicBtn();
    if (muted) { stopListening(); setOrb(null); setVoStatus("Muted — tap the mic to talk"); }
    else if (!voiceBusy) startListening();
  });
  if (capBtn) capBtn.addEventListener("click", () => {
    showText = !showText;
    capPanel.classList.toggle("show", showText);
    capBtn.classList.toggle("active", showText);
    capBtn.setAttribute("aria-pressed", showText ? "true" : "false");
    capBtn.title = showText ? "Hide text" : "Show text";
  });
  if (voInput) voInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const t = voInput.value.trim();
      if (!t || voiceBusy) return;
      voInput.value = "";
      stopListening();
      handleUtterance(t);
    }
  });
  if (voPlus) voPlus.addEventListener("click", () => voInput.focus());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && voiceOn) exitVoice(); });

  // ------------------------------------------------------------------ boot
  (async function boot() {
    await loadSessions(true);
    if (activeId) await openSession(activeId);
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices(); // warm voices
    input.focus();
  })();
})();
