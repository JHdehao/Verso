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

test('纯文本译文留在原来的元素里，不露出视觉隐藏的标签', () => {
  const body = page(`<div><a href="#o"><span class="sr">Open Menu</span></a> <a href="#c"><span class="sr">Close Menu</span></a></div>`);
  const [u] = scan(body);
  apply(u, [{ t: '打开菜单 关闭菜单', s: -1 }]);
  const div = body.querySelector('div');
  assert.equal(div.querySelectorAll('a').length, 2);
  assert.equal(div.querySelector('a[href="#o"] span').textContent, '打开菜单 关闭菜单');
  assert.equal(div.querySelector('a[href="#c"] span').textContent, '');
  assert.ok(Array.from(div.childNodes).every(n => n.nodeType !== 3 || !/\S/.test(n.data)));
  restore(u);
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
