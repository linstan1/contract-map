// Function-level call graph, rendered as inline SVG with no library.
//
// Three columns: caller function, target function, destination function.
// The middle column is always the analysed contract's own functions. The
// left and right columns collapse to one node per address when the caller
// asks for the contract-level view.

const COL_W = 380;
const NODE_H = 30;
const ROW_GAP = 10;
const PAD = 24;
const HEADER_H = 30;
const DEFAULT_CAP = 18;

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

function short(addr) {
  return addr && addr.length > 12 ? addr.slice(0, 6) + "\u2026" + addr.slice(-4) : (addr || "?");
}

function fnLabel(sig) {
  if (!sig) return undefined;
  const i = sig.indexOf("(");
  return i === -1 ? sig + "()" : sig.slice(0, i) + "()";
}

/**
 * Build the node/edge model for one collapse state.
 * `collapsed` merges every node down to its contract address.
 */
function buildModel(result, collapsed) {
  const rt = result.runtime;
  const nodes = new Map(); // id -> { id, col, label, sub, calls, addr }
  const edgeMap = new Map(); // id -> { from, to, calls, possible, observed }

  function addNode(id, col, label, sub, addr, calls) {
    const existing = nodes.get(id);
    if (existing) { existing.calls += calls; return; }
    nodes.set(id, { id, col, label, sub, addr, calls });
  }

  function addEdge(from, to, calls, possible, observed, examples) {
    const id = from + "->" + to;
    let existing = edgeMap.get(id);
    if (!existing) {
      existing = { from, to, calls: 0, possible: false, observed: false, examples: [] };
      edgeMap.set(id, existing);
    }
    existing.calls += calls;
    existing.possible = existing.possible || possible;
    existing.observed = existing.observed || observed;
    // Proofs merge from every underlying edge collapsed into this one node
    // pair. Keep at most 5 distinct transactions, newest additions first.
    for (const tx of examples || []) {
      if (existing.examples.length >= 5) break;
      if (!existing.examples.some((t) => t.hash === tx.hash)) existing.examples.push(tx);
    }
  }

  // Middle column: every exposed function of the target contract.
  for (const fm of result.functions) {
    const midId = "mid:" + fm.selector;
    addNode(midId, 1, targetLabel(result, fm.selector, fm.signature), fm.selector, result.meta.address, fm.observed.calls);
  }

  // Left column: inbound edges, caller function -> target function.
  for (const e of rt.inbound.edges) {
    const leftId = collapsed ? "left:" + e.caller : "left:" + e.caller + "|" + (e.callerSelector || "");
    const prefix = counterpartyPrefix(e.callerLabel, e.caller);
    const label = collapsed ? shortLabel(e.callerLabel, e.caller) : (e.callerSignature ? `${prefix}.${fnLabel(e.callerSignature)}` : `${prefix} \u2014 Unknown caller function`);
    const sub = collapsed ? undefined : shortLabel(e.callerLabel, e.caller);
    addNode(leftId, 0, label, sub, e.caller, e.calls);
    const midId = "mid:" + (e.targetSelector || "?");
    addEdge(leftId, midId, e.calls, false, e.calls > 0, e.examples);
  }

  // Right column: outbound edges, target function -> destination function.
  for (const e of rt.outbound.edges) {
    const rightId = collapsed ? "right:" + e.destination : "right:" + e.destination + "|" + (e.destinationSelector || "");
    const prefix = counterpartyPrefix(e.destinationLabel, e.destination);
    const label = collapsed ? shortLabel(e.destinationLabel, e.destination) : `${prefix}.${fnLabel(e.destinationSignature) || "unknown()"}`;
    const sub = collapsed ? undefined : shortLabel(e.destinationLabel, e.destination);
    addNode(rightId, 2, label, sub, e.destination, e.calls);
    const midId = "mid:" + (e.targetSelector || "?");
    addEdge(midId, rightId, e.calls, e.possibleFromCode === true, e.calls > 0, e.examples);
  }

  return { nodes: [...nodes.values()], edges: [...edgeMap.values()] };
}

/** Prefix used for a non-collapsed caller/destination node: name plus a short address, or the address alone. */
function counterpartyPrefix(label, addr) {
  return label && !/^0x/.test(label) ? `${label} ${short(addr)}` : short(addr);
}

/** This contract's own function: full signature when overloaded, bare name otherwise. */
function targetLabel(result, selector, signature) {
  const fs = result.static.functions.find((f) => f.selector === selector);
  if (fs) return fs.overloaded ? fs.signature : fs.name + "()";
  return fnLabel(signature) || selector || "unknown()";
}
function shortLabel(label, addr) {
  return label && !/^0x/.test(label) ? label : short(addr);
}

function layoutColumn(nodesInCol, cap, x) {
  const sorted = nodesInCol.slice().sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
  const visible = sorted.slice(0, cap);
  const hiddenCount = sorted.length - visible.length;
  const positions = new Map();
  visible.forEach((n, i) => {
    positions.set(n.id, { x, y: PAD + HEADER_H + i * (NODE_H + ROW_GAP), node: n });
  });
  return { positions, hiddenCount, total: sorted.length };
}

function edgePath(x1, y1, x2, y2) {
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function shortHash(hash) {
  return hash && hash.length > 14 ? hash.slice(0, 6) + "\u2026" + hash.slice(-4) : (hash || "?");
}

/**
 * Inner content for the edge proof panel: the edge label plus its proof
 * links. Falls back to a hash and a copy control when no explorer base
 * URL is known, and to a plain note when the edge carries no proof.
 */
function buildEdgePanelContent(fromLabel, toLabel, edge, explorerTx) {
  const frag = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "graph-edge-panel-title mono";
  title.textContent = `${fromLabel} \u2192 ${toLabel}`;
  frag.appendChild(title);

  if (!edge.examples || !edge.examples.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = edge.observed
      ? "This edge was observed, but no proof transaction was recorded."
      : "Possible from code. No transaction has exercised this edge yet.";
    frag.appendChild(note);
    return frag;
  }

  const list = document.createElement("div");
  list.className = "graph-edge-panel-proofs";
  for (const tx of edge.examples) {
    if (explorerTx) {
      const a = document.createElement("a");
      a.className = "proof-link mono";
      a.href = explorerTx + tx.hash;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `Block ${tx.block}`;
      a.textContent = shortHash(tx.hash) + " \u2197";
      list.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.className = "proof-fallback";
      span.title = `Block ${tx.block}`;
      const hashSpan = document.createElement("span");
      hashSpan.className = "proof-hash mono";
      hashSpan.textContent = shortHash(tx.hash);
      span.appendChild(hashSpan);
      const btn = document.createElement("button");
      btn.className = "copy-btn ghost small";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(tx.hash); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1200); }
        catch { btn.textContent = "Failed"; setTimeout(() => (btn.textContent = "Copy"), 1200); }
      });
      span.appendChild(btn);
      list.appendChild(span);
    }
  }
  frag.appendChild(list);
  return frag;
}

/**
 * Render the graph into `container`. Returns a controller with
 * `setCollapsed(bool)` and `destroy()`.
 */
export function renderGraph(container, result, options = {}) {
  const onSelectFunction = options.onSelectFunction || (() => {});
  const explorerTx = options.explorerTx || null;
  let collapsed = false;
  let pinnedEdgeKey = null;
  let caps = { 0: DEFAULT_CAP, 1: DEFAULT_CAP, 2: DEFAULT_CAP };

  function draw() {
    container.innerHTML = "";
    const model = buildModel(result, collapsed);
    const nodeLabelById = new Map(model.nodes.map((n) => [n.id, n.label]));
    const edgePanel = document.createElement("div");
    edgePanel.className = "graph-edge-panel";
    edgePanel.hidden = true;
    const byCol = { 0: [], 1: [], 2: [] };
    for (const n of model.nodes) byCol[n.col].push(n);

    const colX = [PAD, PAD + COL_W, PAD + COL_W * 2];
    const layouts = [
      layoutColumn(byCol[0], caps[0], colX[0]),
      layoutColumn(byCol[1], caps[1], colX[1]),
      layoutColumn(byCol[2], caps[2], colX[2]),
    ];

    const allPositions = new Map();
    for (const l of layouts) for (const [id, p] of l.positions) allPositions.set(id, p);

    const maxRows = Math.max(...layouts.map(l => l.positions.size), 1);
    const height = PAD * 2 + HEADER_H + maxRows * (NODE_H + ROW_GAP);
    const width = colX[2] + COL_W;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });

    const headerGroup = svgEl("g", { class: "graph-headers" });
    const headerNames = ["Inbound callers", "This contract", "Outbound destinations"];
    colX.forEach((x, i) => {
      const t = svgEl("text", { x, y: PAD, class: "graph-col-header" });
      t.textContent = headerNames[i];
      headerGroup.appendChild(t);
    });

    const edgeGroup = svgEl("g", { class: "edge-group" });
    const nodeGroup = svgEl("g", { class: "node-group" });

    const maxCalls = Math.max(1, ...model.edges.map(e => e.calls));
    const edgeEls = [];
    for (const e of model.edges) {
      const from = allPositions.get(e.from);
      const to = allPositions.get(e.to);
      if (!from || !to) continue; // one side capped out of view
      const x1 = from.x + COL_W - 90, y1 = from.y + NODE_H / 2;
      const x2 = to.x, y2 = to.y + NODE_H / 2;
      const width_ = e.observed ? 1 + Math.round((e.calls / maxCalls) * 5) : 1.2;
      const cls = ["graph-edge", e.observed ? "observed" : "possible"].join(" ");
      const path = svgEl("path", { d: edgePath(x1, y1, x2, y2), class: cls, "stroke-width": width_ });
      path.dataset.from = e.from;
      path.dataset.to = e.to;
      path.style.cursor = "pointer";
      const title = svgEl("title", {});
      title.textContent = e.observed
        ? `${e.calls} observed call${e.calls === 1 ? "" : "s"}`
        : "Possible from code, not observed onchain";
      path.appendChild(title);
      const edgeKey = e.from + "->" + e.to;
      path.addEventListener("mouseenter", () => { highlightEdge(path); if (!pinnedEdgeKey) showEdgePanel(e); });
      path.addEventListener("mouseleave", () => { clearEdgeHighlight(path); if (!pinnedEdgeKey) hideEdgePanel(); });
      path.addEventListener("click", () => {
        if (pinnedEdgeKey === edgeKey) { pinnedEdgeKey = null; hideEdgePanel(); }
        else { pinnedEdgeKey = edgeKey; showEdgePanel(e); }
      });
      edgeGroup.appendChild(path);
      edgeEls.push(path);
    }

    const nodeEls = new Map();
    for (const l of layouts) {
      for (const [id, p] of l.positions) {
        const n = p.node;
        const g = svgEl("g", { class: "graph-node", transform: `translate(${p.x},${p.y})` });
        const rectW = COL_W - 90;
        g.appendChild(svgEl("rect", { width: rectW, height: NODE_H, rx: 4 }));
        const text = svgEl("text", { x: 8, y: NODE_H / 2 + 4 });
        text.textContent = truncate(n.label, 40);
        g.appendChild(text);
        const titleEl = svgEl("title", {});
        titleEl.textContent = n.sub ? `${n.label} \u2014 ${n.sub}` : n.label;
        g.appendChild(titleEl);
        g.dataset.id = id;
        g.addEventListener("mouseenter", () => highlight(id));
        g.addEventListener("mouseleave", () => clearHighlight());
        if (n.col === 1) {
          g.style.cursor = "pointer";
          g.addEventListener("click", () => onSelectFunction(n.sub));
        }
        nodeGroup.appendChild(g);
        nodeEls.set(id, g);
      }
    }

    function highlight(id) {
      for (const path of edgeEls) {
        const on = path.dataset.from === id || path.dataset.to === id;
        path.classList.toggle("highlight", on);
      }
      for (const [nid, g] of nodeEls) {
        const on = nid === id || edgeEls.some(p => p.classList.contains("highlight") && (p.dataset.from === nid || p.dataset.to === nid));
        g.classList.toggle("highlight", on);
      }
    }
    function clearHighlight() {
      for (const path of edgeEls) path.classList.remove("highlight");
      for (const [, g] of nodeEls) g.classList.remove("highlight");
    }
    function highlightEdge(path) {
      path.classList.add("highlight");
      const fromNode = nodeEls.get(path.dataset.from);
      const toNode = nodeEls.get(path.dataset.to);
      if (fromNode) fromNode.classList.add("highlight");
      if (toNode) toNode.classList.add("highlight");
    }
    function clearEdgeHighlight(path) {
      path.classList.remove("highlight");
      const fromNode = nodeEls.get(path.dataset.from);
      const toNode = nodeEls.get(path.dataset.to);
      if (fromNode) fromNode.classList.remove("highlight");
      if (toNode) toNode.classList.remove("highlight");
    }
    function showEdgePanel(e) {
      edgePanel.innerHTML = "";
      const fromLabel = nodeLabelById.get(e.from) || e.from;
      const toLabel = nodeLabelById.get(e.to) || e.to;
      edgePanel.appendChild(buildEdgePanelContent(fromLabel, toLabel, e, explorerTx));
      edgePanel.hidden = false;
    }
    function hideEdgePanel() {
      edgePanel.hidden = true;
    }

    svg.appendChild(headerGroup);
    svg.appendChild(edgeGroup);
    svg.appendChild(nodeGroup);
    container.appendChild(svg);

    // Footer: capped-column controls, then the edge proof panel.
    const footer = document.createElement("div");
    footer.className = "graph-footer";

    const controls = document.createElement("div");
    controls.className = "graph-toolbar";
    const colNames = ["Callers", "This contract", "Destinations"];
    layouts.forEach((l, i) => {
      if (l.hiddenCount > 0) {
        const btn = document.createElement("button");
        btn.className = "small";
        btn.type = "button";
        btn.textContent = `Show more ${colNames[i]} (${l.hiddenCount} hidden)`;
        btn.addEventListener("click", () => { caps[i] += DEFAULT_CAP; draw(); });
        controls.appendChild(btn);
      }
    });
    footer.appendChild(controls);
    footer.appendChild(edgePanel);

    container.after(footer);
    if (container._footer) container._footer.remove();
    container._footer = footer;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  }

  draw();

  return {
    setCollapsed(v) { collapsed = v; pinnedEdgeKey = null; caps = { 0: DEFAULT_CAP, 1: DEFAULT_CAP, 2: DEFAULT_CAP }; draw(); },
    destroy() { container.innerHTML = ""; if (container._footer) container._footer.remove(); },
  };
}
