import { phylotree } from "phylotree";
import type { PhylotreeNode } from "phylotree";
import type { Tree, TreeNode, ViewState, TimeResult } from "./model.ts";
import { ageX, makeTicks, treeAgeRange } from "./time.ts";

const NS = "http://www.w3.org/2000/svg";
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
    if (typeof n.data.id !== "string") throw new Error("phylotree 階層遺失節點 ID。");
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
  const time = view.mode === "time" && result.valid;
  const collapsed = new Set(view.collapsed);
  const rootAge = result.ages[tree.rootId] ?? 0;
  const range = time && view.autoRange ? treeAgeRange(Object.values(result.ages))
    : { older: view.older ?? (rootAge > 0 ? rootAge : 1), younger: view.younger };
  const { older, younger } = range;
  let ticks = time ? makeTicks(older, younger, view.gridStep) : [];
  const measurement = document.createElement("canvas").getContext("2d");
  if (!measurement) throw new Error("無法量測節點標籤，請使用支援 Canvas 的瀏覽器。");
  const axisTitle = "距今年代（Ma）";
  measurement.font = "12px sans-serif";
  const titleWidth = measurement.measureText(axisTitle).width;
  measurement.font = "11px sans-serif";
  const tickHalfWidth = ticks.reduce((max, tick) => Math.max(max, measurement.measureText(String(tick)).width / 2), 0);
  const plotLeft = time ? Math.ceil(16 + titleWidth + 16 + tickHalfWidth) : 65;
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
    if (view.gridStep !== null) throw new Error("主刻度文字過密，請增加主刻度間距或留白使用自動刻度。");
    ticks = makeTicks(older, younger, (ticks[0] - ticks[1]) * 2);
  }
  const points = new Map<string, DrawNode>();
  const childRows = new Map<string, DrawNode[]>();
  const rows: DrawNode[] = [];
  const rawScale = tree.nodes.every(n => !n.parentId || n.length !== null) && tree.nodes.some(n => n.parentId && (n.length ?? 0) > 0);
  const distances = new Map<string, number>();
  model.nodes.eachBefore(n => {
    const source = byId.get(idOf(n))!;
    distances.set(source.id, n.parent ? distances.get(idOf(n.parent))! + (rawScale ? source.length! : 1) : 0);
  });
  const maxDistance = [...distances.values()].reduce((max, d) => Math.max(max, d), 0);
  if (!Number.isFinite(maxDistance)) throw new Error("累計枝長超出數值範圍，無法正確繪圖。");
  const rowHeight = Math.max(34, view.fontSize * 3);
  const walk = (n: PhylotreeNode): DrawNode => {
    const id = idOf(n), source = byId.get(id)!, isCollapsed = !!n.children?.length && collapsed.has(id);
    const p: DrawNode = {
      source, collapsed: isCollapsed, y: 0,
      x: time ? ageX(result.ages[id], older, younger, plotLeft, plotWidth) : plotLeft + distances.get(id)! / maxDistance * plotWidth
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
  const visible = rows.filter(p => !time || (result.ages[p.source.id] <= older && result.ages[p.source.id] >= younger));
  for (const p of visible) {
    const n = p.source, chosen = view.selected === n.id, labels: NodeLabel[] = [];
    let lower = 10;
    const baseline = view.fontSize / 3, labelStart = p.collapsed ? 17 : 9;
    let ageStart = labelStart;
    if (view.names && n.name && (!view.simplified || !n.children.length || chosen)) {
      const metrics = measure(n.name, view.fontSize);
      labels.push({ text: n.name, x: labelStart, baseline, size: view.fontSize, color: "#213e3b", kind: "name" });
      ageStart += metrics.right + 8;
      lower = Math.max(lower, baseline + metrics.descent);
    }
    if (time && view.ages && (!view.simplified || chosen) && (n.children.length || view.allTips || result.ages[n.id] !== 0 || chosen)) {
      const rounded = Number(result.ages[n.id].toFixed(view.decimals));
      const text = `${Object.is(rounded, -0) ? 0 : rounded} Ma`, size = Math.max(10, view.fontSize - 1);
      const metrics = measure(text, size);
      labels.push({ text, x: ageStart, baseline, size, color: "#a34a28", kind: "age" });
      lower = Math.max(lower, baseline + metrics.descent + 1.5);
    }
    if (p.collapsed) {
      const text = `已折疊 ${sizes.get(n.id)} tips`, metrics = measure(text, 11);
      const baseline = lower + 6 + metrics.ascent;
      labels.push({ text, x: 17, baseline, size: 11, color: "#657875", kind: "collapsed" });
      lower = baseline + metrics.descent;
    }
    if (view.support && n.support !== null && (!view.simplified || chosen)) {
      const text = `支持度 ${n.support}`, metrics = measure(text, 10);
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
  const bottom = 85 - packed.minY + packed.maxY;
  width = Math.max(width, packed.maxX + 20);
  const height = Math.max(540, bottom + 80);
  const svg = svgElement("svg", { xmlns: NS, width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": time ? "距今年代 Ma 種系時間樹" : "一般種系樹" });
  svg.append(svgElement("rect", { width, height, fill: "#ffffff" }));
  svg.append(svgElement("title", {}, `${tree.name} — ${time ? "距今年代（Ma）" : rawScale ? "原始枝長（非 Ma）" : "拓樸模式（非 Ma）"}`));
  svg.append(svgElement("text", { x: plotLeft, y: 24, fill: "#203f3c", "font-size": 14, "font-family": "sans-serif" }, tree.name));
  svg.append(svgElement("text", {
    x: time ? 16 : plotLeft, y: time ? 68 : 45, fill: "#526966", "font-size": 12, "font-family": "sans-serif",
    ...(time ? { "data-axis-title": "time" } : {})
  }, time ? axisTitle : rawScale ? "原始枝長 · 單位未作年代解讀" : "拓樸模式 · 缺少完整枝長，水平距離不代表時間"));
  const defs = svgElement("defs");
  const clip = svgElement("clipPath", { id: "tree-clip" });
  clip.append(svgElement("rect", { x: plotLeft - 7, y: 76, width: plotWidth + 14, height: height - 125 }));
  defs.append(clip); svg.append(defs);
  const grid = svgElement("g", { "data-layer": "grid" });
  if (time) {
    const drawGrid = (tick: number, minor: boolean) => {
      const x = ageX(tick, older, younger, plotLeft, plotWidth);
      if (view.grid) grid.append(svgElement("line", { x1: x, x2: x, y1: 76, y2: height - 50, stroke: view.gridColor, "stroke-opacity": view.gridOpacity * (minor ? 0.45 : 1), "stroke-width": 1, "data-age": tick }));
      if (!minor) grid.append(svgElement("text", { x, y: 68, "text-anchor": "middle", "font-size": 11, fill: "#596d6a", "font-family": "sans-serif" }, String(tick)));
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
  }
  const root = points.get(tree.rootId)!;
  if (view.rootStem && (!time || (rootAge <= older && rootAge >= younger))) {
    const stem = svgElement("g", { "data-layer": "root-stem" });
    stem.append(svgElement("title", {}, "裝飾根幹，不代表時間長度"));
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
      "data-parent-node": parent.source.id, "data-child-node": p.source.id
    }));
  }
  svg.append(branches);
  const labels = svgElement("g", { "data-layer": "labels", "font-size": view.fontSize, "font-family": "sans-serif" });
  const markers = svgElement("g", { "data-layer": "nodes" });
  for (const p of rows) {
    const n = p.source;
    if (time && (result.ages[n.id] > older || result.ages[n.id] < younger)) continue;
    const chosen = view.selected === n.id;
    const group = svgElement("g", { "data-node-id": n.id, role: "button", tabindex: 0, "aria-label": `${n.name || n.id}${time ? ` ${result.ages[n.id]} Ma` : ""}`, "aria-pressed": String(chosen), cursor: "pointer" });
    const hollow = n.id === tree.rootId ? view.rootStyle === "hollow" : !chosen && n.children.length > 0;
    const marker = p.collapsed
      ? svgElement("path", { d: `M${p.x},${p.y - 7}L${p.x + 12},${p.y}L${p.x},${p.y + 7}Z`, fill: view.branchColor })
      : svgElement("circle", { cx: p.x, cy: p.y, r: chosen ? 5 : 3.2, fill: hollow ? "#ffffff" : chosen ? "#bb5b31" : view.branchColor, stroke: view.branchColor, "stroke-width": chosen ? 2 : 1.3 });
    group.append(svgElement("circle", { cx: p.x, cy: p.y, r: 10, fill: "transparent" }), marker);
    if (chosen) group.append(svgElement("circle", { cx: p.x, cy: p.y, r: 10, fill: "none", stroke: "#bb5b31", "stroke-dasharray": "3 2" }));
    group.append(svgElement("title", {}, `${n.name || n.id}\n${time ? `${result.ages[n.id]} Ma\n${result.sources[n.id]}\n` : ""}枝長：${n.length ?? "缺少"}\n支持度：${n.support ?? "缺少"}`));
    group.addEventListener("click", () => select(n.id));
    group.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.id); } });
    markers.append(group);
    for (const label of nodeLabels.get(n.id) ?? []) {
      labels.append(svgElement("text", {
        x: p.x + label.x, y: p.y + label.baseline, fill: label.color, "font-size": label.size,
        "data-label-kind": label.kind, "data-label-node": n.id,
        ...(label.kind === "age" ? { stroke: "#ffffff", "stroke-width": 3, "paint-order": "stroke", "stroke-linejoin": "round", "data-age-label": n.id } : {})
      }, label.text));
    }
  }
  svg.append(markers, labels);
  svg.append(svgElement("text", { x: plotLeft, y: height - 20, fill: "#657875", "font-size": 11, "font-family": "sans-serif" },
    time ? `年代範圍 ${older}–${younger} Ma · 點選節點可查原始精度` : "非定年圖 · 水平距離不得解讀為 Ma"));
  if (view.simplified) svg.append(svgElement("text", { x: plotLeft, y: height - 37, fill: "#a34a28", "font-size": 11 }, "簡化模式：部分名稱／年代已隱藏，點選節點可查詢。"));
  return { svg, width, height, points, older, younger, plotLeft, plotWidth, ticks };
}
