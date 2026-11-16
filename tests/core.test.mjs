import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument, ImportError } from "../src/parsers.ts";
import { interpretTime, resolveTimeSource, makeTicks, ageX, treeAgeRange } from "../src/time.ts";
import { loadProject, saveProject, nodeCSV, defaultView } from "../src/project.ts";

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
const options = { autoMethod: false, method: "nodes", field: "age_mean", unit: "Ma", origin: "present", zeroAgeMa: 0, zeroAgePairMa: null, evidence: "Analysis uses Ma before present", rootedConfirmed: false };

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
  const content = readFileSync(new URL("../examples/dated-mrbayes.nex", import.meta.url), "utf8");
  const tree = parseDocument(content).trees[0];
  assert.deepEqual(tree.nodes.filter(n => n.annotations.age_mean !== undefined).map(n => n.id), [tree.rootId]);
  assert.equal(interpretTime(tree, options).valid, false);
  const result = interpretTime(tree, { ...options, method: "branches" });
  assert.equal(result.valid, true);
  assert.deepEqual(tree.nodes.map(n => result.ages[n.id]), [100, 50, 20, 0, 66, 35, 0]);
  assert.equal(result.sources[tree.rootId], "explicit:age_mean");
  for (const n of tree.nodes.filter(n => n.id !== tree.rootId)) assert.match(result.sources[n.id], /^derived:time-length/);
});

test("automatic source selection prefers complete ages, derives missing ones and honors manual overrides", () => {
  const complete = parseDocument("[&R](A[&age_mean=0]:1,B[&age_mean=20]:1)[&age_mean=100];").trees[0];
  const preferred = resolveTimeSource(complete, { ...options, autoMethod: true, method: "branches" });
  assert.equal(preferred.options.method, "nodes");
  assert.equal(preferred.result.valid, true);
  const partial = parseDocument("[&R](A:100,B:80)[&age_mean=100];").trees[0];
  const derived = resolveTimeSource(partial, { ...options, autoMethod: true });
  assert.equal(derived.options.method, "branches");
  assert.equal(derived.result.valid, true);
  assert.deepEqual(partial.nodes.map(n => derived.result.ages[n.id]), [100, 0, 20]);
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
  const content = readFileSync(new URL("../examples/trilobites-tip-date.nex.con.tre", import.meta.url), "utf8");
  const doc = parseDocument(content, "trilobites-tip-date.nex.con.tre");
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
  const view = { ...defaultView(), mode: "time" };
  const restored = loadProject(saveProject(doc, 0, shiftedOptions, view));
  assert.equal(restored.options.zeroAgeMa, 380);
  assert.equal(interpretTime(restored.doc.trees[0], restored.options).ages[phacops.id], 380);
  assert.equal(restored.doc.content, content);
  const csv = nodeCSV(tree, shifted, shiftedOptions);
  assert.match(csv, /zero_age_Ma/);
  assert.match(csv, /zero=380 Ma/);
});

test("two origin values shift the whole tree by their arithmetic midpoint regardless of input order", () => {
  const doc = parseDocument("[&R](A:50,B:100)[&age_mean=100,age_95%HPD={90,110}];");
  const tree = doc.trees[0], original = JSON.stringify(tree);
  const opts = { ...options, method: "branches", zeroAgePairMa: [385, 398] };
  const shifted = interpretTime(tree, opts);
  assert.equal(shifted.valid, true);
  assert.deepEqual(tree.nodes.map(n => shifted.ages[n.id]), [491.5, 441.5, 391.5]);
  assert.deepEqual(shifted.intervals[tree.rootId], [{ key: "age_95%HPD", lower: 481.5, upper: 501.5, type: "HPD" }]);
  assert.deepEqual(interpretTime(tree, { ...opts, zeroAgePairMa: [398, 385] }).ages, shifted.ages);
  assert.deepEqual(interpretTime(tree, { ...opts, zeroAgePairMa: [390, 390] }).ages,
    interpretTime(tree, { ...options, method: "branches", zeroAgeMa: 390 }).ages);
  assert.equal(interpretTime(tree, { ...opts, zeroAgePairMa: [0, 0] }).ages[tree.rootId], 100);
  assert.equal(JSON.stringify(tree), original);
  const restored = loadProject(saveProject(doc, 0, opts, defaultView()));
  assert.equal(restored.options.zeroAgeMa, 391.5);
  assert.deepEqual(restored.options.zeroAgePairMa, [385, 398]);
  assert.deepEqual(interpretTime(restored.doc.trees[0], restored.options).ages, shifted.ages);
  const csv = nodeCSV(tree, shifted, opts);
  assert.match(csv, /zero_age_pair_Ma/);
  assert.match(csv, /391\.5/);
  assert.doesNotMatch(csv, /envelopes|origin_only_range/);
  for (const pair of [[], [385], [385, 398, 400], ["385", 398], [-1, 398], [NaN, 398], [Infinity, 398], [1e16, 398]]) {
    assert.equal(interpretTime(tree, { ...opts, zeroAgePairMa: pair }).valid, false);
    assert.throws(() => loadProject(saveProject(doc, 0, { ...opts, zeroAgePairMa: pair }, defaultView())), /兩個數值無效/);
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
  const view = defaultView();
  view.collapsed = [doc.trees[0].nodes[1].id];
  view.gridStep = 10;
  const saved = saveProject(doc, 0, options, view);
  const loaded = loadProject(saved);
  assert.equal(loaded.doc.content, nexus);
  assert.deepEqual(loaded.doc.trees, doc.trees);
  assert.deepEqual(loaded.options, options);
  assert.deepEqual(loaded.view, view);
  const legacy = JSON.parse(saved);
  legacy.options.confirmed = false;
  delete legacy.options.autoMethod;
  delete legacy.options.zeroAgeMa;
  delete legacy.options.zeroAgePairMa;
  delete legacy.view.autoRange;
  delete legacy.view.rootStyle;
  delete legacy.view.rootStem;
  assert.equal(loadProject(JSON.stringify(legacy)).options.zeroAgeMa, 0);
  assert.equal(loadProject(JSON.stringify(legacy)).view.autoRange, false);
  assert.equal(loadProject(JSON.stringify(legacy)).view.rootStyle, "hollow");
  assert.equal(loadProject(JSON.stringify(legacy)).view.rootStem, false);
  assert.equal(loadProject(saveProject(doc, 0, options, { ...view, rootStem: true })).view.rootStem, true);
  assert.equal(loadProject(saveProject(doc, 0, options, { ...view, rootStyle: "hollow" })).view.rootStyle, "hollow");
  assert.deepEqual(loadProject(JSON.stringify(legacy)).options, options);
  const automatic = loadProject(saveProject(doc, 0, { ...options, autoMethod: true }, view));
  assert.equal(automatic.options.autoMethod, true);
  const ranged = JSON.parse(saved);
  ranged.options.zeroAgeRangeMa = [385, 398];
  assert.throws(() => loadProject(JSON.stringify(ranged)), /僅支援固定原點年代/);
  ranged.options.zeroAgeRangeMa = null;
  assert.deepEqual(loadProject(JSON.stringify(ranged)).options, options);
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
  bad.schemaVersion = 2;
  assert.throws(() => loadProject(JSON.stringify(bad)), /版本/);
  bad.schemaVersion = 1;
  bad.view.fontSize = -100;
  assert.throws(() => loadProject(JSON.stringify(bad)), /設定/);
});

test("CSV preserves provenance and protects spreadsheet formulas", () => {
  const doc = parseDocument("[&R]('=2+2'[&age_mean=0],B[&age_mean=20])[&age_mean=100];", "input.tre");
  const csv = nodeCSV(doc.trees[0], interpretTime(doc.trees[0], options), options);
  assert.match(csv, /'=2\+2/);
  assert.match(csv, /Analysis uses Ma/);
  assert.match(csv, /age_mean/);
  assert.match(csv, /parent_id/);
});
