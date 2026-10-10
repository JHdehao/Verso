// 中转 + 跨页面缓存：内容脚本和弹窗不能直接跟原生扩展进程说话
import { idbStore, lookup, translateCached, warm } from './cache';
import type { LookupRequest, TranslateRequest, TranslateResponse } from './protocol';
import { api, loadRules, siteKey } from './rules';

const native = (msg: unknown): Promise<TranslateResponse> =>
  api.runtime.sendNativeMessage('application.id', msg).then(
    (r: any) => r ?? { ok: false, error: '原生侧没有回复' },
    (e: any) => ({ ok: false, error: String(e?.message ?? e) }),
  );

/** 缓存出任何错都整层旁路，退化成直连原生 */
async function translate(msg: TranslateRequest): Promise<TranslateResponse> {
  if (!msg.cache) return native(msg);
  let run;
  try {
    run = await translateCached(msg, idbStore, native);
  } catch {
    return native(msg);
  }
  setTimeout(() => run.save().catch(() => {}));
  return run.res;
}

async function lookupOnly(msg: LookupRequest): Promise<TranslateResponse> {
  const r = await lookup(msg, idbStore);
  setTimeout(() => r.touch().catch(() => {}));
  return r.res;
}

warm();

const reply = (p: Promise<unknown>, sendResponse: (r: unknown) => void) => {
  p.then(sendResponse, (e: any) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
};

api.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
  if (msg?.bg === 'badge') {
    const tabId = sender.tab?.id;
    if (tabId != null) api.action.setBadgeText({ tabId, text: msg.on ? '•' : '' });
    return;
  }
  if (msg?.bg === 'cache-stat') return reply(idbStore.bytes().then(bytes => ({ ok: true, bytes })), sendResponse);
  if (msg?.bg === 'cache-clear') return reply(idbStore.clear().then(() => ({ ok: true })), sendResponse);
  if (!msg?.op) return;
  const t0 = Date.now();
  const p = msg.op === 'translate' ? translate(msg) : msg.op === 'lookup' ? lookupOnly(msg) : native(msg);
  return reply(p.then(r => ({ ms: Date.now() - t0, ...r })), sendResponse);
});

// 导航一开始（请求还没发出）就预热原生：扩展进程冷启动约 1 秒（真机实测），比内容脚本 document_start 再早一个网络往返。
// 这时还不知道页面语言，按「总是翻译」的第一种语言猜（多半是英语），猜错只是多翻了一个词
api.webNavigation?.onBeforeNavigate.addListener(async (d: { frameId: number; url: string }) => {
  if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
  const rules = await loadRules();
  const site = rules.sites[siteKey(new URL(d.url).hostname)];
  if (!rules.settings.auto || site === 'never' || (!site && !rules.langs.length)) return;
  native({ op: 'warm', target: rules.settings.target, fluent: rules.settings.fluent, hint: rules.langs[0] ?? 'en' });
});

api.commands?.onCommand.addListener(async (command: string) => {
  if (command !== 'toggle-translation') return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) api.tabs.sendMessage(tab.id, { cmd: 'toggle' }).catch(() => {});
});
