#!/usr/bin/env node
/**
 * tests/tui_panel_selftest.mjs —— TUI 侧栏视口面板（src/tui-panel.ts）纯逻辑自检。
 *
 * 覆盖：
 *   · decodePngToRgba：现场用 node:zlib 构造合法 PNG（2×2 RGBA，filter 0/1/2/3/4
 *     混用、多段 IDAT），断言像素；坏数据/不支持格式一律 null 不抛。
 *   · fitCells：终端单元 2:1、clamp、极窄面板、纵横比。
 *   · mapClickToNormalized：0..1 映射、边界夹取、图外 null。
 *   · downscaleRgba：最近邻缩放形状/像素。
 *   · autoCaptureDecision：stale + 静默才重拍；隐藏/点选/忙/节流/同 seq/停手全部跳过。
 *   · followCaptureDue：只有跟随开启、面板可见、静默、且到间隔才抓。
 *   · revisionStaleDue / formatAge：GUI revision 停稳判定与帧龄文案。
 *   · registerTuiViewportPanel：descriptor 字段、disposer 经 ctx.effect 清理、
 *     无服务/register 抛错/ctx.effect 抛错都不抛。
 *
 * 只依赖 Node 内置模块，不需要 Blender / 后端 / 网络。
 * 模块解析：先 DSH_BLENDER_TUI_PANEL_MODULE，再 ../lib/tui-panel.js；
 * 都不存在 → 打印 SKIP 并 exit 0（与仓内其它上游产物自检一致）。
 *
 * 用法：node tests/tui_panel_selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [];
if (process.env.DSH_BLENDER_TUI_PANEL_MODULE) {
  CANDIDATES.push(path.resolve(process.env.DSH_BLENDER_TUI_PANEL_MODULE));
}
CANDIDATES.push(path.join(HERE, '..', 'lib', 'tui-panel.js'));

const modulePath = CANDIDATES.find((candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
});
if (!modulePath) {
  console.log('SKIP: tui-panel 构建产物不存在，跳过（先编译 src/tui-panel.ts，或用 DSH_BLENDER_TUI_PANEL_MODULE 指向产物）');
  console.log('  找过: ' + CANDIDATES.join(' / '));
  process.exit(0);
}

let mod;
try {
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error('FAIL 模块加载: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}
console.log('MODULE ' + modulePath);
console.log('NODE   ' + process.version);

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

// ── PNG 构造（含真 CRC；这样"合法 PNG"不是嘴上说说）───────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.from(data);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  typeBytes.copy(out, 4);
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** rows: 每行原始像素字节（不放 filter byte）；filters: 每行 filter 类型。 */
function buildPng({ width, height, colorType = 6, rows, filters, idatSplit = 1, interlace = 0, bitDepth = 8 }) {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.from(rows[y]);
    assert.equal(row.length, stride, '测试 fixture 第 ' + y + ' 行长度');
    const filter = filters[y];
    const base = y * (stride + 1);
    raw[base] = filter;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      raw[base + 1 + i] = (row[i] - predictor) & 0xff;
    }
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const compressed = zlib.deflateSync(raw);
  const chunks = [pngChunk('IHDR', ihdr)];
  const split = Math.max(1, Math.floor(idatSplit));
  const step = Math.max(1, Math.ceil(compressed.length / split));
  for (let at = 0; at < compressed.length; at += step) {
    chunks.push(pngChunk('IDAT', compressed.subarray(at, Math.min(compressed.length, at + step))));
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function rgbaOf(png) {
  const decoded = mod.decodePngToRgba(png);
  assert.ok(decoded, 'decodePngToRgba 应返回对象');
  assert.ok(decoded.data instanceof Uint8Array, 'data 应是 Uint8Array');
  return decoded;
}

// ── decodePngToRgba ───────────────────────────────────────────────────────
test('decode: 2×2 RGBA，filter 0+1，多段 IDAT', () => {
  const pixels = [
    [255, 0, 0, 255], [0, 255, 0, 255], // row 0 (none)
    [0, 0, 255, 255], [255, 255, 0, 128], // row 1 (sub)
  ];
  const png = buildPng({
    width: 2,
    height: 2,
    colorType: 6,
    filters: [0, 1],
    idatSplit: 2,
    rows: [pixels.slice(0, 2).flat(), pixels.slice(2, 4).flat()],
  });
  const decoded = rgbaOf(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.data.length, 16);
  assert.deepEqual(Array.from(decoded.data), pixels.flat());
});

test('decode: 2×2 RGBA，filter 0+2（Up）', () => {
  const pixels = [
    [10, 20, 30, 40], [50, 60, 70, 80],
    [90, 100, 110, 120], [130, 140, 150, 160],
  ];
  const png = buildPng({
    width: 2,
    height: 2,
    colorType: 6,
    filters: [0, 2],
    rows: [pixels.slice(0, 2).flat(), pixels.slice(2, 4).flat()],
  });
  const decoded = rgbaOf(png);
  assert.deepEqual(Array.from(decoded.data), pixels.flat());
});

test('decode: filter 3（Average）+ 4（Paeth）', () => {
  const pixels = [
    [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11],
    [12, 13, 14, 15], [16, 17, 18, 19], [20, 21, 22, 23],
  ];
  const png = buildPng({
    width: 3,
    height: 2,
    colorType: 6,
    filters: [3, 4],
    rows: [pixels.slice(0, 3).flat(), pixels.slice(3, 6).flat()],
  });
  const decoded = rgbaOf(png);
  assert.deepEqual(Array.from(decoded.data), pixels.flat());
});

test('decode: color type 2（RGB）补 alpha=255', () => {
  const png = buildPng({
    width: 2,
    height: 2,
    colorType: 2,
    filters: [0, 1],
    rows: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]],
  });
  const decoded = rgbaOf(png);
  assert.deepEqual(Array.from(decoded.data), [
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ]);
});

test('decode: 坏数据一律 null 不抛', () => {
  const valid = buildPng({
    width: 1,
    height: 1,
    colorType: 6,
    filters: [0],
    rows: [[1, 2, 3, 4]],
  });
  const corruptIdat = Buffer.from(valid);
  const idatAt = corruptIdat.indexOf(Buffer.from('IDAT', 'ascii'));
  assert.ok(idatAt > 0);
  corruptIdat[idatAt + 4 + 2] ^= 0xff; // 破坏 deflate 流
  const interlaced = Buffer.from(valid);
  const ihdrAt = interlaced.indexOf(Buffer.from('IHDR', 'ascii'));
  interlaced[ihdrAt + 4 + 12] = 1; // interlace=1
  const badDepth = Buffer.from(valid);
  badDepth[ihdrAt + 4 + 8] = 16; // bit depth 16
  const badColor = Buffer.from(valid);
  badColor[ihdrAt + 4 + 9] = 3; // indexed color
  // 重建一个 filter 类型 = 9 的行（IHDR 合法，只有扫描线 filter 非法）。
  const rawRow = zlib.deflateSync(Buffer.from([9, 1, 2, 3, 4]));
  const badFilterPng = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', (() => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(1, 0);
      ihdr.writeUInt32BE(1, 4);
      ihdr[8] = 8; ihdr[9] = 6;
      return ihdr;
    })()),
    pngChunk('IDAT', rawRow),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  const cases = [
    ['null', null],
    ['空 bytes', new Uint8Array(0)],
    ['坏签名', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
    ['截断', valid.subarray(0, 20)],
    ['破坏 IDAT', corruptIdat],
    ['隔行', interlaced],
    ['bit depth 16', badDepth],
    ['color type 3', badColor],
    ['非法 filter 类型', badFilterPng],
    ['随机字节', Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)],
  ];
  for (const [label, bytes] of cases) {
    let result;
    assert.doesNotThrow(() => { result = mod.decodePngToRgba(bytes); }, label + ' 不应抛');
    assert.equal(result, null, label + ' 应返回 null');
  }
});

// ── fitCells ──────────────────────────────────────────────────────────────
test('fitCells: 2:1 终端单元 + 极端纵横比', () => {
  assert.deepEqual(mod.fitCells(100, 100, 40, 20), { columns: 40, rows: 20 });
  assert.deepEqual(mod.fitCells(200, 100, 80, 40), { columns: 80, rows: 20 });
  assert.deepEqual(mod.fitCells(400, 100, 40, 40), { columns: 40, rows: 5 });
  assert.deepEqual(mod.fitCells(800, 450, 40, 20), { columns: 40, rows: 11 });
  assert.deepEqual(mod.fitCells(100, 200, 40, 40), { columns: 40, rows: 40 });
  assert.deepEqual(mod.fitCells(10, 1000, 40, 20), { columns: 1, rows: 20 });
});

test('fitCells: 至少 1×1 / 不超过 max / 保持纵横比', () => {
  assert.deepEqual(mod.fitCells(1600, 900, 1, 1), { columns: 1, rows: 1 });
  assert.deepEqual(mod.fitCells(800, 450, 0, -3), { columns: 1, rows: 1 });
  assert.deepEqual(mod.fitCells(0, 0, 10, 10), { columns: 10, rows: 5 });
  const cases = [[100, 100], [200, 100], [800, 450], [400, 100], [900, 1600], [3, 2]];
  for (const [width, height] of cases) {
    for (const [maxColumns, maxRows] of [[28, 14], [80, 40], [12, 60], [1, 40]]) {
      const cell = mod.fitCells(width, height, maxColumns, maxRows);
      assert.ok(Number.isInteger(cell.columns) && Number.isInteger(cell.rows), '单元格应是整数');
      assert.ok(cell.columns >= 1 && cell.columns <= maxColumns, 'columns 越界: ' + JSON.stringify(cell));
      assert.ok(cell.rows >= 1 && cell.rows <= maxRows, 'rows 越界: ' + JSON.stringify(cell));
      // 1 列/1 行是"至少 1×1"的硬下限，量化误差不可能满足纵横比，跳过。
      if (maxColumns < 2 || maxRows < 2 || cell.columns === 1 || cell.rows === 1) continue;
      const shown = cell.columns / (2 * cell.rows);
      const want = width / height;
      const error = Math.abs(shown - want) / want;
      assert.ok(error <= 0.25, '纵横比偏差过大: ' + JSON.stringify({ cell, shown, want, error }));
    }
  }
});

// ── downscaleRgba（最近邻）────────────────────────────────────────────────
test('downscaleRgba: 最近邻 + 输出形状', () => {
  const source = {
    width: 4,
    height: 2,
    data: new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ]),
  };
  const scaled = mod.downscaleRgba(source, 2, 1);
  assert.ok(scaled);
  assert.equal(scaled.width, 2);
  assert.equal(scaled.height, 1);
  // 采样点：x=0.5*2=1、x=1.5*2=3；y=0.5*2=1 ⇒ 第 1 行第 1/3 个像素。
  assert.deepEqual(Array.from(scaled.data), [21, 22, 23, 24, 29, 30, 31, 32]);
  assert.equal(mod.downscaleRgba(source, 0, 1), null);
  assert.equal(mod.downscaleRgba({ width: 0, height: 0, data: new Uint8Array(0) }, 1, 1), null);
});

// ── rgbaToAscii（无图形协议回退）────────────────────────────────────────
test('rgbaToAscii: 行列数 + 亮度映射', () => {
  const image = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      0, 0, 0, 255,       128, 128, 128, 255,
      255, 255, 255, 255, 32, 32, 32, 255,
    ]),
  };
  const art = mod.rgbaToAscii(image);
  const lines = art.split('\n');
  assert.equal(lines.length, 2, '2 行');
  assert.equal(lines[0].length, 2, '每行 2 字符');
  assert.equal(lines[0][0], ' ', '黑 → 空格');
  assert.equal(lines[0][1], '+', '中灰 → +');
  assert.equal(lines[1][0], '@', '白 → @');
  assert.equal(lines[1][1], '.', '暗灰 → .');
  // 自动对比度：100..110 的窄亮度带也应拉满 ramp。
  const lowContrast = {
    width: 2,
    height: 1,
    data: new Uint8Array([100, 100, 100, 255, 110, 110, 110, 255]),
  };
  assert.equal(mod.rgbaToAscii(lowContrast), ' @');
  // 纯色不放大噪声：退回原始亮度（128 → +）。
  const flat = { width: 2, height: 1, data: new Uint8Array([128, 128, 128, 255, 128, 128, 128, 255]) };
  assert.equal(mod.rgbaToAscii(flat), '++');
  // 显式目标尺寸（最近邻采样）也不能越界。
  const small = mod.rgbaToAscii(image, 1, 1);
  assert.equal(small.split('\n').length, 1);
  assert.equal(small.length, 1);
  // 面积平均而非单点采样：2×2 平均亮度 103.75 → '='；单点取中心会得到 '+'。
  assert.equal(small, '=', '1×1 应对整块面积求平均');
  assert.equal(mod.rgbaToAscii(null), '');
  assert.equal(mod.rgbaToAscii({ width: 2, height: 2, data: new Uint8Array(3) }), '');
});

// ── mapClickToNormalized ─────────────────────────────────────────────────
test('mapClickToNormalized: 0..1、边界夹取、图外 null', () => {
  assert.deepEqual(mod.mapClickToNormalized(0, 0, 40, 20), { x: 0, y: 0 });
  assert.deepEqual(mod.mapClickToNormalized(39, 19, 40, 20), { x: 0.975, y: 0.95 });
  assert.deepEqual(mod.mapClickToNormalized(20.5, 10.5, 40, 20), { x: 0.5125, y: 0.525 });
  assert.deepEqual(mod.mapClickToNormalized(40, 20, 40, 20), { x: 1, y: 1 });
  assert.equal(mod.mapClickToNormalized(-1, 0, 40, 20), null);
  assert.equal(mod.mapClickToNormalized(0, -1, 40, 20), null);
  assert.equal(mod.mapClickToNormalized(41, 0, 40, 20), null);
  assert.equal(mod.mapClickToNormalized(0, 21, 40, 20), null);
  assert.equal(mod.mapClickToNormalized(Number.NaN, 0, 40, 20), null);
  assert.equal(mod.mapClickToNormalized(0, 0, 0, 20), null);
  assert.equal(mod.mapClickToNormalized(0, 0, 40, 0), null);
});

// ── __internals / 导出面 ──────────────────────────────────────────────────
test('导出面：4 个函数 + __internals 指向同一实现', () => {
  for (const name of ['decodePngToRgba', 'fitCells', 'createTuiViewportPanel', 'registerTuiViewportPanel', 'tuiPanelState', 'openTuiViewportPanel']) {
    assert.equal(typeof mod[name], 'function', name + ' 应是函数');
  }
  assert.ok(mod.__internals && typeof mod.__internals === 'object', '__internals 应存在');
  assert.equal(mod.__internals.decodePngToRgba, mod.decodePngToRgba);
  assert.equal(mod.__internals.fitCells, mod.fitCells);
  assert.equal(mod.__internals.downscaleRgba, mod.downscaleRgba);
  assert.equal(mod.__internals.rgbaToAscii, mod.rgbaToAscii);
  assert.equal(typeof mod.__internals.mapClickToNormalized, 'function');
  assert.equal(typeof mod.__internals.autoCaptureDecision, 'function');
  assert.equal(typeof mod.__internals.followCaptureDue, 'function');
  assert.equal(typeof mod.__internals.revisionStaleDue, 'function');
  assert.equal(typeof mod.__internals.formatAge, 'function');
  assert.equal(mod.__internals.tuiPanelState, mod.tuiPanelState);
});

// ── 自动重拍决策（与 Web 端 autoCaptureDecision 同语义）──────────────────
const autoBase = () => ({
  seq: 7,
  stale: true,
  blenderQuiet: true,
  visible: true,
  picking: false,
  now: 10000,
  lastAt: 0,
  lastSeq: 0,
  stuck: 0,
  minIntervalMs: 1200,
  maxStuck: 3,
});

test('autoCapture: 前提不满足时全部跳过', () => {
  const decide = mod.__internals.autoCaptureDecision;
  assert.deepEqual(decide({ ...autoBase(), visible: false }), { action: 'skip', reason: 'hidden' });
  assert.deepEqual(decide({ ...autoBase(), picking: true }), { action: 'skip', reason: 'picking' });
  assert.deepEqual(decide({ ...autoBase(), seq: 0 }), { action: 'skip', reason: 'no_frame' });
  assert.deepEqual(decide({ ...autoBase(), stale: false }), { action: 'skip', reason: 'fresh' });
  assert.deepEqual(decide({ ...autoBase(), blenderQuiet: false }), { action: 'skip', reason: 'busy' });
});

test('autoCapture: stale + Blender 静默才重拍', () => {
  const decide = mod.__internals.autoCaptureDecision;
  assert.deepEqual(decide(autoBase()), { action: 'capture', reason: 'stale_and_quiet' });
});

test('autoCapture: 节流 / 同 seq / 停手', () => {
  const decide = mod.__internals.autoCaptureDecision;
  assert.deepEqual(decide({ ...autoBase(), lastAt: 9500 }), { action: 'skip', reason: 'throttled' });
  assert.deepEqual(decide({ ...autoBase(), lastSeq: 7 }), { action: 'noProgress', reason: 'same_seq' });
  assert.deepEqual(decide({ ...autoBase(), stuck: 3 }), { action: 'stop', reason: 'stuck' });
});

// ── 跟随模式决策 ───────────────────────────────────────────────────────────
const followBase = () => ({
  follow: true,
  visible: true,
  picking: false,
  seq: 3,
  blenderQuiet: true,
  now: 10000,
  lastAt: 0,
  intervalMs: 2500,
});

test('followCapture: 开启 + 可见 + 静默 + 到间隔才抓', () => {
  const due = mod.__internals.followCaptureDue;
  assert.equal(due(followBase()), true);
  assert.equal(due({ ...followBase(), now: 2000 }), false);
});

test('followCapture: 关闭 / 不可见 / 点选 / Blender 忙 都跳过', () => {
  const due = mod.__internals.followCaptureDue;
  assert.equal(due({ ...followBase(), follow: false }), false);
  assert.equal(due({ ...followBase(), visible: false }), false);
  assert.equal(due({ ...followBase(), picking: true }), false);
  assert.equal(due({ ...followBase(), blenderQuiet: false }), false);
  assert.equal(due({ ...followBase(), seq: 0 }), false);
});

// ── GUI revision / 帧龄 ────────────────────────────────────────────────────
test('revisionStaleDue: 编辑停稳 ≥800ms 才允许重拍', () => {
  const due = mod.__internals.revisionStaleDue;
  assert.equal(due({ revisionStale: true, idleMs: 900, minIdleMs: 800 }), true);
  assert.equal(due({ revisionStale: true, idleMs: 200, minIdleMs: 800 }), false);
  assert.equal(due({ revisionStale: false, idleMs: 900, minIdleMs: 800 }), false);
  assert.equal(due({ revisionStale: true, idleMs: null, minIdleMs: 800 }), false);
});

test('formatAge: ms / s / m 文案', () => {
  const fmt = mod.__internals.formatAge;
  assert.equal(fmt(0), '0ms');
  assert.equal(fmt(850), '850ms');
  assert.equal(fmt(1200), '1s');
  assert.equal(fmt(65000), '1m 5s');
});

// ── registerTuiViewportPanel ─────────────────────────────────────────────
function makeCtx(panels, options = {}) {
  const effects = [];
  const ctx = {
    effects,
    get(name) {
      assert.equal(name, 'tuiPanels');
      if (options.getThrows) throw new Error('service not found');
      return panels;
    },
    effect(fn) {
      if (options.effectThrows) throw new Error('effect boom');
      effects.push(fn);
      return () => {};
    },
  };
  return ctx;
}

test('register: descriptor 字段 + effect 清理调用 disposer', () => {
  let descriptor = null;
  let disposed = 0;
  const panels = {
    register(value) {
      descriptor = value;
      return () => { disposed += 1; };
    },
  };
  const ctx = makeCtx(panels);
  const result = mod.registerTuiViewportPanel(ctx, { port: 9877 });
  assert.equal(result, 'viewport');
  assert.ok(descriptor, 'register 应被调用');
  assert.equal(descriptor.apiVersion, 1);
  assert.equal(descriptor.id, 'viewport');
  assert.equal(descriptor.title, 'Blender 视口');
  assert.equal(descriptor.icon, '◉');
  assert.equal(descriptor.minColumns, 28);
  assert.equal(descriptor.order, 50);
  assert.equal(typeof descriptor.component, 'function', 'component 应是函数');
  assert.equal(ctx.effects.length, 1, '应挂一个 ctx.effect');
  const cleanup = ctx.effects[0]();
  assert.equal(typeof cleanup, 'function', 'effect 回调应返回 disposer');
  cleanup();
  assert.equal(disposed, 1, '清理时应调用 register 的 disposer');
});

test('register: 无服务/拒绝/异常都返回 null 且不抛', () => {
  const cases = [
    ['ctx.get 返回 undefined', makeCtx(undefined)],
    ['ctx.get 抛错', makeCtx(null, { getThrows: true })],
    ['register 返回 undefined', makeCtx({ register() { return undefined; } })],
    ['register 抛错', makeCtx({ register() { throw new Error('rejected'); } })],
    ['panels 无 register', makeCtx({})],
    ['没有 ctx', null],
  ];
  for (const [label, ctx] of cases) {
    let result = 'unset';
    assert.doesNotThrow(() => { result = mod.registerTuiViewportPanel(ctx, { port: 9877 }); }, label + ' 不应抛');
    assert.equal(result, null, label + ' 应返回 null');
  }
});

test('register: ctx.effect 抛错不影响注册结果', () => {
  let disposed = 0;
  const ctx = makeCtx({ register() { return () => { disposed += 1; }; } }, { effectThrows: true });
  let result;
  assert.doesNotThrow(() => { result = mod.registerTuiViewportPanel(ctx, { port: 9877 }); });
  assert.equal(result, 'viewport');
  assert.equal(disposed, 0, 'effect 失败时 disposer 未被调用（注册仍在）');
});

test('register: list() 取回宿主实际 id，open 用同一 id', () => {
  let opened = null;
  const panels = {
    register() { return () => {}; },
    list() { return [{ id: 'act9:viewport', title: 'Blender 视口', source: 'plugin' }]; },
    open(id) { opened = id; return true; },
  };
  const ctx = makeCtx(panels);
  assert.equal(mod.registerTuiViewportPanel(ctx, { port: 9877 }), 'viewport');
  assert.deepEqual(mod.tuiPanelState(), {
    available: true,
    registered: true,
    id: 'act9:viewport',
    canOpen: true,
  });
  assert.equal(mod.openTuiViewportPanel(), true);
  assert.equal(opened, 'act9:viewport');
});

test('register: list() 失败时 id 为 null，open 安全返回 false', () => {
  const panels = {
    register() { return () => {}; },
    list() { throw new Error('list denied'); },
    open() { throw new Error('must not be called'); },
  };
  const ctx = makeCtx(panels);
  assert.equal(mod.registerTuiViewportPanel(ctx, { port: 9877 }), 'viewport');
  assert.deepEqual(mod.tuiPanelState(), {
    available: true,
    registered: false,
    id: null,
    canOpen: false,
  });
  assert.equal(mod.openTuiViewportPanel(), false);
});

// ── 汇总 ─────────────────────────────────────────────────────────────────
const total = pass + failures.length;
console.log(JSON.stringify({
  suite: 'tui-panel',
  module: modulePath,
  total,
  pass,
  fail: failures.length,
  failures,
  note: '只测纯逻辑与注册契约；真实终端渲染/Kitty/Sixel 协议与真后端交互不在本自检范围。',
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
