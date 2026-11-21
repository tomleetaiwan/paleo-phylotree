import { t } from "./i18n.ts";
import { phylotree } from "phylotree";
import type { PhylotreeNode } from "phylotree";
import type { Tree, TreeNode, ViewState, TimeResult, ViewMode } from "./model.ts";
import { isTimeMode, VIEW_MODE_LABELS } from "./model.ts";
import { ageX, makeTicks, treeAgeRange } from "./time.ts";

const NS = "http://www.w3.org/2000/svg";
export const TIME_AXIS_TITLE = "Age (Ma)";
export const DIAGRAM_MODE_LABELS: Record<ViewMode, string> = VIEW_MODE_LABELS;
export function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

interface DrawNode {
  source: TreeNode;
  x: number;
  y: number;
  collapsed: boolean;
}
interface NodeLabel {
  text: string;
  x: number;
  baseline: number;
  size: number;
  color: string;
  kind: "name" | "age" | "support" | "collapsed";
}
export interface Diagram {
  svg: SVGSVGElement;
  width: number;
  height: number;
  points: Map<string, DrawNode>;
  older: number;
  younger: number;
  plotLeft: number;
  plotWidth: number;
  ticks: number[];
  axisTitle: string;
  scaleMaximum: number;
}

export function drawScaleBar(diagram: Pick<Diagram, "older" | "younger" | "plotWidth" | "scaleMaximum" | "axisTitle">, x: number, y: number, availableWidth: number): SVGGElement {
  const time = diagram.axisTitle === TIME_AXIS_TITLE;
  const span = time ? diagram.older - diagram.younger : diagram.scaleMaximum;
  const target = span * Math.min(0.25, Math.max(0, availableWidth) / diagram.plotWidth);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const value = target > 0 ? (magnitude > 0
    ? (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude : target) : 0;
  const length = span > 0 ? value / span * diagram.plotWidth : 0;
  const group = svgElement("g", { "data-layer": "scale-bar", "data-scale-value": value, "data-scale-span": span });
  const label = time ? `${value} Ma` : `${diagram.axisTitle}: ${value}`;
  group.append(svgElement("text", { x, y: y - 12, fill: "#526966", "font-size": 12, "font-family": "sans-serif" },
    span === 0 ? `${label} (zero span)` : label));
  if (length > 0) {
    group.append(svgElement("line", { x1: x, x2: x + length, y1: y, y2: y, stroke: "#526966", "stroke-width": 1.5 }));
    for (const end of [x, x + length]) group.append(svgElement("line", { x1: end, x2: end, y1: y - 4, y2: y + 4, stroke: "#526966" }));
  }
  return group;
}

export function drawTree(tree: Tree, result: TimeResult, view: ViewState, width: number, select: (id: string) => void): Diagram {
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  const order = new Map(tree.nodes.map((n, i) => [n.id, i]));
  // Use phylotree's hierarchy on a disposable projection. These placeholder attributes
  // never enter the source model, age inference, or exported research data.
  interface Projection { name: string; id: string; attribute: string; children?: Projection[] }
  const project = (id: string): Projection => {
    const node = byId.get(id)!;
    return { name: id === tree.rootId ? "root" : node.name, id, attribute: String(node.length ?? 0),
      ...(node.children.length ? { children: node.children.map(project) } : {}) };
  };
  const model = new phylotree(project(tree.rootId));
  const idOf = (n: PhylotreeNode): string => {
    if (typeof n.data.id !== "string") throw new Error(t("phylotree 階層遺失節點 ID。"));
    return n.data.id;
  };
  const sizes = new Map<string, number>();
  model.nodes.eachAfter(n => { sizes.set(idOf(n), n.children ? n.children.reduce((sum, c) => sum + sizes.get(idOf(c))!, 0) : 1); });
  if (view.order !== "original") {
    model.resortChildren((a, b) => {
      const diff = sizes.get(idOf(a))! - sizes.get(idOf(b))!;
      return (view.order === "ascending" ? diff : -diff) || order.get(idOf(a))! - order.get(idOf(b))!;
    });
  }
  const time = isTimeMode(view.mode) && result.valid;
  const compact = view.compact && view.mode !== "cladogram";
  const simplified = time && view.simplified;
  const collapsed = new Set(view.collapsed);
  const rootAge = result.ages[tree.rootId] ?? 0;
  const range = time && view.autoRange ? treeAgeRange(Object.values(result.ages))
    : { older: view.older ?? (rootAge > 0 ? rootAge : 1), younger: view.younger };
  const { older, younger } = range;
  let ticks = time ? makeTicks(older, younger, view.gridStep) : [];
  const measurement = document.createElement("canvas").getContext("2d");
  if (!measurement) throw new Error(t("無法量測節點標籤，請使用支援 Canvas 的瀏覽器。"));
  const axisTitle = time ? TIME_AXIS_TITLE : view.mode === "relative" ? "Relative time" : view.mode === "phylogram" ? "Branch length" : "Equal steps";
  measurement.font = "12px sans-serif";
  const titleWidth = measurement.measureText(axisTitle).width;
  measurement.font = time ? "bold 11px sans-serif" : "11px sans-serif";
  const tickHalfWidth = ticks.reduce((max, tick) => Math.max(max, measurement.measureText(String(tick)).width / 2), 0);
  const plotLeft = Math.ceil(16 + titleWidth + 16 + tickHalfWidth);
  const labelWidth = view.names ? Math.min(500, tree.nodes.reduce((max, n) => Math.max(max, Math.min(n.name.length, 100) * view.fontSize * 0.65 + 40), 180)) : 50;
  width = Math.max(900, width, plotLeft + labelWidth + 250);
  const plotWidth = width - plotLeft - labelWidth;
  const tickOverlaps = () => ticks.some((tick, i) => {
    if (!i) return false;
    const gap = Math.abs(ageX(tick, older, younger, 0, plotWidth) - ageX(ticks[i - 1], older, younger, 0, plotWidth));
    const required = (measurement.measureText(String(tick)).width + measurement.measureText(String(ticks[i - 1])).width) / 2 + 12;
    return gap < required;
  });
  while (tickOverlaps()) {
    if (view.gridStep !== null) throw new Error(t("主刻度文字過密，請增加主刻度間距或留白使用自動刻度。"));
    ticks = makeTicks(older, younger, (ticks[0] - ticks[1]) * 2);
  }
  const points = new Map<string, DrawNode>();
  const childRows = new Map<string, DrawNode[]>();
  const rows: DrawNode[] = [];
  const rawScale = view.mode === "phylogram" || view.mode === "relative";
  const distances = new Map<string, number>();
  model.nodes.eachBefore(n => {
    const source = byId.get(idOf(n))!;
    distances.set(source.id, n.parent ? distances.get(idOf(n.parent))! + (rawScale ? source.length ?? 0 : 1) : 0);
  });
  const maxDistance = [...distances.values()].reduce((max, d) => Math.max(max, d), 0);
  if (!Number.isFinite(maxDistance)) throw new Error(t("累計枝長超出數值範圍，無法正確繪圖。"));
  const rowHeight = Math.max(34, view.fontSize * 3);
  const walk = (n: PhylotreeNode): DrawNode => {
    const id = idOf(n), source = byId.get(id)!, isCollapsed = !!n.children?.length && collapsed.has(id);
    const distance = distances.get(id)!;
    const p: DrawNode = {
      source, collapsed: isCollapsed, y: 0,
      x: time ? ageX(result.ages[id] ?? younger, older, younger, plotLeft, plotWidth) : plotLeft + distance / (maxDistance || 1) * plotWidth
    };
    points.set(id, p); rows.push(p);
    if (n.children?.length && !isCollapsed) {
      const childPoints = n.children.map(walk);
      childRows.set(id, childPoints);
    }
    return p;
  };
  walk(model.nodes);
  const measure = (text: string, size: number) => {
    measurement.font = `${size}px sans-serif`;
    const metrics = measurement.measureText(text);
    return {
      left: metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight,
      ascent: Math.max(metrics.actualBoundingBoxAscent, metrics.fontBoundingBoxAscent),
      descent: Math.max(metrics.actualBoundingBoxDescent, metrics.fontBoundingBoxDescent)
    };
  };
  const nodeLabels = new Map<string, NodeLabel[]>();
  const visible = rows.filter(p => !time || result.ages[p.source.id] === undefined || (result.ages[p.source.id] <= older && result.ages[p.source.id] >= younger));
  for (const p of visible) {
    const n = p.source, chosen = view.selected === n.id, labels: NodeLabel[] = [];
    let lower = 10;
    const baseline = view.fontSize / 3, labelStart = p.collapsed ? 17 : 9;
    let ageStart = labelStart;
    if (view.names && n.name && (!simplified || !n.children.length || chosen)) {
      const metrics = measure(n.name, view.fontSize);
      labels.push({ text: n.name, x: labelStart, baseline, size: view.fontSize, color: "#213e3b", kind: "name" });
      ageStart += metrics.right + 8;
      lower = Math.max(lower, baseline + metrics.descent);
    }
    if (time && view.ages && (!simplified || chosen) && (n.children.length || view.allTips || result.ages[n.id] !== 0 || chosen)) {
      const age = result.ages[n.id];
      const rounded = age === undefined ? undefined : Number(age.toFixed(view.decimals));
      const text = rounded === undefined ? "Age unknown" : `${Object.is(rounded, -0) ? 0 : rounded} Ma`, size = Math.max(10, view.fontSize - 1);
      const metrics = measure(text, size);
      labels.push({ text, x: ageStart, baseline, size, color: "#a34a28", kind: "age" });
      lower = Math.max(lower, baseline + metrics.descent + 1.5);
    }
    if (p.collapsed) {
      const text = `Collapsed: ${sizes.get(n.id)} tips`, metrics = measure(text, 11);
      const baseline = lower + 6 + metrics.ascent;
      labels.push({ text, x: 17, baseline, size: 11, color: "#657875", kind: "collapsed" });
      lower = baseline + metrics.descent;
    }
    if (view.support && n.support !== null && (!simplified || chosen)) {
      const text = `Support: ${n.support}`, metrics = measure(text, 10);
      labels.push({ text, x: 7, baseline: lower + 6 + metrics.ascent, size: 10, color: "#596888", kind: "support" });
    }
    nodeLabels.set(n.id, labels);
  }
  interface Bounds { left: number; right: number; top: number; bottom: number }
  interface Layout {
    point: DrawNode;
    children: Layout[];
    offsets: number[];
    top: Float64Array;
    bottom: Float64Array;
    minY: number;
    maxY: number;
    maxX: number;
  }
  const bucket = (x: number) => Math.max(0, Math.min(127, Math.floor(x / width * 128)));
  const emptyProfile = () => ({
    top: new Float64Array(128).fill(Infinity),
    bottom: new Float64Array(128).fill(-Infinity)
  });
  const addBounds = (profile: Pick<Layout, "top" | "bottom">, bounds: Bounds) => {
    for (let b = bucket(bounds.left); b <= bucket(bounds.right); b++) {
      profile.top[b] = Math.min(profile.top[b], bounds.top);
      profile.bottom[b] = Math.max(profile.bottom[b], bounds.bottom);
    }
  };
  const merge = (target: Pick<Layout, "top" | "bottom">, source: Layout, offset: number) => {
    for (let b = 0; b < 128; b++) {
      target.top[b] = Math.min(target.top[b], source.top[b] + offset);
      target.bottom[b] = Math.max(target.bottom[b], source.bottom[b] + offset);
    }
  };
  const stroke = view.lineWidth / 2;
  const layout = (p: DrawNode, parent?: DrawNode): Layout => {
    const children = (childRows.get(p.source.id) ?? []).map(child => layout(child, p));
    const labels = nodeLabels.get(p.source.id) ?? [];
    const ownLabels = labels.map(label => {
      const metrics = measure(label.text, label.size), halo = label.kind === "age" ? 1.5 : 0;
      return {
        left: p.x + label.x - metrics.left - halo, right: p.x + label.x + metrics.right + halo,
        top: label.baseline - metrics.ascent - halo, bottom: label.baseline + metrics.descent + halo
      };
    });
    if (children.length === 1) {
      let collision = false;
      for (const bounds of ownLabels) {
        for (let b = bucket(bounds.left); b <= bucket(bounds.right); b++) {
          if (bounds.top <= children[0].bottom[b] + 6 && bounds.bottom >= children[0].top[b] - 6) {
            collision = true;
          }
        }
      }
      if (collision) {
        const shift = children[0].maxX + 6 - Math.min(...ownLabels.map(bounds => bounds.left));
        labels.forEach(label => { label.x += shift; });
        ownLabels.forEach(bounds => { bounds.left += shift; bounds.right += shift; });
      }
    }
    const offsets: number[] = [];
    let childBottom = -Infinity;
    for (const child of children) {
      const offset = offsets.length ? Math.max(offsets.at(-1)! + rowHeight, childBottom + 6 - child.minY) : 0;
      offsets.push(offset);
      childBottom = offset + child.maxY;
    }
    // Reserve room for the parent's labels by translating the final child block.
    // Profiles include incoming horizontal branches, not just text and markers.
    if (children.length > 1) {
      const prefix = emptyProfile(), last = children.at(-1)!;
      for (let i = 0; i < children.length - 1; i++) merge(prefix, children[i], offsets[i]);
      for (const bounds of ownLabels) {
        let prefixBottom = -Infinity, lastTop = Infinity;
        for (let b = bucket(bounds.left); b <= bucket(bounds.right); b++) {
          prefixBottom = Math.max(prefixBottom, prefix.bottom[b]);
          lastTop = Math.min(lastTop, last.top[b]);
        }
        offsets[offsets.length - 1] = Math.max(offsets.at(-1)!,
          2 * (prefixBottom + 6 - bounds.top) - offsets[0],
          offsets[0] + 2 * (bounds.bottom + 6 - lastTop));
      }
    }
    const center = children.length ? (offsets[0] + offsets.at(-1)!) / 2 : 0;
    const profile = emptyProfile();
    for (let i = 0; i < children.length; i++) {
      offsets[i] -= center;
      merge(profile, children[i], offsets[i]);
    }
    for (const bounds of ownLabels) addBounds(profile, bounds);
    addBounds(profile, { left: p.x - 10, right: p.x + (p.collapsed ? 12 : 10), top: -10, bottom: 10 });
    if (children.length) addBounds(profile, {
      left: p.x - stroke, right: p.x + stroke,
      top: offsets[0] - stroke, bottom: offsets.at(-1)! + stroke
    });
    if (parent) addBounds(profile, { left: parent.x - stroke, right: p.x + stroke, top: -stroke, bottom: stroke });
    const maxX = Math.max(p.x + (p.collapsed ? 12 : 10),
      ...ownLabels.map(bounds => bounds.right), ...children.map(child => child.maxX));
    return { point: p, children, offsets, ...profile, minY: Math.min(...profile.top), maxY: Math.max(...profile.bottom), maxX };
  };
  const packed = layout(points.get(tree.rootId)!);
  const place = (block: Layout, y: number) => {
    block.point.y = y;
    block.children.forEach((child, i) => place(child, y + block.offsets[i]));
  };
  place(packed, 85 - packed.minY);
  let bottom = 85 - packed.minY + packed.maxY;
  if (!time) {
    const tips = rows.filter(p => !childRows.has(p.source.id));
    const spacing = tips.reduce((gap, p, i) => i ? Math.max(gap, p.y - tips[i - 1].y) : gap, rowHeight);
    tips.forEach((p, i) => { p.y = 95 + i * spacing; });
    const center = (p: DrawNode): number => {
      const children = childRows.get(p.source.id);
      if (children) {
        const ys = children.map(center);
        p.y = (ys[0] + ys.at(-1)!) / 2;
      }
      return p.y;
    };
    center(points.get(tree.rootId)!);
    bottom = Math.max(...rows.map(p => p.y + Math.max(rowHeight,
      ...(nodeLabels.get(p.source.id) ?? []).map(label => label.baseline + measure(label.text, label.size).descent))));
  }
  width = Math.max(width, packed.maxX + 20);
  const height = Math.max(540, bottom + 80);
  const svg = svgElement("svg", { xmlns: NS, width, height, viewBox: `0 0 ${width} ${height}`, role: "img",
    "data-mode": view.mode, "aria-label": DIAGRAM_MODE_LABELS[view.mode] });
  const background = view.backgroundTransparent ? "none" : view.backgroundColor;
  svg.append(svgElement("rect", { width, height, fill: background }));
  svg.append(svgElement("title", {}, `${tree.name} — ${VIEW_MODE_LABELS[view.mode]} — ${axisTitle}`));
  if (view.treeName) svg.append(svgElement("text", { x: compact ? plotLeft : 16, y: 24, fill: "#203f3c", "font-size": 14, "font-family": "sans-serif", "data-label-kind": "tree-name" }, tree.name));
  if (!compact) svg.append(svgElement("text", {
    x: 16, y: 68, fill: "#526966", "font-size": 12, "font-family": "sans-serif",
    "data-axis-title": time ? "time" : "scale"
  }, axisTitle));
  const defs = svgElement("defs");
  const clip = svgElement("clipPath", { id: "tree-clip" });
  clip.append(svgElement("rect", { x: plotLeft - 7, y: 76, width: plotWidth + 14, height: height - 125 }));
  defs.append(clip); svg.append(defs);
  const grid = svgElement("g", { "data-layer": "grid" });
  if (time && !compact) {
    const drawGrid = (tick: number, minor: boolean) => {
      const x = ageX(tick, older, younger, plotLeft, plotWidth);
      if (view.grid) grid.append(svgElement("line", { x1: x, x2: x, y1: 76, y2: height - 50, stroke: view.gridColor, "stroke-opacity": view.gridOpacity * (minor ? 0.45 : 1), "stroke-width": 1, "data-age": tick }));
      if (!minor) grid.append(svgElement("text", { x, y: 68, "text-anchor": "middle", "font-size": 11, "font-weight": "bold", fill: "#596d6a", "font-family": "sans-serif" }, String(tick)));
    };
    if (view.minorGrid && ticks.length > 1) {
      const step = (ticks[0] - ticks[1]) / 5;
      if (step > 0 && (older - younger) / step < 1000) {
        const first = Math.ceil(younger / step), last = Math.floor(older / step);
        for (let i = first; i <= last; i++) if (i % 5) drawGrid(i * step, true);
      }
    }
    for (const tick of ticks) drawGrid(tick, false);
    grid.append(svgElement("line", { x1: plotLeft, x2: plotLeft + plotWidth, y1: 76, y2: 76, stroke: "#7f9691" }));
    svg.append(grid);
  } else if (rawScale && !compact) {
    const magnitude = 10 ** Math.floor(Math.log10(maxDistance)) || maxDistance;
    ticks = maxDistance === 0 ? [0] : [...new Set(makeTicks(maxDistance / magnitude, 0, null).reverse().map(tick => tick * magnitude))];
    measurement.font = "11px sans-serif";
    while (ticks.some((tick, i) => i > 0 &&
      (tick - ticks[i - 1]) / (maxDistance || 1) * plotWidth <
      (measurement.measureText(String(tick)).width + measurement.measureText(String(ticks[i - 1])).width) / 2 + 12)) {
      ticks = ticks.filter((_, i) => i % 2 === 0);
    }
    for (const tick of ticks) {
      const x = plotLeft + tick / (maxDistance || 1) * plotWidth;
      grid.append(svgElement("text", { x, y: 68, "text-anchor": "middle", "font-size": 11, fill: "#596d6a", "font-family": "sans-serif" }, String(tick)));
    }
    grid.append(svgElement("line", { x1: plotLeft, x2: plotLeft + plotWidth, y1: 76, y2: 76, stroke: "#7f9691" }));
    svg.append(grid);
  }
  if (compact) svg.append(drawScaleBar({ older, younger, plotWidth, scaleMaximum: maxDistance, axisTitle }, plotLeft, 68, plotWidth));
  const root = points.get(tree.rootId)!;
  if (view.rootStem && (!time || (rootAge <= older && rootAge >= younger))) {
    const stem = svgElement("g", { "data-layer": "root-stem" });
    stem.append(svgElement("title", {}, "Decorative root stem (not a time duration)"));
    stem.append(svgElement("line", {
      x1: root.x - 24, x2: root.x, y1: root.y, y2: root.y,
      stroke: view.branchColor, "stroke-width": view.lineWidth, "stroke-dasharray": "3 2"
    }));
    svg.append(stem);
  }
  const branches = svgElement("g", { "data-layer": "branches", "clip-path": "url(#tree-clip)", fill: "none", stroke: view.branchColor, "stroke-width": view.lineWidth });
  for (const p of rows) {
    const parent = p.source.parentId ? points.get(p.source.parentId) : undefined;
    if (parent) branches.append(svgElement("path", {
      d: `M${parent.x},${parent.y}V${p.y}H${p.x}`,
      "data-parent-node": parent.source.id, "data-child-node": p.source.id,
      ...((time && result.ages[p.source.id] === undefined) || (rawScale && p.source.length === null)
        ? { "stroke-dasharray": "4 3", "data-unknown-length": "true" } : {})
    }));
  }
  svg.append(branches);
  const labels = svgElement("g", { "data-layer": "labels", "font-size": view.fontSize, "font-family": "sans-serif" });
  const markers = svgElement("g", { "data-layer": "nodes" });
  for (const p of rows) {
    const n = p.source;
    if (time && (result.ages[n.id] > older || result.ages[n.id] < younger)) continue;
    const chosen = view.selected === n.id;
    const ageText = result.ages[n.id] === undefined ? "Age unknown" : `${result.ages[n.id]} Ma`;
    const group = svgElement("g", { "data-node-id": n.id, role: "button", tabindex: 0, "aria-label": `${n.name || n.id}${time ? ` ${ageText}` : ""}`, "aria-pressed": String(chosen), cursor: "pointer" });
    const hollow = n.id === tree.rootId ? view.rootStyle === "hollow" : !chosen && n.children.length > 0;
    const marker = p.collapsed
      ? svgElement("path", { d: `M${p.x},${p.y - 7}L${p.x + 12},${p.y}L${p.x},${p.y + 7}Z`, fill: view.branchColor })
      : svgElement("circle", { cx: p.x, cy: p.y, r: chosen ? 5 : 3.2, fill: hollow ? background : chosen ? "#bb5b31" : view.branchColor, stroke: view.branchColor, "stroke-width": chosen ? 2 : 1.3 });
    group.append(svgElement("circle", { cx: p.x, cy: p.y, r: 10, fill: "transparent" }), marker);
    if (chosen) group.append(svgElement("circle", { cx: p.x, cy: p.y, r: 10, fill: "none", stroke: "#bb5b31", "stroke-dasharray": "3 2" }));
    group.append(svgElement("title", {}, `${n.name || n.id}\n${time ? `${ageText}\n${result.sources[n.id] ?? "Not provided"}\n` : ""}Branch length: ${n.length ?? "Not provided"}\nSupport: ${n.support ?? "Not provided"}`));
    group.addEventListener("click", () => select(n.id));
    group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.id); } });
    markers.append(group);
    for (const label of nodeLabels.get(n.id) ?? []) {
      labels.append(svgElement("text", {
        x: p.x + label.x, y: p.y + label.baseline, fill: label.color, "font-size": label.size,
        "data-label-kind": label.kind, "data-label-node": n.id,
        ...(label.kind === "age" ? { stroke: background, "stroke-width": 3, "paint-order": "stroke", "stroke-linejoin": "round", "data-age-label": n.id } : {})
      }, label.text));
    }
  }
  svg.append(markers, labels);
  if (time && view.ageRange) svg.append(svgElement("text", { x: plotLeft, y: height - 20, fill: "#657875", "font-size": 11, "font-family": "sans-serif", "data-label-kind": "age-range" },
    `Age range: ${older}–${younger} Ma`));
  return { svg, width, height, points, older, younger, plotLeft, plotWidth, ticks, axisTitle, scaleMaximum: maxDistance };
}
