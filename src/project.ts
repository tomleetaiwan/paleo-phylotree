import { t } from "./i18n.ts";
import { APP_VERSION, PHYLOTREE_VERSION, isTimeMode, VIEW_MODE_LABELS } from "./model.ts";
import type { SourceDocument, TimeOptions, ViewState, ViewMode, Tree, TimeResult } from "./model.ts";
import { parseDocument } from "./parsers.ts";
import { classifyTree, interpretTime, validZeroAgePair, zeroAgeMean } from "./time.ts";

const PROJECT_SCHEMA_VERSION = 3;

export function defaultView(): ViewState {
  return {
    mode: "cladogram", rootStyle: "hollow", rootStem: false, grid: true, minorGrid: false, gridColor: "#d1d5db", gridOpacity: 0.5,
    gridStep: null, autoRange: true, older: null, younger: 0, decimals: 2, fontSize: 13, lineWidth: 1.5,
    branchColor: "#254b48", names: true, ages: true, allTips: false, support: false,
    simplified: false, collapsed: [], order: "original", selected: null, zoom: 1, panX: 0, panY: 0
  };
}
export function defaultTime(): TimeOptions {
  return { autoMethod: true, method: "nodes", field: "age_mean", unit: "Ma", origin: "present", zeroAgeMa: 0, zeroAgePairMa: null, evidence: "", rootedConfirmed: false, branchTimeConfirmed: false };
}
export function saveProject(doc: SourceDocument, selectedTree: number, options: TimeOptions, view: ViewState): string {
  return JSON.stringify({
    kind: "paleo-phylotree", schemaVersion: PROJECT_SCHEMA_VERSION, appVersion: APP_VERSION, phylotreeVersion: PHYLOTREE_VERSION,
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
  if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) throw new Error(t("專案超過 32 MiB 限制。"));
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error(t("專案 JSON 語法損毀。")); }
  if (!record(obj) || obj.kind !== "paleo-phylotree" || obj.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(t("不支援的專案格式或版本；僅接受五模式專案 schemaVersion 3，請重新匯入原始樹檔。"));
  }
  if (typeof obj.appVersion !== "string" || !obj.appVersion || typeof obj.phylotreeVersion !== "string" || !obj.phylotreeVersion) {
    throw new Error(t("專案應用程式版本資訊無效。"));
  }
  if (!record(obj.source) || typeof obj.source.filename !== "string" || typeof obj.source.content !== "string" || typeof obj.source.format !== "string") {
    throw new Error(t("專案來源資料無效。"));
  }
  const doc = parseDocument(obj.source.content, obj.source.filename, obj.source.format);
  if (!Number.isInteger(obj.selectedTree) || !finite(obj.selectedTree, 0, doc.trees.length - 1)) throw new Error(t("專案選定樹索引無效。"));
  if (JSON.stringify(obj.nodeIds) !== JSON.stringify(doc.trees.map(t => t.nodes.map(n => n.id)))) throw new Error(t("專案節點 ID 與來源資料不符。"));
  const o = obj.options, v = obj.view;
  if (!record(o) || (o.method !== "nodes" && o.method !== "branches") || typeof o.field !== "string" || o.field.length > 200 ||
    typeof o.autoMethod !== "boolean" ||
    o.origin !== "present" || typeof o.evidence !== "string" || o.evidence.length > 4000 ||
    typeof o.rootedConfirmed !== "boolean" || typeof o.branchTimeConfirmed !== "boolean" ||
    !finite(o.zeroAgeMa, 0, 1e15)) throw new Error(t("專案年代設定無效。"));
  if (o.unit !== "Ma") throw new Error(t("專案時間單位固定使用 Ma；請先換算原始年代與時間枝長，再重新匯入樹檔。"));
  if (o.zeroAgePairMa !== null && !validZeroAgePair(o.zeroAgePairMa)) {
    throw new Error(t("專案中 0 所代表年代的兩個端點無效，須介於 0–10^15 Ma，順序不限。"));
  }
  const pair = o.zeroAgePairMa;
  if (pair !== null && o.zeroAgeMa !== zeroAgeMean(pair)) throw new Error(t("專案中 0 所代表的年代與所填範圍中點不一致。"));
  const ids = new Set(doc.trees[obj.selectedTree].nodes.map(n => n.id));
  if (!record(v) || typeof v.mode !== "string" || !Object.hasOwn(VIEW_MODE_LABELS, v.mode) ||
    (v.rootStyle !== "hollow" && v.rootStyle !== "solid") ||
    typeof v.rootStem !== "boolean" ||
    typeof v.autoRange !== "boolean" ||
    (v.order !== "original" && v.order !== "ascending" && v.order !== "descending") ||
    !["grid", "minorGrid", "names", "ages", "allTips", "support", "simplified"].every(k => typeof v[k] === "boolean") ||
    !color(v.gridColor) || !color(v.branchColor) || !finite(v.gridOpacity, 0, 1) ||
    (v.gridStep !== null && !finite(v.gridStep, Number.MIN_VALUE, 1e15)) ||
    (v.older !== null && !finite(v.older, 0, 1e15)) || !finite(v.younger, 0, 1e15) ||
    !finite(v.decimals, 0, 6) || !Number.isInteger(v.decimals) || !finite(v.fontSize, 8, 32) ||
    !finite(v.lineWidth, 0.5, 6) || !finite(v.zoom, 0.25, 16) || !finite(v.panX, -1e7, 1e7) || !finite(v.panY, -1e7, 1e7) ||
    (v.selected !== null && (typeof v.selected !== "string" || !ids.has(v.selected))) ||
    !Array.isArray(v.collapsed) || v.collapsed.some(id => typeof id !== "string" || !ids.has(id))) {
    throw new Error(t("專案圖形設定無效。"));
  }
  // Reconstruct from validated fields; never merge arbitrary imported object keys.
  const options: TimeOptions = {
    autoMethod: o.autoMethod,
    method: o.method, field: o.field, unit: "Ma",
    origin: "present", zeroAgeMa: o.zeroAgeMa,
    zeroAgePairMa: pair,
    evidence: o.evidence, rootedConfirmed: o.rootedConfirmed, branchTimeConfirmed: o.branchTimeConfirmed
  };
  const mode = v.mode as ViewMode;
  if ((mode === "dated" && options.method !== "nodes") || (mode === "chronogram" && options.method !== "branches")) {
    throw new Error(t("專案繪圖模式與年代來源不一致。"));
  }
  if (isTimeMode(mode)) {
    const result = interpretTime(doc.trees[obj.selectedTree], options);
    if (!result.valid) throw new Error(t("專案時間模式的年代檢核未通過：{0}", result.errors[0]));
  }
  const classified = classifyTree(doc.trees[obj.selectedTree], options);
  if (classified.mode !== mode) throw new Error(t("專案繪圖模式與樹的分類不一致。"));
  const view: ViewState = {
    rootStyle: v.rootStyle,
    rootStem: v.rootStem,
    mode, order: v.order,
    grid: v.grid === true, minorGrid: v.minorGrid === true, names: v.names === true, ages: v.ages === true, allTips: v.allTips === true,
    support: v.support === true, simplified: v.simplified === true, gridColor: v.gridColor, branchColor: v.branchColor,
    gridOpacity: v.gridOpacity, gridStep: v.gridStep, autoRange: v.autoRange, older: v.older, younger: v.younger, decimals: v.decimals,
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
export function nodeCSV(tree: Tree, result: TimeResult, opts: TimeOptions, mode: ViewMode): string {
  const time = isTimeMode(mode);
  if (!Object.hasOwn(VIEW_MODE_LABELS, mode)) throw new Error(t("CSV 繪圖模式無效。"));
  if (time && (!result.valid || opts.method !== (mode === "dated" ? "nodes" : "branches"))) throw new Error(t("CSV 時間模式須與有效的年代來源一致，請重新套用對應的時間模式。"));
  const zeroAgeMa = opts.zeroAgePairMa ? zeroAgeMean(opts.zeroAgePairMa) : opts.zeroAgeMa;
  const headers = ["tree_id", "tree_name", "mode", "node_id", "parent_id", "name", "is_tip", "raw_age_key", "raw_age_value", "raw_unit",
    "plot_age_Ma", "source", "intervals", "support", "branch_length", "origin", "zero_age_Ma", "evidence", "warnings", "raw_annotations", "zero_age_pair_Ma", "relative_time"];
  const distances = new Map<string, number>();
  for (const n of tree.nodes) distances.set(n.id, n.parentId ? distances.get(n.parentId)! + (n.length ?? 0) : 0);
  const rows = tree.nodes.map(n => [
    tree.id, tree.name, mode, n.id, n.parentId, n.name, !n.children.length,
    time ? opts.field : null, time ? n.annotations[opts.field] : null, time ? opts.unit : null,
    time ? result.ages[n.id] : null, time ? result.sources[n.id] : null,
    time ? result.intervals[n.id] : null, n.support, n.length,
    time ? opts.origin : null, time ? zeroAgeMa : null, time ? opts.evidence : null,
    [...tree.warnings, ...result.warnings].join(" | "), n.annotations, time ? opts.zeroAgePairMa : null,
    mode === "relative" ? distances.get(n.id) : null
  ]);
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
}
