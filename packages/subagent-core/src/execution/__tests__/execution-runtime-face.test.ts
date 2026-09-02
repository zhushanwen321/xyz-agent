// src/execution/__tests__/execution-runtime-face.test.ts
//
// U10① execution 运行时面导出形态测试 = 第三宿主最小构造示例（验收证据）。
//
// 示例语义（设计 docs/design/subagent-core-sink-design.md §3.3 D6 / §4 S5）：第三宿主
// 仅凭模块导出面（不看 core 内部实现）完成——
//   1. createSubagentService({cwd, modelService, ...}) 参数注入构造（无全局查找）；
//   2. record 状态查询面调用（SubagentService.lookupRecordAnyState 按 id 全态查询 +
//      RecordStore 按状态枚举 listRunning/collectRecords 与按 id findLightById/getFullRecord）；
//   3. 错误类型族 instanceof 分流。
//
// 构造先例同 subagent-service.test.ts：真实 ModelConfigService 指向 tmpdir 空目录
// （loadGlobalConfig 对不存在文件返回默认配置，AgentRegistry 空目录安全），不 mock
// service 内核；pi 仅在 initSession 场景以最小 duck-typed mock 注入。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MF-4：barrel 可达性用例的命名空间导入——「仅凭 src/index.ts 导入」的字面载体
//（不经深路径），证明第三宿主按文档用法可构造。
import * as subagentCore from "../../index.ts";
import { EngineError } from "../engine/common/errors.ts";
import { EngineNotFoundError } from "../engine/registry.ts";
import { ZcodePrepareError } from "../engine/engines/zcode/preparer.ts";
import { ZcodeReaderError } from "../engine/engines/zcode/reader.ts";
import { ZcodeTaskShapeError } from "../engine/engines/zcode/zcode-engine.ts";
import { ModelConfigService } from "../model-config-service.ts";
import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  toSubagentRecordEntry,
} from "../record-entry.ts";
import { RecordStore } from "../record-store.ts";
import { createSubagentService, getSubagentService } from "../subagent-service.ts";
import {
  DirtyWorktreeError,
  ForkDepthExceededError,
  ResurrectDeniedError,
} from "../types.ts";
import { GitRunError as WorktreeManagerGitRunError } from "../worktree-manager.ts";
import { GitRunError as WorktreeGitOpsGitRunError } from "../worktree-git-ops.ts";

// ── 工具：tmpdir agentDir + 真实 ModelConfigService（第三宿主自备的最小依赖集）──

function makeAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exec-runtime-face-"));
}

function makeModelService(agentDir: string): ModelConfigService {
  // cwd 为 ModelConfigServiceInit 必填键（与 agentDir 同指 tmp 目录；构造期仅消费 agentDir）
  return new ModelConfigService({ agentDir, cwd: agentDir });
}

/** 最小 PiLike duck-type（initSession 场景用；本文件不触发真实 pi 调用）。 */
function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

describe("execution 运行时面（U10① D6）", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeAgentDir();
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  // ============================================================
  // ① createSubagentService 工厂：参数注入构造（第三宿主最小构造示例主体）
  // ============================================================
  describe("createSubagentService 工厂（参数注入构造）", () => {
    it("仅凭参数注入构造成功，不读写全局单例槽位（无全局查找）", () => {
      // 前置：全局槽位为空（工厂与 getSubagentService/setSubagentService 单例流程解耦）
      expect(getSubagentService()).toBeNull();

      const service = createSubagentService({
        cwd: agentDir,
        modelService: makeModelService(agentDir),
      });

      // 构造产物可用（实例方法存在）且未被登记进全局单例槽位——
      // session_start 单例流程行为零改动，宿主自持实例。
      expect(typeof service.lookupRecordAnyState).toBe("function");
      expect(getSubagentService()).toBeNull();
    });

    it("构造后即可调用按 id 全态查询面：空 store 返回 undefined（未 initSession 按「不存在」处理）", () => {
      const service = createSubagentService({
        cwd: agentDir,
        modelService: makeModelService(agentDir),
      });

      // lookupRecordAnyState 契约：未初始化/disposed 时 assertReady 抛错 → 按「不存在」处理返回 undefined
      expect(service.lookupRecordAnyState("no-such-record")).toBeUndefined();
    });

    it("initSession（宿主注入最小 pi mock）后查询面同型可用", () => {
      const service = createSubagentService({
        cwd: agentDir,
        modelService: makeModelService(agentDir),
      });
      service.initSession({ pi: makePi(), sessionId: "s1" });

      expect(service.lookupRecordAnyState("no-such-record")).toBeUndefined();
      service.dispose();
    });
  });

  // ============================================================
  // ② record 状态查询面：按状态枚举 / 按 id（RecordStore 公共构造）
  // ============================================================
  describe("record 状态查询面（RecordStore）", () => {
    it("按状态枚举查询：空 store 下 listRunning 与 collectRecords 返回空数组", () => {
      const sessionsDir = path.join(agentDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const store = new RecordStore(sessionsDir);

      expect(store.listRunning()).toEqual([]);
      expect(store.collectRecords(10, "all", undefined)).toEqual([]);
      expect(store.collectRecords(10, "running", undefined)).toEqual([]);
    });

    it("按 id 查询：findLightById / getFullRecord / getMutable 对缺失 id 均返回 undefined", () => {
      const sessionsDir = path.join(agentDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const store = new RecordStore(sessionsDir);

      expect(store.findLightById("missing-id")).toBeUndefined();
      expect(store.getFullRecord("missing-id")).toBeUndefined();
      expect(store.getMutable("missing-id")).toBeUndefined();
    });
  });

  // ============================================================
  // ③ 错误类型族：instanceof 分流（导出形态 = 宿主可程序化判别）
  // ============================================================
  describe("错误类型族 instanceof", () => {
    it("EngineError：code 前缀 message + 结构化投影", () => {
      const err = new EngineError("model_not_available", "no provider", "pick another model");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EngineError);
      expect(err.message).toBe("model_not_available: no provider");
      expect(err.toStructured()).toEqual({
        code: "model_not_available",
        message: "model_not_available: no provider",
        recovery: "pick another model",
      });
    });

    it("EngineNotFoundError：携带 engineId / registered / source 供分流", () => {
      const err = new EngineNotFoundError("nope", ["pi", "zcode"], "agent.md");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EngineNotFoundError);
      expect(err.code).toBe("engine_not_found");
      expect(err.engineId).toBe("nope");
      expect(err.registered).toEqual(["pi", "zcode"]);
      expect(err.source).toBe("agent.md");
    });

    it("zcode 引擎错误族：ZcodePrepareError / ZcodeReaderError / ZcodeTaskShapeError", () => {
      const prepare = new ZcodePrepareError("model_not_available", "model gone");
      expect(prepare).toBeInstanceOf(Error);
      expect(prepare).toBeInstanceOf(ZcodePrepareError);
      expect(prepare.code).toBe("model_not_available");

      const reader = new ZcodeReaderError("db missing", "check journal");
      expect(reader).toBeInstanceOf(Error);
      expect(reader).toBeInstanceOf(ZcodeReaderError);

      // [U10①] 原 class 未导出（仅内部 throw），本断言钉住 export 补齐后宿主可 instanceof
      const shape = new ZcodeTaskShapeError("capability_unsupported", "no schema");
      expect(shape).toBeInstanceOf(Error);
      expect(shape).toBeInstanceOf(ZcodeTaskShapeError);
      expect(shape.code).toBe("capability_unsupported");
      expect(shape.name).toBe("ZcodeTaskShapeError");
    });

    it("执行守卫错误族：ResurrectDeniedError / ForkDepthExceededError / DirtyWorktreeError", () => {
      const resurrect = new ResurrectDeniedError();
      expect(resurrect).toBeInstanceOf(Error);
      expect(resurrect).toBeInstanceOf(ResurrectDeniedError);

      const forkDepth = new ForkDepthExceededError("depth > max");
      expect(forkDepth).toBeInstanceOf(Error);
      expect(forkDepth).toBeInstanceOf(ForkDepthExceededError);

      const dirty = new DirtyWorktreeError("uncommitted changes");
      expect(dirty).toBeInstanceOf(Error);
      expect(dirty).toBeInstanceOf(DirtyWorktreeError);
    });

    it("GitRunError 两处同名列（worktree-manager / worktree-git-ops）各自可 instanceof", () => {
      const fromManager = new WorktreeManagerGitRunError("git fail", { exitCode: 1 });
      expect(fromManager).toBeInstanceOf(Error);
      expect(fromManager).toBeInstanceOf(WorktreeManagerGitRunError);
      expect(fromManager).not.toBeInstanceOf(WorktreeGitOpsGitRunError);

      const fromGitOps = new WorktreeGitOpsGitRunError("git fail", { exitCode: 128 });
      expect(fromGitOps).toBeInstanceOf(Error);
      expect(fromGitOps).toBeInstanceOf(WorktreeGitOpsGitRunError);
      expect(fromGitOps).not.toBeInstanceOf(WorktreeManagerGitRunError);
    });
  });

  // ============================================================
  // ④ record-entry 自描述 entry 面（导出形态确认；投影逐字段等值由
  //    execution-record.test.ts 钉住，此处不重复）
  // ============================================================
  describe("record-entry 面", () => {
    it("SUBAGENT_RECORD_CUSTOM_TYPE 值契约：'subagent-record'", () => {
      expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe("subagent-record");
    });

    it("toSubagentRecordEntry 可达且对最小 SubagentRecord 投影出 v===1", () => {
      const entry = toSubagentRecordEntry({
        id: "r1",
        agent: "a.md",
        task: "t",
        slug: "s",
        status: "running",
        mode: "background",
        startedAt: 1,
        rootSessionId: undefined,
        parentRecordId: undefined,
        depth: 0,
        endedAt: undefined,
        turns: 0,
        totalTokens: 0,
        model: "m",
        thinkingLevel: undefined,
        eventLog: [],
        displayItems: [],
      });
      expect(entry.v).toBe(1);
      expect(entry.id).toBe("r1");
    });
  });

  // ============================================================
  // ⑤ barrel 可达性（MF-4）：仅凭 src/index.ts 导入完成第三宿主构造
  //    （SubagentServiceInit.modelService: ModelConfigService——构造依赖
  //    与 jsdoc 示例引用的访问器必须全部从 barrel 可达）
  // ============================================================
  describe("barrel 可达性（仅凭 src/index.ts 导入，MF-4）", () => {
    it("ModelConfigService / getModelConfigService / createSubagentService 从 barrel 可达并可构造", () => {
      // 符号面：类与访问器均为函数（导出存在性）
      expect(typeof subagentCore.ModelConfigService).toBe("function");
      expect(typeof subagentCore.getModelConfigService).toBe("function");

      // 进程单例槽位未被本文件写入（同 ① 的全局查找断言口径）
      expect(subagentCore.getModelConfigService()).toBeNull();

      // 运行时可达：仅凭 barrel 符号完成参数注入构造（ModelConfigServiceInit
      // = { cwd, agentDir }，指向 tmp 目录——loadGlobalConfig 对不存在文件
      // 返回默认配置，AgentRegistry 空目录安全，同文件头既有 stub 口径）
      const modelService = new subagentCore.ModelConfigService({ cwd: agentDir, agentDir });
      const service = subagentCore.createSubagentService({ cwd: agentDir, modelService });

      // 构造产物可用（实例方法存在），且不写进程单例槽位（第三宿主自持实例）
      expect(typeof service.lookupRecordAnyState).toBe("function");
      expect(subagentCore.getModelConfigService()).toBeNull();
    });
  });
});
