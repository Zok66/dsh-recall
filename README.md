# dsh-recall

DSH 的「撤回」插件：只撤**最后一条用户消息**，把对话与工作区文件一起回退到这一轮开始前，并生成一个新的干净分支会话。

## 功能

- 最后一条用户消息的动作条上会出现一个回旋箭头「撤回」按钮。
- 点击后弹窗确认，然后：
  1. 生成一个**不含这条消息及之后内容**的新分支会话，原文与附件回到新会话输入框，可改动后重发。
  2. 工作区里这一轮被 AI 改动过的文件**还原**、本轮新增的文件**删除**（基于每轮开始前的快照）。
  3. **原会话保留**在会话列表中可回看，不会被删除。
- 只允许撤最后一条用户消息；更早的消息用框架自带的「分支」。
- 撤回按钮**即时跟随**最后一条消息：发出新消息后自动移挂，无需重进会话刷新。

## 安装

```bash
dsh plugin --profile web add https://github.com/Zok66/dsh-recall
```

装完**手动重启 `dsh web`**（或刷新页面）即生效。

确认方式：`grep -i recall ~/.dsh/dsh-web.log | tail`，看到 `[recall] 已启用…`、`[recall] 附件读取路由已注册…` 等字样即成功。

## 更新

DSH 目前没有插件原地更新能力，「检查更新」会报 `PLUGIN_MANAGER_EXIT_1` 卡死。更新请直接**卸载重装**：

```bash
node <插件目录>/lib/uninstall.js           # ① 还原前端补丁
dsh plugin --profile web remove dsh-recall  # ② 摘掉旧插件
dsh plugin --profile web add https://github.com/Zok66/dsh-recall  # ③ 装最新版
```

跑完**手动重启 `dsh web`**（或刷新页面）生效。

> `<插件目录>` 一般是 `~/.dsh/profiles/web/node_modules/dsh-recall`；其他 profile 把 `web` 换成对应名字。

## 卸载

```bash
node <插件目录>/lib/uninstall.js           # ① 还原前端补丁（移除撤回按钮）
dsh plugin --profile web remove dsh-recall  # ② 摘掉插件本身
```

撤回按钮通过**改写 `dsh-client-ui-chat/lib/client.js`** 注入，`remove` 不会自动还原被改的前端文件，所以**必须先跑 ①**。`uninstall.js` 会先校验「备份 + 补丁 = 当前文件」才还原，防 DSH 升级后用旧备份降级前端；还原前另存当前版本，可反悔。支持 `--status` / `--dry-run`。

顺带清掉快照（可选）：`rm -rf ~/.dsh/.recall-snapshots`

## 撤回语义

本插件的「撤回」是**分支 + 文件回退**：

- **对话**：fork 一个新会话，从「被撤消息之前」开始，之前的对话保留；被撤消息及之后内容不在新会话里，原会话完整保留。
- **文件**：每轮开始前对工作区做快照，撤回时按快照还原被改文件、删除本轮新增文件。

适用场景：发了一条消息、AI 改了一堆文件，后悔了，想「连话带文件一起回到这一轮之前」再重来。

文件还原只在点「撤回」按钮时触发，框架自带的「分支」不会回退文件。

## 注意事项

1. 撤回会动工作区文件，请在意的目录上谨慎使用。
2. 撤回是**一次性**的：还原后不保留「撤回的撤回」。
3. 超过 8MB 的文件不备份、无法恢复改动，但路径会登记进快照，保证不被误删。
4. 文件快照在 `$DSH_HOME/.recall-snapshots/`，单文件上限 8MB、单会话总计 512MB，超出从最旧轮次清理。
5. 撤回按钮通过补丁注入宿主前端，插件每次启动会自检补丁标记、被覆盖就自动补回；DSH 升级后按钮若消失，重启一次 DSH 即自动恢复。
6. 插件自身目录受保护：撤回时不会把插件自己的文件当成 AI 产物删掉。
7. 若撤回的是会话里**唯一一条**用户消息，无法在保留内容的同时移除它（新分支会空白），此时只把原文与附件放回当前输入框，不创建分支。

## 实现原理（给维护者）

撤回按钮通过 `client-patch.js` **改写宿主前端 `dsh-client-ui-chat/lib/client.js`** 注入到用户消息动作条——这是被实测证明「点击一定有效」的方案。原因是宿主只给**助手回复**开放了 `conversation.chat.assistant-actions` 插槽，用户消息侧没有官方入口；v2.0~v2.1 尝试的官方插槽（位置在 AI 回复下）与 DOM 注入（App WebView 里点击无反应）都被否决，最终回到补丁方案。

代价是补丁改动框架文件，因此：

- 插件每次启动自检补丁标记（`@@DSH_RECALL_PATCH_v9@@`），被 DSH 的「环境安装与修复」覆盖后会自动补回；
- 卸载前必须跑 `lib/uninstall.js`，用 `.orig-recall` 基线还原前端（带校验防降级）。

附件回填走两条通道：图片用会话自带 `session.readAttachment`；普通文件由主机侧路由 `/api/recall.attachment` 流式读回字节后组装成 `File` 放回输入框。文件还原由撤回时显式 `POST /api/recall.restore` 触发，与框架「分支」共用 `sessions.fork` 但通过显式端点区分，避免点普通分支误回退文件。

## 目录结构

```
dsh-recall/
├── package.json            # 插件元信息 + dsh.bundle 声明
├── cordis.patch.yml        # bundle 挂载声明
├── README.md
└── lib/
    ├── index.js            # 主机入口：补丁自愈 + 快照 + 撤回还原
    ├── client-patch.js     # 前端补丁注入（改写 client.js 加撤回按钮）
    ├── attachment-route.js # 附件读取 + 撤回还原 + 自检路由
    ├── snapshot-store.js   # 工作区文件快照 / 还原核心
    └── uninstall.js        # 卸载时还原前端补丁
```

## 许可

MIT
