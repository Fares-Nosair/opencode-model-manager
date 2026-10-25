const $ = id => document.getElementById(id);
const state = {
  providers: [],
  providerId: null,
  models: [],
  selected: new Set(),
  discoveredProviders: new Set(),
  busy: false,
  filterProvider: "all",
  filterStatus: "all",
  sortMode: "az",
  viewMode: (typeof localStorage !== "undefined" && localStorage.getItem("opencode_view_mode")) || "flat",
  activeTab: (typeof localStorage !== "undefined" && localStorage.getItem("opencode_active_tab")) || "models",
  collapsedFamilies: new Set(),
  editingId: null,
  health: new Map(),
  checkingAll: false,
  adapters: [],
  adapterProvider: null,
  adapterQuery: "",
  presets: {},
  activityTimer: null,
  toastTimer: null,
  undoSnapshot: null,
  failedProviders: [],
  playground: { provider: null, model: null },
  pgSearchActiveIndex: -1,
  benchmarkSelected: new Set(),
  mcp: { servers: {}, presets: [] },
  mcpHealth: new Map(),
  editingMcpId: null
};

const keyOf = m => `${m.providerId}::${m.id}`;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

async function api(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function toast(message, bad = false, actionText = null, actionCallback = null) {
  const el = $("toast");
  el.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);

  if (actionText && actionCallback) {
    const btn = document.createElement("button");
    btn.className = "button button-secondary btn-sm";
    btn.style.marginLeft = "10px";
    btn.style.padding = "3px 8px";
    btn.textContent = actionText;
    btn.onclick = (e) => {
      e.stopPropagation();
      actionCallback();
      el.classList.add("hidden");
    };
    el.appendChild(btn);
  }

  el.className = `toast ${bad ? "toast-error" : "toast-ok"}`;
  el.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add("hidden"), 5000);
}

function renderAlertContent(el, message, tone, errorItems) {
  el.className = `alert alert-${tone}`;
  el.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "alert-bar";

  const summary = document.createElement("div");
  summary.className = "alert-bar-summary";
  const icon = tone === "ok" ? "✓" : tone === "warning" ? "⚠" : "✕";
  summary.innerHTML = `<span class="alert-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  bar.appendChild(summary);

  const actions = document.createElement("div");
  actions.className = "alert-actions";

  let detailsBox = null;
  if (Array.isArray(errorItems) && errorItems.length > 0) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "alert-retry-btn";
    retryBtn.innerHTML = `↻ Retry Failed (${errorItems.length})`;
    retryBtn.addEventListener("click", () => {
      const ids = errorItems.map(item => typeof item === "string" ? item : (item.id || item.provider)).filter(Boolean);
      retryFailedProviders(ids);
    });
    actions.appendChild(retryBtn);

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "alert-expand-btn";
    expandBtn.innerHTML = `Details ▾ (${errorItems.length})`;

    detailsBox = document.createElement("div");
    detailsBox.className = "alert-details-content hidden";
    const ul = document.createElement("ul");
    for (const item of errorItems) {
      const li = document.createElement("li");
      if (typeof item === "string") {
        li.textContent = item;
      } else if (item && typeof item === "object") {
        const id = item.id || item.provider || "";
        const errText = item.error || item.message || JSON.stringify(item);
        li.innerHTML = `<strong>${escapeHtml(id)}:</strong> <span>${escapeHtml(errText)}</span>`;
      }
      ul.appendChild(li);
    }
    detailsBox.appendChild(ul);

    expandBtn.addEventListener("click", () => {
      const isHidden = detailsBox.classList.contains("hidden");
      detailsBox.classList.toggle("hidden", !isHidden);
      expandBtn.innerHTML = !isHidden ? `Details ▾ (${errorItems.length})` : `Details ▴ (${errorItems.length})`;
    });

    actions.appendChild(expandBtn);
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "alert-dismiss-btn";
  dismissBtn.innerHTML = "×";
  dismissBtn.title = "Dismiss alert";
  dismissBtn.onclick = () => {
    el.className = "alert hidden";
    el.innerHTML = "";
  };
  actions.appendChild(dismissBtn);

  bar.appendChild(actions);
  el.appendChild(bar);
  if (detailsBox) el.appendChild(detailsBox);

  el.classList.remove("hidden");
}

function showAlert(message, tone = "error", errorItems = null) {
  const el = $("alert");
  if (!el) return;
  renderAlertContent(el, message, tone, errorItems);
}

function showProviderAlert(message, tone = "error", errorItems = null) {
  const el = $("providerAlert");
  if (!el) return;
  renderAlertContent(el, message, tone, errorItems);
}

function clearAlert() { const el = $("alert"); if (el) { el.className = "alert hidden"; el.innerHTML = ""; } }
function clearProviderAlert() { const el = $("providerAlert"); if (el) { el.className = "alert hidden"; el.innerHTML = ""; } }

function setBusy(v) {
  state.busy = v;
  $("discoverBtn").disabled = v || !state.providerId;
  $("discoverAllBtn").disabled = v || !state.providers.length;
  $("addProviderBtn").disabled = v;
  $("modelList").classList.toggle("is-busy", v);
  if (v) {
    $("selectAllBtn").disabled = true;
    $("selectNoneBtn").disabled = true;
    if ($("selectConfiguredBtn")) $("selectConfiguredBtn").disabled = true;
  } else {
    updateCounts();
  }
  $("discoverBtn").innerHTML = v ? '<span class="spinner"></span> Working…' : '<span class="button-symbol">↻</span> Discover provider';
}

function switchTab(which) {
  if (state.activityTimer) {
    clearInterval(state.activityTimer);
    state.activityTimer = null;
  }

  const validTabs = ["models", "providers", "adapters", "activity", "mcp"];
  const targetTab = validTabs.includes(which) ? which : "models";
  state.activeTab = targetTab;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-active-tab", targetTab);
  }

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("opencode_active_tab", targetTab);
    }
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", `#${targetTab}`);
    }
  } catch { /* best effort */ }

  for (const t of validTabs) {
    const active = targetTab === t;
    const btn = $(t === "models" ? "tabModels" : t === "providers" ? "tabProviders" : t === "adapters" ? "tabAdapters" : t === "activity" ? "tabActivity" : "tabMcp");
    if (btn) {
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  $("modelsView")?.classList.toggle("hidden", targetTab !== "models");
  $("providersView")?.classList.toggle("hidden", targetTab !== "providers");
  $("adaptersView")?.classList.toggle("hidden", targetTab !== "adapters");
  $("activityView")?.classList.toggle("hidden", targetTab !== "activity");
  $("mcpView")?.classList.toggle("hidden", targetTab !== "mcp");

  if (targetTab === "providers") renderProviderCards();
  if (targetTab === "adapters") loadAdapters();
  if (targetTab === "mcp") loadMcpServers();
  if (targetTab === "activity") {
    loadActivityLogs();
    state.activityTimer = setInterval(loadActivityLogs, 3000);
  }
}

async function copyModelId(id) {
  try {
    await navigator.clipboard.writeText(id);
    toast(`Copied model ID: ${id}`);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = id;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(`Copied model ID: ${id}`);
    } catch {
      toast("Copy failed — copy manually.", true);
    }
    ta.remove();
  }
}

function filteredModels() {
  const q = $("searchInput").value.trim().toLowerCase();
  let list = state.models.filter(m => {
    // Provider filter
    if (state.filterProvider !== "all" && m.providerId !== state.filterProvider) return false;
    // Status/Capability filter
    if (state.filterStatus === "configured" && !state.selected.has(keyOf(m))) return false;
    if (state.filterStatus === "unconfigured" && state.selected.has(keyOf(m))) return false;
    if (state.filterStatus === "reasoning" && !(m.capabilities?.reasoning || m.tags?.includes("REASONING"))) return false;
    if (state.filterStatus === "vision" && !(m.capabilities?.vision || m.tags?.includes("VISION"))) return false;
    if (state.filterStatus === "tools" && !(m.capabilities?.tools || m.tags?.includes("TOOLS"))) return false;
    if (state.filterStatus === "embed" && !(m.capabilities?.embedding || m.tags?.includes("EMBED"))) return false;
    // Search query
    if (q) {
      const match = m.id.toLowerCase().includes(q) ||
                    m.name.toLowerCase().includes(q) ||
                    m.owned_by.toLowerCase().includes(q) ||
                    m.providerName.toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  // Sorting
  if (state.sortMode === "za") {
    list.sort((a, b) => b.id.localeCompare(a.id));
  } else if (state.sortMode === "provider") {
    list.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.id.localeCompare(b.id));
  } else if (state.sortMode === "configured") {
    list.sort((a, b) => {
      const aOn = state.selected.has(keyOf(a)) ? 1 : 0;
      const bOn = state.selected.has(keyOf(b)) ? 1 : 0;
      return bOn - aOn || a.id.localeCompare(b.id);
    });
  } else {
    list.sort((a, b) => a.id.localeCompare(b.id));
  }

  return list;
}

function updateCounts() {
  const shown = filteredModels();
  $("selectedCount").textContent = `${state.selected.size} selected`;
  $("visibleCount").textContent = `· ${shown.length} shown`;

  const isAll = state.filterProvider === "all";
  const scoped = isAll ? state.models : state.models.filter(m => m.providerId === state.filterProvider);
  const scope = isAll
    ? `${state.discoveredProviders.size}/${state.providers.length} providers fetched`
    : state.discoveredProviders.has(state.filterProvider) ? "fetched" : "not fetched yet";
  $("modelCount").textContent = `${scoped.length} models · ${scope}`;

  // Update filter chip counters
  const allCount = scoped.length;
  const confCount = scoped.filter(m => state.selected.has(keyOf(m))).length;
  const reasonCount = scoped.filter(m => m.capabilities?.reasoning || m.tags?.includes("REASONING")).length;
  const visionCount = scoped.filter(m => m.capabilities?.vision || m.tags?.includes("VISION")).length;
  const toolsCount = scoped.filter(m => m.capabilities?.tools || m.tags?.includes("TOOLS")).length;
  const embedCount = scoped.filter(m => m.capabilities?.embedding || m.tags?.includes("EMBED")).length;

  if ($("chipCountAll")) $("chipCountAll").textContent = allCount;
  if ($("chipCountConfigured")) $("chipCountConfigured").textContent = confCount;
  if ($("chipCountReasoning")) $("chipCountReasoning").textContent = reasonCount;
  if ($("chipCountVision")) $("chipCountVision").textContent = visionCount;
  if ($("chipCountTools")) $("chipCountTools").textContent = toolsCount;
  if ($("chipCountEmbed")) $("chipCountEmbed").textContent = embedCount;

  $("selectAllBtn").disabled = !shown.length || state.busy;
  $("selectNoneBtn").disabled = !shown.some(m => state.selected.has(keyOf(m))) || state.busy;
  if ($("selectConfiguredBtn")) {
    $("selectConfiguredBtn").disabled = !shown.some(m => m.alreadyConfigured) || state.busy;
  }
  $("searchInput").disabled = !state.models.length;
}

const MODEL_LOGOS = {
  openai: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>',
  claude: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>',
  gemini: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>',
  deepseek: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-1.009-.43 1.3 1.3 0 01-.351-1.026 1.258 1.258 0 01.521-.956c.407-.294.9-.387 1.393-.257.251.067.488.196.674.376.438.423.593 1.042.412 1.62-.124.397-.379.743-.728.947-.119.07-.243.13-.377.18z"/></svg>',
  meta: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z"/></svg>',
  mistral: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z"/></svg>',
  qwen: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z"/></svg>',
  cohere: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.128 14.099c.592 0 1.77-.033 3.398-.703 1.897-.781 5.672-2.2 8.395-3.656 1.905-1.026 2.378-2.613 1.417-3.791-.96-1.178-2.784-1.353-4.689-.526-1.896.824-5.597 2.457-8.243 3.916-1.859 1.026-2.316 2.593-1.373 3.771.551.688 1.42 1.039 2.495 1.039zm3.018 3.997c.593 0 1.77-.033 3.399-.703 1.896-.781 5.671-2.2 8.394-3.656 1.905-1.026 2.379-2.613 1.418-3.791-.96-1.178-2.784-1.353-4.689-.526-1.896.824-5.597 2.457-8.243 3.916-1.859 1.026-2.316 2.593-1.373 3.771.551.688 1.42 1.039 2.494 1.039zM3.486 9.873c.592 0 1.77-.033 3.398-.703 1.897-.781 5.672-2.2 8.395-3.656 1.905-1.026 2.378-2.613 1.417-3.791C15.736.545 13.912.37 12.007 1.197c-1.896.824-5.597 2.457-8.243 3.916-1.859 1.026-2.316 2.593-1.373 3.771.551.688 1.42 1.039 2.495 1.039z"/></svg>',
  groq: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z"/></svg>',
  ollama: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"/></svg>',
  stability: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M7.223 21c4.252 0 7.018-2.22 7.018-5.56 0-2.59-1.682-4.236-4.69-4.918l-1.93-.571c-1.694-.375-2.683-.825-2.45-1.975.194-.957.773-1.497 2.122-1.497 4.285 0 5.873 1.497 5.873 1.497v-3.6S11.62 3 7.293 3C3.213 3 1 5.07 1 8.273c0 2.59 1.534 4.097 4.645 4.812l.334.083c.473.144 1.112.335 1.916.572 1.59.375 1.999.773 1.999 1.966 0 1.09-1.15 1.71-2.67 1.71C2.841 17.416 1 15.231 1 15.231v3.989S2.152 21 7.223 21z"/><path d="M20.374 20.73c1.505 0 2.626-1.073 2.626-2.526 0-1.484-1.089-2.526-2.626-2.526-1.505 0-2.594 1.042-2.594 2.526 0 1.484 1.089 2.526 2.594 2.526z"/></svg>',
  microsoft: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2 2h9v9H2V2zm11 0h9v9h-9V2zM2 13h9v9H2v-9zm11 0h9v9h-9v-9z"/></svg>',
  default: '<svg class="model-logo-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/></svg>'
};

function getModelLogoSvg(modelId = "", providerName = "") {
  const m = (modelId || "").toLowerCase();
  const p = (providerName || "").toLowerCase();
  const combined = `${m} ${p}`;

  // 1. Anthropic Claude
  if (combined.includes("claude") || combined.includes("anthropic")) return MODEL_LOGOS.claude;

  // 2. DeepSeek
  if (combined.includes("deepseek") || /(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(combined)) return MODEL_LOGOS.deepseek;

  // 3. Google Gemini & Gemma
  if (combined.includes("gemini") || combined.includes("gemma") || combined.includes("palm-")) return MODEL_LOGOS.gemini;

  // 4. OpenAI
  if (combined.includes("gpt") || combined.includes("openai") || combined.includes("chatgpt") || /(^|[^a-z0-9])o[13](-[a-z0-9]+)?([^a-z0-9]|$)/.test(m) || combined.includes("text-embedding") || combined.includes("dall-e")) return MODEL_LOGOS.openai;

  // 5. Qwen (Alibaba)
  if (combined.includes("qwen") || combined.includes("qwq") || combined.includes("tongyi") || combined.includes("alibaba")) return MODEL_LOGOS.qwen;

  // 6. Mistral AI
  if (combined.includes("mistral") || combined.includes("mixtral") || combined.includes("codestral") || combined.includes("pixtral")) return MODEL_LOGOS.mistral;

  // 7. Meta Llama (careful: 'ollama' contains 'llama')
  if (m.includes("llama") || m.includes("meta-") || m.includes("codellama") || p === "meta" || p.includes("meta-llama")) return MODEL_LOGOS.meta;

  // 8. Cohere
  if (combined.includes("cohere") || combined.includes("command-")) return MODEL_LOGOS.cohere;

  // 9. Groq
  if (combined.includes("groq")) return MODEL_LOGOS.groq;

  // 10. Microsoft / Phi
  if (combined.includes("phi-") || combined.includes("phi3") || combined.includes("phi4") || combined.includes("microsoft") || combined.includes("azure")) return MODEL_LOGOS.microsoft;

  // 11. Stability AI / Image Diffusion
  if (combined.includes("diffusion") || combined.includes("flux") || combined.includes("stability") || combined.includes("sdxl")) return MODEL_LOGOS.stability;

  // 12. Ollama
  if (combined.includes("ollama")) return MODEL_LOGOS.ollama;

  return MODEL_LOGOS.default;
}

function getModelFamily(modelId, providerName = "") {
  const m = String(modelId || "").toLowerCase();
  const p = String(providerName || "").toLowerCase();
  const combined = `${m} ${p}`;

  if (combined.includes("claude") || combined.includes("anthropic")) {
    return { id: "claude", name: "Anthropic / Claude", logo: MODEL_LOGOS.claude };
  }
  if (combined.includes("gpt") || combined.includes("o1") || combined.includes("o3") || combined.includes("chatgpt") || combined.includes("openai") || combined.includes("text-embedding")) {
    return { id: "openai", name: "OpenAI / GPT", logo: MODEL_LOGOS.openai };
  }
  if (combined.includes("deepseek") || /(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(combined)) {
    return { id: "deepseek", name: "DeepSeek", logo: MODEL_LOGOS.deepseek };
  }
  if (combined.includes("qwen") || combined.includes("qwq") || combined.includes("tongyi") || combined.includes("alibaba")) {
    return { id: "qwen", name: "Alibaba / Qwen", logo: MODEL_LOGOS.qwen };
  }
  if (combined.includes("glm") || combined.includes("zhipu") || combined.includes("chatglm")) {
    return { id: "glm", name: "Zhipu / GLM", logo: MODEL_LOGOS.default };
  }
  if (m.includes("llama") || m.includes("meta-") || m.includes("codellama") || p === "meta" || p.includes("meta-llama")) {
    return { id: "llama", name: "Meta / Llama", logo: MODEL_LOGOS.meta };
  }
  if (combined.includes("gemini") || combined.includes("gemma") || combined.includes("google")) {
    return { id: "gemini", name: "Google / Gemini", logo: MODEL_LOGOS.gemini };
  }
  if (combined.includes("mistral") || combined.includes("mixtral") || combined.includes("codestral") || combined.includes("pixtral")) {
    return { id: "mistral", name: "Mistral AI", logo: MODEL_LOGOS.mistral };
  }
  if (combined.includes("minimax")) {
    return { id: "minimax", name: "MiniMax", logo: MODEL_LOGOS.default };
  }
  if (combined.includes("nemotron") || combined.includes("nvidia")) {
    return { id: "nvidia", name: "Nvidia / Nemotron", logo: MODEL_LOGOS.default };
  }
  return { id: "other", name: "Other Models", logo: MODEL_LOGOS.default };
}

function renderModelRowHtml(m) {
  const k = keyOf(m), checked = state.selected.has(k);
  const off = isProviderDisabled(m.providerId);
  const tagsHtml = (m.tags || []).map(t => {
    const cls = t === "REASONING" ? "tag-reasoning" : t === "VISION" ? "tag-vision" : t === "TOOLS" ? "tag-tools" : t === "EMBED" ? "tag-embed" : "";
    return `<span class="model-tag ${cls}">${t}</span>`;
  }).join("");

  return `<label class="model-row ${checked ? "is-selected" : ""}${off ? " is-disabled" : ""}"${off ? ' title="Provider disabled — enable it to change models"' : ""}>
    <input type="checkbox" data-key="${escapeHtml(k)}" ${checked ? "checked" : ""}${off ? " disabled" : ""}>
    <span class="custom-check">${checked ? "✓" : ""}</span>
    <span class="model-glyph" title="${escapeHtml(m.providerName || m.id)}">${getModelLogoSvg(m.id, m.providerName)}</span>
    <span class="model-text">
      <strong title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</strong>
      <small title="${escapeHtml(m.id)}">${escapeHtml(m.id)} · ${escapeHtml(m.providerName)}${m.owned_by ? " · " + escapeHtml(m.owned_by) : ""}</small>
      <span class="model-tags-row">${tagsHtml}${m.alreadyConfigured ? '<span class="model-tag tag-registered">REGISTERED</span>' : ""}</span>
    </span>
    <div class="model-actions-end">
      <button type="button" class="model-test-btn" data-testmodel="${escapeHtml(m.id)}" data-testprovider="${escapeHtml(m.providerId)}" title="Test model chat">⚡ Test</button>
      <button type="button" class="copy-model-btn" data-copyid="${escapeHtml(m.id)}" title="Copy model ID">⎘</button>
    </div>
  </label>`;
}

function bindModelListEvents(container) {
  container.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", () => {
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

  container.querySelectorAll(".copy-model-btn").forEach(btn => btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyModelId(btn.dataset.copyid);
  }));

  container.querySelectorAll(".model-test-btn").forEach(btn => btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openModelPlayground(btn.dataset.testprovider, btn.dataset.testmodel);
  }));

  // Family head accordion collapse
  container.querySelectorAll("[data-familyhead]").forEach(head => {
    head.addEventListener("click", e => {
      if (e.target.closest(".family-group-action")) return;
      const famId = head.dataset.familyhead;
      const group = head.closest(".family-group");
      if (group) {
        const isCollapsed = group.classList.toggle("is-collapsed");
        if (isCollapsed) state.collapsedFamilies.add(famId);
        else state.collapsedFamilies.delete(famId);
      }
    });
  });

  // Family batch select
  container.querySelectorAll("[data-selectfam]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const famId = btn.dataset.selectfam;
      const famModels = filteredModels().filter(m => getModelFamily(m.id, m.providerName).id === famId);
      for (const m of famModels) {
        if (!isProviderDisabled(m.providerId)) state.selected.add(keyOf(m));
      }
      renderModels();
      toast(`Selected all ${famModels.length} models in ${famId}`);
      const affected = [...new Set(famModels.map(m => m.providerId))];
      affected.forEach(pid => persistProvider(pid));
    });
  });

  // Family batch unselect
  container.querySelectorAll("[data-unselectfam]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const famId = btn.dataset.unselectfam;
      const famModels = filteredModels().filter(m => getModelFamily(m.id, m.providerName).id === famId);
      for (const m of famModels) {
        state.selected.delete(keyOf(m));
      }
      renderModels();
      toast(`Unselected all models in ${famId}`);
      const affected = [...new Set(famModels.map(m => m.providerId))];
      affected.forEach(pid => persistProvider(pid));
    });
  });
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
  if (!models.length) {
    empty.innerHTML = '<div class="empty-illustration">⌕</div><h4>No matching models</h4><p>Try another search or filter option.</p>';
  }

  if (state.viewMode === "grouped" && models.length > 0) {
    const families = new Map();
    for (const m of models) {
      const fam = getModelFamily(m.id, m.providerName);
      if (!families.has(fam.id)) {
        families.set(fam.id, { ...fam, models: [] });
      }
      families.get(fam.id).models.push(m);
    }

    list.innerHTML = [...families.values()].map(f => {
      const selectedInFam = f.models.filter(m => state.selected.has(keyOf(m))).length;
      const isCollapsed = state.collapsedFamilies.has(f.id);
      return `
        <div class="family-group${isCollapsed ? " is-collapsed" : ""}" data-family="${f.id}">
          <div class="family-group-head" data-familyhead="${f.id}">
            <div class="family-group-left">
              <span class="family-group-glyph">${f.logo}</span>
              <span class="family-group-title">${escapeHtml(f.name)}</span>
              <span class="family-group-badge">${f.models.length} models · ${selectedInFam} active</span>
            </div>
            <div class="family-group-right">
              <button type="button" class="family-group-action" data-selectfam="${f.id}">Select all</button>
              <button type="button" class="family-group-action" data-unselectfam="${f.id}">Unselect</button>
              <span class="family-chevron">▼</span>
            </div>
          </div>
          <div class="family-group-body">
            ${f.models.map(renderModelRowHtml).join("")}
          </div>
        </div>
      `;
    }).join("");
  } else {
    list.innerHTML = models.map(renderModelRowHtml).join("");
  }

  bindModelListEvents(list);
  updateCounts();
}

function healthDot(id) {
  const h = state.health.get(id);
  if (!h) return `<span class="key-dot key-unknown" title="Not tested yet — click Test or Send hi">○</span>`;
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
      <div class="prov-actions">
        <button class="button button-secondary btn-sm" data-test="${escapeHtml(p.id)}">Test</button>
        <button class="button button-secondary btn-sm" data-directtest="${escapeHtml(p.id)}">Send hi</button>
        <button class="button button-secondary btn-sm" data-editcard="${escapeHtml(p.id)}">Edit</button>
        <button class="button button-danger btn-sm" data-delcard="${escapeHtml(p.id)}">Delete</button>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", () => testProviderById(b.dataset.test)));
  wrap.querySelectorAll("[data-directtest]").forEach(b => b.addEventListener("click", () => directTestProvider(b.dataset.directtest, b)));
  wrap.querySelectorAll("[data-editcard]").forEach(b => b.addEventListener("click", () => openEditModal(b.dataset.editcard)));
  wrap.querySelectorAll("[data-delcard]").forEach(b => b.addEventListener("click", () => deleteProviderById(b.dataset.delcard)));
  wrap.querySelectorAll("[data-toggle]").forEach(t => t.addEventListener("change", () => toggleProvider(t.dataset.toggle, t.checked)));
}

async function directTestProvider(id, btnEl = null) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Sending…";
  }
  try {
    const r = await api("/api/providers/test-completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: id })
    });
    if (r.ok) {
      toast(`${id}: reply: "${r.reply.slice(0, 60)}" (${r.latencyMs}ms)`);
      state.health.set(id, { ok: true, count: state.providers.find(p => p.id === id)?.modelCount || 1, latencyMs: r.latencyMs, testing: false });
    } else {
      toast(`${id}: direct chat failed — ${r.error}`, true);
      state.health.set(id, { ok: false, count: 0, latencyMs: r.latencyMs || 0, error: r.error, testing: false });
    }
  } catch (e) {
    toast(`${id}: chat test failed — ${e.message}`, true);
    state.health.set(id, { ok: false, count: 0, latencyMs: 0, error: e.message, testing: false });
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "Send hi";
    }
    renderProviderCards();
    renderProviders();
  }
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
  for (const k of [...state.selected]) if (k.startsWith(`${providerId}::`)) state.selected.delete(k);
  for (const m of mapped) if (m.alreadyConfigured) state.selected.add(keyOf(m));

  // If models were pruned upstream, update provider modelCount
  if (Array.isArray(result.pruned) && result.pruned.length > 0 && p) {
    p.modelCount = Math.max(0, (p.modelCount || 0) - result.pruned.length);
    for (const prunedId of result.pruned) {
      state.selected.delete(`${providerId}::${prunedId}`);
    }
  }

  state.discoveredProviders.add(providerId);
  saveDiscoveryCache();
}

function saveDiscoveryCache() {
  try {
    if (!state.models.length) return;
    localStorage.setItem("opencode_model_cache", JSON.stringify({
      models: state.models,
      discoveredProviders: [...state.discoveredProviders],
      timestamp: Date.now()
    }));
    updateCacheIndicator(Date.now());
  } catch (_) {}
}

function timeAgo(ms) {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ago`;
}

function updateCacheIndicator(timestamp) {
  const ind = $("cacheIndicator");
  if (!ind) return;
  ind.classList.remove("hidden");
  ind.innerHTML = `<span>📦 Cached (${timeAgo(timestamp)})</span> <button type="button" id="refreshCacheBtn" title="Discover all providers fresh">↻ Refresh</button>`;
  $("refreshCacheBtn")?.addEventListener("click", () => discoverAll());
}

function loadDiscoveryCache() {
  try {
    const raw = localStorage.getItem("opencode_model_cache");
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models) || !data.models.length) return false;
    if (Date.now() - (data.timestamp || 0) > 48 * 3600 * 1000) return false;

    state.models = data.models;
    state.discoveredProviders = new Set(data.discoveredProviders || []);
    state.selected.clear();
    for (const m of state.models) {
      if (m.alreadyConfigured) state.selected.add(keyOf(m));
    }

    state.filterProvider = "all";
    $("selectedProviderTitle").textContent = "All providers (Cached)";
    $("endpointText").textContent = "Loaded from local cache";

    updateCacheIndicator(data.timestamp);
    renderProviders();
    renderProviderCards();
    renderModels();
    return true;
  } catch (_) {
    return false;
  }
}

async function retryFailedProviders(failedIds) {
  if (!failedIds || !failedIds.length || state.busy) return;
  setBusy(true);
  try {
    toast(`Retrying ${failedIds.length} failed provider(s)...`);
    const res = await api("/api/models/discover-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: failedIds })
    });

    let succeeded = 0;
    if (Array.isArray(res.results)) {
      for (const item of res.results) {
        mergeDiscovered(item.provider, item);
        state.health.set(item.provider, { ok: true, count: item.count, latencyMs: 0, testing: false });
        succeeded++;
      }
    }

    const remainingFailures = res.failures || [];
    if (remainingFailures.length) {
      for (const item of remainingFailures) {
        state.health.set(item.provider, { ok: false, count: 0, latencyMs: 0, error: item.error, testing: false });
      }
      showAlert(`Retried: ${succeeded} succeeded, ${remainingFailures.length} still failed`, "warning", remainingFailures);
    } else {
      clearAlert();
      toast(`All ${failedIds.length} previously failed providers succeeded!`);
    }

    saveDiscoveryCache();
    renderProviders();
    renderProviderCards();
    renderModels();
  } catch (e) {
    showAlert(`Retry failed: ${e.message}`, "error");
  } finally {
    setBusy(false);
  }
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
  const tag = row.querySelector(".model-tag.tag-registered") ||
              row.querySelector(".model-tag:not(.tag-reasoning):not(.tag-vision):not(.tag-tools):not(.tag-embed)");
  const tagsRow = row.querySelector(".model-tags-row");
  if (configured && !tag) {
    const s = document.createElement("span");
    s.className = "model-tag tag-registered";
    s.textContent = "REGISTERED";
    if (tagsRow) tagsRow.appendChild(s);
    else row.appendChild(s);
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

  const previousSnapshot = new Set(state.selected);

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

    toast(
      on ? `Selected ${shown.length} models.` : `Deselected ${shown.length} models.`,
      false,
      "Undo",
      async () => {
        state.selected = previousSnapshot;
        renderModels();
        for (const pid of ids) {
          const r = await persistProvider(pid);
          updateProviderCount(pid, r?.modelCount);
        }
        renderModels();
        toast("Selection reverted.");
      }
    );
  } catch (e) {
    setSaveState("error");
    toast(`Could not save: ${e.message}`, true);
    renderModels();
  }
}

async function selectConfigured() {
  if (state.busy) return;
  const shown = filteredModels().filter(m => !isProviderDisabled(m.providerId) && m.alreadyConfigured);
  if (!shown.length) return;
  for (const m of shown) state.selected.add(keyOf(m));
  renderModels();
  setSaveState("saving");
  try {
    const ids = [...new Set(shown.map(m => m.providerId))];
    for (const pid of ids) await persistProvider(pid);
    renderModels();
    setSaveState("saved");
    toast(`Selected ${shown.length} registered models.`);
  } catch (e) {
    setSaveState("error");
    toast(`Could not save: ${e.message}`, true);
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
    if (r.pruned && r.pruned.length > 0) {
      toast(`Loaded ${r.count} models from ${state.providerId} (${r.pruned.length} removed model(s) cleaned up).`);
    } else {
      toast(`Loaded ${r.count} models from ${state.providerId}.`);
    }
  } catch (e) {
    showAlert(`Could not load model list from "${state.providerId}"`, "error", [{ id: state.providerId, error: e.message }]);
    toast("Discovery failed.", true);
  }
  finally { setBusy(false); }
}

async function discoverAll() {
  if (!state.providers.length || state.busy) return;
  clearAlert();
  setBusy(true);
  let ok = 0, fail = [], totalPruned = 0;
  try {
    const results = await Promise.all(state.providers.map(async p => {
      try { const r = await api(`/api/models?provider=${encodeURIComponent(p.id)}`); return { p, r }; }
      catch (e) { return { p, error: e.message }; }
    }));
    for (const item of results) {
      if (item.error) {
        fail.push({ id: item.p.id, error: item.error });
        state.health.set(item.p.id, { ok: false, count: 0, latencyMs: 0, error: item.error, testing: false });
        continue;
      }
      if (item.r?.pruned?.length) totalPruned += item.r.pruned.length;
      mergeDiscovered(item.p.id, item.r);
      state.health.set(item.p.id, { ok: true, count: item.r.count, latencyMs: 0, testing: false });
      ok++;
    }
    state.filterProvider = "all";
    state.providerId = state.providers[0]?.id || null;
    $("selectedProviderTitle").textContent = "All providers";
    $("endpointText").textContent = "All configured /v1/models endpoints";
    saveDiscoveryCache();
    renderProviders();
    renderProviderCards();
    renderModels();
    if (fail.length) {
      state.failedProviders = fail.map(f => f.id);
      const noun = fail.length === 1 ? "provider" : "providers";
      showAlert(`Loaded ${ok}/${state.providers.length} providers (${fail.length} ${noun} had errors)`, "warning", fail);
    } else {
      state.failedProviders = [];
    }
    if (totalPruned > 0) {
      toast(`Discovered ${state.models.length} models (${totalPruned} removed model(s) cleaned from config).`);
    } else {
      toast(`Discovered ${state.models.length} models from ${ok} provider(s).`);
    }
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
      const errList = results.filter(r => !r.ok).map(r => ({ id: r.id, error: r.error || "unreachable" }));
      showProviderAlert(`${okN} of ${total} ${noun} reachable (${errList.length} unreachable)`, "error", errList);
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

/* ---------- Request Adapters ---------- */

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
    catch { toast("Copy failed — select manually.", true); }
    ta.remove();
  }
}

function fillAdapterForm(providerId) {
  const a = adapterEntry(providerId);
  if (!a) return;
  $("adEnabled").checked = !!a.enabled;
  const rawUpstream = a.upstreamBaseURL || "";
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/proxy\//.test(rawUpstream.trim())) {
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

function applyPresetToAdapter(preset) {
  if (!preset) return;
  $("adUpstream").value = preset.upstreamBaseURL || "";
  $("adHeaders").value = JSON.stringify(preset.headers || {}, null, 2);
  $("adDynHeaders").value = JSON.stringify(preset.dynamicHeaders || {}, null, 2);
  $("adBody").value = JSON.stringify(preset.bodyOverrides || {}, null, 2);
  $("adModel").value = preset.defaultModel || "";
  $("adTimeout").value = preset.timeoutMs || 120000;
  if (preset.apiKeySource?.startsWith("env:")) {
    $("adKeySource").value = "env";
    $("adEnvName").value = preset.apiKeySource.slice(4);
  } else {
    $("adKeySource").value = preset.apiKeySource || "incoming";
    $("adEnvName").value = "";
  }
  updateKeySourceRows();
  $("presetDropdown").classList.add("hidden");
  toast(`Applied preset: ${preset.name}. Review and click Save adapter.`);
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
      let extra = "";
      if (r.reasoning_content) extra = `\nreasoning: ${r.reasoning_content.slice(0, 100)}…`;
      out.textContent = `reply: ${r.reply}${extra}\nusage: ${JSON.stringify(r.usage ?? null)}\nlatency: ${r.latencyMs}ms\nstatus: ${r.status}`;
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

/* ---------- Provider Modal & Presets ---------- */

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
  $("modalPresetWrap").classList.remove("hidden");
  $("modalPresetSelect").value = "";
  openModal();
}

async function openEditModal(id) {
  state.editingId = id;
  const form = $("providerForm");
  form.reset();
  $("formError").className = "alert alert-error hidden";
  $("formError").textContent = "";
  $("modalTitle").textContent = `Edit provider: ${id}`;
  $("modalIntro").textContent = "Update ID, name, endpoint, key, package, or headers. Renaming updates model references automatically.";
  $("providerIdInput").disabled = false;
  $("clearApiKeyRow").classList.remove("hidden");
  $("clearApiKeyInput").checked = false;
  $("deleteProviderBtn").classList.remove("hidden");
  $("addProviderBtn").textContent = "Save changes";
  $("modalPresetWrap").classList.add("hidden");
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

/* ---------- Presets Loader ---------- */

async function loadPresets() {
  try {
    const data = await api("/api/presets");
    state.presets = data.presets || {};

    // Populate modal preset select
    const select = $("modalPresetSelect");
    if (select) {
      select.innerHTML = '<option value="">Select a preset to auto-fill…</option>' +
        Object.entries(state.presets).map(([k, p]) => `<option value="${escapeHtml(k)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`).join("");
      select.onchange = () => {
        const chosen = state.presets[select.value];
        if (!chosen) return;
        $("providerIdInput").value = chosen.id || select.value;
        $("providerNameInput").value = chosen.name || "";
        $("providerBaseURLInput").value = chosen.upstreamBaseURL || "";
        $("providerPackageInput").value = chosen.package || "@opencode-ai/ai/providers/openai-compatible";
        $("providerHeadersInput").value = Object.keys(chosen.headers || {}).length ? JSON.stringify(chosen.headers, null, 2) : "";
      };
    }

    // Populate adapter preset dropdown
    const drop = $("presetDropdown");
    if (drop) {
      drop.innerHTML = Object.entries(state.presets).map(([k, p]) =>
        `<button type="button" class="preset-dropdown-item" data-preset="${escapeHtml(k)}">${escapeHtml(p.name)}</button>`
      ).join("");
      drop.querySelectorAll("[data-preset]").forEach(btn => {
        btn.onclick = () => applyPresetToAdapter(state.presets[btn.dataset.preset]);
      });
    }
  } catch { /* best effort */ }
}

/* ---------- Backups System ---------- */

async function loadBackups() {
  const listEl = $("backupsList");
  if (!listEl) return;
  try {
    const data = await api("/api/backups");
    const backups = data.backups || [];
    if (!backups.length) {
      listEl.innerHTML = '<span class="backup-empty">No backups created yet.</span>';
      return;
    }
    listEl.innerHTML = backups.map(b => {
      const kb = Math.max(1, Math.round(b.size / 1024));
      return `<div class="backup-item">
        <div class="backup-item-info">
          <strong>${escapeHtml(b.timestamp || b.filename)}</strong>
          <small>${kb} KB · ${escapeHtml(b.filename)}</small>
        </div>
        <button class="button button-secondary btn-sm" data-restore="${escapeHtml(b.filename)}">Restore</button>
      </div>`;
    }).join("");

    listEl.querySelectorAll("[data-restore]").forEach(btn => {
      btn.onclick = () => restoreBackupItem(btn.dataset.restore);
    });
  } catch (e) {
    listEl.innerHTML = `<span class="backup-empty">Failed: ${escapeHtml(e.message)}</span>`;
  }
}

async function restoreBackupItem(filename) {
  if (!confirm(`Restore configuration from "${filename}"? Current configuration will be automatically backed up first.`)) return;
  try {
    const r = await api("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename })
    });
    $("backupsDropdown").classList.add("hidden");
    await loadStatus();
    await refreshProviders();
    toast(`Restored backup: ${r.restored}`);
  } catch (e) {
    toast(`Restore failed: ${e.message}`, true);
  }
}

/* ---------- Activity / Proxy Logs ---------- */

async function loadActivityLogs() {
  const tbody = $("activityBody");
  if (!tbody) return;
  try {
    const data = await api("/api/proxy/logs");
    const logs = data.logs || [];
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="activity-empty">No requests logged yet. Use the proxy or Send hi to generate activity.</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => {
      const ok = l.status < 400;
      const dot = `<span class="activity-status-dot ${ok ? "dot-ok" : "dot-err"}"></span>`;
      const timeStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : "—";
      return `<tr>
        <td>${escapeHtml(timeStr)}</td>
        <td><strong>${escapeHtml(l.providerId)}</strong></td>
        <td><code>${escapeHtml(l.model)}</code></td>
        <td>${dot} ${l.status}</td>
        <td>${l.latencyMs}ms</td>
        <td class="activity-error-cell" title="${escapeHtml(l.error || "")}">${escapeHtml(l.error || "—")}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="activity-empty">Error loading activity: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function clearActivityLogs() {
  try {
    await api("/api/proxy/logs", { method: "DELETE" });
    await loadActivityLogs();
    toast("Activity log cleared.");
  } catch (e) {
    toast(`Clear failed: ${e.message}`, true);
  }
}

/* ---------- MCP Manager ---------- */

const MCP_ICONS = {
  folder: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4H5V6h14v2z"/></svg>',
  git: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 10.59L8.38 4.8a1.5 1.5 0 0 1 2.12 0l1.24 1.24L9.4 8.38a1.75 1.75 0 0 0-1.4 1.7 1.75 1.75 0 0 0 1.75 1.75c.42 0 .8-.15 1.1-.4l2.36 2.36a1.74 1.74 0 0 0-.4 1.1 1.75 1.75 0 1 0 1.75-1.75 1.75 1.75 0 0 0-1.1.4l-2.3-2.3a1.74 1.74 0 0 0 .15-.71 1.75 1.75 0 0 0-.4-1.1l2.3-2.3 7.76 7.76a1.5 1.5 0 0 1 0 2.12l-5.78 5.79a1.5 1.5 0 0 1-2.12 0l-9.87-9.88a1.5 1.5 0 0 1 0-2.12z"/></svg>',
  github: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.1-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>',
  brain: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3a4 4 0 0 0-4 4c0 .37.06.72.16 1.05A4.5 4.5 0 0 0 4.5 12a4.5 4.5 0 0 0 1.25 3.09A4.5 4.5 0 0 0 9 19.5v.5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-.5a4.5 4.5 0 0 0 3.25-4.41A4.5 4.5 0 0 0 19.5 12a4.5 4.5 0 0 0-3.66-3.95c.1-.33.16-.68.16-1.05a4 4 0 0 0-4-4zm-1 3a2 2 0 0 1 2 2v1h-2V6zm-3 4a2.5 2.5 0 0 1 2 1.05V13H7.5A2.5 2.5 0 0 1 7 10zm7 0a2.5 2.5 0 0 1-.5 3H14v-1.95A2.5 2.5 0 0 1 14 10z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  database: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 5.72V12c0 .5-2.13 2-6 2s-6-1.5-6-2v-1.28C7.54 11.45 9.65 12 12 12s4.46-.55 6-1.28zm0 5V17c0 .5-2.13 2-6 2s-6-1.5-6-2v-1.28c1.54.73 3.65 1.28 6 1.28s4.46-.55 6-1.28z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>'
};

async function loadMcpServers() {
  try {
    const res = await api("/api/mcp");
    state.mcp.servers = res.servers || {};
    state.mcp.presets = res.presets || [];

    const count = Object.keys(state.mcp.servers).length;
    if ($("mcpCountTab")) $("mcpCountTab").textContent = count;
    if ($("mcpServerCountBadge")) $("mcpServerCountBadge").textContent = count;

    renderMcpPresets();
    renderMcpServers();
  } catch (err) {
    showAlert(`Failed to load MCP servers: ${err.message}`);
  }
}

function renderMcpPresets() {
  const container = $("mcpPresetsGrid");
  if (!container) return;
  const presets = state.mcp.presets || [];
  if (!presets.length) {
    container.innerHTML = '<span style="color:#778596;font-size:11px;">No presets available.</span>';
    return;
  }

  container.innerHTML = presets.map(p => {
    const isAdded = Boolean(state.mcp.servers[p.id]);
    const iconSvg = MCP_ICONS[p.icon] || MCP_ICONS.box;
    return `
      <div class="mcp-preset-card">
        <div class="mcp-preset-top">
          <span class="mcp-preset-icon">${iconSvg}</span>
          <span class="mcp-preset-cat">${escapeHtml(p.category || p.type)}</span>
        </div>
        <div>
          <strong class="mcp-preset-title">${escapeHtml(p.name)}</strong>
          <p class="mcp-preset-desc">${escapeHtml(p.description)}</p>
        </div>
        <div class="mcp-preset-bottom">
          <small style="font:9px var(--mono);color:#707f92;">${escapeHtml(p.type)}</small>
          <button type="button" class="button ${isAdded ? "button-secondary" : "button-primary"} mcp-preset-btn" data-mcppreset="${escapeHtml(p.id)}">
            ${isAdded ? "Configure" : "+ Add"}
          </button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-mcppreset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const pid = btn.dataset.mcppreset;
      const preset = presets.find(x => x.id === pid);
      if (preset) {
        if (state.mcp.servers[preset.id]) {
          openMcpModal(preset.id);
        } else {
          openMcpModal(null, preset);
        }
      }
    });
  });
}

function renderMcpServers() {
  const container = $("mcpServersGrid");
  if (!container) return;
  const q = ($("mcpSearchInput")?.value || "").trim().toLowerCase();
  const entries = Object.entries(state.mcp.servers || {});

  const filtered = q
    ? entries.filter(([id, s]) => {
        const full = `${id} ${s.type} ${s.url} ${(s.command || []).join(" ")}`.toLowerCase();
        return full.includes(q);
      })
    : entries;

  if (!entries.length) {
    container.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:36px 16px;color:#7e8b9b;border:1px dashed #262e3d;border-radius:10px;">
        <span style="font-size:24px;display:block;margin-bottom:8px;">🔌</span>
        <strong style="color:#dce5f2;display:block;margin-bottom:4px;">No MCP Servers configured yet</strong>
        <p style="font-size:12px;margin:0 0 14px;">Add custom extensions or pick from the popular presets above to give OpenCode tools.</p>
        <button type="button" class="button button-primary btn-sm" id="mcpEmptyAddBtn">＋ Add Your First MCP Server</button>
      </div>
    `;
    $("mcpEmptyAddBtn")?.addEventListener("click", () => openMcpModal());
    return;
  }

  if (!filtered.length) {
    container.innerHTML = `<span style="grid-column:1/-1;color:#7e8b9b;font-size:12px;padding:16px;">No MCP servers matching "${escapeHtml(q)}".</span>`;
    return;
  }

  container.innerHTML = filtered.map(([id, s]) => {
    const isLocal = s.type === "local";
    const health = state.mcpHealth.get(id);
    let healthHtml = "";
    if (health) {
      if (health.running) {
        healthHtml = '<span class="mcp-test-pill running"><span class="spinner" style="width:10px;height:10px;"></span> Testing…</span>';
      } else if (health.ok) {
        healthHtml = `<span class="mcp-test-pill ok">✓ ${health.latencyMs !== undefined ? health.latencyMs + "ms" : "OK"}</span>`;
      } else {
        healthHtml = `<span class="mcp-test-pill fail" title="${escapeHtml(health.error || "Error")}">✕ Failed</span>`;
      }
    }

    const commandText = isLocal
      ? (s.command && s.command.length ? s.command.join(" ") : "(no command)")
      : (s.url || "(no url)");

    const envCount = Object.keys(s.environment || {}).length;
    const headerCount = Object.keys(s.headers || {}).length;

    return `
      <div class="mcp-card ${s.enabled ? "" : "is-disabled"}" data-mcpid="${escapeHtml(id)}">
        <div class="mcp-card-head">
          <div class="mcp-card-title-group">
            <span class="mcp-card-title">${escapeHtml(id)}</span>
            <span class="mcp-type-badge ${isLocal ? "mcp-type-local" : "mcp-type-remote"}">${escapeHtml(s.type)}</span>
          </div>
          <label class="switch" title="${s.enabled ? "Enabled" : "Disabled"}">
            <input type="checkbox" class="mcp-toggle-check" data-id="${escapeHtml(id)}" ${s.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>

        <div class="mcp-card-body">
          <div class="mcp-cmd-box" title="${escapeHtml(commandText)}">${escapeHtml(commandText)}</div>
          <div class="mcp-card-meta">
            ${s.cwd ? `<span class="mcp-meta-pill" title="cwd: ${escapeHtml(s.cwd)}">cwd: ${escapeHtml(s.cwd)}</span>` : ""}
            ${envCount > 0 ? `<span class="mcp-meta-pill">${envCount} env var${envCount > 1 ? "s" : ""}</span>` : ""}
            ${headerCount > 0 ? `<span class="mcp-meta-pill">${headerCount} header${headerCount > 1 ? "s" : ""}</span>` : ""}
          </div>
        </div>

        <div class="mcp-card-footer">
          <div class="mcp-health-target">${healthHtml}</div>
          <div class="mcp-card-actions">
            <button type="button" class="button button-secondary btn-sm mcp-test-btn" data-id="${escapeHtml(id)}" title="Test connection">🩺 Test</button>
            <button type="button" class="button button-secondary btn-sm mcp-edit-btn" data-id="${escapeHtml(id)}" title="Edit configuration">✏️ Edit</button>
            <button type="button" class="icon-button mcp-del-btn" data-id="${escapeHtml(id)}" title="Delete MCP Server" style="color:#ef4444;">×</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".mcp-toggle-check").forEach(chk => {
    chk.addEventListener("change", () => {
      toggleMcpServerState(chk.dataset.id, chk.checked);
    });
  });

  container.querySelectorAll(".mcp-test-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      testSingleMcp(btn.dataset.id);
    });
  });

  container.querySelectorAll(".mcp-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      openMcpModal(btn.dataset.id);
    });
  });

  container.querySelectorAll(".mcp-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      deleteMcpServerAction(btn.dataset.id);
    });
  });
}

function applyPastedMcpJson() {
  const raw = $("mcpPasteJsonInput")?.value.trim();
  if (!raw) return;
  try {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(`{${raw}}`);
    }

    let id = "";
    let config = parsed;

    const keys = Object.keys(parsed);
    if (keys.length === 1 && typeof parsed[keys[0]] === "object" && !Array.isArray(parsed[keys[0]])) {
      id = keys[0];
      config = parsed[keys[0]];
    }

    if (id && !$("mcpIdInput").disabled) {
      $("mcpIdInput").value = id;
    }

    const type = config.type || (config.url ? "remote" : "local");
    $("mcpTypeSelect").value = type;
    syncMcpModalType(type);

    if (type === "local") {
      let cmd = "";
      if (Array.isArray(config.command)) {
        cmd = config.command.join(" ");
      } else if (typeof config.command === "string") {
        cmd = config.command;
      }
      $("mcpCommandInput").value = cmd;
      $("mcpCwdInput").value = config.cwd || "";
      $("mcpEnvInput").value = config.environment ? JSON.stringify(config.environment, null, 2) : "";
    } else {
      $("mcpUrlInput").value = config.url || "";
      $("mcpHeadersInput").value = config.headers ? JSON.stringify(config.headers, null, 2) : "";
    }

    if (typeof config.enabled === "boolean") {
      $("mcpEnabledInput").checked = config.enabled;
    }

    $("mcpPasteJsonWrap")?.classList.add("hidden");
    toast("Applied JSON configuration to form.");
  } catch (err) {
    alert("Invalid JSON: " + err.message);
  }
}

function openMcpModal(id = null, preset = null) {
  state.editingMcpId = id;
  const isEditing = Boolean(id);
  const s = isEditing ? state.mcp.servers[id] : null;

  $("mcpPasteJsonWrap")?.classList.add("hidden");
  if ($("mcpPasteJsonInput")) $("mcpPasteJsonInput").value = "";

  $("mcpModalTitle").textContent = isEditing ? `Edit MCP Server: ${id}` : "Add MCP Server";
  $("mcpIdInput").value = id || preset?.id || "";
  $("mcpIdInput").disabled = isEditing;

  const type = s ? s.type : (preset ? preset.type : "local");
  $("mcpTypeSelect").value = type;
  syncMcpModalType(type);

  if (type === "local") {
    let cmd = "";
    if (s && s.command) cmd = Array.isArray(s.command) ? s.command.join(" ") : s.command;
    else if (preset && preset.command) cmd = Array.isArray(preset.command) ? preset.command.join(" ") : preset.command;
    $("mcpCommandInput").value = cmd;
    $("mcpCwdInput").value = s?.cwd || preset?.cwd || "";
    $("mcpEnvInput").value = s?.environment ? JSON.stringify(s.environment, null, 2) : (preset?.environment ? JSON.stringify(preset.environment, null, 2) : "");
  } else {
    $("mcpUrlInput").value = s?.url || preset?.url || "";
    $("mcpHeadersInput").value = s?.headers ? JSON.stringify(s.headers, null, 2) : (preset?.headers ? JSON.stringify(preset.headers, null, 2) : "");
  }

  $("mcpEnabledInput").checked = s ? (s.enabled !== false) : true;
  $("mcpDeleteBtn").classList.toggle("hidden", !isEditing);
  $("mcpFormError").classList.add("hidden");
  $("mcpFormTestResult").classList.add("hidden");

  $("mcpModal").classList.remove("hidden");
  if (!isEditing && !preset) $("mcpIdInput").focus();
  else if (type === "local") $("mcpCommandInput").focus();
  else $("mcpUrlInput").focus();
}

function syncMcpModalType(type) {
  const isLocal = type === "local";
  $("mcpLocalGroup")?.classList.toggle("hidden", !isLocal);
  $("mcpRemoteGroup")?.classList.toggle("hidden", isLocal);
}

function closeMcpModal() {
  $("mcpModal")?.classList.add("hidden");
  state.editingMcpId = null;
}

async function handleMcpSubmit(e) {
  e.preventDefault();
  const id = $("mcpIdInput").value.trim();
  const type = $("mcpTypeSelect").value;
  const enabled = $("mcpEnabledInput").checked;

  const errorEl = $("mcpFormError");
  errorEl.classList.add("hidden");

  const config = { type, enabled };

  if (type === "local") {
    const cmdStr = $("mcpCommandInput").value.trim();
    if (!cmdStr) {
      errorEl.textContent = "Command is required for local MCP server.";
      errorEl.classList.remove("hidden");
      return;
    }
    config.command = cmdStr;
    const cwd = $("mcpCwdInput").value.trim();
    if (cwd) config.cwd = cwd;

    const envStr = $("mcpEnvInput").value.trim();
    if (envStr) {
      try {
        config.environment = JSON.parse(envStr);
      } catch {
        errorEl.textContent = "Environment must be valid JSON.";
        errorEl.classList.remove("hidden");
        return;
      }
    }
  } else {
    const url = $("mcpUrlInput").value.trim();
    if (!url) {
      errorEl.textContent = "Remote URL is required.";
      errorEl.classList.remove("hidden");
      return;
    }
    config.url = url;

    const headersStr = $("mcpHeadersInput").value.trim();
    if (headersStr) {
      try {
        config.headers = JSON.parse(headersStr);
      } catch {
        errorEl.textContent = "Custom headers must be valid JSON.";
        errorEl.classList.remove("hidden");
        return;
      }
    }
  }

  const btn = $("mcpSaveBtn");
  btn.disabled = true;

  try {
    await api("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: id, config })
    });
    closeMcpModal();
    await loadMcpServers();
    toast(`MCP Server '${id}' saved successfully.`);
  } catch (err) {
    errorEl.textContent = err.message || "Failed to save MCP server.";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function toggleMcpServerState(id, enabled) {
  try {
    await api("/api/mcp/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: id, enabled })
    });
    if (state.mcp.servers[id]) state.mcp.servers[id].enabled = enabled;
    renderMcpServers();
    toast(`MCP Server '${id}' ${enabled ? "enabled" : "disabled"}.`);
  } catch (err) {
    toast(`Failed to toggle '${id}': ${err.message}`, true);
    await loadMcpServers();
  }
}

async function deleteMcpServerAction(id) {
  if (!confirm(`Are you sure you want to delete MCP server '${id}' from opencode.jsonc?`)) return;
  try {
    await api(`/api/mcp?name=${encodeURIComponent(id)}`, { method: "DELETE" });
    closeMcpModal();
    await loadMcpServers();
    toast(`MCP Server '${id}' deleted.`);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
  }
}

async function testSingleMcp(id) {
  const s = state.mcp.servers[id];
  if (!s) return;

  state.mcpHealth.set(id, { running: true });
  renderMcpServers();

  try {
    const res = await api("/api/mcp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s)
    });
    state.mcpHealth.set(id, res);
  } catch (err) {
    state.mcpHealth.set(id, { ok: false, error: err.message });
  }
  renderMcpServers();
}

async function testAllMcpServers() {
  const ids = Object.keys(state.mcp.servers || {});
  if (!ids.length) {
    toast("No MCP servers configured to test.", true);
    return;
  }
  toast(`Testing ${ids.length} MCP server(s)…`);
  await Promise.all(ids.map(id => testSingleMcp(id)));
  toast("Finished testing all MCP servers.");
}

async function testCurrentModalMcp() {
  const type = $("mcpTypeSelect").value;
  const banner = $("mcpFormTestResult");
  banner.className = "mcp-test-banner";
  banner.textContent = "Testing…";
  banner.classList.remove("hidden");

  let config;
  if (type === "local") {
    config = { type, command: $("mcpCommandInput").value.trim() };
  } else {
    config = { type, url: $("mcpUrlInput").value.trim() };
  }

  try {
    const res = await api("/api/mcp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    if (res.ok) {
      banner.className = "mcp-test-banner ok";
      banner.textContent = type === "local" ? `✓ Runtime found: ${res.path || res.message}` : `✓ Connected (${res.latencyMs}ms, HTTP ${res.status})`;
    } else {
      banner.className = "mcp-test-banner fail";
      banner.textContent = `✕ Test failed: ${res.error}`;
    }
  } catch (err) {
    banner.className = "mcp-test-banner fail";
    banner.textContent = `✕ Error: ${err.message}`;
  }
}

/* ---------- Export & Import ---------- */

async function exportConfig() {
  try {
    const data = await api("/api/config/export");
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `opencode-config-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Configuration exported.");
  } catch (e) {
    toast(`Export failed: ${e.message}`, true);
  }
}

function handleImportClick() {
  $("importFileInput").click();
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = "";
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!confirm("Import configuration from this file? Existing providers and adapters will be merged/updated, and a backup will be created.")) return;
    const r = await api("/api/config/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    });
    await loadStatus();
    await refreshProviders();
    await loadAdapters();
    toast(`Imported ${r.importedProviders} provider(s) and ${r.importedAdapters} adapter(s).`);
  } catch (e) {
    toast(`Import failed: ${e.message}`, true);
  }
}

/* ---------- Playground Modal (Single-Model Chat) & Search ---------- */

function detectModelTags(id) {
  const lower = String(id || "").toLowerCase();
  const tags = [];
  if (/\b(embed|embedding|bge|text-embedding)\b/i.test(lower)) tags.push("EMBED");
  if (/\b(r1|o1|o3|qwq|deepseek-r1|reasoning|thinking)\b/i.test(lower) || lower.includes("-r1")) tags.push("REASONING");
  if (/\b(vision|vl|4o|gemini|claude-3|pixtral|llava)\b/i.test(lower)) tags.push("VISION");
  if (!tags.includes("EMBED") && /\b(chat|instruct|gpt|claude|gemini|qwen|deepseek|llama|mistral|command)\b/i.test(lower)) tags.push("TOOLS");
  return tags;
}

function getPlaygroundCandidateModels() {
  const candidates = [];
  const seen = new Set();

  // 1. Gather all models from state.models
  for (const m of state.models) {
    const pid = m.providerId;
    const p = state.providers.find(x => x.id === pid);
    const k = `${pid}::${m.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      const isConfigured = state.selected.has(keyOf(m)) || Boolean(p?.models && typeof p.models === "object" && Object.prototype.hasOwnProperty.call(p.models, m.id));
      candidates.push({
        providerId: pid,
        providerName: p?.name || pid,
        modelId: m.id,
        name: m.name || m.id,
        tags: (m.tags && m.tags.length) ? m.tags : detectModelTags(m.id),
        isConfigured
      });
    }
  }

  // 2. Gather any models configured in state.providers not present in state.models
  for (const p of state.providers) {
    if (p.models && typeof p.models === "object") {
      for (const mid of Object.keys(p.models)) {
        const k = `${p.id}::${mid}`;
        if (!seen.has(k)) {
          seen.add(k);
          candidates.push({
            providerId: p.id,
            providerName: p.name || p.id,
            modelId: mid,
            name: mid,
            tags: detectModelTags(mid),
            isConfigured: true
          });
        }
      }
    }
  }

  return candidates;
}

function highlightSearchMatch(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.trim();
  if (!q) return escapeHtml(text);
  const str = String(text ?? "");
  const idx = str.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return escapeHtml(str);
  const before = escapeHtml(str.slice(0, idx));
  const matched = escapeHtml(str.slice(idx, idx + q.length));
  const after = escapeHtml(str.slice(idx + q.length));
  return `${before}<span class="pg-search-highlight">${matched}</span>${after}`;
}

function renderPlaygroundSearchResults(query = "") {
  const dropdown = $("pgSearchResults");
  const countEl = $("pgSearchCount");
  const clearBtn = $("pgModelSearchClear");
  if (!dropdown) return;

  const q = (query || "").trim().toLowerCase();
  if (clearBtn) {
    if (q) clearBtn.classList.remove("hidden");
    else clearBtn.classList.add("hidden");
  }

  const candidates = getPlaygroundCandidateModels();
  const currentPid = state.playground.provider;
  const currentMid = state.playground.model;

  candidates.sort((a, b) => {
    const isCurA = a.providerId === currentPid && a.modelId === currentMid;
    const isCurB = b.providerId === currentPid && b.modelId === currentMid;
    if (isCurA && !isCurB) return -1;
    if (!isCurA && isCurB) return 1;
    if (a.isConfigured && !b.isConfigured) return -1;
    if (!a.isConfigured && b.isConfigured) return 1;
    return a.modelId.localeCompare(b.modelId);
  });

  const filtered = q
    ? candidates.filter(c => {
        const full = `${c.modelId} ${c.name} ${c.providerName} ${c.providerId} ${(c.tags || []).join(" ")}`.toLowerCase();
        return full.includes(q);
      })
    : candidates;

  if (countEl) {
    countEl.textContent = q ? `${filtered.length} of ${candidates.length}` : `${candidates.length} models`;
  }

  if (!filtered.length) {
    dropdown.innerHTML = `<div class="pg-search-empty">No models found matching "${escapeHtml(q)}". Try searching for claude, gpt, or deepseek.</div>`;
    dropdown.classList.remove("hidden");
    state.pgSearchActiveIndex = -1;
    return;
  }

  const displayItems = filtered.slice(0, 60);
  dropdown.innerHTML = displayItems.map((c, idx) => {
    const isCur = c.providerId === currentPid && c.modelId === currentMid;
    const glyphHtml = getModelLogoSvg(c.modelId, c.providerName);
    const badgeHtml = isCur
      ? '<span class="pg-search-badge active">Active</span>'
      : (c.isConfigured ? '<span class="pg-search-badge configured">Configured</span>' : "");
    const tagsHtml = (c.tags || []).map(t => {
      const cls = t === "REASONING" ? "tag-reasoning" : t === "VISION" ? "tag-vision" : t === "TOOLS" ? "tag-tools" : t === "EMBED" ? "tag-embed" : "";
      return `<span class="model-tag ${cls}" style="font-size:9px;padding:1px 5px;">${t}</span>`;
    }).join("");

    return `
      <div class="pg-search-item ${isCur ? 'is-current-active' : ''}" role="option" data-provider="${escapeHtml(c.providerId)}" data-model="${escapeHtml(c.modelId)}" data-index="${idx}">
        <span class="pg-search-item-glyph">${glyphHtml}</span>
        <div class="pg-search-item-info">
          <div class="pg-search-item-top">
            <span class="pg-search-item-title">${highlightSearchMatch(c.modelId, q)}</span>
            ${badgeHtml}
          </div>
          <div class="pg-search-item-sub">
            <span class="pg-search-provider">${highlightSearchMatch(c.providerName, q)}</span>
            ${tagsHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");

  dropdown.classList.remove("hidden");
  state.pgSearchActiveIndex = -1;
}

function handlePlaygroundSearchKeydown(e) {
  const dropdown = $("pgSearchResults");
  if (!dropdown || dropdown.classList.contains("hidden")) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      renderPlaygroundSearchResults($("pgModelSearch")?.value || "");
      return;
    }
    return;
  }

  const items = Array.from(dropdown.querySelectorAll(".pg-search-item"));
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.pgSearchActiveIndex = Math.min(items.length - 1, state.pgSearchActiveIndex + 1);
    updateSearchActiveItem(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.pgSearchActiveIndex = Math.max(0, state.pgSearchActiveIndex - 1);
    updateSearchActiveItem(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const activeItem = items[state.pgSearchActiveIndex] || items[0];
    if (activeItem) {
      const pid = activeItem.dataset.provider;
      const mid = activeItem.dataset.model;
      if (pid && mid) {
        openModelPlayground(pid, mid);
        dropdown.classList.add("hidden");
        $("pgPrompt")?.focus();
      }
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    dropdown.classList.add("hidden");
  }
}

function updateSearchActiveItem(items) {
  items.forEach((item, idx) => {
    if (idx === state.pgSearchActiveIndex) {
      item.classList.add("is-active-item");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("is-active-item");
    }
  });
}

function openModelPlayground(providerId, modelId) {
  state.playground = { provider: providerId, model: modelId };
  const m = state.models.find(x => x.id === modelId && x.providerId === providerId);
  const p = state.providers.find(x => x.id === providerId);

  $("pgModelTitle").textContent = modelId;
  $("pgProviderName").textContent = `${p?.name || providerId} (${providerId})`;
  $("pgModelGlyph").innerHTML = getModelLogoSvg(modelId, p?.name || providerId);

  // Sync and update the search bar in Playground
  const searchInput = $("pgModelSearch");
  if (searchInput) {
    searchInput.value = "";
    searchInput.placeholder = `Search & switch models (active: ${modelId})...`;
  }
  const searchDropdown = $("pgSearchResults");
  if (searchDropdown) {
    searchDropdown.classList.add("hidden");
  }
  const clearBtn = $("pgModelSearchClear");
  if (clearBtn) clearBtn.classList.add("hidden");

  const candidateList = getPlaygroundCandidateModels();
  if ($("pgSearchCount")) {
    $("pgSearchCount").textContent = `${candidateList.length} models`;
  }

  // Populate model dropdown switcher
  const sel = $("pgModelSelect");
  if (sel) {
    sel.innerHTML = candidateList.map(mod => {
      const isSelected = mod.modelId === modelId && mod.providerId === providerId ? "selected" : "";
      return `<option value="${escapeHtml(mod.providerId)}::${escapeHtml(mod.modelId)}" ${isSelected}>${escapeHtml(mod.modelId)} (${escapeHtml(mod.providerName || mod.providerId)})</option>`;
    }).join("");
    sel.onchange = () => {
      const [pid, mid] = sel.value.split("::");
      if (pid && mid) openModelPlayground(pid, mid);
    };
  }

  const tags = (m?.tags && m.tags.length) ? m.tags : detectModelTags(modelId);
  $("pgTags").innerHTML = tags.map(t => {
    const cls = t === "REASONING" ? "tag-reasoning" : t === "VISION" ? "tag-vision" : t === "TOOLS" ? "tag-tools" : t === "EMBED" ? "tag-embed" : "";
    return `<span class="model-tag ${cls}">${t}</span>`;
  }).join("");

  if (!$("pgPrompt").value.trim()) {
    $("pgPrompt").value = "Say hello and describe your capabilities in 2 concise sentences.";
  }

  $("pgLatency").className = "stat-pill hidden";
  $("pgTokens").className = "stat-pill hidden";
  $("pgThinkingWrap").classList.add("hidden");
  $("pgThinking").textContent = "";
  $("pgOutputWrap").classList.add("hidden");
  $("pgOutput").textContent = "";
  $("pgError").classList.add("hidden");
  $("pgSendBtn").disabled = false;
  $("pgSendBtn").innerHTML = '<span class="button-symbol">⚡</span> Send Request';

  $("playgroundModal").classList.remove("hidden");
  $("pgPrompt").focus();
}

function closeModelPlayground() {
  $("playgroundModal").classList.add("hidden");
}

async function sendPlaygroundPrompt() {
  if (!state.playground.provider || !state.playground.model) return;
  const prompt = $("pgPrompt").value.trim();
  if (!prompt) return;

  const btn = $("pgSendBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running…';

  $("pgLatency").className = "stat-pill hidden";
  $("pgTokens").className = "stat-pill hidden";
  $("pgThinkingWrap").classList.add("hidden");
  $("pgOutputWrap").classList.add("hidden");
  $("pgError").classList.add("hidden");

  try {
    const res = await api("/api/models/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: state.playground.provider,
        model: state.playground.model,
        prompt,
        maxTokens: 250
      })
    });

    if (res.ok) {
      const latEl = $("pgLatency");
      latEl.textContent = `${res.latencyMs}ms`;
      latEl.className = `stat-pill ${res.latencyMs < 600 ? "latency-fast" : res.latencyMs < 1500 ? "latency-medium" : "latency-slow"}`;
      latEl.classList.remove("hidden");

      const tokEl = $("pgTokens");
      tokEl.textContent = `${res.reply?.length || 0} chars`;
      tokEl.classList.remove("hidden");

      if (res.reasoning) {
        $("pgThinkingWrap").classList.remove("hidden");
        $("pgThinkingLength").textContent = `(${res.reasoning.length} chars)`;
        $("pgThinking").textContent = res.reasoning;
      }

      $("pgOutputWrap").classList.remove("hidden");
      $("pgOutput").textContent = res.reply || "(Empty response)";
    } else {
      $("pgError").classList.remove("hidden");
      $("pgError").textContent = res.error || "Model test request failed.";
    }
  } catch (e) {
    $("pgError").classList.remove("hidden");
    $("pgError").textContent = e.message || "Failed to reach model.";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="button-symbol">⚡</span> Send Request';
  }
}

/* ---------- Benchmark Modal (Speed Race) ---------- */

function getBenchmarkCandidateModels() {
  const candidates = [];
  const seen = new Set();

  for (const p of state.providers) {
    if (isProviderDisabled(p.id)) continue;
    const activeForProvider = state.models.filter(m => m.providerId === p.id && state.selected.has(keyOf(m)));
    if (activeForProvider.length > 0) {
      for (const m of activeForProvider) {
        const k = `${p.id}::${m.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          candidates.push({ providerId: p.id, providerName: p.name || p.id, modelId: m.id, name: m.name || m.id });
        }
      }
    } else if (p.models && typeof p.models === "object") {
      for (const [mid, mdata] of Object.entries(p.models)) {
        const k = `${p.id}::${mid}`;
        if (!seen.has(k)) {
          seen.add(k);
          candidates.push({ providerId: p.id, providerName: p.name || p.id, modelId: mid, name: mdata?.name || mid });
        }
      }
    }
  }

  return candidates;
}

function updateBenchmarkControlState() {
  const count = state.benchmarkSelected.size;
  const countBadge = $("benchmarkSelectCount");
  if (countBadge) countBadge.textContent = `${count} selected`;

  const btn = $("runBenchmarkBtn");
  const status = $("benchmarkStatusText");
  if (!btn || !status) return;

  if (count === 0) {
    btn.disabled = true;
    btn.innerHTML = '<span class="button-symbol">▶</span> Select models to race';
    status.textContent = 'Check the models you want to test above (0 selected)';
  } else {
    btn.disabled = false;
    btn.innerHTML = `<span class="button-symbol">▶</span> Race ${count} Model${count === 1 ? "" : "s"}`;
    status.textContent = `Ready to test ${count} selected model${count === 1 ? "" : "s"} (max 5 tokens each)`;
  }
}

function renderBenchmarkPicker() {
  const picker = $("benchmarkModelPicker");
  if (!picker) return;

  const candidates = getBenchmarkCandidateModels();
  if (!candidates.length) {
    picker.innerHTML = '<span class="benchmark-empty" style="grid-column:1/-1;">No configured models found. Please configure a provider first.</span>';
    updateBenchmarkControlState();
    return;
  }

  const query = ($("benchmarkSearchInput")?.value || "").trim().toLowerCase();
  const filtered = query
    ? candidates.filter(c => c.modelId.toLowerCase().includes(query) || c.name.toLowerCase().includes(query) || c.providerName.toLowerCase().includes(query))
    : candidates;

  if (!filtered.length) {
    picker.innerHTML = '<span class="benchmark-empty" style="grid-column:1/-1;">No matching models. Try another search.</span>';
    return;
  }

  picker.innerHTML = filtered.map(c => {
    const k = `${c.providerId}::${c.modelId}`;
    const checked = state.benchmarkSelected.has(k);
    return `<label class="benchmark-pick-row ${checked ? "is-picked" : ""}" title="${escapeHtml(c.modelId)}">
      <input type="checkbox" class="benchmark-pick-check" data-bkey="${escapeHtml(k)}" ${checked ? "checked" : ""}>
      <span class="benchmark-pick-glyph">${getModelLogoSvg(c.modelId, c.providerName)}</span>
      <span class="benchmark-pick-info">
        <strong>${escapeHtml(c.name || c.modelId)}</strong>
        <small>${escapeHtml(c.modelId)} · ${escapeHtml(c.providerName)}</small>
      </span>
    </label>`;
  }).join("");

  picker.querySelectorAll(".benchmark-pick-check").forEach(input => {
    input.addEventListener("change", () => {
      const k = input.dataset.bkey;
      if (input.checked) {
        state.benchmarkSelected.add(k);
      } else {
        state.benchmarkSelected.delete(k);
      }
      input.closest(".benchmark-pick-row")?.classList.toggle("is-picked", input.checked);
      updateBenchmarkControlState();
    });
  });

  updateBenchmarkControlState();
}

function openBenchmarkModal() {
  $("benchmarkModal").classList.remove("hidden");
  // Default to pre-selecting at most 2-3 models so the user never races 196 models by accident
  if (state.benchmarkSelected.size === 0) {
    const candidates = getBenchmarkCandidateModels();
    for (const c of candidates.slice(0, 3)) {
      state.benchmarkSelected.add(`${c.providerId}::${c.modelId}`);
    }
  }
  renderBenchmarkPicker();
  updateBenchmarkControlState();
}

function closeBenchmarkModal() {
  $("benchmarkModal").classList.add("hidden");
}

async function runBenchmark() {
  const btn = $("runBenchmarkBtn");
  const status = $("benchmarkStatusText");
  const body = $("benchmarkBody");

  const targets = [];
  for (const k of state.benchmarkSelected) {
    const [pid, mid] = k.split("::");
    if (pid && mid) targets.push({ provider: pid, model: mid });
  }

  if (!targets.length) {
    toast("Please select at least one model to benchmark.", true);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Benchmarking…';
  status.textContent = `Pinging ${targets.length} selected model(s) in parallel (max 5 tokens each)...`;
  body.innerHTML = `<tr><td colspan="6" class="benchmark-empty"><span class="spinner"></span> Racing ${targets.length} selected model(s)…</td></tr>`;

  try {
    const r = await api("/api/models/benchmark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: targets })
    });
    if (!r.ok) throw new Error(r.error || "Benchmark failed");

    if (!r.results || !r.results.length) {
      body.innerHTML = '<tr><td colspan="6" class="benchmark-empty">No results returned for the selected models.</td></tr>';
      status.textContent = "No models tested";
      return;
    }

    body.innerHTML = r.results.map((row, idx) => {
      const isFastest = idx === 0 && row.ok;
      const rankBadge = isFastest
        ? '<span class="badge-rank badge-fastest">🥇 #1 FASTEST</span>'
        : `<span class="badge-rank">#${idx + 1}</span>`;
      const latClass = row.latencyMs < 400 ? "latency-fast" : row.latencyMs < 1200 ? "latency-medium" : "latency-slow";
      const statusHtml = row.ok
        ? '<span style="color:#4ade80;font-weight:600;">✓ 200 OK</span>'
        : '<span style="color:#f87171;font-weight:600;">✕ Failed</span>';
      const sampleText = row.reply ? `"${escapeHtml(row.reply.slice(0, 40))}"` : escapeHtml(row.error || "—");

      return `<tr>
        <td>${rankBadge}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="model-glyph" style="width:22px;height:22px;border-radius:5px;">${getModelLogoSvg(row.model, row.provider)}</span>
            <strong style="font-size:12px;">${escapeHtml(row.model)}</strong>
          </div>
        </td>
        <td><span style="font-size:11px;color:#94a3b8;">${escapeHtml(row.provider)}</span></td>
        <td><span class="${latClass}">${row.latencyMs}ms</span></td>
        <td>${statusHtml}</td>
        <td><small style="font-family:var(--mono);color:#94a3b8;">${sampleText}</small></td>
      </tr>`;
    }).join("");

    status.textContent = `Completed ${r.results.length} model(s) · Fastest: ${r.fastest ? r.fastest.model + " (" + r.fastest.latencyMs + "ms)" : "none"}`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    body.innerHTML = `<tr><td colspan="6" class="benchmark-empty" style="color:#f87171;">${escapeHtml(e.message)}</td></tr>`;
  } finally {
    updateBenchmarkControlState();
  }
}

/* ---------- View Mode & Filter Chip Helpers ---------- */

function setViewMode(mode) {
  state.viewMode = mode;
  try { localStorage.setItem("opencode_view_mode", mode); } catch (_) {}
  $("viewFlatBtn")?.classList.toggle("active", mode === "flat");
  $("viewGroupedBtn")?.classList.toggle("active", mode === "grouped");
  renderModels();
}

function syncFilterChips() {
  const bar = $("filterChipsBar");
  if (!bar) return;
  bar.querySelectorAll(".filter-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.filter === state.filterStatus);
  });
}

/* ---------- Event Listeners ---------- */

$("discoverBtn").addEventListener("click", discoverOne);
$("discoverAllBtn").addEventListener("click", discoverAll);
$("playgroundBtn")?.addEventListener("click", () => {
  const available = filteredModels()[0] || state.models[0];
  if (available) {
    openModelPlayground(available.providerId, available.id);
  } else {
    for (const p of state.providers) {
      const keys = Object.keys(p.models || {});
      if (keys.length) {
        openModelPlayground(p.id, keys[0]);
        return;
      }
    }
    toast("No models loaded yet. Discover models first.", true);
  }
});
$("benchmarkBtn")?.addEventListener("click", openBenchmarkModal);
$("closeBenchmark")?.addEventListener("click", closeBenchmarkModal);
$("runBenchmarkBtn")?.addEventListener("click", runBenchmark);
$("benchmarkModal")?.addEventListener("click", e => { if (e.target === $("benchmarkModal")) closeBenchmarkModal(); });
$("benchmarkSearchInput")?.addEventListener("input", renderBenchmarkPicker);
$("benchmarkSelectNoneBtn")?.addEventListener("click", () => {
  state.benchmarkSelected.clear();
  renderBenchmarkPicker();
  updateBenchmarkControlState();
});

$("closePlayground")?.addEventListener("click", closeModelPlayground);
$("playgroundModal")?.addEventListener("click", e => { if (e.target === $("playgroundModal")) closeModelPlayground(); });
$("pgSendBtn")?.addEventListener("click", sendPlaygroundPrompt);
$("pgCopyOutputBtn")?.addEventListener("click", () => {
  const text = $("pgOutput")?.textContent || "";
  if (text) {
    navigator.clipboard.writeText(text).then(() => toast("Copied response to clipboard"));
  }
});

$("pgModelSearch")?.addEventListener("input", e => {
  renderPlaygroundSearchResults(e.target.value);
});
$("pgModelSearch")?.addEventListener("focus", () => {
  renderPlaygroundSearchResults($("pgModelSearch")?.value || "");
});
$("pgModelSearch")?.addEventListener("keydown", handlePlaygroundSearchKeydown);
$("pgModelSearchClear")?.addEventListener("click", () => {
  if ($("pgModelSearch")) {
    $("pgModelSearch").value = "";
    $("pgModelSearch").focus();
    renderPlaygroundSearchResults("");
  }
});
$("pgSearchResults")?.addEventListener("click", e => {
  const item = e.target.closest(".pg-search-item");
  if (item) {
    const pid = item.dataset.provider;
    const mid = item.dataset.model;
    if (pid && mid) {
      openModelPlayground(pid, mid);
      $("pgSearchResults")?.classList.add("hidden");
      $("pgPrompt")?.focus();
    }
  }
});

document.querySelectorAll(".chip-preset").forEach(btn => {
  btn.addEventListener("click", () => {
    const prompt = btn.dataset.prompt;
    if (prompt) {
      $("pgPrompt").value = prompt;
      $("pgPrompt").focus();
    }
  });
});

$("viewFlatBtn")?.addEventListener("click", () => setViewMode("flat"));
$("viewGroupedBtn")?.addEventListener("click", () => setViewMode("grouped"));

const chipsBar = $("filterChipsBar");
if (chipsBar) {
  chipsBar.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const filter = chip.dataset.filter;
      state.filterStatus = filter;
      if ($("modelFilterSelect")) $("modelFilterSelect").value = filter;
      syncFilterChips();
      renderModels();
    });
  });
}

$("removePluginBtn").addEventListener("click", removePlugin);

$("searchInput").addEventListener("input", renderModels);

$("modelFilterSelect").addEventListener("change", () => {
  state.filterStatus = $("modelFilterSelect").value;
  syncFilterChips();
  renderModels();
});

$("modelSortSelect").addEventListener("change", () => {
  state.sortMode = $("modelSortSelect").value;
  renderModels();
});

$("selectAllBtn").addEventListener("click", () => bulkSelect(true));
$("selectNoneBtn").addEventListener("click", () => bulkSelect(false));
if ($("selectConfiguredBtn")) {
  $("selectConfiguredBtn").addEventListener("click", selectConfigured);
}

$("openAddProvider").addEventListener("click", openAddModal);
$("openAddProvider2").addEventListener("click", openAddModal);
$("closeModal").addEventListener("click", closeModal);
$("cancelAdd").addEventListener("click", closeModal);
$("deleteProviderBtn").addEventListener("click", deleteEditingProvider);
$("checkAllBtn").addEventListener("click", checkAllKeys);

$("tabModels").addEventListener("click", () => switchTab("models"));
$("tabProviders").addEventListener("click", () => switchTab("providers"));
$("tabAdapters").addEventListener("click", () => switchTab("adapters"));
$("tabActivity").addEventListener("click", () => switchTab("activity"));
$("tabMcp")?.addEventListener("click", () => switchTab("mcp"));

$("mcpAddBtn")?.addEventListener("click", () => openMcpModal());
$("mcpTestAllBtn")?.addEventListener("click", testAllMcpServers);
$("mcpSearchInput")?.addEventListener("input", renderMcpServers);
$("closeMcpModal")?.addEventListener("click", closeMcpModal);
$("mcpCancelBtn")?.addEventListener("click", closeMcpModal);
$("mcpForm")?.addEventListener("submit", handleMcpSubmit);
$("mcpTogglePasteJsonBtn")?.addEventListener("click", () => {
  $("mcpPasteJsonWrap")?.classList.toggle("hidden");
  if (!$("mcpPasteJsonWrap")?.classList.contains("hidden")) {
    $("mcpPasteJsonInput")?.focus();
  }
});
$("mcpApplyPasteJsonBtn")?.addEventListener("click", applyPastedMcpJson);
$("mcpTypeSelect")?.addEventListener("change", () => syncMcpModalType($("mcpTypeSelect").value));
$("mcpTestCurrentBtn")?.addEventListener("click", testCurrentModalMcp);
$("mcpDeleteBtn")?.addEventListener("click", () => {
  if (state.editingMcpId) deleteMcpServerAction(state.editingMcpId);
});
$("mcpModal")?.addEventListener("click", e => {
  if (e.target === $("mcpModal")) closeMcpModal();
});

$("backupsBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const drop = $("backupsDropdown");
  const hidden = drop.classList.contains("hidden");
  drop.classList.toggle("hidden", !hidden);
  if (hidden) loadBackups();
});

$("adapterPresetBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const drop = $("presetDropdown");
  drop.classList.toggle("hidden");
});

$("activityRefreshBtn").addEventListener("click", loadActivityLogs);
$("activityClearBtn").addEventListener("click", clearActivityLogs);

$("exportBtn").addEventListener("click", exportConfig);
$("importBtn").addEventListener("click", handleImportClick);
$("importFileInput").addEventListener("change", handleImportFile);

$("adapterSearch").addEventListener("input", () => { state.adapterQuery = $("adapterSearch").value; renderAdapterList(); });
$("adapterTestBtn").addEventListener("click", sendAdapterHi);
$("adapterCopyBtn").addEventListener("click", copyProxyUrl);
$("adapterForm").addEventListener("submit", saveAdapter);
$("adKeySource").addEventListener("change", updateKeySourceRows);
$("adStoredKey").addEventListener("input", () => { if ($("adStoredKey").value !== "") $("adClearKey").checked = false; });

$("providerApiKeyInput").addEventListener("input", () => { if ($("providerApiKeyInput").value) $("clearApiKeyInput").checked = false; });
$("providerForm").addEventListener("submit", handleProviderSubmit);
$("providerModal").addEventListener("click", e => { if (e.target === $("providerModal")) closeModal(); });

// Keyboard shortcuts
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if ($("pgSearchResults") && !$("pgSearchResults").classList.contains("hidden")) {
      $("pgSearchResults").classList.add("hidden");
      return;
    }
    if ($("playgroundModal") && !$("playgroundModal").classList.contains("hidden")) {
      closeModelPlayground();
      return;
    }
    if ($("benchmarkModal") && !$("benchmarkModal").classList.contains("hidden")) {
      closeBenchmarkModal();
      return;
    }
    if ($("mcpModal") && !$("mcpModal").classList.contains("hidden")) {
      closeMcpModal();
      return;
    }
    if (!$("providerModal").classList.contains("hidden")) {
      closeModal();
      return;
    }
    if (!$("backupsDropdown").classList.contains("hidden")) {
      $("backupsDropdown").classList.add("hidden");
      return;
    }
    if (!$("presetDropdown").classList.contains("hidden")) {
      $("presetDropdown").classList.add("hidden");
      return;
    }
    if (document.activeElement === $("searchInput")) {
      $("searchInput").value = "";
      renderModels();
      $("searchInput").blur();
    }
  }

  // / or Ctrl+K to search
  if ((e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) || ((e.ctrlKey || e.metaKey) && e.key === "k")) {
    e.preventDefault();
    if ($("playgroundModal") && !$("playgroundModal").classList.contains("hidden")) {
      $("pgModelSearch")?.focus();
      $("pgModelSearch")?.select();
      renderPlaygroundSearchResults($("pgModelSearch")?.value || "");
    } else {
      $("searchInput").focus();
      $("searchInput").select();
    }
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".playground-search-section")) {
    $("pgSearchResults")?.classList.add("hidden");
  }
  if (!e.target.closest(".backup-dropdown-wrap")) {
    $("backupsDropdown").classList.add("hidden");
  }
  if (!e.target.closest(".preset-dropdown-wrap")) {
    $("presetDropdown").classList.add("hidden");
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const hashTab = (location.hash || "").replace(/^#/, "");
    if (["models", "providers", "adapters", "activity", "mcp"].includes(hashTab)) {
      switchTab(hashTab);
    }
  });
}

(async () => {
  // Restore active tab immediately before network calls
  let initialTab = state.activeTab;
  if (typeof location !== "undefined" && location.hash) {
    const hashTab = location.hash.replace(/^#/, "");
    if (["models", "providers", "adapters", "activity", "mcp"].includes(hashTab)) {
      initialTab = hashTab;
    }
  }
  switchTab(initialTab);

  try {
    await loadStatus();
    await refreshProviders();
    await loadPresets();
    await loadMcpServers();
    loadDiscoveryCache();
    setViewMode(state.viewMode);
  } catch (e) {
    $("connectionText").textContent = "Config error";
    $("configPath").textContent = e.message;
    showAlert(e.message);
  }
})();
