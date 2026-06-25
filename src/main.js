// ===========================================================================
// Port Process Pal frontend logic
// Talks to the Rust backend over Tauri's invoke bridge, keeps a gently-diffed
// table in sync on a 2s poll, and guards destructive actions.
// ===========================================================================

const { invoke } = window.__TAURI__.core;

const POLL_MS = 2000;

const state = {
  ports: [],
  filter: "all",
  search: "",
  sort: { key: "port", dir: "asc" },
  firstLoad: true,
  paused: false,
  error: null,
};

const el = {
  rows: document.getElementById("rows"),
  summary: document.getElementById("summary"),
  search: document.getElementById("search"),
  refresh: document.getElementById("refresh"),
  stopAll: document.getElementById("stop-all"),
  themeToggle: document.getElementById("theme-toggle"),
  loading: document.getElementById("loading"),
  empty: document.getElementById("empty"),
  noMatch: document.getElementById("no-match"),
  error: document.getElementById("error"),
  errorMsg: document.getElementById("error-msg"),
  retry: document.getElementById("retry"),
  autoState: document.getElementById("auto-state"),
  toasts: document.getElementById("toasts"),
  modal: document.getElementById("modal"),
  modalList: document.getElementById("modal-list"),
  modalCount: document.getElementById("modal-count"),
  modalConfirm: document.getElementById("modal-confirm"),
  modalCancel: document.getElementById("modal-cancel"),
  sourceLink: document.getElementById("source-link"),
};

const REPO_URL = "https://github.com/JasimSiddiqui/port-process-pal";

// ----------------------------------------------------------------- helpers

const keyOf = (p) => `${p.port}-${p.pid}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function formatUptime(started) {
  if (!started) return { text: "—", title: "Unknown start time" };
  const d = new Date(started);
  if (isNaN(d.getTime())) return { text: started, title: started };

  let ms = Date.now() - d.getTime();
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  let text;
  if (sec < 45) text = "just now";
  else if (min < 60) text = `${min}m`;
  else if (hr < 24) text = `${hr}h ${min % 60}m`;
  else text = `${day}d ${hr % 24}h`;

  return { text, title: d.toLocaleString() };
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

// ----------------------------------------------------------------- toasts

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = "toast" + (kind ? ` is-${kind}` : "");
  node.innerHTML = `<span class="toast__text">${message}</span>`;
  el.toasts.appendChild(node);

  const remove = () => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 220);
  };
  setTimeout(remove, 3200);
  node.addEventListener("click", remove);
}

// ----------------------------------------------------------------- data

async function loadPorts() {
  if (state.paused) return;
  try {
    const ports = await invoke("list_ports");
    state.ports = Array.isArray(ports) ? ports : [];
    state.error = null;
  } catch (err) {
    state.error = typeof err === "string" ? err : "Unexpected error reading ports.";
  } finally {
    state.firstLoad = false;
    render();
  }
}

function retry() {
  state.firstLoad = true;
  state.error = null;
  render();
  loadPorts();
}

// ----------------------------------------------------------------- derive

function visiblePorts() {
  let list = state.ports.slice();

  if (state.filter === "dev") list = list.filter((p) => !p.protected);
  else if (state.filter === "protected") list = list.filter((p) => p.protected);

  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (p) =>
        String(p.port).includes(q) ||
        String(p.pid).includes(q) ||
        p.process_name.toLowerCase().includes(q) ||
        (p.path || "").toLowerCase().includes(q)
    );
  }

  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === "started_at") {
      av = av ? new Date(av).getTime() || 0 : 0;
      bv = bv ? new Date(bv).getTime() || 0 : 0;
    }
    if (typeof av === "string") return av.localeCompare(bv) * mul;
    return (av - bv) * mul;
  });

  return list;
}

// ----------------------------------------------------------------- render

function render() {
  // Header summary
  const total = state.ports.length;
  const killable = state.ports.filter((p) => !p.protected).length;
  el.summary.textContent = state.firstLoad
    ? "Scanning ports…"
    : `${total} active port${total === 1 ? "" : "s"} · ${killable} killable`;
  el.stopAll.disabled = killable === 0;

  // States
  const showLoading = state.firstLoad && !state.error;
  const showError = !!state.error;
  el.loading.hidden = !showLoading;
  el.error.hidden = !showError;
  if (showError) el.errorMsg.textContent = state.error;

  if (showLoading || showError) {
    el.empty.hidden = true;
    el.noMatch.hidden = true;
    return;
  }

  const list = visiblePorts();
  el.empty.hidden = !(state.ports.length === 0);
  el.noMatch.hidden = !(state.ports.length > 0 && list.length === 0);

  reconcile(list);
  updateSortIndicators();
}

function reconcile(list) {
  const desiredKeys = list.map(keyOf);
  const existing = new Map();
  for (const tr of Array.from(el.rows.children)) {
    existing.set(tr.dataset.key, tr);
  }

  // Remove rows that are gone
  for (const [key, tr] of existing) {
    if (!desiredKeys.includes(key)) {
      tr.remove();
      existing.delete(key);
    }
  }

  // Create / update / order
  let prev = null;
  for (const p of list) {
    const key = keyOf(p);
    let tr = existing.get(key);
    if (!tr) {
      tr = createRow(p);
      existing.set(key, tr);
    } else {
      updateRow(tr, p);
    }
    // Place in correct order without disturbing untouched rows
    const shouldBeAfter = prev ? prev.nextSibling : el.rows.firstChild;
    if (tr !== shouldBeAfter) {
      el.rows.insertBefore(tr, shouldBeAfter);
    }
    prev = tr;
  }
}

function rowInner(p) {
  const up = formatUptime(p.started_at);
  const shield = p.protected
    ? `<span class="shield" title="Protected: system or privileged port, excluded from bulk actions">protected</span>`
    : "";
  const path = p.path
    ? `<span class="process__path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</span>`
    : "";

  return `
    <td class="col-port"><span class="port-num">${p.port}</span></td>
    <td class="col-process">
      <div class="process">
        <span class="process__name">${escapeHtml(p.process_name)}${shield}</span>
        ${path}
      </div>
    </td>
    <td class="col-pid">${p.pid}</td>
    <td class="col-proto"><span class="tag">${escapeHtml(p.protocol)}</span></td>
    <td class="col-uptime"><span class="uptime" title="${escapeHtml(up.title)}">${up.text}</span></td>
    <td class="col-actions">
      <span class="row-actions">
        <button class="act act--open" data-act="open" data-port="${p.port}" title="Open http://localhost:${p.port}">Open</button>
        <button class="act act--copy" data-act="copy" data-port="${p.port}" title="Copy localhost URL">Copy</button>
        <button class="act act--kill" data-act="kill" data-pid="${p.pid}" data-name="${escapeHtml(p.process_name)}" data-port="${p.port}" ${p.protected ? "disabled title='Protected: cannot be terminated'" : "title='Terminate this process'"}>Kill</button>
      </span>
    </td>`;
}

function createRow(p) {
  const tr = document.createElement("tr");
  tr.dataset.key = keyOf(p);
  if (p.protected) tr.classList.add("is-protected");
  tr.innerHTML = rowInner(p);
  return tr;
}

function updateRow(tr, p) {
  // Only the volatile bits change between polls; leave action buttons alone so
  // hover / confirm state survives a refresh.
  tr.classList.toggle("is-protected", p.protected);
  const up = formatUptime(p.started_at);
  const uptimeEl = tr.querySelector(".uptime");
  if (uptimeEl && uptimeEl.textContent !== up.text) {
    uptimeEl.textContent = up.text;
    uptimeEl.title = up.title;
  }
}

function updateSortIndicators() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === state.sort.key) {
      th.classList.add(state.sort.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });
}

// ----------------------------------------------------------------- actions

async function openPort(port) {
  try {
    await invoke("open_in_browser", { port: Number(port) });
  } catch (err) {
    toast(`Couldn’t open port ${port}: ${escapeHtml(String(err))}`, "error");
  }
}

async function copyPort(port) {
  const url = `http://localhost:${port}`;
  const ok = await copyText(url);
  toast(
    ok ? `Copied <strong>${url}</strong>` : "Couldn’t copy to clipboard",
    ok ? "ok" : "error"
  );
}

async function killOne(btn) {
  const pid = Number(btn.dataset.pid);
  const name = btn.dataset.name || "process";
  const port = btn.dataset.port;
  const tr = btn.closest("tr");
  if (tr) tr.classList.add("is-killing");

  try {
    await invoke("kill_process", { pid });
    toast(`Terminated <strong>${escapeHtml(name)}</strong> (:${port})`, "ok");
    // Optimistic: drop it now; the next poll reconciles the truth.
    if (tr) setTimeout(() => tr.remove(), 180);
    loadPorts();
  } catch (err) {
    if (tr) tr.classList.remove("is-killing");
    toast(`Couldn’t kill ${escapeHtml(name)}: ${escapeHtml(String(err))}`, "error");
  }
}

// Two-step inline confirm for single kills (no modal, but not a hair-trigger).
let pendingConfirm = null;
function armKillConfirm(btn) {
  if (pendingConfirm && pendingConfirm.btn === btn) {
    clearTimeout(pendingConfirm.timer);
    pendingConfirm = null;
    btn.classList.remove("confirming");
    btn.textContent = "Kill";
    killOne(btn);
    return;
  }
  resetKillConfirm();
  btn.classList.add("confirming");
  btn.textContent = "Confirm?";
  const timer = setTimeout(resetKillConfirm, 3000);
  pendingConfirm = { btn, timer };
}

function resetKillConfirm() {
  if (!pendingConfirm) return;
  clearTimeout(pendingConfirm.timer);
  const { btn } = pendingConfirm;
  btn.classList.remove("confirming");
  btn.textContent = "Kill";
  pendingConfirm = null;
}

// ----------------------------------------------------------------- stop all

function openStopAllModal() {
  const targets = state.ports.filter((p) => !p.protected);
  if (targets.length === 0) return;

  el.modalCount.textContent = targets.length;
  el.modalList.innerHTML = targets
    .map(
      (p) =>
        `<li><span class="ml-port">:${p.port}</span><span class="ml-name">${escapeHtml(
          p.process_name
        )} · PID ${p.pid}</span></li>`
    )
    .join("");
  el.modal.hidden = false;
  state.paused = true;
  setAutoState();
  el.modalConfirm.focus();
}

function closeStopAllModal() {
  el.modal.hidden = true;
  state.paused = false;
  setAutoState();
}

async function confirmStopAll() {
  const pids = state.ports.filter((p) => !p.protected).map((p) => p.pid);
  closeStopAllModal();
  if (pids.length === 0) return;

  // Optimistic fade of all targeted rows
  for (const tr of Array.from(el.rows.children)) {
    const pid = Number(tr.querySelector('[data-act="kill"]')?.dataset.pid);
    if (pids.includes(pid)) tr.classList.add("is-killing");
  }

  try {
    const summary = await invoke("kill_all", { pids });
    const k = summary.killed.length;
    const f = summary.failed.length;
    if (f === 0) {
      toast(`Stopped <strong>${k}</strong> process${k === 1 ? "" : "es"}`, "ok");
    } else {
      toast(`Stopped ${k}, ${f} failed (may need elevation)`, "error");
    }
    loadPorts();
  } catch (err) {
    toast(`Stop All failed: ${escapeHtml(String(err))}`, "error");
    loadPorts();
  }
}

function setAutoState() {
  el.autoState.classList.toggle("is-paused", state.paused);
  el.autoState.lastChild.textContent = state.paused
    ? " Auto-refresh paused"
    : " Auto-refresh on";
}

// ----------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  el.themeToggle.title = theme === "dark" ? "Switch to light" : "Switch to dark";
}

function initTheme() {
  // Light is the default; users opt into dark, and the choice is remembered.
  const theme = localStorage.getItem("ppp-theme") || "light";
  applyTheme(theme);
}

function toggleTheme() {
  const next =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "light"
      : "dark";
  localStorage.setItem("ppp-theme", next);
  applyTheme(next);
}

// ----------------------------------------------------------------- events

el.rows.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "open") openPort(btn.dataset.port);
  else if (act === "copy") copyPort(btn.dataset.port);
  else if (act === "kill" && !btn.disabled) armKillConfirm(btn);
});

el.search.addEventListener("input", () => {
  state.search = el.search.value;
  render();
});

el.refresh.addEventListener("click", () => loadPorts());
el.retry.addEventListener("click", retry);
el.sourceLink.addEventListener("click", () => {
  invoke("open_url", { url: REPO_URL }).catch(() => {});
});

el.stopAll.addEventListener("click", openStopAllModal);
el.themeToggle.addEventListener("click", toggleTheme);
el.modalCancel.addEventListener("click", closeStopAllModal);
el.modalConfirm.addEventListener("click", confirmStopAll);
el.modal.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeStopAllModal();
});

document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.key = key;
      state.sort.dir = "asc";
    }
    render();
  });
});

document.querySelectorAll(".seg__btn").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".seg__btn").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    state.filter = b.dataset.filter;
    render();
  });
});

document.addEventListener("keydown", (e) => {
  const typing =
    e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";

  if (e.key === "Escape") {
    if (!el.modal.hidden) closeStopAllModal();
    else if (el.search.value) {
      el.search.value = "";
      state.search = "";
      render();
    }
    resetKillConfirm();
    return;
  }
  if (typing) return;

  if (e.key === "/") {
    e.preventDefault();
    el.search.focus();
  } else if (e.key.toLowerCase() === "r") {
    loadPorts();
  }
});

// Pause polling while the window is hidden; resume on return.
document.addEventListener("visibilitychange", () => {
  state.paused = document.hidden || !el.modal.hidden;
  setAutoState();
  if (!state.paused) loadPorts();
});

// ----------------------------------------------------------------- boot

initTheme();
loadPorts();
setInterval(loadPorts, POLL_MS);
