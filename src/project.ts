import { APP_VERSION, PHYLOTREE_VERSION } from "./model.ts";
import type { SourceDocument, TimeOptions, ViewState, Tree, TimeResult } from "./model.ts";
import { parseDocument } from "./parsers.ts";
import { validZeroAgePair, zeroAgeMean } from "./time.ts";

export function defaultView(): ViewState {
  return {
    mode: "general", rootStyle: "hollow", rootStem: false, grid: true, minorGrid: false, gridColor: "#d1d5db", gridOpacity: 0.5,
    gridStep: null, autoRange: true, older: null, younger: 0, decimals: 2, fontSize: 13, lineWidth: 1.5,
    branchColor: "#254b48", names: true, ages: true, allTips: false, support: false,
    simplified: false, collapsed: [], order: "original", selected: null, zoom: 1, panX: 0, panY: 0
  };
}
export function defaultTime(): TimeOptions {
  return { autoMethod: true, method: "nodes", field: "age_mean", unit: "Ma", origin: "present", zeroAgeMa: 0, zeroAgePairMa: null, evidence: "", rootedConfirmed: false };
}
export function saveProject(doc: SourceDocument, selectedTree: number, options: TimeOptions, view: ViewState): string {
  return JSON.stringify({
    kind: "paleo-phylotree", schemaVersion: 1, appVersion: APP_VERSION, phylotreeVersion: PHYLOTREE_VERSION,
    source: { filename: doc.filename, content: doc.content, format: doc.format },
    selectedTree, nodeIds: doc.trees.map(t => t.nodes.map(n => n.id)), options, view
  }, null, 2);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function color(value: unknown): value is string { return typeof value === "string" && /^#[\da-f]{6}$/i.test(value); }

export function loadProject(text: string): { doc: SourceDocument; selectedTree: number; options: TimeOptions; view: ViewState } {
  if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) throw new Error("專案超過 32 MiB 限制。");
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error("專案 JSON 語法損毀。"); }
  if (!record(obj) || obj.kind !== "paleo-phylotree" || obj.schemaVersion !== 1) throw new Error("不支援的專案格式或版本。");
  if (!record(obj.source) || typeof obj.source.filename !== "string" || typeof obj.source.content !== "string" || typeof obj.source.format !== "string") {
    throw new Error("專案來源資料無效。");
  }
  const doc = parseDocument(obj.source.content, obj.source.filename, obj.source.format);
  if (!Number.isInteger(obj.selectedTree) || !finite(obj.selectedTree, 0, doc.trees.length - 1)) throw new Error("專案選定樹索引無效。");
  if (JSON.stringify(obj.nodeIds) !== JSON.stringify(doc.trees.map(t => t.nodes.map(n => n.id)))) throw new Error("專案節點 ID 與來源資料不符。");
  const o = obj.options, v = obj.view;
  if (!record(o) || !["nodes", "branches"].includes(String(o.method)) || typeof o.field !== "string" || o.field.length > 200 ||
    (o.autoMethod !== undefined && typeof o.autoMethod !== "boolean") ||
    !["Ma", "ka", "years"].includes(String(o.unit)) || o.origin !== "present" || typeof o.evidence !== "string" || o.evidence.length > 4000 ||
    typeof o.rootedConfirmed !== "boolean" ||
    (o.zeroAgeMa !== undefined && !finite(o.zeroAgeMa, 0, 1e15))) throw new Error("專案年代設定無效。");
  if (o.unit !== "Ma") throw new Error("此版本固定使用 Ma；此專案使用 ka 或 years，請先將原始年代與時間枝長換算為 Ma，再以樹檔重新匯入，不可只修改單位標籤。");
  if (o.zeroAgeRangeMa !== undefined && o.zeroAgeRangeMa !== null) {
    throw new Error("此版本僅支援固定原點年代（可由兩數中點取得），不支援舊版不確定性範圍專案；請重新匯入原始樹檔，再輸入單一 Ma 值或兩個數值取中點。");
  }
  if (o.zeroAgePairMa !== undefined && o.zeroAgePairMa !== null && !validZeroAgePair(o.zeroAgePairMa)) {
    throw new Error("專案原點的兩個數值無效，須介於 0–10^15 Ma，不限輸入順序。");
  }
  const pair = validZeroAgePair(o.zeroAgePairMa) ? o.zeroAgePairMa : null;
  const ids = new Set(doc.trees[obj.selectedTree].nodes.map(n => n.id));
  if (!record(v) || !["general", "time"].includes(String(v.mode)) ||
    (v.rootStyle !== undefined && v.rootStyle !== "hollow" && v.rootStyle !== "solid") ||
    (v.rootStem !== undefined && typeof v.rootStem !== "boolean") ||
    (v.autoRange !== undefined && typeof v.autoRange !== "boolean") ||
    !["original", "ascending", "descending"].includes(String(v.order)) ||
    !["grid", "minorGrid", "names", "ages", "allTips", "support", "simplified"].every(k => typeof v[k] === "boolean") ||
    !color(v.gridColor) || !color(v.branchColor) || !finite(v.gridOpacity, 0, 1) ||
    (v.gridStep !== null && !finite(v.gridStep, Number.MIN_VALUE, 1e15)) ||
    (v.older !== null && !finite(v.older, 0, 1e15)) || !finite(v.younger, 0, 1e15) ||
    !finite(v.decimals, 0, 6) || !Number.isInteger(v.decimals) || !finite(v.fontSize, 8, 32) ||
    !finite(v.lineWidth, 0.5, 6) || !finite(v.zoom, 0.25, 16) || !finite(v.panX, -1e7, 1e7) || !finite(v.panY, -1e7, 1e7) ||
    (v.selected !== null && (typeof v.selected !== "string" || !ids.has(v.selected))) ||
    !Array.isArray(v.collapsed) || v.collapsed.some(id => typeof id !== "string" || !ids.has(id))) {
    throw new Error("專案圖形設定無效。");
  }
  // Reconstruct from validated fields; never merge arbitrary imported object keys.
  const options: TimeOptions = {
    autoMethod: o.autoMethod === true,
    method: o.method === "branches" ? "branches" : "nodes", field: o.field, unit: "Ma",
    origin: "present", zeroAgeMa: pair ? zeroAgeMean(pair) : o.zeroAgeMa === undefined ? 0 : o.zeroAgeMa,
    zeroAgePairMa: pair,
    evidence: o.evidence, rootedConfirmed: o.rootedConfirmed
  };
  const view: ViewState = {
    rootStyle: v.rootStyle === "solid" ? "solid" : "hollow",
    rootStem: v.rootStem === true,
    mode: v.mode === "time" ? "time" : "general", order: v.order === "ascending" ? "ascending" : v.order === "descending" ? "descending" : "original",
    grid: v.grid === true, minorGrid: v.minorGrid === true, names: v.names === true, ages: v.ages === true, allTips: v.allTips === true,
    support: v.support === true, simplified: v.simplified === true, gridColor: v.gridColor, branchColor: v.branchColor,
    gridOpacity: v.gridOpacity, gridStep: v.gridStep, autoRange: v.autoRange === true, older: v.older, younger: v.younger, decimals: v.decimals,
    fontSize: v.fontSize, lineWidth: v.lineWidth, zoom: v.zoom, panX: v.panX, panY: v.panY,
    selected: typeof v.selected === "string" ? v.selected : null,
    collapsed: v.collapsed.filter((id): id is string => typeof id === "string")
  };
  return { doc, selectedTree: obj.selectedTree, options, view };
}

function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function nodeCSV(tree: Tree, result: TimeResult, opts: TimeOptions): string {
  const zeroAgeMa = opts.zeroAgePairMa ? zeroAgeMean(opts.zeroAgePairMa) : opts.zeroAgeMa;
  const headers = ["tree_id", "tree_name", "node_id", "parent_id", "name", "is_tip", "raw_age_key", "raw_age_value", "raw_unit",
    "plot_age_Ma", "source", "intervals", "support", "branch_length", "origin", "zero_age_Ma", "evidence", "warnings", "raw_annotations", "zero_age_pair_Ma"];
  const rows = tree.nodes.map(n => [
    tree.id, tree.name, n.id, n.parentId, n.name, !n.children.length, opts.field, n.annotations[opts.field], opts.unit,
    result.valid ? result.ages[n.id] : null, result.valid ? result.sources[n.id] : "time-mode-invalid",
    result.valid ? result.intervals[n.id] : null, n.support, n.length, opts.origin, zeroAgeMa, opts.evidence,
    [...result.errors, ...result.warnings].join(" | "), n.annotations, opts.zeroAgePairMa
  ]);
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
}
