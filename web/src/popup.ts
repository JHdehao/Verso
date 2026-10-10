import type { CapabilitiesResponse, Rules, Run, TabState, TranslateResponse } from './protocol';
import { api, LANGUAGES, languageName, loadRules, siteKey } from './rules';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const name = (code: string) => languageName(code);

let rules: Rules;
let tabId: number | undefined;
let tab: TabState | undefined;

async function save(patch: Partial<Rules>) {
  rules = { ...rules, ...patch };
  await api.storage.local.set(patch);
}

async function refresh() {
  try {
    tab = tabId == null ? undefined : await api.tabs.sendMessage(tabId, { cmd: 'state' });
  } catch {
    tab = undefined;
  }
  render();
}

function render() {
  const { target, fluent, auto, cache } = rules.settings;
  $<HTMLSelectElement>('target').value = target;
  $<HTMLInputElement>('auto').checked = auto;
  $<HTMLInputElement>('cache').checked = cache;
  $<HTMLSelectElement>('fluent').value = fluent ? '1' : '0';
  $('page').hidden = !tab;
  $('unavailable').hidden = !!tab;
  if (!tab) { $('pair').textContent = `→ ${name(target)}`; return; }

  const lang = tab.lang;
  $('pair').textContent = lang ? `${name(lang)} → ${name(target)}` : `→ ${name(target)}`;
  const toggle = $('toggle');
  toggle.textContent = tab.active ? '显示原文' : '翻译此页';
  toggle.classList.toggle('on', tab.active);
  $('status').textContent = tab.active
    ? `已翻译 ${tab.done} 段${tab.cached ? `（缓存 ${tab.cached}）` : ''}${tab.failed ? `，${tab.failed} 段失败` : ''}，滚动时继续翻译`
    : '';

  $('langName').textContent = lang ? name(lang) : '此语言';
  const always = $<HTMLInputElement>('alwaysLang');
  always.checked = !!lang && rules.langs.includes(lang);
  always.disabled = !lang || lang === target;
  $('host').textContent = tab.host;
  $<HTMLSelectElement>('site').value = rules.sites[siteKey(tab.host)] ?? '';

  const need = tab.missing[0];
  $('need').hidden = !need;
  if (need) $('needText').textContent = `还没有下载「${name(need)} → ${name(target)}」语言包。`;
}

async function cacheInfo() {
  const r = await api.runtime.sendMessage({ bg: 'cache-stat' }).catch(() => undefined);
  $('cacheInfo').textContent = r?.ok ? `已用 ${(r.bytes / 2 ** 20).toFixed(1)} MB / 200 MB` : '缓存不可用';
}

async function selftest() {
  const out = $('selftestOut');
  out.hidden = false;
  out.textContent = '翻译中…';
  const runs: Run[] = [
    { t: 'Read the ', s: 0 }, { t: 'documentation', s: 1 }, { t: ' before you ', s: 2 },
    { t: 'start', s: 3 }, { t: ', then run ', s: 4 }, { t: 'npm install', s: 5, k: 1 }, { t: '.', s: 6 },
  ];
  const res: TranslateResponse = await api.runtime
    .sendMessage({ op: 'translate', target: rules.settings.target, fluent: rules.settings.fluent, hint: 'en', units: [{ id: 'test', runs }] })
    .catch((e: unknown) => ({ ok: false, error: String(e) }));
  const r = res.results?.[0];
  const text = r?.runs?.map(x => (x.s < 0 ? x.t : `[${x.s}]${x.t}`)).join('') ?? '';
  out.textContent = [
    `ok: ${res.ok}  耗时: ${res.ms ?? '?'} ms`,
    r?.src ? `源语言: ${r.src}` : '',
    text ? `译文: ${text}` : '',
    r?.err ? `单元错误: ${r.err}` : '',
    res.missing?.length ? `缺语言包: ${res.missing.join(', ')}` : '',
    res.error ? `错误: ${res.error}` : '',
    tab?.active ? `本页：首段 ${tab.first ?? '-'} ms，查缓存往返 ${tab.lookupMs ?? '-'} ms，翻译往返 ${tab.translateMs ?? '-'} ms` : '',
  ].filter(Boolean).join('\n');
}

async function main() {
  rules = await loadRules();
  const target = $<HTMLSelectElement>('target');
  for (const code of LANGUAGES) target.add(new Option(name(code), code));
  [tabId] = (await api.tabs.query({ active: true, currentWindow: true })).map((t: { id?: number }) => t.id);

  $('toggle').onclick = async () => {
    tab = await api.tabs.sendMessage(tabId, { cmd: 'toggle' }).catch(() => tab);
    render();
  };
  $<HTMLInputElement>('alwaysLang').onchange = e => {
    const lang = tab?.lang;
    if (!lang) return;
    const on = (e.target as HTMLInputElement).checked;
    save({ langs: on ? [...new Set([...rules.langs, lang])] : rules.langs.filter(l => l !== lang) });
  };
  $<HTMLSelectElement>('site').onchange = e => {
    if (!tab) return;
    const sites = { ...rules.sites };
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'always' || v === 'never') sites[siteKey(tab.host)] = v;
    else delete sites[siteKey(tab.host)];
    save({ sites });
  };
  target.onchange = () => save({ settings: { ...rules.settings, target: target.value } });
  $<HTMLSelectElement>('fluent').onchange = e =>
    save({ settings: { ...rules.settings, fluent: (e.target as HTMLSelectElement).value === '1' } });
  $('download').onclick = () => {
    const src = tab?.missing[0];
    if (!src) return;
    api.tabs.update(tabId, { url: `verso://download?src=${src}&tgt=${rules.settings.target}` });
    window.close();
  };
  $('selftest').onclick = selftest;
  $<HTMLInputElement>('auto').onchange = e =>
    save({ settings: { ...rules.settings, auto: (e.target as HTMLInputElement).checked } });
  $<HTMLInputElement>('cache').onchange = e =>
    save({ settings: { ...rules.settings, cache: (e.target as HTMLInputElement).checked } });
  $('cacheClear').onclick = async () => {
    await api.runtime.sendMessage({ bg: 'cache-clear' }).catch(() => {});
    cacheInfo();
  };
  cacheInfo();

  // 没有 Apple 智能时「流畅」会被系统静默降级，干脆标灰并切到「快速」
  const caps: CapabilitiesResponse = await api.runtime.sendMessage({ op: 'capabilities' }).catch(() => ({ ok: false }));
  if (caps.ok && caps.fluent === false) {
    const fluentOption = $<HTMLSelectElement>('fluent').options[0];
    fluentOption.disabled = true;
    fluentOption.textContent = `流畅（${caps.reason ?? 'Apple 智能不可用'}）`;
    if (rules.settings.fluent) await save({ settings: { ...rules.settings, fluent: false } });
  }

  await refresh();
  setInterval(refresh, 1000);
}

main();
