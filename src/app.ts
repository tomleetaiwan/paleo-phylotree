import sample from "../examples/dated-mrbayes.nex";
import trilobites from "../examples/trilobites-tip-date.nex.con.tre";
import { LIMITS } from "./model.ts";
import type { SourceDocument, TimeOptions, ViewState, TimeResult } from "./model.ts";
import { availableFields, parseDocument } from "./parsers.ts";
import { ageX, interpretTime, resolveTimeSource, validZeroAgePair, zeroAgeMean } from "./time.ts";
import { defaultTime, defaultView, loadProject, nodeCSV, saveProject } from "./project.ts";
import { drawTree, svgElement } from "./render.ts";
import type { Diagram } from "./render.ts";

function element(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing interface element: ${id}`);
  return el;
}
function input(id: string): HTMLInputElement {
  const el = element(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`Not an input: ${id}`);
  return el;
}
function select(id: string): HTMLSelectElement {
  const el = element(id);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`Not a select: ${id}`);
  return el;
}
function button(id: string): HTMLButtonElement {
  const el = element(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`Not a button: ${id}`);
  return el;
}
const canvas = element("canvas");
const evidence = element("evidence");
if (!(evidence instanceof HTMLTextAreaElement)) throw new Error("Missing evidence textarea");
const evidenceInput = evidence;
let doc: SourceDocument | null = null;
let selectedTree = 0;
let options = defaultTime();
let view = defaultView();
let result: TimeResult = { valid: false, ages: {}, sources: {}, intervals: {}, errors: [], warnings: [] };
let diagram: Diagram | null = null;
let loadSequence = 0;

function message(text: string, type = "") {
  const el = element("notice");
  el.textContent = text; el.className = type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
}
function report(err: unknown) {
  console.error(err);
  message(err instanceof Error ? err.message : "操作失敗，請檢查輸入資料。", "error");
}
function action(fn: () => void | Promise<void>): () => void {
  return () => { Promise.resolve().then(fn).catch(report); };
}
function bind(id: string, fn: () => void | Promise<void>) { button(id).addEventListener("click", action(fn)); }
function currentTree() {
  if (!doc) throw new Error("請先開啟樹檔。");
  return doc.trees[selectedTree];
}
function paragraph(parent: HTMLElement, text: string, className = "") {
  const p = document.createElement("p"); p.textContent = text; p.className = className; parent.append(p);
}
function appendDetail(dl: HTMLDListElement, key: string, value: unknown) {
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = key; dd.textContent = value === undefined || value === null ? "未提供" : String(value);
  dl.append(dt, dd);
}
function updateDetails() {
  const box = element("node-info");
  box.replaceChildren();
  const node = doc?.trees[selectedTree].nodes.find(n => n.id === view.selected);
  button("collapse").disabled = !node?.children.length;
  if (!node) { box.textContent = "尚未選取節點"; return; }
  const dl = document.createElement("dl");
  appendDetail(dl, "節點／分類群", node.name || "未命名內部節點");
  appendDetail(dl, "穩定節點 ID", node.id);
  appendDetail(dl, "父節點 ID", node.parentId ?? "根");
  appendDetail(dl, "距今年代（Ma，完整精度）", view.mode === "time" && result.valid ? result.ages[node.id] : "未啟用有效時間模式");
  appendDetail(dl, "年代來源", result.valid ? result.sources[node.id] : "未確認／不完整");
  appendDetail(dl, "原始 0 對應的距今年代", `${options.zeroAgeMa} Ma`);
  if (options.zeroAgePairMa) appendDetail(dl, "原點兩數算術中點", `(${options.zeroAgePairMa[0]}＋${options.zeroAgePairMa[1]}) ÷ 2＝${options.zeroAgeMa} Ma`);
  appendDetail(dl, `原始 ${options.field || "年代欄位"}`, JSON.stringify(node.annotations[options.field]));
  appendDetail(dl, "原始枝長（非自動 Ma）", node.length);
  appendDetail(dl, "支持度", node.support);
  if (result.valid) for (const interval of result.intervals[node.id] ?? []) appendDetail(dl, interval.key, `${interval.lower}–${interval.upper} Ma（${interval.type}）`);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify({ annotations: node.annotations, rawAnnotations: node.rawAnnotations }, null, 2);
  box.append(dl, pre);
}
function updateDiagnostics() {
  const el = element("diagnostics"); el.replaceChildren();
  if (!doc) return;
  const tree = currentTree();
  const nodes = options.method === "nodes" ? result : interpretTime(tree, { ...options, method: "nodes" });
  const branches = options.method === "branches" ? result : interpretTime(tree, { ...options, method: "branches" });
  const rootMissing = tree.rooted === false || (tree.rooted === null && !options.rootedConfirmed);
  const branchStatus = branches.valid ? "數值相容，單位待確認" : rootMissing ? "定根條件未滿足" : "數值不相容或資料不足";
  element("method-nodes").textContent = `明確節點年代（${nodes.valid ? "建議" : "目前不可用"}）`;
  element("method-branches").textContent = `時間枝長＋既有年代錨點（${branchStatus}）`;
  const status = [
    options.autoMethod
      ? `自動判斷：${result.valid ? `已採用「${options.method === "nodes" ? "明確節點年代" : "時間枝長＋既有年代錨點"}」。` : "兩種來源目前皆不可用，保留一般模式。"}`
      : `手動指定：${options.method === "nodes" ? "明確節點年代" : "時間枝長＋既有年代錨點"}。`,
    `明確節點年代：${nodes.valid ? `${options.field} 的節點年代完整且通過檢核。` : nodes.errors[0]}`,
    `時間枝長：${branchStatus}。${branches.valid ? "請依原始分析設定確認枝長代表時間，而非替換數；數值相容不代表已驗證時間單位。" : branches.errors[0]}`,
    nodes.valid ? "建議使用「明確節點年代」；不需改用時間枝長也能顯示 Ma。" : branches.valid ? "可依時間枝長推導，但仍須自行確認分析單位與時間原點。" : "請先處理缺漏、定根或年代矛盾，再啟用 Ma。",
    "此檢查依目前欄位、單位與時間原點設定，不代表已驗證分析語意；確認設定後按「驗證並顯示 Ma」。"
  ];
  element("source-status").textContent = status.join("\n");
  paragraph(el, `${doc.filename} · ${doc.format} · ${tree.name}`);
  paragraph(el, `年代欄位：${availableFields(tree).join("、") || "無"}；${Object.keys(result.ages).length}/${tree.nodes.length} 個節點有明確或可推導值。`);
  paragraph(el, `設定單位 ${options.unit}；原始 0＝${options.zeroAgeMa} Ma。單位與原點依目前設定換算，不代表已驗證分析語意。`);
  if (options.evidence) paragraph(el, `年代備註：${options.evidence}`);
  for (const warning of [...tree.warnings, ...result.warnings]) paragraph(el, warning, "problem");
  if (result.errors.length) {
    paragraph(el, `年代檢核未通過：${result.errors[0]}${options.method === "branches" && nodes.valid ? " 建議改用「明確節點年代」。" : ""}`, "problem");
    const details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = `查看 ${result.errors.length} 筆詳細檢核訊息`;
    details.append(summary);
    for (const err of result.errors) paragraph(details, err, "problem");
    el.append(details);
  }
  if (result.valid) paragraph(el, "年代檢核通過。原始枝長與年代分開保留。", "good");
  if (tree.nodes.length > 200 && !view.simplified) paragraph(el, "已依標籤大小自動調整縱向間距；大型樹請向下捲動，或折疊／明確啟用簡化標籤。");
}
function updateMetadata() {
  if (!doc) return;
  const tree = currentTree();
  element("file-summary").textContent = `${doc.filename}\n${doc.format} · ${doc.trees.length} 棵樹`;
  const stats = element("tree-stats");
  stats.replaceChildren();
  for (const text of [
    `${tree.nodes.filter(n => !n.children.length).length} tips`, `${tree.nodes.length} nodes`,
    tree.rooted === true ? "已標記定根" : tree.rooted === false ? "標記為未定根" : "定根狀態未記錄",
    `${availableFields(tree).length} 年代欄位`
  ]) { const span = document.createElement("span"); span.textContent = text; stats.append(span); }
}
function setCanvasGeometry() {
  if (!diagram) return;
  diagram.svg.style.width = `${diagram.width * view.zoom}px`;
  diagram.svg.style.height = `${diagram.height * view.zoom}px`;
  canvas.scrollLeft = view.panX; canvas.scrollTop = view.panY;
  element("zoom-label").textContent = `${Math.round(view.zoom * 100)}%`;
}
function render() {
  if (!doc) return;
  const next = drawTree(currentTree(), result, view, canvas.clientWidth, id => {
    view.selected = id;
    render();
  });
  diagram = next;
  canvas.replaceChildren(diagram.svg);
  setCanvasGeometry();
  input("older").disabled = view.autoRange;
  input("younger").disabled = view.autoRange;
  if (view.autoRange && view.mode === "time" && result.valid) {
    input("older").value = String(diagram.older);
    input("younger").value = String(diagram.younger);
  }
  element("range-summary").textContent = view.mode === "time" && result.valid
    ? `${view.autoRange ? "自動貼合" : "手動範圍"}：${Number(diagram.older.toPrecision(10))}–${Number(diagram.younger.toPrecision(10))} Ma；維持線性比例，不強制延伸至現在。`
    : "自動模式依全樹最老／最年輕年代保留少量邊界；Ma 比例仍為線性。";
  const badge = element("mode-badge");
  badge.textContent = view.mode === "time" && result.valid ? "Ma 時間模式" : "一般模式";
  badge.className = `badge${view.mode === "time" && result.valid ? " time" : ""}`;
  updateDetails(); updateDiagnostics();
}
function syncControls() {
  select("method").value = options.autoMethod ? "auto" : options.method;
  select("time-range").value = view.autoRange ? "auto" : "manual";
  select("root-style").value = view.rootStyle;
  input("zero-age").value = String(options.zeroAgePairMa?.[0] ?? options.zeroAgeMa);
  input("zero-age-second").value = options.zeroAgePairMa ? String(options.zeroAgePairMa[1]) : "";
  input("zero-age-range").checked = options.zeroAgePairMa !== null;
  input("zero-age-single").checked = options.zeroAgePairMa === null;
  syncZeroAgeMode();
  evidenceInput.value = options.evidence;
  element("root-status").hidden = currentTree().rooted !== null;
  select("root-confirmed").value = options.rootedConfirmed ? "rooted" : "unknown";
  const fields = availableFields(currentTree());
  const ageField = select("age-field");
  ageField.replaceChildren();
  for (const field of new Set([options.field, ...fields])) {
    const option = document.createElement("option"); option.value = field;
    option.textContent = fields.includes(field) ? field : `${field}（輸入未提供）`; ageField.append(option);
  }
  ageField.value = options.field;
  for (const [id, value] of Object.entries({
    older: view.older, younger: view.younger, "grid-step": view.gridStep, "grid-opacity": view.gridOpacity,
    decimals: view.decimals, "font-size": view.fontSize, "line-width": view.lineWidth, "grid-color": view.gridColor, "branch-color": view.branchColor
  })) input(id).value = value === null ? "" : String(value);
  for (const [id, value] of Object.entries({
    "root-stem": view.rootStem, grid: view.grid, "minor-grid": view.minorGrid, names: view.names, ages: view.ages, "all-tips": view.allTips, support: view.support, simplified: view.simplified
  })) input(id).checked = value;
  select("order").value = view.order;
}
function commitDocument(nextDoc: SourceDocument, index = 0, nextOptions = defaultTime(), nextView = defaultView()) {
  const resolved = resolveTimeSource(nextDoc.trees[index], nextOptions);
  nextOptions = resolved.options;
  const nextResult = resolved.result;
  if (!nextResult.valid) nextView.mode = "general";
  // Validate drawing settings before replacing a valid open project.
  drawTree(nextDoc.trees[index], nextResult, nextView, canvas.clientWidth, () => {});
  doc = nextDoc; selectedTree = index; options = nextOptions; view = nextView; result = nextResult;
  const selector = select("tree"); selector.replaceChildren(); selector.disabled = false;
  for (const [i, tree] of doc.trees.entries()) {
    const opt = document.createElement("option"); opt.value = String(i); opt.textContent = `${i + 1}. ${tree.name}`; selector.append(opt);
  }
  selector.value = String(index);
  for (const id of ["save", "apply-time", "general", "find", "fit", "zoom-in", "zoom-out", "svg", "png", "csv", "original", "expand-all"]) button(id).disabled = false;
  syncControls(); updateMetadata(); render();
}
async function openFile(file: File) {
  const sequence = ++loadSequence;
  const project = file.name.toLowerCase().endsWith(".json");
  if (file.size > (project ? 32 * 1024 * 1024 : LIMITS.bytes)) throw new Error(`${file.name}：檔案超過 ${project ? "32" : "10"} MiB 限制。`);
  message(`正在讀取 ${file.name}…`);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error(`${file.name}：讀取失敗或非有效 UTF-8，請重新匯出 UTF-8 檔案。`); }
  if (sequence !== loadSequence) return;
  try {
    if (project) {
      const restored = loadProject(content);
      commitDocument(restored.doc, restored.selectedTree, restored.options, restored.view);
    } else commitDocument(parseDocument(content, file.name, select("format").value));
  } catch (err) {
    throw new Error(`${file.name}：${err instanceof Error ? err.message : "匯入失敗"}；目前專案保持不變。`);
  }
  message(`${file.name} 已開啟；${project ? "已還原專案設定。" : "請確認年代來源與單位，再啟用 Ma。"}`, "success");
}
function syncZeroAgeMode() {
  const range = input("zero-age-range").checked;
  element("zero-age-first-label").textContent = range ? "端點 A" : "年代（Ma）";
  element("zero-age-second-label").hidden = !range;
  input("zero-age-second").required = range;
  input("zero-age-second").disabled = !range;
  element("zero-age-values").classList.toggle("two-col", range);
  updateZeroAgeSummary();
}
function updateZeroAgeSummary() {
  const range = input("zero-age-range").checked;
  const first = input("zero-age").valueAsNumber;
  const second = range ? input("zero-age-second").valueAsNumber : null;
  const valid = validZeroAgePair([first, second ?? first]);
  element("zero-age-summary").textContent = !valid ? range ? "請填入兩個端點（0–10^15 Ma，順序不限）。" : "請輸入 0–10^15 Ma 的有效年代。"
    : second === null ? `全樹平移值：${first} Ma`
    : `全樹平移值：（${first}＋${second}）÷2＝${zeroAgeMean([first, second])} Ma`;
}
function readTimeOptions(): TimeOptions {
  const method = select("method").value;
  const first = readNumber("zero-age", 0, 1e15)!;
  const second = input("zero-age-range").checked ? readNumber("zero-age-second", 0, 1e15)! : null;
  const pair: [number, number] | null = second === null ? null : [first, second];
  return {
    autoMethod: method === "auto",
    method: method === "auto" ? options.method : method === "branches" ? "branches" : "nodes", field: select("age-field").value,
    unit: "Ma",
    origin: "present", zeroAgeMa: pair ? zeroAgeMean(pair) : first, zeroAgePairMa: pair,
    evidence: evidenceInput.value.trim(),
    rootedConfirmed: currentTree().rooted === null && select("root-confirmed").value === "rooted"
  };
}
function readNumber(id: string, min: number, max: number, nullable = false): number | null {
  const control = input(id), raw = control.value;
  if (nullable && raw === "" && !control.validity.badInput) return null;
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${id}：設定須介於 ${min} 與 ${max}。`);
  return value;
}
function readView(): ViewState {
  const decimals = readNumber("decimals", 0, 6)!;
  if (!Number.isInteger(decimals)) throw new Error("年代小數位必須是 0–6 的整數。");
  const order = select("order").value;
  const autoRange = select("time-range").value === "auto";
  return {
    ...view, autoRange, rootStyle: select("root-style").value === "solid" ? "solid" : "hollow", rootStem: input("root-stem").checked,
    older: autoRange ? view.older : readNumber("older", 0, 1e15, true),
    younger: autoRange ? view.younger : readNumber("younger", 0, 1e15)!,
    gridStep: readNumber("grid-step", Number.MIN_VALUE, 1e15, true),
    grid: input("grid").checked, minorGrid: input("minor-grid").checked, gridColor: input("grid-color").value,
    gridOpacity: readNumber("grid-opacity", 0, 1)!, decimals, fontSize: readNumber("font-size", 8, 32)!,
    branchColor: input("branch-color").value, lineWidth: readNumber("line-width", 0.5, 6)!,
    names: input("names").checked, ages: input("ages").checked, allTips: input("all-tips").checked,
    support: input("support").checked, simplified: input("simplified").checked,
    order: order === "ascending" ? "ascending" : order === "descending" ? "descending" : "original"
  };
}

bind("open", () => { input("file").click(); });
input("file").addEventListener("change", action(async () => {
  const file = input("file").files?.[0];
  try { if (file) await openFile(file); }
  finally { input("file").value = ""; }
}));
select("demo").addEventListener("change", action(() => {
  const choice = select("demo").value;
  if (!choice) return;
  try {
    if (choice === "synthetic") {
      commitDocument(parseDocument(sample, "dated-mrbayes.nex"), 0, {
        ...defaultTime(),
        evidence: "內建合成範例：根節點 age_mean＝100 Ma 距今；枝長為經過的百萬年，非替換數；其餘節點年代由此推導，非真實生物推論。"
      });
      message("已載入時間枝長合成範例：根節點錨點為 100 Ma，已自動採用時間枝長模式；按「驗證並顯示 Ma」推導其餘節點年代。", "success");
    } else if (choice === "trilobites") {
      commitDocument(parseDocument(trilobites, "trilobites-tip-date.nex.con.tre"));
      message("已載入三葉蟲共識樹。請確認資料以 Ma 為單位並設定原始 0 的距今年代，再按「驗證並顯示 Ma」；不預設化石校正值。", "success");
    } else throw new Error("不支援的範例選項。");
  } finally { select("demo").value = ""; }
}));
select("tree").addEventListener("change", action(() => {
  if (!doc) return;
  commitDocument(doc, Number(select("tree").value));
  message("已切換樹；請針對這棵樹重新確認年代解讀。");
}));
bind("apply-time", () => {
  const { options: nextOptions, result: nextResult } = resolveTimeSource(currentTree(), readTimeOptions());
  const nextView = { ...readView(), mode: nextResult.valid ? "time" : "general" } satisfies ViewState;
  drawTree(currentTree(), nextResult, nextView, canvas.clientWidth, () => {});
  options = nextOptions; result = nextResult; view = nextView;
  render();
  message(result.valid ? "年代檢核通過：目前以 Ma 顯示。化石末端保留既有年代。" : "年代檢核未通過，已保留一般模式。請查看右側診斷。", result.valid ? "success" : "error");
});
bind("general", () => { view.mode = "general"; render(); message("一般模式：水平距離不代表絕對年代。"); });
for (const id of ["zero-age", "zero-age-second"]) input(id).addEventListener("input", updateZeroAgeSummary);
for (const id of ["method", "age-field", "zero-age-single", "zero-age-range", "zero-age", "zero-age-second", "root-confirmed"]) {
  element(id).addEventListener("change", action(() => {
    const modeChanged = id === "zero-age-single" || id === "zero-age-range";
    if (modeChanged) syncZeroAgeMode();
    if (doc) {
      view.mode = "general";
      result = interpretTime(currentTree(), options);
      render();
    }
    if (!doc) return;
    if (modeChanged && input("zero-age-range").checked && input("zero-age-second").value === "") {
      message("請填入端點 A 與端點 B（順序不限），再按「驗證並顯示 Ma」。");
      return;
    }
    const resolved = resolveTimeSource(currentTree(), readTimeOptions());
    options = resolved.options;
    view.mode = "general"; result = resolved.result; render();
    message("年代解讀已變更，請按「驗證並顯示 Ma」套用。");
  }));
}
evidenceInput.addEventListener("change", action(() => {
  options.evidence = evidenceInput.value.trim();
  updateDiagnostics();
}));
for (const id of ["root-style", "root-stem", "time-range", "older", "younger", "grid-step", "grid", "minor-grid", "grid-color", "grid-opacity", "decimals", "font-size", "branch-color", "line-width", "names", "ages", "all-tips", "support", "simplified", "order"]) {
  element(id).addEventListener("change", action(() => {
    if (!doc) return;
    const next = readView();
    drawTree(currentTree(), result, next, canvas.clientWidth, () => {});
    view = next; render();
    message(view.simplified ? "簡化模式已啟用：部分標籤隱藏，點選節點可查詢。" : "檢視設定已更新。");
  }));
}
function zoom(factor: number) {
  if (!diagram) return;
  const old = view.zoom, next = Math.min(16, Math.max(0.25, old * factor));
  view.panX = (canvas.scrollLeft + canvas.clientWidth / 2) * next / old - canvas.clientWidth / 2;
  view.panY = (canvas.scrollTop + canvas.clientHeight / 2) * next / old - canvas.clientHeight / 2;
  view.zoom = next; setCanvasGeometry();
}
bind("zoom-in", () => zoom(1.25)); bind("zoom-out", () => zoom(0.8));
bind("fit", () => {
  if (!diagram) return;
  view.zoom = Math.max(0.25, Math.min(1, canvas.clientWidth / diagram.width, canvas.clientHeight / diagram.height));
  view.panX = 0; view.panY = 0; setCanvasGeometry();
});
canvas.addEventListener("scroll", () => { view.panX = canvas.scrollLeft; view.panY = canvas.scrollTop; });
canvas.addEventListener("wheel", e => {
  if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); }
}, { passive: false });
canvas.addEventListener("keydown", e => {
  if (e.target !== canvas) return;
  if (["+", "=", "-"].includes(e.key)) { e.preventDefault(); zoom(e.key === "-" ? 0.8 : 1.25); }
  const delta = ({ ArrowLeft: [-70, 0], ArrowRight: [70, 0], ArrowUp: [0, -70], ArrowDown: [0, 70] } as Record<string, number[]>)[e.key];
  if (delta) { e.preventDefault(); canvas.scrollBy(delta[0], delta[1]); }
});
let drag: { x: number; y: number; left: number; top: number } | null = null;
canvas.addEventListener("pointerdown", e => {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest("[data-node-id]"))) return;
  drag = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
  canvas.setPointerCapture(e.pointerId); canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", e => {
  if (drag) { canvas.scrollLeft = drag.left + drag.x - e.clientX; canvas.scrollTop = drag.top + drag.y - e.clientY; }
});
for (const name of ["pointerup", "pointercancel"]) canvas.addEventListener(name, () => { drag = null; canvas.classList.remove("dragging"); });
canvas.addEventListener("dragover", e => { e.preventDefault(); canvas.classList.add("drop"); });
canvas.addEventListener("dragleave", () => canvas.classList.remove("drop"));
canvas.addEventListener("drop", e => {
  e.preventDefault(); canvas.classList.remove("drop");
  const file = e.dataTransfer?.files[0];
  if (file) action(() => openFile(file))();
});
bind("find", () => {
  const query = input("search").value.trim().toLocaleLowerCase();
  if (!query) throw new Error("請輸入分類群名稱或節點 ID。");
  const tree = currentTree();
  const matches = tree.nodes.filter(n => n.id.toLowerCase() === query || n.name.toLocaleLowerCase().includes(query));
  if (!matches.length) throw new Error("找不到符合的分類群或節點。");
  const index = matches.findIndex(n => n.id === view.selected), node = matches[(index + 1) % matches.length];
  const map = new Map(tree.nodes.map(n => [n.id, n]));
  let parent = node.parentId;
  while (parent) { view.collapsed = view.collapsed.filter(id => id !== parent); parent = map.get(parent)!.parentId; }
  if (view.mode === "time" && diagram && (result.ages[node.id] > diagram.older || result.ages[node.id] < diagram.younger)) {
    view.autoRange = true; view.older = null; view.younger = 0; syncControls();
  }
  view.selected = node.id; render();
  const point = diagram!.points.get(node.id)!;
  canvas.scrollTo({ left: point.x * view.zoom - canvas.clientWidth / 2, top: point.y * view.zoom - canvas.clientHeight / 2 });
  message(`已定位 ${node.name || node.id}（${node.id}）；共 ${matches.length} 筆，再按定位可循環。`, "success");
});
input("search").addEventListener("keydown", e => { if (e.key === "Enter") button("find").click(); });
bind("collapse", () => {
  const node = currentTree().nodes.find(n => n.id === view.selected);
  if (!node?.children.length) throw new Error("請先選取內部節點。");
  view.collapsed = view.collapsed.includes(node.id) ? view.collapsed.filter(id => id !== node.id) : [...view.collapsed, node.id];
  render();
});
bind("expand-all", () => { view.collapsed = []; render(); });
function download(content: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
bind("save", () => {
  if (!doc) return;
  download(saveProject(doc, selectedTree, options, view), "application/json;charset=utf-8", "paleotree-project.json");
});
bind("original", () => { if (doc) download(doc.content, "text/plain;charset=utf-8", doc.filename); });
bind("csv", () => { if (doc) download(nodeCSV(currentTree(), result, options), "text/csv;charset=utf-8", "node-ages.csv"); });
function exportSVG(): { text: string; width: number; height: number } {
  if (!diagram) throw new Error("請先開啟樹。");
  const svg = diagram.svg.cloneNode(true);
  if (!(svg instanceof SVGSVGElement)) throw new Error("SVG 複製失敗。");
  svg.removeAttribute("style");
  let width = diagram.width, height = diagram.height;
  if (select("export-scope").value === "viewport") {
    width = Math.min(diagram.width - canvas.scrollLeft / view.zoom, canvas.clientWidth / view.zoom);
    height = Math.min(diagram.height - canvas.scrollTop / view.zoom, canvas.clientHeight / view.zoom);
    const left = canvas.scrollLeft / view.zoom, bodyTop = canvas.scrollTop / view.zoom, top = bodyTop - 65;
    const body = svgElement("g", { "clip-path": "url(#export-viewport-clip)" });
    while (svg.firstChild) body.append(svg.firstChild);
    const defs = svgElement("defs"), clip = svgElement("clipPath", { id: "export-viewport-clip" });
    clip.append(svgElement("rect", { x: left, y: bodyTop, width, height }));
    defs.append(clip); svg.append(defs, body);
    height += 65;
    svg.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
    // Keep an explicit axis in a vertically scrolled export instead of silently
    // cropping away the only indication that the horizontal coordinate is Ma.
    const header = svgElement("g", { "data-export-axis": "viewport" });
    header.append(svgElement("rect", { x: left, y: top, width, height: 65, fill: "#ffffff" }));
    header.append(svgElement("text", { x: left + 10, y: top + 18, fill: "#203f3c", "font-size": 12, "font-family": "sans-serif" },
      `${currentTree().name} · ${view.mode === "time" ? "時間樹" : "一般樹（非 Ma）"} · 目前視窗`));
    if (view.mode === "time" && result.valid) {
      header.append(svgElement("text", {
        x: left + 10, y: top + 40, fill: "#526966", "font-size": 12, "font-family": "sans-serif", "data-axis-title": "time"
      }, "距今年代（Ma）"));
      for (const tick of diagram.ticks) {
        const x = ageX(tick, diagram.older, diagram.younger, diagram.plotLeft, diagram.plotWidth);
        if (x < left + diagram.plotLeft || x > left + width - 8) continue;
        header.append(svgElement("line", { x1: x, x2: x, y1: top + 47, y2: top + 55, stroke: "#7f9691" }));
        header.append(svgElement("text", { x, y: top + 40, "text-anchor": "middle", fill: "#596d6a", "font-size": 11, "font-family": "sans-serif" }, String(tick)));
      }
      header.append(svgElement("line", { x1: Math.min(left + diagram.plotLeft, left + width), x2: left + width, y1: top + 55, y2: top + 55, stroke: "#7f9691" }));
    }
    svg.append(header);
  }
  svg.setAttribute("width", String(Math.ceil(width))); svg.setAttribute("height", String(Math.ceil(height)));
  svg.removeAttribute("role"); svg.removeAttribute("aria-label");
  for (const el of svg.querySelectorAll("*")) { el.removeAttribute("tabindex"); el.removeAttribute("role"); el.removeAttribute("cursor"); }
  return { text: new XMLSerializer().serializeToString(svg), width: Math.ceil(width), height: Math.ceil(height) };
}
bind("svg", () => { const svg = exportSVG(); download(svg.text, "image/svg+xml;charset=utf-8", "paleotree.svg"); });
bind("png", async () => {
  const svg = exportSVG(), scale = Number(select("png-scale").value);
  const width = svg.width * scale, height = svg.height * scale;
  if (width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error("PNG 超過畫布限制（單邊 16,384 px、總 6,400 萬像素）。請選目前視窗、降低倍率或改存 SVG。");
  const url = URL.createObjectURL(new Blob([svg.text], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("PNG 圖像載入失敗。")); image.src = url; });
    const surface = document.createElement("canvas"); surface.width = width; surface.height = height;
    const ctx = surface.getContext("2d"); if (!ctx) throw new Error("無法建立 PNG 畫布。");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => surface.toBlob(b => b ? resolve(b) : reject(new Error("PNG 轉換失敗。")), "image/png"));
    download(blob, "image/png", "paleotree.png");
  } finally { URL.revokeObjectURL(url); }
});
bind("help", () => { const dialog = element("help-dialog"); if (dialog instanceof HTMLDialogElement) dialog.showModal(); });
bind("close-help", () => { const dialog = element("help-dialog"); if (dialog instanceof HTMLDialogElement) dialog.close(); });

const mainLayout = element("main-layout");
const paneControls = [
  { splitter: element("resize-settings"), pane: element("settings-pane"), other: element("inspector-pane"), variable: "--settings-width", direction: 1 },
  { splitter: element("resize-inspector"), pane: element("inspector-pane"), other: element("settings-pane"), variable: "--inspector-width", direction: -1 }
];
function paneLimits(control: typeof paneControls[number]) {
  const min = parseFloat(getComputedStyle(control.pane).minWidth);
  const workspaceMin = parseFloat(getComputedStyle(element("tree-workspace")).minWidth);
  const handles = paneControls.reduce((sum, item) => sum + item.splitter.getBoundingClientRect().width, 0);
  return { min, max: Math.max(min, mainLayout.clientWidth - control.other.getBoundingClientRect().width - workspaceMin - handles) };
}
function updatePaneValues() {
  for (const control of paneControls) {
    const limits = paneLimits(control);
    control.splitter.setAttribute("aria-valuemin", String(limits.min));
    control.splitter.setAttribute("aria-valuemax", String(Math.round(limits.max)));
    control.splitter.setAttribute("aria-valuenow", String(Math.round(control.pane.getBoundingClientRect().width)));
  }
}
function setPaneWidth(control: typeof paneControls[number], width: number) {
  const limits = paneLimits(control);
  mainLayout.style.setProperty(control.variable, `${Math.max(limits.min, Math.min(limits.max, width))}px`);
  updatePaneValues();
}
for (const control of paneControls) {
  const { splitter } = control;
  let resize: { pointerId: number; x: number; width: number } | null = null;
  const finish = () => {
    const pointerId = resize?.pointerId;
    resize = null;
    splitter.classList.remove("dragging");
    document.body.classList.remove("resizing-panes");
    if (pointerId !== undefined && splitter.hasPointerCapture(pointerId)) splitter.releasePointerCapture(pointerId);
  };
  splitter.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    splitter.focus({ preventScroll: true });
    resize = { pointerId: e.pointerId, x: e.clientX, width: control.pane.getBoundingClientRect().width };
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-panes");
  });
  splitter.addEventListener("pointermove", e => {
    if (resize?.pointerId === e.pointerId) setPaneWidth(control, resize.width + (e.clientX - resize.x) * control.direction);
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) splitter.addEventListener(event, finish);
  splitter.addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const limits = paneLimits(control), step = e.shiftKey ? 50 : 10;
    const width = e.key === "Home" ? limits.min : e.key === "End" ? limits.max
      : control.pane.getBoundingClientRect().width + (e.key === "ArrowRight" ? step : -step) * control.direction;
    setPaneWidth(control, width);
  });
}
new ResizeObserver(() => {
  for (const control of paneControls) {
    const width = control.pane.getBoundingClientRect().width, limits = paneLimits(control);
    if (width > limits.max || width < limits.min) setPaneWidth(control, width);
  }
  updatePaneValues();
}).observe(mainLayout);
updatePaneValues();
