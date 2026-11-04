import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../src/local.ts';

const runs = [
  { t: 'Click ', s: 0 }, { t: ' here ', s: 1, n: 1 }, { t: ' to run ', s: 2 }, { t: 'npm i', s: 3, k: 1 }, { t: '.', s: 4 },
];

test('编码：行内元素包标签（空白放外面），不翻译的换占位，顶层文字不标', () => {
  assert.equal(encode(runs), 'Click  <x1>here</x1>  to run <k3/>.');
  assert.equal(encode([{ t: 'a < b', s: 0 }]), undefined);
  assert.equal(encode([{ t: 'x', s: 0 }, { t: '<b>', s: 1, k: 1 }]), 'x<k1/>');
});

test('解码：标签挪了位置照样归槽，占位还原原文，标签外记 -1', () => {
  assert.deepEqual(decode('运行<k3/>请点击<x1>此处</x1>。', runs), [
    { t: '运行', s: -1 }, { t: 'npm i', s: 3 }, { t: '请点击', s: -1 }, { t: '此处', s: 1 }, { t: '。', s: -1 },
  ]);
});

test('解码：容忍模型丢掉标签字母（<1>…</x1>）', () => {
  assert.deepEqual(decode('点击<1>此处</x1>运行<k3/>', runs), [
    { t: '点击', s: -1 }, { t: '此处', s: 1 }, { t: '运行', s: -1 }, { t: 'npm i', s: 3 },
  ]);
});

test('解码：占位丢失 / 重复 / 编号没送过 → 退回纯文本', () => {
  assert.equal(decode('点击<x1>此处</x1>运行。', runs), undefined);
  assert.equal(decode('<k3/><k3/><x1>此处</x1>', runs), undefined);
  assert.equal(decode('<x9>此处</x9><k3/>', runs), undefined);
});
