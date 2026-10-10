import type { Rules } from './protocol';

// Safari 用 browser.*，其余兼容 chrome.*
export const api: any = (globalThis as any).browser ?? (globalThis as any).chrome;

/** 语言标签归一成翻译用的代码：中文区分简繁，其余取基础语言 */
export function baseLang(tag?: string | null): string | undefined {
  if (!tag) return undefined;
  const t = tag.trim().toLowerCase().replace('_', '-');
  if (!t || t === 'und') return undefined;
  if (t.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(t) ? 'zh-Hant' : 'zh-Hans';
  return t.split('-')[0];
}

export const defaultTarget = () => baseLang(globalThis.navigator?.language) ?? 'zh-Hans';

export const siteKey = (host: string) => host.replace(/^www\./, '');

export async function loadRules(): Promise<Rules> {
  const r = await api.storage.local.get(['settings', 'sites', 'langs']);
  return {
    settings: { target: defaultTarget(), fluent: true, auto: true, cache: true, cover: true, ...r.settings },
    sites: r.sites ?? {},
    langs: r.langs ?? [],
  };
}

/** 总开关关掉就都不自动翻；否则站点规则优先，其次是「永远翻译某种语言」 */
export function wants(rules: Rules, host: string, lang?: string): boolean {
  if (!rules.settings.auto) return false;
  const site = rules.sites[siteKey(host)];
  if (site) return site === 'always';
  return !!lang && lang !== rules.settings.target && rules.langs.includes(lang);
}

export function languageName(code: string, locale = 'zh-Hans') {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 苹果 Translation 框架支持的语言（目标语言下拉框用） */
export const LANGUAGES = [
  'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar',
  'nl', 'pl', 'tr', 'uk', 'vi', 'th', 'id', 'hi',
];
