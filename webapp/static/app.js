/* App shell: sidebar toggle, notification bell + settings dot, flash auto-hide. */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);

  // ---- sidebar (mobile) ----
  const hamburger = $("#hamburger");
  const sidebar = $("#sidebar");
  if (hamburger && sidebar) {
    hamburger.addEventListener("click", () => sidebar.classList.toggle("open-mobile"));
    document.addEventListener("click", (e) => {
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) {
        sidebar.classList.remove("open-mobile");
      }
    });
  }

  // ---- dropdowns ----
  const bellBtn = $("#bell-btn"), bellDd = $("#bell-dd");
  const setBtn = $("#settings-btn"), setDd = $("#settings-dd");

  function closeAll() {
    bellDd && bellDd.classList.remove("open");
    setDd && setDd.classList.remove("open");
  }
  function toggle(dd) {
    const open = dd.classList.contains("open");
    closeAll();
    if (!open) dd.classList.add("open");
  }
  bellBtn && bellBtn.addEventListener("click", (e) => { e.stopPropagation(); toggle(bellDd); loadNotifications(); });
  setBtn && setBtn.addEventListener("click", (e) => { e.stopPropagation(); toggle(setDd); });
  document.addEventListener("click", (e) => {
    if (bellDd && !bellDd.contains(e.target) && setDd && !setDd.contains(e.target)) closeAll();
  });
  const settingsNotifRow = $("#settings-notif-row");
  settingsNotifRow && settingsNotifRow.addEventListener("click", (e) => {
    e.stopPropagation(); closeAll(); bellDd.classList.add("open"); loadNotifications();
  });

  // ---- notifications ----
  const badge = $("#bell-badge"), dot = $("#settings-dot"), pill = $("#settings-unread-pill");
  const items = $("#bell-items");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function paintCount(n) {
    if (badge) { badge.textContent = n > 99 ? "99+" : n; badge.classList.toggle("hidden", !n); }
    if (dot) dot.classList.toggle("hidden", !n);
    if (pill) { pill.textContent = n + " new"; pill.classList.toggle("hidden", !n); }
  }

  async function loadNotifications() {
    if (!items) return;
    try {
      const r = await fetch("/api/notifications");
      if (!r.ok) return;
      const data = await r.json();
      paintCount(data.unread);
      if (!data.items.length) {
        items.innerHTML = '<div class="dd-empty">🔕 Nothing yet — you\'re all caught up.</div>';
        return;
      }
      items.innerHTML = data.items.map((n) => `
        <div class="dd-item ${n.is_read ? "" : "unread"}" ${n.link ? `style="cursor:pointer" onclick="location.href='${esc(n.link)}'"` : ""}>
          <div class="t">${esc(n.title)}</div>
          ${n.body ? `<div class="b">${esc(n.body)}</div>` : ""}
          <div class="m">${esc((n.created_at || "").slice(0, 16))} UTC</div>
        </div>`).join("");
    } catch (_e) { /* transient — badge stays as-is */ }
  }

  async function pollUnread() {
    try {
      const r = await fetch("/api/notifications");
      if (r.ok) paintCount((await r.json()).unread);
    } catch (_e) {}
  }

  const markAll = $("#mark-all-read");
  markAll && markAll.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch("/api/notifications/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    paintCount(0);
    loadNotifications();
  });

  if (bellBtn) setInterval(pollUnread, 30000);

  // ---- flash auto-hide ----
  const flashes = $("#flashes");
  if (flashes) {
    setTimeout(() => {
      [...flashes.children].forEach((f) => {
        if (!f.classList.contains("credentials")) f.remove(); // keep credential flashes until dismissed
      });
      if (!flashes.children.length) flashes.remove();
    }, 6000);
    flashes.addEventListener("click", (e) => {
      const f = e.target.closest(".flash");
      f && f.remove();
    });
  }
})();
