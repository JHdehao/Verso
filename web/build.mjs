// 打包到 Extension/Resources（Xcode 把这个目录里的文件平铺进扩展包根目录，所以不要建子目录）
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../Extension/Resources/', import.meta.url));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: { content: 'src/content.ts', background: 'src/background.ts', popup: 'src/popup.ts' },
  bundle: true,
  minify: !process.argv.includes('--dev'),
  format: 'iife',
  target: ['safari17'],
  outdir: out,
  legalComments: 'none',
  logLevel: 'warning',
});
await cp('static', out, { recursive: true });
