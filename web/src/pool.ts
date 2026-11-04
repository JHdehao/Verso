// Chromium 版翻译池。内置翻译按来源（origin）分服务进程，每个进程单线程（实测一句约 50 ms、占满一核，同一来源开多个
// Translator 也不并行）。扩展的沙箱页面每个都是独立的匿名来源 → 离屏文档里开 SIZE 个沙箱 iframe，各占一个进程一个核，
// 48 句实测 1 路 3563 ms / 2 路 1899 / 4 路 1018。上限受 TranslationAPIMaxServiceCount 约束（约 10，含其他标签页），取 6 留余量。
// 消息：后台 --runtime--> 离屏文档（host）--postMessage--> 沙箱 iframe（worker）。模型常驻在池里，空闲 IDLE_MS 后离屏文档自关释放内存
import { api } from './rules.ts';

type Kit = { translate(text: string): Promise<string> };
declare const Translator: { create(o: { sourceLanguage: string; targetLanguage: string }): Promise<Kit> };

export const SIZE = 6;
const IDLE_MS = 5 * 60_000;

export type PoolRequest = { pool: 'translate'; src: string; tgt: string; text: string } | { pool: 'warm'; src: string; tgt: string };
export type PoolResponse = { ok: boolean; text?: string; error?: string };

// ---- 后台侧 ----

let opening: Promise<void> | undefined;

async function open() {
  if (await api.offscreen.hasDocument()) return;
  await api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['IFRAME_SCRIPTING'], justification: '本地翻译池：多个沙箱页面并行翻译' });
}

export async function call(msg: PoolRequest): Promise<PoolResponse> {
  // 离屏文档可能已空闲自关，每次都确认一下（hasDocument 是本进程内查询，很便宜）
  await (opening ??= open().finally(() => { opening = undefined; }));
  return (await api.runtime.sendMessage(msg)) ?? { ok: false, error: '翻译池没有回复' };
}

// ---- 离屏文档（host）----

export function host() {
  type Worker = { win: Window; busy: number };
  const workers: Worker[] = [];
  const waiting = new Map<number, (r: PoolResponse) => void>();
  let seq = 0;
  const ready = Promise.all(Array.from({ length: SIZE }, () => new Promise<void>(resolve => {
    const f = document.createElement('iframe');
    f.allow = 'translator *'; // 沙箱页面是匿名来源，默认只放行 src 的来源，要显式放开
    f.src = 'sandbox.html';
    f.onload = () => { workers.push({ win: f.contentWindow!, busy: 0 }); resolve(); };
    document.body.append(f);
  })));
  addEventListener('message', e => {
    if (!workers.some(w => w.win === e.source)) return;
    const done = waiting.get(e.data?.id);
    if (done) { waiting.delete(e.data.id); done(e.data); }
  });
  const post = (w: Worker, data: object) => new Promise<PoolResponse>(resolve => {
    const id = ++seq;
    w.busy++;
    waiting.set(id, r => { w.busy--; resolve(r); });
    w.win.postMessage({ id, ...data }, '*');
  });
  let idle = setTimeout(() => close(), IDLE_MS);
  api.runtime.onMessage.addListener((msg: PoolRequest, _sender: unknown, reply: (r: PoolResponse) => void) => {
    if (msg?.pool !== 'translate' && msg?.pool !== 'warm') return;
    clearTimeout(idle);
    idle = setTimeout(() => close(), IDLE_MS);
    ready.then(async () => {
      const { src, tgt } = msg;
      if (msg.pool === 'warm') {
        const rs = await Promise.all(workers.map(w => post(w, { src, tgt, text: '' })));
        return reply(rs.find(r => !r.ok) ?? { ok: true });
      }
      // 给最闲的那个；一样闲就轮到下标靠前的
      const w = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      reply(await post(w, { src, tgt, text: msg.text }));
    });
    return true;
  });
}

// ---- 沙箱 iframe（worker）----

export function worker() {
  const kits = new Map<string, Promise<Kit>>();
  addEventListener('message', async e => {
    if (e.source !== parent) return;
    const { id, src, tgt, text } = e.data ?? {};
    if (id == null) return;
    const key = `${src}>${tgt}`;
    try {
      let k = kits.get(key);
      if (!k) {
        k = Translator.create({ sourceLanguage: src, targetLanguage: tgt });
        kits.set(key, k);
        k.catch(() => kits.delete(key));
      }
      const kit = await k;
      parent.postMessage({ id, ok: true, text: text ? await kit.translate(text) : '' }, '*');
    } catch (err) {
      parent.postMessage({ id, ok: false, error: String(err) }, '*');
    }
  });
}
