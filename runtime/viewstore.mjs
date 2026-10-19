/**
 * 宿主集成 · 视口状态存储（ViewportStore）
 *
 * 契约：`docs/宿主集成-接口契约.md` §1（HTTP）与 §3（本文件的内部语义，**冻结**）。
 * 参考实现：上游 `ahujasid/mcp-for-blender` 的 `openai_apps.py:254-338`（MIT）——
 * 它解决的是同一个问题：**面板轮询 store，绝不轮询 Blender**（面板开着不能占 Blender 主线程）。
 *
 * 为什么是进程内单例：`runtime/engine.mjs`（在 addon 通道的 send 包装里记在飞/场景变更）
 * 与 `runtime/server.mjs`（HTTP 路由）必须是**同一份状态**；两者同进程、同一次 import。
 *
 * 三条纪律（照契约，不得放宽）：
 *   ① `seq` 只增不减；没捕获过任何一帧时 `seq === 0`（`source:"none"`、`captured_at:null`）。
 *   ② `stale` 用**变更命令计数**判定（`scene_version > captured_scene_version`），
 *      不是"看着像变了"—— 捕获**开始前**读一次 scene_version 存进该帧。
 *   ③ `pickable` 必须诚实：该帧没留下相机矩阵就是 `false`（没有矩阵就投不了，不许撒谎）。
 */

/** A8（上游 `openai_apps.py:251`）：场景改完后静默 0.8 s 才自动重拍 —— 连续编辑只出一张。 */
export const AUTO_CAPTURE_QUIET_S = 0.8;

/** §3：`_views` 只保留最近 50 帧的相机矩阵（点击反查用；再老的 seq 回 `unknown_seq`）。 */
export const VIEWS_KEEP = 50;

/** §1.4：`max_size` 夹到 [200, 2000]，默认 1000。 */
export const HOST_MAX_SIZE_MIN = 200;
export const HOST_MAX_SIZE_MAX = 2000;
export const HOST_MAX_SIZE_DEFAULT = 1000;

/** §1.6：`limit` 默认 200、夹到 [1, 1000]（**每类**各取这么多）。 */
export const HOST_ITEMS_LIMIT_DEFAULT = 200;
export const HOST_ITEMS_LIMIT_MIN = 1;
export const HOST_ITEMS_LIMIT_MAX = 1000;

/**
 * §3「会改场景」的命令集合（对齐上游 `SCENE_CHANGING_COMMANDS`）。
 *
 * ⚠ 口径是**保守过标**（宁可多标 stale，不可漏标）：`execute_code` 是万能通道，
 * 它既可能只是读一下、也可能改场景 —— 上游也把它整条计入。代价是"任何一次模型侧
 * 工具调用之后 stale 都可能为真"；收益是**绝不会**让用户对着过期画面点选。
 *
 * 两类显式例外（由 engine.mjs 的 `addon.send(..., {noMark:true})` 排除，不是在这里）：
 *   ① 插件自己加载 runtime/*.py 模块（纯 plumbing，不可能改场景）；
 *   ② `/host/*` 的三条只读原语（取帧 / 点击反投影 / `@` 列表）——
 *      否则"点一下视口"会经由 ensureView() 的 execute_code 把刚抓的那帧标成 stale。
 *   `/status`、`/doctor` 这类**只读诊断**仍按字面口径计入（保守方向），未做例外。
 */
export const SCENE_CHANGING_COMMANDS = new Set([
  'execute_code',
  // 资产导入类（catalog.mjs 里带 gate 的那几条里真正会改场景的）
  'download_polyhaven_asset',
  'set_texture',
  'import_generated_asset',
  'download_sketchfab_model',
  'download_polypizza_model',
  'import_generated_asset_hunyuan',
]);

/** 这条 addon 命令会不会改场景？（见 SCENE_CHANGING_COMMANDS 的保守口径） */
export function isSceneChangingCommand(name) {
  return SCENE_CHANGING_COMMANDS.has(String(name || ''));
}

/**
 * §1.4：`max_size` 夹到 [200, 2000]，默认 1000。
 * 口径（与 §1.6 的 limit 一致）：**缺省/非数** → 默认值；**给了数** → 一律夹进区间
 * （所以显式 `max_size=0` 夹成 200，而不是被当成"没给"而回落到 1000）。
 */
export function clampMaxSize(v) {
  if (v === null || v === undefined || v === '') return HOST_MAX_SIZE_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return HOST_MAX_SIZE_DEFAULT;
  return Math.max(HOST_MAX_SIZE_MIN, Math.min(HOST_MAX_SIZE_MAX, Math.round(n)));
}

/**
 * §1.6：`limit` 默认 200、夹到 [1, 1000]。
 * 口径同上：**缺省/非数** → 默认 200；**给了数** → 夹进 [1,1000]
 * （所以显式 `limit=0` / `limit=-5` 夹成 **1**，不是 200 —— 这是 tests/host_routes_selftest.mjs
 * 的独立断言发现的：契约写的是"夹到 [1,1000]"，0 是"超出范围"，不是"没给"）。
 */
export function clampItemsLimit(v) {
  if (v === null || v === undefined || v === '') return HOST_ITEMS_LIMIT_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return HOST_ITEMS_LIMIT_DEFAULT;
  return Math.max(HOST_ITEMS_LIMIT_MIN, Math.min(HOST_ITEMS_LIMIT_MAX, Math.round(n)));
}

/** §1.5：x/y 归一化 0..1（图像左上角为原点、y 向下），超出范围夹到 [0,1]。 */
export function clampUnit(v, dflt = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(1, n));
}

/** 内部一律存**原始字符串**（`bpy.data.filepath` 未保存时是 `""`）；只在 JSON 边界把 `""` 折成 `null`。 */
function rawStr(v) { return (v === null || v === undefined) ? '' : String(v); }
function nullIfEmpty(v) { return v ? v : null; }

export function createViewStore() {
  // ── 最近一帧 ────────────────────────────────────────────────────────────
  let seq = 0;                    // 0 = 从未捕获
  let png = null;                 // Buffer（只留最新一帧的字节；§1.3 只服务当前 seq）
  let source = 'none';            // user | auto | model | none
  let capturedAt = null;          // Unix 秒（float）
  let file = '';                  // 该帧所属 .blend 的绝对路径（未保存 = ""）
  let scene = '';                 // 该帧所属场景名
  let sceneCount = null;          // 捕获时 len(bpy.data.scenes)
  let width = 0;
  let height = 0;

  // ── 场景变更计数 ────────────────────────────────────────────────────────
  // 谁算"会改场景"由 engine.mjs 在 addon 通道的 send 包装里逐条判定（见 SCENE_CHANGING_COMMANDS），
  // 并显式排除两类：插件自己加载 python 模块、以及 /host/* 的只读原语（opts.noMark）。
  // 早先这里有一个全局 suppress 计数器，已删 —— 全局可变的抑制会在"别的会话的写命令
  // 恰好在此窗口内完成"时**吞掉**它的标记（欠标 stale 是危险方向），逐调用点判定没有这个洞。
  let sceneVersion = 0;               // "会改场景"的命令完成一次 +1
  let capturedSceneVersion = 0;       // 最近一帧捕获**开始前**的 sceneVersion
  // v2.3：GUI 编辑 revision（来自 Blender 侧 depsgraph handler 写的 JSON；null = 没有探针）
  let sceneRevision = null;
  let capturedSceneRevision = null;

  // ── §3 在飞计数（blender_quiet 的判据）──────────────────────────────────
  let inflight = 0;                   // addon 通道在飞命令数
  let lastCommandAt = 0;              // 最近一条命令**结束**的时刻（ms）

  /** §3：`seq → {view_matrix, window_matrix, width, height, file, scene}`，只留最近 50 帧。 */
  const views = new Map();

  function beginCommand() { inflight += 1; }
  function endCommand() { inflight = Math.max(0, inflight - 1); lastCommandAt = Date.now(); }
  /** §3：任何"会改场景"的命令完成后 scene_version += 1。 */
  function noteSceneChange() { sceneVersion += 1; }

  /** §1.2 的 `blender_quiet`：当前无在飞命令 且 距上次命令 ≥ 0.8 s。 */
  function isQuiet() {
    return inflight === 0 && (Date.now() - lastCommandAt) >= AUTO_CAPTURE_QUIET_S * 1000;
  }
  /** §1.2 的 `stale`：该帧之后场景被改过。没捕获过任何一帧时恒为 false。 */
  function isStale() { return seq > 0 && sceneVersion > capturedSceneVersion; }

  /** v2.3：GUI 编辑带来的陈旧（revision 变了、但还没有对应的新帧）。 */
  function isRevisionStale() {
    if (!(seq > 0) || sceneRevision === null) return false;
    // 捕获发生在探针注入之前时 capturedSceneRevision 还是 null：只要之后出现过
    // 编辑（revision > 0）就算陈旧；revision 仍为 0 时保持 false（没改过场景）。
    if (capturedSceneRevision === null) return sceneRevision > 0;
    return sceneRevision !== capturedSceneRevision;
  }

  /** v2.3：记录后端探到的 GUI revision（文件读出来的计数）。 */
  function noteSceneRevision(value) {
    const rev = Number(value);
    if (Number.isFinite(rev)) sceneRevision = rev;
  }

  /**
   * §3：登记一帧。`seq += 1`。
   * @param {Buffer} pngBuf PNG 字节
   * @param {'user'|'auto'|'model'} src 谁触发的（`seq===0` 时对外报 "none"）
   * @param {{view_matrix:number[][], window_matrix:number[][]}|null} view 该帧相机矩阵（拿不到就 null → pickable=false）
   * @param {object} meta {file, scene, scene_count, width, height, captured_scene_version}
   * @returns {number} 新的 seq
   */
  function put(pngBuf, src, view, meta) {
    const m = meta || {};
    seq += 1;
    png = Buffer.isBuffer(pngBuf) ? pngBuf : Buffer.from(pngBuf || '');
    source = (src === 'auto' || src === 'model' || src === 'user') ? src : 'user';
    capturedAt = Date.now() / 1000;
    file = rawStr(m.file);
    scene = rawStr(m.scene);
    const sc = Number(m.scene_count);
    sceneCount = Number.isFinite(sc) ? sc : null;
    width = Math.max(0, Math.round(Number(m.width) || 0));
    height = Math.max(0, Math.round(Number(m.height) || 0));
    const csv = Number(m.captured_scene_version);
    capturedSceneVersion = Number.isFinite(csv) ? csv : sceneVersion;
    // 这帧之后若 GUI 又改过，revision 会再次大于它；null（没有探针）保持 null。
    capturedSceneRevision = sceneRevision;
    const vm = view && view.view_matrix, wm = view && view.window_matrix;
    if (vm && wm) {
      views.set(seq, { view_matrix: vm, window_matrix: wm, width: width, height: height, file: file, scene: scene });
      while (views.size > VIEWS_KEEP) {
        const oldest = views.keys().next().value;
        views.delete(oldest);
      }
    }
    return seq;
  }

  /** §1.2：最近一次捕获的**状态**（不含图像字节）。键与顺序照契约，不加字段。 */
  function latest() {
    return {
      ok: true,
      seq: seq,
      captured_at: capturedAt,
      source: seq === 0 ? 'none' : source,
      file: nullIfEmpty(file),
      scene: nullIfEmpty(scene),
      scene_count: sceneCount,
      stale: isStale(),
      scene_revision: sceneRevision,
      revision_stale: isRevisionStale(),
      pickable: seq > 0 && views.has(seq),
      blender_quiet: isQuiet(),
      width: width,
      height: height,
    };
  }

  /**
   * §1.3：取图。
   * - `seqArg` 省略 → 当前帧 200
   * - `seqArg === seq` → 200
   * - 落后或未知（含大于当前、非数）→ 409 `stale_seq`（带当前 seq）
   * - 还没有任何帧 → 404 `no_frame`
   */
  function pngFor(seqArg) {
    if (seq === 0 || !png) return { status: 404, body: { ok: false, error: 'no_frame' } };
    const raw = (seqArg === null || seqArg === undefined || seqArg === '') ? seq : Number(seqArg);
    if (!Number.isFinite(raw) || Math.round(raw) !== seq) {
      return { status: 409, body: { ok: false, error: 'stale_seq', seq: seq } };
    }
    return { status: 200, png: png };
  }

  /** §1.5：取某 seq 的相机矩阵；没有（未知/太老/无矩阵）返回 null → 路由回 `unknown_seq`。 */
  function viewFor(seqArg) {
    const raw = (seqArg === null || seqArg === undefined || seqArg === '') ? seq : Number(seqArg);
    if (!Number.isFinite(raw)) return null;
    return views.get(Math.round(raw)) || null;
  }

  /**
   * 宿主取帧：捕获**开始前**读 scene_version，捕获完成后把 PNG + 矩阵 + origin 登记进 store。
   * 捕获自身不改场景（engine 侧对这三条原语用 opts.noMark）→ 刚抓的帧不会自己把自己标成 stale。
   * engine 以参数注入（避免 viewstore → engine 的循环 import）。
   */
  async function captureThrough(engine, opts = {}) {
    const maxSize = clampMaxSize(opts.maxSize);
    const src = opts.auto ? 'auto' : 'user';
    const v0 = sceneVersion;                       // §3：捕获开始前读一次
    let out = null;
    try {
      out = await engine.hostCapture({ maxSize: maxSize });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    const meta = (out && out.meta) || null;
    if (!out || !out.png || !meta) return { ok: false, error: 'capture 无回执' };
    const view = (meta.view_matrix && meta.window_matrix)
      ? { view_matrix: meta.view_matrix, window_matrix: meta.window_matrix } : null;
    put(out.png, src, view, {
      file: meta.file, scene: meta.scene, scene_count: meta.scene_count,
      width: meta.width, height: meta.height, captured_scene_version: v0,
    });
    return { ok: true, meta: meta, pickable: !!view };
  }

  /** 诊断用快照（**不进 HTTP 契约**，只给 /health 之类的自证看）。 */
  function snapshot() {
    return {
      seq: seq, source: source, scene_version: sceneVersion, captured_scene_version: capturedSceneVersion,
      scene_revision: sceneRevision, captured_scene_revision: capturedSceneRevision,
      inflight: inflight, last_command_age_ms: lastCommandAt ? (Date.now() - lastCommandAt) : null,
      views_kept: views.size, views_keep_max: VIEWS_KEEP,
      png_bytes: png ? png.length : 0, file: nullIfEmpty(file), scene: nullIfEmpty(scene),
    };
  }

  return {
    // 状态机
    beginCommand, endCommand, noteSceneChange, noteSceneRevision,
    isQuiet, isStale, isRevisionStale, put, latest, pngFor, viewFor, captureThrough, snapshot,
    // 只读取用（engine 在捕获前读 scene_version）
    get sceneVersion() { return sceneVersion; },
    get seq() { return seq; },
    get viewsKept() { return views.size; },
  };
}

/** 进程内单例：engine.mjs（记在飞/场景变更）与 server.mjs（HTTP 路由）共用同一份状态。 */
export const viewStore = createViewStore();
