/**
 * Workflow Extension — WorkflowScript 实体
 *
 * 一个 workflow 脚本文件的数据 + 操作收敛（domain-models.md §7）。
 *
 * 设计：
 * - 将"脚本源 + meta + validate + toExecutable"收敛为实体。
 * - validate 委托 engine/script-lint.ts 的 lintScript。
 * - toExecutable 只做 strip `export const meta`（纯文本变换）；worker 线程 wrap
 * （注入 agent/parallel/pipeline globals）由 infra/worker-script-builder.ts
 * 的 buildWorkerScript 承担——那是技术资源模板生成，不属于实体职责（D-12：
 * 模型只管数据+不变式）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §7（字段/操作）、engine/script-lint.ts（lint 实现）。
 */
import { type LintResult,lintScript } from "../script-lint.ts";
// LintFinding/LintResult 类型规范归属 engine/script-lint.ts（canonical 源）。

// WorkflowMeta 规范来源是 shared/resource-meta.ts（m1 DM1，含 parameters/usage/when/notFor）。
// m2：删本地封闭 3 字段 interface，re-export m1 的判别联合。
import type { WorkflowMeta } from "../../shared/resource-meta.ts";
export type { WorkflowMeta };

/** 脚本来源：saved（.pi/workflows/ 固定）或 tmp（.pi/workflows/.tmp/ 临时）。 */
export type WorkflowSource = "saved" | "tmp";

/**
 * WorkflowScript 实体。
 *
 * 不变式：
 * - name 非空（meta 提取成功时来自 meta.name，失败时来自文件名 stem）
 * - available=false 时 meta 为空壳（name=stem, description="", phases=[]）
 * - sourceCode 为原始文件内容（含 export）；toExecutable 返回 strip 后的副本
 */
export class WorkflowScript {
  readonly name: string;
  readonly source: WorkflowSource;
  readonly path: string;
 /** 原始文件内容（可编辑）。toExecutable 返回 strip 后的副本，不改本字段。 */
  sourceCode: string;
  readonly meta: WorkflowMeta;
 /** false 当 meta 提取失败（loader 不抛错，标记不可用但仍列出）。 */
  available: boolean;

  constructor(opts: {
    name: string;
    source: WorkflowSource;
    path: string;
    sourceCode: string;
    meta: WorkflowMeta;
    available: boolean;
  }) {
    this.name = opts.name;
    this.source = opts.source;
    this.path = opts.path;
    this.sourceCode = opts.sourceCode;
    this.meta = opts.meta;
    this.available = opts.available;
  }

 /**
 * 静态检查脚本合法性。
 *
 * 委托 engine/script-lint.ts 的 lintScript——检查项含：
 * - 必须含 agent/parallel/pipeline 入口之一
 * - agent 选项 outputSchema → schema
 * - result.output/parsedOutput/content 不存在
 * - 文件传状态警告
 */
  validate(): LintResult {
    return lintScript(this.sourceCode);
  }

 /**
 * 返回可执行源。
 *
 * m2：不再 strip `export const meta`——meta 现为 @pi-meta 块注释（合法 JS，
 * worker 天然忽略），无 const meta 变量。toExecutable 返回原文（含块注释）。
 * Worker 线程 wrap（注入 globals）由 infra/worker-script-builder.ts buildWorkerScript 完成。
 */
  toExecutable(): string {
    return this.sourceCode;
  }
}
