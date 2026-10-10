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
  /** 在视觉隐藏（≤1px，常见的 sr-only）的元素里：原样保留不翻，也不参与对齐，免得译文的一半落进看不见的节点 */
  hidden?: boolean;
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
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'data', 'del', 'dfn', 'em', 'font',
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
/** 连字符 / 点分的小写标识符（ai-agents、full-text-search、github.com）单独成段时不翻 */
const SLUG = /^[a-z0-9]+(?:[-_./][a-z0-9]+)+$/;
/** 计数器文字：数字带数量单位（9.2k、1.2M、3万），去掉后没有字母就当计数器 */
const COUNT = /\d[\d.,]*\s?(?:[kKmMbB]|万|亿)?(?![\p{L}])/gu;
const countish = (t: string) => !LETTER.test(t.replace(COUNT, ''));

/** 切段选项：bodyOnly = 只翻正文（跳过按钮、导航、单个词、短链接），由内容脚本按设置写入；测试里默认关 */
export const scanOptions = { bodyOnly: false };

/** 界面控件：里面的文字（按钮、标签页、开关……）不翻，图标、计数器挤在一起最容易错位 */
const CONTROL = [
  'button', 'summary', 'select', 'label', '[aria-hidden="true"]',
  ...['button', 'tab', 'switch', 'checkbox', 'radio', 'option'].map(r => `[role="${r}"]`),
].join(',');
/** 菜单和导航：每一条是独立的一段文字，翻了不会错位，短的也照翻 */
const MENU = ['nav', ...['navigation', 'menu', 'menubar', 'menuitem', 'dialog'].map(r => `[role="${r}"]`)].join(',');
/** 标识符：纯英文、没有空格，且带 / . _ - 或数字、驼峰、全小写（仓库名、文件名、用户名、分支名） */
const ident = (t: string) =>
  /^[\x21-\x7e]+$/.test(t) && (/[/._\-\d]/.test(t) || /[a-z][A-Z]/.test(t) || /^[a-z]+$/.test(t));
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu;
/** 词数：空格分词的语言数词，中日韩按两个字算一个词 */
function wordCount(t: string) {
  const cjk = t.match(CJK)?.length ?? 0;
  return Math.ceil(cjk / 2) + (t.replace(CJK, ' ').match(/\p{L}[\p{L}\p{N}'’-]*/gu)?.length ?? 0);
}
/** 只翻正文时跳过：控件里的、标识符；菜单 / 导航之外再跳过单个词（标题除外）和不超过 3 个词的单独链接 */
function looksLikeUI(parent: ParentNode & Node, nodes: ChildNode[], text: string) {
  const el = parent.nodeType === 11 ? (parent as ShadowRoot).host : (parent as Element);
  if (!el?.closest) return false;
  if (el.closest(CONTROL) || ident(text)) return true;
  if (el.closest(MENU)) return false;
  const n = wordCount(text);
  if (n <= 1 && !/^h[1-6]$/.test(el.localName)) return true;
  const lone = nodes.length === 1 && nodes[0].nodeType === 1 && (nodes[0] as Element).localName === 'a';
  return n <= 3 && (lone || !!el.closest('a'));
}

let hiddenMemo = new WeakMap<Element, boolean>();
let renderedMemo = new WeakMap<Element, boolean>();
let displayMemo = new WeakMap<Element, boolean>();
/** CSS 把行内标签排成了块（菜单项里标题、说明两个 span 上下排）：按块处理，各自成段，不连成「GitHub CopilotWrite better code」 */
function blockish(el: Element): boolean {
  let v = displayMemo.get(el);
  if (v === undefined) {
    v = /^(block|flex|grid|list-item|table)/.test(el.ownerDocument.defaultView?.getComputedStyle(el).display ?? '');
    displayMemo.set(el, v);
  }
  return v;
}
/** 有没有布局盒子（display:none 的没有）；jsdom 里都没有，不会触发混排判断 */
function rendered(el: Element | null): boolean {
  if (!el) return true;
  let v = renderedMemo.get(el);
  if (v === undefined) { v = el.getClientRects().length > 0; renderedMemo.set(el, v); }
  return v;
}
/** 有布局但 ≤1px：sr-only 一类只给读屏用的文字。没有布局（display:none、jsdom）不算 */
function visuallyHidden(el: Element): boolean {
  let v = hiddenMemo.get(el);
  if (v === undefined) {
    const r = el.getClientRects().length ? el.getBoundingClientRect() : undefined;
    v = !!r && r.width <= 1 && r.height <= 1;
    hiddenMemo.set(el, v);
  }
  return v;
}

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
  // 按钮（button 不在 INLINE 里、role=button 的链接 / span）是界面上独立的一块：自成一段，不和旁边的按钮、提示框并在一起
  if (!INLINE.has(el.localName) || el.getAttribute('role') === 'button' || blockish(el)) return false;
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
  hiddenMemo = new WeakMap();
  renderedMemo = new WeakMap();
  displayMemo = new WeakMap();
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
  // 一排各自独立的行内元素（标签、按钮、面包屑），中间只隔空白 / 符号：各成一段，免得译文在它们之间串位
  // （紧挨着、中间没有文本节点的不拆，那多半是同一个短语的不同样式）
  const elements = nodes.filter(n => n.nodeType === 1 && !isAtom(n as Element));
  const separated = elements.every((el, i) => i === 0 || el.previousSibling?.nodeType === 3);
  if (elements.length >= 2 && separated && nodes.every(n => n.nodeType === 1 || !LETTER.test((n as Text).data))) {
    for (const el of elements) flush(parent, [el], out);
    return;
  }
  const slots: Slot[] = [];
  const collect = (n: Node, chain: Element[]) => {
    if (n.nodeType === 3) {
      if ((n as Text).data) slots.push({ node: n as Text, chain, atom: false, hidden: chain.some(visuallyHidden) });
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (isAtom(el)) { slots.push({ node: el, chain, atom: true }); return; }
    const next = [...chain, el];
    for (const c of Array.from(el.childNodes)) collect(c, next);
  };
  for (const n of nodes) collect(n, []);
  // 同一段里一部分文字不渲染（display:none，常见于移动端藏起来的长标签）、一部分渲染：不渲染的原样保留，免得译文分一半进看不见的节点。
  // 整段都不渲染（折叠菜单）就照常翻
  const host = parent.nodeType === 1 ? (parent as Element) : null;
  const shown = slots.map(s => s.atom || rendered(s.chain[s.chain.length - 1] ?? host));
  if (shown.some(x => !x) && slots.some((s, i) => shown[i] && !s.atom && LETTER.test((s.node as Text).data))) {
    slots.forEach((s, i) => { if (!shown[i]) s.hidden = true; });
  }
  if (!slots.some(s => !s.atom && !s.hidden && LETTER.test((s.node as Text).data))) return;
  const plainText = slots.filter(s => !s.atom).map(s => (s.node as Text).data).join('').trim();
  if (SLUG.test(plainText)) return;
  if (scanOptions.bodyOnly && looksLikeUI(parent, nodes, plainText)) return;
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
    s.atom ? { t: atomText(s.node as Element), s: i, k: 1 }
      : { t: (s.node as Text).data.replace(/\s+/g, ' '), s: i, ...(s.hidden ? { k: 1 as const } : {}) });
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

/**
 * 按原文重新锚定两类槽：不翻译的（行内代码、视觉隐藏的文字）和原文没有字母的（计数器「13」、符号）。
 * 框架对齐槽位时可能差几个字符（真机见过「[5] npm instal[6]l 。」「手[13 的槽]表 13」），而这些槽回填时用不上译文 /
 * 不该有字，被挤错位的字就会露在页面上。做法：在整段译文里找原文，区间内的字符归这个槽，这个槽在区间外多占的字符
 * 还给区间外侧相邻的槽；只有空白的槽不接收文字，也还给相邻的槽。找不到原文（被译掉了）就不动。
 */
export function anchorAtoms(sent: Run[], got: Run[]): Run[] {
  let full = '';
  const labels: number[] = [];
  for (const r of got) { full += r.t; for (let i = 0; i < r.t.length; i++) labels.push(r.s); }
  const n = full.length;
  /** 把 [from, to) 里标成 s 的字符改标成 fill */
  const give = (from: number, to: number, s: number, fill: number) => { for (let i = from; i < to; i++) if (labels[i] === s) labels[i] = fill; };
  for (const r of sent) {
    // 不翻译 / 计数器槽必锚定；普通槽只有译文里原样出现原文（没翻的名字，如用户名）且和它现有字符重叠时才锚定
    const fixed = !!r.k || countish(r.t);
    const text = r.t.trim();
    if (!text || (!fixed && text.length < 2)) continue;
    // 同样的文字出现多处时，选和这个槽现有字符重叠最多的那处
    let best = -1, overlap = -1;
    for (let p = full.indexOf(text); p >= 0; p = full.indexOf(text, p + 1)) {
      let hit = 0;
      for (let i = p; i < p + text.length; i++) if (labels[i] === r.s) hit++;
      if (hit > overlap) { best = p; overlap = hit; }
    }
    if (best < 0 || (!fixed && overlap <= 0)) continue;
    const end = best + text.length;
    let left = best;
    while (left > 0 && labels[left - 1] === r.s) left--;
    let right = end;
    while (right < n && labels[right] === r.s) right++;
    give(left, best, r.s, left > 0 ? labels[left - 1] : -1);
    give(end, right, r.s, right < n ? labels[right] : -1);
    for (let i = best; i < end; i++) labels[i] = r.s;
  }
  const blank = new Set(sent.filter(r => !r.k && !r.t.trim()).map(r => r.s));
  for (let i = 0; i < n; i++) {
    if (!blank.has(labels[i])) continue;
    let j = i;
    while (j < n && labels[j] === labels[i]) j++;
    give(i, j, labels[i], i > 0 ? labels[i - 1] : j < n ? labels[j] : -1);
    i = j - 1;
  }
  const out: Run[] = [];
  for (let i = 0; i < n; i++) {
    const last = out[out.length - 1];
    if (last && last.s === labels[i]) last.t += full[i];
    else out.push({ t: full[i], s: labels[i] });
  }
  return out;
}

const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
const LATIN = /[A-Za-z0-9]/;
const PAD = [
  [/([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])([A-Za-z0-9])/gu, '$1 $2'],
  [/([A-Za-z0-9])([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])/gu, '$1 $2'],
] as const;

/**
 * 中日文译文里，汉字 / 假名和英文、数字之间加空格（「Apache-2.0 许可证」）。
 * 原子槽（行内代码）的文字回填时用不上，跨槽的空格放到非原子那一侧。
 */
export function spaced(unit: Unit, runs: Run[]): Run[] {
  const atom = (r: Run) => !!unit.slots[r.s]?.atom;
  const out = runs.map(r => ({ ...r, t: atom(r) ? r.t : PAD.reduce((t, [re, to]) => t.replace(re, to), r.t) }));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const x = a.t.slice(-1), y = b.t.slice(0, 1);
    if (!((CJK_CHAR.test(x) && LATIN.test(y)) || (LATIN.test(x) && CJK_CHAR.test(y)))) continue;
    if (atom(b)) a.t += ' ';
    else b.t = ' ' + b.t;
  }
  return out;
}

/**
 * 段首 / 段尾的图标类原子（svg、img 这类没有文字的）在译文里的位置不可靠（真机见过下拉箭头插进「代 ▾ 码」中间、
 * 眼睛图标跑到按钮末尾）：固定回段首 / 段尾。中间的照译文位置放
 */
export function pinEdges(sent: Run[], got: Run[]): Run[] {
  const icon = (r: Run) => !!r.k && !LETTER.test(r.t);
  const blank = (r: Run) => !r.k && !r.t.trim();
  const lead: number[] = [], tail: number[] = [];
  for (const r of sent) { if (icon(r)) lead.push(r.s); else if (!blank(r)) break; }
  for (let i = sent.length - 1; i >= 0; i--) {
    const r = sent[i];
    if (icon(r) && !lead.includes(r.s)) tail.unshift(r.s);
    else if (!blank(r)) break;
  }
  if (!lead.length && !tail.length) return got;
  const pinned = new Set([...lead, ...tail]);
  return [...lead.map(s => ({ t: '', s })), ...got.filter(r => !pinned.has(r.s)), ...tail.map(s => ({ t: '', s }))];
}

export function apply(unit: Unit, runs: Run[]): 'inplace' | 'rebuild' {
  restore(unit);
  const sent = serialize(unit);
  const merged = merge(unit, pinEdges(sent, anchorAtoms(sent, runs)));
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
    if (s.atom || s.hidden) return;
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
  const host = unit.slots.find(s => !s.atom && !s.hidden && /\S/.test((s.node as Text).data));
  const texts = new Map<Text, string>();
  for (const s of unit.slots) {
    if (s.atom || s.hidden) continue;
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
