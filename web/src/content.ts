// 页面里的调度：判断要不要翻 → 切段 → 只翻看得见的 → 回填 → 跟着页面变化继续翻
import { apply, boxOf, cacheKey, forget, inlineOnly, owner, restore, scan, serialize, type Unit } from './dom';
import type { LookupRequest, Rules, Run, TabCommand, TabState, TranslateRequest, TranslateResponse, UnitRequest } from './protocol';
import { api, baseLang, loadRules, siteKey, wants } from './rules';

const BATCH_UNITS = 40;
const BATCH_CHARS = 5000;
const MAX_INFLIGHT = 2;
/** 只查缓存的一批可以大得多：不过原生，只是一次 IndexedDB 读 */
const LOOKUP_UNITS = 300;
const TAB_KEY = 'verso:tab';

let rules: Rules;
let pageLang: string | undefined;
let active = false;
let failed = 0;
let done = 0;
let cached = 0;
let started = 0;
let first: number | undefined;
/** [总耗时, 次数] */
const lat = { lookup: [0, 0], translate: [0, 0] };
const missing = new Set<string>();

const units = new Map<string, Unit>();
const byBox = new Map<Element, Set<Unit>>();
const queue = new Set<Unit>();
/** 等着先查缓存的单元 */
const probe = new Set<Unit>();
let probeTimer: ReturnType<typeof setTimeout> | undefined;
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
  probe.delete(u);
  forget(u);
  for (const [box, set] of byBox) if (set.delete(u) && !set.size) { byBox.delete(box); io?.unobserve(box); }
}

/** rw 读写；隐私窗口只读；设置里关掉就不碰缓存 */
const cacheMode = (): 'rw' | 'ro' | undefined =>
  !rules.settings.cache ? undefined : api.extension?.inIncognitoContext ? 'ro' : 'rw';

const request = (units: UnitRequest[]) =>
  ({ target: rules.settings.target, fluent: rules.settings.fluent, hint: pageLang, units });

function remember(key: string, runs: Run[]) {
  cache.set(key, runs);
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
}

function fill(u: Unit, runs: Run[], hit: boolean) {
  mute(() => apply(u, runs));
  done++;
  if (hit) cached++;
  first ??= Math.round(performance.now() - started);
}

const timed = (k: keyof typeof lat, t0: number) => { lat[k][0] += performance.now() - t0; lat[k][1]++; };
const avg = (k: keyof typeof lat) => (lat[k][1] ? Math.round(lat[k][0] / lat[k][1]) : undefined);

function enqueue(u: Unit) {
  if (u.applied || sent.has(u) || !units.has(u.id)) return;
  const hit = cache.get(cacheKey(serialize(u)));
  if (hit) return fill(u, hit, true);
  if (cacheMode()) { probe.add(u); probeTimer ??= setTimeout(lookup, 10); return; }
  queue.add(u);
  timer ??= setTimeout(pump, 30);
}

/** 先只查缓存：命中的马上回填，不陪没命中的段落等原生翻译；没命中的再进翻译队列 */
async function lookup() {
  probeTimer = undefined;
  const batch = [...probe].slice(0, LOOKUP_UNITS).map(u => ({ unit: u, req: { id: u.id, runs: serialize(u) } }));
  for (const b of batch) { probe.delete(b.unit); sent.add(b.unit); }
  if (probe.size) probeTimer = setTimeout(lookup, 0);
  const t0 = performance.now();
  const msg: LookupRequest = { op: 'lookup', cache: cacheMode(), ...request(batch.map(b => b.req)) };
  const res: TranslateResponse = await api.runtime.sendMessage(msg).catch(() => ({ ok: false }));
  if (!active) return;
  timed('lookup', t0);
  const hits = new Map((res.results ?? []).map(r => [r.id, r]));
  for (const { unit, req } of batch) {
    if (!units.has(unit.id)) continue;
    const r = hits.get(unit.id);
    if (r?.runs) { remember(cacheKey(req.runs), r.runs); fill(unit, r.runs, true); }
    else if (!r) queue.add(unit); // 命中的「已是目标语言」什么都不用做
  }
  if (queue.size) timer ??= setTimeout(pump, 0);
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
  // 已经 lookup 过，background 只管写回；隐私窗口不写
  const msg: TranslateRequest = { op: 'translate', cache: cacheMode() === 'rw' ? 'wo' : undefined, ...request(batch.map(b => b.req)) };
  const t0 = performance.now();
  let res: TranslateResponse;
  try {
    res = await api.runtime.sendMessage(msg);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  inflight--;
  if (!active) return;
  timed('translate', t0);
  for (const m of res.missing ?? []) missing.add(m);
  const byId = new Map(batch.map(b => [b.req.id, b]));
  for (const r of res.results ?? []) {
    const b = byId.get(r.id);
    byId.delete(r.id);
    if (!b || !units.has(r.id)) continue;
    if (r.runs) {
      remember(b.key, r.runs);
      fill(b.unit, r.runs, false);
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
  started = performance.now();
  first = undefined;
  lat.lookup = [0, 0];
  lat.translate = [0, 0];
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
  clearTimeout(probeTimer);
  timer = dirtyTimer = probeTimer = undefined;
  queue.clear();
  probe.clear();
  dirty.clear();
  for (const u of units.values()) { restore(u); forget(u); }
  units.clear();
  byBox.clear();
  api.runtime.sendMessage({ bg: 'badge', on: false }).catch(() => {});
}

function state(): TabState {
  return { host: siteKey(location.hostname), lang: pageLang, active, units: units.size, done, cached, failed, missing: [...missing],
    first, lookupMs: avg('lookup'), translateMs: avg('translate') };
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
