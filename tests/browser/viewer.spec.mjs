import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const url = pathToFileURL(resolve("dist", "paleo-phylotree.html")).href;
async function upload(page, name, text) {
  await page.locator("#file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
}
async function demoTime(page) {
  await page.locator("#demo").selectOption("synthetic");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
}
async function download(page, id, testInfo, name) {
  const pending = page.waitForEvent("download");
  await page.locator(`#${id}`).click();
  const item = await pending, file = testInfo.outputPath(name);
  expect(await item.failure()).toBeNull();
  await item.saveAs(file);
  return file;
}

test.beforeEach(async ({ page }) => {
  const errors = [], requests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.goto(url);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.locator("#style-settings > summary").click();
  await page.locator("#source-settings > summary").click();
  page.__errors = errors; page.__requests = requests;
});
test.afterEach(async ({ page }) => {
  expect(page.__errors).toEqual([]);
  expect(page.__requests).toEqual([]);
});

test("side panes resize independently by dragging and keyboard without changing the open tree", async ({ page }) => {
  await demoTime(page);
  const widths = () => page.evaluate(() => ({
    left: document.querySelector("#settings-pane").getBoundingClientRect().width,
    right: document.querySelector("#inspector-pane").getBoundingClientRect().width,
    center: document.querySelector("#tree-workspace").getBoundingClientRect().width
  }));
  const drag = async (id, delta) => {
    const b = await page.locator(id).boundingBox(), x = b.x + b.width / 2, y = b.y + 100;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 8 }); await page.mouse.up();
  };
  const ages = await page.locator("[data-age-label]").allTextContents();
  const initial = await widths();
  await drag("#resize-settings", 90);
  let actual = await widths();
  expect(actual.left).toBeCloseTo(initial.left + 90, 0);
  expect(actual.right).toBe(initial.right);
  await drag("#resize-inspector", -70);
  actual = await widths();
  expect(actual.right).toBeCloseTo(initial.right + 70, 0);
  expect(actual.left).toBeCloseTo(initial.left + 90, 0);
  const left = page.getByRole("separator", { name: "調整左側窗格寬度" });
  const right = page.getByRole("separator", { name: "調整右側窗格寬度" });
  await left.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await widths()).left).toBeCloseTo(actual.left - 10, 0);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await widths()).left).toBeCloseTo(actual.left + 40, 0);
  await page.keyboard.press("Home");
  await expect(left).toHaveAttribute("aria-valuenow", "220");
  await page.keyboard.press("ArrowLeft");
  expect((await widths()).left).toBe(220);
  await page.keyboard.press("End");
  actual = await widths();
  expect(actual.center).toBeCloseTo(500, 0);
  await expect(left).toHaveAttribute("aria-valuenow", await left.getAttribute("aria-valuemax"));
  await right.focus();
  await page.keyboard.press("Home");
  await expect(right).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("ArrowRight");
  expect((await widths()).right).toBe(200);
  await page.keyboard.press("End");
  expect((await widths()).center).toBeCloseTo(500, 0);
  expect(await page.locator("[data-age-label]").allTextContents()).toEqual(ages);
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator("body")).not.toHaveClass(/resizing-panes/);
});

test("pane resizing handles cancellation and clamps widths when the window shrinks", async ({ page }) => {
  const left = page.locator("#resize-settings"), right = page.locator("#resize-inspector");
  const b = await left.boundingBox(), y = b.y + 100;
  await page.mouse.move(b.x + b.width / 2, y); await page.mouse.down();
  await page.mouse.move(b.x + 120, y, { steps: 4 });
  await expect(page.locator("body")).toHaveClass(/resizing-panes/);
  await left.dispatchEvent("pointercancel", { pointerId: 1 });
  await expect(page.locator("body")).not.toHaveClass(/resizing-panes/);
  await page.mouse.up();
  const cancelledWidth = await left.getAttribute("aria-valuenow");
  await page.mouse.move(b.x + 200, y);
  await expect(left).toHaveAttribute("aria-valuenow", cancelledWidth);
  await left.focus(); await page.keyboard.press("End");
  for (const width of [960, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector("#main-layout").getBoundingClientRect();
      const settings = document.querySelector("#settings-pane").getBoundingClientRect();
      const inspector = document.querySelector("#inspector-pane").getBoundingClientRect();
      const center = document.querySelector("#tree-workspace").getBoundingClientRect();
      return settings.width >= 220 && inspector.width >= 200 && center.width >= 430 && inspector.right <= main.right + 1;
    })).toBe(true);
    for (const splitter of [left, right]) {
      const value = Number(await splitter.getAttribute("aria-valuenow"));
      expect(value).toBeGreaterThanOrEqual(Number(await splitter.getAttribute("aria-valuemin")));
      expect(value).toBeLessThanOrEqual(Number(await splitter.getAttribute("aria-valuemax")));
    }
  }
});

test("brand loads the supplied PNG embedded in the offline HTML", async ({ page }) => {
  const icon = page.locator("img.brand-icon");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("src", `data:image/png;base64,${(await readFile(resolve("src", "icon.png"))).toString("base64")}`);
  const loaded = await icon.evaluate(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  expect(loaded).toBe(true);
  await expect(page.locator(".brand")).not.toContainText("⌘");
});

test("example menu embeds both trees and resets settings when switching or reloading an example", async ({ page }, testInfo) => {
  await page.getByLabel("載入範例").selectOption("trilobites");
  await expect(page.locator("#file-summary")).toContainText("trilobites-tip-date.nex.con.tre");
  await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(9);
  await expect(page.locator("#zero-age")).toHaveValue("0");
  await expect(page.locator("#evidence")).toHaveValue("");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  const original = await readFile(await download(page, "original", testInfo, "example-trilobites.tre"), "utf8");
  expect(original).toBe(await readFile(resolve("examples", "trilobites-tip-date.nex.con.tre"), "utf8"));
  await page.locator("#zero-age").fill("385");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("385 Ma");
  await demoTime(page);
  await expect(page.locator("#file-summary")).toContainText("dated-mrbayes.nex");
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#source-status")).toContainText("已採用「時間枝長＋既有年代錨點」");
  await expect(page.locator("#method-nodes")).toContainText("目前不可用");
  await expect(page.locator("#method-branches")).toContainText("數值相容，單位待確認");
  await expect(page.locator("#diagnostics details")).toHaveCount(0);
  await expect(page.locator('[data-age-label="t0-n1"]')).toHaveText("50 Ma");
  await expect(page.locator('[data-age-label="t0-n2"]')).toHaveText("20 Ma");
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("66 Ma");
  await expect(page.locator('[data-age-label="t0-n5"]')).toHaveText("35 Ma");
  await expect(page.locator("#zero-age")).toHaveValue("0");
  await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(7);
  for (let i = 0; i < 2; i++) {
    await page.getByLabel("載入範例").selectOption("trilobites");
    await expect(page.locator("#mode-badge")).toHaveText("一般模式");
    await expect(page.locator("#method")).toHaveValue("auto");
    await expect(page.locator("#source-status")).toContainText("已採用「明確節點年代」");
    await expect(page.locator("#zero-age")).toHaveValue("0");
    await expect(page.locator("#demo")).toHaveValue("");
    await page.locator("#apply-time").click();
    await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("115.34 Ma");
  }
});

test("style settings start collapsed and toggle without changing the configured chart", async ({ page }) => {
  await page.reload();
  const summary = page.locator("#style-settings > summary");
  await expect(summary).toBeVisible();
  await expect(page.locator("#font-size")).toBeHidden();
  await demoTime(page);
  await expect(page.locator("#font-size")).toBeHidden();
  await summary.click();
  await page.locator("#font-size").fill("20");
  await page.locator("#font-size").press("Tab");
  const svg = await page.locator("#canvas svg").evaluate(el => el.outerHTML);
  await summary.click();
  await expect(page.locator("#font-size")).toBeHidden();
  expect(await page.locator("#canvas svg").evaluate(el => el.outerHTML)).toBe(svg);
  await summary.focus();
  await summary.press("Enter");
  await expect(page.locator("#font-size")).toBeVisible();
  await expect(page.locator("#font-size")).toHaveValue("20");
  expect(await page.locator("#canvas svg").evaluate(el => el.outerHTML)).toBe(svg);
});

test("root appearance changes only its marker and survives exports and project restore", async ({ page }, testInfo) => {
  await demoTime(page);
  const marker = page.locator('[data-node-id="t0-n0"] > circle').nth(1);
  await expect(page.locator("#root-style")).toHaveValue("hollow");
  await expect(marker).toHaveAttribute("fill", "#ffffff");
  await expect(page.locator('[data-node-id="t0-n1"] > circle').nth(1)).toHaveAttribute("fill", "#ffffff");
  const branches = await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML);
  const labels = await page.locator('[data-layer="labels"]').evaluate(el => el.outerHTML);
  for (const [style, fill] of [["hollow", "#ffffff"], ["solid", "#254b48"]]) {
    await page.locator("#root-style").selectOption(style);
    await expect(marker).toHaveAttribute("fill", fill);
    expect(await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML)).toBe(branches);
    expect(await page.locator('[data-layer="labels"]').evaluate(el => el.outerHTML)).toBe(labels);
    const svg = await readFile(await download(page, "svg", testInfo, `${style}.svg`), "utf8");
    const exportedFill = await page.evaluate(text => new DOMParser().parseFromString(text, "image/svg+xml")
      .querySelector('[data-node-id="t0-n0"] > circle:nth-of-type(2)').getAttribute("fill"), svg);
    expect(exportedFill).toBe(fill);
    const saved = await download(page, "save", testInfo, `${style}.json`);
    await page.reload();
    await page.locator("#file").setInputFiles(saved);
    await expect(page.locator("#root-style")).toHaveValue(style);
    await expect(marker).toHaveAttribute("fill", fill);
    await page.locator("#style-settings > summary").click();
  }
});

test("decorative root stem stays separate from time branches and persists with exports", async ({ page }, testInfo) => {
  await demoTime(page);
  const stem = page.locator('[data-layer="root-stem"] line');
  await expect(page.locator("#root-stem")).not.toBeChecked();
  await expect(stem).toHaveCount(0);
  const branches = await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML);
  const labels = await page.locator('[data-layer="labels"]').evaluate(el => el.outerHTML);
  await page.locator("#root-stem").check();
  await expect(stem).toHaveCount(1);
  await expect(stem).toHaveAttribute("stroke-dasharray", "3 2");
  const geometry = await page.evaluate(() => {
    const line = document.querySelector('[data-layer="root-stem"] line');
    const root = document.querySelector('[data-node-id="t0-n0"] > circle');
    return {
      length: Number(line.getAttribute("x2")) - Number(line.getAttribute("x1")),
      dx: Number(line.getAttribute("x2")) - Number(root.getAttribute("cx")),
      dy: Number(line.getAttribute("y1")) - Number(root.getAttribute("cy")),
      horizontal: line.getAttribute("y1") === line.getAttribute("y2")
    };
  });
  expect(geometry).toEqual({ length: 24, dx: 0, dy: 0, horizontal: true });
  expect(await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML)).toBe(branches);
  expect(await page.locator('[data-layer="labels"]').evaluate(el => el.outerHTML)).toBe(labels);
  await page.locator("#root-style").selectOption("solid");
  await expect(stem).toHaveCount(1);
  await page.locator("#root-style").selectOption("hollow");
  const exported = await readFile(await download(page, "svg", testInfo, "stem.svg"), "utf8");
  expect(exported).toContain('data-layer="root-stem"');
  expect(exported).toContain("裝飾根幹，不代表時間長度");
  const saved = await download(page, "save", testInfo, "stem.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#root-style")).toHaveValue("hollow");
  await expect(page.locator("#root-stem")).toBeChecked();
  await expect(stem).toHaveCount(1);
  await page.locator("#style-settings > summary").click();
  await page.locator("#time-range").selectOption("manual");
  await page.locator("#older").fill("60");
  await page.locator("#older").press("Tab");
  await expect(stem).toHaveCount(0);
  await page.locator("#time-range").selectOption("auto");
  await expect(stem).toHaveCount(1);
  await page.locator("#root-stem").uncheck();
  await expect(stem).toHaveCount(0);
});

test("offline Ma coordinates, fossils, exact details, grid and zoom", async ({ page }) => {
  await demoTime(page);
  await page.locator("#grid-step").fill("10");
  await page.locator("#grid-step").press("Tab");
  await expect(page.locator('[data-layer="grid"] line[data-age]')).toHaveCount(11);
  const positions = await page.evaluate(() => {
    const xs = id => Number(document.querySelector(`[data-node-id="t0-n${id}"] circle`).getAttribute("cx"));
    return { root: xs(0), fifty: xs(1), fossil: xs(2), recent: xs(3) };
  });
  expect(positions.fifty).toBeCloseTo((positions.root + positions.recent) / 2, 5);
  expect(positions.fossil).toBeCloseTo(positions.root + (positions.recent - positions.root) * 0.8, 5);
  await page.locator('[data-node-id="t0-n2"]').click();
  await expect(page.locator("#node-info")).toContainText("20");
  await expect(page.locator("#node-info")).toContainText("age_95%HPD");
  await expect(page.locator("#node-info")).toContainText("30");
  await expect(page.locator("#node-info")).toContainText("derived:time-length");
  await page.locator("#zoom-in").click();
  const aligned = await page.evaluate(() => {
    const point = document.querySelector('[data-node-id="t0-n2"] circle').getBoundingClientRect();
    const line = document.querySelector('[data-layer="grid"] line[data-age="20"]').getBoundingClientRect();
    return Math.abs((point.left + point.right) / 2 - line.left);
  });
  expect(aligned).toBeLessThan(1);
});

test("SVG, PNG, CSV and original downloads work offline", async ({ page }, testInfo) => {
  await demoTime(page);
  const checkAxisTitle = async locator => {
    const layout = await locator.evaluate(root => {
      const title = root.querySelector('[data-axis-title="time"]'), b = title.getBBox();
      const ticks = [...root.querySelectorAll("text")].filter(el => /^\d+(?:\.\d+)?$/.test(el.textContent));
      return {
        title: title.textContent, left: b.x, right: b.x + b.width, baseline: Number(title.getAttribute("y")),
        ticks: ticks.map(el => ({ left: el.getBBox().x, baseline: Number(el.getAttribute("y")) }))
      };
    });
    expect(layout.title).toBe("距今年代（Ma）");
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.ticks.length).toBeGreaterThan(0);
    for (const tick of layout.ticks) {
      expect(tick.baseline).toBe(layout.baseline);
      expect(tick.left - layout.right).toBeGreaterThanOrEqual(10);
    }
  };
  await checkAxisTitle(page.locator("#canvas svg"));
  const svg = await readFile(await download(page, "svg", testInfo, "tree.svg"), "utf8");
  expect(svg).toContain("距今年代");
  expect(svg).toContain("20 Ma");
  expect(svg).toContain('data-layer="grid"');
  expect(svg).not.toMatch(/<script|\son\w+=|(?:href|src)="https?:/i);
  const exported = await page.context().newPage();
  try {
    await exported.setContent(svg);
    await checkAxisTitle(exported.locator("svg"));
  } finally { await exported.close(); }
  const png = await readFile(await download(page, "png", testInfo, "tree.png"));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBeGreaterThan(800);
  const csv = await readFile(await download(page, "csv", testInfo, "ages.csv"), "utf8");
  expect(csv).toContain("raw_age_key");
  expect(csv).toContain("age_mean");
  const original = await readFile(await download(page, "original", testInfo, "source.nex"), "utf8");
  expect(original).toBe(await readFile(resolve("examples", "dated-mrbayes.nex"), "utf8"));
  await page.locator("#export-scope").selectOption("viewport");
  await page.locator("#zoom-in").click();
  await page.locator("#canvas").evaluate(el => { el.scrollTop = 100; });
  const viewportSVG = await readFile(await download(page, "svg", testInfo, "viewport.svg"), "utf8");
  expect(viewportSVG).toContain('data-export-axis="viewport"');
  expect(viewportSVG).toContain("距今年代（Ma）");
  expect(viewportSVG).toContain("export-viewport-clip");
  const viewportPage = await page.context().newPage();
  try {
    await viewportPage.setContent(viewportSVG);
    await checkAxisTitle(viewportPage.locator('[data-export-axis="viewport"]'));
  } finally { await viewportPage.close(); }
});

test("project restores age provenance, selection, grid and collapse", async ({ page }, testInfo) => {
  await demoTime(page);
  await page.locator("#search").fill("t0-n1"); await page.locator("#find").click();
  await page.locator("#collapse").click();
  await page.locator("#grid-step").fill("10"); await page.locator("#grid-step").press("Tab");
  const saved = await download(page, "save", testInfo, "project.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator("#node-info")).toContainText("t0-n1");
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#canvas")).toContainText("已折疊 2 tips");
  await expect(page.locator("#grid-step")).toHaveValue("10");
  await page.locator("#expand-all").click();
  await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(7);
});

test("switching trees never carries age settings into an unrooted tree", async ({ page }) => {
  await demoTime(page);
  await page.locator("#tree").selectOption("1");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await expect(page.locator("#root-status")).toBeHidden();
  await page.locator("#apply-time").click();
  await expect(page.locator("#diagnostics")).toContainText("未定根");
  await expect(page.locator("[data-age-label]")).toHaveCount(0);
});

test("age controls need no notes or checkbox and only prompt for an unknown root", async ({ page }, testInfo) => {
  const tree = "(A[&age_mean=0],B[&age_mean=20])[&age_mean=100];";
  await upload(page, "rooted.tre", "[&R]" + tree);
  await expect(page.locator("#confirmed")).toHaveCount(0);
  await expect(page.locator("#root-status")).toBeHidden();
  await expect(page.locator("#evidence")).toHaveValue("");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#evidence").fill("Optional provenance");
  await page.locator("#evidence").press("Tab");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await upload(page, "unknown.tre", tree);
  await expect(page.locator("#root-status")).toBeVisible();
  await expect(page.locator("#root-confirmed")).toHaveValue("unknown");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await expect(page.locator("#diagnostics")).toContainText("使用目前的根");
  await page.locator("#root-confirmed").selectOption("rooted");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  const saved = await download(page, "save", testInfo, "unknown-root.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#root-confirmed")).toHaveValue("rooted");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#root-confirmed").selectOption("unknown");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await upload(page, "another.tre", tree);
  await expect(page.locator("#root-confirmed")).toHaveValue("unknown");
});

test("corrupt files and unsafe XML preserve the open project", async ({ page }) => {
  await demoTime(page);
  for (const [name, text] of [
    ["bad.nex", "#NEXUS begin data; dimensions ntax=1; end;"],
    ["bad.tre", "(A:invalid,B);"],
    ["bad.xml", '<!DOCTYPE a [<!ENTITY x SYSTEM "https://invalid.example/test">]><phyloxml/>'],
    ["bad.json", '{"kind":"paleo-phylotree","schemaVersion":99}']
  ]) {
    await upload(page, name, text);
    await expect(page.locator("#notice")).toHaveClass("error");
    await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
    await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(7);
  }
});

const phyloxml = `<phyloxml xmlns="http://www.phyloxml.org"><phylogeny rooted="true"><name>XML tree</name><clade><name>root</name><property ref="age_mean">100</property><clade branch_length="1"><name>Fossil</name><property ref="age_mean">20</property></clade><clade><name>Recent</name><branch_length>2</branch_length><property ref="age_mean">0</property></clade></clade></phylogeny></phyloxml>`;
const nexml = `<nex:nexml xmlns:nex="http://www.nexml.org/2009" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><nex:otus id="o"><nex:otu id="oa" label="Fossil"/><nex:otu id="ob" label="Recent"/></nex:otus><nex:trees otus="o"><nex:tree id="t" label="NeXML tree"><nex:node id="r" root="true"><nex:meta property="age_mean" content="100"/></nex:node><nex:node id="a" otu="oa"><nex:meta property="age_mean" content="20"/></nex:node><nex:node id="b" otu="ob"><nex:meta property="age_mean" content="0"/></nex:node><nex:edge id="e1" source="r" target="a" length="80"/><nex:edge id="e2" source="r" target="b" length="100"/></nex:tree></nex:trees></nex:nexml>`;
for (const [name, text] of [
  ["plain.nwk", "((A:1e-15,B:2e-15):3e-15,C:4e-15);"],
  ["hyphy.tre", "(A{Foreground}:1,B:2);"],
  ["nhx.nhx", "(A[&&NHX:S=fish:D=Y]:1,B:2);"],
  ["beast.tre", "[&R](A[&height=0]:10,B[&height=2]:8)[&height=10];"],
  ["tree.phyloxml", phyloxml],
  ["tree.nexml", nexml]
]) {
  test(`format import ${name}`, async ({ page }) => {
    await upload(page, name, text);
    await expect(page.locator("#notice")).toHaveClass("success");
    await expect(page.locator('[data-layer="nodes"] > g')).not.toHaveCount(0);
    await expect(page.locator("#mode-badge")).toHaveText("一般模式");
    if (name === "plain.nwk") {
      const span = await page.locator('[data-layer="nodes"] > g > circle:first-child').evaluateAll(nodes => {
        const xs = nodes.map(n => Number(n.getAttribute("cx")));
        return Math.max(...xs) - Math.min(...xs);
      });
      expect(span).toBeGreaterThan(200);
    }
    if (name.endsWith("xml")) {
      await page.locator("#evidence").fill("Synthetic XML: age_mean is Ma before present");
      await page.locator("#apply-time").click();
      await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
    }
  });
}

test("invalid XML topology and wrong XML document are rejected", async ({ page }) => {
  for (const [name, text] of [
    ["phylo.xml", "<phyloxml><phylogeny><clade></phylogeny></phyloxml>"],
    ["network.xml", '<nexml><trees><network id="n"/></trees></nexml>'],
    ["beast.xml", "<beast><run/></beast>"],
    ["cycle.nexml", '<nexml><trees><tree><node id="a"/><node id="b"/><edge source="a" target="b"/><edge source="b" target="a"/></tree></trees></nexml>']
  ]) {
    await upload(page, name, text);
    await expect(page.locator("#notice")).toHaveClass("error");
    await expect(page.locator("#empty")).toBeVisible();
  }
});

test("labels are literal data, not executable markup", async ({ page }) => {
  await upload(page, "literal.tre", `('<img src="https://invalid.example/x" onerror="alert(1)">':1,B:2);`);
  await expect(page.locator("#canvas")).toContainText("<img");
  await expect(page.locator("#canvas img")).toHaveCount(0);
});

test("UTF-8 BOM original content survives export and invalid settings preserve chart", async ({ page }, testInfo) => {
  const text = "\uFEFF[&R](A[&age_mean=0],B[&age_mean=20])[&age_mean=100];";
  await upload(page, "bom.tre", text);
  expect(await readFile(await download(page, "original", testInfo, "bom.tre"), "utf8")).toBe(text);
  await demoTime(page);
  await page.locator("#grid-step").fill("0.00001");
  await page.locator("#grid-step").press("Tab");
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator("[data-age-label]")).not.toHaveCount(0);
});

test("automatic sources need no advanced selection and preserve auto, manual and legacy projects", async ({ page }, testInfo) => {
  await page.reload();
  await expect(page.locator("#method")).toBeHidden();
  await upload(page, "anchor.tre", "[&R](A:100,B:80)[&age_mean=100];");
  await expect(page.locator("#source-status")).toContainText("已採用「時間枝長＋既有年代錨點」");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  const saved = await download(page, "save", testInfo, "automatic.json");
  const project = JSON.parse(await readFile(saved, "utf8"));
  expect(project.options.autoMethod).toBe(true);
  expect(project.options.method).toBe("branches");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#source-settings > summary").click();
  await page.locator("#method").selectOption("nodes");
  await expect(page.locator("#source-status")).toContainText("手動指定：明確節點年代");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  const manual = await download(page, "save", testInfo, "manual.json");
  await page.reload();
  await page.locator("#file").setInputFiles(manual);
  await expect(page.locator("#method")).toHaveValue("nodes");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  const legacy = JSON.parse(await readFile(manual, "utf8"));
  delete legacy.options.autoMethod;
  await upload(page, "legacy.json", JSON.stringify(legacy));
  await expect(page.locator("#method")).toHaveValue("nodes");
  await expect(page.locator("#source-status")).toContainText("手動指定：明確節點年代");
  await page.locator("#source-settings > summary").click();
  await page.locator("#method").selectOption("auto");
  await expect(page.locator("#source-status")).toContainText("已採用「時間枝長＋既有年代錨點」");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await upload(page, "complete.tre", "[&R](A[&age_mean=0]:100,B[&age_mean=20]:80)[&age_mean=100,age_median=100];");
  await expect(page.locator("#source-status")).toContainText("已採用「明確節點年代」");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#age-field").selectOption("age_median");
  await expect(page.locator("#source-status")).toContainText("已採用「時間枝長＋既有年代錨點」");
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#age-field").selectOption("age_mean");
  await expect(page.locator("#source-status")).toContainText("已採用「明確節點年代」");
  await upload(page, "incomplete.tre", "[&R](A:10,B:20);");
  await expect(page.locator("#source-status")).toContainText("兩種來源目前皆不可用");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
});

test("source preflight recommends explicit ages for trilobites and collapses branch errors", async ({ page }) => {
    await page.locator("#demo").selectOption("trilobites");
    await expect(page.locator("#method")).toHaveValue("auto");
    await expect(page.locator("#method-nodes")).toHaveText("明確節點年代（建議）");
    await expect(page.locator("#method-branches")).toContainText("數值不相容或資料不足");
    await expect(page.locator("#source-status")).toContainText("age_mean");
    await expect(page.locator("#source-status")).toContainText("建議使用「明確節點年代」");
    await page.locator("#method").selectOption("branches");
    await expect(page.locator("#mode-badge")).toHaveText("一般模式");
    await expect(page.locator("#diagnostics > p.problem")).toHaveCount(1);
    await expect(page.locator("#diagnostics > p.problem")).toContainText("建議改用「明確節點年代」");
    await expect(page.locator("#diagnostics details")).not.toHaveAttribute("open");
    await expect(page.locator("#diagnostics details p").first()).toBeHidden();
    await page.locator("#diagnostics summary").click();
    await expect(page.locator("#diagnostics details p").first()).toBeVisible();
    await page.locator("#age-field").selectOption("age_median");
    await expect(page.locator("#source-status")).toContainText("age_median");
    await expect(page.locator("#method")).toHaveValue("branches");
    await expect(page.locator("#mode-badge")).toHaveText("一般模式");
    await page.locator("#method").selectOption("nodes");
    await page.locator("#apply-time").click();
    await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
    await expect(page.locator("#diagnostics details")).toHaveCount(0);
});

test("source preflight distinguishes derivable ages from missing anchors without assuming time units", async ({ page }) => {
  await upload(page, "compatible.tre", "[&R]((A:50,B:30):50,C:100)[&age_mean=100];");
  await expect(page.locator("#method-nodes")).toContainText("目前不可用");
  await expect(page.locator("#method-branches")).toContainText("數值相容，單位待確認");
  await expect(page.locator("#source-status")).toContainText("數值相容不代表已驗證時間單位");
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#method").selectOption("branches");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await upload(page, "no-anchor.tre", "[&R]((A:50,B:30):50,C:100);");
  await expect(page.locator("#source-status")).toContainText("缺少輸入中既有的絕對年代錨點");
  await expect(page.locator("#method-branches")).toContainText("資料不足");
  await upload(page, "unknown-root.tre", "(A:50,B:30)[&age_mean=50];");
  await expect(page.locator("#method-branches")).toContainText("定根條件未滿足");
  await page.locator("#root-confirmed").selectOption("rooted");
  await expect(page.locator("#method-branches")).toContainText("數值相容，單位待確認");
});

test("time branches use fixed Ma and incompatible legacy units cannot replace the open chart", async ({ page }, testInfo) => {
  await upload(page, "branches.tre", "[&R]((A:50,B:30):50,C:100)[&age_mean=100]:999;");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#method").selectOption("branches");
  await page.locator("#evidence").fill("Synthetic: Ma time branches with a 100 Ma root anchor.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator('[data-age-label="t0-n3"]')).toHaveText("20 Ma");
  await expect(page.locator("#unit")).toHaveCount(0);
  const saved = await download(page, "save", testInfo, "fixed-ma.json");
  const project = JSON.parse(await readFile(saved, "utf8"));
  expect(project.options.unit).toBe("Ma");
  for (const unit of ["ka", "years"]) {
    await upload(page, `${unit}.json`, JSON.stringify({
      ...project, options: { ...project.options, unit }
    }));
    await expect(page.locator("#notice")).toHaveClass("error");
    await expect(page.locator("#notice")).toContainText("固定使用 Ma");
    await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
    await expect(page.locator('[data-age-label="t0-n3"]')).toHaveText("20 Ma");
  }
});

test("fossil zero correction shifts real MrBayes data and survives exports and restore", async ({ page }, testInfo) => {
  const file = resolve("examples", "trilobites-tip-date.nex.con.tre");
  await page.locator("#file").setInputFiles(file);
  await expect(page.locator("#zero-range-enabled, #zero-younger, #zero-older")).toHaveCount(0);
  await page.locator("#zero-age").fill("380");
  await page.locator("#evidence").fill("Technical regression only: illustrative fossil zero=380 Ma, not a scientific calibration.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await page.locator("#search").fill("Phacops");
  await page.locator("#find").click();
  await expect(page.locator("#node-info")).toContainText("380");
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("380 Ma");
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("495.34 Ma");
  const csv = await readFile(await download(page, "csv", testInfo, "corrected.csv"), "utf8");
  expect(csv).toContain("zero_age_Ma");
  expect(csv).toContain("zero=380 Ma");
  expect(csv).not.toContain("zero_age_range_Ma");
  await expect(page.locator("#node-info")).toContainText("age_95%HPD");
  await expect(page.locator("[data-origin-range-line]")).toHaveCount(0);
  const original = await readFile(await download(page, "original", testInfo, "unchanged.tre"), "utf8");
  expect(original).toBe(await readFile(file, "utf8"));
  const saved = await download(page, "save", testInfo, "corrected.json");
  const project = JSON.parse(await readFile(saved, "utf8"));
  expect(project.options.zeroAgeRangeMa).toBeUndefined();
  await upload(page, "old-range.json", JSON.stringify({ ...project, options: { ...project.options, zeroAgeRangeMa: [375, 385] } }));
  await expect(page.locator("#notice")).toContainText("僅支援固定原點年代");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("380 Ma");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#zero-age")).toHaveValue("380");
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("380 Ma");
  const svg = await readFile(await download(page, "svg", testInfo, "corrected.svg"), "utf8");
  expect(svg).toContain("380 Ma");
  await page.locator("#zero-age").fill("390");
  await page.locator("#zero-age").press("Tab");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#zero-age").fill("-1");
  await page.locator("#zero-age").press("Tab");
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
});

test("origin input modes show one age or two unordered endpoints and restore the selected mode", async ({ page }, testInfo) => {
  await demoTime(page);
  await expect(page.locator("#zero-age-single")).toBeChecked();
  await expect(page.locator("#zero-age-first-label")).toHaveText("年代（Ma）");
  await expect(page.locator("#zero-age-second")).toBeHidden();
  await expect(page.locator("#zero-age-second")).toBeDisabled();
  await expect(page.locator("#zero-age-second")).toHaveValue("");
  await page.getByLabel("年代區間", { exact: true }).check();
  await expect(page.locator("#zero-age-first-label")).toHaveText("端點 A");
  await expect(page.getByLabel("端點 B", { exact: true })).toBeVisible();
  await expect(page.locator("#zero-age-help")).toContainText("順序不限");
  const fields = await page.locator("#zero-age-values input").evaluateAll(inputs => inputs.map(el => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, right: b.right };
  }));
  expect(fields[0].y).toBe(fields[1].y);
  expect(fields[1].x).toBeGreaterThan(fields[0].right);
  const groupRight = await page.locator(".zero-age-settings").evaluate(el => el.getBoundingClientRect().right);
  expect(fields[1].right).toBeLessThan(groupRight);
  await page.locator("#zero-age").fill("385");
  await page.locator("#zero-age-second").fill("398");
  await expect(page.locator("#zero-age-summary")).toContainText("391.5 Ma");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("491.5 Ma");
  await expect(page.locator('[data-age-label="t0-n3"]')).toHaveText("391.5 Ma");
  await expect(page.locator("[data-origin-range-line]")).toHaveCount(0);
  const paths = () => page.locator('[data-layer="branches"] path').evaluateAll(elements => elements.map(el => el.getAttribute("d")));
  const originalGeometry = await paths();
  await page.locator("#zero-age").fill("398");
  await page.locator("#zero-age-second").fill("385");
  await page.locator("#apply-time").click();
  expect(await paths()).toEqual(originalGeometry);
  await page.locator('[data-node-id="t0-n0"]').click();
  await expect(page.locator("#node-info")).toContainText("(398＋385) ÷ 2＝391.5 Ma");
  await expect(page.locator("#node-info")).toContainText("age_95%HPD");
  const csv = await readFile(await download(page, "csv", testInfo, "midpoint.csv"), "utf8");
  expect(csv).toContain("zero_age_pair_Ma");
  expect(csv).toContain("[398,385]");
  expect(csv).toContain("zero=391.5 Ma");
  const svg = await readFile(await download(page, "svg", testInfo, "midpoint.svg"), "utf8");
  expect(svg).toContain("491.5 Ma");
  expect(svg).not.toContain('data-layer="origin-ranges"');
  const saved = await download(page, "save", testInfo, "midpoint.json");
  const project = JSON.parse(await readFile(saved, "utf8"));
  expect(project.options.zeroAgeMa).toBe(391.5);
  expect(project.options.zeroAgePairMa).toEqual([398, 385]);
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#zero-age-range")).toBeChecked();
  await expect(page.locator("#zero-age-second")).toBeVisible();
  await expect(page.locator("#zero-age")).toHaveValue("398");
  await expect(page.locator("#zero-age-second")).toHaveValue("385");
  await expect(page.locator("#zero-age-summary")).toContainText("391.5 Ma");
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("491.5 Ma");
  await page.locator("#zero-age-second").fill("-1");
  await page.locator("#apply-time").click();
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.locator("#zero-age-second").fill("");
  await expect(page.locator("#zero-age-summary")).toContainText("請填入兩個端點");
  await page.locator("#apply-time").click();
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("一般模式");
  await page.getByLabel("單一年代", { exact: true }).check();
  await expect(page.locator("#zero-age-second")).toBeHidden();
  await expect(page.locator("#zero-age-summary")).toHaveText("全樹平移值：398 Ma");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("498 Ma");
  await page.getByLabel("年代區間", { exact: true }).check();
  await page.locator("#zero-age-second").fill("0");
  await expect(page.locator("#zero-age-summary")).toContainText("199 Ma");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("299 Ma");
  await page.getByLabel("單一年代", { exact: true }).check();
  await expect(page.locator("#zero-age-second")).toHaveValue("0");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("498 Ma");
  const single = await download(page, "save", testInfo, "single-origin.json");
  expect(JSON.parse(await readFile(single, "utf8")).options.zeroAgePairMa).toBeNull();
  await page.reload();
  await page.locator("#file").setInputFiles(single);
  await expect(page.locator("#zero-age-single")).toBeChecked();
  await expect(page.locator("#zero-age")).toHaveValue("398");
  await expect(page.locator("#zero-age-second")).toBeHidden();
});

test("vertical layout separates measured OTU, age and support labels without changing Ma positions", async ({ page }, testInfo) => {
  await page.locator("#file").setInputFiles(resolve("examples", "trilobites-tip-date.nex.con.tre"));
  await page.locator("#zero-age").fill("385");
  await page.locator("#evidence").fill("Layout regression: illustrative 385 Ma origin only.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
  const checkLayout = async () => {
    const data = await page.locator("#canvas svg").evaluate(svg => {
      const labels = [...svg.querySelectorAll('[data-layer="labels"] text')].map(el => {
        const box = el.getBBox(), halo = el.hasAttribute("data-age-label") ? 1.5 : 0;
        return { text: el.textContent, x: box.x - halo, y: box.y - halo, width: box.width + 2 * halo, height: box.height + 2 * halo };
      });

      const overlaps = [];
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps.push([a.text, b.text]);
      }
      const points = [...svg.querySelectorAll('[data-layer="nodes"] > g')].map(el => ({
        id: el.getAttribute("data-node-id"), x: Number(el.querySelector("circle").getAttribute("cx")),
        y: Number(el.querySelector("circle").getAttribute("cy"))
      }));
      const byId = new Map(points.map(p => [p.id, p]));
      const baseline = Number(svg.querySelector('[data-layer="labels"]').getAttribute("font-size")) / 3;
      const alignmentErrors = [];
      for (const age of svg.querySelectorAll("[data-age-label]")) {
        const id = age.getAttribute("data-age-label"), point = byId.get(id);
        const x = Number(age.getAttribute("x")), y = Number(age.getAttribute("y"));
        if (x <= point.x || Math.abs(y - point.y - baseline) > 1e-8) alignmentErrors.push(age.textContent);
        const name = svg.querySelector(`[data-label-kind="name"][data-label-node="${id}"]`);
        if (name) {
          const box = name.getBBox(), ageBox = age.getBBox();
          if (name.getAttribute("y") !== age.getAttribute("y") || ageBox.x <= box.x + box.width) alignmentErrors.push(age.textContent);
        }
      }
      const children = new Map(), branchOverlaps = [];
      const stroke = Number(svg.querySelector('[data-layer="branches"]').getAttribute("stroke-width")) / 2;
      for (const path of svg.querySelectorAll('[data-layer="branches"] path')) {
        const parent = byId.get(path.getAttribute("data-parent-node"));
        const child = byId.get(path.getAttribute("data-child-node"));
        const ys = children.get(parent.id) ?? [];
        ys.push(child.y); children.set(parent.id, ys);
        const segments = [
          { x: parent.x - stroke, y: Math.min(parent.y, child.y) - stroke, width: 2 * stroke, height: Math.abs(child.y - parent.y) + 2 * stroke },
          { x: Math.min(parent.x, child.x) - stroke, y: child.y - stroke, width: Math.abs(child.x - parent.x) + 2 * stroke, height: 2 * stroke }
        ];
        for (const label of labels) for (const segment of segments) {
          if (label.x < segment.x + segment.width && segment.x < label.x + label.width &&
            label.y < segment.y + segment.height && segment.y < label.y + label.height) branchOverlaps.push(label.text);
        }
      }
      const midpointErrors = [...children].map(([id, ys]) => Math.abs(byId.get(id).y - (Math.min(...ys) + Math.max(...ys)) / 2));
      return { overlaps, branchOverlaps, midpointErrors, alignmentErrors, points, count: labels.length, height: Number(svg.getAttribute("height")),
        inside: labels.every(l => l.x >= 0 && l.x + l.width <= Number(svg.getAttribute("width")) &&
          l.y >= 76 && l.y + l.height < Number(svg.getAttribute("height")) - 40) };
    });
    expect(data.overlaps).toEqual([]);
    expect(data.branchOverlaps).toEqual([]);
    expect(data.alignmentErrors).toEqual([]);
    for (const error of data.midpointErrors) expect(error).toBeLessThan(1e-8);
    expect(data.inside).toBe(true);
    return data;
  };
  await expect(page.locator('[data-label-kind="name"]')).toHaveCount(5);
  await expect(page.locator("[data-age-label]")).toHaveCount(9);
  const small = await checkLayout();
  await page.locator("#font-size").fill("32");
  await page.locator("#font-size").press("Tab");
  await page.locator("#support").check();
  const large = await checkLayout();
  expect(large.height).toBeGreaterThan(small.height);
  await page.locator("#line-width").fill("6");
  await page.locator("#line-width").press("Tab");
  await checkLayout();
  await page.locator("#names").uncheck();
  await checkLayout();
  await page.locator("#names").check();
  await checkLayout();
  const normalizeX = points => {
    const root = points.find(p => p.id === "t0-n0").x, tip = points.find(p => p.id === "t0-n4").x;
    return points.map(p => ({ id: p.id, x: (p.x - root) / (tip - root) }));
  };
  const expected = normalizeX(small.points);
  for (const [i, p] of normalizeX(large.points).entries()) expect(p.x).toBeCloseTo(expected[i].x, 10);
  await page.locator("#zoom-in").click();
  await checkLayout();
  await page.locator("#order").selectOption("ascending");
  await checkLayout();
  await page.locator("#search").fill("t0-n3");
  await page.locator("#find").click();
  await page.locator("#collapse").click();
  await checkLayout();
  await page.locator("#expand-all").click();
  const expanded = await checkLayout();
  await expect(page.locator("[data-age-label]")).toHaveCount(9);
  const exported = await readFile(await download(page, "svg", testInfo, "spaced-labels.svg"), "utf8");
  const exportPage = await page.context().newPage();
  try {
    await exportPage.setContent(exported);
    const positions = await exportPage.locator('[data-layer="labels"] text').evaluateAll(elements => elements.map(el => ({
      text: el.textContent, x: el.getAttribute("x"), y: el.getAttribute("y")
    })));
    const screen = await page.locator('[data-layer="labels"] text').evaluateAll(elements => elements.map(el => ({
      text: el.textContent, x: el.getAttribute("x"), y: el.getAttribute("y")
    })));
    expect(positions).toEqual(screen);
    expect(positions).toHaveLength(expanded.count);
  } finally { await exportPage.close(); }
  for (const text of [
    "[&R](A[&age_mean=10],B[&age_mean=10],C[&age_mean=10],D[&age_mean=10])root[&age_mean=10];",
    "[&R](((A[&age_mean=10])inner[&age_mean=10])middle[&age_mean=10],B[&age_mean=10])root[&age_mean=10];"
  ]) {
    await upload(page, "crowded.tre", text);
    await page.locator("#font-size").fill("32");
    await page.locator("#font-size").press("Tab");
    await page.locator("#apply-time").click();
    await expect(page.locator("#mode-badge")).toHaveText("Ma 時間模式");
    await checkLayout();
  }
});

test("automatic horizontal range spreads fossil trees and persists with readable axis labels", async ({ page }, testInfo) => {
  await page.locator("#file").setInputFiles(resolve("examples", "trilobites-tip-date.nex.con.tre"));
  await page.locator("#zero-age").fill("385");
  await page.locator("#evidence").fill("Horizontal layout regression only: illustrative 385 Ma origin.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#time-range")).toHaveValue("auto");
  await expect(page.locator("#younger")).toBeDisabled();
  expect(Number(await page.locator("#younger").inputValue())).toBeGreaterThan(370);
  const inspect = async () => page.locator("#canvas svg").evaluate(svg => {
    const root = svg.querySelector('[data-node-id="t0-n0"] circle');
    const tip = svg.querySelector('[data-node-id="t0-n4"] circle');
    const axis = svg.querySelector('[data-layer="grid"] > line:last-child');
    const width = Number(axis.getAttribute("x2")) - Number(axis.getAttribute("x1"));
    const boxes = [...svg.querySelectorAll('[data-layer="labels"] text, [data-layer="grid"] text')].map(el => {
      const b = el.getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height, text: el.textContent };
    });
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push([a.text, b.text]);
    }
    return { span: Number(tip.getAttribute("cx")) - Number(root.getAttribute("cx")), width, overlaps };
  });
  const auto = await inspect();
  expect(auto.span / auto.width).toBeGreaterThan(0.9);
  expect(auto.overlaps).toEqual([]);
  await page.locator("#grid-step").fill("1");
  await page.locator("#grid-step").press("Tab");
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#notice")).toContainText("刻度文字過密");
  expect((await inspect()).overlaps).toEqual([]);
  await page.locator("#grid-step").fill("");
  await page.locator("#grid-step").press("Tab");
  await page.locator("#time-range").selectOption("manual");
  await page.locator("#older").fill("510");
  await page.locator("#older").press("Tab");
  await page.locator("#younger").fill("0");
  await page.locator("#younger").press("Tab");
  const manual = await inspect();
  expect(manual.span).toBeLessThan(auto.span / 3);
  expect(manual.overlaps).toEqual([]);
  await page.locator("#time-range").selectOption("auto");
  expect((await inspect()).span).toBeCloseTo(auto.span, 5);
  await page.locator("#font-size").fill("32");
  await page.locator("#font-size").press("Tab");
  expect((await inspect()).overlaps).toEqual([]);
  await page.locator("#search").fill("t0-n3");
  await page.locator("#find").click();
  await page.locator("#collapse").click();
  await expect(page.locator("#younger")).toHaveValue(String(385 - (500.341211 - 385) * 0.05));
  const saved = await download(page, "save", testInfo, "automatic-range.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#time-range")).toHaveValue("auto");
  expect(Number(await page.locator("#younger").inputValue())).toBeGreaterThan(370);
  await page.locator("#expand-all").click();
  expect((await inspect()).overlaps).toEqual([]);
});

test("1000-tip render and search remain bounded", async ({ page }, testInfo) => {
  const tree = `(${Array.from({ length: 1000 }, (_, i) => `Tip_${i}[&age_mean=${i % 20}]:1`).join(",")})[&age_mean=100];`;
  const start = Date.now();
  await upload(page, "1000.tre", "[&R]" + tree);
  await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(1001);
  const loadMs = Date.now() - start;
  await page.locator("#search").fill("Tip_999");
  const searchStart = Date.now();
  await page.locator("#find").click();
  await expect(page.locator("#node-info")).toContainText("Tip_999");
  const searchMs = Date.now() - searchStart;
  await testInfo.attach("timing.json", { body: JSON.stringify({ loadMs, searchMs }), contentType: "application/json" });
  console.log(`1000-tip timing: load=${loadMs}ms search=${searchMs}ms`);
  expect(loadMs).toBeLessThan(5000);
  expect(searchMs).toBeLessThan(1000);
});

test("five fresh offline contexts meet the median import target", async ({ browser }) => {
  const tree = `[&R](${Array.from({ length: 1000 }, (_, i) => `T${i}:1`).join(",")});`;
  const times = [];
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({ offline: true, viewport: { width: 1366, height: 768 } });
    try {
      const page = await context.newPage();
      await page.goto(url);
      const start = Date.now();
      await upload(page, "benchmark.tre", tree);
      await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(1001);
      times.push(Date.now() - start);
    } finally { await context.close(); }
  }
  const median = [...times].sort((a, b) => a - b)[2];
  console.log(`Fresh offline contexts: ${times.join(", ")}ms; median=${median}ms`);
  expect(median).toBeLessThan(5000);
});
