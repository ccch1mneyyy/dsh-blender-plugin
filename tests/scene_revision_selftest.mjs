#!/usr/bin/env node
/**
 * tests/scene_revision_selftest.mjs —— v2.3 GUI revision 状态机自检。
 *
 * 只测 runtime/viewstore.mjs 的纯内存状态：不连 Blender、不起后端。
 * 覆盖：
 *   · 探针注入前先捕获（capturedRevision=null）→ 之后 revision>0 算陈旧；
 *   · 捕获会记住当前 revision；再编辑 → 变陈旧，再捕获 → 恢复；
 *   · Blender 重启 revision 归零 → 与旧捕获不同也算陈旧；
 *   · 非法 revision 不污染状态。
 */
import assert from 'node:assert/strict';

const { viewStore } = await import('../runtime/viewstore.mjs');

let pass = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)));
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : String(error)));
  }
}

const putFrame = () => viewStore.put(Buffer.from([1, 2, 3]), 'auto', null, {
  width: 10, height: 10, scene: 'Scene', captured_scene_version: 0,
});

test('初始：没有 revision、也不陈旧', () => {
  assert.equal(viewStore.latest().scene_revision, null);
  assert.equal(viewStore.latest().revision_stale, false);
});

test('探针注入前捕获 → 之后首次编辑算陈旧', () => {
  putFrame();
  viewStore.noteSceneRevision(3);
  const latest = viewStore.latest();
  assert.equal(latest.scene_revision, 3);
  assert.equal(latest.revision_stale, true);
});

test('捕获记住当前 revision；再编辑再陈旧，再捕获恢复', () => {
  putFrame();
  assert.equal(viewStore.latest().revision_stale, false);
  viewStore.noteSceneRevision(4);
  assert.equal(viewStore.latest().revision_stale, true);
  putFrame();
  assert.equal(viewStore.latest().revision_stale, false);
});

test('Blender 重启 revision 归零也算陈旧', () => {
  viewStore.noteSceneRevision(0);
  assert.equal(viewStore.latest().revision_stale, true);
  putFrame();
  assert.equal(viewStore.latest().revision_stale, false);
});

test('非法 revision 不污染状态', () => {
  const before = viewStore.latest().scene_revision;
  viewStore.noteSceneRevision('not-a-number');
  assert.equal(viewStore.latest().scene_revision, before);
});

const total = pass + failures.length;
console.log(JSON.stringify({ suite: 'scene-revision', total, pass, fail: failures.length, failures }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
