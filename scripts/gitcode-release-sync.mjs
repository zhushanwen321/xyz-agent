#!/usr/bin/env node
/**
 * GitCode Release 同步脚本（GitHub Releases → GitCode Release 镜像）
 *
 * 用法：
 *   探针（验证写路径）：node scripts/gitcode-release-sync.mjs probe [--large] [--no-repo]
 *     --large 追加一个 200MB 文件上传 + Range 探测，当场验证「单附件大小上限」
 *     --no-repo 跳过仓库镜像推送（只验证 Release 写路径）
 *   镜像仓库（分支 + tags 强推对齐 GitHub）：node scripts/gitcode-release-sync.mjs push-repo
 *   正式同步：node scripts/gitcode-release-sync.mjs sync <tag> <name> <notes-file> <artifacts-dir> [--prerelease]
 *     把 <artifacts-dir> 下所有文件同步到 GitCode 同 tag 的 Release（幂等：同名同大小跳过）；
 *     --prerelease 在 release 正文加测试版标注
 *
 * 环境变量（必填）：
 *   GITCODE_TOKEN  GitCode 私人令牌（GitHub Actions 中配置为 secret GITCODE_TOKEN）
 *   GITCODE_REPO   GitCode 仓库路径 owner/repo（GitHub Actions 中建议配置为 variable GITCODE_REPO）
 *
 * API 依据（2026-09 调研 docs.gitcode.com，写路径行为以本脚本探针实测为准）：
 *   - 基址 https://api.gitcode.com/api/v5，认证 header `Private-Token`
 *   - 创建  POST   /repos/{repo}/releases                body {tag_name, name, body}
 *   - 查询  GET    /repos/{repo}/releases/tags/{tag}
 *   - 上传  GET    /repos/{repo}/releases/{tag}/upload_url?file_name=x → PUT 到返回的预签名地址
 *   - 删除  DELETE /repos/{repo}/releases/{id}（tag 清理：DELETE /repos/{repo}/tags/{tag}，未验证）
 *   - 匿名下载 https://gitcode.com/{repo}/releases/download/{tag}/{file}（302 → CDN）
 *   - API 限流：实测 8 并发即 429 → 全程串行 + 每次调用间隔 1.5s
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';

const API_BASE = 'https://api.gitcode.com/api/v5';
const WEB_BASE = 'https://gitcode.com';
const CALL_PAUSE_MS = 1500;
const LARGE_PROBE_BYTES = 200 * 1024 * 1024;

const token = process.env.GITCODE_TOKEN;
const repo = process.env.GITCODE_REPO;

function die(msg) {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

if (!token) {
  die('缺少环境变量 GITCODE_TOKEN（GitCode 私人令牌）。'
    + '配置方式：GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret，'
    + 'Name 填 GITCODE_TOKEN；或本地验证时 export GITCODE_TOKEN=<令牌> 后重跑。');
}
if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
  die(`缺少或非法的环境变量 GITCODE_REPO="${repo ?? ''}"（应为 owner/repo，如 zhushanwen321/xyz-agent）。`
    + 'GitHub Actions 中配置为仓库 variable GITCODE_REPO；本地验证时 export GITCODE_REPO=<owner/repo>。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GitCode API 调用：串行限速 + 429/5xx 指数退避重试，返回 {status, ok, json, text} */
async function apiCall(method, pathOrUrl, { body, extraHeaders = {} } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      const headers = { 'Private-Token': token, ...extraHeaders };
      // URLSearchParams 由 fetch 自动设置 form content-type；Buffer 由调用方通过 extraHeaders 指定
      if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
        headers['Content-Type'] = 'application/json';
      }
      res = await fetch(url, { method, headers, body });
    } catch (e) {
      lastErr = e;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非JSON响应（如纯文本错误页）原样保留在 text */ }
    await sleep(CALL_PAUSE_MS);
    return { status: res.status, ok: res.ok, json, text };
  }
  die(`GitCode API 连续 3 次失败：${method} ${pathOrUrl}，最后错误：${lastErr}。`
    + '恢复：等 1 分钟后重跑（api.gitcode.com 有限流与偶发 5xx）；持续失败到 docs.gitcode.com 查 API 是否变更。');
}

/** 拿到 release（按 tag），不存在返回 null；其它错误直接终止 */
async function findReleaseByTag(tag) {
  const r = await apiCall('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.ok) return r.json;
  if (r.status === 404) return null;
  die(`查询 release ${tag} 失败（HTTP ${r.status}）：${r.text.slice(0, 400)}。`
    + `恢复：401/403 检查 GITCODE_TOKEN 是否有效、是否过期；404 且确认仓库存在则可能是权限不足。`);
}

/** 创建 release。GitCode 对 body 编码的行为未写明文档且实测 JSON 被 400 拒
 * （"Request body parsing error, please check if the header content-type"），
 * 故按 json → form → query 三种编码自动降级，成功形态打印进日志留档。 */
async function createRelease({ tag, name, body, prerelease = false }) {
  const payload = { tag_name: tag, name, body, prerelease: String(prerelease) };
  const formPairs = Object.entries(payload);
  let lastResp;
  for (const enc of ['json', 'form', 'query']) {
    let path = `/repos/${repo}/releases`;
    let reqBody;
    if (enc === 'json') {
      reqBody = JSON.stringify(payload);
    } else if (enc === 'form') {
      reqBody = new URLSearchParams(formPairs);
    } else {
      path += `?${new URLSearchParams(formPairs).toString()}`;
    }
    const r = await apiCall('POST', path, { body: reqBody });
    lastResp = r;
    if (r.ok) {
      if (enc !== 'json') console.log(`[info] createRelease: json 编码被拒，${enc} 编码成功（后续调用沿用）`);
      const created = r.json?.id ? r.json : await findReleaseByTag(tag);
      if (created) return created;
      die(`创建 release 返回 ${r.status} 但按 tag 回查不到，响应片段：${r.text.slice(0, 400)}`);
    }
    console.log(`[info] createRelease ${enc} 编码失败（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
    // 凭据/仓库问题是编码无关的，降级无意义，直接终止并给恢复动作
    if (r.status === 401 || r.status === 403) {
      die(`令牌无效或无写权限（HTTP ${r.status}）：${r.text.slice(0, 300)}。恢复：到 GitCode 个人设置检查私人令牌是否过期、是否授予目标仓库写权限`);
    }
    if (r.status === 404) {
      die(`仓库 ${repo} 不存在或不可见（HTTP 404）。恢复：核对 GitHub variable GITCODE_REPO 与 GitCode 仓库路径一致（含大小写），仓库已创建`);
    }
  }
  die(`创建 release 三种编码均失败，最后响应（HTTP ${lastResp.status}）：${lastResp.text.slice(0, 500)}。`
    + `恢复：到 docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-releases 核对接口契约后调整本脚本`);
}

/** release 的附件列表（字段名做了防御：GitCode 实测非 GitHub 的 assets.size 形态，
 * 探针观察到 size=-1 即字段名不匹配，候选覆盖 name/file_name/path × size/filesize） */
function assetList(releaseJson) {
  const assets = releaseJson?.assets ?? releaseJson?.attach_files ?? releaseJson?.attachFiles ?? [];
  return (Array.isArray(assets) ? assets : [])
    .map((a) => ({
      name: a.name ?? a.file_name ?? a.path ?? a.filename ?? '',
      size: Number(a.size ?? a.filesize ?? a.file_size ?? a.attach_size ?? -1),
    }))
    .filter((a) => a.name);
}

/** 取预签名上传地址并 PUT 上传单个文件；返回上传耗时 ms */
async function uploadAsset(tag, filePath, fileName) {
  const r = await apiCall('GET',
    `/repos/${repo}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(fileName)}`);
  if (!r.ok) {
    die(`获取附件上传地址失败（HTTP ${r.status}）：${r.text.slice(0, 500)}。`
      + `恢复：确认 release ${tag} 存在；持续失败核对 docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url 是否变更。`);
  }
  const uploadUrl = r.json?.upload_url || r.json?.url;
  if (!uploadUrl) {
    die(`upload_url 接口响应中无 upload_url/url 字段，原始响应：${r.text.slice(0, 500)}。`
      + 'GitCode API 形态可能已变化，按上方文档链接人工核对。');
  }
  const finalUrl = uploadUrl.startsWith('/') ? `https://api.gitcode.com${uploadUrl}` : uploadUrl;
  const headers = { ...(r.json?.headers || {}) };
  if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/octet-stream';

  const buf = readFileSync(filePath);
  const t0 = performance.now();
  const put = await fetch(finalUrl, { method: 'PUT', headers, body: buf });
  const elapsed = Math.round(performance.now() - t0);
  if (!put.ok) {
    const putText = await put.text().catch(() => '');
    die(`上传附件 ${fileName} 失败（HTTP ${put.status}）：${putText.slice(0, 500)}。`
      + `恢复：429/5xx 直接重跑（脚本幂等）；403 可能是预签名地址过期（脚本每次现取，重跑即可）。`);
  }
  return elapsed;
}

/** 匿名下载回读比对（走与终端用户相同的稳定直链） */
async function verifyAnonymousDownload(tag, fileName, expectedContent) {
  const url = `${WEB_BASE}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    return { ok: false, detail: `匿名下载 HTTP ${res.status}（${url}）——终端用户可能无法下载，需排查` };
  }
  const text = await res.text();
  if (expectedContent !== undefined && text !== expectedContent) {
    return { ok: false, detail: `下载内容与上传内容不一致（长度 ${text.length} vs ${expectedContent.length}）` };
  }
  return { ok: true, detail: `匿名下载成功（HTTP ${res.status}，${text.length} bytes）` };
}

/** Range 探测远端文件总大小（GitCode 禁 HEAD，用 GET Range 206） */
async function probeRemoteSize(tag, fileName) {
  const url = `${WEB_BASE}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow' });
  const range = res.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (res.status !== 206 || !Number.isFinite(total)) {
    return { ok: false, detail: `Range 探测异常（HTTP ${res.status}，content-range="${range}"）` };
  }
  return { ok: true, detail: `远端文件大小 ${total} bytes`, total };
}

async function deleteReleaseQuietly(releaseId, tag) {
  const r = await apiCall('DELETE', `/repos/${repo}/releases/${releaseId}`);
  if (!r.ok) {
    console.log(`[WARN] 删除探针 release 失败（HTTP ${r.status}），请手动到 ${WEB_BASE}/${repo}/releases 删除 "${tag}"`);
  }
  const t = await apiCall('DELETE', `/repos/${repo}/tags/${encodeURIComponent(tag)}`);
  if (!t.ok) {
    console.log(`[WARN] 删除探针 tag 失败（HTTP ${t.status}），请手动到 ${WEB_BASE}/${repo}/tags 删除 "${tag}"`);
  }
}

/* ── 仓库镜像：把 origin 分支 + 全部 tags 强推对齐到 GitCode ── */

/** GitCode https push 的认证格式官方未写明，按常见三种自动探测 */
function resolveGitcodeRemote() {
  const owner = repo.split('/')[0];
  const candidates = [
    `https://${owner}:${token}@gitcode.com/${repo}.git`,
    `https://oauth2:${token}@gitcode.com/${repo}.git`,
    `https://${token}@gitcode.com/${repo}.git`,
  ];
  for (const url of candidates) {
    try {
      execSync(`git ls-remote "${url}" HEAD`, { stdio: 'pipe', timeout: 60000 });
      return url;
    } catch { /* 试下一种认证格式 */ }
  }
  throw new Error(`GitCode 仓库 https 认证三种格式（user:token / oauth2:token / token）均失败。`
    + `恢复：确认令牌未过期、对 ${repo} 有写权限、仓库已创建且已解除镜像状态（镜像仓锁写）`);
}

/** 强推 origin 分支 + tags 到 GitCode（--prune 保证与 GitHub 完全一致，防 drift）。
 * 超时 30 分钟：GitHub runner（海外）→ GitCode（国内）实测上行约 0.8MB/s，
 * 首次全量（本仓 pack ≈ 490MB）需 10-20 分钟，仅首次；后续发布只推增量。 */
function pushRepoMirror() {
  const url = resolveGitcodeRemote();
  execSync('git remote remove gitcode-sync 2>/dev/null || true', { stdio: 'pipe', shell: '/bin/bash' });
  execSync(`git remote add gitcode-sync "${url}"`, { stdio: 'pipe' });
  try {
    execSync(
      'git push gitcode-sync --progress --force --prune "+refs/remotes/origin/*:refs/heads/*" "+refs/tags/*:refs/tags/*" 2>&1',
      { stdio: 'inherit', timeout: 1800000 },
    );
  } finally {
    execSync('git remote remove gitcode-sync 2>/dev/null || true', { stdio: 'pipe', shell: '/bin/bash' });
  }
  console.log('[push-repo] 仓库镜像完成：origin 全部分支 + tags 已对齐到 GitCode');
}

/* ── 模式一：探针 ─────────────────────────────────────────── */

async function runProbe({ large, skipRepo }) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` —— ${detail}` : ''}`);
  };

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tag = `sync-probe-${stamp}`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'gitcode-probe-'));
  const probeContent = randomBytes(4096).toString('hex');
  const smallFile = join(tmpDir, 'gitcode-probe.txt');
  writeFileSync(smallFile, probeContent);

  console.log(`GitCode 写路径探针：repo=${repo}，探针 tag=${tag}${large ? '（含 200MB 大文件验证）' : ''}${skipRepo ? '（跳过仓库镜像）' : ''}\n`);

  // 0. 仓库镜像（正式链路第一步：先推代码再同步附件）；git push 输出较慢属正常
  if (!skipRepo) {
    try {
      const t0 = performance.now();
      pushRepoMirror();
      record('镜像仓库（origin 分支 + tags 强推对齐）', true, `${(Math.round(performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      record('镜像仓库（origin 分支 + tags 强推对齐）', false, String(e.message || e).slice(0, 400));
    }
  }

  let release;
  try {
    release = await createRelease({
      tag,
      name: 'GitCode 同步探针（跑完自动清理）',
      body: 'gitcode-release-sync.mjs probe 自动创建，验证写路径后删除。',
    });
    record('创建 release（含不存在的 tag）', true, `release id=${release.id ?? '?'}`);
  } catch (e) {
    record('创建 release（含不存在的 tag）', false, e.message);
    process.exit(1);
  }

  // 1. 小文件上传 + API 侧确认在 assets 里
  const smallName = 'gitcode-probe.txt';
  let uploaded = false;
  try {
    const ms = await uploadAsset(tag, smallFile, smallName);
    await sleep(1000);
    const fresh = await findReleaseByTag(tag);
    const hit = assetList(fresh).find((a) => a.name === smallName);
    if (!hit) {
      record('上传 4KB 附件', false, `PUT 返回 ${ms}ms 成功但 release assets 列表中找不到该文件（原始 assets：${JSON.stringify(fresh?.assets ?? fresh).slice(0, 500)}）`);
    } else {
      uploaded = true;
      // 打印原始条目：定位 GitCode 真实字段名（sync 幂等的 size 匹配依赖它）
      const rawHit = (fresh?.assets ?? []).find((x) => JSON.stringify(x).includes(smallName));
      record('上传 4KB 附件', true, `PUT ${ms}ms，size=${hit.size}（原始条目：${JSON.stringify(rawHit ?? {}).slice(0, 300)}）`);
    }
  } catch (e) {
    record('上传 4KB 附件', false, e.message);
  }

  // 2. 匿名下载回读
  if (uploaded) {
    const v = await verifyAnonymousDownload(tag, smallName, probeContent);
    record('匿名（未登录）下载回读', v.ok, v.detail);
  }

  // 3. 大文件（可选）：200MB 上传 + Range 探测总大小
  if (large) {
    const bigName = 'gitcode-probe-200mb.bin';
    const bigFile = join(tmpDir, bigName);
    console.log(`生成 ${LARGE_PROBE_BYTES} bytes 测试文件…`);
    // 内容熵无要求（只验证传输与远端大小），用固定字节填充避免 200MB 随机数生成耗时
    writeFileSync(bigFile, Buffer.alloc(LARGE_PROBE_BYTES, 0x61));
    try {
      const ms = await uploadAsset(tag, bigFile, bigName);
      record(`上传 200MB 附件（验证单文件上限）`, true, `PUT ${ms}ms（${Math.round(LARGE_PROBE_BYTES / 1024 / (ms / 1000))} KB/s，GitHub runner → GitCode 上行方向）`);
      const p = await probeRemoteSize(tag, bigName);
      record('Range 探测 200MB 附件', p.ok, `${p.detail}${p.total === LARGE_PROBE_BYTES ? '（与上传大小一致）' : ''}`);
    } catch (e) {
      record('上传 200MB 附件（验证单文件上限）', false, `${e.message}——若为大小上限拒绝，说明 222MB 安装包不能直传 GitCode Release，需回退分卷或对象存储方案`);
    }
  }

  // 4. 清理
  deleteReleaseQuietly(release.id, tag);
  rmSync(tmpDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 探针结果：${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`} =====`);
  if (failed.length === 0) {
    console.log('写路径可用：下一步把 sync job 挂进 release.yml（正式同步复用本脚本的 sync 模式）。');
  } else {
    console.log('按各 FAIL 项的恢复指引处理后重跑探针。');
    process.exit(1);
  }
}

/* ── 模式二：正式同步 ─────────────────────────────────────── */

async function runSync({ tag, name, notesFile, artifactsDir, prerelease = false }) {
  // GitCode 的 prerelease 展示位（release_status 字段）行为未验证，用文本标注兜底
  const notes = notesFile ? readFileSync(notesFile, 'utf8') : '';
  const body = prerelease ? `【测试版 Pre-release】\n\n${notes}` : notes;
  let release = await findReleaseByTag(tag);
  if (!release) {
    release = await createRelease({ tag, name, body, prerelease });
    console.log(`[sync] 已创建 GitCode release：${WEB_BASE}/${repo}/releases/tag/${tag}`);
  } else {
    console.log(`[sync] GitCode release 已存在，复用（幂等补齐附件）`);
  }

  const existing = new Map(assetList(release).map((a) => [a.name, a.size]));
  const files = listFilesRecursive(artifactsDir);
  if (files.length === 0) die(`产物目录 ${artifactsDir} 下没有文件——检查构建产物路径是否正确`);

  let skipped = 0;
  for (const f of files) {
    const rel = f.slice(artifactsDir.length + 1);
    const size = statSync(f).size;
    if (existing.get(rel) === size) {
      skipped++;
      console.log(`[sync] 跳过（已存在同大小）：${rel}`);
      continue;
    }
    const ms = await uploadAsset(tag, f, rel);
    console.log(`[sync] 已上传：${rel}（${(size / 1048576).toFixed(1)}MB，${ms}ms）`);
  }
  console.log(`[sync] 完成：${files.length} 个文件（新传 ${files.length - skipped}，跳过 ${skipped}）。`);
  console.log(`[sync] 下载直链格式：${WEB_BASE}/${repo}/releases/download/${tag}/<文件名>`);
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/* ── 入口 ─────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'probe') {
  await runProbe({ large: argv.includes('--large'), skipRepo: argv.includes('--no-repo') });
} else if (cmd === 'push-repo') {
  try {
    pushRepoMirror();
  } catch (e) {
    die(String(e.message || e));
  }
} else if (cmd === 'sync') {
  const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
  const [tag, name, notesFile, artifactsDir] = pos;
  if (!tag || !name || !artifactsDir) {
    die('用法：node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file|空串> <artifacts-dir> [--prerelease]');
  }
  await runSync({
    tag, name, notesFile: notesFile || null, artifactsDir,
    prerelease: argv.includes('--prerelease'),
  });
} else {
  console.log(`用法：
  node scripts/gitcode-release-sync.mjs probe [--large] [--no-repo]
  node scripts/gitcode-release-sync.mjs push-repo
  node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file> <artifacts-dir> [--prerelease]
环境变量：GITCODE_TOKEN（必填）、GITCODE_REPO=owner/repo（必填）`);
  process.exit(cmd ? 1 : 0);
}
