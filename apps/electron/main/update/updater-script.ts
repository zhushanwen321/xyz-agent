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
 * - mac 脚本：xattr -cr 清 quarantine（未签名发布场景：CI 产物本就未签名，无需
 *   ad-hoc 重签名；xattr 清 quarantine 已足够绕过 Gatekeeper）。删除原 codesign 段
 *   的理由：(1) 本项目是未签名/ad-hoc 签名发布，CI 产物本就无 Developer ID，重签
 *   无意义；(2) `--deep` 在 macOS 13+ 已弃用；(3) xattr -cr 已清 quarantine。
 * - mac 脚本：所有命令守卫 + 失败写 update-result.json status='failed' + 退出非 0
 * - mac 脚本：pgrep 用 {{APP_BUNDLE}}（精确 .app 路径）+ grep -v 排除脚本自身 PID，
 *   避免 pgrep -f "{{APP_NAME}}" 误匹配 detached 脚本自身（脚本路径含 xyz-agent 子串），
 *   导致 || break 永不触发、循环跑满 30s。
 * - linux 脚本：detached 等 app 退出（pgrep 用精确 {{APP_IMAGE_PATH}} + 排除自身 PID）
 *   → sha256 二次校验 + .old 预恢复（与 mac 一致）→ mv 旧 AppImage 到 .old（备份，非
 *   unlink）→ mv 新到位 → mv 失败回滚 .old → chmod 755 → spawn 重启
 * - 占位符用 {{...}} 双花括号（避免 bash ${} 冲突）
 * - 所有注入到双引号上下文的值经 shellEscapeDoubleQuote 转义（防 shell 注入：
 *   路径/版本号若含 `"`、`` ` ``、`$`、`\` 会破坏引号配对或注入命令）
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
  /** app 进程名（日志用，如 'xyz-agent'） */
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
  /** 64 位 hex sha256（verify-before-replace 用，与 mac 一致） */
  sha256: string
  /** 日志输出路径 */
  logPath: string
  /** update-result.json 路径 */
  resultPath: string
  /** 目标版本号 */
  targetVersion: string
}

/**
 * Shell 转义：把值安全地注入 bash 双引号上下文。
 *
 * 双引号上下文里 `$`、`` ` ``、`\`、`"` 是危险字符（前两个触发命令/变量展开，
 * `\` 是转义符，`"` 闭合引号），需反斜杠转义。其它字符（含空格、`;`、`&`、`<`、
 * `>`、`|`、`'`）在双引号内为字面量，无需处理。
 *
 * 防御对象：路径 / 版本号 / sha256 等来自外部（manifest/用户环境）的值若被污染
 * （如版本号 `0.9.0"; rm -rf ~ #`），原 replace 会破坏脚本结构 → 注入任意命令。
 * sha256 虽已被 release-checker 的 `/^[0-9a-f]{64}$/i` 校验，但为 defense-in-depth
 * 一并转义（hex 无危险字符，转义为 no-op，无害）。
 */
function shellEscapeDoubleQuote(s: string): string {
  return s.replace(/[\\$`"]/g, '\\$&')
}

/**
 * 生成 mac updater bash 脚本。
 *
 * 流程：等 app 退出（pgrep 精确匹配 .app 路径 + 排除自身 PID）→ sha256 校验
 *       → 回滚决策树（rm 半截 + .old 优先恢复 + 正常备份）→ unzip
 *       → 失败回滚 .old → xattr 清 quarantine → 清理 .old → 写 result.json
 *       status='done' → open -n 重启
 */
export function buildUpdaterScript(vars: UpdaterScriptVars): string {
  const { appBundle, zipPath, sha256, logPath, resultPath, appName, targetVersion } = vars
  // 全部经 shellEscapeDoubleQuote 转义：模板里这些值都注入到 bash 双引号上下文，
  // 防止路径/版本号含危险字符（" ` $ \）导致引号破坏或命令注入。
  return MAC_UPDATER_TEMPLATE
    .replace(/\{\{APP_BUNDLE\}\}/g, shellEscapeDoubleQuote(appBundle))
    .replace(/\{\{ZIP_PATH\}\}/g, shellEscapeDoubleQuote(zipPath))
    .replace(/\{\{SHA256\}\}/g, shellEscapeDoubleQuote(sha256))
    .replace(/\{\{LOG_PATH\}\}/g, shellEscapeDoubleQuote(logPath))
    .replace(/\{\{RESULT_PATH\}\}/g, shellEscapeDoubleQuote(resultPath))
    .replace(/\{\{APP_NAME\}\}/g, shellEscapeDoubleQuote(appName))
    .replace(/\{\{TARGET_VERSION\}\}/g, shellEscapeDoubleQuote(targetVersion))
}

/**
 * 生成 linux AppImage updater bash 脚本（detached）。
 *
 * 流程：等 app 退出（pgrep 精确匹配 AppImage 路径 + 排除自身 PID）→ sha256 校验
 *       → 回滚决策树（rm 半截 + .old 优先恢复 + 正常备份）→ mv 旧 AppImage 到 .old
 *       （备份，替代 unlink）→ mv 新到位 → mv 失败则回滚 .old → chmod 755
 *       → 写 result.json → spawn 新 AppImage 重启
 *
 * [HISTORICAL] mv 而非 unlink：避免 mv 新文件失败（跨设备/ENOSPC/EACCES）时用户
 * 处于"无 app"状态。备份回滚决策树与 mac 脚本语义一致（rm 半截 → mv .old 优先恢复）。
 */
export function buildLinuxUpdaterScript(vars: LinuxUpdaterScriptVars): string {
  const { appImagePath, newFilePath, sha256, logPath, resultPath, targetVersion } = vars
  return LINUX_UPDATER_TEMPLATE
    .replace(/\{\{APP_IMAGE_PATH\}\}/g, shellEscapeDoubleQuote(appImagePath))
    .replace(/\{\{NEW_FILE_PATH\}\}/g, shellEscapeDoubleQuote(newFilePath))
    .replace(/\{\{SHA256\}\}/g, shellEscapeDoubleQuote(sha256))
    .replace(/\{\{LOG_PATH\}\}/g, shellEscapeDoubleQuote(logPath))
    .replace(/\{\{RESULT_PATH\}\}/g, shellEscapeDoubleQuote(resultPath))
    .replace(/\{\{TARGET_VERSION\}\}/g, shellEscapeDoubleQuote(targetVersion))
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
// pgrep 用 APP_BUNDLE 精确路径 + grep -v "^$$\$" 排除脚本自身 PID：
//   原 pgrep -f "{{APP_NAME}}"（"xyz-agent"）会命中 detached 脚本自身进程（其命令行
//   `bash /Users/<u>/.xyz-agent/update/updater.sh` 含 "xyz-agent" 子串），导致 || break
//   永不触发、循环跑满 30s。改用 {{APP_BUNDLE}}（/Applications/xyz-agent.app）后，
//   脚本命令行不含该路径，不再自匹配；grep -v "^$$\$"（$$=脚本自身 PID）做兜底。
const MAC_UPDATER_TEMPLATE = `#!/bin/bash
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[$(date)] start update to {{TARGET_VERSION}}"

# 1. 等 app 退出（pgrep 轮询，最多 30s）
# 用 {{APP_BUNDLE}} 精确匹配 .app 路径（避免 "xyz-agent" 子串误匹配 detached 脚本自身）；
# grep -v "^$$\$" 排除脚本自身 PID（$$=当前 shell PID），防止脚本进程被自己命中。
for i in $(seq 1 60); do
  pgrep -f "{{APP_BUNDLE}}" | grep -v "^$$\\$" > /dev/null || break
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

# 4. 清 quarantine（未签名发布场景：xattr -cr 清 com.apple.quarantine 即可绕过
#    Gatekeeper；无需 codesign 重签名——CI 产物本就未签名，ad-hoc 重签无意义且
#    --deep 在 macOS 13+ 已弃用。command -v 守卫，缺工具不崩。）
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "{{APP_BUNDLE}}"
fi

# 5. 清理 + 写成功标记
rm -rf "{{APP_BUNDLE}}.old"
echo '{"status":"done","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'"}' > "{{RESULT_PATH}}"

# 6. 重启
echo "[$(date)] update done, restarting"
open -n "{{APP_BUNDLE}}"
`

// ── linux updater 脚本模板（detached，避免双实例）──────────────────
// 关键：sha256 二次校验 + rm-then-mv 回滚决策树（与 mac 一致）+ mv 旧 AppImage 到
// .old（备份，非 unlink）+ mv 新文件失败时回滚 .old，避免 mv 失败（跨设备/ENOSPC/
// EACCES）导致用户处于无 app 状态。
// pgrep 用 {{APP_IMAGE_PATH}} 精确路径 + grep -v "^$$\$" 排除脚本自身 PID（理由同 mac）：
//   原硬编码 pgrep -f "xyz-agent" 会命中 detached 脚本自身进程（其命令行
//   `bash /home/<u>/.xyz-agent/update/updater-linux.sh` 含 "xyz-agent" 子串），
//   导致 || break 永不触发、循环跑满 30s。
const LINUX_UPDATER_TEMPLATE = `#!/bin/bash
set -uo pipefail
exec > "{{LOG_PATH}}" 2>&1
echo "[$(date)] start AppImage update to {{TARGET_VERSION}}"

# 等 app 退出（pgrep 轮询，最多 30s）
# 用 {{APP_IMAGE_PATH}} 精确匹配 AppImage 路径（避免 "xyz-agent" 子串误匹配 detached
# 脚本自身）；grep -v "^$$\$" 排除脚本自身 PID（$$=当前 shell PID），防止自匹配。
for i in $(seq 1 60); do
  pgrep -f "{{APP_IMAGE_PATH}}" | grep -v "^$$\\$" > /dev/null || break
  sleep 0.5
done
sleep 1

# sha256 校验（verify-before-replace，与 mac 一致；防下载后篡改/损坏）
ACTUAL=$(sha256sum "{{NEW_FILE_PATH}}" | awk '{print $1}')
if [ "$ACTUAL" != "{{SHA256}}" ]; then
  echo "[$(date)] ROLLBACK: sha mismatch"
  echo '{"status":"failed","version":"{{TARGET_VERSION}}","at":"'"$(date -u +%FT%TZ)"'","error":"sha mismatch"}' > "{{RESULT_PATH}}"
  exit 1
fi

# .old 预恢复（与 mac 一致）：若上次升级中断留下「半截 AppImage + .old」，先 rm 半截
# 再 mv .old 回来，回到上次稳定状态，再进入本次正常备份替换流程。
if [ -f "{{APP_IMAGE_PATH}}" ] && [ -f "{{APP_IMAGE_PATH}}.old" ]; then
  rm -f "{{APP_IMAGE_PATH}}"
  mv "{{APP_IMAGE_PATH}}.old" "{{APP_IMAGE_PATH}}"
  echo "[$(date)] restored from .old (previous interrupted)"
fi

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
