import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: ["src/app.ts"], bundle: true, minify: true, write: false, metafile: true,
  platform: "browser", format: "iife", target: ["chrome120", "edge120"], legalComments: "inline",
  loader: { ".nex": "text", ".tre": "text" }
});
const licenses = [];
const packages = new Set();
const bundledInputs = new Set(Object.values(result.metafile.outputs).flatMap(output =>
  Object.entries(output.inputs).filter(([, info]) => info.bytesInOutput > 0).map(([name]) => name)));
for (const input of bundledInputs) {
  if (!input.includes("node_modules/")) continue;
  const parts = input.split("/");
  const index = parts.lastIndexOf("node_modules");
  const end = parts[index + 1].startsWith("@") ? index + 3 : index + 2;
  const dir = path.join(...parts.slice(0, end));
  if (packages.has(dir)) continue;
  packages.add(dir);
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  let license;
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "COPYING"]) {
    try { license = await readFile(path.join(dir, name), "utf8"); break; }
    catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  if (!license && pkg.name === "@nodable/entities" && pkg.version === "3.1.0") {
    license = await readFile("third-party/nodable-entities-LICENSE", "utf8");
  }
  if (!license) throw new Error(`Missing license text for bundled package ${pkg.name}; review before distribution.`);
  licenses.push(`${pkg.name} ${pkg.version}\n${license}`);
}
const escapeHTML = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const template = await readFile("src/index.html", "utf8");
const css = await readFile("src/style.css", "utf8");
const icon = `data:image/png;base64,${(await readFile("src/icon.png")).toString("base64")}`;
const projectLicense = await readFile("LICENSE", "utf8");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = template.replace("/*APP_STYLE*/", () => css).replace("/*APP_LICENSES*/", () => escapeHTML(licenses.sort().join("\n\n" + "=".repeat(60) + "\n\n")))
  .replace("/*APP_ICON*/", () => icon)
  .replace("/*PROJECT_LICENSE*/", () => escapeHTML(projectLicense))
  .replace("/*APP_SCRIPT*/", () => script);
await mkdir("dist", { recursive: true });
await writeFile("dist/paleo-phylotree.html", html, "utf8");
console.log(`Built dist/paleo-phylotree.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB); ${packages.size} bundled package licenses.`);
