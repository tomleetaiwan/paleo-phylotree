import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument, ImportError } from "../src/parsers.ts";
import { classifyTree, interpretTime, resolveTimeSource, makeTicks, ageX, treeAgeRange } from "../src/time.ts";
import { loadProject, saveProject, nodeCSV, defaultView, defaultTime } from "../src/project.ts";
import { createTranslator, locales, resolveLocale, setLocale } from "../src/i18n.ts";

setLocale("zh-Hant");

test("locale selection uses only the browser's primary language with English fallback", () => {
  for (const language of ["zh", "zh-TW", "zh-HK", "zh-CN", "zh-Hans", "ZH_hant_TW"]) {
    assert.equal(resolveLocale([language]), "zh-Hant", language);
  }
  for (const language of ["en-US", "fr-FR", "ja-JP", "de", "zhx", ""]) {
    assert.equal(resolveLocale([language]), "en", language);
  }
  assert.equal(resolveLocale(["en-US", "zh-TW"]), "en");
  assert.equal(resolveLocale(["fr-FR", "zh-TW"]), "en");
  assert.equal(resolveLocale([], "zh-TW"), "zh-Hant");
  assert.equal(resolveLocale([]), "en");
});

test("translation catalogs cover the same parameters and never translate inserted research data", () => {
  const placeholders = value => [...value.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(locales.en.messages)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.ok(value.trim());
  }
  const english = createTranslator("en"), chinese = createTranslator("zh-Hant");
  assert.equal(english("已載入範例：{0}。", "原始名稱 {1} <script>"), "Example loaded: 原始名稱 {1} <script>.");
  assert.equal(chinese("已載入範例：{0}。", "Phylogram"), "已載入範例：Phylogram。");
  assert.throws(() => english("已載入範例：{0}。"), /Missing translation argument/);
});

const nexus = `#NEXUS
begin trees;
translate 1 'Fossil, one', 2 'Taxon ''two''', 3 Recent;
tree * consensus = [&R]
 ((1[&age_mean=20,age_95%HPD={18,22},prob=9.5e-1]:30,
 2[&age_mean=0]:50)[&age_mean=50]:50,3[&age_mean=0]:100)[&age_mean=100];
tree other = [&U] (1:1,3:1);
end;
begin trees;
translate 1 Different,2 Other;
tree third = [&R] (1:1,2:1);
end;`;
const options = { autoMethod: false, method: "nodes", field: "age_mean", unit: "Ma", origin: "present", zeroAgeMa: 0, zeroAgePairMa: null, evidence: "Analysis uses Ma before present", rootedConfirmed: false, branchTimeConfirmed: true };

test("NEXUS trees, scoped TRANSLATE, escaped names and numeric arrays", () => {
  const doc = parseDocument(nexus, "result.con.tre");
  assert.equal(doc.trees.length, 3);
  assert.equal(doc.trees[0].rooted, true);
  assert.equal(doc.trees[1].rooted, false);
  assert.equal(doc.trees[0].nodes[2].name, "Fossil, one");
  assert.equal(doc.trees[0].nodes[3].name, "Taxon 'two'");
  assert.equal(doc.trees[2].nodes[1].name, "Different");
  assert.deepEqual(doc.trees[0].nodes[2].annotations["age_95%HPD"], [18, 22]);
  assert.equal(doc.trees[0].nodes[2].annotations.prob, 0.95);
  assert.deepEqual(parseDocument(nexus, "result.nex").trees, doc.trees);
});

test("ordinary NEXUS comments may contain apostrophes and nested brackets", () => {
  const doc = parseDocument("#NEXUS [This taxon's data [nested]] begin trees; tree x=[&R](A,B); end;");
  assert.equal(doc.trees[0].nodes.length, 3);
  assert.equal(doc.trees[0].rooted, true);
});

test("explicit ages override substitution lengths without changing input", () => {
  const tree = parseDocument(nexus).trees[0];
  const original = JSON.stringify(tree);
  const result = interpretTime(tree, options);
  assert.equal(result.valid, true);
  assert.deepEqual(tree.nodes.map(n => result.ages[n.id]), [100, 50, 20, 0, 0]);
  assert.equal(tree.nodes[2].length, 30);
  assert.equal(JSON.stringify(tree), original);
});

test("time branches use an existing anchor and ignore root stem", () => {
  const tree = parseDocument("[&R]((A:50,B:30):50,C:100)[&age_mean=100]:999;").trees[0];
  const result = interpretTime(tree, { ...options, method: "branches" });
  assert.equal(result.valid, true);
  assert.deepEqual(tree.nodes.map(n => result.ages[n.id]), [100, 50, 0, 20, 0]);
});

test("bundled time-branch example derives ages from its sole root anchor", () => {
  const content = readFileSync(new URL("../examples/chronogram.nex", import.meta.url), "utf8");
  const tree = parseDocument(content).trees[0];
  assert.deepEqual(tree.nodes.filter(n => n.annotations.age_mean !== undefined).map(n => n.id), [tree.rootId]);
  assert.equal(interpretTime(tree, options).valid, false);
  const result = interpretTime(tree, { ...options, method: "branches" });
  assert.equal(result.valid, true);
  assert.equal(result.ages[tree.rootId], 100);
  assert.deepEqual(tree.nodes.filter(n => !n.children.length).map(n => result.ages[n.id]),
    [20, 0, 35, 0, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
  assert.equal(result.sources[tree.rootId], "explicit:age_mean");
  for (const n of tree.nodes.filter(n => n.id !== tree.rootId)) assert.match(result.sources[n.id], /^derived:time-length/);
});

test("automatic source selection prefers complete ages, derives missing ones and honors manual overrides", () => {
  const complete = parseDocument("[&R](A[&age_mean=0]:1,B[&age_mean=20]:1)[&age_mean=100];").trees[0];
  const preferred = resolveTimeSource(complete, { ...options, autoMethod: true, method: "branches" });
  assert.equal(preferred.options.method, "nodes");
  assert.equal(preferred.result.valid, true);
  const partial = parseDocument("[&R]((A:50,B:30):50,C:100)[&age_mean=100];").trees[0];
  const derived = resolveTimeSource(partial, { ...options, autoMethod: true });
  assert.equal(derived.options.method, "branches");
  assert.equal(derived.result.valid, true);
  assert.deepEqual(partial.nodes.map(n => derived.result.ages[n.id]), [100, 50, 0, 20, 0]);
  const missing = resolveTimeSource(parseDocument("[&R](A:1,B:1);").trees[0], { ...options, autoMethod: true });
  assert.equal(missing.result.valid, false);
  const manual = resolveTimeSource(complete, { ...options, method: "branches" });
  assert.equal(manual.options.method, "branches");
  assert.equal(manual.result.valid, false);
  assert.equal(resolveTimeSource(partial, options).result.valid, false);
});

test("branch durations can propagate from a fossil anchor upward", () => {
  const tree = parseDocument("[&R]((A:50,B[&age_mean=20]:30):50,C:100);").trees[0];
  const result = interpretTime(tree, { ...options, method: "branches" });
  assert.deepEqual(tree.nodes.map(n => result.ages[n.id]), [100, 50, 0, 20, 0]);
});

test("reject unknown root and missing ages instead of inventing Ma", () => {
  const tree = parseDocument("((A:50,B:30):50,C:100);").trees[0];
  for (const opts of [options, { ...options, method: "branches" }]) {
    assert.equal(interpretTime(tree, opts).valid, false);
  }
  const height = parseDocument("[&R](A[&height_mean=0],B[&height_mean=0])[&height_mean=10];").trees[0];
  assert.equal(interpretTime(height, options).valid, false);
});

test("optional notes do not gate ages, but unknown and explicit unrooted trees still do", () => {
  const text = "(A[&age_mean=0],B[&age_mean=20])[&age_mean=100];";
  const opts = { ...options, evidence: "" };
  assert.equal(interpretTime(parseDocument("[&R]" + text).trees[0], opts).valid, true);
  assert.equal(interpretTime(parseDocument(text).trees[0], opts).valid, false);
  assert.equal(interpretTime(parseDocument(text).trees[0], { ...opts, rootedConfirmed: true }).valid, true);
  assert.equal(interpretTime(parseDocument("[&U]" + text).trees[0], { ...opts, rootedConfirmed: true }).valid, false);
});

test("invalid ages, chronology and conflicting anchors block time mode", () => {
  for (const text of [
    "[&R](A[&age_mean=50]:1,B[&age_mean=0]:1)[&age_mean=40];",
    "[&R](A[&age_mean=-1],B[&age_mean=0])[&age_mean=40];",
    "[&R](A[&age_mean=NaN],B[&age_mean=0])[&age_mean=40];"
  ]) assert.equal(interpretTime(parseDocument(text).trees[0], options).valid, false);
  const conflict = parseDocument("[&R](A[&age_mean=0]:30,B:50)[&age_mean=100];").trees[0];
  assert.equal(interpretTime(conflict, { ...options, method: "branches" }).valid, false);
});

test("unit conversions preserve numeric precision and interval types", () => {
  const tree = parseDocument("[&R](A[&age_mean=0],B[&age_mean=20000000])[&age_mean=100000000,age_95%HPD={90000000,110000000}];").trees[0];
  const result = interpretTime(tree, { ...options, unit: "years" });
  assert.equal(result.valid, true);
  assert.equal(result.ages[tree.rootId], 100);
  assert.deepEqual(result.intervals[tree.rootId][0], { key: "age_95%HPD", lower: 90, upper: 110, type: "HPD" });
});

test("fossil zero shifts supplied MrBayes ages and intervals, not input or branch lengths", () => {
  const content = readFileSync(new URL("../examples/dated-tree.nex", import.meta.url), "utf8");
  const doc = parseDocument(content, "dated-tree.nex");
  const tree = doc.trees[0], original = JSON.stringify(tree);
  const base = interpretTime(tree, options);
  const shiftedOptions = { ...options, zeroAgeMa: 380 };
  const shifted = interpretTime(tree, shiftedOptions);
  assert.equal(shifted.valid, true);
  const phacops = tree.nodes.find(n => n.name === "Phacops");
  assert.equal(shifted.ages[phacops.id], 380);
  assert.equal(shifted.ages[tree.rootId], 495.341211);
  for (const n of tree.nodes) {
    assert.equal(shifted.ages[n.id], base.ages[n.id] + 380);
    for (let i = 0; i < base.intervals[n.id].length; i++) {
      assert.equal(shifted.intervals[n.id][i].lower, base.intervals[n.id][i].lower + 380);
      assert.equal(shifted.intervals[n.id][i].upper, base.intervals[n.id][i].upper + 380);
    }
  }
  assert.equal(JSON.stringify(tree), original);
  const view = { ...defaultView(), mode: "dated" };
  const restored = loadProject(saveProject(doc, 0, shiftedOptions, view));
  assert.equal(restored.options.zeroAgeMa, 380);
  assert.equal(interpretTime(restored.doc.trees[0], restored.options).ages[phacops.id], 380);
  assert.equal(restored.doc.content, content);
  const csv = nodeCSV(tree, shifted, shiftedOptions, "dated");
  assert.match(csv, /zero_age_Ma/);
  assert.match(csv, /zero=380 Ma/);
});

test("two origin values shift the whole tree by their arithmetic midpoint regardless of input order", () => {
  const doc = parseDocument("[&R](A:50,B:100)[&age_mean=100,age_95%HPD={90,110}];");
  const tree = doc.trees[0], original = JSON.stringify(tree);
  const opts = { ...options, method: "branches", zeroAgeMa: 391.5, zeroAgePairMa: [385, 398] };
  const shifted = interpretTime(tree, opts);
  assert.equal(shifted.valid, true);
  assert.deepEqual(tree.nodes.map(n => shifted.ages[n.id]), [491.5, 441.5, 391.5]);
  assert.deepEqual(shifted.intervals[tree.rootId], [{ key: "age_95%HPD", lower: 481.5, upper: 501.5, type: "HPD" }]);
  assert.deepEqual(interpretTime(tree, { ...opts, zeroAgePairMa: [398, 385] }).ages, shifted.ages);
  assert.deepEqual(interpretTime(tree, { ...opts, zeroAgePairMa: [390, 390] }).ages,
    interpretTime(tree, { ...options, method: "branches", zeroAgeMa: 390 }).ages);
  assert.equal(interpretTime(tree, { ...opts, zeroAgePairMa: [0, 0] }).ages[tree.rootId], 100);
  assert.equal(JSON.stringify(tree), original);
  const restored = loadProject(saveProject(doc, 0, opts, { ...defaultView(), mode: "chronogram" }));
  assert.equal(restored.options.zeroAgeMa, 391.5);
  assert.deepEqual(restored.options.zeroAgePairMa, [385, 398]);
  assert.deepEqual(interpretTime(restored.doc.trees[0], restored.options).ages, shifted.ages);
  const csv = nodeCSV(tree, shifted, opts, "chronogram");
  assert.match(csv, /zero_age_pair_Ma/);
  assert.match(csv, /391\.5/);
  assert.doesNotMatch(csv, /envelopes|origin_only_range/);
  for (const pair of [[], [385], [385, 398, 400], ["385", 398], [-1, 398], [NaN, 398], [Infinity, 398], [1e16, 398]]) {
    assert.equal(interpretTime(tree, { ...opts, zeroAgePairMa: pair }).valid, false);
    assert.throws(() => loadProject(saveProject(doc, 0, { ...opts, zeroAgePairMa: pair }, defaultView())), /兩個端點無效/);
  }
});

test("zero offset is always Ma, applied after unit conversion and branch inference", () => {
  const tree = parseDocument("[&R](A:50000000,B:30000000)[&age_mean=50000000];").trees[0];
  const shifted = interpretTime(tree, { ...options, method: "branches", unit: "years", zeroAgeMa: 380 });
  assert.equal(shifted.valid, true);
  assert.deepEqual(tree.nodes.map(n => shifted.ages[n.id]), [430, 380, 400]);
  const negative = parseDocument("[&R](A:60,B:30)[&age_mean=50];").trees[0];
  assert.equal(interpretTime(negative, { ...options, method: "branches", zeroAgeMa: 380 }).valid, false);
  for (const offset of [-1, NaN, Infinity, null, 1e16]) {
    assert.equal(interpretTime(tree, { ...options, zeroAgeMa: offset }).valid, false);
  }
});

test("ticks and coordinates have a common scale, unique labels and no negative zero", () => {
  assert.deepEqual(makeTicks(100, 0, 10), [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]);
  assert.equal(ageX(50, 100, 0, 0, 1000), 500);
  assert.equal(ageX(20, 100, 0, 0, 1000), 800);
  assert.equal(ageX(20, 100, 0, 75, 1200), 1035);
  const large = makeTicks(1e15, 1e15 - 10, 0.5);
  assert.equal(large.length, 21);
  assert.equal(new Set(large).size, 21);
  assert.deepEqual(makeTicks(0.5, 0, 0.1), [0.5, 0.4, 0.3, 0.2, 0.1, 0]);
  assert.throws(() => makeTicks(100, 0, 0.00001), /刻度/);
  assert.throws(() => makeTicks(1, 1, 1), /範圍/);
});

test("automatic time range fits fossil ages without forcing the present", () => {
  const range = treeAgeRange([500, 499, 480, 385]);
  assert.deepEqual(range, { older: 505.75, younger: 379.25 });
  assert.ok((500 - 385) / (range.older - range.younger) > 0.9);
  assert.equal(treeAgeRange([100, 20, 0]).younger, 0);
  const same = treeAgeRange([385, 385]);
  assert.ok(same.older > 385 && same.younger < 385);
  const zero = treeAgeRange([0]);
  assert.ok(zero.older > zero.younger);
  assert.throws(() => treeAgeRange([]), /無效年代/);
  assert.throws(() => treeAgeRange([NaN]), /無效年代/);
});

test("Newick, HyPhy and NHX retain names, raw annotations and duplicate IDs", () => {
  const tree = parseDocument("('A;one'{Foreground}:1e-3,A[&&NHX:S=fish:D=Y]:0,A:0)0.9;").trees[0];
  assert.equal(tree.nodes[1].name, "A;one");
  assert.equal(tree.nodes[1].annotations.hyphy, "Foreground");
  assert.equal(tree.nodes[2].annotations.S, "fish");
  assert.equal(tree.nodes[1].length, 0.001);
  assert.equal(new Set(tree.nodes.map(n => n.id)).size, 4);
  assert.match(tree.warnings.join(" "), /重複/);
  assert.equal(tree.nodes[0].support, 0.9);
});

test("reject malformed inputs, DATA-only and missing translations", () => {
  for (const input of [
    "((A,B);", "(A:invalid,B);", "(A:-2,B);", "(A,,B);", "(A,B)", "(A,B); garbage;",
    "#NEXUS begin data; matrix A 01; end;", "#NEXUS begin trees; tree x=(A,B);",
    "#NEXUS begin trees; translate 1 A; tree x=(1,2); end;",
    "(A[&x={1,2],B);"
  ]) assert.throws(() => parseDocument(input), ImportError, input);
});

test("import limits prevent oversized, too deep and too many tips", () => {
  assert.throws(() => parseDocument(" ".repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
  assert.throws(() => parseDocument("(".repeat(514) + "A" + ",B)".repeat(514) + ";"), /深度/);
  assert.throws(() => parseDocument(`(${Array.from({ length: 1001 }, (_, i) => `T${i}`).join(",")});`), /1,000/);
  assert.throws(() => parseDocument("(A,B);".repeat(101)), /100 棵/);
});

test("project round trip validates versions, settings and stable IDs", () => {
  const doc = parseDocument(nexus, "original.nex");
  const view = { ...defaultView(), mode: "dated" };
  view.collapsed = [doc.trees[0].nodes[1].id];
  view.gridStep = 10;
  const saved = saveProject(doc, 0, options, view);
  const loaded = loadProject(saved);
  assert.equal(loaded.doc.content, nexus);
  assert.deepEqual(loaded.doc.trees, doc.trees);
  assert.deepEqual(loaded.options, options);
  assert.deepEqual(loaded.view, view);
  const hiddenLabels = { ...view, treeName: false, ageRange: false };
  assert.deepEqual(loadProject(saveProject(doc, 0, options, hiddenLabels)).view, hiddenLabels);
  const legacyLabels = JSON.parse(saved);
  delete legacyLabels.view.treeName;
  delete legacyLabels.view.ageRange;
  assert.deepEqual(loadProject(JSON.stringify(legacyLabels)).view, view);
  for (const key of ["treeName", "ageRange"]) {
    for (const value of ["false", null, 0]) {
      const invalid = JSON.parse(saved);
      invalid.view[key] = value;
      assert.throws(() => loadProject(JSON.stringify(invalid)), /圖形設定/);
    }
  }
  for (const [section, keys] of [
    ["options", ["autoMethod", "zeroAgeMa", "zeroAgePairMa"]],
    ["view", ["autoRange", "rootStyle", "rootStem"]]
  ]) {
    for (const key of keys) {
      const incomplete = JSON.parse(saved);
      delete incomplete[section][key];
      assert.throws(() => loadProject(JSON.stringify(incomplete)), /無效/);
    }
  }
  assert.equal(loadProject(saveProject(doc, 0, options, { ...view, rootStem: true })).view.rootStem, true);
  assert.equal(loadProject(saveProject(doc, 0, options, { ...view, rootStyle: "hollow" })).view.rootStyle, "hollow");
  const automatic = loadProject(saveProject(doc, 0, { ...options, autoMethod: true }, view));
  assert.equal(automatic.options.autoMethod, true);
  const inconsistent = JSON.parse(saved);
  inconsistent.options.zeroAgePairMa = [385, 398];
  assert.throws(() => loadProject(JSON.stringify(inconsistent)), /中點不一致/);
  for (const unit of ["ka", "years"]) {
    const nonMa = JSON.parse(saved);
    nonMa.options.unit = unit;
    assert.throws(() => loadProject(JSON.stringify(nonMa)), /固定使用 Ma/);
  }
  for (const value of ["auto", null, 1]) {
    const invalid = JSON.parse(saved);
    invalid.options.autoMethod = value;
    assert.throws(() => loadProject(JSON.stringify(invalid)), /年代設定/);
  }
  for (const value of ["square", null, 1]) {
    const invalid = JSON.parse(saved);
    invalid.view.rootStyle = value;
    assert.throws(() => loadProject(JSON.stringify(invalid)), /圖形設定/);
  }
  for (const value of ["true", null, 1]) {
    const invalid = JSON.parse(saved);
    invalid.view.rootStem = value;
    assert.throws(() => loadProject(JSON.stringify(invalid)), /圖形設定/);
  }
  for (const offset of [-1, null, "380", 1e16]) {
    const invalid = JSON.parse(saved);
    invalid.options.zeroAgeMa = offset;
    assert.throws(() => loadProject(JSON.stringify(invalid)), /年代設定/);
  }
  const bad = JSON.parse(saved);
  bad.schemaVersion = 1;
  assert.throws(() => loadProject(JSON.stringify(bad)), /版本/);
  bad.schemaVersion = 3;
  bad.view.fontSize = -100;
  assert.throws(() => loadProject(JSON.stringify(bad)), /設定/);
});

test("CSV preserves provenance and protects spreadsheet formulas", () => {
  const doc = parseDocument("[&R]('=2+2'[&age_mean=0],B[&age_mean=20])[&age_mean=100];", "input.tre");
  const csv = nodeCSV(doc.trees[0], interpretTime(doc.trees[0], options), options, "dated");
  assert.match(csv, /'=2\+2/);
  assert.match(csv, /Analysis uses Ma/);
  assert.match(csv, /age_mean/);
  assert.match(csv, /parent_id/);
});

test("all five renamed examples classify automatically and round trip without changing source", () => {
  for (const [filename, mode] of [
    ["dated-tree", "dated"], ["chronogram", "chronogram"], ["relative-chronogram", "relative"],
    ["phylogram", "phylogram"], ["cladogram", "cladogram"]
  ]) {
    const content = readFileSync(new URL(`../examples/${filename}.nex`, import.meta.url), "utf8");
    const doc = parseDocument(content, `${filename}.nex`), tree = doc.trees[0];
    const original = JSON.stringify(tree);
    const classified = classifyTree(tree, defaultTime());
    assert.equal(classified.mode, mode, filename);
    const restored = loadProject(saveProject(doc, 0, classified.options, { ...defaultView(), mode }));
    assert.equal(restored.view.mode, mode);
    assert.equal(restored.doc.content, content);
    const csv = nodeCSV(tree, classified.result, classified.options, mode);
    const [headers, ...rows] = csv.slice(1).split("\r\n").map(line =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
    for (const row of rows) {
      assert.equal(row.length, headers.length);
      assert.equal(row[headers.indexOf("mode")], mode);
      assert.equal(row[headers.indexOf("plot_age_Ma")] !== "", mode === "dated" || mode === "chronogram");
      assert.equal(row[headers.indexOf("relative_time")] !== "", mode === "relative");
    }
    if (mode === "relative") {
      assert.equal(Number(rows[0][headers.indexOf("relative_time")]), 0);
      assert.deepEqual(rows.filter(row => row[headers.indexOf("is_tip")] === "true")
        .map(row => Number(row[headers.indexOf("relative_time")])), Array(15).fill(30));
    }
    assert.equal(JSON.stringify(tree), original);
  }
});

test("four synthetic examples share exactly 15 OTU names and a strictly binary topology", () => {
  const expectedNames = Array.from({ length: 15 }, (_, i) => `OTU${String(i + 1).padStart(2, "0")}`);
  let topology;
  for (const filename of ["chronogram", "relative-chronogram", "phylogram", "cladogram"]) {
    const tree = parseDocument(readFileSync(new URL(`../examples/${filename}.nex`, import.meta.url), "utf8")).trees[0];
    assert.deepEqual(tree.nodes.filter(n => !n.children.length).map(n => n.name), expectedNames, filename);
    assert.equal(tree.nodes.length, 29, filename);
    for (const node of tree.nodes.filter(n => n.children.length)) assert.equal(node.children.length, 2, `${filename}: ${node.id}`);
    const structure = tree.nodes.map(n => ({ name: n.name, parentId: n.parentId, children: n.children }));
    topology ??= structure;
    assert.deepEqual(structure, topology, filename);
  }
});

test("relative and phylogram examples provide synthetic probabilities above 85 percent on every internal node", () => {
  for (const filename of ["relative-chronogram", "phylogram"]) {
    const tree = parseDocument(readFileSync(new URL(`../examples/${filename}.nex`, import.meta.url), "utf8")).trees[0];
    const internal = tree.nodes.filter(n => n.children.length);
    assert.equal(internal.length, 14);
    for (const node of internal) {
      assert.equal(typeof node.annotations.prob, "number");
      assert.ok(node.annotations.prob > 0.85 && node.annotations.prob <= 1, `${filename}: ${node.id}`);
      assert.equal(node.support, node.annotations.prob);
    }
  }
});

test("classification requires explicit time evidence, not ultrametric shape or an age anchor alone", () => {
  const classify = (text, opts = {}) => classifyTree(parseDocument(text).trees[0], { ...defaultTime(), ...opts });
  assert.equal(classify("[&R]((A:10,B:10):20,C:30);").mode, "phylogram");
  assert.equal(classify("[&R]((A:10,B:10):20,C:30);", { branchTimeConfirmed: true }).mode, "relative");
  assert.equal(classify("[&R]((A:10,B:10):20,C:30)[&root_age=100];").mode, "phylogram");
  for (const anchor of ["root_age=100", "node_age=100", "calibration_age=100", "age_mean=100"]) {
    const c = classify(`[&R]((A:10,B:10):20,C:30)[&branch_length_unit=Ma,${anchor}];`);
    assert.equal(c.mode, "chronogram");
    assert.deepEqual(Object.values(c.result.ages).sort((a, b) => b - a), [100, 80, 70, 70, 70]);
  }
  assert.equal(classify("[&R]((A[&tip_age=70]:10,B:10):20,C:30)[&branch_length_unit=Ma];").mode, "chronogram");
  for (const text of [
    "[&R]((A:10,B:10):20,C:30)[&branch_length_unit=Ma,root_age=-1];",
    "[&R]((A:10,B:10):20,C:30)[&branch_length_unit=Ma,age_mean={90,110}];",
    "[&R]((A:10,B:10):20,C:30)[&branch_length_unit=Ma,root_age=100,calibration_age=110];",
    "[&R]((A:10,B:10):20,C:30)[&branch_length_unit=Ma,calibration_age={90,110}];",
    "[&R]((A:10,B):20,C:30)[&branch_length_unit=relative_time];",
    "[&U]((A:10,B:10):20,C:30)[&branch_length_unit=relative_time];"
  ]) assert.equal(classify(text).mode, "phylogram", text);
  assert.equal(classify("[&R](A:0,B:0);").mode, "phylogram");
  assert.equal(classify("[&R](A:1,B);").mode, "phylogram");
  assert.equal(classify("[&R](A,B):999;").mode, "cladogram");
});

test("Dated Tree validates internal ages, retains unknown tips and rejects chronology conflicts", () => {
  for (const field of ["age", "age_mean", "age_median", "height", "height_mean", "height_median"]) {
    const tree = parseDocument(`[&R]((A,B)[&${field}=385],C)[&${field}=420];`).trees[0];
    const c = classifyTree(tree, defaultTime());
    assert.equal(c.mode, "dated");
    assert.equal(Object.keys(c.result.ages).length, 2);
    assert.equal(c.result.ages[tree.nodes.find(n => n.name === "A").id], undefined);
    assert.match(c.result.warnings.join(" "), /末端年代未知/);
    const csv = nodeCSV(tree, c.result, c.options, c.mode);
    assert.doesNotMatch(csv, /NaN|undefined/);
  }
  for (const text of [
    "[&R]((A,B)[&age=430],C)[&age=420];",
    "[&R]((A,B)[&age=-1],C)[&age=420];",
    "[&R]((A,B),C)[&age=420];",
    "[&R]((A[&age=400],B)[&age=385],C)[&age=420];"
  ]) assert.equal(classifyTree(parseDocument(text).trees[0], defaultTime()).mode, "cladogram");
});

test("projects and CSV reject stale classifications, source mismatches and invalid ages", () => {
  const doc = parseDocument("[&R](A[&age_mean=0],B[&age_mean=20])[&age_mean=100];");
  const opts = { ...defaultTime(), autoMethod: false };
  const project = JSON.parse(saveProject(doc, 0, opts, { ...defaultView(), mode: "dated" }));
  for (const schemaVersion of [1, 2]) {
    assert.throws(() => loadProject(JSON.stringify({ ...project, schemaVersion })), /版本/);
  }
  for (const mode of ["topology", "nodes", "branches", "unknown"]) {
    assert.throws(() => loadProject(JSON.stringify({ ...project, view: { ...project.view, mode } })), /圖形設定無效/);
  }
  assert.throws(() => loadProject(JSON.stringify({ ...project, view: { ...project.view, mode: "chronogram" } })), /模式與年代來源不一致/);
  assert.throws(() => loadProject(JSON.stringify({ ...project, view: { ...project.view, mode: "cladogram" } })), /分類不一致/);
  assert.throws(() => loadProject(JSON.stringify({ ...project, options: { ...opts, field: "missing_age" } })), /年代檢核未通過/);
  const result = interpretTime(doc.trees[0], opts);
  assert.throws(() => nodeCSV(doc.trees[0], result, opts, "chronogram"), /有效的年代來源/);
  assert.throws(() => nodeCSV(doc.trees[0], { ...result, valid: false }, opts, "dated"), /有效的年代來源/);
});
