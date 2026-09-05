#!/usr/bin/env node
/**
 * GitCode Release 同步脚本（GitHub Releases → GitCode Release 镜像）
 *
 * 用法：
 *   探针（验证写路径）：node scripts/gitcode-release-sync.mjs probe [--large]
 *     --large 追加一个 200MB 文件上传 + Range 探测，当场验证「单附件大小上限」
 *   正式同步：node scripts/gitcode-release-sync.mjs sync <tag> <name> <notes-file> <artifacts-dir>
 *     把 <artifacts-dir> 下所有文件同步到 GitCode 同 tag 的 Release（幂等：同名同大小跳过）
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
      if (body !== undefined && !Buffer.isBuffer(body)) headers['Content-Type'] = 'application/json';
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

/** 创建 release；tag 不存在时的行为未经验证，失败时输出原始错误供定位 */
async function createRelease({ tag, name, body, prerelease = false }) {
  const payload = { tag_name: tag, name, body, prerelease };
  const r = await apiCall('POST', `/repos/${repo}/releases`, { body: payload });
  if (!r.ok) {
    die(`创建 release 失败（HTTP ${r.status}）：${r.text.slice(0, 600)}\n`
      + `常见原因：① 仓库 ${repo} 不存在或令牌无写权限 → 确认 GitCode 上已建仓库且令牌未过期；`
      + `② 平台要求 tag 先存在 → 在 GitCode 网页端给仓库建 tag "${tag}"（或先导入 GitHub 仓库让 tag 随代码同步过去）后重跑。`);
  }
  const created = r.json?.id
    ? r.json
    : await findReleaseByTag(tag); // 响应无 id 时回查确认创建成功
  if (!created) {
    die(`创建 release 返回 ${r.status} 但按 tag 回查不到，响应片段：${r.text.slice(0, 400)}`);
  }
  return created;
}

/** release 的附件列表（字段名做了防御：name / file_name / path 任一形态） */
function assetList(releaseJson) {
  const assets = releaseJson?.assets ?? releaseJson?.attach_files ?? releaseJson?.attachFiles ?? [];
  return (Array.isArray(assets) ? assets : [])
    .map((a) => ({
      name: a.name ?? a.file_name ?? a.path ?? '',
      size: Number(a.size ?? a.file_size ?? -1),
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

/* ── 模式一：探针 ─────────────────────────────────────────── */

async function runProbe({ large }) {
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

  console.log(`GitCode 写路径探针：repo=${repo}，探针 tag=${tag}${large ? '（含 200MB 大文件验证）' : ''}\n`);

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
      record('上传 4KB 附件', false, `PUT 返回 ${ms}ms 成功但 release assets 列表中找不到该文件（响应字段名可能不同，原始 assets：${JSON.stringify(assetList(fresh))}）`);
    } else {
      uploaded = true;
      record('上传 4KB 附件', true, `PUT ${ms}ms，assets 确认 size=${hit.size}`);
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

async function runSync({ tag, name, notesFile, artifactsDir }) {
  const body = notesFile ? readFileSync(notesFile, 'utf8') : '';
  let release = await findReleaseByTag(tag);
  if (!release) {
    release = await createRelease({ tag, name, body });
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
  await runProbe({ large: argv.includes('--large') });
} else if (cmd === 'sync') {
  const [, tag, name, notesFile, artifactsDir] = argv;
  if (!tag || !name || !artifactsDir) {
    die('用法：node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file|空串> <artifacts-dir>');
  }
  await runSync({ tag, name, notesFile: notesFile || null, artifactsDir });
} else {
  console.log(`用法：
  node scripts/gitcode-release-sync.mjs probe [--large]
  node scripts/gitcode-release-sync.mjs sync <tag> <release-name> <notes-file> <artifacts-dir>
环境变量：GITCODE_TOKEN（必填）、GITCODE_REPO=owner/repo（必填）`);
  process.exit(cmd ? 1 : 0);
}
