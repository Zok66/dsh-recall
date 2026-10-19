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

## 卸载（一条命令，无需清理）

```bash
dsh plugin --profile web remove dsh-recall
```

本插件是 DSH 官方的**双面包**（dual-face package）：撤回按钮是正规的浏览器端插件模块（`lib/client.js`），由宿主按 `package.json` 的 `dsh.client` 声明加载。`remove` 之后宿主不再加载这个包，**按钮自然消失**。

> v1.x 靠正则改写 `dsh-client-ui-chat/lib/client.js` 来注入按钮，卸载后会残留、还得手动跑还原脚本。那套做法已彻底删除。

顺带清掉快照（可选，目录 `~/.dsh/.recall-snapshots/`）：

```bash
rm -rf ~/.dsh/.recall-snapshots
```

## 撤回语义（与普通聊天撤回不同）

本插件的「撤回」不只是删一条气泡，而是**分支 + 文件回退**：

- **对话**：fork 一个新会话，从「被撤消息之前」开始，之前的对话保留，被撤消息及其之后的内容不在新会话里。原会话完整保留。
- **文件**：每轮开始前对工作区（会话 `cwd`）做快照；撤回时按快照还原被改的文件、删除本轮新增的文件。

适用场景：发了一条消息、AI 改了一堆文件，你后悔了，想「连话带文件一起回到这一轮之前」再重来。

## 注意事项

1. **不改写任何框架文件。** 撤回按钮是正规浏览器端插件模块，经 `dsh.client` 声明由宿主加载；DSH 升级/重装不会丢失，卸载自动消失。
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

## 开发：客户端半边的规范要点

浏览器半边必须满足（详见 DSH 官方 `docs/subsystems/slots.zh.md` 与 `packages/client/modules/README.zh.md`）：

1. **模块格式**：lazy-CJS factory，只向 `window.__ModuleLoader__` 登记 `{ id, factory }`，副作用全在 factory 闭包内。
2. **`id` 必须等于包名**（`dsh-recall`），否则宿主认不出这条 row。
3. **注册 list 槽位时 `id` 字段必填**（「cell 由必填 id 定址」）。缺了会在 `register()` 直接抛错，导致整个客户端模块加载失败、前端启动页报 `Failed to load plugins`。
4. **只能 require `PLATFORM_MODULES` 基线表里的模块**（`react`、`react/jsx-runtime` 等）；基线之外的模块请求必须在 `dsh.client.external` 声明。
5. `dsh.client.inject` 是**信息性**的包名依赖边，不决定激活顺序；真正的等待靠 `ctx.slots.inject()`。
6. `jsx()` 只接受单个 child，多个 child 要用 `jsxs()` + 数组。

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
