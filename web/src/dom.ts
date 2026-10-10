// 切段 / 序列化 / 回填 / 还原。只依赖 DOM，测试里用 jsdom 跑。
//
// 一个「翻译单元」= 某个元素下一段连续的「文字 + 行内元素」。单元里每个文本节点和原子元素（代码、换行、图片……）
// 各占一个槽位，翻译时槽位编号作为自定义属性随 AttributedString 一起过苹果翻译，回来后按编号写回：
// - 能原地写回就原地写（只改文本节点的 data，不动任何元素 → React 等框架、事件监听都不受影响）；
// - 行内元素的先后顺序被译文调换时，才浅克隆行内元素重建这一段。
import type { Run } from './protocol';

export type Slot = {
  node: Text | Element;
  /** 单元父节点之下、该节点之上的行内元素（外 → 内） */
  chain: Element[];
  atom: boolean;
};

type Applied =
  | { mode: 'inplace'; texts: Map<Text, string>; created: Text[] }
  | { mode: 'rebuild'; original: ChildNode[]; inserted: ChildNode[] };

export type Unit = {
  id: string;
  parent: ParentNode & Node;
  /** 单元在父节点下占的那一段直接子节点 */
  nodes: ChildNode[];
  slots: Slot[];
  applied?: Applied;
};

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'pre', 'code',
  'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'head', 'title', 'slot',
]);
const INLINE = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'button', 'cite', 'data', 'del', 'dfn', 'em', 'font',
  'i', 'ins', 'label', 'mark', 'nobr', 'output', 'q', 'rp', 'rt', 'ruby', 's', 'small', 'span', 'strike',
  'strong', 'sub', 'sup', 'time', 'u',
]);
/** 行内但不翻译：原样保留在原位置 */
const ATOM = new Set([
  'br', 'wbr', 'img', 'picture', 'svg', 'math', 'code', 'kbd', 'samp', 'var', 'tt', 'input', 'select',
  'textarea', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'meter', 'progress',
]);
/** 原子元素里这些带文字进翻译（标为不翻译），让译文语序有参照；其余用占位符 */
const ATOM_TEXT = new Set(['code', 'kbd', 'samp', 'var', 'tt']);
const OBJ = '￼';
const LETTER = /\p{L}/u;

export const isNoTranslate = (el: Element) =>
  el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');

const isEditable = (el: Element) => {
  const v = el.getAttribute('contenteditable');
  return v !== null && v !== 'false';
};

function skipContainer(el: Element) {
  return SKIP.has(el.localName) || isNoTranslate(el) || isEditable(el) || el.hasAttribute('data-verso-ui');
}

function isAtom(el: Element) {
  return ATOM.has(el.localName) || (INLINE.has(el.localName) && (isNoTranslate(el) || isEditable(el)));
}

let inlineMemo = new WeakMap<Element, boolean>();

/** 整个子树都是行内内容（没有块级后代） */
export function inlineOnly(el: Element): boolean {
  if (isAtom(el)) return true;
  if (!INLINE.has(el.localName)) return false;
  let m = inlineMemo.get(el);
  if (m === undefined) {
    m = true;
    for (const c of Array.from(el.children)) if (!inlineOnly(c)) { m = false; break; }
    inlineMemo.set(el, m);
  }
  return m;
}

/** 文本节点 / 顶层节点 → 所属单元 */
export const owner = new WeakMap<Node, Unit>();
let seq = 0;

/** 扫描 root 之下所有还没有归属的单元 */
export function scan(root: Node): Unit[] {
  inlineMemo = new WeakMap();
  const out: Unit[] = [];
  if (root.nodeType === 1 && skipContainer(root as Element)) return out;
  if (root.nodeType === 1 && hasSkippedAncestor(root as Element)) return out;
  walk(root as ParentNode & Node, out);
  return out;
}

function hasSkippedAncestor(el: Element) {
  for (let p = el.parentElement; p; p = p.parentElement) if (skipContainer(p)) return true;
  return false;
}

function walk(container: ParentNode & Node, out: Unit[]) {
  let run: ChildNode[] = [];
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === 3) run.push(child);
    else if (child.nodeType === 1) {
      const el = child as Element;
      if (inlineOnly(el)) { run.push(el); continue; }
      flush(container, run, out);
      run = [];
      if (!skipContainer(el)) walk(el, out);
    }
  }
  flush(container, run, out);
  if (container.nodeType === 1 && (container as Element).shadowRoot) walk((container as Element).shadowRoot!, out);
}

const blank = (n: Node) => n.nodeType === 3 && !/\S/.test((n as Text).data);

function flush(parent: ParentNode & Node, run: ChildNode[], out: Unit[]) {
  let a = 0, b = run.length;
  while (a < b && blank(run[a])) a++;
  while (b > a && blank(run[b - 1])) b--;
  if (a === b) return;
  const nodes = run.slice(a, b);
  const slots: Slot[] = [];
  const collect = (n: Node, chain: Element[]) => {
    if (n.nodeType === 3) { if ((n as Text).data) slots.push({ node: n as Text, chain, atom: false }); return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (isAtom(el)) { slots.push({ node: el, chain, atom: true }); return; }
    const next = [...chain, el];
    for (const c of Array.from(el.childNodes)) collect(c, next);
  };
  for (const n of nodes) collect(n, []);
  if (!slots.some(s => !s.atom && LETTER.test((s.node as Text).data))) return;
  if (slots.some(s => owner.has(s.node))) return;
  const unit: Unit = { id: `u${++seq}`, parent, nodes, slots };
  for (const s of slots) owner.set(s.node, unit);
  for (const n of nodes) owner.set(n, unit);
  out.push(unit);
}

/** 解除节点归属，之后 scan 可以重新切这一段 */
export function forget(unit: Unit) {
  for (const s of unit.slots) if (owner.get(s.node) === unit) owner.delete(s.node);
  for (const n of unit.nodes) if (owner.get(n) === unit) owner.delete(n);
}

function atomText(el: Element) {
  if (el.localName === 'br') return '\n';
  if (ATOM_TEXT.has(el.localName) || isNoTranslate(el)) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ');
    if (t.trim() && t.length <= 200) return t;
  }
  return OBJ;
}

export function serialize(unit: Unit): Run[] {
  const runs = unit.slots.map((s, i): Run =>
    s.atom ? { t: atomText(s.node as Element), s: i, k: 1 } : { t: (s.node as Text).data.replace(/\s+/g, ' '), s: i });
  // 整段首尾的空白（缩进、换行）不送去翻译
  const first = runs.find(r => !r.k), last = runs.findLast(r => !r.k);
  if (first) first.t = first.t.trimStart();
  if (last) last.t = last.t.trimEnd();
  return runs;
}

/** 缓存键：只看文字和槽位形状，同样内容的段落（导航、按钮、重复渲染）直接复用 */
export const cacheKey = (runs: Run[]) => runs.map(r => `${r.s}${r.k ? '!' : ':'}${r.t}`).join('\u0001');

function merge(unit: Unit, runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const s = Number.isInteger(r.s) && r.s >= 0 && r.s < unit.slots.length ? r.s : -1;
    const last = out[out.length - 1];
    if (last && last.s === s) last.t += r.t;
    else out.push({ t: r.t, s });
  }
  return out;
}

export function apply(unit: Unit, runs: Run[]): 'inplace' | 'rebuild' {
  restore(unit);
  const merged = merge(unit, runs);
  if (merged.every(r => r.s < 0)) { plain(unit, merged.map(r => r.t).join('')); return 'inplace'; }
  if (inPlace(unit, merged)) return 'inplace';
  rebuild(unit, merged);
  return 'rebuild';
}

const topLevel = (unit: Unit, n: Node) => {
  let x: Node = n;
  while (x.parentNode && x.parentNode !== unit.parent) x = x.parentNode;
  return x as ChildNode;
};

function inPlace(unit: Unit, runs: Run[]): boolean {
  const { slots } = unit;
  const nested = (i: number) => slots[i].atom || slots[i].chain.length > 0;

  // 行内元素和原子元素在译文里的顺序必须和原文一致，且每个只出现在一处
  const seen = new Set<number>();
  let last = -1;
  for (const r of runs) {
    if (r.s < 0 || !nested(r.s)) continue;
    if (seen.has(r.s) || r.s < last) return false;
    seen.add(r.s);
    last = r.s;
  }

  // 顶层文字按「夹在哪两个行内元素之间」分区，写进原文同一区间里的第一个顶层文本节点
  const assign = new Map<number, string>();
  const buckets = new Map<number, string>();
  let cur = -1;
  for (const r of runs) {
    if (r.s >= 0 && nested(r.s)) {
      cur = r.s;
      if (!slots[r.s].atom) assign.set(r.s, (assign.get(r.s) ?? '') + r.t);
    } else buckets.set(cur, (buckets.get(cur) ?? '') + r.t);
  }
  const regions = new Map<number, number[]>();
  let region = -1;
  slots.forEach((s, i) => {
    if (nested(i)) region = i;
    else regions.set(region, [...(regions.get(region) ?? []), i]);
  });
  const nestedIdx = slots.map((_, i) => i).filter(nested);
  const created: [Text, ChildNode | null][] = [];
  for (const [key, text] of buckets) {
    const target = regions.get(key)?.[0];
    if (target !== undefined) { assign.set(target, text); continue; }
    if (!/\S/.test(text)) continue;
    // 原文这里没有顶层文本节点：区间两侧在同一个顶层元素里就没法原地放，交给重建
    const next = nestedIdx.find(i => i > key);
    const before = key >= 0 ? topLevel(unit, slots[key].node) : null;
    const after = next !== undefined ? topLevel(unit, slots[next].node) : null;
    if (before && after && before === after) return false;
    const doc = unit.parent.ownerDocument ?? (unit.parent as unknown as Document);
    const ref = before ? before.nextSibling : (after ?? unit.nodes[0]);
    created.push([doc.createTextNode(text), ref]);
  }

  const texts = new Map<Text, string>();
  slots.forEach((s, i) => {
    if (s.atom) return;
    const node = s.node as Text;
    const t = assign.get(i) ?? '';
    if (node.data !== t) { texts.set(node, node.data); node.data = t; }
  });
  for (const [node, ref] of created) unit.parent.insertBefore(node, ref && ref.parentNode === unit.parent ? ref : null);
  unit.applied = { mode: 'inplace', texts, created: created.map(c => c[0]) };
  return true;
}

/**
 * 译文整段丢了槽位（原生侧退回纯文本）：写进原文第一个有字的文本节点，其余文字清空，不新建节点。
 * 新建的顶层节点会跑出原来的元素——比如视觉隐藏的「Open Menu」标签，译文就会露出来叠在页面上。
 */
function plain(unit: Unit, text: string) {
  const host = unit.slots.find(s => !s.atom && /\S/.test((s.node as Text).data));
  const texts = new Map<Text, string>();
  for (const s of unit.slots) {
    if (s.atom) continue;
    const node = s.node as Text;
    const t = s === host ? text : '';
    if (node.data !== t) { texts.set(node, node.data); node.data = t; }
  }
  unit.applied = { mode: 'inplace', texts, created: [] };
}

function rebuild(unit: Unit, runs: Run[]) {
  const doc = unit.parent.ownerDocument ?? (unit.parent as unknown as Document);
  const frag = doc.createDocumentFragment();
  const open: { orig: Element; clone: Element }[] = [];
  const sink = (): Node => (open.length ? open[open.length - 1].clone : frag);
  const ensure = (chain: Element[]) => {
    let p = 0;
    while (p < open.length && p < chain.length && open[p].orig === chain[p]) p++;
    open.length = p;
    for (let i = p; i < chain.length; i++) {
      const clone = chain[i].cloneNode(false) as Element;
      sink().appendChild(clone);
      open.push({ orig: chain[i], clone });
    }
  };
  const used = new Set<number>();
  for (const r of runs) {
    const slot = r.s >= 0 ? unit.slots[r.s] : undefined;
    if (slot?.atom) {
      if (used.has(r.s)) continue;
      used.add(r.s);
      ensure(slot.chain);
      sink().appendChild(slot.node.cloneNode(true));
      continue;
    }
    ensure(slot ? slot.chain : []);
    if (r.t) sink().appendChild(doc.createTextNode(r.t));
  }
  unit.slots.forEach((s, i) => {
    if (s.atom && !used.has(i)) { ensure(s.chain); sink().appendChild(s.node.cloneNode(true)); }
  });

  const original = unit.nodes.filter(n => n.parentNode === unit.parent);
  const anchor = original.length ? original[original.length - 1].nextSibling : null;
  const inserted = Array.from(frag.childNodes) as ChildNode[];
  for (const n of original) n.remove();
  unit.parent.insertBefore(frag, anchor && anchor.parentNode === unit.parent ? anchor : null);
  for (const n of inserted) owner.set(n, unit);
  unit.applied = { mode: 'rebuild', original, inserted };
}

export function restore(unit: Unit) {
  const a = unit.applied;
  if (!a) return;
  if (a.mode === 'inplace') {
    for (const [node, data] of a.texts) node.data = data;
    for (const n of a.created) n.remove();
  } else {
    const anchor = a.inserted.find(n => n.parentNode === unit.parent) ?? null;
    for (const n of a.original) unit.parent.insertBefore(n, anchor);
    for (const n of a.inserted) { n.remove(); if (owner.get(n) === unit) owner.delete(n); }
  }
  unit.applied = undefined;
}

/** 单元在页面上的可见性观察对象（display: contents 的元素没有盒子，往上找） */
export function boxOf(unit: Unit): Element | null {
  let el: Node | null = unit.parent;
  if (el.nodeType === 11) el = (el as ShadowRoot).host ?? null;
  while (el && el.nodeType === 1) {
    const e = el as Element;
    if (e.getClientRects().length || e.localName === 'body') return e;
    el = e.parentElement;
  }
  return null;
}
