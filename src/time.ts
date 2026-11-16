import type { Tree, TimeOptions, TimeResult } from "./model.ts";

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
  if (opts.origin !== "present" || !unitFactor(opts.unit)) error("不支援的年代基準或單位。");
  if (!Number.isFinite(opts.zeroAgeMa) || opts.zeroAgeMa < 0 || opts.zeroAgeMa > 1e15) {
    error("檔案中 0 對應的距今年代須為 0–10^15 Ma 的有限數值。");
  }
  const pair = opts.zeroAgePairMa ?? null;
  if (pair !== null && !validZeroAgePair(pair)) error("檔案中 0 所代表年代的兩個端點須為 0–10^15 Ma 的有限數值，順序不限。");
  const offset = validZeroAgePair(pair) ? zeroAgeMean(pair) : opts.zeroAgeMa;
  if (tree.rooted === false) error("檔案明確標記為未定根，無法切換至時間模式。");
  else if (tree.rooted === null && !opts.rootedConfirmed) error("檔案未記錄定根狀態，請在「輸入樹的根」選擇「使用目前的根」，再按目標模式按鈕。");
  const factor = unitFactor(opts.unit);
  if (!factor) return result;
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  for (const node of tree.nodes) {
    const raw = node.annotations[opts.field];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) error(`${node.id} ${node.name}：${opts.field} 非合法非負年代。`);
      else { result.ages[node.id] = raw * factor; result.sources[node.id] = `explicit:${opts.field}`; }
    }
    const intervals = [];
    for (const [key, value] of Object.entries(node.annotations)) {
      if (!/^(age|height).*?(HPD|CredInt)$/i.test(key) || !key.startsWith(opts.field.split("_")[0] + "_")) continue;
      if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0) ||
        typeof value[0] !== "number" || typeof value[1] !== "number" || value[0] > value[1]) {
        result.warnings.push(`${node.id}：無效年代區間 ${key}`); continue;
      }
      intervals.push({ key, lower: value[0] * factor, upper: value[1] * factor, type: /HPD$/i.test(key) ? "HPD" : "CredInt" });
    }
    result.intervals[node.id] = intervals;
  }
  if (opts.method === "branches") {
    const anchors = tree.nodes.filter(n => Object.hasOwn(result.ages, n.id));
    if (!anchors.length) error("缺少輸入中既有的絕對年代錨點；不能假定末端為 0 Ma。");
    for (const n of tree.nodes) if (n.parentId && (n.length === null || !Number.isFinite(n.length) || n.length < 0)) error(`${n.id}：缺少合法時間枝長。`);
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
          error(`${node.id} ↔ ${neighbor.id}：既有年代錨點與時間枝長矛盾。`);
        }
      }
    }
  }
  let missing = 0;
  for (const node of tree.nodes) {
    const age = result.ages[node.id];
    if (age === undefined) { missing++; continue; }
    if (!Number.isFinite(age) || age < 0) error(`${node.id}：推導年代小於 0 或不是有限值。`);
    if (node.parentId) {
      const parent = result.ages[node.parentId];
      if (parent !== undefined && age - parent > tolerance(age, parent)) error(`${node.id}：子節點 ${age} Ma 比父節點 ${parent} Ma 更老。`);
    }
  }
  if (missing) error(`所選欄位 ${opts.field} 有 ${missing}/${tree.nodes.length} 個節點無可用年代；不以 0 補齊。`);
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
  if (!ages.length || ages.some(age => !Number.isFinite(age) || age < 0)) throw new Error("無法依無效年代計算橫軸範圍。");
  let min = ages[0], max = ages[0];
  for (const age of ages) { min = Math.min(min, age); max = Math.max(max, age); }
  const span = Math.max(max - min, max * 1e-12, 1e-6);
  return { older: max + span * 0.05, younger: Math.max(0, min - span * 0.05) };
}

export function makeTicks(older: number, younger: number, step: number | null): number[] {
  if (![older, younger].every(Number.isFinite) || older <= younger || younger < 0) throw new Error("年代範圍須為非負值，較老端必須大於較新端。");
  if (step === null) {
    const raw = (older - younger) / 8;
    const power = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 5, 10].find(n => n * power >= raw)! * power;
  }
  if (!Number.isFinite(step) || step <= 0 || step < Number.EPSILON * Math.max(older, 1)) throw new Error("刻度間距過小或無效。");
  const first = Math.ceil(younger / step - 1e-10), last = Math.floor(older / step + 1e-10);
  if (last - first > 200) throw new Error("刻度過密：最多 201 條主格線，請增加間距或縮小範圍。");
  const ticks = [];
  const places = Math.min(100, Math.max(0, -Math.floor(Math.log10(step))) + 2);
  for (let i = last; i >= first; i--) {
    const value = Number((i * step).toFixed(places));
    if (value >= younger - 1e-10 && value <= older + 1e-10) ticks.push(Object.is(value, -0) ? 0 : value);
  }
  if (new Set(ticks).size !== ticks.length) throw new Error("刻度間距小於此範圍可表達的數值精度。");
  return ticks;
}
