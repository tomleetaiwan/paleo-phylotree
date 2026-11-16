export type Annotation = string | number | boolean | Annotation[];
export interface TreeNode {
  id: string;
  parentId: string | null;
  children: string[];
  name: string;
  length: number | null;
  support: number | null;
  annotations: Record<string, Annotation>;
  rawAnnotations: string[];
}
export interface Tree {
  id: string;
  name: string;
  rootId: string;
  rooted: boolean | null;
  nodes: TreeNode[];
  warnings: string[];
}
export interface SourceDocument {
  filename: string;
  content: string;
  format: string;
  trees: Tree[];
}
export interface TimeOptions {
  autoMethod: boolean;
  method: "nodes" | "branches";
  field: string;
  unit: "Ma" | "ka" | "years";
  origin: "present";
  zeroAgeMa: number;
  zeroAgePairMa: [number, number] | null;
  evidence: string;
  rootedConfirmed: boolean;
}
export interface Interval {
  key: string;
  lower: number;
  upper: number;
  type: string;
}
export interface TimeResult {
  valid: boolean;
  ages: Record<string, number>;
  sources: Record<string, string>;
  intervals: Record<string, Interval[]>;
  errors: string[];
  warnings: string[];
}
export interface ViewState {
  mode: "general" | "time";
  rootStyle: "hollow" | "solid";
  rootStem: boolean;
  grid: boolean;
  minorGrid: boolean;
  gridColor: string;
  gridOpacity: number;
  gridStep: number | null;
  autoRange: boolean;
  older: number | null;
  younger: number;
  decimals: number;
  fontSize: number;
  lineWidth: number;
  branchColor: string;
  names: boolean;
  ages: boolean;
  allTips: boolean;
  support: boolean;
  simplified: boolean;
  collapsed: string[];
  order: "original" | "ascending" | "descending";
  selected: string | null;
  zoom: number;
  panX: number;
  panY: number;
}
export const APP_VERSION = "0.1.0";
export const PHYLOTREE_VERSION = "2.6.1";
export const LIMITS = { bytes: 10 * 1024 * 1024, trees: 100, nodes: 200_000, tips: 1000, depth: 512, annotation: 65_536 };
