import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { apply, restore, scan, serialize } from '../src/dom.ts';

const page = html => new JSDOM(`<body>${html}</body>`).window.document.body;
const text = unit => serialize(unit).map(r => r.t).join('');

test('切段：段落、列表项各成一段，跳过 pre / translate=no / 可编辑区 / 纯数字', () => {
  const body = page(`
    <div>
      <p>Read the <a href="/d">docs</a> first.</p>
      <ul><li>One</li><li>Two <b>x</b></li></ul>
      <pre>code block</pre>
      <p translate="no">Keep me</p>
      <div contenteditable>Draft</div>
      <p>42</p>
      Loose text in div
      <section><h2>Title</h2></section>
    </div>`);
  const units = scan(body);
  assert.deepEqual(units.map(text), ['Read the docs first.', 'One', 'Two x', 'Loose text in div', 'Title']);
});

test('切段：带块级后代的行内元素当容器处理', () => {
  const body = page(`<a href="/card"><div>Card title</div><span>meta</span></a>`);
  assert.deepEqual(scan(body).map(text), ['Card title', 'meta']);
});

test('原地回填：顶层文字语序变化，链接元素原样保留', () => {
  const body = page(`<p>Read the <a href="/d">docs</a> first.</p>`);
  const p = body.querySelector('p');
  const a = p.querySelector('a');
  const [u] = scan(body);
  assert.equal(apply(u, [{ t: '先阅读', s: 2 }, { t: '文档', s: 1 }]), 'inplace');
  assert.equal(p.textContent, '先阅读文档');
  assert.equal(p.querySelector('a'), a, '同一个 <a> 节点');
  assert.equal(a.getAttribute('href'), '/d');
  restore(u);
  assert.equal(p.innerHTML, 'Read the <a href="/d">docs</a> first.');
});

test('重建：行内元素顺序被调换时克隆元素，还原后回到原节点', () => {
  const body = page(`<p><a href="#a">A</a> and <b>B</b></p>`);
  const p = body.querySelector('p');
  const a = p.querySelector('a');
  const [u] = scan(body);
  assert.equal(apply(u, [{ t: '乙', s: 2 }, { t: '和', s: 1 }, { t: '甲', s: 0 }]), 'rebuild');
  assert.equal(p.innerHTML, '<b>乙</b>和<a href="#a">甲</a>');
  restore(u);
  assert.equal(p.innerHTML, '<a href="#a">A</a> and <b>B</b>');
  assert.equal(p.querySelector('a'), a);
});

test('原子元素：代码带文字标为不翻译，换行用 \\n，原地回填时不动它们', () => {
  const body = page(`<p>Run <code>npm i</code> now<br>next line</p>`);
  const p = body.querySelector('p');
  const [u] = scan(body);
  assert.deepEqual(serialize(u), [
    { t: 'Run ', s: 0 }, { t: 'npm i', s: 1, k: 1 }, { t: ' now', s: 2 }, { t: '\n', s: 3, k: 1 }, { t: 'next line', s: 4 },
  ]);
  apply(u, [{ t: '运行 ', s: 0 }, { t: 'npm i', s: 1 }, { t: ' 现在', s: 2 }, { t: '\n', s: 3 }, { t: '下一行', s: 4 }]);
  assert.equal(p.innerHTML, '运行 <code>npm i</code> 现在<br>下一行');
});

test('原地回填：两个行内元素之间原本没有文字，译文多出连接词时补一个文本节点', () => {
  const body = page(`<p><a>A</a><b>B</b></p>`);
  const p = body.querySelector('p');
  const [u] = scan(body);
  assert.equal(apply(u, [{ t: '甲', s: 0 }, { t: '和', s: -1 }, { t: '乙', s: 1 }]), 'inplace');
  assert.equal(p.innerHTML, '<a>甲</a>和<b>乙</b>');
  restore(u);
  assert.equal(p.innerHTML, '<a>A</a><b>B</b>');
});

test('嵌套行内元素：链按公共前缀合并，不重复克隆外层', () => {
  const body = page(`<p>Hello <a href="/x"><b>big</b> world</a></p>`);
  const p = body.querySelector('p');
  const [u] = scan(body);
  // 「world」挪到「big」前面 → 只能重建
  apply(u, [{ t: '你好 ', s: 0 }, { t: '世界', s: 2 }, { t: '大', s: 1 }]);
  assert.equal(p.innerHTML, '你好 <a href="/x">世界<b>大</b></a>');
});

test('译文丢了槽位编号（-1）时归到顶层文字', () => {
  const body = page(`<p>Plain sentence here.</p>`);
  const [u] = scan(body);
  apply(u, [{ t: '这里是一句话。', s: -1 }]);
  assert.equal(body.querySelector('p').textContent, '这里是一句话。');
});

test('一排只含视觉隐藏标签的链接各成一段，纯文本译文留在各自元素里，不露在外面', () => {
  const body = page(`<div><a href="#o"><span class="sr">Open Menu</span></a> <a href="#c"><span class="sr">Close Menu</span></a></div>`);
  const units = scan(body);
  assert.equal(units.length, 2);
  apply(units[0], [{ t: '打开菜单', s: -1 }]);
  apply(units[1], [{ t: '关闭菜单', s: -1 }]);
  const div = body.querySelector('div');
  assert.equal(div.querySelector('a[href="#o"] span').textContent, '打开菜单');
  assert.equal(div.querySelector('a[href="#c"] span').textContent, '关闭菜单');
  assert.ok(Array.from(div.childNodes).every(n => n.nodeType !== 3 || !/\S/.test(n.data)));
  units.forEach(restore);
  assert.equal(div.textContent, 'Open Menu Close Menu');
});

test('纯文本译文不会挪到原子元素前面', () => {
  const body = page(`<p><img src="x.png"> Caption here</p>`);
  const [u] = scan(body);
  apply(u, [{ t: '图片说明', s: -1 }]);
  const p = body.querySelector('p');
  assert.equal(p.firstChild.nodeName, 'IMG');
  assert.equal(p.textContent, '图片说明');
});

test('已经切过的节点不会被重复切段', () => {
  const body = page(`<p>Once</p>`);
  assert.equal(scan(body).length, 1);
  assert.equal(scan(body).length, 0);
});

test('锚定原子槽：对齐差一个字符时把「l」还给行内代码，前导空格还给前一槽', async () => {
  const { anchorAtoms } = await import('../src/dom.ts');
  const sent = [{ t: ', then run ', s: 4 }, { t: 'npm install', s: 5, k: 1 }, { t: '.', s: 6 }];
  const got = [{ t: '，然后运行', s: 4 }, { t: ' npm instal', s: 5 }, { t: 'l 。', s: 6 }];
  assert.deepEqual(anchorAtoms(sent, got), [{ t: '，然后运行 ', s: 4 }, { t: 'npm install', s: 5 }, { t: ' 。', s: 6 }]);
  // 找不到原文（被译掉了）就不动
  assert.deepEqual(anchorAtoms(sent, [{ t: '运行npm安装。', s: -1 }]), [{ t: '运行npm安装。', s: -1 }]);
});

test('回填：带格式译文对齐偏一个字符，行内代码后不多出字母', () => {
  const body = page(`<p>Then run <code>npm install</code>.</p>`);
  const [u] = scan(body);
  const runs = serialize(u);
  const code = runs.find(r => r.k).s, tail = runs[runs.length - 1].s, head = runs[0].s;
  apply(u, [{ t: '然后运行', s: head }, { t: ' npm instal', s: code }, { t: 'l 。', s: tail }]);
  assert.equal(body.querySelector('p').textContent, '然后运行 npm install 。');
  assert.equal(body.querySelector('code').textContent, 'npm install');
});

test('锚定：计数器槽多占两个以上字符也能整段还给前一槽', async () => {
  const { anchorAtoms } = await import('../src/dom.ts');
  assert.deepEqual(
    anchorAtoms([{ t: 'Watch', s: 0 }, { t: '13', s: 1 }], [{ t: '手', s: 0 }, { t: '表 13', s: 1 }]),
    [{ t: '手表 ', s: 0 }, { t: '13', s: 1 }]);
});

test('回填：按钮「Watch 13」译文跑进计数器时纠正，计数器只留数字', () => {
  const body = page(`<a href="#"><span>Watch</span> <span class="c">13</span></a>`);
  const [u] = scan(body);
  const runs = serialize(u);
  const word = runs.find(r => r.t === 'Watch').s, count = runs.find(r => r.t === '13').s;
  apply(u, [{ t: '手', s: word }, { t: '表 13', s: count }]);
  assert.equal(body.querySelector('.c').textContent, '13');
  assert.equal(body.textContent.replace(/\s+/g, ''), '手表13');
});

test('切段：一排独立链接（主题标签）各成一段，连字符标识符不翻', () => {
  const body = page(`<div><a href="#">ai-agents</a> <a href="#">Full text</a> · <a href="#">Vector search</a></div>`);
  assert.deepEqual(scan(body).map(text), ['Full text', 'Vector search']);
});

test('锚定：带数量单位的计数器（9.2k）也按原文锚定', async () => {
  const { anchorAtoms } = await import('../src/dom.ts');
  assert.deepEqual(
    anchorAtoms([{ t: 'Fork ', s: 0 }, { t: '9.2k', s: 2 }], [{ t: '叉', s: 0 }, { t: '子9.2k', s: 2 }]),
    [{ t: '叉子', s: 0 }, { t: '9.2k', s: 2 }]);
});

test('切段：按钮和 role=button 各成一段，不和旁边的按钮、提示框并在一起', () => {
  const body = page(`<div><button><span>Code</span></button><a role="button" href="#">More options</a><span>Sign in</span></div>`);
  assert.deepEqual(scan(body).map(text), ['Code', 'More options', 'Sign in']);
});

test('只翻正文：菜单 / 导航照翻，跳过按钮、标识符、正文里的单个词和短链接', async () => {
  const { scanOptions } = await import('../src/dom.ts');
  scanOptions.bodyOnly = true;
  try {
    const body = page(`
      <nav><a href="#">Code</a> <a href="#">Pull requests</a> <a href="#">JHdehao/Conch-dev</a> <a href="#">ghidra</a> <a href="#">NationalSecurityAgency</a></nav>
      <div><button><span>Watch</span> <span>1172</span></button></div>
      <h2>About</h2>
      <p>Ghidra is a Software Reverse Engineering (SRE) Framework</p>
      <ul><li><a href="#">Readme</a></li><li><a href="#">Code of conduct</a></li></ul>
      <span>Public</span>
      <div><a href="#">Show HN: A faster way to build apps</a></div>`);
    assert.deepEqual(scan(body).map(text), ['Code', 'Pull requests', 'About', 'Ghidra is a Software Reverse Engineering (SRE) Framework', 'Show HN: A faster way to build apps']);
  } finally {
    scanOptions.bodyOnly = false;
  }
});

test('中英文间加空格：段内和跨槽都加，跨到行内代码时空格放在代码外面', async () => {
  const { spaced } = await import('../src/dom.ts');
  const body = page(`<p>Run <code>npm</code> now, Apache license</p>`);
  const [u] = scan(body);
  const [head, code, tail] = serialize(u).map(r => r.s);
  assert.deepEqual(spaced(u, [{ t: '运行', s: head }, { t: 'npm', s: code }, { t: '现在，Apache许可证', s: tail }]),
    [{ t: '运行 ', s: head }, { t: 'npm', s: code }, { t: ' 现在，Apache 许可证', s: tail }]);
});

test('首尾图标固定：下拉箭头被译文插到词中间时挪回段尾', async () => {
  const { pinEdges } = await import('../src/dom.ts');
  const sent = [{ t: '￼', s: 0, k: 1 }, { t: 'Code', s: 1 }, { t: '￼', s: 2, k: 1 }];
  assert.deepEqual(pinEdges(sent, [{ t: '代', s: 1 }, { t: '', s: 2 }, { t: '码', s: 1 }, { t: '', s: 0 }]),
    [{ t: '', s: 0 }, { t: '代', s: 1 }, { t: '码', s: 1 }, { t: '', s: 2 }]);
});

test('锚定：译文里原样保留的名字被切掉尾巴时还回来', async () => {
  const { anchorAtoms } = await import('../src/dom.ts');
  assert.deepEqual(
    anchorAtoms([{ t: 'ryanmkurtz', s: 0 }, { t: ' ', s: 1 }, { t: '2 days ago', s: 2 }], [{ t: 'ryanmkurt', s: 0 }, { t: 'z 2天前', s: 2 }]),
    [{ t: 'ryanmkurtz', s: 0 }, { t: ' 2天前', s: 2 }]);
});

test('切段：被 CSS 排成块的 span 各成一段（菜单项标题和说明）', () => {
  const body = page(`<style>.t,.d{display:block}</style><a href="#"><span class="t">GitHub Copilot</span><span class="d">Write better code with AI</span></a>`);
  assert.deepEqual(scan(body).map(text), ['GitHub Copilot', 'Write better code with AI']);
});
