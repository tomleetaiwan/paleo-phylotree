import { t } from "./i18n.ts";
import type { Tree, TimeOptions, TimeResult } from "./model.ts";
import type { ViewMode } from "./model.ts";
import { hasBranchLengths, hasCompleteBranchLengths } from "./model.ts";
import { availableFields } from "./parsers.ts";

export function timeBranchesConfirmed(tree: Tree, options: TimeOptions): boolean {
  const root = tree.nodes.find(n => n.id === tree.rootId)!;
  return options.branchTimeConfirmed ||
    root.annotations.branch_length_unit === "Ma" || root.annotations.branch_length_unit === "relative_time";
}

export function classifyTree(tree: Tree, options: TimeOptions): { mode: ViewMode; options: TimeOptions; result: TimeResult } {
  const fields = availableFields(tree);
  const field = tree.nodes.some(n => Object.hasOwn(n.annotations, options.field)) || !options.autoMethod
    ? options.field : fields[0] ?? options.field;
  const resolved = resolveTimeSource(tree, { ...options, field });
  if (resolved.result.valid) return { ...resolved, mode: resolved.options.method === "nodes" ? "dated" : "chronogram" };
  const hasAnchors = tree.nodes.some(n => Object.hasOwn(n.annotations, field) || fields.some(key => Object.hasOwn(n.annotations, key)) ||
    ["root_age", "node_age", "tip_age", "calibration_age"].some(key => Object.hasOwn(n.annotations, key)));
  const relative = timeBranchesConfirmed(tree, options) && hasCompleteBranchLengths(tree) && !hasAnchors &&
    tree.rooted !== false && (tree.rooted === true || options.rootedConfirmed);
  if (hasBranchLengths(tree) && !hasCompleteBranchLengths(tree)) {
    resolved.result.warnings.push(t("部分分支缺少枝長；未知長度以虛線連接，不補成 1，也不代表零長度測量。"));
  }
  return { ...resolved, mode: !hasBranchLengths(tree) ? "cladogram" : relative ? "relative" : "phylogram" };
}

export const tolerance = (a: number, b: number) => Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);
export const unitFactor = (unit: TimeOptions["unit"]) => ({ Ma: 1, ka: 0.001, years: 0.000001 })[unit];

export function validZeroAgePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    value.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e15);
}
export const zeroAgeMean = (pair: [number, number]): number => (pair[0] + pair[1]) / 2;

export function resolveTimeSource(tree: Tree, options: TimeOptions): { options: TimeOptions; result: TimeResult } {
  if (!options.autoMethod) return { options, result: interpretTime(tree, options) };
  const nodes = interpretTime(tree, { ...options, method: "nodes" });
  if (nodes.valid) return { options: { ...options, method: "nodes" }, result: nodes };
  const branches = interpretTime(tree, { ...options, method: "branches" });
  return branches.valid
    ? { options: { ...options, method: "branches" }, result: branches }
    : { options: { ...options, method: "nodes" }, result: nodes };
}

export function interpretTime(tree: Tree, opts: TimeOptions): TimeResult {
  const result: TimeResult = { valid: false, ages: {}, sources: {}, intervals: {}, errors: [], warnings: [] };
  const error = (text: string) => { if (result.errors.length < 50) result.errors.push(text); };
  if (opts.origin !== "present" || !unitFactor(opts.unit)) error(t("不支援的年代基準或單位。"));
  if (!Number.isFinite(opts.zeroAgeMa) || opts.zeroAgeMa < 0 || opts.zeroAgeMa > 1e15) {
    error(t("檔案中 0 對應的距今年代須為 0–10^15 Ma 的有限數值。"));
  }
  const pair = opts.zeroAgePairMa ?? null;
  if (pair !== null && !validZeroAgePair(pair)) error(t("檔案中 0 所代表年代的兩個端點須為 0–10^15 Ma 的有限數值，順序不限。"));
  const offset = validZeroAgePair(pair) ? zeroAgeMean(pair) : opts.zeroAgeMa;
  if (tree.rooted === false) error(t("檔案明確標記為未定根，無法切換至時間模式。"));
  else if (tree.rooted === null && !opts.rootedConfirmed) error(t("檔案未記錄定根狀態，請在「輸入樹的根」選擇「使用目前的根」，再按目標模式按鈕。"));
  const factor = unitFactor(opts.unit);
  if (!factor) return result;
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  if (opts.method === "branches" && !timeBranchesConfirmed(tree, opts)) error(t("枝長尚未確認代表時間；請提供 branch_length_unit 註解或手動確認。"));
  for (const node of tree.nodes) {
    const anchorKeys = [opts.field, "node_age", "tip_age", "calibration_age", ...(node.id === tree.rootId ? ["root_age"] : [])];
    const key = opts.method === "branches" ? anchorKeys.find(key => Object.hasOwn(node.annotations, key)) ?? opts.field : opts.field;
    const raw = node.annotations[key];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) error(t("{0} {1}：{2} 非合法非負年代。", node.id, node.name, opts.field));
      else { result.ages[node.id] = raw * factor; result.sources[node.id] = `explicit:${key}`; }
    }
    if (opts.method === "branches") {
      for (const anchorKey of anchorKeys) {
        const anchor = node.annotations[anchorKey];
        if (anchor !== undefined && (typeof anchor !== "number" || !Number.isFinite(anchor) || anchor < 0 ||
          (typeof raw === "number" && Math.abs(anchor - raw) > tolerance(anchor, raw)))) {
          error(t("{0}：無效或互相矛盾的年代錨點 {1}。", node.id, anchorKey));
        }
      }
    }
    const intervals = [];
    for (const [key, value] of Object.entries(node.annotations)) {
      if (!/^(age|height).*?(HPD|CredInt)$/i.test(key) || !key.startsWith(opts.field.split("_")[0] + "_")) continue;
      if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0) ||
        typeof value[0] !== "number" || typeof value[1] !== "number" || value[0] > value[1]) {
        result.warnings.push(t("{0}：無效年代區間 {1}", node.id, key)); continue;
      }
      intervals.push({ key, lower: value[0] * factor, upper: value[1] * factor, type: /HPD$/i.test(key) ? "HPD" : "CredInt" });
    }
    result.intervals[node.id] = intervals;
  }
  if (opts.method === "branches") {
    const anchors = tree.nodes.filter(n => Object.hasOwn(result.ages, n.id));
    if (!anchors.length) error(t("缺少輸入中既有的絕對年代錨點；不能假定末端為 0 Ma。"));
    for (const n of tree.nodes) if (n.parentId && (n.length === null || !Number.isFinite(n.length) || n.length < 0)) error(t("{0}：缺少合法時間枝長。", n.id));
    const queue = [...anchors];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], age = result.ages[node.id];
      const neighbors: { id: string; delta: number }[] = [];
      if (node.parentId && node.length !== null) neighbors.push({ id: node.parentId, delta: node.length * factor });
      for (const id of node.children) {
        const child = byId.get(id)!;
        if (child.length !== null) neighbors.push({ id, delta: -child.length * factor });
      }
      for (const neighbor of neighbors) {
        const computed = age + neighbor.delta;
        if (!Object.hasOwn(result.ages, neighbor.id)) {
          result.ages[neighbor.id] = computed;
          result.sources[neighbor.id] = `derived:time-length via ${node.id}`;
          queue.push(byId.get(neighbor.id)!);
        } else if (Math.abs(result.ages[neighbor.id] - computed) > tolerance(result.ages[neighbor.id], computed)) {
          error(t("{0} ↔ {1}：既有年代錨點與時間枝長矛盾。", node.id, neighbor.id));
        }
      }
    }
  }
  let missing = 0;
  for (const node of tree.nodes) {
    const age = result.ages[node.id];
    if (age === undefined) { if (node.children.length || opts.method === "branches") missing++; continue; }
    if (!Number.isFinite(age) || age < 0) error(t("{0}：推導年代小於 0 或不是有限值。", node.id));
    if (node.parentId) {
      const parent = result.ages[node.parentId];
      if (parent !== undefined && age - parent > tolerance(age, parent)) error(t("{0}：子節點 {1} Ma 比父節點 {2} Ma 更老。", node.id, age, parent));
    }
  }
  if (missing) error(t("所選欄位 {0} 有 {1}/{2} 個節點無可用年代；不以 0 補齊。", opts.field, missing, tree.nodes.length));
  const unknownTips = tree.nodes.filter(n => !n.children.length && result.ages[n.id] === undefined).length;
  if (opts.method === "nodes" && unknownTips) result.warnings.push(t("{0} 個末端年代未知；虛線僅供辨識拓樸，不代表年代或時間長度。", unknownTips));
  // Validate relative ages first: an offset must not conceal invalid negative ages
  // or inconsistent time branches. Shift absolute points, never durations.
  if (!result.errors.length && (offset !== 0 || pair !== null)) {
    for (const id of Object.keys(result.ages)) {
      result.ages[id] += offset;
      result.sources[id] += `; zero=${offset} Ma${pair ? `; midpoint=(${pair[0]}+${pair[1]})/2` : ""}`;
    }
    for (const intervals of Object.values(result.intervals)) {
      for (const interval of intervals) {
        interval.lower += offset;
        interval.upper += offset;
      }
    }
  }
  result.valid = !result.errors.length;
  return result;
}

export function ageX(age: number, older: number, younger: number, left: number, width: number): number {
  return left + (older - age) / (older - younger) * width;
}

export function treeAgeRange(ages: number[]): { older: number; younger: number } {
  if (!ages.length || ages.some(age => !Number.isFinite(age) || age < 0)) throw new Error(t("無法依無效年代計算橫軸範圍。"));
  let min = ages[0], max = ages[0];
  for (const age of ages) { min = Math.min(min, age); max = Math.max(max, age); }
  const span = Math.max(max - min, max * 1e-12, 1e-6);
  return { older: max + span * 0.05, younger: Math.max(0, min - span * 0.05) };
}

export function makeTicks(older: number, younger: number, step: number | null): number[] {
  if (![older, younger].every(Number.isFinite) || older <= younger || younger < 0) throw new Error(t("年代範圍須為非負值，較老端必須大於較新端。"));
  if (step === null) {
    const raw = (older - younger) / 8;
    const power = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 5, 10].find(n => n * power >= raw)! * power;
  }
  if (!Number.isFinite(step) || step <= 0 || step < Number.EPSILON * Math.max(older, 1)) throw new Error(t("刻度間距過小或無效。"));
  const first = Math.ceil(younger / step - 1e-10), last = Math.floor(older / step + 1e-10);
  if (last - first > 200) throw new Error(t("刻度過密：最多 201 條主格線，請增加間距或縮小範圍。"));
  const ticks = [];
  const places = Math.min(100, Math.max(0, -Math.floor(Math.log10(step))) + 2);
  for (let i = last; i >= first; i--) {
    const value = Number((i * step).toFixed(places));
    if (value >= younger - 1e-10 && value <= older + 1e-10) ticks.push(Object.is(value, -0) ? 0 : value);
  }
  if (new Set(ticks).size !== ticks.length) throw new Error(t("刻度間距小於此範圍可表達的數值精度。"));
  return ticks;
}
