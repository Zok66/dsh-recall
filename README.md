# dsh-recall

DSH 的「撤回」插件：只撤**最后一条用户消息**，把对话与工作区文件一起回退到这一轮开始前，并生成一个新的干净分支会话。

## 功能

- 每一轮助手回复的动作条上会出现一个回旋箭头「撤回」按钮。
- 点击后：
  1. 弹窗确认（`window.confirm`）。
  2. 生成一个**不含这条消息及其之后内容**的新分支会话，原文回到新会话输入框，可改动后重发。
  3. **文字与附件一起回填**：图片、普通文件都会重新放回输入框（图片带预览、文件显示成附件卡）。
  4. 工作区里这一轮被 AI 改动过的文件**还原**、这一轮新增的文件**删除**（基于每轮开始前的快照）。
  5. **原会话保留**在会话列表中可回看，不会被删除。
- 只允许撤最后一条用户消息；更早的消息请用框架自带的「分支」功能。
- 撤回按钮**即时跟随最后一条用户消息**：发出新消息后按钮自动移挂到新气泡，无需重进会话刷新（v2.3 起经 `useSyncExternalStore` 订阅分发）。

## 安装（一行命令）

```bash
dsh plugin --profile web add https://github.com/Zok66/dsh-recall
```

装完后**手动重启 `dsh web`**（或刷新页面），撤回按钮即生效。

### 装完怎么确认

```bash
grep -i recall ~/.dsh/dsh-web.log | tail
```

正常会看到：

```
[recall] 已启用：快照 + 文件还原 + 附件字节路由
[recall] 附件读取路由已注册: /api/recall.attachment
[recall] 撤回还原路由已注册: /api/recall.restore
```

## 卸载（两条命令，先还原前端再摘插件）

```bash
# ① 把宿主前端还原干净（移除撤回按钮；带基线校验，不会降级）
node /插件目录/lib/uninstall.js

# ② 摘掉插件本身
dsh plugin --profile web remove dsh-recall
```

v2.2 的撤回按钮通过**改写 `dsh-client-ui-chat/lib/client.js`** 注入到用户消息的 React 组件树里——这是被实测证明「点击一定有效」的唯一方案（v2.0/v2.1 的官方插槽与 DOM 注入在 Android App 里点击无反应）。代价是 `remove` 不会自动还原被改写的前端文件，所以**必须先跑第 ① 步**。不跑的话按钮会残留在界面上（点了没反应），再跑 ① 即可清除。

`lib/uninstall.js` 的安全设计：先验证「备份 + 补丁 = 当前文件」才还原（防 DSH 升级后用旧备份降级整个前端）；还原前把当前版本另存一份，可反悔。支持 `--status` / `--dry-run`。

> 历史注记：v2.0~v2.1 曾改用官方双面包（不改框架文件、卸载自动消失），但在 Android App 里撤回按钮点击无反应（宿主日志无任何痕迹），最终回到 v1.x 的补丁方案。官方插槽版按钮能显示但位置在 AI 回复下方，也被否决。

顺带清掉快照（可选，目录 `~/.dsh/.recall-snapshots/`）：

```bash
rm -rf ~/.dsh/.recall-snapshots
```

## 更新（一键脚本）

DSH 目前没有插件原地更新能力，「检查更新」在目标包已被 pnpm 落成实体目录时会报 `PLUGIN_MANAGER_EXIT_1` 卡死。本仓库提供 `update.sh`，把「卸载 + 重装」自动化并保证前端补丁正确清理：

```bash
bash update.sh          # 更新 web profile
bash update.sh tui      # 更新指定 profile
```

脚本做的事：① 用**已安装版本自己的** `lib/uninstall.js` 还原前端补丁 → ② `dsh plugin remove` 摘旧包（同时解除实体目录冲突）→ ③ `dsh plugin add` 装最新版。跑完**手动重启 `dsh`**（或刷新页面）生效。

> 也可以手动两步走：先 `node <插件目录>/lib/uninstall.js`，再 `dsh plugin --profile web remove dsh-recall`，最后 `add` 新版。

## 撤回语义（与普通聊天撤回不同）

本插件的「撤回」不只是删一条气泡，而是**分支 + 文件回退**：

- **对话**：fork 一个新会话，从「被撤消息之前」开始，之前的对话保留，被撤消息及其之后的内容不在新会话里。原会话完整保留。
- **文件**：每轮开始前对工作区（会话 `cwd`）做快照；撤回时按快照还原被改的文件、删除本轮新增的文件。

适用场景：发了一条消息、AI 改了一堆文件，你后悔了，想「连话带文件一起回到这一轮之前」再重来。

## 注意事项

1. **撤回按钮通过补丁注入宿主前端**（`dsh-client-ui-chat/lib/client.js`），插件每次启动会自检补丁标记、被覆盖就自动补回；DSH 升级后按钮若消失，重启一次 DSH 即自动恢复。卸载请按上文两步走。
2. **撤回会动工作区文件**，请在意的目录上谨慎使用。
3. 若撤回的是会话里**唯一一条**用户消息，无法在保留内容的同时移除它（新分支会空白），此时只把原文与附件放回当前输入框，不创建分支。
4. 文件快照在 `$DSH_HOME/.recall-snapshots/`，单文件上限 8MB、单会话总计 512MB，超出从最旧轮次清理。
5. **插件自身目录受保护**：插件源码若装在工作区里（例如本机就在 `/sdcard/Zorrose-DSHA/日常/dsh-recall`），撤回时会主动跳过它，不会把插件自己的文件当成 AI 产物删掉。
6. **附件回填说明**：图片走会话自带的 `session.readAttachment`（带引用校验）；普通文件由主机侧只读路由 `/api/recall.attachment` 取回原始字节，再组装成 `File`。该路由挂在 connection 认证栅栏后，只接受本会话日志真实引用过的 `attachmentId`。

## 只对「撤回」生效，不影响框架自带「分支」

文件还原由前端撤回时**显式请求** `POST /api/recall.restore` 触发，主机侧不监听 `session/created`。

原因：框架「分支」和本插件「撤回」都走 `sessions.fork`，子会话都带 `header.parentSession`，主机侧无法从事件本身区分。靠它猜测会导致**点普通分支也回退文件**。现已改为显式请求。

## 已知限制

1. **超过 8MB 的文件不备份**，撤回时无法恢复其改动；但路径会登记进快照，**保证不被误删**。
2. 撤回是**一次性**的：还原后不保留「撤回的撤回」。
3. 撤回按钮出现在**最后一条用户消息**的动作条里、复制按钮左边（v2.1.0 起）。
   这一格官方没有插槽：宿主只给助手回复开了 `conversation.chat.assistant-actions`，
   用户消息侧的 actions 是 `UserStyleBubble` 里硬编码的。所以按钮用**浏览器 DOM 注入**实现——
   仍然不改磁盘上任何框架文件，插件被 `remove` 后宿主不再加载本模块，按钮随页面卸载消失。
   定位依赖 `[data-chat-flow-kind="user"]` 与动作条里的复制按钮，宿主大版本改结构时可能需要适配。

## 撤回按钮是怎么放进去的（给维护者）

宿主侧的事实（`dsh-client-ui-chat`）：

- 只有 `conversation.chat.assistant-actions` 这个 list 插槽对外开放，挂在轮末尾的助手回复上；
- 用户消息节点（`key: "user"`）注册时**没有声明 children**；
- `UserStyleBubble` 收到的 `actions` 是硬编码的 `MessageIconActions`，没有 `extraActions` 入口。

因此第三方插件**没有任何官方途径**把按钮放进用户消息动作条。v2.1.x 的做法：

1. `MutationObserver` 监听 `document.body`，React 每次重渲染都会被兜住；
2. 找到最后一个 `[data-chat-flow-kind="user"]` 行，在它内部找到带「复制」文案的按钮；
3. **直接复用那个复制按钮的 `className`**——宿主的 `.action` 来自 CSS Module，包含前景色
   `--dsw-alias-label-tertiary`、随 `--dsh-content-font-delta` 的 calc() 尺寸、hover 背景、
   `svg` 尺寸等整套规则，抄类名才能 100% 一致；用内联样式复刻必然出现颜色偏深、大小不一的偏差
   （v2.1.0 踩过，见下）；
4. 图标本身也按宿主图标规范做：`viewBox="0 0 16 16"` + `stroke-width="1"`
   （宿主 `dsh-client-ui-primitives` 的 outline 系列就是 1px 描边；用 24 网格 + 2px 描边会明显更黑更粗）；
5. 插入前先清掉页面里所有旧的本插件按钮，保证「只有最后一条消息带按钮」；
6. 幂等：已有按钮就只做保序移动，不重复插入。

失败即静默（认不出结构就不显示），绝不影响聊天本身。

> **v2.1.1 修的两个样式坑**（都是对着渲染图比对后改的，不是凭感觉）：
> ① 按钮用内联样式 → 颜色偏深、与复制按钮大小不统一；改为复用类名。
> ② 图标用 24 网格 + 2px 描边 → 显得又粗又黑；改为宿主同款 16 网格 + 1px 描边，
> 几何也放大到撑满网格，避免 15px 实际尺寸下偏小。
>
> **v2.1.2 修图标位置偏移**：把图标渲染成 512px 位图量包围盒，与宿主复制图标对齐。
> 修前垂直中心偏低 0.9 单位（看起来「偏下、不平行」），修后六项指标逐项重合：
>
> | 指标 | 复制图标 | 本图标 |
> |---|---|---|
> | 垂直中心 | 8.234 | **8.234** |
> | 水平中心 | 7.734 | **7.734** |
> | 垂直跨度 | 13.41 | **13.41** |
> | 水平跨度 | 13.47 | **13.47** |
> | 左边界 | 1.00 | **1.00** |
> | 右边界 | 14.47 | **14.47** |
>
> 期间还发现一个反直觉的坑：用 `scale()` 放大来对齐尺寸，**会把 `stroke-width` 一起放大**
> （1px→1.09px），描边反而变粗。所以最终**只做平移**，放大靠路径坐标本身实现。
>
> **v2.1.4 修「点撤回没反应/撤错会话」**：取当前会话 id 原来靠
> `sessions.list` 里 `retainedBy.mainView > 0` 猜——那是「主视图保留计数」，
> 多会话并存或列表快照滞后时会**猜错会话**（屏幕看 B 撤了 A）或**一个都猜不到**
> （点击静默无反应）。现在改读宿主视图容器自带的
> `[data-conversation-region="chat"][data-conversation-session]` 锚点，
> 它由宿主 React 树直接渲染，值就是屏幕上正在显示的会话 id。锚点消失时静默忽略。
>
> **v2.1.5 修 Android App 里「点了没反应、连确认框都没有」**：
> DSHA App 的 WebView 若没实现 WebChromeClient，`window.confirm` 要么不存在、
> 要么弹窗被吞且同步返回 `false`——旧代码把 `false` 一律当「用户取消」直接放弃，
> 于是点击看起来毫无反应（宿主日志无任何痕迹，实测复现）。现在：
> - `confirm` 正常返回 `true` → 照常撤回（桌面浏览器行为不变）；
> - `confirm` 不存在 → 直接撤回（无弹窗能力的环境宁撤勿卡）；
> - `confirm` 返回 `false` → **3 秒内再点一次撤回按钮 = 确认撤回**（双击确认），
>   第一次点击会 alert 提示这条规则。

## 开发：客户端半边的规范要点

浏览器半边必须满足（详见 DSH 官方 `docs/subsystems/slots.zh.md` 与 `packages/client/modules/README.zh.md`）：

1. **模块格式**：lazy-CJS factory，只向 `window.__ModuleLoader__` 登记 `{ id, factory }`，副作用全在 factory 闭包内。
2. **`id` 必须等于包名**（`dsh-recall`），否则宿主认不出这条 row。
3. **注册 list 槽位时 `id` 字段必填**（「cell 由必填 id 定址」）。缺了会在 `register()` 直接抛错，导致整个客户端模块加载失败、前端启动页报 `Failed to load plugins`。
4. **只能 require `PLATFORM_MODULES` 基线表里的模块**（`react`、`react/jsx-runtime` 等）；基线之外的模块请求必须在 `dsh.client.external` 声明。
5. `dsh.client.inject` 是**信息性**的包名依赖边，不决定激活顺序；真正的等待靠 `ctx.slots.inject()`。
6. **`jsx()` / `jsxs()` 的第三个参数是 `key`，不是 `children`**（签名：`type, props, key?`）。多个子元素**必须塞进 `props.children`**：

   ```js
   // ✅ 正确
   jsx.jsx("svg", { viewBox: "0 0 24 24", children: [jsx.jsx("path", {...}), jsx.jsx("path", {...})] })

   // ❌ 错误（v2.0.0 的 bug）：两个 path 被当成 key 丢掉，svg 渲染成空壳，
   //    按钮只剩自带的 minWidth/minHeight 占位，界面上表现为一块莫名的空白。
   jsx.jsxs("svg", { viewBox: "0 0 24 24" }, [path1, path2])
   ```

## 附件回填怎么实现的（给维护者）

撤回时前端只能从会话快照拿到附件**引用**，拿不到字节：

- **图片**：`session.readAttachment(id)`（会校验该图片确被本会话引用）。
- **普通文件**：前端没有 API 能读 `file` 块字节，由主机侧 `/api/recall.attachment` 从 `ctx.attachments.readFileStream(ref)` 流式读回。

拿回字节后走与「拖拽/选择文件」完全相同的通道：

```js
const drafts = conversation.createDrafts(sessionId, files)   // 图片有预览，普通文件自动后台上传
shell.addFiles([], drafts.map((d) => d.id))                  // 挂到输入框附件栏
```

## 目录结构

```
dsh-recall/
├── package.json           # dsh.bundle + dsh.client 双声
├── cordis.patch.yml       # bundle 挂载声明
├── README.md
└── lib/
    ├── index.js           # 主机半边：快照 + 文件还原 + 附件字节路由
    ├── client.js          # 浏览器半边：撤回按钮（官方插槽，不改写框架文件）
    ├── attachment-route.js # 附件读取路由 + 撤回还原路由
    └── snapshot-store.js  # 工作区文件快照 / 还原核心
```

## 许可

MIT
