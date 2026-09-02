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

  function addEdge(from, to, calls, possible, observed) {
    const id = from + "->" + to;
    const existing = edgeMap.get(id);
    if (existing) {
      existing.calls += calls;
      existing.possible = existing.possible || possible;
      existing.observed = existing.observed || observed;
      return;
    }
    edgeMap.set(id, { from, to, calls, possible, observed });
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
    addEdge(leftId, midId, e.calls, false, e.calls > 0);
  }

  // Right column: outbound edges, target function -> destination function.
  for (const e of rt.outbound.edges) {
    const rightId = collapsed ? "right:" + e.destination : "right:" + e.destination + "|" + (e.destinationSelector || "");
    const prefix = counterpartyPrefix(e.destinationLabel, e.destination);
    const label = collapsed ? shortLabel(e.destinationLabel, e.destination) : `${prefix}.${fnLabel(e.destinationSignature) || "unknown()"}`;
    const sub = collapsed ? undefined : shortLabel(e.destinationLabel, e.destination);
    addNode(rightId, 2, label, sub, e.destination, e.calls);
    const midId = "mid:" + (e.targetSelector || "?");
    addEdge(midId, rightId, e.calls, e.possibleFromCode === true, e.calls > 0);
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

/**
 * Render the graph into `container`. Returns a controller with
 * `setCollapsed(bool)` and `destroy()`.
 */
export function renderGraph(container, result, options = {}) {
  const onSelectFunction = options.onSelectFunction || (() => {});
  let collapsed = false;
  let caps = { 0: DEFAULT_CAP, 1: DEFAULT_CAP, 2: DEFAULT_CAP };

  function draw() {
    container.innerHTML = "";
    const model = buildModel(result, collapsed);
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
      const title = svgEl("title", {});
      title.textContent = e.observed
        ? `${e.calls} observed call${e.calls === 1 ? "" : "s"}`
        : "Possible from code, not observed onchain";
      path.appendChild(title);
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

    svg.appendChild(headerGroup);
    svg.appendChild(edgeGroup);
    svg.appendChild(nodeGroup);
    container.appendChild(svg);

    // "Show more" controls, one per column that is capped.
    const controls = document.createElement("div");
    controls.className = "graph-toolbar";
    controls.style.marginTop = "8px";
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
    container.after(controls);
    if (container._controls) container._controls.remove();
    container._controls = controls;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  }

  draw();

  return {
    setCollapsed(v) { collapsed = v; caps = { 0: DEFAULT_CAP, 1: DEFAULT_CAP, 2: DEFAULT_CAP }; draw(); },
    destroy() { container.innerHTML = ""; if (container._controls) container._controls.remove(); },
  };
}
