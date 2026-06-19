/* ── State ──────────────────────────────────────────────────── */
let currentStatus  = "";
let currentView    = "grid";
let selectedIds    = new Set();
let debounceTimer  = null;
let currentModalId = null;
let allImages      = [];

/* ── Boot ───────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  setupDrop();
  loadImages();
  loadStats();
  loadLogs();
  setInterval(loadStats, 20000);
});

/* ── Tab Switching ──────────────────────────────────────────── */
function switchTab(name, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
  if (btn) btn.classList.add("active");
  if (name === "logs") loadLogs();
  if (name === "gallery") loadImages();
}

/* ── Status Filter ──────────────────────────────────────────── */
function setFilter(status, btn) {
  currentStatus = status;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  loadImages();
}

/* ── Load Images ────────────────────────────────────────────── */
function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadImages, 280);
}

async function loadImages() {
  const search = document.getElementById("search").value.trim();
  const params = new URLSearchParams();
  if (currentStatus) params.set("status", currentStatus);
  if (search)        params.set("search", search);

  allImages = await api(`/api/images?${params}`) || [];
  selectedIds.clear();
  updateBatchBar();

  const empty = document.getElementById("empty-state");
  const grid  = document.getElementById("grid-view");
  const tbody = document.getElementById("table-body");

  if (!allImages.length) {
    grid.innerHTML  = "";
    tbody.innerHTML = "";
    empty.style.display = "block";
    document.getElementById("gallery-sub").textContent = "No images found";
    return;
  }

  empty.style.display = "none";
  const lbl = currentStatus
    ? `${allImages.length} image${allImages.length !== 1 ? "s" : ""} — ${currentStatus.replace("_"," ")}`
    : `${allImages.length} image${allImages.length !== 1 ? "s" : ""} in dataset`;
  document.getElementById("gallery-sub").textContent = lbl;

  renderGrid(allImages);
  renderTable(allImages);
}

/* ── Render Grid ────────────────────────────────────────────── */
function renderGrid(images) {
  document.getElementById("grid-view").innerHTML = images.map(img => {
    const src  = `/uploads/${encodeURIComponent(img.filename)}`;
    const size = img.file_size ? fmtSize(img.file_size) : "";
    const info = [img.file_type?.split("/")[1]?.toUpperCase(), size].filter(Boolean).join(" · ");
    const tags = img.tags ? img.tags.split(",").map(t => `#${t.trim()}`).join(" ") : "";
    return `
    <div class="card" id="card-${img.id}" onclick="openModal('${img.id}')">
      <div class="card-img-wrap">
        <input type="checkbox" class="card-check"
          onclick="event.stopPropagation(); toggleSelect('${img.id}', this)"
          ${selectedIds.has(img.id) ? "checked" : ""}/>
        <img class="card-thumb" src="${src}" alt="${esc(img.filename)}" loading="lazy"
          onerror="this.parentElement.style.background='var(--surface3)'"/>
        <div class="card-status-bar ${img.status}"></div>
      </div>
      <div class="card-body">
        <div class="card-name" title="${esc(img.filename)}">${esc(img.filename)}</div>
        <div class="card-info">${info || "–"}</div>
        <div class="card-bottom">
          <span class="status-badge badge-${img.status}">${img.status.replace("_"," ")}</span>
        </div>
        ${tags ? `<div class="card-tags">${tags}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

/* ── Render Table ───────────────────────────────────────────── */
function renderTable(images) {
  document.getElementById("table-body").innerHTML = images.map(img => {
    const src  = `/uploads/${encodeURIComponent(img.filename)}`;
    const size = img.file_size ? fmtSize(img.file_size) : "–";
    const dims = img.width && img.height ? `${img.width}×${img.height}` : "–";
    const type = img.file_type?.split("/")[1]?.toUpperCase() || "–";
    return `<tr>
      <td><input type="checkbox" onchange="toggleSelect('${img.id}',this)" ${selectedIds.has(img.id)?"checked":""}></td>
      <td><img class="thumb-small" src="${src}" alt="" onerror="this.style.opacity=0"/></td>
      <td style="max-width:200px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(img.filename)}">${esc(img.filename)}</div></td>
      <td>${type}</td>
      <td>${size}</td>
      <td>${dims}</td>
      <td><span class="status-badge badge-${img.status}">${img.status.replace("_"," ")}</span></td>
      <td style="max-width:120px;font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${img.tags || "–"}</td>
      <td>
        <button class="act-btn" onclick="openModal('${img.id}')">Edit</button>
        <button class="act-btn" onclick="quickStatus('${img.id}','keep')">✓</button>
        <button class="act-btn" onclick="quickStatus('${img.id}','reject')">✕</button>
        <button class="act-btn danger" onclick="deleteImg('${img.id}')">🗑</button>
      </td>
    </tr>`;
  }).join("");
}

/* ── View Toggle ────────────────────────────────────────────── */
function setView(v) {
  currentView = v;
  document.getElementById("grid-view").style.display  = v === "grid"  ? "" : "none";
  document.getElementById("table-view").style.display = v === "table" ? "" : "none";
  document.getElementById("vt-grid").classList.toggle("active",  v === "grid");
  document.getElementById("vt-table").classList.toggle("active", v === "table");
}

/* ── Selection ──────────────────────────────────────────────── */
function toggleSelect(id, cb) {
  if (cb.checked) selectedIds.add(id);
  else            selectedIds.delete(id);
  document.getElementById(`card-${id}`)?.classList.toggle("selected", cb.checked);
  updateBatchBar();
}

function toggleSelectAll(cb) {
  document.querySelectorAll("#table-body input[type=checkbox]").forEach((el, i) => {
    el.checked = cb.checked;
    const id = allImages[i]?.id;
    if (id) cb.checked ? selectedIds.add(id) : selectedIds.delete(id);
  });
  updateBatchBar();
}

function clearSelection() {
  selectedIds.clear();
  document.querySelectorAll("input[type=checkbox]").forEach(el => el.checked = false);
  document.querySelectorAll(".card.selected").forEach(c => c.classList.remove("selected"));
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById("batch-bar");
  document.getElementById("batch-count").textContent = `${selectedIds.size} selected`;
  bar.style.display = selectedIds.size > 0 ? "" : "none";
}

/* ── Batch Actions ──────────────────────────────────────────── */
async function batchAction(action) {
  if (!selectedIds.size) return;
  if (action === "delete" && !confirm(`Permanently delete ${selectedIds.size} image(s)?`)) return;
  await api("/api/batch", "POST", { ids: [...selectedIds], action });
  const msg = action === "delete" ? `Deleted ${selectedIds.size} images` : `Marked ${selectedIds.size} as ${action}`;
  toast(msg, "ok");
  clearSelection();
  loadImages();
  loadStats();
}

/* ── Quick Status ───────────────────────────────────────────── */
async function quickStatus(id, status) {
  await api(`/api/images/${id}`, "PATCH", { status });
  toast(`Marked as ${status}`, "ok");
  loadImages();
  loadStats();
}

async function deleteImg(id) {
  if (!confirm("Delete this image permanently?")) return;
  await api(`/api/images/${id}`, "DELETE");
  toast("Image deleted", "ok");
  loadImages();
  loadStats();
}

/* ── Stats ──────────────────────────────────────────────────── */
async function loadStats() {
  const s = await api("/api/stats");
  if (!s) return;
  document.getElementById("s-total").textContent  = s.total;
  document.getElementById("s-keep").textContent   = s.keep;
  document.getElementById("s-reject").textContent = s.reject;
  document.getElementById("s-review").textContent = s.needs_review;
  document.getElementById("size-info").textContent = s.total_size_mb ? `${s.total_size_mb} MB used` : "";

  // Progress bar
  if (s.total > 0) {
    const prog = document.getElementById("review-progress");
    prog.style.display = "";
    document.getElementById("rp-keep").style.width   = (s.keep   / s.total * 100) + "%";
    document.getElementById("rp-reject").style.width = (s.reject / s.total * 100) + "%";
  }
}

/* ── Modal ──────────────────────────────────────────────────── */
async function openModal(id) {
  const img = allImages.find(i => i.id === id);
  if (!img) {
    // fallback: fetch fresh
    const fresh = await api(`/api/images?`) || [];
    const found = fresh.find(i => i.id === id);
    if (!found) return;
    openModalData(found);
    return;
  }
  openModalData(img);
}

function openModalData(img) {
  currentModalId = img.id;
  const src = `/uploads/${encodeURIComponent(img.filename)}`;

  document.getElementById("modal-img").src = src;
  document.getElementById("modal-open-link").href = src;
  document.getElementById("modal-title").textContent = img.filename;
  document.getElementById("modal-tags").value  = img.tags  || "";
  document.getElementById("modal-notes").value = img.notes || "";

  // Meta chips
  const chips = [
    img.file_type   ? `<span>Type</span>${img.file_type.split("/")[1]?.toUpperCase() || img.file_type}` : null,
    img.file_size   ? `<span>Size</span>${fmtSize(img.file_size)}` : null,
    img.width       ? `<span>Dims</span>${img.width}×${img.height}px` : null,
    img.file_hash   ? `<span>MD5</span>${img.file_hash.slice(0,10)}…` : null,
    img.imported_at ? `<span>Added</span>${img.imported_at.slice(0,10)}` : null,
  ].filter(Boolean);
  document.getElementById("modal-meta").innerHTML = chips.map(c => `<div class="meta-chip">${c}</div>`).join("");

  // Status buttons
  const statuses = [
    { key: "keep",         label: "✓ Keep" },
    { key: "reject",       label: "✕ Reject" },
    { key: "needs_review", label: "? Review" },
  ];
  document.getElementById("modal-status-btns").innerHTML = statuses.map(s =>
    `<button class="status-btn ${img.status === s.key ? `active-${s.key}` : ""}"
      data-status="${s.key}" onclick="pickStatus(this,'${s.key}')">${s.label}</button>`
  ).join("");

  document.getElementById("modal").classList.add("open");
  document.body.style.overflow = "hidden";
}

function pickStatus(btn, status) {
  document.querySelectorAll(".status-btn").forEach(b => {
    b.className = "status-btn";
  });
  btn.classList.add(`active-${status}`);
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
  document.body.style.overflow = "";
  currentModalId = null;
}

async function saveModal() {
  if (!currentModalId) return;
  const activeBtn = document.querySelector(".status-btn[class*='active-']");
  const status    = activeBtn?.dataset.status || null;
  const tags      = document.getElementById("modal-tags").value.trim();
  const notes     = document.getElementById("modal-notes").value.trim();
  const body = { tags, notes };
  if (status) body.status = status;
  await api(`/api/images/${currentModalId}`, "PATCH", body);
  toast("Changes saved!", "ok");
  closeModal();
  loadImages();
  loadStats();
}

// Keyboard: Escape closes modal
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

/* ── Drag & Drop ────────────────────────────────────────────── */
function setupDrop() {
  const zone = document.getElementById("drop-zone");
  if (!zone) return;
  ["dragenter","dragover"].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag-over"); })
  );
  ["dragleave","dragend"].forEach(ev =>
    zone.addEventListener(ev, () => zone.classList.remove("drag-over"))
  );
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    uploadFiles(e.dataTransfer.files);
  });
}

/* ── Import: Files ──────────────────────────────────────────── */
async function uploadFiles(files) {
  if (!files?.length) return;
  showProgress(5, `Uploading ${files.length} file(s)…`);
  const form = new FormData();
  [...files].forEach(f => form.append("images", f));
  const res = await apiFetch("/api/import/files", { method:"POST", body:form });
  showProgress(100, "Done!");
  showResults(res);
  loadImages(); loadStats();
  showImportBadge();
}

async function uploadZip(input) {
  const f = input.files[0]; if (!f) return;
  showProgress(10, `Extracting ${f.name}…`);
  const form = new FormData();
  form.append("zipfile", f);
  const res = await apiFetch("/api/import/zip", { method:"POST", body:form });
  showProgress(100, "Done!");
  showResults(res);
  loadImages(); loadStats();
  input.value = "";
  showImportBadge();
}

/* ── Import: URLs ───────────────────────────────────────────── */
async function importURLs() {
  const raw  = document.getElementById("url-input").value.trim();
  const urls = raw.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
  if (!urls.length) { toast("No valid URLs found", "err"); return; }
  showProgress(10, `Downloading ${urls.length} image(s)…`);
  const res = await api("/api/import/urls", "POST", { urls });
  showProgress(100, "Done!");
  showResults(res);
  loadImages(); loadStats();
  showImportBadge();
}

/* ── Import: Scrape ─────────────────────────────────────────── */
async function scrapePage() {
  const url = document.getElementById("scrape-url").value.trim();
  if (!url) { toast("Please enter a URL to scrape", "err"); return; }
  showProgress(15, "Scraping page for images…");
  const result = await api("/api/import/scrape", "POST", { url });
  showProgress(100, "Scraped!");
  if (!result || result.error) { toast(result?.error || "Failed", "err"); return; }

  const preview = document.getElementById("scrape-preview");
  preview.style.display = "";
  preview.innerHTML = `
    <div class="scrape-found">${result.count} images found on this page</div>
    <div class="scrape-url-list">
      ${result.urls.slice(0,12).map(u =>
        `<div class="scrape-url-item" onclick="addURL('${esc(u)}')" title="${esc(u)}">${u.length > 65 ? u.slice(0,65)+"…" : u}</div>`
      ).join("")}
    </div>
    ${result.count > 12 ? `<div class="scrape-more">…and ${result.count - 12} more</div>` : ""}
    <div style="margin-top:10px">
      <button class="btn-primary" style="font-size:12px" onclick="importAllScrape(${JSON.stringify(result.urls)})">Import All ${result.count}</button>
    </div>`;
}

function addURL(url) {
  const ta = document.getElementById("url-input");
  ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + url;
  toast("URL added — click Fetch Images to import", "info");
}

async function importAllScrape(urls) {
  showProgress(10, `Importing ${urls.length} scraped images…`);
  const res = await api("/api/import/urls", "POST", { urls });
  showProgress(100, "Done!");
  showResults(res);
  loadImages(); loadStats();
  showImportBadge();
}

/* ── Import: CSV ────────────────────────────────────────────── */
async function importCSV(input) {
  const f = input.files[0]; if (!f) return;
  const form = new FormData();
  form.append("csvfile", f);
  const result = await apiFetch("/api/import/csv", { method:"POST", body:form });
  if (!result?.urls?.length) { toast("No image URLs found in CSV", "err"); return; }
  document.getElementById("url-input").value = result.urls.join("\n");
  toast(`${result.urls.length} URLs loaded — click Fetch Images to import`, "info");
  input.value = "";
}

/* ── Progress & Results ─────────────────────────────────────── */
function showProgress(pct, label) {
  const block = document.getElementById("import-progress");
  block.style.display = "";
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("progress-label").textContent = label;
  document.getElementById("progress-pct").textContent = pct + "%";
}

function showResults(results) {
  if (!results?.length) return;
  const ok  = results.filter(r => !r.error && !r.duplicate).length;
  const dup = results.filter(r => r.duplicate).length;
  const err = results.filter(r => r.error).length;

  const el = document.getElementById("import-results");
  el.innerHTML = `<div class="ir-results-title">Import complete — ${ok} added, ${dup} duplicate${dup!==1?"s":""}, ${err} failed</div>` +
    results.map(r => {
      const cls   = r.error ? "err" : r.duplicate ? "dup" : "ok";
      const icon  = r.error ? "✕" : r.duplicate ? "⚠" : "✓";
      const label = r.error
        ? `${r.filename || r.url || "?"} — ${r.error}`
        : r.duplicate
          ? `${r.filename} is a duplicate of "${r.original_filename}"`
          : `${r.filename}`;
      return `<div class="import-row ${cls}"><span>${icon}</span><span class="ir-label">${label}</span></div>`;
    }).join("");
}

function showImportBadge() {
  const badge = document.getElementById("import-badge");
  if (badge) badge.style.display = "";
  setTimeout(() => { if (badge) badge.style.display = "none"; }, 5000);
}

/* ── Duplicates ─────────────────────────────────────────────── */
async function loadDuplicates() {
  const el = document.getElementById("dup-results");
  el.innerHTML = `<div style="color:var(--text-2);padding:16px 0">Scanning for duplicates…</div>`;
  const groups = await api("/api/duplicates") || [];

  if (!groups.length) {
    el.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;text-align:center">
        <div style="font-size:36px;margin-bottom:12px">✅</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">No near-duplicates found</div>
        <div style="color:var(--text-2);font-size:13px">All images in your dataset are visually distinct.</div>
      </div>`;
    return;
  }

  el.innerHTML = groups.map((g, i) => `
    <div class="dup-group">
      <div class="dup-group-header">
        <div>
          <div class="dup-group-title">Group ${i+1} — ${g.length} similar images</div>
          <div class="dup-group-sub">Click an image to review and decide which to keep</div>
        </div>
      </div>
      <div class="dup-thumbs">
        ${g.map(img => `
          <div class="dup-thumb">
            <img src="/uploads/${encodeURIComponent(img.filename)}" alt=""
              onclick="openModal('${img.id}')" title="Click to review"/>
            <p title="${img.filename}">${img.filename}</p>
          </div>`).join("")}
      </div>
    </div>`).join("");
}

/* ── Logs ───────────────────────────────────────────────────── */
async function loadLogs() {
  const rows = await api("/api/logs") || [];
  const colors = { IMPORT:"var(--keep)", DELETE:"var(--reject)", UPDATE:"var(--accent-l)", EXPORT:"var(--review)", BATCH:"var(--review)", SCRAPE:"#22d3ee" };
  document.getElementById("log-body").innerHTML = rows.length
    ? rows.map(r => `
      <tr>
        <td style="color:var(--text-3);font-size:12px">${r.id}</td>
        <td style="white-space:nowrap;color:var(--text-3);font-size:12px">${r.created_at?.slice(0,19).replace("T"," ") || "–"}</td>
        <td><code style="color:${colors[r.action.split("_")[0]] || "var(--text-2)"}">${r.action}</code></td>
        <td style="color:var(--text-2);font-size:12px">${r.detail || "–"}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:30px">No activity yet</td></tr>`;
}

/* ── Export ─────────────────────────────────────────────────── */
function exportData(type) {
  const q = currentStatus ? `?status=${currentStatus}` : "";
  window.location.href = `/api/export/${type}${q}`;
  toast(`Downloading ${type.toUpperCase()}…`, "info");
}

/* ── Utilities ──────────────────────────────────────────────── */
function fmtSize(b) {
  if (b < 1024)     return `${b} B`;
  if (b < 1048576)  return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}

function esc(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function toast(msg, type = "ok") {
  const el   = document.getElementById("toast");
  const icon = { ok:"✓", err:"✕", info:"ℹ" }[type] || "";
  document.getElementById("toast-icon").textContent = icon;
  document.getElementById("toast-msg").textContent  = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = "toast", 3500);
}

async function api(url, method = "GET", body = null) {
  return apiFetch(url, {
    method,
    headers: body ? { "Content-Type":"application/json" } : undefined,
    body:    body ? JSON.stringify(body) : undefined,
  });
}

async function apiFetch(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch(e) {
    console.error(e);
    toast("Something went wrong: " + e.message, "err");
    return null;
  }
}
