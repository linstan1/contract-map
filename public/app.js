// Contract Map application shell. Plain ES module, no framework.
//
// State machine: entry -> loading -> app (or error, back to entry).
// `result` holds the current `AnalysisResult` once analysis finishes.

import { renderGraph } from "./graph.js";

/* ------------------------------------------------------------- helpers */

function $(id) { return document.getElementById(id); }

function esc(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shortAddr(a) {
  if (!a) return "?";
  return a.length > 12 ? a.slice(0, 6) + "\u2026" + a.slice(-4) : a;
}

/** Replaces every full address inside a sentence with its short form, for display in tight spaces. */
function shortenAddressesInText(text) {
  if (!text) return "";
  return text.replace(/0x[a-fA-F0-9]{40}/g, (m) => shortAddr(m));
}

function fnName(sig) {
  if (!sig) return undefined;
  const i = sig.indexOf("(");
  return i === -1 ? sig : sig.slice(0, i);
}

function firstSentence(text) {
  if (!text) return "";
  const m = text.match(/^[^.]*\./);
  return m ? m[0] : text;
}

function formatDuration(days) {
  if (days < 1) return `${(days * 24).toFixed(1)} hours`;
  return `${days.toFixed(2)} days`;
}

function selShort(sel) {
  return sel ? `<span class="mono fn-selector">${esc(sel)}</span>` : "";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return node;
}

/* --------------------------------------------------------------- proofs */
//
// Every observed edge carries the transactions that prove it. This section
// turns a `TxRef` list into clickable proof links to a block explorer.
// When the chain has no known explorer, the app shows the raw hash as
// text with a copy control instead of a dead link. A row with no example
// renders nothing, because nothing proves it.

function explorerTxUrl(hash) {
  const base = state.result && state.result.meta && state.result.meta.explorerTx;
  return base ? base + hash : null;
}

function shortHash(hash) {
  if (!hash) return "?";
  return hash.length > 14 ? hash.slice(0, 6) + "\u2026" + hash.slice(-4) : hash;
}

/** One proof transaction: a link when an explorer is known, a hash plus copy control otherwise. */
function proofNode(tx) {
  const url = explorerTxUrl(tx.hash);
  if (url) {
    return el("a", {
      class: "proof-link mono",
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
      title: `Block ${tx.block}`,
      text: shortHash(tx.hash) + " \u2197",
    });
  }
  const wrap = el("span", { class: "proof-fallback", title: `Block ${tx.block}` }, [
    el("span", { class: "proof-hash mono", text: shortHash(tx.hash) }),
  ]);
  wrap.appendChild(copyButton(tx.hash));
  return wrap;
}

/**
 * A compact proof column for one row: the newest transaction plus a
 * toggle for the rest. Returns `null` when the row has no proof, so the
 * caller renders an empty placeholder instead of a broken link.
 */
function renderProofs(examples) {
  if (!examples || !examples.length) return null;
  const group = el("span", { class: "proof-group" });
  group.appendChild(el("span", { class: "proof-label", text: "proof:" }));
  group.appendChild(proofNode(examples[0]));
  if (examples.length > 1) {
    const rest = examples.slice(1);
    const moreBtn = el("button", { class: "proof-more-btn ghost small", type: "button", text: `+${rest.length}` });
    const morePanel = el("span", { class: "proof-more-panel", hidden: "" });
    for (const tx of rest) morePanel.appendChild(proofNode(tx));
    moreBtn.addEventListener("click", () => { morePanel.hidden = !morePanel.hidden; });
    group.appendChild(moreBtn);
    group.appendChild(morePanel);
  }
  return group;
}

/* ---------------------------------------------------------------- state */

const state = {
  result: null,
  view: "overview",
  selectedSelector: null,
  filters: { text: "", stateChanging: false, hasOutbound: false, observedOnly: false },
  sort: { key: "name", dir: 1 },
  graphController: null,
  graphCollapsed: false,
  chains: [],
  selectedChainKey: "ethereum",
  lastRequest: null,
};

/* --------------------------------------------------------------- auth */
//
// The server gates every `/api/*` route behind an access token when
// `AUTH_TOKEN` is set. The token lives in `localStorage` only, travels as
// the `X-Auth-Token` header on the plain POST fallback, and as the `token`
// query parameter on the `EventSource` URL, because `EventSource` cannot
// set request headers. The token is never written into the page body or
// into the address bar: it stays inside the password-style input and the
// query string of a request that is never a page navigation.

const TOKEN_KEY = "contract-map-auth-token";
let authRetry = null;

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage may be unavailable; the session still works, just unauthenticated */ }
}

function updateAuthStatusUI() {
  $("auth-status").hidden = !getToken();
}

function openAuthModal(retry) {
  authRetry = retry;
  $("auth-token-input").value = "";
  $("auth-modal-error").textContent = "";
  $("auth-modal").hidden = false;
  $("auth-token-input").focus();
}

function closeAuthModal() {
  $("auth-modal").hidden = true;
  authRetry = null;
}

function wireAuth() {
  $("sign-out-btn").addEventListener("click", () => {
    setToken("");
    updateAuthStatusUI();
  });
  $("auth-cancel-btn").addEventListener("click", () => closeAuthModal());
  $("auth-submit-btn").addEventListener("click", () => {
    const value = $("auth-token-input").value.trim();
    if (!value) { $("auth-modal-error").textContent = "Enter a token before you continue."; return; }
    setToken(value);
    updateAuthStatusUI();
    const retry = authRetry;
    closeAuthModal();
    if (retry) retry();
  });
  $("auth-token-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("auth-submit-btn").click(); });
  updateAuthStatusUI();
}

/* ------------------------------------------------------------ chains */

/** Splits the chain list into the two groups the picker shows, filtered by the search text. */
function chainGroups(chains, filterText) {
  const q = filterText.trim().toLowerCase();
  const filtered = q ? chains.filter((c) => c.label.toLowerCase().includes(q) || c.key.toLowerCase().includes(q)) : chains;
  const full = filtered.filter((c) => c.traceFilter).sort((a, b) => a.label.localeCompare(b.label));
  const limited = filtered.filter((c) => !c.traceFilter).sort((a, b) => a.label.localeCompare(b.label));
  const groups = [];
  if (full.length) groups.push({ title: "Full trace support", chains: full });
  if (limited.length) groups.push({ title: "Limited trace support (no trace_filter)", chains: limited });
  return groups;
}

/** Wires the searchable, grouped chain combobox and selects a default chain. */
function buildChainPicker(chains) {
  state.chains = chains;
  const preferred = chains.find((c) => c.key === state.selectedChainKey) || chains.find((c) => c.key === "ethereum") || chains[0];
  state.selectedChainKey = preferred ? preferred.key : "ethereum";
  const input = $("chain-search");
  const options = $("chain-options");
  input.value = preferred ? preferred.label : "";

  function renderOptions(filterText) {
    options.innerHTML = "";
    const groups = chainGroups(state.chains, filterText);
    if (!groups.length) {
      options.appendChild(el("div", { class: "combobox-empty", text: "No chain matches." }));
      return;
    }
    for (const group of groups) {
      options.appendChild(el("div", { class: "combobox-group-label", text: group.title }));
      for (const c of group.chains) {
        const row = el("div", { class: "combobox-option" + (c.key === state.selectedChainKey ? " active" : "") });
        row.appendChild(el("span", { text: c.label }));
        if (c.probeNote) {
          row.appendChild(el("span", { class: "combobox-warn-dot", title: c.probeNote, text: "!" }));
        }
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          state.selectedChainKey = c.key;
          input.value = c.label;
          options.hidden = true;
        });
        options.appendChild(row);
      }
    }
  }

  input.addEventListener("focus", () => { options.hidden = false; renderOptions(input.value === (preferred ? preferred.label : "") ? "" : input.value); });
  input.addEventListener("input", () => { options.hidden = false; renderOptions(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { options.hidden = true; input.blur(); }
    if (e.key === "Enter") {
      const first = options.querySelector(".combobox-option");
      if (first) first.dispatchEvent(new MouseEvent("mousedown"));
      e.preventDefault();
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("chain-combobox").contains(e.target)) options.hidden = true;
  });
}

async function loadChains() {
  try {
    const res = await fetch("/api/chains", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("chains request failed");
    const data = await res.json();
    buildChainPicker(data.chains);
  } catch (err) {
    buildChainPicker([{ id: 1, key: "ethereum", label: "Ethereum", traceFilter: true }]);
  }
}

/* ---------------------------------------------------------- entry flow */

function validateAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function showScreen(id) {
  for (const s of ["entry-screen", "loading-screen", "error-screen", "app-screen"]) {
    $(s).hidden = s !== id;
  }
}

function wireEntry() {
  const addressInput = $("address-input");
  const addressError = $("address-error");
  const analyzeBtn = $("analyze-btn");

  function validate() {
    const v = addressInput.value.trim();
    if (v.length === 0) { addressError.textContent = ""; return false; }
    if (!validateAddress(v)) { addressError.textContent = "Enter an address as 0x followed by 40 hex characters."; return false; }
    addressError.textContent = "";
    return true;
  }

  addressInput.addEventListener("input", validate);
  addressInput.addEventListener("keydown", (e) => { if (e.key === "Enter") analyzeBtn.click(); });

  analyzeBtn.addEventListener("click", () => {
    const v = addressInput.value.trim();
    if (!validateAddress(v)) { addressError.textContent = "Enter a valid address before you start the analysis."; return; }
    const chain = state.selectedChainKey;
    const depth = $("depth-select").value;
    startAnalysis(v, chain, depth);
  });

  $("error-back-btn").addEventListener("click", () => showScreen("entry-screen"));
  $("new-analysis-btn").addEventListener("click", () => {
    state.result = null;
    showScreen("entry-screen");
  });
}

/* -------------------------------------------------------------- loading */

function resetLoading() {
  $("loading-stage").textContent = "Starting analysis\u2026";
  $("progress-fill").style.width = "0%";
  $("progress-pct").textContent = "0%";
  $("loading-log").innerHTML = "";
}

function pushProgress(stage, detail, pct) {
  $("loading-stage").textContent = stage;
  if (typeof pct === "number") {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    $("progress-fill").style.width = clamped + "%";
    $("progress-pct").textContent = clamped + "%";
  }
  const log = $("loading-log");
  const line = document.createElement("div");
  line.textContent = `${stage}${detail ? " \u2014 " + detail : ""}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function showError(message) {
  $("error-message").textContent = message;
  showScreen("error-screen");
}

function startAnalysis(address, chain, depth) {
  resetLoading();
  showScreen("loading-screen");
  state.lastRequest = { address, chain, depth };

  const qs = new URLSearchParams({ address, chain, depth });
  const token = getToken();
  if (token) qs.set("token", token);
  const url = `/api/analyze/stream?${qs.toString()}`;
  let settled = false;
  let source;
  try {
    source = new EventSource(url);
  } catch (err) {
    fallbackToPost(address, chain, depth);
    return;
  }

  source.addEventListener("progress", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      pushProgress(data.stage, data.detail, data.pct);
    } catch (err) { /* ignore malformed progress frame */ }
  });

  source.addEventListener("result", (ev) => {
    settled = true;
    source.close();
    try {
      const data = JSON.parse(ev.data);
      showApp(data);
    } catch (err) {
      showError("The server returned a result that could not be parsed: " + err.message);
    }
  });

  source.addEventListener("error", (ev) => {
    if (settled) return;
    // A named `error` SSE event carries a JSON payload from the server.
    if (ev.data) {
      settled = true;
      source.close();
      try {
        const data = JSON.parse(ev.data);
        showError(data.message || "Analysis failed.");
      } catch (err) {
        showError("Analysis failed.");
      }
      return;
    }
  });

  source.onerror = () => {
    if (settled) return;
    settled = true;
    source.close();
    fallbackToPost(address, chain, depth);
  };
}

async function fallbackToPost(address, chain, depth) {
  pushProgress("Streaming unavailable", "Falling back to a single request.", 5);
  try {
    const headers = { "content-type": "application/json" };
    const token = getToken();
    if (token) headers["X-Auth-Token"] = token;
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({ address, chain, depth }),
      signal: AbortSignal.timeout(120000),
    });
    if (res.status === 401) {
      openAuthModal(() => startAnalysis(address, chain, depth));
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Server returned ${res.status}.`);
    }
    const data = await res.json();
    showApp(data);
  } catch (err) {
    showError(err.message || String(err));
  }
}

/* -------------------------------------------------------------- fixture */

async function loadFixture(variant) {
  resetLoading();
  showScreen("loading-screen");
  pushProgress("Loading fixture", "Reading fixture.json for offline development.", 50);
  try {
    const path = variant ? `fixture-${variant}.json` : "fixture.json";
    const res = await fetch(path);
    const data = await res.json();
    // The fixture may carry a dev-only `chains` list so the searchable
    // picker can be exercised with more entries than the live server has.
    if (Array.isArray(data.chains)) buildChainPicker(data.chains);
    showApp(data);
  } catch (err) {
    showError("Could not load " + (variant ? `fixture-${variant}.json` : "fixture.json") + ": " + err.message);
  }
}

/* ------------------------------------------------------------- app view */

function showApp(result) {
  state.result = result;
  state.view = "overview";
  state.selectedSelector = null;
  showScreen("app-screen");
  renderProvenance();
  renderTabs();
  renderReview();
  switchView("overview");
}

/** A small strip of bars showing where the read slices sit inside the trace span. */
function buildSliceStrip(w) {
  const span = Math.max(1, w.toBlock - w.fromBlock);
  const slices = w.slices && w.slices.length ? w.slices : [{ fromBlock: w.fromBlock, toBlock: w.toBlock }];
  const wrap = el("div", { class: "slice-strip", title: `${slices.length} slice(s) read out of a ${w.blocks}-block span.` });
  for (const s of slices) {
    const leftPct = ((s.fromBlock - w.fromBlock) / span) * 100;
    const widthPct = Math.max(0.6, ((s.toBlock - s.fromBlock) / span) * 100);
    wrap.appendChild(el("div", { class: "slice-bar", style: `left:${leftPct}%; width:${widthPct}%;` }));
  }
  return wrap;
}

function renderProvenance() {
  const r = state.result;
  const w = r.runtime.window;
  const strip = $("provenance-strip");
  strip.innerHTML = "";
  strip.appendChild(el("span", { class: "prov-item" }, [el("strong", { text: r.meta.chainLabel })]));
  strip.appendChild(el("span", { class: "prov-item" }, ["Analysed at block ", el("strong", { class: "mono", text: String(r.meta.headBlock) })]));

  if (r.runtime.available) {
    const spanText = `Span ${formatDuration(w.approxDays)}, ${w.blocks} blocks.`;
    const coverageText = w.strategy === "stratified"
      ? `Read ${(w.slices || []).length} slices, ${w.coveredBlocks} blocks, ${formatDuration(w.coveredDays)}.`
      : `Read the whole span, ${w.coveredBlocks} blocks.`;
    strip.appendChild(el("span", { class: "prov-item", text: spanText }));
    strip.appendChild(el("span", { class: "prov-item", text: coverageText }));
    strip.appendChild(buildSliceStrip(w));
    strip.appendChild(el("span", { class: "prov-item" }, [
      "Sampled ", el("strong", { class: "mono", text: String(w.sampledTxs) }), " of ",
      el("strong", { class: "mono", text: String(w.candidateTxs) }), " candidate txs",
    ]));
    strip.appendChild(el("span", { class: "prov-item prov-note", text: w.note }));
  } else {
    strip.appendChild(el("span", { class: "prov-item prov-note", text: "No runtime trace data is available for this contract." }));
  }
}

function renderTabs() {
  for (const tab of document.querySelectorAll(".tab[data-view]")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
}

function switchView(view) {
  state.view = view;
  state.selectedSelector = null;
  for (const tab of document.querySelectorAll(".tab[data-view]")) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  for (const id of ["overview", "functions", "function-detail", "calls-from", "calls-into", "graph"]) {
    $("view-" + id).hidden = id !== view;
  }
  if (view === "overview") renderOverview();
  if (view === "functions") renderFunctionsTable();
  if (view === "calls-from") renderCallsFrom();
  if (view === "calls-into") renderCallsInto();
  if (view === "graph") renderGraphView();
}

function openFunctionDetail(selector) {
  if (!selector) return;
  state.selectedSelector = selector;
  for (const tab of document.querySelectorAll(".tab[data-view]")) {
    tab.classList.toggle("active", tab.dataset.view === "functions");
  }
  for (const id of ["overview", "functions", "function-detail", "calls-from", "calls-into", "graph"]) {
    $("view-" + id).hidden = id !== "function-detail";
  }
  renderFunctionDetail(selector);
}

/* ------------------------------------------------------------- overview */

function copyButton(text) {
  const btn = el("button", { class: "copy-btn ghost small", type: "button", text: "Copy" });
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1200); }
    catch (err) { btn.textContent = "Failed"; setTimeout(() => (btn.textContent = "Copy"), 1200); }
  });
  return btn;
}

function renderOverview() {
  const r = state.result;
  const o = r.overview;
  const host = $("view-overview");
  host.innerHTML = "";

  const header = el("div", { class: "overview-header" });
  const left = el("div");
  const addrRow = el("div", { class: "overview-address" }, [
    el("span", { text: shortAddr(r.meta.address) }),
  ]);
  addrRow.appendChild(copyButton(r.meta.address));
  left.appendChild(addrRow);

  const tags = el("div", { class: "overview-tags" });
  tags.appendChild(el("span", { class: "tag " + (o.verified ? "ok" : "warn"), text: o.verified ? "Verified" : "Unverified" }));
  if (r.static.sourceProvenance) {
    const label = "Source recovered: " + shortenAddressesInText(firstSentence(r.static.sourceProvenance));
    tags.appendChild(el("span", { class: "tag info source-provenance-badge", text: label, title: r.static.sourceProvenance }));
  }
  if (r.static.vyper) {
    tags.appendChild(el("span", { class: "tag vyper-badge", text: "Vyper", title: "Function bodies were analysed with Vyper rules." }));
  }
  tags.appendChild(el("span", { class: "tag info", text: o.likelyType }));
  if (o.proxy && o.proxy.isProxy) {
    tags.appendChild(el("span", { class: "tag", text: `Proxy (${o.proxy.proxyType || "unknown type"}) \u2192 ${shortAddr(o.proxy.implementation)}` }));
  }
  if (o.token) {
    const t = o.token;
    tags.appendChild(el("span", { class: "tag", text: `${t.name || "Token"} (${t.symbol || "?"}${t.decimals !== undefined ? ", " + t.decimals + " decimals" : ""})` }));
  }
  left.appendChild(tags);
  header.appendChild(left);
  host.appendChild(header);

  const summaryPanel = el("div", { class: "panel" });
  summaryPanel.appendChild(el("p", { class: "panel-title", text: "Summary" }));
  summaryPanel.appendChild(el("p", { class: "summary-text", text: o.summary || "No summary is available." }));
  if (o.interfaces && o.interfaces.length) {
    const ifaceTags = el("div", { class: "overview-tags" });
    for (const i of o.interfaces) ifaceTags.appendChild(el("span", { class: "tag", text: i }));
    summaryPanel.appendChild(ifaceTags);
  }
  host.appendChild(summaryPanel);

  const stats = el("div", { class: "stats-row" });
  const statDefs = [
    ["Exposed functions", o.stats.exposedFunctions],
    ["Outbound contracts", o.stats.outboundContracts],
    ["Inbound contracts", o.stats.inboundContracts],
    ["Observed calls", o.stats.observedCalls],
  ];
  for (const [label, value] of statDefs) {
    stats.appendChild(el("div", { class: "stat-card" }, [
      el("div", { class: "stat-value", text: String(value) }),
      el("div", { class: "stat-label", text: label }),
    ]));
  }
  host.appendChild(stats);

  if (r.static.warnings.length || r.runtime.warnings.length || r.errors.length) {
    const warnPanel = el("div", { class: "panel" });
    warnPanel.appendChild(el("p", { class: "panel-title", text: "Warnings" }));
    for (const w of [...r.errors, ...r.static.warnings, ...r.runtime.warnings]) {
      warnPanel.appendChild(el("p", { class: "summary-text", text: "\u2022 " + w }));
    }
    host.appendChild(warnPanel);
  }
}

/* --------------------------------------------------------- functions tab */

function functionMapFor(selector) {
  return state.result.functions.find((f) => f.selector === selector);
}

function staticFunctionFor(selector) {
  return state.result.static.functions.find((f) => f.selector === selector);
}

/** This contract's own function: full signature when overloaded, bare name otherwise. */
function targetFnDisplay(selector, signature) {
  const fs = selector ? staticFunctionFor(selector) : undefined;
  if (fs) return fs.overloaded ? fs.signature : fs.name + "()";
  if (signature) return fnName(signature) + "()";
  if (selector) return selector;
  return "unknown()";
}

/** A counterparty function we hold no overload information for. */
function externalFnDisplay(signature, selector) {
  if (signature) return fnName(signature) + "()";
  if (selector) return selector;
  return "unknown()";
}

function fnTitle(signature, selector) {
  if (signature) return signature;
  if (selector) return `Unresolved selector ${selector}`;
  return "Unknown function";
}

/** A panel that starts collapsed, with a caret toggle and an optional count in the title. */
function collapsiblePanel(titleText, count, buildBody) {
  const panel = el("div", { class: "panel" });
  const toggle = el("div", { class: "review-toggle" });
  const label = el("p", { class: "panel-title", style: "margin:0;", text: count !== undefined ? `${titleText} (${count})` : titleText });
  const caret = el("span", { class: "mono", text: "\u25B8" });
  toggle.appendChild(label);
  toggle.appendChild(caret);
  const body = el("div");
  body.hidden = true;
  buildBody(body);
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    caret.textContent = body.hidden ? "\u25B8" : "\u25BE";
  });
  panel.appendChild(toggle);
  panel.appendChild(body);
  return panel;
}

function accessBadgeClass(kind) {
  if (kind === "owner" || kind === "role") return "access-owner";
  if (kind === "restricted" || kind === "self") return "access-restricted";
  return "access-open";
}

/* ----------------------------------------------------- compiled code facts */
//
// `bytecodeFacts` exists for every function of a contract that has runtime
// code, verified or not. It answers the reader's first questions about an
// unverified function directly from a control-flow walk of the dispatcher
// branch: does it write storage, does it call out, does it delegatecall. A
// `false` field means the walk did not see the action, never that the
// action cannot happen; `truncated` says the walk stopped early.

const BYTECODE_FACT_DEFS = [
  ["readsStorage", "Reads storage"],
  ["writesStorage", "Writes storage"],
  ["makesCall", "External call"],
  ["makesStaticcall", "Staticcall"],
  ["makesDelegatecall", "Delegatecall"],
  ["createsContract", "Creates contract"],
  ["selfDestructs", "Self destructs"],
];

const BYTECODE_FACT_TAGS = [
  ["readsStorage", "R", "Reads storage"],
  ["writesStorage", "W", "Writes storage"],
  ["makesCall", "call", "Makes an external call"],
  ["makesStaticcall", "static", "Makes a staticcall"],
  ["makesDelegatecall", "delegate", "Makes a delegatecall"],
  ["createsContract", "create", "Creates a contract"],
  ["selfDestructs", "self-destruct", "Self destructs"],
];

/** Maps a lowercase address to a display label and the tab that explains it, when one is known. */
function addressLabelIndex() {
  const map = new Map();
  const r = state.result;
  if (!r) return map;
  map.set(r.meta.address.toLowerCase(), { label: r.meta.label || "This contract", view: "overview" });
  if (r.overview.proxy && r.overview.proxy.isProxy && r.overview.proxy.implementation) {
    map.set(r.overview.proxy.implementation.toLowerCase(), { label: r.overview.proxy.implementationName || "Implementation", view: "overview" });
  }
  for (const c of r.runtime.outbound.contracts) map.set(c.address.toLowerCase(), { label: c.label, view: "calls-from" });
  for (const c of r.runtime.inbound.contracts) map.set(c.address.toLowerCase(), { label: c.label, view: "calls-into" });
  return map;
}

const VIEW_TITLES = { overview: "Overview", "calls-from": "Calls from this contract", "calls-into": "Calls into this contract" };

function addressConstantChip(addr, index) {
  const hit = index.get(addr.toLowerCase());
  if (hit) {
    const btn = el("button", { class: "addr-link mono", type: "button", title: `${hit.label} \u2014 open ${VIEW_TITLES[hit.view]}`, text: `${hit.label} ${shortAddr(addr)}` });
    btn.addEventListener("click", () => switchView(hit.view));
    return btn;
  }
  return el("span", { class: "mono bytecode-chip unlabeled", text: shortAddr(addr) });
}

function chipList(items, render) {
  const wrap = el("div", { class: "bytecode-chip-list" });
  if (items.length) {
    for (const item of items) wrap.appendChild(render(item));
  } else {
    wrap.appendChild(el("span", { class: "empty-note", text: "None" }));
  }
  return wrap;
}

/** The "Compiled code facts" panel shown in the function detail view. */
function renderBytecodeFactsPanel(bf) {
  const panel = el("div", { class: "panel bytecode-facts-panel" });
  panel.appendChild(el("p", { class: "panel-title", text: "Compiled code facts" }));
  panel.appendChild(el("p", { class: "summary-text", text: "These facts come from walking the compiled code. A \u201cno\u201d means the walk did not see the action on the paths it took, not that the action cannot happen." }));

  const grid = el("div", { class: "bytecode-facts-grid" });
  for (const [key, label] of BYTECODE_FACT_DEFS) {
    const yes = !!bf[key];
    grid.appendChild(el("div", { class: "bytecode-fact" }, [
      el("span", { text: label }),
      el("span", { class: "badge " + (yes ? "observed" : "possible"), text: yes ? "yes" : "no" }),
    ]));
  }
  panel.appendChild(grid);

  const index = addressLabelIndex();
  panel.appendChild(el("p", { class: "panel-subtitle", text: "Address constants" }));
  panel.appendChild(chipList(bf.addressConstants, (a) => addressConstantChip(a, index)));

  panel.appendChild(el("p", { class: "panel-subtitle", text: "Event topics" }));
  panel.appendChild(chipList(bf.eventTopics, (t) => el("span", { class: "mono bytecode-chip", text: t })));

  panel.appendChild(el("p", { class: "panel-subtitle", text: "Storage slots" }));
  panel.appendChild(chipList(bf.storageSlots, (s) => el("span", { class: "mono bytecode-chip", text: s })));

  panel.appendChild(el("p", { class: "empty-note", text: `Walked ${bf.blocksWalked} basic block(s).` }));
  if (bf.truncated) {
    panel.appendChild(el("p", { class: "bytecode-warning", text: "The walk stopped early, at a dynamic jump or the block cap. A \u201cno\u201d fact above may still be possible along a path the walk did not take." }));
  }
  return panel;
}

/** Compact tag row for the functions table, used only when the contract has no source. */
function bytecodeFactTags(bf) {
  const wrap = el("div", { class: "fn-bytecode-tags" });
  if (!bf) {
    wrap.appendChild(el("span", { class: "empty-note", text: "not observed" }));
    return wrap;
  }
  let any = false;
  for (const [key, tag, title] of BYTECODE_FACT_TAGS) {
    if (bf[key]) { any = true; wrap.appendChild(el("span", { class: "badge bytecode-tag", title, text: tag })); }
  }
  if (!any) wrap.appendChild(el("span", { class: "empty-note", text: "No actions seen" }));
  if (bf.truncated) wrap.appendChild(el("span", { class: "badge bytecode-tag truncated", title: "The walk stopped early. A \u201cno\u201d fact may still be possible.", text: "\u26A0 truncated" }));
  return wrap;
}

function renderFunctionsTable() {
  const r = state.result;
  const host = $("view-functions");
  host.innerHTML = "";

  const filters = el("div", { class: "filters-row" }, [
    el("input", { type: "text", id: "fn-filter-text", placeholder: "Filter by name, signature, or role\u2026" }),
    el("label", { class: "toggle-label" }, [
      (() => { const c = el("input", { type: "checkbox", id: "fn-filter-state" }); return c; })(),
      "State changing only",
    ]),
    el("label", { class: "toggle-label" }, [
      (() => { const c = el("input", { type: "checkbox", id: "fn-filter-outbound" }); return c; })(),
      "Has outbound calls",
    ]),
    el("label", { class: "toggle-label" }, [
      (() => { const c = el("input", { type: "checkbox", id: "fn-filter-observed" }); return c; })(),
      "Observed only",
    ]),
  ]);
  host.appendChild(filters);

  // An unverified contract has no statement-level evidence, so the table
  // trades the "External calls" detail for a compact compiled-facts column
  // instead of leaving the reader with nothing.
  const showBytecodeCol = !r.static.verified;

  const tableWrap = el("div", { class: "scroll-x panel" });
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  const cols = [
    ["name", "Function"], ["purpose", "Purpose"], ["access", "Access"], ["mutability", "Mutability"], ["calls", "External calls"],
  ];
  if (showBytecodeCol) cols.push(["bytecode", "Compiled facts"]);
  for (const [key, label] of cols) {
    const th = el("th", { text: label });
    if (state.sort.key === key) th.classList.add("sorted");
    if (key !== "bytecode") {
      th.addEventListener("click", () => {
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
        renderFunctionsTable();
      });
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  host.appendChild(tableWrap);

  function applyFiltersAndSort() {
    let rows = r.static.functions.map((fs) => ({ fs, fm: functionMapFor(fs.selector) }));
    const f = state.filters;
    if (f.text) {
      const q = f.text.toLowerCase();
      rows = rows.filter(({ fs }) => fs.name.toLowerCase().includes(q) || fs.signature.toLowerCase().includes(q) || fs.role.toLowerCase().includes(q));
    }
    if (f.stateChanging) rows = rows.filter(({ fs }) => fs.mutability === "nonpayable" || fs.mutability === "payable");
    if (f.hasOutbound) rows = rows.filter(({ fm }) => fm && fm.externalCalls.length > 0);
    if (f.observedOnly) rows = rows.filter(({ fm }) => fm && fm.observed.calls > 0);

    const key = state.sort.key, dir = state.sort.dir;
    rows.sort((a, b) => {
      let av, bv;
      if (key === "name") { av = a.fs.name; bv = b.fs.name; }
      else if (key === "access") { av = a.fs.access.kind; bv = b.fs.access.kind; }
      else if (key === "mutability") { av = a.fs.mutability; bv = b.fs.mutability; }
      else if (key === "calls") { av = a.fm ? a.fm.externalCalls.length : 0; bv = b.fm ? b.fm.externalCalls.length : 0; }
      else { av = a.fs.role; bv = b.fs.role; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function draw() {
    tbody.innerHTML = "";
    const rows = applyFiltersAndSort();
    if (rows.length === 0) {
      tbody.appendChild(el("tr", {}, [el("td", { colspan: String(cols.length), class: "empty-note", text: "No function matches the current filters." })]));
      return;
    }
    for (const { fs, fm } of rows) {
      const tr = el("tr", { class: "fn-row" });
      tr.addEventListener("click", () => openFunctionDetail(fs.selector));

      const nameCell = el("td", {}, [
        el("div", { class: "fn-name", text: fs.overloaded ? fs.signature : fs.name + "()", title: fs.signature }),
        el("div", {}, [selRaw(fs.selector)]),
      ]);
      tr.appendChild(nameCell);

      tr.appendChild(el("td", { text: `${fs.role} \u2014 ${firstSentence(fs.whatItDoes)}` }));

      const accessCell = el("td");
      accessCell.appendChild(el("span", { class: "badge " + accessBadgeClass(fs.access.kind), text: fs.access.kind }));
      tr.appendChild(accessCell);

      const mutCell = el("td");
      mutCell.appendChild(el("span", { class: "badge mutability", text: fs.mutability }));
      tr.appendChild(mutCell);

      const callsCell = el("td", { class: "calls-cell" });
      if (fm && fm.externalCalls.length) {
        for (const c of fm.externalCalls.slice(0, 4)) {
          const chip = el("div", { class: "call-chip" }, [
            el("span", { class: "dest", text: c.destinationLabel + "." + c.functionLabel.replace(/\(\)$/, "()") }),
          ]);
          chip.appendChild(el("span", { class: "badge " + (c.observedOnchain ? "observed" : "possible"), text: c.observedOnchain ? `observed \u00d7${c.observedCalls}` : "possible" }));
          callsCell.appendChild(chip);
        }
        if (fm.externalCalls.length > 4) callsCell.appendChild(el("div", { class: "call-chip", text: `+${fm.externalCalls.length - 4} more` }));
      } else {
        callsCell.appendChild(el("span", { class: "empty-note", text: "None" }));
      }
      tr.appendChild(callsCell);

      if (showBytecodeCol) {
        const bcCell = el("td", { class: "bytecode-cell" }, [bytecodeFactTags(fs.bytecodeFacts)]);
        tr.appendChild(bcCell);
      }

      tbody.appendChild(tr);
    }
  }

  function selRaw(sel) {
    return el("span", { class: "mono fn-selector", text: sel });
  }

  $("fn-filter-text").value = state.filters.text;
  $("fn-filter-state").checked = state.filters.stateChanging;
  $("fn-filter-outbound").checked = state.filters.hasOutbound;
  $("fn-filter-observed").checked = state.filters.observedOnly;

  $("fn-filter-text").addEventListener("input", (e) => { state.filters.text = e.target.value; draw(); });
  $("fn-filter-state").addEventListener("change", (e) => { state.filters.stateChanging = e.target.checked; draw(); });
  $("fn-filter-outbound").addEventListener("change", (e) => { state.filters.hasOutbound = e.target.checked; draw(); });
  $("fn-filter-observed").addEventListener("change", (e) => { state.filters.observedOnly = e.target.checked; draw(); });

  draw();
}

/* ----------------------------------------------------- function detail */

function renderExecutionTree(node, root) {
  const wrap = el("div", { class: "tree-node" + (root ? " root" : "") });
  const badge = node.observedOnchain
    ? el("span", { class: "badge observed" }, [el("span", { class: "badge-dot" }), `observed \u00d7${node.observedCalls}`])
    : el("span", { class: "badge possible" }, [el("span", { class: "badge-dot" }), "possible, not observed"]);
  const label = el("div", { class: "tree-node-label" }, [
    el("span", { class: "tree-node-kind", text: node.kind }),
    el("span", { text: node.label }),
    badge,
  ]);
  wrap.appendChild(label);
  if (node.detail) wrap.appendChild(el("div", { class: "tree-node-detail", text: node.detail }));
  for (const c of node.children) wrap.appendChild(renderExecutionTree(c, false));
  return wrap;
}

function renderFunctionDetail(selector) {
  const r = state.result;
  const fs = r.static.functions.find((f) => f.selector === selector);
  const fm = functionMapFor(selector);
  const host = $("view-function-detail");
  host.innerHTML = "";

  if (!fs) {
    host.appendChild(el("p", { class: "empty-note", text: "This function could not be found in the analysis result." }));
    return;
  }

  const backBtn = el("button", { class: "detail-back ghost", type: "button", text: "\u2190 Back to Exposed functions" });
  backBtn.addEventListener("click", () => switchView("functions"));
  host.appendChild(backBtn);

  const header = el("div", { class: "detail-header" }, [
    el("div", { class: "detail-signature mono", text: fs.signature }),
    el("div", { class: "detail-selector", text: "Selector " + fs.selector }),
  ]);
  host.appendChild(header);

  const whatPanel = el("div", { class: "panel" }, [
    el("p", { class: "panel-title", text: "What it does" }),
    el("p", { class: "summary-text", text: fs.whatItDoes }),
  ]);
  host.appendChild(whatPanel);

  // Compiled code facts exist for every function with runtime code. They
  // matter most, and are placed first, when the function has no source.
  if (fs.bytecodeFacts) host.appendChild(renderBytecodeFactsPanel(fs.bytecodeFacts));

  // Who can call it: access detail plus observed inbound callers of this function.
  const whoPanel = el("div", { class: "panel" });
  whoPanel.appendChild(el("p", { class: "panel-title", text: "Who can call it" }));
  whoPanel.appendChild(el("p", { class: "summary-text", text: fs.access.detail }));
  if (fs.access.gates.length) whoPanel.appendChild(el("p", { class: "summary-text", text: "Gated by: " + fs.access.gates.join(", ") }));
  const inbound = fm ? fm.inbound : [];
  if (inbound.length) {
    const list = el("div", { class: "flow-list" });
    for (const e of inbound.slice().sort((a, b) => b.calls - a.calls)) {
      const callerFnLabel = e.callerSignature ? externalFnDisplay(e.callerSignature, e.callerSelector) : "Unknown caller function";
      const callerFnTitle = e.callerSignature ? fnTitle(e.callerSignature, e.callerSelector) : "Unknown caller function";
      const row = el("div", { class: "flow-row" });
      row.appendChild(el("span", { class: "flow-seg" + (e.callerSignature ? "" : " unknown-fn"), text: e.callerLabel }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg" + (e.callerSignature ? "" : " unknown-fn"), text: callerFnLabel, title: callerFnTitle }));
      row.appendChild(el("span", { class: "flow-arrow", text: "" }));
      row.appendChild(el("span", {}));
      row.appendChild(el("span", { class: "flow-count", text: `${e.calls} calls / ${e.txs} txs` }));
      row.appendChild(renderProofs(e.examples) || el("span", {}));
      list.appendChild(row);
    }
    whoPanel.appendChild(list);
  } else {
    whoPanel.appendChild(el("p", { class: "empty-note", text: "No inbound calls to this function were observed in the traced window." }));
  }
  host.appendChild(whoPanel);

  const grid = el("div", { class: "detail-grid" });

  const readsPanel = el("div", { class: "panel" }, [el("p", { class: "panel-title", text: "Reads" })]);
  if (fs.reads.length) {
    const list = el("div", { class: "kv-list" });
    for (const rd of fs.reads) list.appendChild(el("div", { class: "kv-item" }, [el("span", { class: "kv-name mono", text: rd.name }), el("span", { text: rd.type || "" })]));
    readsPanel.appendChild(list);
  } else {
    readsPanel.appendChild(el("p", { class: "empty-note", text: "No state variables are read directly." }));
  }
  grid.appendChild(readsPanel);

  const writesPanel = el("div", { class: "panel" }, [el("p", { class: "panel-title", text: "Writes" })]);
  if (fs.writes.length) {
    const list = el("div", { class: "kv-list" });
    for (const wr of fs.writes) list.appendChild(el("div", { class: "kv-item" }, [el("span", { class: "kv-name mono", text: wr.name }), el("span", { text: wr.type || "" })]));
    writesPanel.appendChild(list);
  } else {
    writesPanel.appendChild(el("p", { class: "empty-note", text: "No state variables are written directly." }));
  }
  grid.appendChild(writesPanel);
  host.appendChild(grid);

  // Internal calls: the tree nodes of kind "internal" from the function map's execution tree.
  const internalPanel = el("div", { class: "panel" });
  internalPanel.appendChild(el("p", { class: "panel-title", text: "Internal calls" }));
  const internalNodes = fm ? fm.tree.children.filter((c) => c.kind === "internal") : [];
  if (internalNodes.length) {
    for (const n of internalNodes) internalPanel.appendChild(renderExecutionTree(n, true));
  } else {
    internalPanel.appendChild(el("p", { class: "empty-note", text: "No internal function calls were found in code." }));
  }
  host.appendChild(internalPanel);

  // Outbound calls: every row shows possible-from-code and observed-onchain explicitly.
  const outboundPanel = el("div", { class: "panel" });
  outboundPanel.appendChild(el("p", { class: "panel-title", text: "Outbound calls" }));
  const outCalls = fm ? fm.externalCalls : [];
  if (outCalls.length) {
    const list = el("div", { class: "outbound-list" });
    for (const c of outCalls) {
      const row = el("div", { class: "outbound-row" + (c.observedOnchain ? "" : " unobserved") });
      row.appendChild(el("div", { class: "outbound-row-head" }, [
        el("span", { class: "outbound-target mono", text: `${c.destinationLabel}.${c.functionLabel}` }),
        el("span", { class: "mono", text: c.callType }),
      ]));
      row.appendChild(el("p", { class: "outbound-reason", text: c.reason }));
      const badges = el("div", { class: "outbound-badges" });
      badges.appendChild(el("span", { class: "badge mutability", text: `Possible from code: ${c.possibleFromCode ? "yes" : "no"}` }));
      badges.appendChild(el("span", { class: "badge " + (c.observedOnchain ? "observed" : "possible"), text: `Observed onchain: ${c.observedOnchain ? "yes" : "no"}${c.observedOnchain ? ` (${c.observedCalls} calls, ${c.observedTxs} txs)` : ""}` }));
      const outProofs = renderProofs(c.examples);
      if (outProofs) badges.appendChild(outProofs);
      row.appendChild(badges);
      list.appendChild(row);
    }
    outboundPanel.appendChild(list);
  } else {
    outboundPanel.appendChild(el("p", { class: "empty-note", text: "This function makes no external calls." }));
  }
  host.appendChild(outboundPanel);

  // Observed execution.
  const execPanel = el("div", { class: "panel" });
  execPanel.appendChild(el("p", { class: "panel-title", text: "Observed execution" }));
  if (fm && fm.observed.calls > 0) {
    execPanel.appendChild(el("p", { class: "summary-text", text: `Observed ${fm.observed.calls} entries across ${fm.observed.txs} transactions in the traced window.` }));
    const execProofs = renderProofs(fm.observed.examples);
    if (execProofs) execPanel.appendChild(el("div", { class: "exec-proof-row" }, [execProofs]));
  } else {
    execPanel.appendChild(el("p", { class: "empty-note", text: "No sampled transaction exercises this function in the traced window." }));
  }
  host.appendChild(execPanel);

  // Narrative: an ordered account of one execution.
  const narrPanel = el("div", { class: "panel" });
  narrPanel.appendChild(el("p", { class: "panel-title", text: "Possible execution" }));
  if (fm && fm.narrative.length) {
    const ol = el("ol", { class: "narrative-list" });
    for (const line of fm.narrative) ol.appendChild(el("li", { text: line }));
    narrPanel.appendChild(ol);
  } else {
    narrPanel.appendChild(el("p", { class: "empty-note", text: "No narrative is available for this function." }));
  }
  host.appendChild(narrPanel);

  // Analysis limits: caller notes, collapsed by default so they never crowd out the real content.
  if (fs.notes.length) {
    host.appendChild(collapsiblePanel("Analysis limits", fs.notes.length, (body) => {
      for (const n of fs.notes) body.appendChild(el("p", { class: "summary-text", text: n }));
    }));
  }
}

/* -------------------------------------------------------- calls from/into */

function contractRollupCard(agg, direction) {
  const card = el("div", { class: "rollup-card" });
  card.appendChild(el("div", { class: "rollup-card-title mono", text: agg.label }));
  card.appendChild(el("div", { class: "rollup-fn-line" }, [el("span", { text: "Total" }), el("span", { text: `${agg.calls} calls / ${agg.txs} txs` })]));
  const fnTitle = direction === "out" ? "Functions called" : "Functions called on this address";
  card.appendChild(el("p", { class: "empty-note", style: "margin:6px 0 2px;", text: fnTitle }));
  for (const f of agg.functions) {
    card.appendChild(el("div", { class: "rollup-fn-line" }, [
      el("span", { text: f.signature ? fnName(f.signature) + "()" : "Unknown function" }),
      el("span", { text: String(f.calls) }),
    ]));
  }
  card.appendChild(el("p", { class: "empty-note", style: "margin:6px 0 2px;", text: direction === "out" ? "Target functions that caused this" : "Target functions called" }));
  for (const f of agg.targetFunctions) {
    card.appendChild(el("div", { class: "rollup-fn-line" }, [
      el("span", { text: f.signature ? fnName(f.signature) + "()" : "unknown()" }),
      el("span", { text: String(f.calls) }),
    ]));
  }
  const proofs = renderProofs(agg.examples);
  if (proofs) card.appendChild(el("div", { class: "rollup-proof-row" }, [proofs]));
  return card;
}

function renderCallsFrom() {
  const r = state.result;
  const host = $("view-calls-from");
  host.innerHTML = "";
  host.appendChild(el("h2", { class: "section-title", text: "Outbound calls" }));

  const edges = r.runtime.outbound.edges.slice().sort((a, b) => b.calls - a.calls);
  if (!edges.length) {
    host.appendChild(el("p", { class: "empty-note", text: "No outbound calls were found in code or traces." }));
  } else {
    const list = el("div", { class: "flow-list panel" });
    for (const e of edges) {
      const observed = e.calls > 0;
      const row = el("div", { class: "flow-row" + (observed ? "" : " unobserved") });
      row.appendChild(el("span", { class: "flow-seg", text: targetFnDisplay(e.targetSelector, e.targetSignature), title: fnTitle(e.targetSignature, e.targetSelector) }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg", text: e.destinationLabel }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg", text: externalFnDisplay(e.destinationSignature, e.destinationSelector), title: fnTitle(e.destinationSignature, e.destinationSelector) }));
      row.appendChild(el("span", { class: "flow-count", text: observed ? `${e.calls} calls` : "possible only" }));
      row.appendChild(renderProofs(e.examples) || el("span", {}));
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  host.appendChild(el("h2", { class: "section-title", text: "Outbound contracts (roll-up)" }));
  if (!r.runtime.outbound.contracts.length) {
    host.appendChild(el("p", { class: "empty-note", text: "No outbound contracts were found." }));
  } else {
    const grid = el("div", { class: "rollup-grid" });
    for (const agg of r.runtime.outbound.contracts.slice().sort((a, b) => b.calls - a.calls)) grid.appendChild(contractRollupCard(agg, "out"));
    host.appendChild(grid);
  }

  host.appendChild(el("h2", { class: "section-title", text: "Delegatecalls" }));
  const dcs = r.runtime.delegatecalls;
  if (!dcs.length) {
    host.appendChild(el("p", { class: "empty-note", text: "No delegatecalls were found." }));
  } else {
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("p", { class: "summary-text", text: "Delegatecalls execute with this contract's storage. They are kept separate from ordinary outbound calls." }));
    const list = el("div", { class: "flow-list" });
    for (const e of dcs) {
      const row = el("div", { class: "flow-row" });
      row.appendChild(el("span", { class: "flow-seg", text: "(any function, via proxy)" }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg", text: e.destinationLabel }));
      row.appendChild(el("span", { class: "flow-arrow", text: "" }));
      row.appendChild(el("span", {}));
      row.appendChild(el("span", { class: "flow-count", text: `${e.calls} calls / ${e.txs} txs` }));
      row.appendChild(renderProofs(e.examples) || el("span", {}));
      list.appendChild(row);
    }
    panel.appendChild(list);
    host.appendChild(panel);
  }
}

function renderCallsInto() {
  const r = state.result;
  const host = $("view-calls-into");
  host.innerHTML = "";
  host.appendChild(el("h2", { class: "section-title", text: "Inbound calls" }));

  const edges = r.runtime.inbound.edges.slice().sort((a, b) => b.calls - a.calls);
  if (!edges.length) {
    host.appendChild(el("p", { class: "empty-note", text: "No inbound calls were observed in the traced window." }));
  } else {
    const list = el("div", { class: "flow-list panel" });
    for (const e of edges) {
      const callerFn = e.callerSignature ? externalFnDisplay(e.callerSignature, e.callerSelector) : "Unknown caller function";
      const callerTitle = e.callerSignature ? fnTitle(e.callerSignature, e.callerSelector) : "Unknown caller function";
      const row = el("div", { class: "flow-row" });
      row.appendChild(el("span", { class: "flow-seg", text: e.callerLabel }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg" + (e.callerSignature ? "" : " unknown-fn"), text: callerFn, title: callerTitle }));
      row.appendChild(el("span", { class: "flow-arrow", text: "\u2192" }));
      row.appendChild(el("span", { class: "flow-seg", text: targetFnDisplay(e.targetSelector, e.targetSignature), title: fnTitle(e.targetSignature, e.targetSelector) }));
      row.appendChild(el("span", { class: "flow-count", text: `${e.calls} calls` }));
      row.appendChild(renderProofs(e.examples) || el("span", {}));
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  host.appendChild(el("h2", { class: "section-title", text: "Inbound contracts (roll-up)" }));
  if (!r.runtime.inbound.contracts.length) {
    host.appendChild(el("p", { class: "empty-note", text: "No inbound contracts were observed." }));
  } else {
    const grid = el("div", { class: "rollup-grid" });
    for (const agg of r.runtime.inbound.contracts.slice().sort((a, b) => b.calls - a.calls)) grid.appendChild(contractRollupCard(agg, "in"));
    host.appendChild(grid);
  }
}

/* ---------------------------------------------------------------- graph */

function renderGraphView() {
  const r = state.result;
  const host = $("view-graph");
  host.innerHTML = "";

  const toolbar = el("div", { class: "graph-toolbar" });
  const collapseLabel = el("label", { class: "toggle-label" });
  const collapseInput = el("input", { type: "checkbox", id: "graph-collapse-toggle" });
  collapseInput.checked = state.graphCollapsed;
  collapseLabel.appendChild(collapseInput);
  collapseLabel.appendChild(document.createTextNode("Collapse to contracts"));
  toolbar.appendChild(collapseLabel);

  const legend = el("div", { class: "graph-legend" }, [
    el("span", {}, [el("span", { class: "legend-swatch", style: "background:var(--observed);" }), "Observed"]),
    el("span", {}, [el("span", { class: "legend-swatch", style: "background:var(--text-3); border-top: 2px dashed var(--text-3);" }), "Possible, not observed"]),
  ]);
  toolbar.appendChild(legend);
  host.appendChild(toolbar);

  const container = el("div", { id: "graph-container" });
  host.appendChild(container);

  const controller = renderGraph(container, r, {
    onSelectFunction: (selector) => { if (selector) openFunctionDetail(selector); },
    explorerTx: r.meta.explorerTx,
  });
  state.graphController = controller;
  controller.setCollapsed(state.graphCollapsed);

  collapseInput.addEventListener("change", (e) => {
    state.graphCollapsed = e.target.checked;
    controller.setCollapsed(state.graphCollapsed);
  });
}

/* --------------------------------------------------------------- review */

function renderReview() {
  const r = state.result;
  const body = $("review-body");
  body.innerHTML = "";
  for (const c of r.review.checks) {
    body.appendChild(el("div", { class: "review-check " + c.status }, [
      el("span", { class: "status-dot" }),
      el("div", {}, [
        el("div", { class: "review-check-title", text: c.title }),
        el("div", { class: "review-check-detail", text: c.detail }),
      ]),
    ]));
  }
}

$("review-toggle").addEventListener("click", () => {
  const body = $("review-body");
  const caret = $("review-caret");
  body.hidden = !body.hidden;
  caret.textContent = body.hidden ? "\u25B8" : "\u25BE";
});

/* ---------------------------------------------------------------- init */

function init() {
  wireEntry();
  wireAuth();
  const params = new URLSearchParams(window.location.search);
  if (params.get("fixture") === "1") {
    // Offline development mode: never touch the network.
    loadFixture(params.get("variant") || undefined);
  } else {
    loadChains();
    showScreen("entry-screen");
  }
}

init();
