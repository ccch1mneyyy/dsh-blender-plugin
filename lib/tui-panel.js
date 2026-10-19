// @ts-nocheck
/**
 * dsh-TUI 侧栏视口面板（实验性 `ctx.tuiPanels`，apiVersion 1）。
 *
 * 设计口径：
 * - host 侧 `src/index.ts` 的 16 个模型工具一行不改；本文件只做 **TUI 面板**
 *   （后端仍是 127.0.0.1:<port> 的 `/host/*` 路由，契约见
 *   `docs/宿主集成-接口契约.md` §1 / §7，以及 v2.1 增补 §8）。
 * - 面板拿宿主 React 与收窄 UI kit（`props.React` / `props.ui`），不自己
 *   import React；`props.ui.Image` 吃 RGBA（`{ data, width, height }`），
 *   无图形协议的终端回退到 `alt` / children 文本。
 * - 轮询走 `props.ui.useAnimationTime`（面板内唯一合法定时源），不用
 *   setInterval；所有 fetch 自带 AbortController 5s 超时，失败只落到面板
 *   状态行，绝不抛给宿主。
 * - 点选：有 pending 的模型请求 → `POST /host/pick/answer`；否则
 *   `POST /host/view/pick`。结果用 `host.toast()` 提示 —— `sendToChat`
 *   当前恒 false（需要 `panels.chat.attach` 授权），这里不用它。
 * - 纯 ESM、Node >= 20、零新增 npm 依赖（PNG 解码只用 node:zlib）。
 */
import { inflateSync } from 'node:zlib';
const DEFAULT_PORT = 9877;
/** 面板数据轮询间隔（契约 §2.3 / §7.3 的 1500 ms 口径）。 */
const POLL_MS = 1500;
/** `GET /host/pick/request` 的最小轮询间隔（§7.4 的 2000 ms 口径）。 */
const PICK_POLL_MS = 2000;
/** 所有 fetch 的硬超时。 */
const FETCH_TIMEOUT_MS = 5000;
/** 手动/挂载捕获的最长边（v2.1 §8.1：捕获分辨率提到 1600）。 */
const CAPTURE_MAX_SIZE = 1600;
/** stale 帧的轮询间隔（与 Web 端同口径：600 ms，尽快把自动重拍的结果显示出来）。 */
const POLL_STALE_MS = 600;
/** 自动重拍最小间隔（上游 A8 的 1200 ms 节流；连续改场景只出一张）。 */
const AUTO_CAPTURE_MIN_INTERVAL_MS = 1200;
/** 连续无进展几次后停手，避免场景持续变化时无限重拍。 */
const AUTO_CAPTURE_MAX_STUCK = 3;
/** 跟随模式轮询间隔（ms）：抓帧间隔的 2/5，保证到点能发。 */
const FOLLOW_POLL_MS = 1000;
/** 跟随模式抓帧间隔（ms）：只在面板可见 + Blender 静默时抓，不抢在飞命令。 */
const FOLLOW_CAPTURE_INTERVAL_MS = 2500;
/** 跟随模式捕获分辨率：1000 长边约 0.5 s/帧；1600 要 ~1 s，跟随用小的。 */
const FOLLOW_CAPTURE_MAX_SIZE = 1000;
/** GUI revision 编辑停下多久才允许自动重拍（与后端 blender_quiet 同口径 0.8 s）。 */
const REVISION_IDLE_MS = 800;
/** 与宿主 Image 的单元格预算保持一致（TERMINAL_IMAGE_MAX_CELLS = 128×128），
 * 超过时宿主会自行缩小格子，点击坐标就不再对应我们的 layout。 */
const MAX_IMAGE_COLUMNS = 128;
const MAX_IMAGE_ROWS = 128;
/** PNG 解码的资源上限（Blender 捕获通常 ≤1600²，这里只兜坏数据）。 */
const MAX_PNG_EDGE = 16384;
const MAX_PNG_PIXELS = 16 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
// ── PNG 解码（8-bit、color type 6/2、非隔行、filter 0..4、多段 IDAT）──────
function readU32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}
function readAscii(bytes, at, length) {
    let out = '';
    for (let i = 0; i < length; i += 1)
        out += String.fromCharCode(bytes[at + i]);
    return out;
}
function concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
/** PNG 的 Paeth 预测器（filter 4）。 */
function paethPredictor(left, up, upLeft) {
    const p = left + up - upLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upLeft);
    if (pa <= pb && pa <= pc)
        return left;
    if (pb <= pc)
        return up;
    return upLeft;
}
/**
 * 反滤波一行（原地改写 `line`）。`prev` 是上一行还原后的扫描线（首行全 0）。
 * 返回 false = filter 类型不合法。
 */
function unfilterRow(filterType, line, prev, bpp) {
    if (filterType === 0)
        return true;
    if (filterType === 1) {
        for (let i = bpp; i < line.length; i += 1)
            line[i] = (line[i] + line[i - bpp]) & 0xff;
        return true;
    }
    if (filterType === 2) {
        for (let i = 0; i < line.length; i += 1)
            line[i] = (line[i] + prev[i]) & 0xff;
        return true;
    }
    if (filterType === 3) {
        for (let i = 0; i < line.length; i += 1) {
            const left = i >= bpp ? line[i - bpp] : 0;
            line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        return true;
    }
    if (filterType === 4) {
        for (let i = 0; i < line.length; i += 1) {
            const left = i >= bpp ? line[i - bpp] : 0;
            const upLeft = i >= bpp ? prev[i - bpp] : 0;
            line[i] = (line[i] + paethPredictor(left, prev[i], upLeft)) & 0xff;
        }
        return true;
    }
    return false;
}
/**
 * 解一张 PNG 成 RGBA。支持 8-bit、color type 6（RGBA）与 2（RGB）、
 * 非隔行、filter 0..4、多段 IDAT。任何坏数据返回 null（不抛）。
 */
export function decodePngToRgba(bytes) {
    try {
        if (!(bytes instanceof Uint8Array) || bytes.length < 8 + 25 + 12)
            return null;
        for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
            if (bytes[i] !== PNG_SIGNATURE[i])
                return null;
        }
        let offset = 8;
        let width = 0;
        let height = 0;
        let bitDepth = 0;
        let colorType = 0;
        let interlace = 0;
        let sawIhdr = false;
        const idatParts = [];
        let idatLength = 0;
        while (offset + 12 <= bytes.length) {
            const length = readU32(bytes, offset);
            if (length > bytes.length - offset - 12)
                return null;
            const type = readAscii(bytes, offset + 4, 4);
            const dataStart = offset + 8;
            if (type === 'IHDR') {
                if (sawIhdr || offset !== 8 || length !== 13)
                    return null;
                width = readU32(bytes, dataStart);
                height = readU32(bytes, dataStart + 4);
                bitDepth = bytes[dataStart + 8];
                colorType = bytes[dataStart + 9];
                const compression = bytes[dataStart + 10];
                const filterMethod = bytes[dataStart + 11];
                interlace = bytes[dataStart + 12];
                if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2))
                    return null;
                if (compression !== 0 || filterMethod !== 0 || interlace !== 0)
                    return null;
                if (width < 1 || height < 1)
                    return null;
                if (width > MAX_PNG_EDGE || height > MAX_PNG_EDGE || width * height > MAX_PNG_PIXELS)
                    return null;
                sawIhdr = true;
            }
            else if (type === 'IDAT') {
                if (!sawIhdr)
                    return null;
                const part = bytes.subarray(dataStart, dataStart + length);
                idatParts.push(part);
                idatLength += part.length;
            }
            else if (type === 'IEND') {
                break;
            }
            offset = dataStart + length + 4; // 跳过 CRC
        }
        if (!sawIhdr || idatLength === 0)
            return null;
        const channels = colorType === 6 ? 4 : 3;
        const stride = width * channels;
        const expected = (stride + 1) * height;
        let raw;
        try {
            raw = inflateSync(concatBytes(idatParts, idatLength), { maxOutputLength: expected });
        }
        catch (error) {
            return null;
        }
        if (raw.length !== expected)
            return null;
        // 先还原成 tightly packed 的 channels 行，再从 RGB 扩成 RGBA。
        const pixels = new Uint8Array(width * height * channels);
        let prev = new Uint8Array(stride);
        let at = 0;
        for (let y = 0; y < height; y += 1) {
            const filterType = raw[at];
            at += 1;
            const line = pixels.subarray(y * stride, (y + 1) * stride);
            line.set(raw.subarray(at, at + stride));
            at += stride;
            if (!unfilterRow(filterType, line, prev, channels))
                return null;
            prev = line;
        }
        if (channels === 4) {
            return { width: width, height: height, data: pixels };
        }
        const rgba = new Uint8Array(width * height * 4);
        for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
            rgba[j] = pixels[i];
            rgba[j + 1] = pixels[i + 1];
            rgba[j + 2] = pixels[i + 2];
            rgba[j + 3] = 255;
        }
        return { width: width, height: height, data: rgba };
    }
    catch (error) {
        return null;
    }
}
// ── 终端单元格布局 ───────────────────────────────────────────────────────
/**
 * 把图像纵横比放进 `maxColumns × maxRows` 的终端单元格盒。
 * 终端单元格近似 2:1（高:宽），所以显示纵横比 = columns / (2 * rows)。
 * 至少 1×1，且 columns/rows 分别不超过 maxColumns/maxRows。
 */
export function fitCells(imageWidth, imageHeight, maxColumns, maxRows) {
    const maxCols = Math.max(1, Math.floor(Number(maxColumns)) || 1);
    const maxRowsClamped = Math.max(1, Math.floor(Number(maxRows)) || 1);
    const safeWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 1;
    const safeHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 1;
    const aspect = safeWidth / safeHeight;
    let rows = maxRowsClamped;
    let columns = Math.round(2 * aspect * rows);
    if (columns > maxCols) {
        columns = maxCols;
        rows = Math.floor(columns / (2 * aspect));
    }
    columns = Math.min(maxCols, Math.max(1, Math.floor(columns)));
    rows = Math.min(maxRowsClamped, Math.max(1, rows));
    return { columns: columns, rows: rows };
}
/**
 * 最近邻缩放 RGBA 到 `width × height`（面板里就是单元格数：一个 cell 一个
 * 像素，渲染器再按终端 cell 尺寸铺开）。输入输出都是行主序 RGBA。
 */
export function downscaleRgba(image, width, height) {
    try {
        if (!image || !(image.data instanceof Uint8Array))
            return null;
        const srcW = Math.floor(Number(image.width)) || 0;
        const srcH = Math.floor(Number(image.height)) || 0;
        const dstW = Math.floor(Number(width)) || 0;
        const dstH = Math.floor(Number(height)) || 0;
        if (srcW < 1 || srcH < 1 || dstW < 1 || dstH < 1)
            return null;
        if (image.data.length < srcW * srcH * 4)
            return null;
        const out = new Uint8Array(dstW * dstH * 4);
        const scaleX = srcW / dstW;
        const scaleY = srcH / dstH;
        for (let y = 0; y < dstH; y += 1) {
            const srcY = Math.min(srcH - 1, Math.floor((y + 0.5) * scaleY));
            for (let x = 0; x < dstW; x += 1) {
                const srcX = Math.min(srcW - 1, Math.floor((x + 0.5) * scaleX));
                const src = (srcY * srcW + srcX) * 4;
                const dst = (y * dstW + x) * 4;
                out[dst] = image.data[src];
                out[dst + 1] = image.data[src + 1];
                out[dst + 2] = image.data[src + 2];
                out[dst + 3] = image.data[src + 3];
            }
        }
        return { width: dstW, height: dstH, data: out };
    }
    catch (error) {
        return null;
    }
}
const CLICK_EPSILON = 1e-6;
// 无图形协议终端的亮度字符表：暗 → 亮。10 级足够看清轮廓，又不会让面板太吵。
const ASCII_RAMP = ' .:-=+*#%@';
/**
 * 把 RGBA 缩成 `columns × rows` 的 ASCII 亮度图（每 cell 一个字符）。
 *
 * 为什么需要：dsh-TUI 的 `<Image>` 在 tmux / 无 Kitty/Sixel 的终端里会回退成
 * 一行占位；如果面板只显示 `▦ 视口 W×H`，用户点选就是“盲点”。这里用同一份
 * 已解码像素做亮度映射，让任何终端都能看见画面轮廓；点击仍按 cell 坐标映射，
 * 与原生图片路径一致。纯函数、无 I/O，坏了返回空串（调用方回退占位文本）。
 */
export function rgbaToAscii(image, columns, rows) {
    try {
        if (!image || !(image.data instanceof Uint8Array))
            return '';
        const srcW = Math.floor(Number(image.width)) || 0;
        const srcH = Math.floor(Number(image.height)) || 0;
        if (srcW < 1 || srcH < 1 || image.data.length < srcW * srcH * 4)
            return '';
        const dstW = Math.max(1, Math.floor(Number(columns)) || srcW);
        const dstH = Math.max(1, Math.floor(Number(rows)) || srcH);
        const lum = new Float32Array(dstW * dstH);
        for (let y = 0; y < dstH; y += 1) {
            const y0 = Math.floor((y * srcH) / dstH);
            const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
            for (let x = 0; x < dstW; x += 1) {
                const x0 = Math.floor((x * srcW) / dstW);
                const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
                // 面积平均：视口帧常常有细密网格/噪点，单点采样会让 ASCII 整屏都是
                // 高频字符；按 cell 覆盖的源像素求平均，背景才安静、轮廓才连续。
                let sum = 0;
                let count = 0;
                for (let sy = y0; sy < y1; sy += 1) {
                    for (let sx = x0; sx < x1; sx += 1) {
                        const at = (sy * srcW + sx) * 4;
                        sum += 0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
                        count += 1;
                    }
                }
                lum[y * dstW + x] = count > 0 ? sum / count : 0;
            }
        }
        // 自动对比度：Blender 视口常是"深灰背景 + 灰色物体"，原始亮度挤在中段。
        // 用 2%–98% 分位而不是 min/max，避免少量噪点/高光把整屏拉成高频字符；
        // 近乎纯色（span < 8）时退回原始亮度，不放大噪声。
        const sorted = Array.from(lum).sort((a, b) => a - b);
        const atQuantile = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
        const low = atQuantile(0.02);
        const high = atQuantile(0.98);
        const span = high - low;
        const stretch = span >= 8;
        const lines = [];
        for (let y = 0; y < dstH; y += 1) {
            let line = '';
            for (let x = 0; x < dstW; x += 1) {
                const value = lum[y * dstW + x];
                const level = stretch
                    ? Math.round(((value - low) / span) * (ASCII_RAMP.length - 1))
                    : Math.max(0, Math.min(ASCII_RAMP.length - 1, Math.floor((value / 256) * ASCII_RAMP.length)));
                line += ASCII_RAMP[Math.max(0, Math.min(ASCII_RAMP.length - 1, level))];
            }
            lines.push(line);
        }
        return lines.join('\n');
    }
    catch (error) {
        return '';
    }
}
/**
 * 把图像 Box 的单元格局部坐标映射成 0..1 归一化坐标（左上原点、y 向下）。
 * 落在图外返回 null —— v2.1 §8.1 要求"图外点击不发请求"；边界处按
 * [0,1] 夹取（终端点击坐标可能刚好落在右/下边缘）。
 */
export function mapClickToNormalized(localCol, localRow, columns, rows) {
    const col = Number(localCol);
    const row = Number(localRow);
    const width = Number(columns);
    const height = Number(rows);
    if (!Number.isFinite(col) || !Number.isFinite(row))
        return null;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    if (col < -CLICK_EPSILON || col > width + CLICK_EPSILON)
        return null;
    if (row < -CLICK_EPSILON || row > height + CLICK_EPSILON)
        return null;
    return {
        x: Math.min(1, Math.max(0, col / width)),
        y: Math.min(1, Math.max(0, row / height)),
    };
}
// ── 后端 HTTP（同 src/index.ts 的 127.0.0.1:<port> 口径）──────────────────
function normalizePort(value) {
    const port = Number(value);
    return Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_PORT;
}
function backendUrl(port, path) {
    return 'http://127.0.0.1:' + String(port) + path;
}
/** 单次 fetch：AbortController 5s 超时；网络/abort 失败返回 null。 */
async function fetchRaw(port, path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        try {
            controller.abort();
        }
        catch (error) { /* 已结束 */ }
    }, FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(backendUrl(port, path), Object.assign({}, init || {}, { signal: controller.signal }));
        const buffer = await response.arrayBuffer();
        return { status: response.status, body: new Uint8Array(buffer) };
    }
    catch (error) {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchJson(port, path, init) {
    const raw = await fetchRaw(port, path, init);
    if (!raw)
        return null;
    let data = null;
    try {
        data = JSON.parse(new TextDecoder().decode(raw.body));
    }
    catch (error) {
        data = null;
    }
    return { status: raw.status, data: data };
}
function postJson(port, path, payload) {
    return fetchJson(port, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
    });
}
/** 只取路径末段（面板元信息里不展示完整路径）。 */
function shortName(value) {
    const text = String(value || '');
    const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at >= 0 ? text.slice(at + 1) : text;
}
function safeToast(host, text) {
    try {
        if (host && typeof host.toast === 'function')
            host.toast(text);
    }
    catch (error) {
        // toast 不可用/宿主拒绝都不值得让面板崩。
    }
}
function errorLine(error) {
    const text = error && error.message ? String(error.message) : String(error || 'unknown');
    return text.split('\n')[0].slice(0, 120);
}
// ── 自动重拍决策（纯函数，与 React / 网络解耦 ⇒ 可离线单测）──────────────
/**
 * 面板可见、场景改过（`stale`）且 Blender 静默（`blender_quiet`）时，
 * 自动重拍一帧。语义与 Web 端 `src/client/index.js` 的
 * `autoCaptureDecision` 保持一致（上游 A8：静默 0.8 s 后重拍，连续编辑只出一张）：
 * - 看不见 / 正在点选 / 有帧没到 / 不陈旧 → 跳过；
 * - 连续 3 次无进展 → 停手（避免场景持续变化时无限打后端）；
 * - Blender 还在忙 → 等静默；
 * - 同一 seq 已经重拍过 → 只记"无进展"，不发新请求；
 * - 两次重拍至少间隔 1200 ms。
 */
function autoCaptureDecision(s) {
    if (s.visible === false)
        return { action: 'skip', reason: 'hidden' };
    if (s.picking === true)
        return { action: 'skip', reason: 'picking' };
    if (!(s.seq > 0))
        return { action: 'skip', reason: 'no_frame' };
    if (s.stale !== true)
        return { action: 'skip', reason: 'fresh' };
    if (s.stuck >= s.maxStuck)
        return { action: 'stop', reason: 'stuck' };
    if (s.blenderQuiet !== true)
        return { action: 'skip', reason: 'busy' };
    if (s.seq === s.lastSeq)
        return { action: 'noProgress', reason: 'same_seq' };
    if (s.now - s.lastAt < s.minIntervalMs)
        return { action: 'skip', reason: 'throttled' };
    return { action: 'capture', reason: 'stale_and_quiet' };
}
/**
 * 跟随模式是否该抓下一帧：用户显式打开、面板可见、没有 pending 点选、
 * Blender 静默、且距上次抓帧 ≥ FOLLOW_CAPTURE_INTERVAL_MS。
 * 跟随模式不看 `stale` —— 鼠标在 Blender 里直接改场景不会产生后端命令，
 * 只能按固定节律抓；`blender_quiet` 保证不打扰模型/别的会话的在飞命令。
 */
function followCaptureDue(s) {
    if (s.follow !== true)
        return false;
    if (s.visible === false)
        return false;
    if (s.picking === true)
        return false;
    if (!(s.seq > 0))
        return false;
    if (s.blenderQuiet !== true)
        return false;
    if (s.now - s.lastAt < s.intervalMs)
        return false;
    return true;
}
/**
 * v2.3：GUI revision 陈旧是否已经"停稳"到可以重拍。
 * Blender 侧 depsgraph handler 每次更新 revision；后端返回 idle_ms（距上次编辑）。
 * 连续拖动时 idle 很小 → 不拍；停手 ≥800 ms 才拍，避免拖一下出一张。
 */
function revisionStaleDue(s) {
    if (s.revisionStale !== true)
        return false;
    if (s.idleMs === null || s.idleMs === undefined)
        return false;
    return s.idleMs >= s.minIdleMs;
}
// ── 面板组件 ─────────────────────────────────────────────────────────────
/**
 * 创建视口面板组件。返回的组件吃 `TuiPanelProps`（dsh-TUI
 * `src/dsh-adapter/panels.ts`），用宿主 React 渲染。
 */
export function createTuiViewportPanel(opts) {
    const port = normalizePort(opts && opts.port);
    function TuiViewportPanel(props) {
        if (!props || !props.React || !props.ui)
            return null;
        const React = props.React;
        const ui = props.ui;
        const host = props.host;
        const width = Math.max(1, Math.floor(Number(props.width)) || 1);
        const height = Math.max(1, Math.floor(Number(props.height)) || 1);
        const visible = props.visible !== false;
        const [latest, setLatest] = React.useState({ seq: 0, width: 0, height: 0, stale: false, blenderQuiet: false, sceneRevision: null, revisionStale: false, scene: '', file: '' });
        const [ready, setReady] = React.useState(null);
        const [decoded, setDecoded] = React.useState(null);
        const [pick, setPick] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [reloadToken, setReloadToken] = React.useState(0);
        // stale 时缩短轮询间隔，自动重拍的结果能尽快出现在面板里。
        const [pollMs, setPollMs] = React.useState(POLL_MS);
        // 跟随模式：默认关；打开后按固定节律抓帧，用来近似"实时预览"。
        const [follow, setFollow] = React.useState(false);
        // effect 里要读最新值，但不该因为每次 setState 重订阅。
        const latestRef = React.useRef(latest);
        latestRef.current = latest;
        const decodedRef = React.useRef(decoded);
        decodedRef.current = decoded;
        const pickRef = React.useRef(pick);
        pickRef.current = pick;
        const aliveRef = React.useRef(true);
        const pollingRef = React.useRef(false);
        // 自动重拍记账：lastSeq = 上一次尝试重拍时的帧号（同 seq 不重复打后端），
        // stuck = 连续无进展次数，stopped = 达到上限后停手（手动捕获会重新放行）。
        const autoRef = React.useRef({ lastAt: 0, lastSeq: 0, stuck: 0, stopped: false });
        // 跟随模式记账：followAtRef = 上次跟随抓帧时刻；线程里读 followRef，避免闭包旧值。
        const followRef = React.useRef(false);
        followRef.current = follow;
        const followAtRef = React.useRef(0);
        const pickPolledAtRef = React.useRef(0);
        const captureTriedRef = React.useRef(false);
        const clickBusyRef = React.useRef(false);
        const time = ui.useAnimationTime(visible ? pollMs : null);
        // 手动"立即刷新"：真正重拍一帧（不是只重读 store），键盘 r / 点击按钮都走它。
        const captureBusyRef = React.useRef(false);
        const captureNow = async () => {
            if (captureBusyRef.current)
                return;
            captureBusyRef.current = true;
            try {
                const res = await postJson(port, '/host/view/capture', { auto: false, max_size: CAPTURE_MAX_SIZE });
                if (res && res.data && res.data.ok === true) {
                    // 手动捕获成功 = 用户明确要这张画面：把自动重拍的停手状态复位，
                    // 并把跟随计时推到当下，避免刚手动抓完又立刻跟随抓一张。
                    autoRef.current.stuck = 0;
                    autoRef.current.stopped = false;
                    autoRef.current.lastAt = Date.now();
                    autoRef.current.lastSeq = Math.max(0, Math.floor(Number(res.data.seq) || 0));
                    followAtRef.current = Date.now();
                    safeToast(host, '已刷新 #' + String(res.data.seq));
                    setReloadToken(token => token + 1);
                }
                else {
                    safeToast(host, '刷新失败：后端不可达');
                }
            }
            finally {
                captureBusyRef.current = false;
            }
        };
        const toggleFollow = () => {
            setFollow(previous => {
                const next = !previous;
                // 打开时清掉上次计时，下一拍立即抓一帧，不用干等 2.5 s。
                if (next)
                    followAtRef.current = 0;
                return next;
            });
            setReloadToken(token => token + 1);
        };
        React.useEffect(() => {
            aliveRef.current = true;
            return () => {
                aliveRef.current = false;
                try {
                    host.clearBadge();
                }
                catch (error) { /* 卸载时宿主可能已撤服务 */ }
            };
        }, []);
        // ── 数据轮询：ready + latest（1500ms），seq 变了才拉 PNG；顺带轮询
        // pick/request（≈2000ms）。整段只有面板状态，不抛不吼。
        React.useEffect(() => {
            if (!visible || pollingRef.current)
                return undefined;
            pollingRef.current = true;
            const run = async () => {
                try {
                    const now = Date.now();
                    if (now - pickPolledAtRef.current >= PICK_POLL_MS) {
                        pickPolledAtRef.current = now;
                        const pickRes = await fetchJson(port, '/host/pick/request?client=tui');
                        if (!aliveRef.current)
                            return;
                        if (pickRes && pickRes.status === 200 && pickRes.data && pickRes.data.ok === true) {
                            const request = pickRes.data.request || null;
                            const nextId = request ? String(request.requestId || '') : '';
                            const current = pickRef.current;
                            const currentId = current ? String(current.requestId || '') : '';
                            if (nextId !== currentId) {
                                const next = request && nextId
                                    ? {
                                        requestId: nextId,
                                        prompt: String(request.prompt || ''),
                                        multi: request.multi === true,
                                        objects: Array.isArray(request.objects) ? request.objects : [],
                                    }
                                    : null;
                                pickRef.current = next;
                                setPick(next);
                                // 点选请求是"需要用户马上处理"的信号：有请求挂徽标，结束清掉。
                                try {
                                    if (next)
                                        host.notify('warning', 1);
                                    else
                                        host.clearBadge();
                                }
                                catch (error) { /* 宿主不提供徽标也不影响点选 */ }
                            }
                        }
                    }
                    const readyRes = await fetchJson(port, '/host/ready?client=tui');
                    if (!aliveRef.current)
                        return;
                    setReady(readyRes && readyRes.status === 200 && readyRes.data && readyRes.data.ok === true
                        ? readyRes.data.ready === true
                        : false);
                    // v2.3：GUI 编辑 revision（后端读 Blender 侧 handler 写的 JSON；读不到就忽略，
                    // 面板仍保留原有的 command-stale 自动重拍）。先刷新 revision 再看 latest，
                    // 这样 latest.revision_stale 是本轮的新值。
                    const revisionRes = await fetchJson(port, '/host/scene-revision?client=tui');
                    if (!aliveRef.current)
                        return;
                    const revisionData = revisionRes && revisionRes.status === 200 ? revisionRes.data : null;
                    const revisionOk = !!(revisionData && revisionData.ok === true);
                    const revisionIdleMs = revisionOk && Number.isFinite(Number(revisionData.idle_ms))
                        ? Number(revisionData.idle_ms)
                        : null;
                    const revisionStale = !!(revisionOk && revisionData.revision_stale === true
                        && revisionStaleDue({ revisionStale: true, idleMs: revisionIdleMs, minIdleMs: REVISION_IDLE_MS }));
                    const latestRes = await fetchJson(port, '/host/view/latest?client=tui');
                    if (!aliveRef.current)
                        return;
                    const data = latestRes ? latestRes.data : null;
                    if (!latestRes || latestRes.status !== 200 || !data || data.ok !== true) {
                        setNotice({ kind: 'error', text: '后端不可达（127.0.0.1:' + String(port) + '）' });
                        return;
                    }
                    let nextLatest = {
                        seq: Math.max(0, Math.floor(Number(data.seq) || 0)),
                        width: Math.max(0, Math.floor(Number(data.width) || 0)),
                        height: Math.max(0, Math.floor(Number(data.height) || 0)),
                        stale: data.stale === true,
                        blenderQuiet: data.blender_quiet === true,
                        sceneRevision: Number.isFinite(Number(data.scene_revision)) ? Number(data.scene_revision) : null,
                        revisionStale: data.revision_stale === true,
                        scene: data.scene ? String(data.scene) : '',
                        file: data.file ? String(data.file) : '',
                    };
                    latestRef.current = nextLatest;
                    setLatest(nextLatest);
                    const autoStale = nextLatest.stale || revisionStale;
                    setPollMs(followRef.current ? FOLLOW_POLL_MS : autoStale ? POLL_STALE_MS : POLL_MS);
                    setNotice(previous => (previous && previous.kind === 'error' ? null : previous));
                    // 挂载后第一次拿到 latest 且还没有任何帧 ⇒ 自动捕获一次（只一次，
                    // 失败不重试轰炸）。
                    if (!captureTriedRef.current && nextLatest.seq === 0) {
                        captureTriedRef.current = true;
                        const captured = await postJson(port, '/host/view/capture', { auto: true, max_size: CAPTURE_MAX_SIZE });
                        if (aliveRef.current) {
                            if (!captured || !captured.data || captured.data.ok !== true) {
                                setNotice({ kind: 'error', text: '自动捕获失败：按 c 重试' });
                            }
                            setReloadToken(token => token + 1);
                        }
                        return;
                    }
                    // ── 抓帧决策：跟随模式 / stale 自动重拍 ───────────────────────
                    // 跟随模式按固定节律抓（鼠标直接改场景不会产生后端命令 ⇒ 不会有
                    // stale）；不开跟随时才走 stale + Blender 静默的自动重拍。两者都只
                    // 发一次请求，并复用后端已有的 blender_quiet（契约 §1.2）避免打扰
                    // 模型 / 别的会话的在飞命令。
                    const followOn = followRef.current;
                    const auto = autoRef.current;
                    const picking = !!(pickRef.current && pickRef.current.requestId);
                    const nowMs = Date.now();
                    let captureKind = null;
                    let captureMaxSize = CAPTURE_MAX_SIZE;
                    if (followOn) {
                        if (followCaptureDue({
                            follow: true,
                            visible: visible,
                            picking: picking,
                            seq: nextLatest.seq,
                            blenderQuiet: nextLatest.blenderQuiet,
                            now: nowMs,
                            lastAt: followAtRef.current,
                            intervalMs: FOLLOW_CAPTURE_INTERVAL_MS,
                        })) {
                            captureKind = 'follow';
                            captureMaxSize = FOLLOW_CAPTURE_MAX_SIZE;
                            followAtRef.current = nowMs;
                        }
                    }
                    else if (!auto.stopped) {
                        const decision = autoCaptureDecision({
                            seq: nextLatest.seq,
                            stale: autoStale,
                            blenderQuiet: nextLatest.blenderQuiet,
                            visible: visible,
                            picking: picking,
                            now: nowMs,
                            lastAt: auto.lastAt,
                            lastSeq: auto.lastSeq,
                            stuck: auto.stuck,
                            minIntervalMs: AUTO_CAPTURE_MIN_INTERVAL_MS,
                            maxStuck: AUTO_CAPTURE_MAX_STUCK,
                        });
                        if (decision.action === 'capture') {
                            captureKind = 'auto';
                            auto.lastAt = nowMs;
                            auto.lastSeq = nextLatest.seq;
                        }
                        else if (decision.action === 'noProgress') {
                            auto.stuck += 1;
                            if (auto.stuck >= AUTO_CAPTURE_MAX_STUCK) {
                                auto.stopped = true;
                                setNotice({ kind: 'warn', text: '自动重拍已停手（连续 ' + String(AUTO_CAPTURE_MAX_STUCK) + ' 次无进展）——按 c 或 r 手动刷新' });
                            }
                        }
                        else if (decision.action === 'stop') {
                            auto.stopped = true;
                            setNotice({ kind: 'warn', text: '自动重拍已停手（连续 ' + String(AUTO_CAPTURE_MAX_STUCK) + ' 次无进展）——按 c 或 r 手动刷新' });
                        }
                    }
                    if (captureKind) {
                        const captured = await postJson(port, '/host/view/capture', { auto: true, max_size: captureMaxSize });
                        if (!aliveRef.current)
                            return;
                        const after = captured && captured.data && captured.data.ok === true ? captured.data : null;
                        if (after) {
                            const afterLatest = {
                                seq: Math.max(0, Math.floor(Number(after.seq) || 0)),
                                width: Math.max(0, Math.floor(Number(after.width) || 0)),
                                height: Math.max(0, Math.floor(Number(after.height) || 0)),
                                stale: after.stale === true,
                                blenderQuiet: after.blender_quiet === true,
                                sceneRevision: Number.isFinite(Number(after.scene_revision)) ? Number(after.scene_revision) : null,
                                revisionStale: after.revision_stale === true,
                                scene: after.scene ? String(after.scene) : '',
                                file: after.file ? String(after.file) : '',
                            };
                            if (captureKind === 'auto')
                                auto.stuck = afterLatest.stale ? auto.stuck + 1 : 0;
                            latestRef.current = afterLatest;
                            setLatest(afterLatest);
                            setPollMs(followOn ? FOLLOW_POLL_MS : afterLatest.stale ? POLL_STALE_MS : POLL_MS);
                            setNotice(previous => (previous && previous.kind === 'error' ? null : previous));
                            nextLatest = afterLatest;
                        }
                        else if (captureKind === 'auto') {
                            auto.stuck += 1;
                            setNotice({ kind: 'error', text: '自动重拍失败：按 c 或 r 手动刷新' });
                        }
                        else {
                            setNotice({ kind: 'error', text: '跟随抓帧失败：稍后重试，或用 r 手动刷新' });
                        }
                        if (captureKind === 'auto' && auto.stuck >= AUTO_CAPTURE_MAX_STUCK) {
                            auto.stopped = true;
                            setNotice({ kind: 'warn', text: '自动重拍已停手（连续 ' + String(AUTO_CAPTURE_MAX_STUCK) + ' 次无进展）——按 c 或 r 手动刷新' });
                        }
                    }
                    const cached = decodedRef.current;
                    if (nextLatest.seq > 0 && (!cached || cached.seq !== nextLatest.seq)) {
                        const png = await fetchRaw(port, '/host/view.png?seq=' + String(nextLatest.seq) + '&client=tui');
                        if (!aliveRef.current)
                            return;
                        if (png && png.status === 200 && png.body.length) {
                            const image = decodePngToRgba(png.body);
                            if (image) {
                                const next = { seq: nextLatest.seq, image: image };
                                decodedRef.current = next;
                                setDecoded(next);
                                setNotice(previous => (previous && previous.kind === 'error' ? null : previous));
                            }
                            else {
                                setNotice({ kind: 'error', text: 'PNG 解码失败（seq ' + String(nextLatest.seq) + '）' });
                            }
                        }
                        else {
                            let reason = 'HTTP ' + String(png ? png.status : '?');
                            if (png && png.body.length) {
                                try {
                                    const parsed = JSON.parse(new TextDecoder().decode(png.body));
                                    if (parsed && parsed.error)
                                        reason = String(parsed.error);
                                }
                                catch (error) { /* 非 JSON 错误体 */ }
                            }
                            setNotice({ kind: 'error', text: '取图失败：' + reason });
                        }
                    }
                }
                catch (error) {
                    if (aliveRef.current)
                        setNotice({ kind: 'error', text: '轮询失败：' + errorLine(error) });
                }
                finally {
                    pollingRef.current = false;
                }
            };
            void run();
            return undefined;
        }, [time, reloadToken, visible]);
        // ── 键盘：c 捕获 / r 立即刷新 / Esc 取消 pending 模型点选。host.onKey 的
        // 订阅必须随 effect 清理；listener 只碰 ref 与 setState，不闭包旧状态。
        React.useEffect(() => {
            if (!host || typeof host.onKey !== 'function')
                return undefined;
            const finishMulti = async () => {
                const request = pickRef.current;
                if (!request || !request.multi || !request.requestId)
                    return;
                const res = await postJson(port, '/host/pick/answer', { requestId: request.requestId, done: true });
                const data = res ? res.data : null;
                if (data && data.state === 'answered') {
                    const count = Array.isArray(data.objects) ? data.objects.length : 0;
                    pickRef.current = null;
                    setPick(null);
                    safeToast(host, '已提交多选：' + String(count) + ' 件');
                }
                else {
                    safeToast(host, '多选提交失败：' + String((data && data.error) || '后端不可达'));
                }
            };
            const listener = (event) => {
                if (!event)
                    return;
                const key = event.key || {};
                const input = String(event.input || '');
                if (key.escape === true || input === '\x1b') {
                    const request = pickRef.current;
                    if (!request || !request.requestId)
                        return;
                    try {
                        event.preventDefault();
                    }
                    catch (error) { /* 宿主已消费 */ }
                    void (async () => {
                        const res = await postJson(port, '/host/pick/cancel', { requestId: request.requestId, reason: 'user' });
                        if (res && res.data && res.data.ok === true) {
                            pickRef.current = null;
                            setPick(null);
                            safeToast(host, '已取消点选请求');
                        }
                        else {
                            safeToast(host, '取消失败：后端不可达');
                        }
                    })();
                    return;
                }
                if (key.ctrl === true || key.meta === true)
                    return;
                if (input === 'c' || input === 'C') {
                    try {
                        event.preventDefault();
                    }
                    catch (error) { /* 宿主已消费 */ }
                    void captureNow();
                }
                else if (input === 'r' || input === 'R') {
                    // r = 真正的"立即刷新"：重拍 + 重读，而不是只重读 store。
                    try {
                        event.preventDefault();
                    }
                    catch (error) { /* 宿主已消费 */ }
                    void captureNow();
                }
                else if (input === 'f' || input === 'F') {
                    try {
                        event.preventDefault();
                    }
                    catch (error) { /* 宿主已消费 */ }
                    toggleFollow();
                }
                else if ((input === 'd' || input === 'D') && pickRef.current && pickRef.current.multi) {
                    try {
                        event.preventDefault();
                    }
                    catch (error) { /* 宿主已消费 */ }
                    void finishMulti();
                }
            };
            const off = host.onKey(listener);
            return () => {
                try {
                    if (typeof off === 'function')
                        off();
                }
                catch (error) {
                    // 取消订阅失败也不该把面板卸载搞崩。
                }
            };
        }, [host]);
        // ── 布局：品牌头 2 行 + 分隔线 +（点选/错误）通知 + 画框 + 分隔线 + 键位行。
        const frameWidth = latest.width > 0
            ? latest.width
            : decoded && decoded.image ? decoded.image.width : 0;
        const frameHeight = latest.height > 0
            ? latest.height
            : decoded && decoded.image ? decoded.image.height : 0;
        const sceneName = latest.scene || shortName(latest.file) || 'untitled';
        const frameStale = latest.stale || latest.revisionStale;
        const status = ready === false ? 'OFFLINE' : frameStale ? 'STALE' : latest.seq > 0 ? 'LIVE' : 'IDLE';
        const statusColor = status === 'OFFLINE' ? 'error' : status === 'STALE' ? 'warning' : status === 'LIVE' ? 'success' : 'subtle';
        const bannerRows = pick ? 2 : notice ? 1 : 0;
        // 头部 2 + 两条分隔线 2 + 键位 1 + 画框上下边框 2 + 通知行。
        const maxImageRows = Math.max(1, height - 7 - bannerRows);
        const maxImageCols = Math.max(8, width - 4);
        const layout = fitCells(frameWidth || 16, frameHeight || 9, Math.min(maxImageCols, MAX_IMAGE_COLUMNS), Math.min(maxImageRows, MAX_IMAGE_ROWS));
        const source = React.useMemo(() => {
            if (!decoded || !decoded.image)
                return null;
            const image = decoded.image;
            // ui.Image's source is physical pixels and the renderer fits it into the
            // cell box by its natural aspect. Downscaling to layout.columns x rows
            // turned the frame into a 2x-wide image, letterboxed it vertically and
            // made click y wrong. Keep the natural aspect; only obey the host budget.
            const edge = 1024;
            const maxBytes = 4 * 1024 * 1024;
            const scale = Math.min(1, edge / Math.max(1, image.width, image.height), Math.sqrt(maxBytes / (4 * image.width * image.height)));
            if (scale >= 1) {
                return { data: image.data, width: image.width, height: image.height };
            }
            const scaled = downscaleRgba(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
            return scaled ? { data: scaled.data, width: scaled.width, height: scaled.height } : null;
        }, [decoded]);
        // 无 Kitty/Sixel 时 `<Image>` 的 children 就是用户能看到的全部画面。
        // ASCII 直接取全分辨率帧按 cell 采样：source 保持自然纵横比，不能拿它
        // 当 cell 图用；点击仍按 cell 坐标映射。
        const ascii = React.useMemo(() => (decoded && decoded.image ? rgbaToAscii(decoded.image, layout.columns, layout.rows) : ''), [decoded, layout.columns, layout.rows]);
        const frameIsCurrent = decoded !== null && decoded.seq === latest.seq && latest.seq > 0;
        const onImageClick = (event) => {
            if (!decoded || !decoded.image) {
                safeToast(host, '还没有视口画面，按 c 捕获');
                return;
            }
            if (!frameIsCurrent) {
                safeToast(host, '画面刚更新，请稍候再点');
                return;
            }
            const point = mapClickToNormalized(event && event.localCol, event && event.localRow, layout.columns, layout.rows);
            if (!point)
                return; // 图外点击不发请求（v2.1 §8.1 判据 19）
            if (clickBusyRef.current)
                return;
            clickBusyRef.current = true;
            void (async () => {
                try {
                    const request = pickRef.current;
                    if (request && request.requestId) {
                        const res = await postJson(port, '/host/pick/answer', {
                            requestId: request.requestId,
                            seq: latest.seq,
                            x: point.x,
                            y: point.y,
                        });
                        const data = res ? res.data : null;
                        if (!data) {
                            safeToast(host, '点选失败：后端不可达');
                            return;
                        }
                        if (data.state === 'answered') {
                            pickRef.current = null;
                            setPick(null);
                            const name = data.object && data.object.name ? String(data.object.name) : '';
                            safeToast(host, name ? '已应答：' + name + '（已返回给模型）' : '已应答：点空处（已返回给模型）');
                        }
                        else if (data.ok === true && data.state === 'pending') {
                            // §8.2 多选模式：加选后请求仍 pending；记下累积，按 d 收单。
                            const objects = Array.isArray(data.objects)
                                ? data.objects
                                : (Array.isArray(request.objects) ? request.objects : []);
                            const nextPick = { ...request, multi: true, objects: objects };
                            pickRef.current = nextPick;
                            setPick(nextPick);
                            safeToast(host, (data.added ? '已加选 ' + String(data.added) : '已加入多选')
                                + '（已选 ' + String(objects.length) + ' 件，按 d 完成）');
                        }
                        else {
                            safeToast(host, '点选未完成：' + String(data.error || 'unknown') + '（刷新后再点）');
                        }
                    }
                    else {
                        const res = await postJson(port, '/host/view/pick', {
                            seq: latest.seq,
                            x: point.x,
                            y: point.y,
                        });
                        const data = res ? res.data : null;
                        if (!data) {
                            safeToast(host, '点选失败：后端不可达');
                            return;
                        }
                        if (data.ok === true) {
                            const name = data.object && data.object.name ? String(data.object.name) : '';
                            // sendToChat 本阶段恒 false（需 panels.chat.attach 授权），只提示命中。
                            safeToast(host, name ? '命中 ' + name + '（sendToChat 暂不可用）' : '点空处（未命中物体）');
                        }
                        else {
                            safeToast(host, '点选失败：' + String(data.error || 'unknown'));
                        }
                    }
                }
                catch (error) {
                    safeToast(host, '点选失败：' + errorLine(error));
                }
                finally {
                    clickBusyRef.current = false;
                }
            })();
        };
        const header = React.createElement(ui.Box, { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 }, React.createElement(ui.Box, { flexDirection: 'row' }, React.createElement(ui.Text, { color: 'accent', bold: true }, 'BLENDER'), React.createElement(ui.Text, { color: 'subtle' }, '  VIEWPORT')), React.createElement(ui.Text, { color: statusColor }, '● ' + status + (follow ? ' · FOLLOW' : '')));
        const metaText = latest.seq > 0
            ? sceneName + '  ·  ' + String(frameWidth) + ' × ' + String(frameHeight) + '  ·  frame ' + String(latest.seq)
            : 'no frame captured';
        const meta = React.createElement(ui.Box, { paddingX: 1 }, React.createElement(ui.Text, { color: 'subtle', wrap: 'truncate' }, metaText));
        const callout = pick
            ? React.createElement(ui.Box, {
                flexDirection: 'column',
                borderStyle: 'single',
                borderTop: false,
                borderRight: false,
                borderBottom: false,
                borderColor: 'warning',
                paddingLeft: 1,
            }, React.createElement(ui.Text, { color: 'warning', bold: true, wrap: 'truncate' }, '点选请求' + (pick.multi
                ? ' · 多选 ' + String(Array.isArray(pick.objects) ? pick.objects.length : 0)
                : '')), React.createElement(ui.Text, { color: 'text', wrap: 'truncate' }, String(pick.prompt || '请点一下你要改的物体').replace(/\s+/g, ' ').slice(0, 120)))
            : notice
                ? React.createElement(ui.Box, { paddingX: 1 }, React.createElement(ui.Text, { color: notice.kind === 'error' ? 'error' : 'warning', wrap: 'truncate' }, String(notice.text || '').slice(0, 160)))
                : null;
        const emptyState = React.createElement(ui.Box, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }, React.createElement(ui.Text, { color: 'subtle' }, latest.seq > 0 ? 'LOADING' : 'NO FRAME'), React.createElement(ui.Text, { color: 'inactive' }, latest.seq > 0 ? '正在读取视口' : 'c 捕获当前视口'));
        const imageNode = source
            ? React.createElement(ui.Image, {
                source: source,
                width: layout.columns,
                height: layout.rows,
                presentation: 'transcript',
                alt: 'Blender viewport frame ' + String(latest.seq) + ' ' + String(frameWidth) + '×' + String(frameHeight),
                copyText: 'Blender viewport #' + String(latest.seq),
            }, React.createElement(ui.Text, { wrap: 'truncate' }, ascii || 'NO SIGNAL'))
            : emptyState;
        const imageWell = React.createElement(ui.Box, {
            flexDirection: 'column',
            width: width,
            height: layout.rows + 2,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            borderStyle: 'round',
            borderColor: 'subtle',
            paddingX: 1,
            overflow: 'hidden',
        }, React.createElement(ui.Box, { width: layout.columns, height: layout.rows, alignItems: 'center', justifyContent: 'center', onClick: onImageClick }, imageNode));
        // 底部可点击操作：手动刷新（复用 r/c 的处理）与跟随开关。
        const controlButton = (label, onClick, color) => React.createElement(ui.Box, { onClick, paddingX: 1, flexShrink: 0 }, React.createElement(ui.Text, { color, wrap: 'truncate' }, label));
        const footer = React.createElement(ui.Box, { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 }, React.createElement(ui.Box, { flexDirection: 'row', flexShrink: 1, overflow: 'hidden' }, controlButton('⟳ 刷新', () => { void captureNow(); }, 'accent'), controlButton(follow ? '⏸ 跟随' : '▶ 跟随', toggleFollow, follow ? 'success' : 'subtle'), pick && pick.multi ? React.createElement(ui.Text, { color: 'warning', wrap: 'truncate' }, '  d 完成') : null, React.createElement(ui.Text, { color: 'subtle', wrap: 'truncate' }, '  esc 取消')), React.createElement(ui.Text, { color: 'subtle', wrap: 'truncate' }, 'click 选物'));
        return React.createElement(ui.Box, { flexDirection: 'column', width: width, height: height, overflow: 'hidden' }, header, meta, React.createElement(ui.Divider, { color: 'subtle' }), callout, imageWell, React.createElement(ui.Box, { flexGrow: 1 }), React.createElement(ui.Divider, { color: 'subtle' }), footer);
    }
    return TuiViewportPanel;
}
// 面板服务与最终 id 的进程内句柄。宿主会给 id 加 `<pluginId>:` 前缀
// （没有 Component identity 的 bundle 回退成 `actN:`），所以只能注册后
// 从 list() 取回真正可寻址的 id，不能自己拼。
let panelService = null;
let panelId = null;
let panelAvailable = false;
/**
 * 把视口面板注册进 dsh-TUI 的 `ctx.tuiPanels`（apiVersion 1）。
 * 无服务 / 宿主拒绝 / 任何异常都返回 null，绝不把异常抛给宿主。
 * 成功返回 `'viewport'`（宿主会自动加 `<pluginId>:` 前缀）。
 */
export function registerTuiViewportPanel(ctx, opts) {
    try {
        const panels = ctx && typeof ctx.get === 'function' ? ctx.get('tuiPanels') : undefined;
        panelAvailable = !!(panels && typeof panels.register === 'function');
        if (!panelAvailable)
            return null;
        const component = createTuiViewportPanel(opts);
        const dispose = panels.register({
            apiVersion: 1,
            id: 'viewport',
            title: 'Blender 视口',
            icon: '◉',
            minColumns: 28,
            order: 50,
            component: component,
        });
        if (typeof dispose !== 'function')
            return null;
        // 注册后立刻 list()：拿到宿主实际分配的 id（`<pluginId>:viewport`）。
        // list 失败不影响面板本身，只是自动 open/诊断拿不到可寻址 id。
        try {
            const list = typeof panels.list === 'function' ? panels.list() : [];
            const found = (Array.isArray(list) ? list : []).find((entry) => entry && typeof entry.id === 'string' && entry.id.endsWith(':viewport'));
            panelId = found ? String(found.id) : null;
        }
        catch (error) {
            panelId = null;
        }
        panelService = panels;
        // 注册即效应：注册寿命 = effect 寿命；宿主 teardown 时调用 dispose。
        if (ctx && typeof ctx.effect === 'function') {
            try {
                ctx.effect(() => () => {
                    try {
                        dispose();
                    }
                    catch (error) {
                        // 宿主已撤下（重复清理）不抛。
                    }
                    if (panelService === panels) {
                        panelService = null;
                        panelId = null;
                    }
                });
            }
            catch (error) {
                // effect 接缝失败也不把注册失败化；面板仍在，等宿主下一个清理漏斗。
            }
        }
        return 'viewport';
    }
    catch (error) {
        return null;
    }
}
/** 面板能力/注册态：给 doctor/status 与 pick 自动打开用。 */
export function tuiPanelState() {
    return {
        available: panelAvailable,
        registered: panelId !== null,
        id: panelId,
        canOpen: !!(panelService && panelId && typeof panelService.open === 'function'),
    };
}
/**
 * 打开/聚焦视口面板。模型发起点选时调用：TUI 没有 Web 侧栏，不自动
 * 打开的话用户可能根本看不到请求。限速/拒绝都由宿主决定，这里只吞异常。
 */
export function openTuiViewportPanel() {
    try {
        if (!panelService || !panelId || typeof panelService.open !== 'function')
            return false;
        return panelService.open(panelId) === true;
    }
    catch (error) {
        return false;
    }
}
/** 只给自检用的纯逻辑出口（不承诺稳定 API）。 */
export const __internals = {
    decodePngToRgba: decodePngToRgba,
    fitCells: fitCells,
    downscaleRgba: downscaleRgba,
    rgbaToAscii: rgbaToAscii,
    mapClickToNormalized: mapClickToNormalized,
    autoCaptureDecision: autoCaptureDecision,
    followCaptureDue: followCaptureDue,
    revisionStaleDue: revisionStaleDue,
    tuiPanelState: tuiPanelState,
};
//# sourceMappingURL=tui-panel.js.map