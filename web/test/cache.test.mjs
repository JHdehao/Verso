import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, lookup, today, toEntry, translateCached } from '../src/cache.ts';

/** 内存版存储，只测拆分 / 合并 / 写入逻辑；IndexedDB 适配层靠真机自检 */
function memStore() {
  const map = new Map();
  return {
    map,
    async get(keys) { return keys.map(k => map.get(k)); },
    async write(fresh, touch, day) {
      for (const [k, e] of fresh) map.set(k, e);
      for (const k of touch) map.set(k, { ...map.get(k), d: day });
    },
    async bytes() { return 0; },
    async clear() { map.clear(); },
  };
}

const unit = (id, t) => ({ id, runs: [{ t, s: 0 }] });
const req = (units, cache = 'rw', target = 'zh-Hans') => ({ op: 'translate', target, fluent: true, hint: 'en', cache, units });

function fakeNative() {
  const calls = [];
  const fn = async m => {
    calls.push(m.units.map(u => u.id));
    return {
      ok: true,
      results: m.units.map(u => {
        const t = u.runs[0].t;
        if (t === 'Hallo') return { id: u.id, err: 'needsDownload', src: 'de' };
        if (t === '你好') return { id: u.id, src: 'zh-Hans', skip: 1 };
        return { id: u.id, src: 'en', runs: [{ t: `译:${t}`, s: 0 }] };
      }),
    };
  };
  return { fn, calls };
}

test('缓存：第二次全命中不调原生；出错的不存，已是目标语言的存成跳过', async () => {
  const store = memStore(), nat = fakeNative();
  const units = [unit('a', 'Hello'), unit('b', 'Hallo'), unit('c', '你好')];
  let run = await translateCached(req(units), store, nat.fn);
  assert.equal(run.res.hits, 0);
  await run.save();
  assert.equal(store.map.size, 2);

  run = await translateCached(req(units), store, nat.fn);
  assert.deepEqual(nat.calls, [['a', 'b', 'c'], ['b']]);
  assert.equal(run.res.hits, 1);
  const byId = Object.fromEntries(run.res.results.map(r => [r.id, r]));
  assert.deepEqual(byId.a.runs, [{ t: '译:Hello', s: 0 }]);
  assert.equal(byId.c.skip, 1);
  assert.equal(byId.b.err, 'needsDownload');
});

test('缓存：目标语言 / 译法不同不串；只读模式不写', async () => {
  const store = memStore(), nat = fakeNative();
  await (await translateCached(req([unit('a', 'Hello')]), store, nat.fn)).save();
  const run = await translateCached(req([unit('a', 'Hello')], 'ro', 'ja'), store, nat.fn);
  assert.equal(run.res.hits, 0);
  await run.save();
  assert.equal(store.map.size, 1);
  assert.notEqual(await keyOf(req([]), unit('a', 'x').runs), await keyOf({ ...req([]), fluent: false }, unit('a', 'x').runs));
});

test('缓存：同批重复段落只存一条；命中旧条目会刷新使用日期', async () => {
  const store = memStore(), nat = fakeNative();
  await (await translateCached(req([unit('a', 'Hi'), unit('b', 'Hi')]), store, nat.fn)).save();
  assert.equal(store.map.size, 1);
  const [k] = store.map.keys();
  store.map.set(k, { ...store.map.get(k), d: 1 });
  await (await translateCached(req([unit('c', 'Hi')]), store, nat.fn)).save();
  assert.equal(store.map.get(k).d, today());
  assert.equal(toEntry({ id: 'x', skip: 1 }, 0), undefined);
});

test('缓存：lookup 只回命中的；wo 不读只写，供 lookup 之后的翻译用', async () => {
  const store = memStore(), nat = fakeNative();
  await (await translateCached(req([unit('a', 'Hello')]), store, nat.fn)).save();
  const r = await lookup(req([unit('a', 'Hello'), unit('b', 'World')]), store);
  assert.deepEqual(r.res.results.map(x => x.id), ['a']);
  assert.equal(r.res.hits, 1);
  assert.deepEqual(r.miss.map(u => u.id), ['b']);

  const run = await translateCached(req([unit('a', 'Hello'), unit('b', 'World')], 'wo'), store, nat.fn);
  assert.equal(run.res.hits, 0);
  assert.deepEqual(nat.calls.at(-1), ['a', 'b']);
  await run.save();
  assert.equal(store.map.size, 2);
});
