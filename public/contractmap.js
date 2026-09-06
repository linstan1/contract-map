// Contract-level neighbourhood map, rendered as inline SVG with no library.
//
// One hub and two spokes. The hub is the analysed contract. The left spoke
// holds the contracts that called it, the right spoke holds the contracts it
// called. Nodes are contracts, never functions: every edge is the roll-up of
// all function-level calls between the two addresses.
//
// Each card carries a short description. Every word of it comes from a
// recovered fact: a token symbol, a verified contract name, the contract or
// account decision, and the functions the traces really show. Nothing here
// is guessed, so an address the explorer refused to describe says so.

const SIDE_W = 306;
const CENTER_W = 336;
const GAP = 104;
const PAD = 24;
const HEADER_H = 34;
const ROW_GAP = 12;
const LINE_H = 14;
const CARD_PAD_Y = 10;
const DESC_CHARS = 47;
const MAX_DESC_LINES = 3;
const TOP_N = 10;

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  return node;
}

function short(addr) {
  return addr && addr.length > 12 ? addr.slice(0, 6) + "\u2026" + addr.slice(-4) : (addr || "?");
}

function fnName(sig) {
  if (!sig) return null;
  const i = sig.indexOf("(");
  return (i === -1 ? sig : sig.slice(0, i)) + "()";
}

/** Splits a sentence into at most `maxLines` lines of at most `max` characters. */
function wrapText(text, max, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? current + " " + word : word;
    if (next.length <= max) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines) break;
    current = word.length > max ? word.slice(0, max - 1) + "\u2026" : word;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.length > lines.join(" ").split(/\s+/).length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > max - 1 ? last.slice(0, max - 1) + "\u2026" : last + "\u2026";
  }
  return lines;
}

/** The distinct function names on one side of a roll-up, most called first. */
function topFunctions(counts, limit) {
  const seen = new Set();
  const names = [];
  for (const f of (counts || []).slice().sort((a, b) => b.calls - a.calls)) {
    const name = fnName(f.signature) || f.selector;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length === limit) break;
  }
  return names;
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/** What the address is: token, named contract, plain contract, or account. */
function identityPhrase(agg) {
  const token = agg.token || {};
  const symbol = token.symbol;
  const tokenName = token.name;
  if (symbol || tokenName) {
    const head = tokenName && symbol && tokenName !== symbol ? `${tokenName} (${symbol})` : (tokenName || symbol);
    return `${head} token`;
  }
  const kind = agg.kind || "contract";
  if (kind === "eoa") return "Externally owned account";
  /* The card title already shows the label, so repeat the name only when the
   * label does not already start with it. The pipeline appends a short address
   * to a label that two contracts share, so an exact match is not enough. */
  const name = agg.name && !String(agg.label || "").startsWith(agg.name) ? agg.name : null;
  if (kind === "unknown") return name ? `${name}, type unknown` : "Address no source described";
  const status = agg.verified ? "verified contract" : "unverified contract";
  return name ? `${name}, ${status}` : status;
}

/**
 * The one-line description under a card title: what the address is, then
 * what the traced sample shows it doing with the analysed contract.
 */
function describe(agg, direction) {
  const parts = [identityPhrase(agg)];
  if (direction === "in") {
    const targetFns = topFunctions(agg.targetFunctions, 3);
    const callerFns = topFunctions(agg.functions, 2);
    if (targetFns.length) parts.push(`calls ${joinList(targetFns)} here`);
    else parts.push("caller of this contract");
    if (callerFns.length) parts.push(`from ${joinList(callerFns)}`);
  } else {
    const ownFns = topFunctions(agg.functions, 3);
    const targetFns = topFunctions(agg.targetFunctions, 2);
    if (ownFns.length) parts.push(`this contract calls ${joinList(ownFns)}`);
    else parts.push("called by this contract");
    if (targetFns.length) parts.push(`from ${joinList(targetFns)}`);
  }
  return parts.join(", ") + ".";
}

/** Description of the hub: the type the analysis settled on, plus the proxy and standards facts. */
function describeTarget(result) {
  const o = result.overview;
  const parts = [o.likelyType || "Contract"];
  parts.push(o.verified ? "verified source" : "no verified source");
  /* `likelyType` often already says "proxy"; do not say it twice. */
  if (o.proxy && o.proxy.isProxy && !/proxy/i.test(parts[0])) {
    parts.push("proxy");
  }
  if (o.proxy && o.proxy.isProxy && o.proxy.implementation) {
    parts.push(`code runs from the implementation at ${short(o.proxy.implementation)}`);
  }
  if (o.interfaces && o.interfaces.length) parts.push(`matches ${o.interfaces.slice(0, 3).join(", ")}`);
  return parts.join(", ") + ".";
}

function callsText(agg) {
  if (!agg.calls) return "possible from code, not observed";
  const calls = `${agg.calls} call${agg.calls === 1 ? "" : "s"}`;
  return agg.txs ? `${calls} / ${agg.txs} tx${agg.txs === 1 ? "" : "s"}` : calls;
}

/** Builds one side of the map: the top contracts, and what was left out. */
function sideNodes(aggregates, direction) {
  const usable = (aggregates || []).filter((a) => (a.kind || "contract") !== "eoa");
  const accounts = (aggregates || []).length - usable.length;
  const ranked = usable.slice().sort((a, b) => b.calls - a.calls || a.address.localeCompare(b.address));
  const shown = ranked.slice(0, TOP_N);
  return {
    accounts,
    hidden: ranked.length - shown.length,
    total: ranked.length,
    nodes: shown.map((agg) => {
      const lines = wrapText(describe(agg, direction), DESC_CHARS, MAX_DESC_LINES);
      return {
        agg,
        direction,
        title: agg.label,
        meta: `${short(agg.address)}  \u00b7  ${callsText(agg)}`,
        lines,
        height: CARD_PAD_Y * 2 + LINE_H * (2 + lines.length),
      };
    }),
  };
}

function columnHeight(nodes) {
  return nodes.reduce((sum, n) => sum + n.height + ROW_GAP, 0) - (nodes.length ? ROW_GAP : 0);
}

function edgePath(x1, y1, x2, y2) {
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

/** Draws one card and returns its group element. */
function cardGroup(node, x, y, width, cls, tooltip) {
  const g = svgEl("g", { class: cls, transform: `translate(${x},${y})` });
  g.appendChild(svgEl("rect", { width, height: node.height, rx: 5 }));
  const title = svgEl("text", { x: 10, y: CARD_PAD_Y + 11, class: "cmap-card-title" });
  title.textContent = node.title.length > 34 ? node.title.slice(0, 33) + "\u2026" : node.title;
  g.appendChild(title);
  const meta = svgEl("text", { x: 10, y: CARD_PAD_Y + 11 + LINE_H, class: "cmap-card-meta" });
  meta.textContent = node.meta;
  g.appendChild(meta);
  node.lines.forEach((line, i) => {
    const t = svgEl("text", { x: 10, y: CARD_PAD_Y + 11 + LINE_H * (2 + i), class: "cmap-card-desc" });
    t.textContent = line;
    g.appendChild(t);
  });
  const titleEl = svgEl("title", {});
  titleEl.textContent = tooltip;
  g.appendChild(titleEl);
  return g;
}

/**
 * Renders the contract map into `container`.
 *
 * `options.onSelectSide("in" | "out")` fires when a side card is clicked, so
 * the page can open the roll-up that carries the proof transactions.
 */
export function renderContractMap(container, result, options = {}) {
  const onSelectSide = options.onSelectSide || (() => {});
  container.innerHTML = "";

  const rt = result.runtime;
  const left = sideNodes(rt.inbound.contracts, "in");
  const right = sideNodes(rt.outbound.contracts, "out");

  const targetLines = wrapText(describeTarget(result), DESC_CHARS, MAX_DESC_LINES);
  const targetNode = {
    title: result.meta.label || "This contract",
    meta: `${short(result.meta.address)}  \u00b7  ${result.meta.chainLabel}`,
    lines: targetLines,
    height: CARD_PAD_Y * 2 + LINE_H * (2 + targetLines.length),
  };

  const leftH = columnHeight(left.nodes);
  const rightH = columnHeight(right.nodes);
  const bodyH = Math.max(leftH, rightH, targetNode.height);
  const width = PAD * 2 + SIDE_W * 2 + CENTER_W + GAP * 2;
  const height = PAD * 2 + HEADER_H + bodyH;

  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "cmap" });

  const leftX = PAD;
  const centerX = PAD + SIDE_W + GAP;
  const rightX = centerX + CENTER_W + GAP;
  const top = PAD + HEADER_H;

  const headers = [
    { x: leftX, text: `Contracts calling in (top ${TOP_N})` },
    { x: centerX, text: "Contract under analysis" },
    { x: rightX, text: `Contracts called out (top ${TOP_N})` },
  ];
  const headerGroup = svgEl("g", {});
  for (const h of headers) {
    const t = svgEl("text", { x: h.x, y: PAD, class: "cmap-col-header" });
    t.textContent = h.text;
    headerGroup.appendChild(t);
  }
  svg.appendChild(headerGroup);

  const edgeGroup = svgEl("g", { class: "cmap-edges" });
  const nodeGroup = svgEl("g", {});

  const centerY = top + (bodyH - targetNode.height) / 2;
  const hubLeft = { x: centerX, y: centerY + targetNode.height / 2 };
  const hubRight = { x: centerX + CENTER_W, y: centerY + targetNode.height / 2 };

  const maxCalls = Math.max(1, ...left.nodes.concat(right.nodes).map((n) => n.agg.calls));

  function drawSide(side, x, hub, isInbound) {
    let y = top + Math.max(0, (bodyH - columnHeight(side.nodes)) / 2);
    for (const node of side.nodes) {
      const agg = node.agg;
      const observed = agg.calls > 0;
      const anchor = { x: isInbound ? x + SIDE_W : x, y: y + node.height / 2 };
      const from = isInbound ? anchor : hub;
      const to = isInbound ? hub : anchor;
      const path = svgEl("path", {
        d: edgePath(from.x, from.y, to.x, to.y),
        class: "cmap-edge " + (observed ? "observed" : "possible"),
        "stroke-width": observed ? 1 + Math.round((agg.calls / maxCalls) * 5) : 1.2,
        "marker-end": observed ? "url(#cmap-arrow)" : "url(#cmap-arrow-dim)",
      });
      const edgeTitle = svgEl("title", {});
      edgeTitle.textContent = observed
        ? `${agg.calls} observed call${agg.calls === 1 ? "" : "s"} in ${agg.txs} transaction${agg.txs === 1 ? "" : "s"}`
        : "Possible from code, not observed in the traced window";
      path.appendChild(edgeTitle);
      edgeGroup.appendChild(path);

      const count = svgEl("text", {
        x: isInbound ? x + SIDE_W + 8 : x - 8,
        y: anchor.y - 4,
        class: "cmap-edge-count",
        "text-anchor": isInbound ? "start" : "end",
      });
      count.textContent = observed ? String(agg.calls) : "0";
      edgeGroup.appendChild(count);

      const tooltip = `${agg.label}\n${agg.address}\n${describe(agg, node.direction)}\n${callsText(agg)}`;
      const card = cardGroup(node, x, y, SIDE_W, "cmap-card" + (observed ? "" : " unobserved"), tooltip);
      card.style.cursor = "pointer";
      card.addEventListener("click", () => onSelectSide(isInbound ? "in" : "out"));
      nodeGroup.appendChild(card);
      y += node.height + ROW_GAP;
    }
  }

  drawSide(left, leftX, hubLeft, true);
  drawSide(right, rightX, hubRight, false);

  const defs = svgEl("defs", {});
  for (const [id, cls] of [["cmap-arrow", "cmap-arrow"], ["cmap-arrow-dim", "cmap-arrow dim"]]) {
    /* `userSpaceOnUse` keeps the head one size: a heavy edge must not grow a
     * head that hides the card it points at. */
    const marker = svgEl("marker", {
      id,
      viewBox: "0 0 8 8",
      refX: 7,
      refY: 4,
      markerWidth: 9,
      markerHeight: 9,
      markerUnits: "userSpaceOnUse",
      orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M 0 1 L 8 4 L 0 7 z", class: cls }));
    defs.appendChild(marker);
  }
  svg.appendChild(defs);
  svg.appendChild(edgeGroup);

  const hub = cardGroup(
    targetNode,
    centerX,
    centerY,
    CENTER_W,
    "cmap-card cmap-hub",
    `${result.meta.label}\n${result.meta.address}\n${describeTarget(result)}`,
  );
  nodeGroup.appendChild(hub);
  svg.appendChild(nodeGroup);
  container.appendChild(svg);

  return {
    /** Facts the page states below the map, so a missing node is never silent. */
    notes: {
      inbound: left,
      outbound: right,
    },
  };
}
