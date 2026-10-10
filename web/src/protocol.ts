// 内容脚本 ⇄ 后台 ⇄ 原生扩展进程之间的消息格式（Swift 侧见 Shared/Translator.swift）

/** 一段文字：s = 段内槽位编号（-1 表示译文里对不上号的文字），k = 不翻译（行内代码、换行等） */
export type Run = { t: string; s: number; k?: 1 };

export type UnitRequest = { id: string; runs: Run[] };

export type TranslateRequest = {
  op: 'translate';
  target: string;
  fluent: boolean;
  /** 页面声明或检测出的语言，短句识别不准时兜底 */
  hint?: string;
  /** 跨页面缓存：rw = 读写，ro = 只读（隐私窗口），wo = 只写（已经 lookup 过），不带 = 关闭。只在 background 用，不进原生 */
  cache?: 'rw' | 'ro' | 'wo';
  units: UnitRequest[];
};

export type UnitResult = {
  id: string;
  runs?: Run[];
  src?: string;
  /** 已是目标语言 / 没有可翻的文字 / 不支持的语言 */
  skip?: 1;
  err?: string;
};

export type TranslateResponse = {
  ok: boolean;
  results?: UnitResult[];
  /** 没装语言包的源语言 */
  missing?: string[];
  error?: string;
  ms?: number;
  /** 其中来自缓存的段数 */
  hits?: number;
};

/** 只查缓存（background 处理，不进原生），回复里 results 只含命中的 */
export type LookupRequest = Omit<TranslateRequest, 'op'> & { op: 'lookup' };

/** 预热原生：叫醒扩展进程，hint 已知时顺带把这对语言的模型加载好 */
export type WarmRequest = { op: 'warm'; target: string; fluent: boolean; hint?: string };

export type DetectRequest = { op: 'detect'; text: string };
export type DetectResponse = { ok: boolean; lang?: string; error?: string };

export type CapabilitiesRequest = { op: 'capabilities' };
/** fluent = 本机能用「流畅」（Apple 智能）；不能时 reason 说明原因 */
export type CapabilitiesResponse = { ok: boolean; fluent?: boolean; reason?: string; error?: string };

export type NativeRequest = TranslateRequest | WarmRequest | DetectRequest | CapabilitiesRequest;

/** auto = 按站点 / 语言规则自动翻译（关掉后只能手动翻译此页）；cache = 跨页面缓存译文；cover = 防闪烁（第一屏译好前先隐藏页面） */
export type Settings = { target: string; fluent: boolean; auto: boolean; cache: boolean; cover: boolean };
export type SiteRule = 'always' | 'never';
export type Rules = {
  settings: Settings;
  sites: Record<string, SiteRule>;
  /** 永远自动翻译的源语言（基础代码，如 en / ja） */
  langs: string[];
};

/** 弹窗 → 内容脚本 */
export type TabCommand = { cmd: 'state' } | { cmd: 'toggle' };

export type TabState = {
  host: string;
  lang?: string;
  active: boolean;
  units: number;
  done: number;
  /** done 里来自缓存的段数（页内 + 跨页面） */
  cached: number;
  failed: number;
  /** 端到端耗时（ms）：打开页面到第一段回填；查缓存、翻译的平均往返 */
  first?: number;
  lookupMs?: number;
  translateMs?: number;
  missing: string[];
};
