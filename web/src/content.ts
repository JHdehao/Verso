// 页面里的调度：判断要不要翻 → 切段 → 只翻看得见的 → 回填 → 跟着页面变化继续翻
import { apply, boxOf, cacheKey, forget, inlineOnly, owner, restore, scan, serialize, type Unit } from './dom';
import type { Rules, Run, TabCommand, TabState, TranslateRequest, TranslateResponse, UnitRequest } from './protocol';
import { api, baseLang, loadRules, siteKey, wants } from './rules';

const BATCH_UNITS = 40;
const BATCH_CHARS = 5000;
const MAX_INFLIGHT = 2;
const TAB_KEY = 'verso:tab';

let rules: Rules;
let pageLang: string | undefined;
let active = false;
let failed = 0;
let done = 0;
let cached = 0;
const missing = new Set<string>();

const units = new Map<string, Unit>();
const byBox = new Map<Element, Set<Unit>>();
const queue = new Set<Unit>();
const cache = new Map<string, Run[]>();
/** 发出去过的单元不再重发（跳过 / 失败的要靠重新开关或页面变化后重新切段） */
const sent = new WeakSet<Unit>();
let inflight = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let io: IntersectionObserver | undefined;
let mo: MutationObserver | undefined;

const tabChoice = (): string | null => { try { return sessionStorage.getItem(TAB_KEY); } catch { return null; } };
const setTabChoice = (v: 'on' | 'off' | null) => {
  try { v ? sessionStorage.setItem(TAB_KEY, v) : sessionStorage.removeItem(TAB_KEY); } catch { /* 沙盒 iframe */ }
};

function shouldTranslate() {
  const tab = tabChoice();
  if (tab) return tab === 'on';
  return wants(rules, location.hostname, pageLang);
}

/** 自己改 DOM 时不让 MutationObserver 当成页面变化 */
function mute(fn: () => void) {
  fn();
  mo?.takeRecords();
}

function register(found: Unit[]) {
  for (const u of found) {
    units.set(u.id, u);
    const box = boxOf(u);
    if (!box) continue;
    let set = byBox.get(box);
    if (!set) { set = new Set(); byBox.set(box, set); io?.observe(box); }
    set.add(u);
  }
}

function drop(u: Unit) {
  units.delete(u.id);
  queue.delete(u);
  forget(u);
  for (const [box, set] of byBox) if (set.delete(u) && !set.size) { byBox.delete(box); io?.unobserve(box); }
}

function enqueue(u: Unit) {
  if (u.applied || sent.has(u) || !units.has(u.id)) return;
  const key = cacheKey(serialize(u));
  const hit = cache.get(key);
  if (hit) { mute(() => apply(u, hit)); done++; cached++; return; }
  queue.add(u);
  timer ??= setTimeout(pump, 30);
}

function pump() {
  timer = undefined;
  while (inflight < MAX_INFLIGHT && queue.size) {
    const batch: { unit: Unit; req: UnitRequest; key: string }[] = [];
    let chars = 0;
    for (const u of queue) {
      const runs = serialize(u);
      const size = runs.reduce((n, r) => n + r.t.length, 0);
      if (batch.length && (batch.length >= BATCH_UNITS || chars + size > BATCH_CHARS)) break;
      queue.delete(u);
      sent.add(u);
      batch.push({ unit: u, req: { id: u.id, runs }, key: cacheKey(runs) });
      chars += size;
    }
    send(batch);
  }
}

async function send(batch: { unit: Unit; req: UnitRequest; key: string }[]) {
  inflight++;
  const msg: TranslateRequest = {
    op: 'translate',
    target: rules.settings.target,
    fluent: rules.settings.fluent,
    hint: pageLang,
    cache: rules.settings.cache ? (api.extension?.inIncognitoContext ? 'ro' : 'rw') : undefined,
    units: batch.map(b => b.req),
  };
  let res: TranslateResponse;
  try {
    res = await api.runtime.sendMessage(msg);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  inflight--;
  if (!active) return;
  for (const m of res.missing ?? []) missing.add(m);
  cached += res.hits ?? 0;
  const byId = new Map(batch.map(b => [b.req.id, b]));
  for (const r of res.results ?? []) {
    const b = byId.get(r.id);
    byId.delete(r.id);
    if (!b || !units.has(r.id)) continue;
    if (r.runs) {
      cache.set(b.key, r.runs);
      if (cache.size > 3000) cache.delete(cache.keys().next().value!);
      mute(() => apply(b.unit, r.runs!));
      done++;
    } else if (r.err) failed++;
  }
  if (!res.ok) failed += byId.size;
  if (queue.size) timer ??= setTimeout(pump, 0);
}

// 页面变化：新节点、页面自己改了已翻译的文字 → 重新切段（已是目标语言的段落由原生侧识别后跳过）
const dirty = new Set<Node>();
let dirtyTimer: ReturnType<typeof setTimeout> | undefined;

function markDirty(n: Node) {
  const root = n.nodeType === 1 && !inlineOnly(n as Element) ? n : n.parentNode;
  if (!root) return;
  dirty.add(root);
  dirtyTimer ??= setTimeout(rescan, 120);
}

function rescan() {
  dirtyTimer = undefined;
  const roots = [...dirty];
  dirty.clear();
  for (const u of [...units.values()]) if (!u.parent.isConnected) drop(u);
  for (const root of roots) {
    if (!root.isConnected) continue;
    for (const u of [...units.values()]) if (u.parent === root) drop(u);
    register(scan(root));
  }
}

function onMutations(records: MutationRecord[]) {
  for (const r of records) {
    if (r.type === 'characterData') {
      const u = owner.get(r.target);
      if (u) { drop(u); markDirty(u.parent); }
    } else {
      for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1 || n.nodeType === 3) markDirty(n);
    }
  }
}

function start() {
  if (active || !document.body) return;
  active = true;
  failed = done = cached = 0;
  missing.clear();
  io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) for (const u of byBox.get(e.target) ?? []) enqueue(u);
  }, { rootMargin: '100% 0px' });
  mo = new MutationObserver(onMutations);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  register(scan(document.body));
  api.runtime.sendMessage({ bg: 'badge', on: true }).catch(() => {});
}

function stop() {
  if (!active) return;
  active = false;
  io?.disconnect();
  mo?.disconnect();
  io = mo = undefined;
  clearTimeout(timer);
  clearTimeout(dirtyTimer);
  timer = dirtyTimer = undefined;
  queue.clear();
  dirty.clear();
  for (const u of units.values()) { restore(u); forget(u); }
  units.clear();
  byBox.clear();
  api.runtime.sendMessage({ bg: 'badge', on: false }).catch(() => {});
}

function state(): TabState {
  return { host: siteKey(location.hostname), lang: pageLang, active, units: units.size, done, cached, failed, missing: [...missing] };
}

/** 页面语言：先信 <html lang>，没写就取一段正文问原生侧 */
async function detectLanguage(): Promise<string | undefined> {
  const declared = baseLang(document.documentElement.lang);
  if (declared) return declared;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (/^(script|style|noscript)$/i.test(n.parentElement?.localName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  while (text.length < 1000 && walker.nextNode()) text += ' ' + walker.currentNode.nodeValue;
  if (!/\p{L}/u.test(text)) return undefined;
  try {
    const r = await api.runtime.sendMessage({ op: 'detect', text: text.replace(/\s+/g, ' ').slice(0, 1000) });
    return r?.ok ? baseLang(r.lang) : undefined;
  } catch {
    return undefined;
  }
}

function reevaluate(restart = false) {
  const want = shouldTranslate();
  if (restart) cache.clear();
  if (active && (!want || restart)) stop();
  if (want) start();
}

async function main() {
  if (!document.body || location.protocol === 'about:') return;
  rules = await loadRules();
  pageLang = await detectLanguage();
  reevaluate();

  api.storage.onChanged.addListener(async (changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    const before = rules.settings;
    rules = await loadRules();
    // 改了站点 / 语言规则就以规则为准，清掉这个标签页的手动选择
    if ('sites' in changes || 'langs' in changes) setTabChoice(null);
    reevaluate('settings' in changes && (before.target !== rules.settings.target || before.fluent !== rules.settings.fluent));
  });

  api.runtime.onMessage.addListener((msg: TabCommand) => {
    if (msg?.cmd === 'state') return Promise.resolve(state());
    if (msg?.cmd === 'toggle') {
      if (active) { setTabChoice('off'); stop(); } else { setTabChoice('on'); start(); }
      return Promise.resolve(state());
    }
  });
}

main();
