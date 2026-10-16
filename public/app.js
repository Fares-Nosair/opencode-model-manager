const $ = id => document.getElementById(id);
const state = { providers: [], providerId: null, models: [], selected: new Set(), discoveredProviders: new Set(), busy: false, filterProvider: "all", editingId: null, health: new Map(), checkingAll: false, adapters: [], adapterProvider: null, adapterQuery: "" };
const keyOf = m => `${m.providerId}::${m.id}`;

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }

async function api(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${bad ? "toast-error" : "toast-ok"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4500);
}

function showAlert(message, tone = "error") {
  const el = $("alert");
  el.textContent = message;
  el.className = `alert alert-${tone}`;
  el.classList.remove("hidden");
}

function showProviderAlert(message, tone = "error") {
  const el = $("providerAlert");
  if (!el) return;
  el.textContent = message;
  el.className = `alert alert-${tone}`;
  el.classList.remove("hidden");
}

function clearAlert() { $("alert").className = "alert hidden"; $("alert").textContent = ""; }
function clearProviderAlert() { const el = $("providerAlert"); if (el) { el.className = "alert hidden"; el.textContent = ""; } }

function setBusy(v) {
  state.busy = v;
  $("discoverBtn").disabled = v || !state.providerId;
  $("discoverAllBtn").disabled = v || !state.providers.length;
  $("addProviderBtn").disabled = v;
  $("modelList").classList.toggle("is-busy", v);
  if (v) { $("selectAllBtn").disabled = true; $("selectNoneBtn").disabled = true; }
  else { updateCounts(); }
  $("discoverBtn").innerHTML = v ? '<span class="spinner"></span> Working…' : '<span class="button-symbol">↻</span> Discover provider';
}

function switchTab(which) {
  for (const t of ["models", "providers", "adapters"]) {
    const active = which === t;
    const btn = $(t === "models" ? "tabModels" : t === "providers" ? "tabProviders" : "tabAdapters");
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  $("modelsView").classList.toggle("hidden", which !== "models");
  $("providersView").classList.toggle("hidden", which !== "providers");
  $("adaptersView").classList.toggle("hidden", which !== "adapters");
  if (which === "providers") renderProviderCards();
  if (which === "adapters") loadAdapters();
}

function filteredModels() {
  const q = $("searchInput").value.trim().toLowerCase();
  return state.models.filter(m => (state.filterProvider === "all" || m.providerId === state.filterProvider) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.owned_by.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q)));
}

function updateCounts() {
  const shown = filteredModels();
  $("selectedCount").textContent = `${state.selected.size} selected`;
  $("visibleCount").textContent = `· ${shown.length} shown`;
  // Scope the badge to the active filter: a single provider shows only its own
  // models, "All providers" keeps the aggregate + fetch progress.
  const isAll = state.filterProvider === "all";
  const scoped = isAll ? state.models : state.models.filter(m => m.providerId === state.filterProvider);
  const scope = isAll
    ? `${state.discoveredProviders.size}/${state.providers.length} providers fetched`
    : state.discoveredProviders.has(state.filterProvider) ? "fetched" : "not fetched yet";
  $("modelCount").textContent = `${scoped.length} models · ${scope}`;
  $("selectAllBtn").disabled = !shown.length || state.busy;
  $("selectNoneBtn").disabled = !shown.some(m => state.selected.has(keyOf(m))) || state.busy;
  $("searchInput").disabled = !state.models.length;
}

function renderModels() {
  const list = $("modelList"), empty = $("emptyState");
  if (!state.models.length) {
    list.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = '<div class="empty-illustration">⌘</div><h4>Discover your models</h4><p>Use Discover all providers to load every configured API at once.</p>';
    updateCounts();
    return;
  }
  const models = filteredModels();
  empty.classList.toggle("hidden", models.length > 0);
  list.classList.toggle("hidden", models.length === 0);
  if (!models.length) empty.innerHTML = '<div class="empty-illustration">⌕</div><h4>No matching models</h4><p>Try another search or provider filter.</p>';
  list.innerHTML = models.map(m => {
    const k = keyOf(m), checked = state.selected.has(k);
    const off = isProviderDisabled(m.providerId);
    return `<label class="model-row ${checked ? "is-selected" : ""}${off ? " is-disabled" : ""}"${off ? ' title="Provider disabled — enable it to change models"' : ""}><input type="checkbox" data-key="${escapeHtml(k)}" ${checked ? "checked" : ""}${off ? " disabled" : ""}><span class="custom-check">${checked ? "✓" : ""}</span><span class="model-glyph">${m.id.toLowerCase().includes("gemini") ? "✦" : m.id.toLowerCase().includes("claude") ? "◈" : m.id.toLowerCase().includes("deepseek") ? "⌘" : "✳"}</span><span class="model-text"><strong>${escapeHtml(m.name)}</strong><small>${escapeHtml(m.id)} · ${escapeHtml(m.providerName)}${m.owned_by ? " · " + escapeHtml(m.owned_by) : ""}</small></span>${m.alreadyConfigured ? '<span class="model-tag">REGISTERED</span>' : ""}</label>`;
  }).join("");
  list.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", () => {
    const k = input.dataset.key;
    if (state.busy) { input.checked = !input.checked; return; }
    const m = state.models.find(x => keyOf(x) === k);
    if (!m || isProviderDisabled(m.providerId)) { input.checked = !input.checked; return; }
    if (input.checked) state.selected.add(k); else state.selected.delete(k);
    input.closest(".model-row").classList.toggle("is-selected", input.checked);
    input.nextElementSibling.textContent = input.checked ? "✓" : "";
    updateCounts();
    persistModelToggle(m, input);
  }));
  updateCounts();
}

function healthDot(id) {
  const h = state.health.get(id);
  if (!h) return `<span class="key-dot key-unknown" title="Not tested yet — click Test or Check all keys">○</span>`;
  if (h.testing) return `<span class="key-dot key-testing" title="Testing…">◌</span>`;
  if (h.ok) return `<span class="key-dot key-ok" title="OK — ${h.count} model(s) · ${h.latencyMs}ms">●</span>`;
  return `<span class="key-dot key-bad" title="Failed — ${escapeHtml(h.error || "unreachable")}">●</span>`;
}

function renderProviders() {
  $("providerCount").textContent = state.providers.length;
  const tabCount = $("providerCountTab");
  if (tabCount) tabCount.textContent = state.providers.length;
  const list = $("providerList");
  if (!state.providers.length) {
    list.innerHTML = '<div class="sidebar-empty">No providers yet. Add your first custom API.</div>';
    return;
  }
  const allActive = state.filterProvider === "all" ? "active" : "";
  let html = `<button class="provider-item ${allActive}" data-filter="all"><span class="provider-avatar">✳</span><span class="provider-info"><strong>All providers</strong><small>${state.models.length} discovered models</small></span><span class="provider-chevron">›</span></button>`;
  html += state.providers.map(p => {
    const active = p.id === state.filterProvider ? "active" : "";
    const h = state.health.get(p.id);
    const dot = !h ? "" : h.testing ? " · testing…" : h.ok ? ` · ${h.count} models` : " · test failed";
    return `<button class="provider-item ${active} ${p.disabled ? "is-disabled" : ""}" data-filter="${escapeHtml(p.id)}"><span class="provider-avatar">${escapeHtml((p.name || p.id).slice(0, 1).toUpperCase())}</span><span class="provider-info"><strong>${escapeHtml(p.name)}${p.disabled ? " · OFF" : ""}</strong><small>${escapeHtml(p.id)} · ${p.modelCount} registered${state.discoveredProviders.has(p.id) ? " · discovered" : ""}${dot}</small></span>${p.adapterEnabled ? `<span class="adapter-badge" data-adapter-link="${escapeHtml(p.id)}" title="Adapter enabled — open in Adapters tab">Adapter</span>` : ""}<span class="provider-chevron">›</span></button>`;
  }).join("");
  list.innerHTML = html;
  list.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => {
    state.filterProvider = b.dataset.filter;
    state.providerId = b.dataset.filter === "all" ? (state.providers[0]?.id || null) : b.dataset.filter;
    const p = state.providers.find(x => x.id === state.providerId);
    $("selectedProviderTitle").textContent = state.filterProvider === "all" ? "All providers" : (p?.name || state.providerId);
    $("endpointText").textContent = state.filterProvider === "all" ? "All configured /v1/models endpoints" : (p?.baseURL || "") + " → /v1/models";
    $("discoverBtn").disabled = state.busy || !state.providerId;
    renderProviders();
    renderModels();
  }));
  list.querySelectorAll("[data-adapter-link]").forEach(s => s.addEventListener("click", (e) => {
    e.stopPropagation();
    switchTab("adapters");
    selectAdapter(s.dataset.adapterLink, true);
  }));
}

function renderProviderCards() {
  const wrap = $("providerCards");
  if (!wrap) return;
  const tabCount = $("providerCountTab");
  if (tabCount) tabCount.textContent = state.providers.length;
  if (!state.providers.length) {
    wrap.innerHTML = '<div class="sidebar-empty">No providers yet. Click Add provider to create one.</div>';
    $("providerSummary").textContent = "0 providers";
    return;
  }
  const checked = [...state.health.values()].filter(h => !h.testing);
  const okCount = checked.filter(h => h.ok).length;
  const failCount = checked.length - okCount;
  const unknownCount = Math.max(0, state.providers.length - checked.length);
  const summary = [`${state.providers.length} provider${state.providers.length === 1 ? "" : "s"}`];
  if (okCount) summary.push(`${okCount} reachable`);
  if (failCount) summary.push(`${failCount} failed`);
  if (unknownCount) summary.push(`${unknownCount} unchecked`);
  $("providerSummary").textContent = summary.join(" · ");
  wrap.innerHTML = state.providers.map(p => {
    const h = state.health.get(p.id);
    const statusText = !h ? "Not tested" : h.testing ? "Testing…" : h.ok ? `${h.count} models · ${h.latencyMs}ms` : (h.error || "Failed");
    const statusClass = !h ? "st-unknown" : h.testing ? "st-testing" : h.ok ? "st-ok" : "st-bad";
    return `<div class="prov-card ${p.disabled ? "is-off" : ""}">
      <div class="prov-top">${healthDot(p.id)}<div class="prov-title"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.id)}${p.disabled ? " · DISABLED" : ""}</small></div>
      <label class="switch" title="${p.disabled ? "Enable" : "Disable"} ${escapeHtml(p.id)}"><input type="checkbox" data-toggle="${escapeHtml(p.id)}" ${p.disabled ? "" : "checked"}><span class="slider"></span></label></div>
      <div class="prov-meta"><span title="${escapeHtml(p.baseURL || "no baseURL")}">🌐 ${escapeHtml(p.baseURL || "no baseURL")}</span>${p.adapterEnabled && p.proxyUrl ? `<span class="mono-link" title="${escapeHtml(p.proxyUrl)}">🔗 Served via ${escapeHtml(p.proxyUrl)}</span>` : ""}<span>📦 ${escapeHtml(p.package)}</span><span>🧩 ${p.modelCount} models${p.hasApiKey ? " · 🔑 key saved" : " · no key"}</span><span class="prov-status ${statusClass}">${escapeHtml(statusText)}</span></div>
      <div class="prov-actions"><button class="button button-secondary btn-sm" data-test="${escapeHtml(p.id)}">Test</button><button class="button button-secondary btn-sm" data-editcard="${escapeHtml(p.id)}">Edit</button><button class="button button-danger btn-sm" data-delcard="${escapeHtml(p.id)}">Delete</button></div>
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", () => testProviderById(b.dataset.test)));
  wrap.querySelectorAll("[data-editcard]").forEach(b => b.addEventListener("click", () => openEditModal(b.dataset.editcard)));
  wrap.querySelectorAll("[data-delcard]").forEach(b => b.addEventListener("click", () => deleteProviderById(b.dataset.delcard)));
  wrap.querySelectorAll("[data-toggle]").forEach(t => t.addEventListener("change", () => toggleProvider(t.dataset.toggle, t.checked)));
}

function selectProvider(id) {
  state.providerId = id;
  state.filterProvider = id;
  const p = state.providers.find(x => x.id === id);
  $("selectedProviderTitle").textContent = p?.name || id;
  $("endpointText").textContent = (p?.baseURL || "") + " → /v1/models";
  $("discoverBtn").disabled = state.busy || !id;
  renderProviders();
  renderModels();
}

async function loadStatus() {
  const status = await api("/api/status");
  $("configPath").textContent = status.configPath;
  $("connectionText").textContent = "Config connected";
  $("removePluginBtn").classList.toggle("hidden", !status.pluginPresent);
  $("modeStatus").textContent = status.pluginPresent ? "Direct mode · plugin still configured" : "Direct model registration · no plugin";
}

async function removePlugin() {
  if (!confirm("Remove opencode-models-discovery from this global config and delete its modelsDiscovery settings?")) return;
  $("removePluginBtn").disabled = true;
  try {
    const r = await api("/api/disable-discovery-plugin", { method: "POST" });
    await loadStatus();
    showAlert(`Removed ${r.removedPluginEntries} plugin entry/entries.`, "ok");
    toast("Direct mode enabled.");
  } catch (e) { showAlert(e.message); }
  finally { $("removePluginBtn").disabled = false; }
}

async function refreshProviders(selectId = null) {
  const data = await api("/api/providers");
  state.providers = data.providers;
  renderProviders();
  renderProviderCards();
  if (selectId && state.providers.some(p => p.id === selectId)) selectProvider(selectId);
  else if (state.providerId && state.providers.some(p => p.id === state.providerId)) selectProvider(state.providerId);
  else if (state.providers.length) selectProvider(state.providers[0].id);
  else { $("selectedProviderTitle").textContent = "No providers yet"; $("discoverBtn").disabled = true; }
}

function mergeDiscovered(providerId, result) {
  const p = state.providers.find(x => x.id === providerId);
  state.models = state.models.filter(m => m.providerId !== providerId);
  const mapped = result.models.map(m => ({ ...m, providerId, providerName: p?.name || providerId }));
  state.models.push(...mapped);
  // Checkbox state mirrors the config: only already-registered models stay
  // checked. Stale keys for this provider are pruned; other providers kept.
  for (const k of [...state.selected]) if (k.startsWith(`${providerId}::`)) state.selected.delete(k);
  for (const m of mapped) if (m.alreadyConfigured) state.selected.add(keyOf(m));
  state.discoveredProviders.add(providerId);
}

function isProviderDisabled(providerId) {
  return !!state.providers.find(x => x.id === providerId)?.disabled;
}

const providerSaveQueue = new Map();
function persistProvider(providerId) {
  const prev = providerSaveQueue.get(providerId) || Promise.resolve();
  const next = prev.then(() => saveProviderNow(providerId));
  providerSaveQueue.set(providerId, next.catch(() => {}));
  return next;
}
async function saveProviderNow(providerId) {
  const models = state.models.filter(m => m.providerId === providerId);
  if (!models.length) return null;
  const selected = models.filter(m => state.selected.has(keyOf(m)));
  const metadata = Object.fromEntries(models.map(m => [m.id, { name: m.name }]));
  return await api("/api/models/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: providerId, discoveredIds: models.map(m => m.id), selectedIds: selected.map(m => m.id), metadata })
  });
}
function updateProviderCount(providerId, count) {
  if (typeof count !== "number") return;
  const p = state.providers.find(x => x.id === providerId);
  if (!p || p.modelCount === count) return;
  p.modelCount = count;
  renderProviders();
  renderProviderCards();
}
function setSaveState(mode) {
  const el = $("saveState");
  if (!el) return;
  const t = $("saveStateText");
  if (mode === "saving") { el.className = "save-state is-saving"; t.textContent = "Saving…"; }
  else if (mode === "saved") { el.className = "save-state is-saved"; t.textContent = `Saved ${new Date().toLocaleTimeString()}`; }
  else if (mode === "error") { el.className = "save-state is-error"; t.textContent = "Save failed"; }
  else { el.className = "save-state"; t.textContent = "Auto-save on"; }
}
function syncRowTag(input, configured) {
  const row = input.closest(".model-row");
  if (!row) return;
  const tag = row.querySelector(".model-tag");
  if (configured && !tag) {
    const s = document.createElement("span");
    s.className = "model-tag";
    s.textContent = "REGISTERED";
    row.appendChild(s);
  } else if (!configured && tag) {
    tag.remove();
  }
}
function persistModelToggle(m, input) {
  const k = keyOf(m);
  setSaveState("saving");
  persistProvider(m.providerId).then((r) => {
    m.alreadyConfigured = state.selected.has(k);
    syncRowTag(input, m.alreadyConfigured);
    updateProviderCount(m.providerId, r?.modelCount);
    updateCounts();
    setSaveState("saved");
  }).catch(e => {
    if (state.selected.has(k)) state.selected.delete(k);
    else state.selected.add(k);
    input.checked = !input.checked;
    input.closest(".model-row").classList.toggle("is-selected", input.checked);
    input.nextElementSibling.textContent = input.checked ? "✓" : "";
    updateCounts();
    setSaveState("error");
    toast(`Could not save: ${e.message}`, true);
  });
}
async function bulkSelect(on) {
  if (state.busy) return;
  const shown = filteredModels().filter(m => !isProviderDisabled(m.providerId));
  if (!shown.length) return;
  for (const m of shown) {
    const k = keyOf(m);
    if (on) state.selected.add(k);
    else state.selected.delete(k);
  }
  renderModels();
  setSaveState("saving");
  try {
    const ids = [...new Set(shown.map(m => m.providerId))];
    const results = await Promise.all(ids.map(pid => persistProvider(pid).then(r => [pid, r?.modelCount])));
    for (const [pid, count] of results) updateProviderCount(pid, count);
    for (const m of shown) m.alreadyConfigured = state.selected.has(keyOf(m));
    renderModels();
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
    toast(`Could not save: ${e.message}`, true);
    renderModels();
  }
}

async function discoverOne() {
  if (!state.providerId || state.busy) return;
  clearAlert();
  setBusy(true);
  try {
    const r = await api(`/api/models?provider=${encodeURIComponent(state.providerId)}`);
    mergeDiscovered(state.providerId, r);
    state.filterProvider = state.providerId;
    $("endpointText").textContent = r.endpoint;
    state.health.set(state.providerId, { ok: true, count: r.count, latencyMs: 0, testing: false });
    renderProviders();
    renderProviderCards();
    renderModels();
    toast(`Loaded ${r.count} models from ${state.providerId}.`);
  } catch (e) { showAlert(e.message); toast("Discovery failed.", true); }
  finally { setBusy(false); }
}

async function discoverAll() {
  if (!state.providers.length || state.busy) return;
  clearAlert();
  setBusy(true);
  let ok = 0, fail = [];
  try {
    const results = await Promise.all(state.providers.map(async p => {
      try { const r = await api(`/api/models?provider=${encodeURIComponent(p.id)}`); return { p, r }; }
      catch (e) { return { p, error: e.message }; }
    }));
    for (const item of results) {
      if (item.error) {
        fail.push(`${item.p.id}: ${item.error}`);
        state.health.set(item.p.id, { ok: false, count: 0, latencyMs: 0, error: item.error, testing: false });
        continue;
      }
      mergeDiscovered(item.p.id, item.r);
      state.health.set(item.p.id, { ok: true, count: item.r.count, latencyMs: 0, testing: false });
      ok++;
    }
    state.filterProvider = "all";
    state.providerId = state.providers[0]?.id || null;
    $("selectedProviderTitle").textContent = "All providers";
    $("endpointText").textContent = "All configured /v1/models endpoints";
    renderProviders();
    renderProviderCards();
    renderModels();
    if (fail.length) showAlert(`Loaded ${ok}/${state.providers.length} providers. Errors: ${fail.join(" | ")}`);
    toast(`Discovered ${state.models.length} models from ${ok} provider(s).`);
  } finally { setBusy(false); }
}

async function testProviderById(id) {
  state.health.set(id, { testing: true, ok: false, count: 0, latencyMs: 0 });
  renderProviderCards();
  renderProviders();
  try {
    const r = await api(`/api/providers/test?provider=${encodeURIComponent(id)}`);
    state.health.set(id, { ok: r.ok, count: r.count || 0, latencyMs: r.latencyMs || 0, error: r.error || "", testing: false, endpoint: r.endpoint || "" });
    if (r.ok) toast(`${id}: OK (${r.count} models, ${r.latencyMs}ms).`);
    else toast(`${id}: FAILED — ${r.error || "unreachable"}`, true);
  } catch (e) {
    state.health.set(id, { ok: false, count: 0, latencyMs: 0, error: e.message, testing: false });
    toast(`${id}: test failed — ${e.message}`, true);
  }
  renderProviderCards();
  renderProviders();
}

async function checkAllKeys() {
  if (!state.providers.length || state.checkingAll) return;
  state.checkingAll = true;
  clearProviderAlert();
  const btn = $("checkAllBtn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  for (const p of state.providers) state.health.set(p.id, { testing: true, ok: false, count: 0, latencyMs: 0 });
  renderProviderCards();
  renderProviders();
  try {
    const data = await api("/api/providers/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    for (const r of (data.results || [])) {
      state.health.set(r.id, { ok: !!r.ok, count: r.count || 0, latencyMs: r.latencyMs || 0, error: r.error || "", testing: false, endpoint: r.endpoint || "" });
    }
    const results = data.results || [];
    const total = results.length;
    const okN = results.filter(r => r.ok).length;
    const unreachable = results.filter(r => !r.ok).map(r => r.id);
    const noun = total === 1 ? "provider" : "providers";
    if (!unreachable.length) {
      showProviderAlert(`All ${total} ${noun} reachable.`, "ok");
      toast(`Key check: all ${total} ${noun} reachable.`);
    } else {
      showProviderAlert(`${okN} of ${total} ${noun} reachable — not reachable: ${unreachable.join(", ")}.`, "error");
      toast(`Key check: ${okN} of ${total} ${noun} reachable.`, true);
    }
  } catch (e) {
    showProviderAlert(e.message);
    toast("Check all failed.", true);
  } finally {
    state.checkingAll = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="button-symbol">✓</span> Check all keys';
    renderProviderCards();
    renderProviders();
  }
}

async function toggleProvider(id, enabled) {
  try {
    const r = await api("/api/providers/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: id, enabled }) });
    await refreshProviders();
    toast(`Provider ${id} ${r.disabled ? "disabled" : "enabled"}.`);
  } catch (e) {
    showProviderAlert(e.message);
    toast("Toggle failed.", true);
    await refreshProviders();
  }
}

function adapterEntry(id) {
  return state.adapters.find(a => a.provider === id) || null;
}

async function loadAdapters() {
  try {
    const data = await api("/api/adapters");
    state.adapters = data.adapters || [];
  } catch (e) {
    showAdapterAlert(e.message, true);
    state.adapters = [];
  }
  renderAdapterList();
  if (state.adapterProvider) fillAdapterForm(state.adapterProvider);
  else if (state.providers.length) selectAdapter(state.providers[0].id);
}

function showAdapterAlert(message, bad = true) {
  const el = $("adapterAlert");
  if (!el) return;
  el.textContent = message;
  el.className = `alert ${bad ? "alert-error" : "alert-warning"}`;
  el.classList.remove("hidden");
}

function clearAdapterAlert() {
  const el = $("adapterAlert");
  if (el) { el.className = "alert hidden"; el.textContent = ""; }
}

function filteredAdapters() {
  const q = state.adapterQuery.trim().toLowerCase();
  if (!q) return state.providers;
  return state.providers.filter(p => (p.name || "").toLowerCase().includes(q) || (p.id || "").toLowerCase().includes(q));
}

function renderAdapterList() {
  const list = $("adapterList");
  if (!list) return;
  const countEl = $("adapterSearchCount");
  if (!state.providers.length) {
    if (countEl) countEl.textContent = "0 providers";
    list.innerHTML = '<div class="sidebar-empty">No providers yet. Add a provider first.</div>';
    return;
  }
  const providers = filteredAdapters();
  if (countEl) {
    const n = providers.length, total = state.providers.length;
    countEl.textContent = n === total ? `${n} provider${n === 1 ? "" : "s"}` : `${n} of ${total} providers`;
  }
  if (!providers.length) {
    list.innerHTML = `<div class="sidebar-empty">No providers match “${escapeHtml(state.adapterQuery.trim())}”.</div>`;
    return;
  }
  list.innerHTML = providers.map(p => {
    const a = adapterEntry(p.id);
    const on = !!a?.enabled;
    const routed = !!a?.routed;
    const src = a?.apiKeySource || "incoming";
    const keyLabel = src.startsWith("env:")
      ? `key: env ${src.slice(4)}`
      : src === "stored"
        ? (a?.hasKey ? "key: stored ✓" : "key: stored (empty)")
        : "key: incoming Bearer";
    return `<div class="prov-card adapter-card ${on ? "" : "is-off"} ${state.adapterProvider === p.id ? "is-selected-card" : ""}">
      <div class="prov-top"><div class="prov-title"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.id)}</small></div>
      <span class="status-pill-sm ${on ? "pill-on" : "pill-off"}">${on ? "ENABLED" : "DISABLED"}</span>
      <span class="status-pill-sm ${routed ? "pill-routed" : "pill-direct"}" title="${routed ? "OpenCode sends requests through this proxy" : "Provider bypasses the proxy"}">${routed ? "ROUTED" : "DIRECT"}</span></div>
      <div class="prov-meta"><span class="mono-link">🔗 ${escapeHtml(a?.proxyUrl || "—")}</span><span>🌐 ${escapeHtml(a?.upstreamBaseURL || "— no upstream set —")}</span><span>🔑 ${escapeHtml(keyLabel)}${a?.defaultModel ? ` · 🧩 ${escapeHtml(a.defaultModel)}` : ""}</span></div>
      <div class="prov-actions"><button class="button ${on ? "button-secondary" : "button-primary"} btn-sm" data-adapter-toggle="${escapeHtml(p.id)}">${on ? "Disable" : "Enable"}</button><button class="button button-secondary btn-sm" data-adapter-config="${escapeHtml(p.id)}">Configure</button></div>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-adapter-toggle]").forEach(b => b.addEventListener("click", () => toggleAdapterQuick(b.dataset.adapterToggle)));
  list.querySelectorAll("[data-adapter-config]").forEach(b => b.addEventListener("click", () => selectAdapter(b.dataset.adapterConfig, true)));
}

function showAdapterFormError(message) {
  $("adapterFormError").textContent = message;
  $("adapterFormError").className = "alert alert-error";
}

async function toggleAdapterQuick(providerId) {
  const a = adapterEntry(providerId);
  const next = !(a?.enabled);
  if (next && !a?.upstreamBaseURL) {
    selectAdapter(providerId, true);
    showAdapterFormError("Set the upstream base URL first, then enable.");
    return;
  }
  clearAdapterAlert();
  try {
    await api("/api/adapters", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerId,
        enabled: next,
        upstreamBaseURL: a.upstreamBaseURL,
        headers: a.headers || {},
        dynamicHeaders: a.dynamicHeaders || {},
        bodyOverrides: a.bodyOverrides || {},
        defaultModel: a.defaultModel || "",
        timeoutMs: a.timeoutMs || 120000,
        apiKeySource: a.apiKeySource || "incoming"
      })
    });
    await refreshProviders();
    await loadAdapters();
    toast(next ? "Adapter enabled — provider now routes via the local proxy." : "Adapter disabled — provider restored to direct.");
  } catch (e) {
    showAdapterAlert(e.message, true);
  }
}

function selectAdapter(providerId, scrollToForm = false) {
  state.adapterProvider = providerId;
  renderAdapterList();
  fillAdapterForm(providerId);
  $("adapterFormPanel").classList.remove("hidden");
  const p = state.providers.find(x => x.id === providerId);
  $("adapterFormTitle").textContent = `Adapter: ${p?.name || providerId}`;
  if (scrollToForm) {
    try { $("adapterFormPanel").scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* ignore */ }
  }
}

async function copyProxyUrl() {
  const t = $("adapterProxyUrl").textContent;
  if (!t || t === "—") return;
  try {
    await navigator.clipboard.writeText(t);
    toast("Proxy URL copied.");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Proxy URL copied."); }
    catch { toast("Copy failed — select the URL manually.", true); }
    ta.remove();
  }
}

function fillAdapterForm(providerId) {
  const a = adapterEntry(providerId);
  if (!a) return;
  $("adEnabled").checked = !!a.enabled;
  const rawUpstream = a.upstreamBaseURL || "";
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/proxy\//.test(rawUpstream.trim())) {
    // Heal old data: a proxy URL was saved as the upstream. Don't use it —
    // ask for the real upstream URL instead.
    $("adUpstream").value = "";
    showAdapterAlert(`Adapter for "${providerId}" has a proxy URL saved as its upstream — enter the real upstream URL and Save.`, true);
  } else {
    $("adUpstream").value = rawUpstream;
  }
  $("adHeaders").value = JSON.stringify(a.headers || {}, null, 2);
  $("adDynHeaders").value = JSON.stringify(a.dynamicHeaders || {}, null, 2);
  $("adBody").value = JSON.stringify(a.bodyOverrides || {}, null, 2);
  $("adModel").value = a.defaultModel || "";
  $("adTimeout").value = a.timeoutMs || 120000;
  const src = a.apiKeySource || "incoming";
  if (src.startsWith("env:")) {
    $("adKeySource").value = "env";
    $("adEnvName").value = src.slice(4);
  } else {
    $("adKeySource").value = src === "stored" ? "stored" : "incoming";
    $("adEnvName").value = "";
  }
  $("adStoredKey").value = "";
  $("adStoredKey").placeholder = a.hasKey ? "Key saved — leave blank to keep" : "No key saved";
  $("adClearKey").checked = false;
  $("adapterProxyUrl").textContent = a.proxyUrl || "—";
  const pills = $("adapterStatusPills");
  if (pills) {
    const on = !!a.enabled, routed = !!a.routed;
    pills.innerHTML = `<span class="status-pill-sm ${on ? "pill-on" : "pill-off"}">${on ? "ENABLED" : "DISABLED"}</span> <span class="status-pill-sm ${routed ? "pill-routed" : "pill-direct"}">${routed ? "ROUTED" : "DIRECT"}</span>`;
  }
  $("adapterRoutedLine").textContent = a.routed
    ? "● Routed — OpenCode currently sends this provider through the local proxy."
    : (a.enabled
      ? "Enabled, but the provider base URL is not the proxy URL. Save again to route it."
      : "Direct — this provider bypasses the proxy.");
  updateKeySourceRows();
  $("adapterFormError").className = "alert alert-error hidden";
  $("adapterFormError").textContent = "";
}

function updateKeySourceRows() {
  const v = $("adKeySource").value;
  $("adEnvNameRow").classList.toggle("hidden", v !== "env");
  $("adStoredKeyRow").classList.toggle("hidden", v !== "stored");
  $("adClearKeyRow").classList.toggle("hidden", v !== "stored");
}

function parseAdapterJson(text, field) {
  if (!String(text).trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
    return parsed;
  } catch {
    throw new Error(`${field} must be a valid JSON object.`);
  }
}

async function applyAhefiPreset() {
  if (!state.adapterProvider) return;
  try {
    const data = await api("/api/adapters/preset");
    const p = data.preset;
    $("adUpstream").value = p.upstreamBaseURL || "";
    $("adHeaders").value = JSON.stringify(p.headers || {}, null, 2);
    $("adDynHeaders").value = JSON.stringify(p.dynamicHeaders || {}, null, 2);
    $("adBody").value = JSON.stringify(p.bodyOverrides || {}, null, 2);
    $("adModel").value = p.defaultModel || "";
    $("adTimeout").value = p.timeoutMs || 120000;
    toast("Ahefi preset applied. Review the key source, then Save.");
  } catch (e) {
    $("adapterFormError").textContent = e.message;
    $("adapterFormError").className = "alert alert-error";
  }
}

async function saveAdapter(event) {
  event.preventDefault();
  if (!state.adapterProvider) return;
  let payload;
  try {
    const src = $("adKeySource").value;
    payload = {
      provider: state.adapterProvider,
      enabled: $("adEnabled").checked,
      upstreamBaseURL: $("adUpstream").value.trim(),
      headers: parseAdapterJson($("adHeaders").value, "Static headers"),
      dynamicHeaders: parseAdapterJson($("adDynHeaders").value, "Dynamic headers"),
      bodyOverrides: parseAdapterJson($("adBody").value, "Body overrides"),
      defaultModel: $("adModel").value.trim(),
      timeoutMs: Number($("adTimeout").value),
      apiKeySource: src === "env" ? `env:${$("adEnvName").value.trim()}` : src,
      clearStoredKey: $("adClearKey").checked || undefined
    };
    if ($("adStoredKey").value !== "") payload.storedApiKey = $("adStoredKey").value;
  } catch (e) {
    $("adapterFormError").textContent = e.message;
    $("adapterFormError").className = "alert alert-error";
    return;
  }
  $("adapterFormError").className = "alert alert-error hidden";
  $("adapterSaveBtn").disabled = true;
  $("adapterSaveBtn").textContent = "Saving…";
  try {
    await api("/api/adapters", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await refreshProviders();
    await loadAdapters();
    toast("Adapter saved.");
    clearAdapterAlert();
  } catch (e) {
    $("adapterFormError").textContent = e.message;
    $("adapterFormError").className = "alert alert-error";
  } finally {
    $("adapterSaveBtn").disabled = false;
    $("adapterSaveBtn").textContent = "Save adapter";
  }
}

async function sendAdapterHi() {
  if (!state.adapterProvider) return;
  const btn = $("adapterTestBtn");
  const out = $("adapterTestOut");
  btn.disabled = true;
  out.textContent = "Sending…";
  out.className = "diag-out";
  try {
    const r = await api("/api/providers/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: state.adapterProvider })
    });
    if (r.ok) {
      out.textContent = `reply: ${r.reply}\nusage: ${JSON.stringify(r.usage ?? null)}\nlatency: ${r.latencyMs}ms\nstatus: ${r.status}`;
      out.className = "diag-out is-ok";
    } else {
      out.textContent = `error: ${r.error || "failed"}\nstatus: ${r.status ?? "?"}\nlatency: ${r.latencyMs ?? "?"}ms`;
      out.className = "diag-out is-err";
    }
  } catch (e) {
    out.textContent = `error: ${e.message}`;
    out.className = "diag-out is-err";
  } finally {
    btn.disabled = false;
  }
}

function openModal() {
  $("providerModal").classList.remove("hidden");
  $("formError").className = "alert alert-error hidden";
}

function closeModal() {
  $("providerModal").classList.add("hidden");
  state.editingId = null;
}

function openAddModal() {
  state.editingId = null;
  const form = $("providerForm");
  form.reset();
  form.elements.package.value = "@opencode-ai/ai/providers/openai-compatible";
  $("providerIdInput").disabled = false;
  $("modalTitle").textContent = "Add custom provider";
  $("modalIntro").textContent = "Add an OpenAI-compatible API. You can discover models immediately after saving.";
  $("providerApiKeyInput").placeholder = "Paste provider key";
  $("providerApiKeyInput").value = "";
  $("apiKeyHelp").textContent = "Stored in opencode.jsonc in plain text, like a normal provider config. Leave blank for unauthenticated APIs.";
  $("clearApiKeyRow").classList.add("hidden");
  $("clearApiKeyInput").checked = false;
  $("servedViaRow").classList.add("hidden");
  $("deleteProviderBtn").classList.add("hidden");
  $("addProviderBtn").textContent = "Add provider";
  $("formError").className = "alert alert-error hidden";
  $("formError").textContent = "";
  openModal();
}

async function openEditModal(id) {
  state.editingId = id;
  const form = $("providerForm");
  form.reset();
  $("formError").className = "alert alert-error hidden";
  $("formError").textContent = "";
  $("modalTitle").textContent = `Edit provider: ${id}`;
  $("modalIntro").textContent = "Update the ID, name, endpoint, key, package, or headers. Changing the ID renames the provider — model references (id/model) and any auth saved for the old ID do not follow automatically.";
  $("providerIdInput").disabled = false;
  $("clearApiKeyRow").classList.remove("hidden");
  $("clearApiKeyInput").checked = false;
  $("deleteProviderBtn").classList.remove("hidden");
  $("addProviderBtn").textContent = "Save changes";
  openModal();
  try {
    const data = await api(`/api/providers?provider=${encodeURIComponent(id)}`);
    const p = data.provider;
    form.elements.id.value = p.id;
    form.elements.name.value = p.name || "";
    form.elements.baseURL.value = p.baseURL || "";
    if (p.adapterEnabled && p.proxyUrl) {
      $("servedViaUrl").textContent = p.proxyUrl;
      $("servedViaRow").classList.remove("hidden");
    } else {
      $("servedViaRow").classList.add("hidden");
    }
    form.elements.package.value = p.package || "@opencode-ai/ai/providers/openai-compatible";
    form.elements.headersText.value = p.headersText || "";
    form.elements.apiKey.value = "";
    $("providerApiKeyInput").placeholder = p.hasApiKey ? "Key saved — leave blank to keep" : "No key saved — leave blank for none";
    $("apiKeyHelp").textContent = p.hasApiKey
      ? "A key is stored for this provider (hidden). Leave blank to keep it, enter a new one to replace, or check Remove to delete it."
      : "No key stored. Enter one to add it, or leave blank.";
  } catch (e) {
    $("formError").textContent = e.message;
    $("formError").className = "alert alert-error";
  }
}

// Client-side state follows a provider rename so selections, health and
// discovery flags don't get orphaned under the old id.
function migrateProviderState(fromId, toId) {
  state.models = state.models.map(m => (m.providerId === fromId ? { ...m, providerId: toId } : m));
  for (const k of [...state.selected]) {
    if (k.startsWith(`${fromId}::`)) {
      state.selected.delete(k);
      state.selected.add(`${toId}::${k.slice(fromId.length + 2)}`);
    }
  }
  if (state.discoveredProviders.has(fromId)) {
    state.discoveredProviders.delete(fromId);
    state.discoveredProviders.add(toId);
  }
  if (state.health.has(fromId)) {
    state.health.set(toId, state.health.get(fromId));
    state.health.delete(fromId);
  }
  if (state.filterProvider === fromId) state.filterProvider = toId;
  if (state.adapterProvider === fromId) state.adapterProvider = toId;
}
async function handleProviderSubmit(event) {
  event.preventDefault();
  const form = $("providerForm");
  const values = Object.fromEntries(new FormData(form).entries());
  if (!("clearApiKey" in values)) values.clearApiKey = false;
  $("formError").className = "alert alert-error hidden";
  $("formError").textContent = "";
  $("addProviderBtn").disabled = true;
  const isEdit = !!state.editingId;
  const originalId = state.editingId;
  if (isEdit) {
    values.originalId = originalId;
    if (!values.id) values.id = originalId;
  }
  $("addProviderBtn").textContent = isEdit ? "Saving…" : "Adding…";
  try {
    if (isEdit) {
      const r = await api("/api/providers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      if (originalId && originalId !== r.provider) migrateProviderState(originalId, r.provider);
      closeModal();
      await refreshProviders(r.provider);
      toast(originalId && originalId !== r.provider ? `Provider renamed ${originalId} → ${r.provider}.` : `Provider ${r.provider} updated.`);
    } else {
      const r = await api("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      closeModal();
      form.reset();
      form.elements.package.value = "@opencode-ai/ai/providers/openai-compatible";
      await refreshProviders(r.provider);
      toast(`Provider ${r.provider} added. Use Discover all providers to include it.`);
    }
  } catch (e) {
    $("formError").textContent = e.message;
    $("formError").className = "alert alert-error";
  } finally {
    $("addProviderBtn").disabled = false;
    $("addProviderBtn").textContent = isEdit ? "Save changes" : "Add provider";
  }
}

async function deleteProviderById(id) {
  if (!confirm(`Delete provider "${id}" from opencode.jsonc? Its registered models will also be removed.`)) return;
  clearAlert();
  clearProviderAlert();
  try {
    await api(`/api/providers?provider=${encodeURIComponent(id)}`, { method: "DELETE" });
    state.models = state.models.filter(m => m.providerId !== id);
    for (const k of [...state.selected]) { if (k.startsWith(`${id}::`)) state.selected.delete(k); }
    state.discoveredProviders.delete(id);
    state.health.delete(id);
    if (state.providerId === id) state.providerId = null;
    if (state.filterProvider === id) state.filterProvider = "all";
    if (state.editingId === id) closeModal();
    await refreshProviders();
    renderModels();
    toast(`Provider ${id} deleted.`);
  } catch (e) { showAlert(e.message); showProviderAlert(e.message); toast("Could not delete provider.", true); }
}

function deleteEditingProvider() {
  if (state.editingId) deleteProviderById(state.editingId);
}

$("discoverBtn").addEventListener("click", discoverOne);
$("discoverAllBtn").addEventListener("click", discoverAll);
$("removePluginBtn").addEventListener("click", removePlugin);
$("searchInput").addEventListener("input", renderModels);
$("selectAllBtn").addEventListener("click", () => bulkSelect(true));
$("selectNoneBtn").addEventListener("click", () => bulkSelect(false));
$("openAddProvider").addEventListener("click", openAddModal);
$("openAddProvider2").addEventListener("click", openAddModal);
$("closeModal").addEventListener("click", closeModal);
$("cancelAdd").addEventListener("click", closeModal);
$("deleteProviderBtn").addEventListener("click", deleteEditingProvider);
$("checkAllBtn").addEventListener("click", checkAllKeys);
$("tabModels").addEventListener("click", () => switchTab("models"));
$("tabProviders").addEventListener("click", () => switchTab("providers"));
$("tabAdapters").addEventListener("click", () => switchTab("adapters"));
$("adapterPresetBtn").addEventListener("click", applyAhefiPreset);
$("adapterSearch").addEventListener("input", () => { state.adapterQuery = $("adapterSearch").value; renderAdapterList(); });
$("adapterTestBtn").addEventListener("click", sendAdapterHi);
$("adapterCopyBtn").addEventListener("click", copyProxyUrl);
$("adapterForm").addEventListener("submit", saveAdapter);
$("adKeySource").addEventListener("change", updateKeySourceRows);
$("adStoredKey").addEventListener("input", () => { if ($("adStoredKey").value !== "") $("adClearKey").checked = false; });
$("providerApiKeyInput").addEventListener("input", () => { if ($("providerApiKeyInput").value) $("clearApiKeyInput").checked = false; });
$("providerForm").addEventListener("submit", handleProviderSubmit);
$("providerModal").addEventListener("click", e => { if (e.target === $("providerModal")) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

(async () => {
  try { await loadStatus(); await refreshProviders(); }
  catch (e) { $("connectionText").textContent = "Config error"; $("configPath").textContent = e.message; showAlert(e.message); }
})();
