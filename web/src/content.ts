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
// 防闪烁的计时从「首屏有要翻的段落」算起：网络慢时正文还没到，那段本来就是加载白屏，隐藏不影响观感
/** 首屏段落出现后最多再等这么久译文 */
const COVER_TRANSLATE_MS = 800;
/** 页面解析完仍没有首屏段落（已是目标语言 / 纯图片 / JS 还没渲染），最多再等这么久 */
const COVER_IDLE_MS = 1000;
/** 绝对上限，防异常 */
const COVER_MAX_MS = 5000;

let rules: Rules;
let pageLang: string | undefined;
/** 本次翻译固定用开始时的页面语言做提示，中途识别出语言也不改，免得同一页的缓存键前后不一 */
let hint: string | undefined;
let active = false;
let failed = 0;
let done = 0;
let cached = 0;
/** 从打开页面（导航开始）算起 */
let first: number | undefined;
let startAt: number | undefined;
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
/** 进入视口（不含下一屏预取区）的单元，排队时插到最前 */
const hot = new WeakSet<Unit>();
/** 防闪烁期间还没出结果的视口内单元，清空就显示页面 */
const pendingHot = new Set<Unit>();
let cover: HTMLStyleElement | undefined;
/** 首屏段落已出现，翻译计时已开始 */
let coverArmed = false;
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
  const fresh: [Unit, Element][] = [];
  for (const u of found) {
    units.set(u.id, u);
    const box = boxOf(u);
    if (!box) continue;
    let set = byBox.get(box);
    if (!set) { set = new Set(); byBox.set(box, set); io?.observe(box); }
    set.add(u);
    fresh.push([u, box]);
  }
  // 遮着的时候浏览器可能不出渲染帧，IntersectionObserver 迟迟不回调（无头 Chromium 实测约一半概率）：直接量位置，首屏和下一屏马上送翻
  if (cover && active) {
    const rects = fresh.map(([, box]) => box.getBoundingClientRect());
    fresh.forEach(([u], i) => {
      const r = rects[i];
      if (r.bottom > -innerHeight && r.top < 2 * innerHeight) enqueue(u, r.top < innerHeight && r.bottom > 0);
    });
  }
}

function drop(u: Unit) {
  units.delete(u.id);
  queue.delete(u);
  probe.delete(u);
  pendingHot.delete(u);
  forget(u);
  for (const [box, set] of byBox) if (set.delete(u) && !set.size) { byBox.delete(box); io?.unobserve(box); }
}

/** rw 读写；隐私窗口只读；设置里关掉就不碰缓存 */
const cacheMode = (): 'rw' | 'ro' | undefined =>
  !rules.settings.cache ? undefined : api.extension?.inIncognitoContext ? 'ro' : 'rw';

const request = (units: UnitRequest[]) =>
  ({ target: rules.settings.target, fluent: rules.settings.fluent, hint, units });

function remember(key: string, runs: Run[]) {
  cache.set(key, runs);
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
}

function fill(u: Unit, runs: Run[], hit: boolean) {
  mute(() => apply(u, runs));
  done++;
  if (hit) cached++;
  first ??= Math.round(performance.now());
}

/** 已确定要翻、页面还在加载时先隐藏，免得先画出原文再一闪变译文 */
function coverPage() {
  if (cover || !document.documentElement) return;
  cover = document.createElement('style');
  cover.textContent = 'html{opacity:0!important}';
  document.documentElement.append(cover);
  setTimeout(uncover, COVER_MAX_MS);
}

function uncover() {
  cover?.remove();
  cover = undefined;
  pendingHot.clear();
}

/** 每批结果回来后调用：视口内的都有结果了就显示 */
function settle(us: Iterable<Unit>) {
  for (const u of us) pendingHot.delete(u);
  if (cover && !pendingHot.size) uncover();
}

/** 视口内的排前面，其余保持原顺序 */
const byHeat = (s: Set<Unit>) => [...s].sort((a, b) => +!hot.has(a) - +!hot.has(b));

const timed = (k: keyof typeof lat, t0: number) => { lat[k][0] += performance.now() - t0; lat[k][1]++; };
const avg = (k: keyof typeof lat) => (lat[k][1] ? Math.round(lat[k][0] / lat[k][1]) : undefined);

function enqueue(u: Unit, inView: boolean) {
  if (inView) {
    hot.add(u);
    if (cover) {
      pendingHot.add(u);
      if (!coverArmed) { coverArmed = true; setTimeout(uncover, COVER_TRANSLATE_MS); }
    }
  }
  if (u.applied || sent.has(u) || !units.has(u.id)) return;
  const hit = cache.get(cacheKey(serialize(u)));
  if (hit) { fill(u, hit, true); return settle([u]); }
  if (cacheMode()) { probe.add(u); probeTimer ??= setTimeout(lookup, 10); return; }
  queue.add(u);
  timer ??= setTimeout(pump, 30);
}

/** 先只查缓存：命中的马上回填，不陪没命中的段落等原生翻译；没命中的再进翻译队列 */
async function lookup() {
  probeTimer = undefined;
  const batch = byHeat(probe).slice(0, LOOKUP_UNITS).map(u => ({ unit: u, req: { id: u.id, runs: serialize(u) } }));
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
  settle(batch.filter(b => !queue.has(b.unit)).map(b => b.unit));
  if (queue.size) timer ??= setTimeout(pump, 0);
}

function pump() {
  timer = undefined;
  while (inflight < MAX_INFLIGHT && queue.size) {
    const batch: { unit: Unit; req: UnitRequest; key: string }[] = [];
    let chars = 0;
    for (const u of byHeat(queue)) {
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
  settle(batch.map(b => b.unit));
  if (queue.size) timer ??= setTimeout(pump, 0);
}

// 页面变化：新节点、页面自己改了已翻译的文字 → 重新切段（已是目标语言的段落由原生侧识别后跳过）
const dirty = new Set<Node>();
let dirtyTimer: ReturnType<typeof setTimeout> | undefined;

function markDirty(n: Node) {
  const root = n.nodeType === 1 && !inlineOnly(n as Element) ? n : n.parentNode;
  if (!root) return;
  dirty.add(root);
  // 页面还在加载 / 防闪烁还在遮：新段落尽快切段送翻，首屏不等整页解析完
  dirtyTimer ??= setTimeout(rescan, document.readyState === 'loading' || cover ? 16 : 120);
}

function rescan() {
  dirtyTimer = undefined;
  // 祖先也在这批里的不用单独扫（加载期间父子节点常在同一批里）
  const roots = [...dirty].filter(r => { for (let p = r.parentNode; p; p = p.parentNode) if (dirty.has(p)) return false; return true; });
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
  first = undefined;
  startAt = Math.round(performance.now());
  hint = pageLang;
  lat.lookup = [0, 0];
  lat.translate = [0, 0];
  missing.clear();
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const r = e.boundingClientRect;
      const inView = r.top < innerHeight && r.bottom > 0;
      for (const u of byBox.get(e.target) ?? []) enqueue(u, inView);
    }
  }, { rootMargin: '100% 0px' });
  mo = new MutationObserver(onMutations);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  register(scan(document.body));
  api.runtime.sendMessage({ bg: 'badge', on: true }).catch(() => {});
}

function stop() {
  if (!active) return;
  active = false;
  uncover();
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
    first, startAt, lookupMs: avg('lookup'), translateMs: avg('translate') };
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

/** 不看正文就能定下来要不要翻：手动选择、总开关、站点规则、<html lang>，或根本没有语言规则 */
const decidable = () =>
  !!tabChoice() || !rules.settings.auto || !!rules.sites[siteKey(location.hostname)] || !!pageLang || !rules.langs.length;

function reevaluate(restart = false) {
  const want = shouldTranslate();
  if (restart) cache.clear();
  if (active && (!want || restart)) stop();
  if (want) start();
}

const whenBody = () => new Promise<void>(ok => {
  if (document.body) return ok();
  const o = new MutationObserver(() => { if (document.body) { o.disconnect(); ok(); } });
  o.observe(document, { childList: true, subtree: true });
});

const whenParsed = () => new Promise<void>(ok => {
  if (document.readyState !== 'loading') return ok();
  document.addEventListener('DOMContentLoaded', () => ok(), { once: true });
});

// document_start 注入：读规则和页面解析并行；能提前定下来就先预热原生、隐藏页面、边解析边翻
async function main() {
  if (location.protocol === 'about:' || !/html/.test(document.contentType)) return;

  api.runtime.onMessage.addListener((msg: TabCommand) => {
    if (msg?.cmd === 'state') return Promise.resolve(state());
    if (msg?.cmd === 'toggle') {
      if (active) { setTabChoice('off'); stop(); } else { setTabChoice('on'); start(); }
      return Promise.resolve(state());
    }
  });

  rules = await loadRules();
  pageLang = baseLang(document.documentElement.lang);
  const early = decidable();
  if (early && shouldTranslate()) {
    if (rules.settings.cover && document.readyState === 'loading') coverPage();
    api.runtime.sendMessage({ op: 'warm', target: rules.settings.target, fluent: rules.settings.fluent, hint: pageLang }).catch(() => {});
  }
  await whenBody();
  if (early) reevaluate();

  api.storage.onChanged.addListener(async (changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    const before = rules.settings;
    rules = await loadRules();
    // 改了站点 / 语言规则就以规则为准，清掉这个标签页的手动选择
    if ('sites' in changes || 'langs' in changes) setTabChoice(null);
    reevaluate('settings' in changes && (before.target !== rules.settings.target || before.fluent !== rules.settings.fluent));
  });

  // 没声明语言：等正文解析完再识别（提前定下来的页面也补上，弹窗「总是翻译某语言」要用）
  await whenParsed();
  if (cover) setTimeout(() => { if (!coverArmed) uncover(); }, COVER_IDLE_MS);
  if (!pageLang) pageLang = await detectLanguage();
  if (!early) reevaluate();
}

main();
