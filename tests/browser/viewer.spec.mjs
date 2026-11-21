import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const url = pathToFileURL(resolve("dist", "paleo-phylotree.html")).href;
test.use({ locale: "zh-TW" });
async function upload(page, name, text) {
  await page.locator("#file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
}
async function demoTime(page) {
  await page.locator("#demo").selectOption("chronogram");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
}
async function fillEvidence(page, text) {
  if (!await page.locator("#evidence").isVisible()) await page.locator("#evidence-settings > summary").click();
  await page.locator("#evidence").fill(text);
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

for (const [mode, filename, label, axis, distances] of [
  ["dated", "dated-tree", "Dated Tree", "Age (Ma)", null],
  ["chronogram", "chronogram", "Chronogram", "Age (Ma)", null],
  ["relative", "relative-chronogram", "Relative Chronogram", "Relative time", Array(15).fill(30)],
  ["phylogram", "phylogram", "Phylogram", "Branch length", [0.4, 0.5, ...Array.from({ length: 13 }, (_, i) => 0.4 + i * 0.1)]],
  ["cladogram", "cladogram", "Cladogram", "Equal steps", null]
]) {
  test(`${label} automatically classifies, preserves its scale and exports offline`, async ({ page }, testInfo) => {
    await expect(page.locator("#demo option")).toHaveText([
      "選擇範例…", "dated-tree.nex", "chronogram.nex", "relative-chronogram.nex", "phylogram.nex", "cladogram.nex"
    ]);
    await page.locator("#demo").selectOption(mode);
    await expect(page.locator("#mode-badge")).toHaveText(label);
    const svg = page.locator("#canvas svg");
    await expect(svg).toHaveAttribute("data-mode", mode);
    await expect(svg.locator("[data-axis-title]")).toHaveText(axis);
    await expect(svg.locator('[data-label-kind="tree-name"]')).toHaveAttribute("x",
      await svg.locator("[data-axis-title]").getAttribute("x"));
    await expect(svg).not.toContainText(/[\u3400-\u9fff]/u);
    if (mode !== "dated") {
      await expect(svg.locator('[data-label-kind="name"]')).toHaveText(
        Array.from({ length: 15 }, (_, i) => `OTU${String(i + 1).padStart(2, "0")}`)
      );
      await expect(svg.locator('[data-layer="nodes"] > g')).toHaveCount(29);
    }
    const absolute = mode === "dated" || mode === "chronogram";
    if (absolute) await expect(page.locator("#apply-time")).toBeVisible();
    else {
      await expect(page.locator("#apply-time")).toBeHidden();
      await expect(page.locator("#apply-time")).toBeDisabled();
    }
    if (!absolute) {
      await expect(svg).not.toContainText("Ma");
      await expect(page.locator("[data-age-label]")).toHaveCount(0);
    }
    const geometry = await svg.evaluate(el => ({
      xs: [...el.querySelectorAll('[data-layer="nodes"] > g > circle:first-child')].map(n => Number(n.getAttribute("cx"))),
      tips: [...el.querySelectorAll('[data-layer="nodes"] > g[aria-label^="OTU"] > circle:first-child')].map(n => Number(n.getAttribute("cx"))),
      edges: [...el.querySelectorAll('[data-layer="branches"] path')].map(path => {
        const n = path.getAttribute("d").match(/M([^,]+),[^V]+V[^H]+H(.+)/);
        return Number(n[2]) - Number(n[1]);
      })
    }));
    if (distances) {
      const max = Math.max(...distances), width = Math.max(...geometry.xs) - geometry.xs[0];
      distances.forEach((value, i) => expect(geometry.tips[i] - geometry.xs[0]).toBeCloseTo(value / max * width, 5));
    }
    if (mode === "cladogram") {
      for (const edge of geometry.edges) {
        expect(edge).toBeGreaterThan(0);
        expect(edge).toBeCloseTo(geometry.edges[0], 5);
      }
    }
    const csv = await readFile(await download(page, "csv", testInfo, `${mode}.csv`), "utf8");
    const [headers, ...rows] = csv.slice(1).split("\r\n").map(line =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
    for (const row of rows) {
      expect(row).toHaveLength(headers.length);
      expect(row[headers.indexOf("mode")]).toBe(mode);
      expect(row[headers.indexOf("plot_age_Ma")] !== "").toBe(absolute);
      expect(row[headers.indexOf("relative_time")] !== "").toBe(mode === "relative");
    }
    for (const scope of ["full", "viewport"]) {
      await page.locator("#export-scope").selectOption(scope);
      const exported = await readFile(await download(page, "svg", testInfo, `${mode}-${scope}.svg`), "utf8");
      expect(exported).toContain(label);
      if (!absolute) expect(exported).not.toContain("Ma");
    }
    const png = await readFile(await download(page, "png", testInfo, `${mode}.png`));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const original = await readFile(await download(page, "original", testInfo, `${filename}.nex`), "utf8");
    expect(original).toBe(await readFile(resolve("examples", `${filename}.nex`), "utf8"));
    const saved = await download(page, "save", testInfo, `${mode}.json`);
    const project = JSON.parse(await readFile(saved, "utf8"));
    expect(project.schemaVersion).toBe(3);
    expect(project.view.mode).toBe(mode);
    await page.reload();
    await page.locator("#file").setInputFiles(saved);
    await expect(page.locator("#mode-badge")).toHaveText(label);
    await expect(svg).toHaveAttribute("data-mode", mode);
  });
}

for (const mode of ["relative", "phylogram", "cladogram"]) {
  test(`${mode} spaces visible OTUs equally after styling, sorting and collapse`, async ({ page }, testInfo) => {
    await page.locator("#demo").selectOption(mode);
    const check = async svg => {
      const geometry = await svg.evaluate(el => {
        const nodes = [...el.querySelectorAll('[data-layer="nodes"] > g')].map(node => ({
          id: node.getAttribute("data-node-id"),
          x: Number(node.querySelector("circle").getAttribute("cx")),
          y: Number(node.querySelector("circle").getAttribute("cy"))
        }));
        const edges = [...el.querySelectorAll('[data-layer="branches"] path')].map(edge => ({
          parent: edge.getAttribute("data-parent-node"), child: edge.getAttribute("data-child-node")
        }));
        return { nodes, edges };
      });
      const tips = geometry.nodes.filter(n => !geometry.edges.some(e => e.parent === n.id)).sort((a, b) => a.y - b.y);
      expect(tips.length).toBeGreaterThan(2);
      const gap = tips[1].y - tips[0].y;
      expect(gap).toBeGreaterThan(0);
      for (let i = 2; i < tips.length; i++) expect(tips[i].y - tips[i - 1].y).toBeCloseTo(gap, 5);
      for (const parent of geometry.nodes) {
        const children = geometry.edges.filter(e => e.parent === parent.id)
          .map(e => geometry.nodes.find(n => n.id === e.child)).sort((a, b) => a.y - b.y);
        if (children.length) expect(parent.y).toBeCloseTo((children[0].y + children.at(-1).y) / 2, 5);
      }
      return Object.fromEntries(geometry.nodes.map(n => [n.id, n.x]));
    };
    const svg = page.locator("#canvas svg"), xs = await check(svg);
    await page.locator("#font-size").fill("32");
    await page.locator("#font-size").press("Tab");
    await page.locator("#support").check();
    expect(await check(svg)).toEqual(xs);
    await page.locator("#order").selectOption("descending");
    expect(await check(svg)).toEqual(xs);
    await page.locator("#search").fill("t0-n1");
    await page.locator("#find").click();
    await page.locator("#collapse").click();
    const collapsed = await check(svg);
    for (const [id, x] of Object.entries(collapsed)) expect(x).toBe(xs[id]);
    const exported = await readFile(await download(page, "svg", testInfo, `${mode}-spacing.svg`), "utf8");
    const output = await page.context().newPage();
    try {
      await output.setContent(exported);
      expect(await check(output.locator("svg"))).toEqual(collapsed);
    } finally { await output.close(); }
    await page.locator("#expand-all").click();
    expect(await check(svg)).toEqual(xs);
  });
}

test("zoom percentage resets to exact original size with mouse and keyboard", async ({ page }, testInfo) => {
  const reset = page.locator("#zoom-label");
  await expect(reset).toBeDisabled();
  await page.locator("#demo").selectOption("cladogram");
  await expect(reset).toBeEnabled();
  for (const [control, key] of [["zoom-in", null], ["zoom-out", "Enter"], ["fit", "Space"]]) {
    await page.locator(`#${control}`).click();
    await expect(reset).not.toHaveText("100%");
    if (key) {
      await reset.focus();
      await reset.press(key);
    } else await reset.click();
    await expect(reset).toHaveText("100%");
    const dimensions = await page.locator("#canvas svg").evaluate(svg => ({
      actualWidth: parseFloat(svg.style.width), actualHeight: parseFloat(svg.style.height),
      originalWidth: Number(svg.getAttribute("width")), originalHeight: Number(svg.getAttribute("height"))
    }));
    expect(dimensions.actualWidth).toBe(dimensions.originalWidth);
    expect(dimensions.actualHeight).toBe(dimensions.originalHeight);
  }
  const saved = JSON.parse(await readFile(await download(page, "save", testInfo, "original-size.json"), "utf8"));
  expect(saved.view.zoom).toBe(1);
});

test("successful search replaces errors from empty and unmatched queries", async ({ page }) => {
  await page.locator("#demo").selectOption("cladogram");
  const notice = page.locator("#notice");
  for (const query of ["", "   ", "no-matching-taxon"]) {
    await page.locator("#search").fill(query);
    await page.locator("#find").click();
    await expect(notice).toHaveClass("error");
    await expect(notice).toHaveAttribute("role", "alert");
    await page.locator("#search").fill("OTU03");
    await expect(notice).not.toHaveClass("error");
    await expect(notice).toHaveAttribute("role", "status");
    await page.locator("#find").click();
    await expect(notice).toHaveClass("success");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("已定位 OTU03");
    await expect(page.locator("#node-info")).toContainText("OTU03");
  }
  await upload(page, "invalid.tre", "(A:-1,B);");
  await expect(notice).toHaveClass("error");
  const importError = await notice.textContent();
  await page.locator("#search").fill("OTU04");
  await expect(notice).toHaveClass("error");
  await expect(notice).toHaveText(importError);
});

test("unknown tip dates are dashed, never invented as zero and remain blank in CSV", async ({ page }, testInfo) => {
  await upload(page, "unknown-tips.nex", "#NEXUS begin trees; tree x=[&R]((A,B)[&age=385],C)[&age=420]; end;");
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
  await expect(page.locator('[data-unknown-length="true"]')).toHaveCount(3);
  await expect(page.locator('[data-age-label]:text-is("Age unknown")')).toHaveCount(3);
  await expect(page.locator("#import-warnings")).toContainText("末端年代未知");
  await page.locator("#search").fill("A");
  await page.locator("#find").click();
  await expect(page.locator("#node-info")).toContainText("Age unknown");
  const csv = await readFile(await download(page, "csv", testInfo, "unknown-tips.csv"), "utf8");
  const [headers, ...rows] = csv.slice(1).split("\r\n").map(line =>
    [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
  for (const row of rows.filter(row => row[headers.indexOf("is_tip")] === "true")) {
    expect(row[headers.indexOf("plot_age_Ma")]).toBe("");
  }
  const exported = await readFile(await download(page, "svg", testInfo, "unknown-tips.svg"), "utf8");
  expect(exported).toContain("Age unknown");
  expect(exported).not.toMatch(/NaN|undefined/);
});

for (const transparent of [false, true]) {
test(`custom background colors (transparent=${transparent}) apply to every mode, exports and restored projects`, async ({ page }, testInfo) => {
  const fill = transparent ? "none" : "#e0f2ff";
  for (const mode of ["dated", "chronogram", "relative", "phylogram", "cladogram"]) {
    await page.locator("#demo").selectOption(mode);
    await expect(page.locator("#background-transparent")).not.toBeChecked();
    await expect(page.locator("#background-color")).toHaveValue("#ffffff");
    await expect(page.locator("#canvas svg > rect").first()).toHaveAttribute("fill", "#ffffff");
    await page.locator("#background-color").fill("#e0f2ff");
    await page.locator("#background-color").dispatchEvent("change");
    await page.locator("#background-transparent").setChecked(transparent);
    if (transparent) await expect(page.locator("#background-color")).toBeDisabled();
    else await expect(page.locator("#background-color")).toBeEnabled();
    await expect(page.locator("#canvas")).toHaveCSS("background-color", transparent ? "rgba(0, 0, 0, 0)" : "rgb(224, 242, 255)");
    await expect(page.locator("#canvas svg > rect").first()).toHaveAttribute("fill", fill);
  }
  await page.locator("#demo").selectOption("chronogram");
  await page.locator("#background-color").fill("#e0f2ff");
  await page.locator("#background-color").dispatchEvent("change");
  await page.locator("#background-transparent").setChecked(transparent);
  await expect(page.locator("[data-age-label]").first()).toHaveAttribute("stroke", fill);
  for (const scope of ["full", "viewport"]) {
    await page.locator("#export-scope").selectOption(scope);
    const text = await readFile(await download(page, "svg", testInfo, `${scope}-background.svg`), "utf8");
    const exported = await page.context().newPage();
    try {
      await exported.setContent(text);
      await expect(exported.locator(scope === "full" ? "svg > rect" : '[data-export-axis] > rect').first())
        .toHaveAttribute("fill", fill);
    } finally { await exported.close(); }
    const png = await readFile(await download(page, "png", testInfo, `${scope}-background.png`));
    const pixel = await page.evaluate(async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }, png.toString("base64"));
    expect(pixel).toEqual(transparent ? [0, 0, 0, 0] : [224, 242, 255, 255]);
  }
  const saved = await download(page, "save", testInfo, "background.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#background-color")).toHaveValue("#e0f2ff");
  await expect(page.locator("#background-transparent")).toBeChecked({ checked: transparent });
  await expect(page.locator("#canvas svg > rect").first()).toHaveAttribute("fill", fill);
  await page.locator("#style-settings > summary").click();
  await page.locator("#background-transparent").uncheck();
  await expect(page.locator("#background-color")).toBeEnabled();
  await expect(page.locator("#canvas svg > rect").first()).toHaveAttribute("fill", "#e0f2ff");
});
}

test("manual time confirmation is shown only when branch time needs confirmation", async ({ page }) => {
  await expect(page.locator("#branch-time-confirmation")).toBeHidden();
  for (const text of [
    "[&R](A:10,B:10)[&branch_length_unit=Ma,root_age=100];",
    "[&R](A:10,B:10)[&branch_length_unit=relative_time];",
    "[&R](A:10,B:10)[&age=100];",
    "[&R](A,B);",
    "[&R](A:10,B);",
    "[&U](A:10,B:10);"
  ]) {
    await upload(page, "hidden.tre", text);
    await expect(page.locator("#branch-time-confirmation")).toBeHidden();
    await expect(page.locator("#branch-time")).toBeHidden();
  }
  await upload(page, "dated.tre", "[&R](A:10,B:10)[&age=100];");
  await page.locator("#method").selectOption("branches");
  await expect(page.locator("#branch-time")).toBeVisible();
  await page.locator("#branch-time").check();
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
  await page.locator("#method").selectOption("auto");
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
  await expect(page.locator("#branch-time")).toBeVisible();
  await page.locator("#branch-time").uncheck();
  await expect(page.locator("#branch-time-confirmation")).toBeHidden();

  await upload(page, "anchored.tre", "[&R](A:10,B:10)[&root_age=100];");
  await expect(page.locator("#branch-time")).toBeVisible();
  await page.locator("#branch-time").check();
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
  await expect(page.locator("#branch-time")).toBeVisible();
  await page.locator("#branch-time").uncheck();
  await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
});

test("manual time evidence distinguishes relative durations and invalid anchors from generic branch lengths", async ({ page }) => {
  await upload(page, "relative.tre", "[&R]((A:10,B:10):20,C:30);");
  await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
  await page.locator("#branch-time").check();
  await expect(page.locator("#mode-badge")).toHaveText("Relative Chronogram");
  await expect(page.locator("#canvas svg")).not.toContainText("Ma");
  await page.locator("#branch-time").uncheck();
  await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
  await upload(page, "conflict.tre", "[&R]((A:10,B:10):20,C:30)[&root_age=-1,branch_length_unit=Ma];");
  await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
  await expect(page.locator("#diagnostics")).toContainText("年代檢核未通過");
  await expect(page.locator("#canvas svg")).not.toContainText("Ma");
  for (const [text, xs] of [["[&R](A:0,B:0);", [0, 0, 0]], ["[&R](A:1,B);", null]]) {
    await upload(page, "lengths.tre", text);
    await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
    if (xs) {
      const values = await page.locator('[data-layer="nodes"] > g > circle:first-child').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute("cx"))));
      expect(new Set(values).size).toBe(1);
    } else await expect(page.locator("#import-warnings")).toContainText("缺少枝長");
  }
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
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
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
  await expect(page.getByRole("button", { name: "使用說明", exact: true })).toHaveCount(0);
});

test("tree annotations stay English and omit instructional text in every mode", async ({ page }) => {
  const svg = page.locator("#canvas svg");
  for (const demo of ["chronogram", "dated", "relative", "phylogram", "cladogram"]) {
    await page.locator("#demo").selectOption(demo);
    const time = demo === "chronogram" || demo === "dated";
    if (time) await page.locator("#apply-time").click();
    await page.locator("#support").check();
    await page.locator("#root-stem").check();
    await expect(svg).not.toContainText(/[\u3400-\u9fff]/u);
    await expect(page.locator("#canvas svg > text")).toHaveCount(time ? 3 : 2);
    if (time) {
      await expect(svg.locator('[data-axis-title="time"]')).toHaveText("Age (Ma)");
      await expect(svg.locator(":scope > text").last()).toHaveText(/^Age range: [\d.]+–[\d.]+ Ma$/);
    }
    if (demo === "chronogram") {
      await expect(svg.locator('[data-label-kind="support"]').first()).toHaveText(/^Support: /);
      await page.locator("#simplified").check();
      await expect(page.locator("#canvas svg > text")).toHaveCount(3);
    }
    await page.locator("#search").fill("t0-n0");
    await page.locator("#find").click();
    await page.locator("#collapse").click();
    await expect(svg.locator('[data-label-kind="collapsed"]')).toHaveText(/^Collapsed: \d+ tips$/);
    await expect(svg).not.toContainText(/[\u3400-\u9fff]/u);
  }
  await upload(page, "original-branches.tre", "[&R](A:1,B:2);");
  await expect(page.locator("#file-summary")).toContainText("original-branches.tre");
  await expect(page.locator("#canvas svg > text")).toHaveCount(2);
  await expect(svg.locator(":scope > title")).toContainText("Branch length");
  await expect(svg).not.toContainText(/[\u3400-\u9fff]/u);
});

test("topology keeps import warnings visible without showing age diagnostics", async ({ page }) => {
  await upload(page, "duplicate-tips.tre", "[&R](A,A);");
  await expect(page.locator("#file-summary")).toContainText("duplicate-tips.tre");
  await expect(page.locator("#diagnostics-section")).toBeHidden();
  await expect(page.locator("#import-warnings")).toBeVisible();
  await expect(page.locator("#import-warnings")).toContainText("重複末端名稱");
  await expect(page.locator("#notice")).toContainText("Cladogram");
  await upload(page, "broken.tre", "(A,");
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#file-summary")).toContainText("duplicate-tips.tre");
  await expect(page.locator("#import-warnings")).toBeVisible();
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

test("age notes start collapsed, expand for editing and survive project restoration", async ({ page }, testInfo) => {
  await page.locator("#demo").selectOption("dated");
  const notes = page.locator("#evidence-settings"), field = page.locator("#evidence");
  const expectButtonSpacing = async () => {
    const gap = await notes.evaluate(el =>
      document.getElementById("apply-time").getBoundingClientRect().top - el.getBoundingClientRect().bottom
    );
    expect(gap).toBeGreaterThanOrEqual(14);
  };
  await expect(notes).not.toHaveAttribute("open");
  await expect(field).toBeHidden();
  await expectButtonSpacing();
  await notes.locator("summary").click();
  await expect(field).toBeVisible();
  await expectButtonSpacing();
  const size = await field.evaluate(el => ({
    height: el.getBoundingClientRect().height,
    width: el.getBoundingClientRect().width,
    available: el.parentElement.getBoundingClientRect().width,
    resize: getComputedStyle(el).resize
  }));
  expect(size.height).toBeGreaterThanOrEqual(160);
  expect(size.width).toBeCloseTo(size.available, 1);
  expect(size.resize).toBe("vertical");
  const text = ["Optional analysis notes", "Units: Ma", "Origin: original analysis"].join("\n");
  await field.fill(text);
  await page.locator("#apply-time").click();
  await notes.locator("summary").click();
  await expect(field).toBeHidden();
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
  const saved = await download(page, "save", testInfo, "age-notes.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#file-summary")).toContainText("dated-tree.nex");
  await expect(notes).not.toHaveAttribute("open");
  await expect(field).toHaveValue(text);
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
  await notes.locator("summary").click();
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(text);
});

test("tree name and age range toggle independently and persist in projects and exports", async ({ page }, testInfo) => {
  await demoTime(page);
  const title = page.locator('#canvas [data-label-kind="tree-name"]');
  const range = page.locator('#canvas [data-label-kind="age-range"]');
  await expect(page.locator("#tree-name")).toBeChecked();
  await expect(page.locator("#age-range")).toBeChecked();
  await expect(title).toHaveCount(1);
  await expect(range).toContainText("Age range:");
  const treeName = await title.textContent();
  const branches = await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML);
  await page.locator("#tree-name").uncheck();
  await expect(title).toHaveCount(0);
  await expect(range).toHaveCount(1);
  await page.locator("#tree-name").check();
  await page.locator("#age-range").uncheck();
  await expect(title).toHaveCount(1);
  await expect(range).toHaveCount(0);
  await page.locator("#tree-name").uncheck();
  expect(await page.locator('[data-layer="branches"]').evaluate(el => el.outerHTML)).toBe(branches);
  for (const scope of ["full", "viewport"]) {
    await page.locator("#export-scope").selectOption(scope);
    const svg = await readFile(await download(page, "svg", testInfo, `${scope}-hidden-labels.svg`), "utf8");
    const texts = await page.evaluate(text => [...new DOMParser().parseFromString(text, "image/svg+xml")
      .querySelectorAll("text")].map(el => el.textContent), svg);
    expect(texts.some(text => text.includes("Age range:"))).toBe(false);
    expect(texts.some(text => text.includes(treeName))).toBe(false);
  }
  const saved = await download(page, "save", testInfo, "hidden-labels.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#tree-name")).not.toBeChecked();
  await expect(page.locator("#age-range")).not.toBeChecked();
  await expect(title).toHaveCount(0);
  await expect(range).toHaveCount(0);
  await page.locator("#style-settings > summary").click();
  await page.locator("#tree-name").check();
  await page.locator("#age-range").check();
  await expect(title).toHaveCount(1);
  await expect(range).toHaveCount(1);
  await page.locator("#demo").selectOption("cladogram");
  await expect(page.locator("#age-range")).toBeHidden();
  await expect(range).toHaveCount(0);
  await expect(title).toHaveCount(1);
  await page.locator("#tree-name").uncheck();
  await expect(title).toHaveCount(0);
});

for (const mode of ["dated", "chronogram", "relative", "phylogram"]) {
  test(`${mode} compact mode preserves quantitative scale in projects and exports`, async ({ page }, testInfo) => {
    await page.locator("#demo").selectOption(mode);
    const svg = page.locator("#canvas svg");
    await expect(page.locator("#compact")).not.toBeChecked();
    const branches = await svg.locator('[data-layer="branches"]').evaluate(el => el.outerHTML);
    const grid = await svg.locator('[data-layer="grid"]').evaluate(el => el.outerHTML);
    await page.locator("#compact").check();
    await expect(svg.locator("[data-axis-title], [data-layer=grid]")).toHaveCount(0);
    const bar = svg.locator('[data-layer="scale-bar"]');
    await expect(bar).toHaveCount(1);
    await expect(svg.locator('[data-label-kind="tree-name"]')).toHaveAttribute("x",
      await bar.locator("text").getAttribute("x"));
    await expect(bar).toContainText(mode === "dated" || mode === "chronogram" ? "Ma" : mode === "relative" ? "Relative time" : "Branch length");
    if (mode === "relative" || mode === "phylogram") await expect(bar).not.toContainText("Ma");
    expect(await svg.locator('[data-layer="branches"]').evaluate(el => el.outerHTML)).toBe(branches);
    const geometry = await svg.evaluate(el => {
      const bar = el.querySelector('[data-layer="scale-bar"]');
      const line = bar.querySelector("line");
      const axisWidth = Number(el.querySelector("#tree-clip rect").getAttribute("width")) - 14;
      return { value: Number(bar.dataset.scaleValue), span: Number(bar.dataset.scaleSpan), axisWidth,
        length: Number(line.getAttribute("x2")) - Number(line.getAttribute("x1")) };
    });
    expect(geometry.value).toBeGreaterThan(0);
    expect(geometry.length).toBeCloseTo(geometry.value / geometry.span * geometry.axisWidth, 8);
    for (const scope of ["full", "viewport"]) {
      await page.locator("#export-scope").selectOption(scope);
      if (scope === "viewport") {
        await page.locator("#zoom-in").click();
        await page.locator("#canvas").evaluate(el => { el.scrollTop = 150; el.scrollLeft = 60; });
      }
      const text = await readFile(await download(page, "svg", testInfo, `${mode}-${scope}-compact.svg`), "utf8");
      const exported = await page.evaluate(text => {
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const header = doc.querySelector('[data-export-axis="viewport"]') ?? doc.documentElement;
        const bar = header.querySelector('[data-layer="scale-bar"]'), line = bar.querySelector("line");
        return { axes: doc.querySelectorAll("[data-axis-title], [data-layer=grid]").length,
          value: Number(bar.dataset.scaleValue), span: Number(bar.dataset.scaleSpan),
          length: Number(line.getAttribute("x2")) - Number(line.getAttribute("x1")) };
      }, text);
      expect(exported.axes).toBe(0);
      expect(exported.length).toBeCloseTo(exported.value / exported.span * geometry.axisWidth, 8);
      const png = await readFile(await download(page, "png", testInfo, `${mode}-${scope}-compact.png`));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
    const saved = await download(page, "save", testInfo, `${mode}-compact.json`);
    await page.reload();
    await page.locator("#file").setInputFiles(saved);
    await expect(page.locator("#compact")).toBeChecked();
    await expect(bar).toHaveCount(1);
    await page.locator("#style-settings > summary").click();
    await page.locator("#compact").uncheck();
    expect(await svg.locator('[data-layer="grid"]').evaluate(el => el.outerHTML)).toBe(grid);
    await page.locator("#demo").selectOption("cladogram");
    await expect(page.locator("#compact")).toBeHidden();
    await expect(page.locator("#compact")).toBeDisabled();
    await expect(bar).toHaveCount(0);
  });
}

test("compact scale bars handle tiny, zero and missing branch lengths without inventing units", async ({ page }) => {
  for (const [text, zero, missing] of [
    ["(A:0,B:0);", true, false],
    ["(A:1e-12,B:2e-12);", false, false],
    ["(A:0.1,B);", false, true]
  ]) {
    await upload(page, "scale.nwk", text);
    await page.locator("#compact").check();
    const bar = page.locator('#canvas [data-layer="scale-bar"]');
    await expect(bar).toContainText("Branch length:");
    await expect(bar).not.toContainText("Ma");
    if (zero) {
      await expect(bar).toContainText("0 (zero span)");
      await expect(bar.locator("line")).toHaveCount(0);
    } else {
      expect(Number(await bar.getAttribute("data-scale-value"))).toBeGreaterThan(0);
      await expect(bar.locator("line")).toHaveCount(3);
    }
    await expect(page.locator('#canvas [data-unknown-length="true"]')).toHaveCount(missing ? 1 : 0);
  }
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
  expect(exported).toContain("Decorative root stem (not a time duration)");
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

test("export resolutions match PNG pixels after scale, zoom, scroll and resize changes", async ({ page }, testInfo) => {
  await expect(page.locator("#full-resolution")).toHaveText("—");
  await expect(page.locator("#viewport-resolution")).toHaveText("—");
  await demoTime(page);
  const checkDownloads = async stage => {
    const layout = await page.locator(".export-resolution").evaluate(el => {
      const resolution = el.getBoundingClientRect();
      const button = document.getElementById("png").getBoundingClientRect();
      return { gap: resolution.left - button.right, centerOffset: (resolution.top + resolution.bottom - button.top - button.bottom) / 2 };
    });
    expect(layout.gap).toBe(6);
    expect(Math.abs(layout.centerOffset)).toBeLessThan(1);
    for (const [scope, id] of [["full", "full-resolution"], ["viewport", "viewport-resolution"]]) {
      await page.locator("#export-scope").selectOption(scope);
      const png = await readFile(await download(page, "png", testInfo, `${stage}-${scope}.png`));
      await expect(page.locator(`#${id}`)).toHaveText(`${png.readUInt32BE(16)} × ${png.readUInt32BE(20)} px`);
    }
  };
  await checkDownloads("initial");
  const initialFull = await page.locator("#full-resolution").textContent();
  await page.locator("#png-scale").selectOption("2");
  const [width, height] = initialFull.match(/\d+/g).map(Number);
  await expect(page.locator("#full-resolution")).toHaveText(`${width * 2} × ${height * 2} px`);
  const beforeZoom = await page.locator("#viewport-resolution").textContent();
  await page.locator("#zoom-in").click();
  await expect(page.locator("#viewport-resolution")).not.toHaveText(beforeZoom);
  await expect(page.locator("#full-resolution")).toHaveText(`${width * 2} × ${height * 2} px`);
  await checkDownloads("scaled-zoom");
  const beforeResize = await page.locator("#viewport-resolution").textContent();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#viewport-resolution")).not.toHaveText(beforeResize);
  await page.locator("#canvas").evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
  await checkDownloads("resized-scrolled");
  await page.locator("#search").fill("t0-n1"); await page.locator("#find").click();
  await page.locator("#collapse").click();
  await expect(page.locator("#full-resolution")).not.toHaveText(`${width * 2} × ${height * 2} px`);
  await checkDownloads("collapsed");
});

test("SVG, PNG, CSV and original downloads work offline", async ({ page }, testInfo) => {
  await demoTime(page);
  const checkAxisTitle = async locator => {
    const layout = await locator.evaluate(root => {
      const title = root.querySelector('[data-axis-title="time"]'), b = title.getBBox();
      const ticks = [...root.querySelectorAll("text")].filter(el => /^\d+(?:\.\d+)?$/.test(el.textContent));
      return {
        title: title.textContent, left: b.x, right: b.x + b.width, baseline: Number(title.getAttribute("y")),
        ticks: ticks.map(el => ({ left: el.getBBox().x, baseline: Number(el.getAttribute("y")), weight: getComputedStyle(el).fontWeight }))
      };
    });
    expect(layout.title).toBe("Age (Ma)");
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.ticks.length).toBeGreaterThan(0);
    for (const tick of layout.ticks) {
      expect(tick.weight).toBe("700");
      expect(tick.baseline).toBe(layout.baseline);
      expect(tick.left - layout.right).toBeGreaterThanOrEqual(10);
    }
  };
  await checkAxisTitle(page.locator("#canvas svg"));
  const svg = await readFile(await download(page, "svg", testInfo, "tree.svg"), "utf8");
  expect(svg).toContain("Age (Ma)");
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
  expect(original).toBe(await readFile(resolve("examples", "chronogram.nex"), "utf8"));
  await page.locator("#export-scope").selectOption("viewport");
  await page.locator("#zoom-in").click();
  await page.locator("#canvas").evaluate(el => { el.scrollTop = 100; });
  const viewportSVG = await readFile(await download(page, "svg", testInfo, "viewport.svg"), "utf8");
  expect(viewportSVG).toContain('data-export-axis="viewport"');
  expect(viewportSVG).toContain("Age (Ma)");
  expect(viewportSVG).toContain("Current view");
  expect(viewportSVG).not.toMatch(/[\u3400-\u9fff]/u);
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
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await expect(page.locator("#node-info")).toContainText("t0-n1");
  await expect(page.locator("#method")).toHaveValue("auto");
  await expect(page.locator("#canvas")).toContainText("Collapsed: 2 tips");
  await expect(page.locator("#grid-step")).toHaveValue("10");
  await page.locator("#expand-all").click();
  await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(29);
});

test("age controls need no notes or checkbox and only prompt for an unknown root", async ({ page }, testInfo) => {
  const tree = "(A[&age_mean=0],B[&age_mean=20])[&age_mean=100];";
  await upload(page, "rooted.tre", "[&R]" + tree);
  await expect(page.locator("#confirmed")).toHaveCount(0);
  await expect(page.locator("#root-status")).toBeHidden();
  await expect(page.locator("#evidence")).toHaveValue("");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await fillEvidence(page, "Optional provenance");
  await page.locator("#evidence").press("Tab");
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await upload(page, "unknown.tre", tree);
  await expect(page.locator("#root-status")).toBeVisible();
  await expect(page.locator("#root-confirmed")).toHaveValue("unknown");
  await expect(page.locator("#apply-time")).toBeHidden();
  await expect(page.locator("#mode-badge")).toHaveText("Cladogram");
  await expect(page.locator("#diagnostics")).toContainText("使用目前的根");
  await page.locator("#root-confirmed").selectOption("rooted");
  await expect(page.locator("#apply-time")).toBeVisible();
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  const saved = await download(page, "save", testInfo, "unknown-root.json");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#root-confirmed")).toHaveValue("rooted");
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await page.locator("#root-confirmed").selectOption("unknown");
  await expect(page.locator("#apply-time")).toBeHidden();
  await expect(page.locator("#mode-badge")).toHaveText("Cladogram");
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
    await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
    await expect(page.locator('[data-layer="nodes"] > g')).toHaveCount(29);
  }
});

const phyloxml = `<phyloxml xmlns="http://www.phyloxml.org"><phylogeny rooted="true"><name>XML tree</name><clade><name>root</name><property ref="age_mean">100</property><clade branch_length="1"><name>Fossil</name><property ref="age_mean">20</property></clade><clade><name>Recent</name><branch_length>2</branch_length><property ref="age_mean">0</property></clade></clade></phylogeny></phyloxml>`;
const nexml = `<nex:nexml xmlns:nex="http://www.nexml.org/2009" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><nex:otus id="o"><nex:otu id="oa" label="Fossil"/><nex:otu id="ob" label="Recent"/></nex:otus><nex:trees otus="o"><nex:tree id="t" label="NeXML tree"><nex:node id="r" root="true"><nex:meta property="age_mean" content="100"/></nex:node><nex:node id="a" otu="oa"><nex:meta property="age_mean" content="20"/></nex:node><nex:node id="b" otu="ob"><nex:meta property="age_mean" content="0"/></nex:node><nex:edge id="e1" source="r" target="a" length="80"/><nex:edge id="e2" source="r" target="b" length="100"/></nex:tree></nex:trees></nex:nexml>`;
for (const [name, text] of [
  ["plain.nwk", "((A:1e-15,B:2e-15):3e-15,C:4e-15);"],
  ["tiny.nwk", "[&R](A:1e-300,B:2e-300);"],
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
    await expect(page.locator("#mode-badge")).toHaveText(name === "beast.tre" || name.endsWith("xml") ? "Dated Tree" : "Phylogram");
    if (name === "plain.nwk") {
      const span = await page.locator('[data-layer="nodes"] > g > circle:first-child').evaluateAll(nodes => {
        const xs = nodes.map(n => Number(n.getAttribute("cx")));
        return Math.max(...xs) - Math.min(...xs);
      });
      expect(span).toBeGreaterThan(200);
      const positions = await page.locator('[data-layer="nodes"] > g').evaluateAll(nodes =>
        Object.fromEntries(nodes.map(node => [node.getAttribute("aria-label"), Number(node.querySelector("circle").getAttribute("cx"))])));
      expect(positions.B).toBeGreaterThan(positions.A);
      expect(positions.A).toBeCloseTo(positions.C, 5);
    }
    if (name.endsWith("xml")) {
      await fillEvidence(page, "Synthetic XML: age_mean is Ma before present");
      await page.locator("#apply-time").click();
      await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await expect(page.locator("[data-age-label]")).not.toHaveCount(0);
});

test("time branches use fixed Ma and unsupported project units cannot replace the open chart", async ({ page }, testInfo) => {
  await upload(page, "branches.tre", "[&R]((A:50,B:30):50,C:100)[&age_mean=100]:999;");
  await expect(page.locator("#mode-badge")).toHaveText("Phylogram");
  await page.locator("#method").selectOption("branches");
  await page.locator("#branch-time").check();
  await fillEvidence(page, "Synthetic: Ma time branches with a 100 Ma root anchor.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
    await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
    await expect(page.locator('[data-age-label="t0-n3"]')).toHaveText("20 Ma");
  }
});

test("fossil zero correction shifts real MrBayes data and survives exports and restore", async ({ page }, testInfo) => {
  const file = resolve("examples", "dated-tree.nex");
  await page.locator("#file").setInputFiles(file);
  await expect(page.locator("#file-summary")).toContainText("dated-tree.nex");
  await expect(page.locator("#zero-range-enabled, #zero-younger, #zero-older")).toHaveCount(0);
  await page.locator("#zero-age").fill("380");
  await fillEvidence(page, "Technical regression only: illustrative fossil zero=380 Ma, not a scientific calibration.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
  expect(project.schemaVersion).toBe(3);
  await upload(page, "old-project.json", JSON.stringify({ ...project, schemaVersion: 1 }));
  await expect(page.locator("#notice")).toContainText("不支援的專案格式或版本");
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("380 Ma");
  await page.reload();
  await page.locator("#file").setInputFiles(saved);
  await expect(page.locator("#zero-age")).toHaveValue("380");
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
  await expect(page.locator('[data-age-label="t0-n4"]')).toHaveText("380 Ma");
  const svg = await readFile(await download(page, "svg", testInfo, "corrected.svg"), "utf8");
  expect(svg).toContain("380 Ma");
  await page.locator("#zero-age").fill("390");
  await page.locator("#zero-age").press("Tab");
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
  await page.locator("#zero-age").fill("-1");
  await page.locator("#zero-age").press("Tab");
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("Dated Tree");
});

test("origin input modes show one age or two unordered endpoints and restore the selected mode", async ({ page }, testInfo) => {
  await demoTime(page);
  await expect(page.locator("#zero-age-single")).toBeChecked();
  await expect(page.locator(".zero-age-settings legend")).toHaveText("檔案中的 0 代表何時？");
  await expect(page.locator("#zero-age-first-label")).toHaveText("距今年代（Ma）");
  await expect(page.locator("#zero-age-summary")).toHaveText("檔案中的 0＝現在（0 Ma）");
  await expect(page.locator("#zero-age-help")).toContainText("若 0 代表現在，填 0");
  await expect(page.locator("#zero-age-second")).toBeHidden();
  await expect(page.locator("#zero-age-second")).toBeDisabled();
  await expect(page.locator("#zero-age-second")).toHaveValue("");
  await page.getByLabel("年代範圍（取中點）", { exact: true }).check();
  await expect(page.locator("#zero-age-first-label")).toHaveText("端點 A（Ma）");
  await expect(page.getByLabel("端點 B（Ma）", { exact: true })).toBeVisible();
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
  await expect(page.locator("#zero-age-summary")).toContainText("採用中點");
  await expect(page.locator("#zero-age-help")).toContainText("以中點作為代表年代");
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
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
  await page.locator("#zero-age-second").fill("");
  await expect(page.locator("#zero-age-summary")).toContainText("請填入兩個端點");
  await page.locator("#apply-time").click();
  await expect(page.locator("#notice")).toHaveClass("error");
  await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
  await page.getByLabel("已知年代", { exact: true }).check();
  await expect(page.locator("#zero-age-second")).toBeHidden();
  await expect(page.locator("#zero-age-summary")).toHaveText("檔案中的 0＝398 Ma");
  await expect(page.locator("#zero-age-first-label")).toHaveText("距今年代（Ma）");
  await expect(page.locator("#zero-age-help")).toContainText("最年輕化石");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("498 Ma");
  await page.getByLabel("年代範圍（取中點）", { exact: true }).check();
  await page.locator("#zero-age-second").fill("0");
  await expect(page.locator("#zero-age-summary")).toContainText("199 Ma");
  await page.locator("#apply-time").click();
  await expect(page.locator('[data-age-label="t0-n0"]')).toHaveText("299 Ma");
  await page.getByLabel("已知年代", { exact: true }).check();
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
  await page.locator("#file").setInputFiles(resolve("examples", "dated-tree.nex"));
  await expect(page.locator("#file-summary")).toContainText("dated-tree.nex");
  await page.locator("#zero-age").fill("385");
  await fillEvidence(page, "Layout regression: illustrative 385 Ma origin only.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
    await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
    await checkLayout();
  }
});

test("automatic horizontal range spreads fossil trees and persists with readable axis labels", async ({ page }, testInfo) => {
  // Keep file reading asynchronous long enough to expose edits made before import finishes.
  await page.evaluate(() => {
    const arrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await new Promise(resolve => setTimeout(resolve, 500));
      return arrayBuffer.call(this);
    };
  });
  await page.locator("#file").setInputFiles(resolve("examples", "dated-tree.nex"));
  await expect(page.locator("#file-summary")).toContainText("dated-tree.nex");
  await page.locator("#zero-age").fill("385");
  await fillEvidence(page, "Horizontal layout regression only: illustrative 385 Ma origin.");
  await page.locator("#apply-time").click();
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
  await expect(page.locator("#mode-badge")).toHaveText(/^(?:Dated Tree|Chronogram)$/);
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
