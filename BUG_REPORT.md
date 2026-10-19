# Bug Report：dsh-recall 检查更新失败（PLUGIN_MANAGER_EXIT_1）

> 本报告面向 DSHA / DSH 插件管理器的开发者，也供本插件仓库作者开 issue 时直接粘贴使用。

## 摘要

用户（非作者侧）已安装 `dsh-recall` 2.2.0，在 DSHA App 内点「检查更新」更新到 2.3.1 时失败。
预览阶段能正常拉到最新版，但「预览 → 安装」环节被插件管理器以 exit 1 拒绝，报错如下，导致已装版本始终停留在 2.2.0，且 App 内无法自行解除。

```
操作失败：PLUGIN_MANAGER_EXIT_1: exit=1 timedOut=false truncated=false
output=RUNTIME_LINKS_CACHED: 共享依赖未变化，复用已检查链接
PLUGIN_RESULT: {"status": "error",
  "message": "dsh-recall 已由 pnpm 安装为实体目录，请先在终端移除该依赖再导入"}
```

## 结论（根因）

**这是插件管理器「更新」状态机的 bug，不是 dsh-recall 插件本身的问题。** 具体死锁链：

1. 「检查更新」走「预览 → 安装」流程，预览目录成功拉到 2.3.1（网络与源均正常）；
2. 安装环节插件管理器对 profile 执行 `pnpm add https://github.com/Zok66/dsh-recall`，而 dsh-recall 在 profile 里已被 pnpm 落成「实体目录」形态；
3. 管理器的导入/链接逻辑检测到「该包已由 pnpm 安装为实体目录」，判定冲突，直接 exit 1 拒绝继续；
4. 因此依赖解析被跳过，预览目录 `.dsha-dependencies.json` 里的 `managerVersion` 被写成 `not-executed`，安装中止；
5. 弹窗只提供「重试安装 / 关闭 / 清理临时包」，没有一个动作能解除第 3 步的实体目录冲突，用户点「重试」只会重复第 2~3 步，形成死循环。

## 已复现的事实（带证据）

| 项 | 证据 |
|---|---|
| 预览正常拉到 2.3.1 | `/root/.dsh/plugin-previews/<id>/contents/dsh-recall-269d3f6e17f6ba3a5f8157d5ebdddecc7182223a/`，commit `269d3f6` |
| 安装失败 | 操作日志 `operation-8RqrbS` 的 `pnpm add 'https://github.com/Zok66/dsh-recall'`，exit 1 |
| 依赖解析被跳过 | 预览目录 `.dsha-dependencies.json`：`"state": "no-dependencies"`、`"managerVersion": "not-executed"`、`"resolved": []` |
| App 弹窗报错 | 见上方「摘要」原文 |

## 请开发者确认 / 修复的点

1. 「检查更新」的安装分支，在目标包已以 pnpm 实体目录存在时，为何直接 exit 1 拒绝，而不是先移除旧实体目录再装新版本——这是更新流程卡死的直接原因。
2. 弹窗提示「请先在终端移除该依赖再导入」，但普通用户在 App 内没有终端入口，无法自行完成，请提供 App 内可操作的解除冲突动作。
3. 对「会改写 DSH 框架文件」型插件（如 dsh-recall），卸载流程应强制执行插件的 `lib/uninstall.js`，否则旧补丁标记（v8）会残留并与新版本（v9）冲突。

## 用户侧临时解法（bug 修复前）

```bash
cd ~/.dsh/profiles/web && pnpm remove dsh-recall
dsh plugin --profile web add https://github.com/Zok66/dsh-recall
# 重启 web profile 生效
```

装完若前端有异常残留，检查并重建补丁基线：

```bash
grep -c "@@DSH_RECALL_PATCH" /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js
```

若命中且无 `.orig-recall` 基线，重装一次插件让 2.3.1 的自愈逻辑重建基线即可。
