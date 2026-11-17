import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const url = pathToFileURL(resolve("dist", "paleo-phylotree.html")).href;
async function upload(page, name, text) {
  await page.locator("#file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
}
async function save(page, testInfo, name) {
  const pending = page.waitForEvent("download");
  await page.locator("#save").click();
  const download = await pending, file = testInfo.outputPath(name);
  await download.saveAs(file);
  return readFile(file, "utf8");
}

for (const language of ["zh-TW", "zh-CN", "en-US", "fr-FR", "ja-JP"]) {
  test.describe(`Browser language ${language}`, () => {
    test.use({ locale: language });
    test("localizes static controls, dynamic messages and validation without network requests", async ({ page }) => {
      const chinese = language.startsWith("zh"), requests = [], errors = [];
      page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(url);
      await expect(page.locator("html")).toHaveAttribute("lang", chinese ? "zh-Hant" : "en");
      await expect(page).toHaveTitle(chinese ? "PaleoTree — 種系樹檢視器" : "PaleoTree — Phylogenetic Tree Viewer");
      await expect(page.getByRole("button", { name: chinese ? "開啟檔案" : "Open file", exact: true })).toBeVisible();
      await expect(page.locator("#format option[value=nexus]")).toHaveText("NEXUS / MrBayes");
      await expect(page.locator("#search")).toHaveAttribute("placeholder", chinese ? "搜尋分類群或節點 ID" : "Search taxa or node IDs");
      await expect(page.locator("#resize-settings")).toHaveAttribute("aria-label", chinese ? "調整左側窗格寬度" : "Resize left pane");
      if (!chinese) {
        expect(await page.locator("body").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
        for (const attribute of ["placeholder", "aria-label", "title"]) {
          const values = await page.locator(`[${attribute}]`).evaluateAll((els, attr) => els.map(el => el.getAttribute(attr)), attribute);
          expect(values.join(" ")).not.toMatch(/[\u3400-\u9fff]/u);
        }
      }
      for (const [value, mode] of [["dated", "Dated Tree"], ["relative", "Relative Chronogram"], ["phylogram", "Phylogram"], ["cladogram", "Cladogram"], ["chronogram", "Chronogram"]]) {
        await page.locator("#demo").selectOption(value);
        await expect(page.locator("#mode-badge")).toHaveText(mode);
        await expect(page.locator("#apply-time")).toBeVisible({ visible: value === "dated" || value === "chronogram" });
        if (!chinese) expect(await page.locator("body").innerText()).not.toMatch(/[\u3400-\u9fff]/u);
      }
      await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
      await expect(page.locator("#notice")).toHaveText(chinese ? "已載入範例：Chronogram。" : "Example loaded: Chronogram.");
      await expect(page.locator("#apply-time")).toHaveText(chinese ? "重新判定與套用 Chronogram" : "Reclassify and apply Chronogram");
      await expect(page.locator("#source-status")).toContainText(chinese ? "時間枝長＋既有年代錨點" : "Time branch lengths + existing age anchors");
      await page.locator("#search").fill("OTU01");
      await page.locator("#find").click();
      await expect(page.locator("#node-info")).toContainText(chinese ? "距今年代（Ma，完整精度）" : "Age before present (Ma, full precision)");
      await expect(page.locator("#node-info")).toContainText("OTU01");
      await page.locator("#style-settings > summary").click();
      await page.locator("#grid-step").fill("0");
      await page.locator("#grid-step").press("Tab");
      await expect(page.locator("#notice")).toHaveClass("error");
      await expect(page.locator("#notice")).toContainText(chinese ? "有效數值" : "valid number");
      await upload(page, "invalid.tre", "(A:-1,B);");
      await expect(page.locator("#notice")).toContainText(chinese ? "枝長必須是非負有限數值" : "Branch lengths must be finite non-negative numbers");
      await expect(page.locator("#mode-badge")).toHaveText("Chronogram");
      await upload(page, "conflict.tre", "[&R](A[&age=50],B[&age=0])[&age=40];");
      await expect(page.locator("#diagnostics")).toContainText(chinese ? "比父節點" : "older than parent");
      await upload(page, "duplicates.tre", "[&R](A,A);");
      await expect(page.locator("#import-warnings")).toContainText(chinese ? "重複末端名稱" : "Duplicate tip names");
      expect(errors).toEqual([]);
      expect(requests).toEqual([]);
    });
  });
}

test("a project saved in Chinese restores in English without translating original data or chart text", async ({ browser }, testInfo) => {
  const contexts = await Promise.all(["zh-TW", "en-US"].map(locale => browser.newContext({ locale, offline: true })));
  try {
    const zh = await contexts[0].newPage(), en = await contexts[1].newPage();
    await Promise.all([zh.goto(url), en.goto(url)]);
    const source = "[&R]('原始名稱'[&age=20],B[&age=0])[&age=100];";
    await upload(zh, "研究資料.tre", source);
    await zh.locator("#evidence-settings > summary").click();
    await zh.locator("#evidence").fill("原始備註 Original notes");
    await zh.locator("#evidence").press("Tab");
    const projectText = await save(zh, testInfo, "chinese-project.json");
    expect(projectText).not.toContain('"locale"');
    await upload(en, "project.json", projectText);
    await expect(en.locator("html")).toHaveAttribute("lang", "en");
    await expect(en.locator("#notice")).toContainText("Project settings restored.");
    await expect(en.locator("#evidence")).toHaveValue("原始備註 Original notes");
    await expect(en.locator('[data-label-kind="name"]').first()).toHaveText("原始名稱");
    await expect(en.locator("#canvas svg [data-axis-title]")).toHaveText("Age (Ma)");
    await en.locator("#search").fill("原始名稱");
    await en.locator("#find").click();
    await expect(en.locator("#node-info")).toContainText("Node / taxon");
    await expect(en.locator("#node-info")).toContainText("原始名稱");
    const restored = JSON.parse(await save(en, testInfo, "english-project.json"));
    expect(restored.source.content).toBe(source);
    expect(restored.options.evidence).toBe("原始備註 Original notes");
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
