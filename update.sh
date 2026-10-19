#!/usr/bin/env bash
# update.sh — dsh-recall 一键更新脚本
#
# 为什么「检查更新」会卡死（PLUGIN_MANAGER_EXIT_1）：
#   DSH 目前没有插件原地更新能力，官方提示是「卸载 + 重装」。
#   而插件管理器在目标包已被 pnpm 落成「实体目录」时，会直接 exit 1 拒绝导入，
#   用户在 App 内又无法解除这个冲突，于是更新永远停在旧版本。
#
# 本脚本就是把「卸载 + 重装」自动化，并保证前端补丁被正确清理：
#   ① 用「已安装版本自己的 uninstall.js」还原前端补丁（v8→v9 升级时，
#      旧版用旧规则还原、新版用新规则重打，顺序不能反）；
#   ② dsh plugin remove 摘掉旧包（这一步同时解除实体目录冲突）；
#   ③ dsh plugin add 装最新版。
#
# 用法：
#   bash update.sh            # 更新 web profile
#   bash update.sh tui        # 更新指定 profile（默认 web）

set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="${DSH_HOME}/profiles/${PROFILE}/node_modules/dsh-recall"
GIT_URL="https://github.com/Zok66/dsh-recall"

command -v dsh >/dev/null 2>&1 || {
  echo "[recall-update] 未找到 dsh 命令，请确认 DSH 已安装并加入 PATH。" >&2
  exit 1
}

echo "[recall-update] 目标 profile: ${PROFILE}"

# ① 若已安装，先用「旧版自己的 uninstall.js」还原前端补丁
if [ -f "${PLUGIN_DIR}/lib/uninstall.js" ]; then
  echo "[recall-update] 检测到已安装版本，正在清理前端补丁…"
  if (cd "${PLUGIN_DIR}" && node lib/uninstall.js); then
    echo "[recall-update] 前端补丁已还原。"
  else
    echo "[recall-update] ⚠ 前端还原未完成（可能缺 .orig-recall 备份或备份与当前前端不匹配）。"
    echo "[recall-update]   继续更新；新版启动时自带升级自愈，若仍有残留按钮请手动重装 DSH。"
  fi
else
  echo "[recall-update] 未找到已安装目录（或首次安装），跳过前端清理。"
fi

# ② 摘掉旧插件（这步同时解除「实体目录」冲突，必须成功）
echo "[recall-update] 移除旧版本…"
if ! dsh plugin --profile "${PROFILE}" remove dsh-recall; then
  echo "[recall-update] ✗ remove 失败，为避免再次撞上实体目录冲突，中止更新。" >&2
  echo "[recall-update]   请手动检查: ${PLUGIN_DIR} 是否仍存在，并在终端执行上面的 remove 命令排查。" >&2
  exit 1
fi

# ③ 安装最新版
echo "[recall-update] 安装最新版…"
dsh plugin --profile "${PROFILE}" add "${GIT_URL}"

echo
echo "[recall-update] ✅ 更新完成。"
echo "[recall-update] 请手动重启 dsh ${PROFILE}（或刷新页面）让前端重新加载。"
