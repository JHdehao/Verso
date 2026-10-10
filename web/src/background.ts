// 只做中转：内容脚本和弹窗不能直接跟原生扩展进程说话
import { api } from './rules';

api.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
  if (msg?.bg === 'badge') {
    const tabId = sender.tab?.id;
    if (tabId != null) api.action.setBadgeText({ tabId, text: msg.on ? '•' : '' });
    return;
  }
  if (!msg?.op) return;
  const t0 = Date.now();
  api.runtime.sendNativeMessage('application.id', msg).then(
    (r: any) => sendResponse({ ms: Date.now() - t0, ...(r ?? { ok: false, error: '原生侧没有回复' }) }),
    (e: any) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true;
});

api.commands?.onCommand.addListener(async (command: string) => {
  if (command !== 'toggle-translation') return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) api.tabs.sendMessage(tab.id, { cmd: 'toggle' }).catch(() => {});
});
