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
/**
 * 解一张 PNG 成 RGBA。支持 8-bit、color type 6（RGBA）与 2（RGB）、
 * 非隔行、filter 0..4、多段 IDAT。任何坏数据返回 null（不抛）。
 */
export declare function decodePngToRgba(bytes: Uint8Array): {
    width: number;
    height: number;
    data: Uint8Array;
} | null;
/**
 * 把图像纵横比放进 `maxColumns × maxRows` 的终端单元格盒。
 * 终端单元格近似 2:1（高:宽），所以显示纵横比 = columns / (2 * rows)。
 * 至少 1×1，且 columns/rows 分别不超过 maxColumns/maxRows。
 */
export declare function fitCells(imageWidth: number, imageHeight: number, maxColumns: number, maxRows: number): {
    columns: number;
    rows: number;
};
/**
 * 最近邻缩放 RGBA 到 `width × height`（面板里就是单元格数：一个 cell 一个
 * 像素，渲染器再按终端 cell 尺寸铺开）。输入输出都是行主序 RGBA。
 */
export declare function downscaleRgba(image: {
    width: number;
    height: number;
    data: Uint8Array;
}, width: number, height: number): {
    width: number;
    height: number;
    data: Uint8Array;
} | null;
/**
 * 把 RGBA 缩成 `columns × rows` 的 ASCII 亮度图（每 cell 一个字符）。
 *
 * 为什么需要：dsh-TUI 的 `<Image>` 在 tmux / 无 Kitty/Sixel 的终端里会回退成
 * 一行占位；如果面板只显示 `▦ 视口 W×H`，用户点选就是“盲点”。这里用同一份
 * 已解码像素做亮度映射，让任何终端都能看见画面轮廓；点击仍按 cell 坐标映射，
 * 与原生图片路径一致。纯函数、无 I/O，坏了返回空串（调用方回退占位文本）。
 */
export declare function rgbaToAscii(image: {
    width: number;
    height: number;
    data: Uint8Array;
}, columns?: number, rows?: number): string;
/**
 * 把图像 Box 的单元格局部坐标映射成 0..1 归一化坐标（左上原点、y 向下）。
 * 落在图外返回 null —— v2.1 §8.1 要求"图外点击不发请求"；边界处按
 * [0,1] 夹取（终端点击坐标可能刚好落在右/下边缘）。
 */
export declare function mapClickToNormalized(localCol: number, localRow: number, columns: number, rows: number): {
    x: number;
    y: number;
} | null;
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
declare function autoCaptureDecision(s: any): {
    action: string;
    reason: string;
};
/**
 * 创建视口面板组件。返回的组件吃 `TuiPanelProps`（dsh-TUI
 * `src/dsh-adapter/panels.ts`），用宿主 React 渲染。
 */
export declare function createTuiViewportPanel(opts: {
    port: number;
}): (props: any) => any;
/**
 * 把视口面板注册进 dsh-TUI 的 `ctx.tuiPanels`（apiVersion 1）。
 * 无服务 / 宿主拒绝 / 任何异常都返回 null，绝不把异常抛给宿主。
 * 成功返回 `'viewport'`（宿主会自动加 `<pluginId>:` 前缀）。
 */
export declare function registerTuiViewportPanel(ctx: any, opts: {
    port: number;
}): string | null;
/** 面板能力/注册态：给 doctor/status 与 pick 自动打开用。 */
export declare function tuiPanelState(): {
    available: boolean;
    registered: boolean;
    id: string | null;
    canOpen: boolean;
};
/**
 * 打开/聚焦视口面板。模型发起点选时调用：TUI 没有 Web 侧栏，不自动
 * 打开的话用户可能根本看不到请求。限速/拒绝都由宿主决定，这里只吞异常。
 */
export declare function openTuiViewportPanel(): boolean;
/** 只给自检用的纯逻辑出口（不承诺稳定 API）。 */
export declare const __internals: {
    decodePngToRgba: typeof decodePngToRgba;
    fitCells: typeof fitCells;
    downscaleRgba: typeof downscaleRgba;
    rgbaToAscii: typeof rgbaToAscii;
    mapClickToNormalized: typeof mapClickToNormalized;
    autoCaptureDecision: typeof autoCaptureDecision;
    tuiPanelState: typeof tuiPanelState;
};
export {};
