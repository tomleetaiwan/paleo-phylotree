import { t } from "./i18n.ts";
import { LIMITS } from "./model.ts";
import type { Annotation, SourceDocument, Tree, TreeNode } from "./model.ts";

export class ImportError extends Error {
  constructor(message: string, text?: string, offset?: number) {
    let location = "";
    if (text !== undefined && offset !== undefined) {
      const before = text.slice(0, offset).split("\n");
      location = t("（行 {0}，列 {1}）", before.length, before.at(-1)!.length + 1);
    }
    super(t("解析：{0}{1}。請檢查格式與原始輸出。", message, location));
    this.name = "ImportError";
  }
}

interface Token { value: string; kind: "word" | "symbol" | "comment" | "tag"; quoted?: boolean; pos: number }
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const pos = i, c = text[i++];
    if (c === "'" || c === '"') {
      let value = "", closed = false;
      while (i < text.length) {
        if (text[i] === c) {
          i++;
          if (text[i] === c) { value += c; i++; }
          else { closed = true; break; }
        } else value += text[i++];
      }
      if (!closed) throw new ImportError(t("引號未結束"), text, pos);
      tokens.push({ value, kind: "word", quoted: true, pos });
    } else if (c === "[" || c === "{") {
      const close = c === "[" ? "]" : "}";
      const quotedValues = c === "{" || /^\s*&/.test(text.slice(i, i + 32));
      let depth = 1, value = "", quote = "";
      while (i < text.length && depth) {
        const ch = text[i++];
        if (quote) {
          if (ch === quote) {
            if (text[i] === quote) { value += ch + text[i++]; continue; }
            quote = "";
          }
        } else if (quotedValues && (ch === "'" || ch === '"')) quote = ch;
        else if (ch === c) depth++;
        else if (ch === close) depth--;
        if (depth) value += ch;
        if (value.length > LIMITS.annotation) throw new ImportError(t("註解超過 65,536 字元"), text, pos);
      }
      if (depth || quote) throw new ImportError(t("註解未結束"), text, pos);
      tokens.push({ value, kind: c === "[" ? "comment" : "tag", pos });
    } else if ("(),:;=*".includes(c)) {
      tokens.push({ value: c, kind: "symbol", pos });
    } else {
      while (i < text.length && !/[\s()[\]{},:;=*'"]/.test(text[i])) i++;
      tokens.push({ value: text.slice(pos, i), kind: "word", pos });
    }
    if (tokens.length > 2_000_000) throw new ImportError(t("詞彙數量超出安全限制"));
  }
  return tokens;
}

function splitValues(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) i++;
        else quote = "";
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth < 0) throw new ImportError(t("註解陣列括號不匹配")); }
    else if (c === delimiter && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (depth || quote) throw new ImportError(t("註解陣列或字串未結束"));
  parts.push(text.slice(start).trim());
  return parts;
}

function annotationValue(text: string, depth = 0): Annotation {
  if (depth > 32) throw new ImportError(t("註解陣列深度超限"));
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new ImportError(t("註解陣列未結束"));
    return splitValues(text.slice(1, -1), ",").map(s => annotationValue(s, depth + 1));
  }
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    const q = text[0];
    return text.slice(1, -1).replaceAll(q + q, q);
  }
  if (numeric.test(text)) return Number(text);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  return text;
}

function annotate(node: TreeNode, token: Token) {
  node.rawAnnotations.push(token.value);
  if (token.kind === "tag") {
    node.annotations.hyphy = token.value;
    return;
  }
  const nhx = token.value.startsWith("&&NHX:");
  if (!nhx && !token.value.startsWith("&")) return;
  const content = token.value.slice(nhx ? 6 : 1);
  for (const pair of splitValues(content, nhx ? ":" : ",")) {
    const equal = pair.indexOf("=");
    if (equal < 0) continue;
    const key = pair.slice(0, equal).trim();
    if (!key) throw new ImportError(t("空白註解鍵"));
    Object.defineProperty(node.annotations, key, {
      value: annotationValue(pair.slice(equal + 1).trim()), enumerable: true, configurable: true, writable: true
    });
  }
  const prob = node.annotations.prob;
  if (typeof prob === "number") node.support = prob;
}

class TreeReader {
  tokens: Token[];
  text: string;
  index = 0;
  nodes: TreeNode[] = [];
  treeId: string;
  translation: Map<string, string>;
  rooted: boolean | null = null;
  constructor(tokens: Token[], text: string, treeId: string, translation = new Map<string, string>()) {
    this.tokens = tokens; this.text = text; this.treeId = treeId; this.translation = translation;
  }
  fail(message: string): never { throw new ImportError(message, this.text, this.tokens[this.index]?.pos ?? this.text.length); }
  is(value: string) { const t = this.tokens[this.index]; return t?.kind === "symbol" && t.value === value; }
  comments(node?: TreeNode) {
    while (["comment", "tag"].includes(this.tokens[this.index]?.kind)) {
      const token = this.tokens[this.index++];
      if (/^&[RU]$/i.test(token.value)) this.rooted = token.value.toUpperCase() === "&R";
      else if (node) annotate(node, token);
    }
  }
  read(parentId: string | null, depth: number): TreeNode {
    if (depth > LIMITS.depth) this.fail(t("樹深度超過 512"));
    this.comments();
    const node: TreeNode = {
      id: `${this.treeId}-n${this.nodes.length}`, parentId, children: [], name: "",
      length: null, support: null, annotations: {}, rawAnnotations: []
    };
    this.nodes.push(node);
    if (this.nodes.length > LIMITS.nodes) this.fail(t("節點超過 200,000"));
    const internal = this.is("(");
    if (internal) {
      this.index++;
      node.children.push(this.read(node.id, depth + 1).id);
      while (this.is(",")) { this.index++; node.children.push(this.read(node.id, depth + 1).id); }
      if (!this.is(")")) this.fail(t("缺少右括號"));
      this.index++;
    }
    const token = this.tokens[this.index];
    if (token?.kind === "word") {
      node.name = token.value; this.index++;
      if (!internal && this.translation.size) {
        if (!this.translation.has(node.name)) this.fail(t("TRANSLATE 缺少分類群 {0}", node.name));
        node.name = this.translation.get(node.name)!;
      }
      if (internal && !token.quoted && numeric.test(node.name)) node.support = Number(node.name);
    } else if (!internal) this.fail(t("缺少末端名稱"));
    this.comments(node);
    if (this.is(":")) {
      this.index++;
      const length = this.tokens[this.index++];
      if (!length || length.kind !== "word" || !numeric.test(length.value) || !Number.isFinite(Number(length.value)) || Number(length.value) < 0) {
        this.fail(t("枝長必須是非負有限數值"));
      }
      node.length = Number(length.value);
      this.comments(node);
    }
    return node;
  }
  parse(name: string, forcedRoot: boolean | null = null): Tree {
    const root = this.read(null, 0);
    if (!root.children.length) this.fail(t("不支援單節點或非樹敘述"));
    if (this.index !== this.tokens.length) this.fail(t("樹定義尾端有未預期內容"));
    return finishTree({ id: this.treeId, name, rootId: root.id, rooted: forcedRoot ?? this.rooted, nodes: this.nodes, warnings: [] });
  }
}

function finishTree(tree: Tree): Tree {
  const names = new Set<string>();
  const duplicates = new Set<string>();
  let tips = 0;
  for (const n of tree.nodes) if (!n.children.length) {
    tips++;
    if (names.has(n.name)) duplicates.add(n.name);
    names.add(n.name);
  }
  if (tips > LIMITS.tips) throw new ImportError(t("單棵樹超過 1,000 個末端 OTU"));
  if (duplicates.size) tree.warnings.push(t("重複末端名稱（以 ID 區分）：{0}", [...duplicates].slice(0, 10).join("、")));
  return tree;
}

function statements(tokens: Token[], text: string): Token[][] {
  const result: Token[][] = [];
  let start = 0;
  tokens.forEach((t, i) => {
    if (t.kind === "symbol" && t.value === ";") { result.push(tokens.slice(start, i)); start = i + 1; }
  });
  if (tokens.slice(start).some(t => t.kind !== "comment")) throw new ImportError(t("敘述缺少結尾分號"), text, tokens[start]?.pos);
  return result;
}

function parseText(text: string, format: string): Tree[] {
  const tokens = lex(text.replace(/^\uFEFF/, ""));
  const trees: Tree[] = [];
  const addTree = (ts: Token[], name: string, translate?: Map<string, string>, rooted: boolean | null = null) => {
    if (trees.length >= LIMITS.trees) throw new ImportError(t("檔案超過 100 棵樹"));
    trees.push(new TreeReader(ts, text, `t${trees.length}`, translate).parse(name, rooted));
    if (trees.reduce((s, t) => s + t.nodes.length, 0) > LIMITS.nodes) throw new ImportError(t("總節點超過 200,000"));
  };
  if (format !== "nexus") {
    for (const statement of statements(tokens, text)) {
      if (statement.some(t => t.kind !== "comment")) addTree(statement, `Tree ${trees.length + 1}`);
    }
  } else {
    if (tokens[0]?.value.toUpperCase() === "#NEXUS") tokens.shift();
    let block = "", translate = new Map<string, string>();
    for (const raw of statements(tokens, text)) {
      const s = raw.filter(t => t.kind !== "comment");
      if (!s.length) continue;
      const cmd = s[0].value.toUpperCase();
      if (cmd === "BEGIN") {
        if (block) throw new ImportError(t("NEXUS 區塊不可巢狀"));
        block = s[1]?.value.toUpperCase() ?? "";
        translate = new Map();
      } else if (cmd === "END" || cmd === "ENDBLOCK") { block = ""; translate = new Map(); }
      else if (block === "TREES" && cmd === "TRANSLATE") {
        if (translate.size) throw new ImportError(t("同一區塊重複 TRANSLATE"));
        let i = 1;
        while (i < s.length) {
          const key = s[i++], value = s[i++];
          if (key?.kind !== "word" || value?.kind !== "word" || translate.has(key.value)) throw new ImportError(t("TRANSLATE 對照無效"));
          translate.set(key.value, value.value);
          if (i < s.length) {
            if (s[i++].value !== ",") throw new ImportError(t("TRANSLATE 缺少逗號"));
          }
        }
      } else if (block === "TREES" && (cmd === "TREE" || cmd === "UTREE")) {
        const equal = raw.findIndex(t => t.kind === "symbol" && t.value === "=");
        const header = s.slice(1, s.findIndex(t => t.kind === "symbol" && t.value === "=")).filter(t => t.value !== "*" || t.quoted);
        if (equal < 0 || header.length !== 1 || header[0].kind !== "word") throw new ImportError(t("TREE 名稱或等號無效"));
        addTree(raw.slice(equal + 1), header[0].value, translate, cmd === "UTREE" ? false : null);
      }
    }
    if (block) throw new ImportError(t("NEXUS 區塊缺少 END"));
  }
  if (!trees.length) throw new ImportError(t("沒有可顯示的樹；NEXUS 須含 TREES，DATA／CHARACTERS 本身不是樹"));
  return trees;
}

const children = (e: Element, local: string) => [...e.children].filter(c => c.localName === local);
const first = (e: Element, local: string) => children(e, local)[0];
const textOf = (e: Element, local: string) => first(e, local)?.textContent?.trim() ?? "";

function parseXML(text: string, forced: string): { format: string; trees: Tree[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ImportError(t("禁止 XML DTD／外部實體"));
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new ImportError(t("XML 語法損毀"));
  for (const el of [...xml.getElementsByTagName("*")]) {
    for (const attr of [...el.attributes]) {
      if ((/^(href|src|schemaLocation)$/i.test(attr.localName) && /^(https?:|file:|\/\/)/i.test(attr.value)) ||
        /^on/i.test(attr.name)) throw new ImportError(t("XML 含外部資源或可執行屬性"));
    }
  }
  const root = xml.documentElement;
  const detected = root.localName.toLowerCase();
  const format = forced === "auto" ? detected : forced;
  if (format !== detected) throw new ImportError(t("指定格式與 XML 根元素不相符"));
  const trees: Tree[] = [];
  if (format === "phyloxml") {
    for (const phylogeny of children(root, "phylogeny")) {
      if (trees.length >= LIMITS.trees) throw new ImportError(t("檔案超過 100 棵樹"));
      const treeId = `t${trees.length}`, nodes: TreeNode[] = [];
      const walk = (clade: Element, parentId: string | null, depth: number): TreeNode => {
        if (depth > LIMITS.depth) throw new ImportError(t("樹深度超過 512"));
        const rawLength = clade.getAttribute("branch_length") ?? textOf(clade, "branch_length");
        const node: TreeNode = {
          id: `${treeId}-n${nodes.length}`, parentId, children: [],
          name: textOf(clade, "name") || (first(clade, "taxonomy") ? textOf(first(clade, "taxonomy"), "scientific_name") : ""),
          length: rawLength ? checkedLength(rawLength) : null,
          support: null, annotations: {}, rawAnnotations: []
        };
        nodes.push(node);
        if (nodes.length + trees.reduce((sum, t) => sum + t.nodes.length, 0) > LIMITS.nodes) throw new ImportError(t("總節點超過 200,000"));
        for (const prop of children(clade, "property")) {
          const key = prop.getAttribute("ref") || "property";
          Object.defineProperty(node.annotations, key, { value: annotationValue(prop.textContent?.trim() ?? ""), enumerable: true });
        }
        for (const confidence of children(clade, "confidence")) {
          const value = confidence.textContent?.trim() ?? "";
          node.annotations[`confidence:${confidence.getAttribute("type") || "unknown"}`] = annotationValue(value);
          if (numeric.test(value)) node.support = Number(value);
        }
        node.children = children(clade, "clade").map(c => walk(c, node.id, depth + 1).id);
        return node;
      };
      const roots = children(phylogeny, "clade");
      if (roots.length !== 1) throw new ImportError(t("PhyloXML 每棵樹須有唯一根 clade"));
      const nr = walk(roots[0], null, 0);
      const rooted = phylogeny.getAttribute("rooted");
      trees.push(finishTree({ id: treeId, name: textOf(phylogeny, "name") || `Tree ${trees.length + 1}`, rootId: nr.id, rooted: rooted === null ? null : rooted === "true" || rooted === "1", nodes, warnings: [] }));
    }
  } else if (format === "nexml") {
    for (const block of children(root, "trees")) {
      const otuBlock = children(root, "otus").find(e => e.id === block.getAttribute("otus"));
      const otus = new Map(otuBlock ? children(otuBlock, "otu").map(e => [e.id, e.getAttribute("label") ?? e.id]) : []);
      if (children(block, "network").length) throw new ImportError(t("NeXML 網狀結構不屬於樹"));
      for (const elem of children(block, "tree")) {
        if (trees.length >= LIMITS.trees) throw new ImportError(t("檔案超過 100 棵樹"));
        const treeId = `t${trees.length}`, nodes: TreeNode[] = [], idMap = new Map<string, TreeNode>();
        for (const el of children(elem, "node")) {
          const sourceId = el.id;
          if (!sourceId || idMap.has(sourceId)) throw new ImportError(t("NeXML node ID 缺少或重複"));
          const otu = el.getAttribute("otu");
          if (otu && !otus.has(otu)) throw new ImportError(t("NeXML OTU 對照不存在"));
          const node: TreeNode = { id: `${treeId}-n${nodes.length}`, parentId: null, children: [], name: otu ? otus.get(otu)! : el.getAttribute("label") ?? "", length: null, support: null, annotations: {}, rawAnnotations: [] };
          for (const meta of children(el, "meta")) {
            const key = meta.getAttribute("property") ?? meta.getAttribute("rel") ?? "meta";
            Object.defineProperty(node.annotations, key, { value: annotationValue(meta.getAttribute("content") ?? meta.textContent ?? ""), enumerable: true });
          }
          nodes.push(node); idMap.set(sourceId, node);
          if (nodes.length + trees.reduce((sum, t) => sum + t.nodes.length, 0) > LIMITS.nodes) throw new ImportError(t("總節點超過 200,000"));
        }
        for (const edge of children(elem, "edge")) {
          const source = idMap.get(edge.getAttribute("source") ?? ""), target = idMap.get(edge.getAttribute("target") ?? "");
          if (!source || !target || target.parentId !== null) throw new ImportError(t("NeXML 含無效邊或多重父節點"));
          target.parentId = source.id; source.children.push(target.id);
          if (edge.hasAttribute("length")) target.length = checkedLength(edge.getAttribute("length")!);
        }
        const roots = nodes.filter(n => n.parentId === null);
        if (roots.length !== 1) throw new ImportError(t("NeXML 須為連通且唯一根的樹"));
        const map = new Map(nodes.map(n => [n.id, n])), visited = new Set<string>();
        const visit = (n: TreeNode, depth: number) => {
          if (depth > LIMITS.depth || visited.has(n.id)) throw new ImportError(t("NeXML 循環或樹深度超過 512"));
          visited.add(n.id); for (const id of n.children) visit(map.get(id)!, depth + 1);
        };
        visit(roots[0], 0);
        if (visited.size !== nodes.length) throw new ImportError(t("NeXML 存在不連通節點或循環"));
        const rootElement = children(elem, "node").find(n => idMap.get(n.id)?.id === roots[0].id);
        const rootMark = rootElement?.getAttribute("root");
        const rooted = rootMark === "true" || rootMark === "1" ? true : null;
        trees.push(finishTree({ id: treeId, name: elem.getAttribute("label") || `Tree ${trees.length + 1}`, rootId: roots[0].id, rooted, nodes, warnings: [] }));
      }
    }
  } else throw new ImportError(t("不支援此 XML；僅接受 PhyloXML／NeXML 樹，不接受 BEAST 設定 XML"));
  if (!trees.length) throw new ImportError(t("XML 不含可顯示的樹"));
  if (trees.length > LIMITS.trees || trees.reduce((n, t) => n + t.nodes.length, 0) > LIMITS.nodes) throw new ImportError(t("XML 樹數／總節點超限"));
  return { format, trees };
}

function checkedLength(raw: string): number {
  if (!numeric.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new ImportError(t("枝長必須是非負有限數值"));
  return Number(raw);
}

export function parseDocument(content: string, filename = "input.tre", requested = "auto"): SourceDocument {
  if (new TextEncoder().encode(content).length > LIMITS.bytes) throw new ImportError(t("檔案超過 10 MiB"));
  const start = content.replace(/^\uFEFF/, "").trimStart();
  const allowed = ["auto", "newick", "nhx", "hyphy", "beast", "nexus", "phyloxml", "nexml"];
  if (!allowed.includes(requested)) throw new ImportError(t("不支援的指定格式"));
  if (!start) throw new ImportError(t("檔案為空"));
  let format = requested;
  if (start.startsWith("<") || ["phyloxml", "nexml"].includes(format)) {
    const result = parseXML(content, format);
    return { filename, content, ...result };
  }
  if (format === "auto") {
    format = /^#NEXUS\b/i.test(start) || /\bbegin\s+trees\s*;/i.test(start) ? "nexus"
      : start.includes("[&&NHX:") ? "nhx" : /\[&[^RU\]]/i.test(start) ? "beast" : start.includes("{") ? "hyphy" : "newick";
  }
  if (format === "beast" && /^#NEXUS\b/i.test(start)) format = "nexus";
  const trees = parseText(content, format);
  return { filename, content, format, trees };
}

export function availableFields(tree: Tree): string[] {
  const keys = new Set<string>();
  for (const node of tree.nodes) {
    for (const key of Object.keys(node.annotations)) if (/^(age|height|date|time)(_(mean|median))?$/i.test(key)) keys.add(key);
  }
  return [...keys].sort((a, b) => (a === "age_mean" ? -1 : b === "age_mean" ? 1 : a.localeCompare(b)));
}
