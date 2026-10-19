# dsh-TUI 适配：侧栏视口面板 + 点击点选

> 适用版本：**dsh-TUI ≥ 0.16.0**（`ctx.tuiPanels`，`apiVersion: 1`，实验性接缝）。
> Web / 官方桌面端 / headless 不注册 TUI 面板，16 个模型工具不变。v2.2 给 `/host/*` 新增了 `ui`/`watching` 附加字段；
> `blender_rt_pick` 在没有面板轮询时会 2.5–6 s 快速失败（Web 页面可见时 `/host/ready` 仍算 watcher，侧栏收起不会误杀）。
> 本文只写 TUI 侧新增的那一半；Web 面板、`@` 提及与 v2.1 多选/缩放/作业区仍以
> [宿主集成接口契约](宿主集成-接口契约.md) 与 [操作教程 §9/§10](操作教程.md#9-宿主集成) 为准。

---

## 1. 为什么需要适配

插件原本的 UI 半边是**浏览器 bundle**（`src/client/index.js`，`dsh.client.platform = "web"`），
注册在 DSH Web 的 `conversation.view` / 右侧栏槽位上。dsh-TUI 没有浏览器 DOM，也没有这套槽位，
所以 TUI 里最初只有 16 个模型工具能用：

| 能力 | Web / 桌面端 | dsh-TUI（适配前） | dsh-TUI（适配后） |
|---|---|---|---|
| 16 个 `blender_rt_*` 工具 | ✅ | ✅ | ✅（一行未改） |
| 实时视口面板 | ✅ | ❌ | ✅ 侧栏 Panel |
| 点击画面选物体 | ✅ | ❌ | ✅ 点击面板画面 |
| 模型请求点选 `blender_rt_pick` | ✅ 面板应答 | ❌ 无 UI，只能等到超时 | ✅ 自动打开面板 + 点击/`Esc`/`d` 应答；无面板时 ~2.5–6 s 快速失败 |
| 图片内联显示 | `<img>` | 终端图片协议可用时显示真实画面，否则 ASCII 预览 | 同左 |
| 点击进消息（sendToChat） | ✅ | ❌（授权未落地，宿主恒 `false`） | ❌ 只 toast 命中结果 |
| `@` 提及对象/材质/集合 | ✅ | ❌（TUI 没有插件提及接缝） | ❌ 未适配 |
| 多选 UI / 缩放平移 / 作业区 | ✅ v2.1 | ❌ | ❌ 当前只做单选 + 逐次 answer |

适配只走 **host 侧**：新增 `src/tui-panel.ts`，通过 `ctx.inject(['tuiPanels'], …)` 等待宿主服务，
拿到后注册一个 id 为 `viewport` 的侧栏面板。**不新增 npm 依赖**（PNG 解码只用 Node 内置 `zlib`），
**不改** `lib/client.js`，**不改** 16 个工具的入参/回执。

---

## 2. 安装与验收

安装方式与 Web 完全一样（`dsh.bundle` 装配），额外要求只有一条：**dsh-TUI ≥ 0.16.0**。

```bash
# 1) 装进 profile（与 README §3 相同）
dsh plugin --profile <profile> add link:/绝对路径/dsh-blender-plugin
#    或：dsh plugin --profile <profile> add ./dsh-external-dsh-blender-plugin-2.1.0.tgz

# 2) 重启 dsh-TUI（插件是启动时加载的模块；面板注册不会热插进已启动的进程）
# 3) 确认 Blender 与 addon 已连（doctor kind=ok）
# 4) 在 TUI 里让模型调用：
blender_viewport(op="doctor")
```

`doctor` 会多一行宿主面板状态：

```text
宿主面板：✅ dsh-TUI 侧栏已注册（act1:viewport）
```

- Web / headless 下这一行是 `无 tuiPanels（…模型工具不受影响）`，属正常。
- `act1:viewport` 是**宿主实际分配的 id**（没有 `dsh-plugin.json` Component identity 时，
  宿主用 `actN:` 前缀）。不要自己拼；以 `doctor` / 面板栏显示为准。
- 面板注册失败时是 `⚠️ tuiPanels 可用，但面板注册失败`，工具面不受影响。

> ⚠ **已知宿主问题（dsh-TUI 0.16）**：profile 里除官方 bundle 外还有第三方 bundle 时，
> standalone `dsh-tui` 可能在启动时报 `1 required plugin did not activate`，日志里是核心插件的
> `root.effect is unavailable from a plugin activation`（核心插件与 TUI 行的激活竞态）。
> 这不是插件错误：用 **`dsh --profile <profile>`** 启动（DSH 自己的 Loader 组合）即可正常使用
> 工具与面板；等 dsh-TUI 修好入口守卫后再换回 `dsh-tui`。

打开面板：

- `Ctrl+B` 打开侧栏，点顶部「Blender 视口」标签；或
- `/panel act1:viewport`（把 id 换成 doctor 打印的那个）。

---

## 3. 面板内操作

| 操作 | 行为 |
|---|---|
| 点击画面 | 有模型点选请求 → `POST /host/pick/answer` 应答；没有请求 → `POST /host/view/pick` 并 toast 命中对象名 |
| `c` | `POST /host/view/capture` 抓当前 GUI 视口一帧（`max_size=1600`） |
| `r` / 点「⟳ 刷新」 | 立即重拍一帧并刷新（`POST /host/view/capture` → 重读 `/host/view/latest`），不是只重读 store |
| `f` / 点「▶ 跟随」 | 跟随模式开关：每 2.5 s 抓一帧（1000 长边，仅 `blender_quiet` 时），默认关闭 |
| 场景改后静默 | 面板可见且 `stale` + `blender_quiet` 时自动 `POST /host/view/capture`（1200 ms 节流；连续 3 次无进展停手，按 `r`/`c` 手动刷新复位） |
| 鼠标改场景 | v2.3：`GET /host/scene-revision` 读到 revision 变化且 `idle_ms ≥ 800` 时也自动重拍（depsgraph handler，不依赖后端命令） |
| 渲染中 | v2.3：头部状态 `● RENDERING`；自动重拍/跟随暂停，渲染结束（标记失效）后再抓 |
| 作业区 | v2.3：`GET /host/jobs` 有 running 作业时，画面下方显示 `JOBS` 行；点击行（或按 `J`）展开最近 3 行日志，再点收起 |
| `s` / 点「⤓ 保存」 | 把当前帧的原始 PNG 写到 `~/Pictures`（没有则 `~/Downloads` / 临时目录），toast 给出完整路径 |
| `y` / 点「⧉ 复制」 | 复制最近一次点选命中的对象名（Linux 依次试 wl-copy/xclip/xsel；mac pbcopy；win clip） |
| `o` / 点「⌂ 目录」 | 在文件管理器里定位当前 `.blend` 所在目录（未保存时提示） |
| **滚轮** | 以光标为锚缩放（1–8×）；**不经过输入法**，首选 |
| **按住拖拽画面** | 平移；自动夹在原图内，不会裁出黑边；**不经过输入法**，首选 |
| 点「− / + / ⟲」 | 元信息右侧可点的缩小 / 放大 / 复位（无滚轮也能用） |
| `+` / `-` / `0`（可选） | 键盘缩放/复位；输入法会先吃字母，IME 用户请用滚轮或按钮 |
| `h` / `j` / `k` / `l`（可选） | 键盘平移；IME 用户请用拖拽 |
| `Esc` | 有 pending 点选请求时取消它（`POST /host/pick/cancel`）并阻止面板关闭；没有请求时不拦截，按宿主语义退出面板 |
| 切走面板 | 停止轮询；切回来继续（面板不可见时不发请求） |

> **输入法（IME）注意**：终端会把单字母先交给输入法，组词确认后才会到应用；面板无法绕过。
> 因此**鼠标操作是主路径**：滚轮缩放、拖拽平移、点击按钮（刷新/跟随/保存/复制/目录/缩放）；
> 单字母快捷键只作为非 IME 用户的附加。

面板挂载时如果后端还**没有任何帧**（`seq=0`），会自动抓一帧；失败不重试、也不额外弹错误
（面板保持 `NO FRAME`，可按 `c` 手动再捕），不会反复重试轰炸 Blender。

场景改过（`stale=true`）且 Blender 静默 0.8 s 后，面板会自动重拍一帧，状态从 `STALE` 回到
`LIVE`；1200 ms 节流保证连续编辑只出一张。连续 3 次无进展会停手（避免场景持续变化时无限打
后端），按 `r`/`c` 手动刷新即可复位。

**跟随模式**：鼠标在 Blender 里直接改场景不会产生后端命令，所以 `stale` 不会变；如果希望
"边拖边看"，按 `f` 或点「▶ 跟随」打开跟随模式。它每 2.5 s 抓一帧，捕获分辨率降到 **1000**
长边（1600 实测约 1 s/帧，1000 约 0.5 s），并且只在 `blender_quiet` 时抓——不打断模型/别的
会话的在飞命令。默认关闭；面板不可见/有 pending 点选时自动暂停。

**模型请求点选时自动打开**：`blender_rt_pick` 发起点选后，host 侧调用 `tuiPanels.open()`，
把面板切到前台并聚焦；请求挂起期间在画框上方显示一条 `点选请求` 提示
（warning 色左竖线 + 你给的 prompt），同时给面板挂 `warning` 徽标。

如果面板没能注册/打开（dsh-TUI < 0.16、`tuiPanel: false`、注册被拒、宿主没有 `tuiPanels`），
后端会记录「有没有面板在轮询 `/host/*`」；工具在 **2.5 s 宽限**（auto-open 失败时放宽到 6 s）后若仍无 watcher，会立即取消请求并
返回 `PICK 未检测到可应答的视口面板`（而不是空等 120–600 s，也不再把原因误写成「用户没点」）。
有面板轮询时行为不变，仍按 `timeout_s` 等用户点击。细节见
[宿主集成接口契约 v2.2 增补](宿主集成-接口契约-v2.2增补.md)。

### 3.1 面板视觉

面板走 dsh-TUI 的主题色与原有 UI 原语，不引入图片之外的自绘图形：

- **品牌头**：`BLENDER  VIEWPORT`（accent 色 + subtle 色）+ 右侧状态点
  `● LIVE / STALE / OFFLINE / IDLE`（success / warning / error / subtle）。
- **元信息**：`Scene · 宽 × 高 · frame N · 3s ago`，右侧可点的 `− / + / ⟲`（无帧时 `no frame captured`）。
- **分隔线**：`ui.Divider` 的 hairline，上下各一条，给画框留出呼吸感。
- **画框**：`ui.Box` 圆角细边框 + 水平内边距；画面顶部锚定，下方留白，不铺满整块面板。
- **键位栏**：左侧是可点击的「⟳ 刷新」「▶/⏸ 跟随」「⤓ 保存」按钮（有命中对象时再加「⧉ 复制」）+ `esc 取消`，右侧 `click 选物`；多选请求额外显示 `d 完成`。元信息右侧有可点击的「⌂ 目录」。
- **点选提示**：warning 色左竖线 + `点选请求` + prompt；不写长句、不用 emoji。
- 无 Kitty/Sixel 时画框内是 ASCII 亮度图；有图形协议时同一位置换成真实画面。

---

## 4. 图片显示与回退

面板把 `/host/view.png` 的 PNG 用 `node:zlib` 解成 RGBA，按**原始像素纵横比**缩到宿主预算
（最长边 ≤1024、RGBA ≤4MB），交给宿主 `<Image>` 按 cell 盒等比 fit；ASCII 回退则按 cell 面积平均采样：

- 终端支持 **Kitty graphics / Sixel**：显示真实画面（与 TUI 的内联图片同一套渲染路径）。
- 不支持（tmux 未开 passthrough、`DSH_TUI_DISABLE_TERMINAL_IMAGES=1`、普通 SSH 终端等）：
  回退成 **ASCII 亮度预览**——对全分辨率帧按 cell **面积平均**降采样（不是单点采样，避免网格/噪点
  变成满屏高频字符），再用 **2%–98% 分位**做对比度拉伸（Blender 常见的深灰背景 + 灰色物体也能
  看出轮廓），点击坐标仍按 cell 映射。
  取帧、点选、模型看图仍然工作；**模型侧始终能拿到 PNG 附件**——面板显示不出来不等于
  `blender_rt_see` 不可用。

点击坐标按“图像 Box 的局部单元格”换算成 `0..1` 归一化坐标；图外点击不发请求（v2.1 §8.1 判据 19）。

---

## 5. 配置

插件行（profile 的 `cordis.patch.yml` 或 `dsh plugin` 写入的 bundle 行）支持：

```yaml
- id: dsh-blender-plugin
  name: '@dsh-external/dsh-blender-plugin'
  config:
    tuiPanel: false     # 关掉 TUI 面板；默认 true（只在有 ctx.tuiPanels 的宿主生效）
    port: 9877          # 后端端口，同 Web
    autoStart: true     # 自动拉起后端，同 Web
```

`tuiPanel: false` 时不会等待/注册面板，模型工具与 Web 半边不受影响。
面板 API 仍是 dsh-TUI 的实验性接缝；宿主升级导致面板异常时，这是无需降级插件版本的开关。

---

## 6. 排障

| 现象 | 先看 | 处置 |
|---|---|---|
| `doctor` 报 `无 tuiPanels` | dsh-TUI 版本 / 是否真的跑在 TUI profile | 升级到 ≥ 0.16.0；确认启动的是 `dsh-tui`（不是 `dsh web`） |
| 报 `tuiPanels 可用，但面板注册失败` | dsh-TUI 启动日志里的 `tuiPanels.register rejected …` | 面板预算（每插件 ≤4 / 全局 ≤32）或 id 冲突；重启 TUI 后复查 |
| 面板在标签栏里但打不开 | `/panel` 的 id 是否写错 | 用 `doctor` 打印的 `actN:viewport`，或直接点标签 |
| 画框里一直是 `LOADING` / `NO FRAME` | 后端 9877 是否可达；Blender 是否连上；是否真的捕获过帧 | `curl 127.0.0.1:9877/health`、`blender_viewport(op="doctor")`；连上后按 `r` 或 `c` 捕获 |
| 面板显示 ASCII 字符画而不是图 | 终端是否有 Kitty/Sixel；tmux 是否 passthrough | 正常回退；换支持图形协议的终端可看真实画面。字符画仍可点击 |
| 点画面总回“空处” | 点的是不是视口里的空白/背景 | 点在物体轮廓内；或用 `blender_rt_pick` 让用户重点 |
| `blender_rt_pick` 2.5–6 s 后返回「未检测到可应答的视口面板」 | 面板是否真的注册/轮询（`doctor` 的宿主面板行）；Web 页是否在后台 | 打开/切回面板后重试；修面板或用 `tuiPanel: true` 重启。请求已自动 cancel，不会留 pending |
| `blender_rt_pick` 等满 `timeout_s` 后超时 | 面板在轮询但用户没点 | `Esc` 取消；或让用户重点/直接给对象名 |
| Esc 没取消、反而退回聊天 | 焦点是否在面板 | 先点面板画面/按 `Ctrl+B` 聚焦右栏，再按 Esc |

---

## 7. 验收记录（2026-10-18，本机实测）

环境：Arch Linux · Blender **5.2.2 LTS** · 插件 **2.1.0** · dsh-TUI **0.16.1** · DSH core **0.2.1-rc.2**。

| 判据 | 结果 |
|---|---|
| TUI 里 `blender_viewport(op=doctor)` | `kind=ok`，且 `宿主面板：✅ dsh-TUI 侧栏已注册（act1:viewport）` |
| 面板打开 | 标签栏出现「Blender 视口」；品牌头 `BLENDER  VIEWPORT` + 状态点 `● LIVE/STALE/IDLE`，元信息 `Scene · W × H · frame N` |
| `c` 捕获 | seq 递增、尺寸变 1600 长边、`fresh` |
| 帧龄 | 元信息显示 `· 2s ago`，随时间增长；新帧后归零 |
| 鼠标改场景自动重拍 | 在 Blender GUI 里拖动物体 → revision 递增 → 停手 0.8 s 后面板自动重拍（无 `c` 操作），状态回 `LIVE` |
| `r` / 「⟳ 刷新」 | 无 `c` 之外的操作，seq 立即 +1、画面刷新（真重拍，不只是重读 store） |
| 场景改后自动重拍 | 改场景 → 等 Blender 静默 0.8 s → 面板从 `STALE` 回 `LIVE`，`frame N` 递增；连续 3 次无进展停手，按 `r`/`c` 复位 |
| 跟随模式 | 按 `f`/点「▶ 跟随」→ 状态带 `· FOLLOW`；每 2.5 s 自动抓帧（1000 长边），`seq` 持续递增；Blender 忙时暂停；再按 `f` 关闭 |
| 渲染状态 | 人工写 `renders/render_state.json` → 头部 `● RENDERING`、跟随暂停；删除后恢复 `LIVE`/`STALE` |
| 作业区 | 起一个 headless 作业 → 面板出现 `JOBS` running 行；点击行显示日志尾部；作业结束后不再显示 running 行 |
| 保存帧 | 按 `s` → `~/Pictures/blender-viewport-*.png` 出现、toast 路径；文件为合法 PNG |
| 复制对象名 | 点选命中后按 `y` → 剪贴板内容为对象名；无剪贴板工具时 toast 完整名字 |
| 打开目录 | 按 `o` → 文件管理器打开当前 `.blend` 所在目录；未保存时提示 |
| 缩放/平移 | `+`/`-`/`0` 改 `· 1.5×`、画面裁剪；`h/j/k/l` 平移不越界；点选坐标仍命中同一物体 |
| 模型 `blender_rt_pick` | 面板自动打开并显示 `点选请求` 提示；点击画面后工具返回 `PICK ok`（点空处返回空处语义） |
| `Esc` 取消 | 工具返回 `PICK 已取消`，面板 toast「已取消点选请求」 |
| 无面板时 `blender_rt_pick` | 独立后端（无 watcher）**2.8 s** 返回 `PICK 未检测到可应答的视口面板`，请求已 cancel，不再等 120 s |
| 有 watcher 时 `blender_rt_pick` | 模拟 watcher（1 s 一次 `/host/view/latest`，非真实面板）下，`timeout_s=5` 仍等满 **5.2 s** 返回原超时语义（不误杀） |
| 聚焦自检 | `tests/tui_panel_selftest.mjs` **27/27** · `tests/scene_revision_selftest.mjs` **5/5** · `tests/pick_presence_selftest.mjs` **5/5** · `tests/host_cors_selftest.mjs` **48/48** · `tests/dsh_api_compat_probe.mjs` **PASS**（16 工具） |
| `npm test` | exit 0（discoverability 51/51 + 上述聚焦自检） |
| 无图形协议回退 | tmux 内显示自动对比度 ASCII 预览（物体轮廓可见），取帧/点选/模型看图均正常 |

> 未覆盖：真实 Kitty/Sixel 终端里的像素级呈现（本机 tmux 无 passthrough）；多选 UI、缩放平移、
> 作业区、`@` 提及。它们不是本次适配的承诺，见 §1 对照表。
