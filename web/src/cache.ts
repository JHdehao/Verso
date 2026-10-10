// 跨页面的译文缓存：background 用 IndexedDB 挡在原生调用前面，命中就不唤醒扩展进程。设计见 PLAN.md §3.8
import { cacheKey } from './dom.ts';
import type { Run, TranslateRequest, TranslateResponse, UnitRequest, UnitResult } from './protocol';

/** 改了 serialize / merge / Swift 对齐逻辑就 +1，旧条目不再命中，按 LRU 老化掉 */
export const CACHE_V = 1;
export const LIMIT = 200 * 2 ** 20;
/** 超限后删到这里，留回差，免得每次写入都淘汰 */
export const KEEP = 180 * 2 ** 20;

/** r = null 表示已是目标语言；d = 最近使用的天数戳；n = 估算字节 */
export type Entry = { r: Run[] | null; src?: string; d: number; n: number };

export interface Store {
  get(keys: string[]): Promise<(Entry | undefined)[]>;
  /** 写入新条目，并把命中的旧条目的 d 改成 day */
  write(fresh: [string, Entry][], touch: string[], day: number): Promise<void>;
  bytes(): Promise<number>;
  clear(): Promise<void>;
}

export const today = () => Math.floor(Date.now() / 864e5);

export async function keyOf(msg: Pick<TranslateRequest, 'target' | 'fluent' | 'hint'>, runs: Run[]) {
  const raw = [CACHE_V, msg.target, msg.fluent ? 1 : 0, msg.hint ?? '', cacheKey(runs)].join('\u0002');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return Array.from(hash.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

/** 只存稳定结果：缺语言包 / 不支持 / 出错的不存，装好语言包后要能重翻 */
export function toEntry(r: UnitResult, day: number): Entry | undefined {
  if (r.err) return;
  if (r.runs) return { r: r.runs, src: r.src, d: day, n: 2 * JSON.stringify(r.runs).length + 100 };
  if (r.skip && r.src) return { r: null, src: r.src, d: day, n: 100 };
}

type Req = Pick<TranslateRequest, 'target' | 'fluent' | 'hint' | 'cache' | 'units'>;

/** 只查缓存。rw 命中会顺带刷新使用日期（touch，回复之后再跑）；wo 不读，只算键给后面写入用 */
export async function lookup(msg: Req, store: Store) {
  const day = today();
  const keys = await Promise.all(msg.units.map(u => keyOf(msg, u.runs)));
  const found = msg.cache === 'rw' || msg.cache === 'ro' ? await store.get(keys).catch(() => []) : [];
  const hits: UnitResult[] = [];
  const miss: UnitRequest[] = [];
  const missKey = new Map<string, string>();
  const stale: string[] = [];
  msg.units.forEach((u, i) => {
    const e = found[i];
    if (!e) { miss.push(u); missKey.set(u.id, keys[i]); return; }
    hits.push(e.r ? { id: u.id, runs: e.r, src: e.src } : { id: u.id, src: e.src, skip: 1 });
    if (e.d !== day) stale.push(keys[i]);
  });
  const touch = msg.cache === 'rw' ? stale : [];
  return {
    day, hits, miss, missKey,
    res: { ok: true, results: hits, hits: hits.filter(h => h.runs).length } as TranslateResponse,
    touch: () => (touch.length ? store.write([], touch, day) : Promise.resolve()),
  };
}

/** 命中的直接出结果，没命中的交给 native；save 留给回复之后再跑，不挡回填 */
export async function translateCached(
  msg: TranslateRequest,
  store: Store,
  native: (m: TranslateRequest) => Promise<TranslateResponse>,
): Promise<{ res: TranslateResponse; save: () => Promise<void> }> {
  const { day, hits, miss, missKey, res: cached, touch } = await lookup(msg, store);
  const res: TranslateResponse = miss.length ? await native({ ...msg, units: miss }) : { ok: true };
  // 隐私窗口（ro）只读：不写新条目，也不更新使用时间
  const write = msg.cache === 'rw' || msg.cache === 'wo';
  // 同一批里重复的段落键相同，按键去重，免得字节数重复计
  const fresh = new Map<string, Entry>();
  if (write) for (const r of res.results ?? []) {
    const k = missKey.get(r.id);
    const e = k ? toEntry(r, day) : undefined;
    if (k && e) fresh.set(k, e);
  }
  return {
    res: { ...res, results: [...hits, ...(res.results ?? [])], hits: cached.hits },
    save: async () => { await touch(); if (fresh.size) await store.write([...fresh], [], day); },
  };
}

// ---- IndexedDB 实现。事务里不用 await（Safari 老版本会提前提交），全走回调 ----

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx: IDBTransaction) =>
  new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error); });

let conn: Promise<IDBDatabase> | undefined;
function open() {
  return conn ??= new Promise<IDBDatabase>((ok, no) => {
    const r = indexedDB.open('verso-cache', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('t').createIndex('d', 'd');
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => { r.result.onclose = () => { conn = undefined; }; ok(r.result); };
    r.onerror = () => { conn = undefined; no(r.error); };
  });
}

/** background 一醒就开库，和内容脚本切段并行，第一批查询不用再等开库 */
export const warm = () => { open().catch(() => {}); };

let evicting = false;
/** 按使用日期从旧到新删，每个事务最多删 2000 条，iOS 中途杀进程也不会白干 */
async function evict(db: IDBDatabase) {
  if (evicting) return;
  evicting = true;
  try {
    let total = Infinity;
    while (total > KEEP) {
      const tx = db.transaction(['t', 'meta'], 'readwrite');
      const s = tx.objectStore('t'), meta = tx.objectStore('meta');
      const m = meta.get('bytes');
      m.onsuccess = () => {
        total = m.result ?? 0;
        let left = 2000;
        const c = s.index('d').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (cur && total > KEEP && left-- > 0) { total -= cur.value.n; cur.delete(); cur.continue(); return; }
          if (!cur) total = 0; // 删空了，计数漂移也一并归零
          meta.put(Math.max(0, total), 'bytes');
        };
      };
      await done(tx);
    }
  } finally {
    evicting = false;
  }
}

export const idbStore: Store = {
  async get(keys) {
    const s = (await open()).transaction('t').objectStore('t');
    return Promise.all(keys.map(k => req<Entry | undefined>(s.get(k))));
  },
  async write(fresh, touch, day) {
    const db = await open();
    const tx = db.transaction(['t', 'meta'], 'readwrite');
    const s = tx.objectStore('t'), meta = tx.objectStore('meta');
    let delta = 0, total = 0;
    for (const [k, e] of fresh) {
      const g = s.get(k);
      g.onsuccess = () => { delta += e.n - (g.result?.n ?? 0); s.put(e, k); };
    }
    for (const k of touch) {
      const g = s.get(k);
      g.onsuccess = () => { if (g.result) s.put({ ...g.result, d: day }, k); };
    }
    // 同一事务里的请求按发出顺序完成，到这里 delta 已经算完
    const m = meta.get('bytes');
    m.onsuccess = () => { total = (m.result ?? 0) + delta; meta.put(total, 'bytes'); };
    await done(tx);
    if (total > LIMIT) await evict(db);
  },
  async bytes() {
    return (await req<number | undefined>((await open()).transaction('meta').objectStore('meta').get('bytes'))) ?? 0;
  },
  async clear() {
    const tx = (await open()).transaction(['t', 'meta'], 'readwrite');
    tx.objectStore('t').clear();
    tx.objectStore('meta').clear();
    await done(tx);
  },
};
