// Chromium 版的「原生」：后台 Service Worker 里用浏览器内置的本地翻译（Translator API，TranslateKit 离线模型）和 CLD3 语言识别，
// 翻译本身交给多进程翻译池并行（pool.ts）。
// 对外接口与 Swift 侧（Extension/Sources/SafariWebExtensionHandler.swift）一致，content / cache 不分平台。
// Translator 只吃纯文本，格式靠标签带：行内元素的槽包成 <xN>…</xN>、不翻译的槽换成 <kN/>，模型会跟着语序挪标签（实测）
import type { DiagResponse, NativeRequest, Run, TranslateRequest, TranslateResponse, UnitRequest, UnitResult } from './protocol';
import { call, SIZE } from './pool.ts';
import { api, baseLang } from './rules.ts';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type Kit = { translate(text: string): Promise<string> };
type KitOptions = { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void };
declare const Translator: { availability(o: KitOptions): Promise<Availability>; create(o: KitOptions): Promise<Kit> };

/** 内置翻译的语言代码：简体是 zh，其余照用（zh-Hant、en、ja…） */
const kitLang = (code: string) => (code === 'zh-Hans' ? 'zh' : code);
const pairOf = (src: string, tgt: string): KitOptions => ({ sourceLanguage: kitLang(src), targetLanguage: kitLang(tgt) });

const plainOf = (runs: Run[]) => runs.filter(r => !r.k).map(r => r.t).join('');

/** 原文自带尖括号时分不清哪些是标签，返回 undefined 走纯文本 */
export function encode(runs: Run[]): string | undefined {
  if (runs.some(r => !r.k && /[<>]/.test(r.t))) return undefined;
  return runs.map(r => {
    if (r.k) return `<k${r.s}/>`;
    if (!r.n) return r.t;
    // 首尾空白放到标签外，模型对「<x1> here </x1>」这种处理不好
    const [, lead, body, tail] = r.t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return body ? `${lead}<x${r.s}>${body}</x${r.s}>${tail}` : r.t;
  }).join('');
}

/** 模型偶尔丢掉标签里的字母（实测见过 <4>…</x4>），按编号认 */
const TAG = /<\s*(\/?)\s*[xk]?\s*(\d+)\s*\/?\s*>/g;

/** 译文拆回槽位；标签外的文字记 -1（顶层文字）。占位丢了 / 出现没送过的编号 → undefined，退回纯文本（同苹果框架失败时） */
export function decode(out: string, sent: Run[]): Run[] | undefined {
  const bySlot = new Map(sent.map(r => [r.s, r]));
  const res: Run[] = [];
  const kept = new Set<number>();
  const push = (t: string, s: number) => {
    if (!t) return;
    const last = res[res.length - 1];
    if (last && last.s === s) last.t += t;
    else res.push({ t, s });
  };
  let cur = -1, at = 0;
  for (const m of out.matchAll(TAG)) {
    push(out.slice(at, m.index), cur);
    at = m.index! + m[0].length;
    const s = Number(m[2]);
    const r = bySlot.get(s);
    if (!r) return undefined;
    if (r.k) {
      if (kept.has(s)) return undefined;
      kept.add(s);
      push(r.t, s);
    } else if (m[1]) {
      if (cur === s) cur = -1;
    } else cur = s;
  }
  push(out.slice(at), cur);
  if (sent.some(r => r.k && !kept.has(r.s))) return undefined;
  return res;
}

/**
 * 有页面语言时只信 CLD3 标了 isReliable 的结果：一两句话它常给 100% 却认错（实测 GitHub 提交说明认成 fy / ca / id / it，
 * 长度 40～60 字也一样，isReliable 都是 false）。没有拉丁字母的（中日韩、西里尔…）字形就能定，不让英文页面的提示盖掉
 */
async function detect(text: string, hint?: string): Promise<string | undefined> {
  if (!/\p{L}/u.test(text)) return undefined;
  const r = await api.i18n.detectLanguage(text);
  const top = r?.languages?.[0]?.language;
  const sure = r?.isReliable || !/[a-z]/i.test(text);
  return baseLang(top && top !== 'und' && (sure || !hint) ? top : hint ?? top);
}

/** 走翻译池；池出错（离屏文档起不来等）就退回本进程直连，慢但能用 */
function pooled(src: string, tgt: string): Kit {
  const o = pairOf(src, tgt);
  let direct: Promise<Kit> | undefined;
  return {
    async translate(text) {
      const r = await call({ pool: 'translate', src: o.sourceLanguage, tgt: o.targetLanguage, text }).catch(e => ({ ok: false, error: String(e), text: undefined }));
      if (r.ok) return r.text ?? '';
      direct ??= Translator.create(o);
      return (await direct).translate(text);
    },
  };
}

const kits = new Map<string, Kit>();

/** availability 确认过 available 才给 Kit；每次都要跨进程问一次，所以确认过的语言对记下来 */
async function kit(src: string, tgt: string): Promise<Kit | Availability> {
  const key = `${src}>${tgt}`;
  if (!kits.has(key)) {
    const a = await Translator.availability(pairOf(src, tgt));
    if (a !== 'available') return a;
    kits.set(key, pooled(src, tgt));
  }
  return kits.get(key)!;
}

async function one(k: Kit, u: UnitRequest, src: string): Promise<UnitResult> {
  try {
    const tagged = encode(u.runs);
    if (tagged !== undefined) {
      const runs = decode(await k.translate(tagged), u.runs);
      if (runs) return { id: u.id, runs, src };
    }
    return { id: u.id, runs: [{ t: await k.translate(plainOf(u.runs)), s: -1 }], src };
  } catch (e) {
    return { id: u.id, src, err: String(e) };
  }
}

/** Service Worker 空闲约 30 秒就被回收，回收后第一条消息记为冷启动 */
let served = 0;

async function translate(msg: TranslateRequest): Promise<TranslateResponse> {
  const t0 = performance.now();
  const timing = { detect: 0, avail: 0, translate: 0 };
  let mark = t0;
  const lap = (k: keyof typeof timing) => { const now = performance.now(); timing[k] += Math.round(now - mark); mark = now; };
  const target = baseLang(msg.target) ?? msg.target;
  const results: UnitResult[] = [];
  const missing = new Set<string>();
  const groups = new Map<string, UnitRequest[]>();
  const hint = baseLang(msg.hint);
  for (const u of msg.units) {
    const src = await detect(plainOf(u.runs), hint);
    if (!src) results.push({ id: u.id, skip: 1 });
    else if (src === target) results.push({ id: u.id, src, skip: 1 });
    else if (groups.has(src)) groups.get(src)!.push(u);
    else groups.set(src, [u]);
  }
  lap('detect');
  for (const [src, group] of groups) {
    mark = performance.now();
    let k: Kit | Availability;
    try {
      k = await kit(src, target);
    } catch (e) {
      results.push(...group.map(u => ({ id: u.id, src, err: String(e) })));
      continue;
    }
    lap('avail');
    if (k === 'unavailable') results.push(...group.map(u => ({ id: u.id, src, skip: 1 as const, err: 'unsupported' })));
    else if (typeof k === 'string') {
      // 只为页面本身的语言提示下载：英文页面里零星认出的荷兰语、印尼语（多半是人名、短语）不值得让用户下一个语言包
      if (!hint || src === hint) missing.add(src);
      results.push(...group.map(u => ({ id: u.id, src, err: 'needsDownload' })));
    } else {
      // 全部同时发，翻译池按忙闲分给各进程
      results.push(...await Promise.all(group.map(u => one(k as Kit, u, src))));
      lap('translate');
    }
  }
  return { ok: true, results, missing: [...missing], nms: Math.round(performance.now() - t0), timing, cold: !served++ };
}

const SAMPLES = [
  'Fork this repository and open a pull request on GitHub.',
  'The quick brown fox jumps over the lazy dog.',
  'Install the dependencies before you run the test suite.',
  'This project is licensed under the MIT License.',
  'Contributions are welcome, please read the guide first.',
  'Releases are published automatically when a tag is pushed.',
  'If you find a bug, open an issue with steps to reproduce it.',
  'The documentation covers configuration, deployment and upgrades.',
];

async function diagnose(target: string): Promise<DiagResponse> {
  const lines: string[] = [];
  const tgt = baseLang(target) ?? target;
  const a = await Translator.availability(pairOf('en', tgt));
  lines.push(`本地翻译 英语 → ${tgt}：${a}`);
  if (a !== 'available') return { ok: true, lines };
  let t = performance.now();
  const k = await kit('en', tgt) as Kit;
  const warmed = await call({ pool: 'warm', src: 'en', tgt: kitLang(tgt) }).catch(e => ({ ok: false, error: String(e) }));
  lines.push(`翻译池 ${SIZE} 进程就绪：${Math.round(performance.now() - t)} ms${warmed.ok ? '' : `（失败：${warmed.error}，退回单进程）`}`);
  const runs: Run[] = [{ t: 'Click ', s: 0 }, { t: 'here', s: 1, n: 1 }, { t: ' to open ', s: 2 }, { t: 'npm', s: 3, k: 1 }, { t: ' in the ', s: 4 }, { t: 'editor', s: 5, n: 1 }, { t: '.', s: 6 }];
  t = performance.now();
  const raw = await k.translate(encode(runs)!);
  const back = decode(raw, runs);
  lines.push(`带格式（${Math.round(performance.now() - t)} ms）：${raw}${back ? '' : ' → 对不上号，退回纯文本'}`);
  const xs = [...SAMPLES, ...SAMPLES.map(s => `${s} (2)`)];
  t = performance.now();
  for (const s of xs) await k.translate(s);
  const serial = Math.round(performance.now() - t);
  t = performance.now();
  await Promise.all(xs.map(s => k.translate(`${s} `)));
  lines.push(`吞吐 ${xs.length} 句：逐句 ${serial} ms / 并行 ${Math.round(performance.now() - t)} ms`);
  return { ok: true, lines };
}

export async function local(msg: NativeRequest): Promise<any> {
  try {
    switch (msg.op) {
      case 'translate': return await translate(msg);
      case 'warm': {
        // 叫起翻译池并让每个进程把这对语言的模型加载好
        const src = baseLang(msg.hint), tgt = baseLang(msg.target) ?? msg.target;
        if (src && src !== tgt && typeof await kit(src, tgt) !== 'string') await call({ pool: 'warm', src: kitLang(src), tgt: kitLang(tgt) });
        return { ok: true };
      }
      case 'detect': {
        const lang = await detect(msg.text);
        return lang ? { ok: true, lang } : { ok: false, error: '无法识别' };
      }
      case 'diag': return await diagnose(msg.target);
      case 'capabilities': return { ok: true, fluent: false, reason: 'Chromium 只有一档本地模型' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: false, error: `未知操作 ${(msg as any).op}` };
}

/** 语言包下载要用户手势（点击）才允许，只能在弹窗里调；progress 0～1 */
export async function download(src: string, tgt: string, progress: (p: number) => void): Promise<void> {
  const k = await Translator.create({
    ...pairOf(src, baseLang(tgt) ?? tgt),
    monitor: m => m.addEventListener('downloadprogress', e => progress((e as ProgressEvent).loaded)),
  });
  await k.translate('ready');
}
