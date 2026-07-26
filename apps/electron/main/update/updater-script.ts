/**
 * 升级 bash 脚本生成器（纯函数，无副作用）。
 *
 * 对应 slice auto-update-and-install w3：生成 mac/linux detached bash 脚本字符串，
 * 由 platform-updater 写到磁盘 + chmod 755 + spawn detached 执行。
 *
 * 纯函数设计：输入变量对象 → 输出脚本字符串。便于单元测试（断言关键片段 +
 * 占位符全替换无 {{ 残留）。
 *
 * [HISTORICAL] 关键不变量（守护脚本正确性）：
 * - mac 脚本：sha256 二次校验（verify-before-replace）+ rm-then-mv 回滚决策树
 *   （先 rm 半截 .app → 若有 .old 优先恢复 → 正常备份 mv .old → unzip 失败回滚 .old）
 * - mac 脚本：xattr -cr 清 quarantine + codesign 重签名（command -v 守卫，缺失工具不崩）
 * - mac 脚本：所有命令守卫 + 失败写 update-result.json status='failed' + 退出非 0
 * - linux 脚本：detached 等 app 退出 → mv 旧 AppImage 到 .old（备份，非 unlink）→
 *   mv 新到位 → mv 失败回滚 .old → chmod 755 → spawn 重启（与 mac 一致的备份回滚语义）
 * - 占位符用 {{...}} 双花括号（避免 bash ${} 冲突）
 *
 * 依赖方向：updater-script → 无外部依赖（纯字符串拼接）
 */

/** mac updater 脚本的变量替换入参 */
export interface UpdaterScriptVars {
  /** app bundle 路径（如 /Applications/xyz-agent.app） */
  appBundle: string
  /** 下载的 zip 路径 */
  zipPath: string
  /** 64 位 hex sha256（verify-before-replace 用） */
  sha256: string
  /** 日志输出路径 */
  logPath: string
  /** update-result.json 路径（跨进程状态 SSOT） */
  resultPath: string
  /** app 进程名（pgrep 轮询用，如 'xyz-agent'） */
  appName: string
  /** 目标版本号（写日志 + result） */
  targetVersion: string
}

/** linux updater 脚本的变量替换入参 */
export interface LinuxUpdaterScriptVars {
  /** 当前 AppImage 路径（process.env.APPIMAGE） */
  appImagePath: string
  /** 下载的新 AppImage 文件路径 */
  newFilePath: string
  /** 日志输出路径 */
  logPath: string
  /** update-result.json 路径 */
  resultPath: string
  /** 目标版本号 */
  targetVersion: string
}

/**
 * 生成 mac updater bash 脚本。
 *
 * 流程：等 app 退出 → sha256 校验 → 回滚决策树（rm 半截 + .old 优先恢复 + 正常备份）
 *       → unzip → 失败回滚 .old → xattr 清 quarantine + codesign 重签名
 *       → 清理 .old → 写 result.json status='done' → open -n 重启
 */
export function buildUpdaterScript(vars: UpdaterScriptVars): string {
  const { appBundle, zipPath, sha256, logPath, resultPath, appName, targetVersion } = vars
  return MAC_UPDATER_TEMPLATE
    .replace(/\{\{APP_BUNDLE\}\}/g, appBundle)
    .replace(/\{\{ZIP_PATH\}\}/g, zipPath)
    .replace(/\{\{SHA256\}\}/g, sha256)
    .replace(/\{\{LOG_PATH\}\}/g, logPath)
    .replace(/\{\{RESULT_PATH\}\}/g, resultPath)
    .replace(/\{\{APP_NAME\}\}/g, appName)
    .replace(/\{\{TARGET_VERSION\}\}/g, targetVersion)
}

/**
 * 生成 linux AppImage updater bash 脚本（detached）。
 *
 * 流程：等 app 退出 → mv 旧 AppImage 到 .old（备份，替代 unlink）→ mv 新到位
 *       → mv 失败则回滚 .old → chmod 755 → 写 result.json → spawn 新 AppImage 重启
 *
 * [HISTORICAL] mv 而非 unlink：避免 mv 新文件失败（跨设备/ENOSPC/EACCES）时用户
 * 处于"无 app"状态。备份回滚决策树与 mac 脚本语义一致（rm 半截 → mv .old 优先恢复）。
 */
export function buildLinuxUpdaterScript(vars: LinuxUpdaterScriptVars): string {
  const { appImagePath, newFilePath, logPath, resultPath, targetVersion } = vars
  return LINUX_UPDATER_TEMPLATE
    .replace(/\{\{APP_IMAGE_PATH\}\}/g, appImagePath)
    .replace(/\{\{NEW_FILE_PATH\}\}/g, newFilePath)
    .replace(/\{\{LOG_PATH\}\}/g, logPath)
    .replace(/\{\{RESULT_PATH\}\}/g, resultPath)
    .replace(/\{\{TARGET_VERSION\}\}/g, targetVersion)
}

/**
 * 生成 win NSIS 安装器静默安装参数。
 *
 * - /S：静默安装（无 GUI，绕过 UAC）
 * - --updated：标记是升级流程（electron-builder NSIS 自定义）
 * - /D=<installDir>：指定安装目录（NSIS 约定，必须放最后，无引号）
 */
export function buildWinInstallerArgs(installDir: string): string[] {
  return ['/S', '--updated', `/D=${installDir}`]
}

// ── mac updater 脚本模板 ──────────────────────────────────────────
// 关键：rm-then-mv 回滚决策树（先 rm 半截态 → .old 优先恢复 → 正常备份）。
// sha256 二次校验（download-asset 已校验过，这里 detached 脚本独立再校验一次防篡改/损坏）。
const MAC_UPDATER_TEMPLATE = `#!/bin/bash
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[$(date)] start update to {{TARGET_VERSION}}"

# 1. 等 app 退出（pgrep 轮询，最多 30s）
for i in $(seq 1 60); do
  pgrep -f "{{APP_NAME}}" > /dev/null || break
  sleep 0.5
done
sleep 1

# 2. sha256 校验（verify-before-replace）
ACTUAL=$(shasum -a 256 "{{ZIP_PATH}}" | awk '{print $1}')
if [ "$ACTUAL" != "{{SHA256}}" ]; then
  echo "[$(date)] ROLLBACK: sha mismatch"
  echo '{"status":"failed","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'","error":"sha mismatch"}' > "{{RESULT_PATH}}"
  exit 1
fi

# 3. 备份 + 替换（回滚决策树：先 rm 半截，再 mv .old）
if [ -d "{{APP_BUNDLE}}" ] && [ -d "{{APP_BUNDLE}}.old" ]; then
  rm -rf "{{APP_BUNDLE}}"
  mv "{{APP_BUNDLE}}.old" "{{APP_BUNDLE}}"
  echo "[$(date)] restored from .old (previous interrupted)"
fi

# 正常备份（仅当无 .old 时）
if [ -d "{{APP_BUNDLE}}" ]; then
  mv "{{APP_BUNDLE}}" "{{APP_BUNDLE}}.old" 2>/dev/null || true
fi

# 解压
unzip -o "{{ZIP_PATH}}" -d "$(dirname "{{APP_BUNDLE}}")"
if [ ! -d "{{APP_BUNDLE}}" ]; then
  # unzip 失败，回滚
  rm -rf "{{APP_BUNDLE}}"
  if [ -d "{{APP_BUNDLE}}.old" ]; then
    mv "{{APP_BUNDLE}}.old" "{{APP_BUNDLE}}"
  fi
  echo "[$(date)] ROLLBACK: unzip failed"
  echo '{"status":"failed","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'","error":"unzip failed"}' > "{{RESULT_PATH}}"
  exit 1
fi

# 4. 清 quarantine + 重签名（command -v 守卫，缺工具不崩）
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "{{APP_BUNDLE}}"
fi
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "{{APP_BUNDLE}}" 2>/dev/null || true
fi

# 5. 清理 + 写成功标记
rm -rf "{{APP_BUNDLE}}.old"
echo '{"status":"done","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'"}' > "{{RESULT_PATH}}"

# 6. 重启
echo "[$(date)] update done, restarting"
open -n "{{APP_BUNDLE}}"
`

// ── linux updater 脚本模板（detached，避免双实例）──────────────────
// 关键：mv 旧 AppImage 到 .old（备份，非 unlink）+ mv 新文件失败时回滚 .old，
// 避免 mv 失败（跨设备/ENOSPC/EACCES）导致用户处于无 app 状态。
const LINUX_UPDATER_TEMPLATE = `#!/bin/bash
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[$(date)] start AppImage update to {{TARGET_VERSION}}"

# 等 app 退出（pgrep 轮询，最多 30s）
for i in $(seq 1 60); do
  pgrep -f "xyz-agent" >/dev/null || break
  sleep 0.5
done
sleep 1

# 备份旧 AppImage（不 unlink，改 mv 到 .old；失败不致命，无旧文件时跳过）
mv "{{APP_IMAGE_PATH}}" "{{APP_IMAGE_PATH}}.old" 2>/dev/null || true

# mv 新 AppImage 到位（失败则回滚 .old，确保用户不处于无 app 状态）
if ! mv "{{NEW_FILE_PATH}}" "{{APP_IMAGE_PATH}}"; then
  # mv 失败，回滚备份
  if [ -f "{{APP_IMAGE_PATH}}.old" ]; then
    mv "{{APP_IMAGE_PATH}}.old" "{{APP_IMAGE_PATH}}"
  fi
  echo "[$(date)] ROLLBACK: mv new AppImage failed"
  echo '{"status":"failed","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'","error":"mv failed"}' > "{{RESULT_PATH}}"
  exit 1
fi

chmod 755 "{{APP_IMAGE_PATH}}"
rm -f "{{APP_IMAGE_PATH}}.old"

echo '{"status":"done","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'"}' > "{{RESULT_PATH}}"
echo "[$(date)] update done, restarting"

# spawn 重启（detached，& 放后台）
"{{APP_IMAGE_PATH}}" &
`
