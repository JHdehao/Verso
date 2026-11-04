// 打包到 Extension/Resources（Xcode 把这个目录里的文件平铺进扩展包根目录，所以不要建子目录）
// --chromium：打 Chromium 版到 dist/chromium（浏览器内置本地翻译代替原生扩展进程，见 src/local.ts），在 chrome://extensions 加载解压的扩展
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const chromium = process.argv.includes('--chromium');
const out = fileURLToPath(new URL(chromium ? '../dist/chromium/' : '../Extension/Resources/', import.meta.url));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: { content: 'src/content.ts', background: 'src/background.ts', popup: 'src/popup.ts' },
  bundle: true,
  minify: !process.argv.includes('--dev'),
  format: 'iife',
  target: chromium ? ['chrome138'] : ['safari17'],
  define: { __CHROMIUM__: String(chromium) },
  outdir: out,
  legalComments: 'none',
  logLevel: 'warning',
});
await cp('static', out, { recursive: true });
if (chromium) {
  // 同一份清单改三处：后台改 service_worker、去掉 nativeMessaging、Translator API 138 起才有
  const manifest = JSON.parse(await readFile('static/manifest.json', 'utf8'));
  manifest.description = '用浏览器内置的本地翻译模型，把网页原样译成你的语言，并记住哪些网站要自动翻译。';
  manifest.background = { service_worker: 'background.js' };
  manifest.permissions = manifest.permissions.filter(p => p !== 'nativeMessaging');
  manifest.minimum_chrome_version = '138';
  await writeFile(`${out}manifest.json`, JSON.stringify(manifest, null, 2));
}
