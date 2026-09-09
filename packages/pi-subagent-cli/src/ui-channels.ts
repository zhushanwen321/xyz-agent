// src/ui-channels.ts
//
// UI channel 提取（marker 解析）——W7 随 ui-request-queue 迁 pi 包（impl-plan
// §2.7 MF-X2：通道解析属 pi extension extension_ui_request 载荷域；core 侧副本
// 过渡期保留服务壳侧消费方，W11 收口核对）。
//
// channel 是扩展协议自定义的业务路由标识，由 NUL 前缀 marker 标记：
//   - ASK_USER_MARKER   = "\0XYZ_ASK_USER"     走 select method，出现在 title
//     （options[0] = JSON payload {questions, allowCancel}）
//   - GUI_WIDGET_MARKER = "\0XYZ_GUI_WIDGET:"  走 setWidget method，出现在 widgetLines[0]
//     （同行 marker 后紧跟 JSON payload {component}）
//
// 本文件是 core src/execution/ui-channels.ts 的逐字等价副本（纯函数，无 core 依赖）。

/** NUL 前缀字符。Pi extension-protocol 用 NUL（\0）标记控制行，
 *  避免与用户可见文本冲突。 */
const NUL = "\0";

/** channel 提取结果。channel 无 NUL 前缀、字段缺失、JSON parse 失败时
 *  channel 与 channelPayload 均为 undefined（返回 {}）。 */
export interface ParsedChannel {
  /** 规范化后的 channel 名（如 "ask_user"、"gui_widget"）。
   *  无 marker 或解析失败时为 undefined。 */
  channel?: string;
  /** marker 标记的结构化 payload（已 JSON.parse）。
   *  ask_user: {questions, allowCancel}；gui_widget: {component}。
   *  payload 来源缺失或 JSON parse 失败时为 undefined（channel 仍可解析）。 */
  channelPayload?: unknown;
}

/** parseChannel 入参的最小形状。
 *  method 是判别字段；按 method 不同，对应字段（select 的 title/options、
 *  setWidget 的 widgetLines）可选出现。其他 method 的字段统称 [key:string]。 */
export interface ExtensionUiRequestLike {
  method: string;
  /** select method：title 字段（可能含 ASK_USER_MARKER NUL 前缀）。 */
  title?: string;
  /** select method：options 数组（options[0] 可能是 channel payload 的 JSON）。 */
  options?: string[];
  /** setWidget method：widgetKey 字段。 */
  widgetKey?: string;
  /** setWidget method：widgetLines 数组（widgetLines[0] 可能含 GUI_WIDGET_MARKER）。 */
  widgetLines?: string[] | undefined;
  /** 其他 method 的任意字段（容错：允许测试和未来扩展传入额外字段）。 */
  [key: string]: unknown;
}

/** channel handler 签名：接收 UiRequest，返回 UiResponse。 */
export type ChannelHandler = (req: unknown) => Promise<unknown>;

/** channel 注册表接口。职责单一：只管业务路由，不管排队、不管透传判定。 */
export interface UiChannelRegistry {
  register(channel: string, handler: ChannelHandler): void;
  resolve(channel: string): ChannelHandler | undefined;
  list(): string[];
}

/** 规范化 channel 名。
 *    1. 去 "XYZ_" 命名空间前缀（协议命名空间标识，非业务语义）
 *    2. 去尾部 ":"（GUI_WIDGET 等"行内 payload"型 marker 的分隔符）
 *    3. 小写化（XYZ_ASK_USER → ask_user） */
function normalizeChannelName(markerLiteral: string): string {
  let name = markerLiteral;
  if (name.startsWith("XYZ_")) {
    name = name.slice("XYZ_".length);
  }
  if (name.endsWith(":")) {
    name = name.slice(0, -1);
  }
  return name.toLowerCase();
}

/** 从 marker 字面量字符串解析 channel 名。
 *  输入 str 形如 "\0XYZ_ASK_USER"（marker 占满整个字段，payload 在别处）。
 *  无 NUL 前缀返回 undefined。 */
function parseMarkerFromField(str: string): string | undefined {
  if (!str.startsWith(NUL)) return undefined;
  const literal = str.slice(NUL.length);
  if (literal === "") return undefined;
  return normalizeChannelName(literal);
}

/** 从 marker + 行内 payload 字符串解析 channel 名 + payload。
 *  输入 str 形如 "\0XYZ_GUI_WIDGET:{...json...}"。无 NUL 前缀返回 undefined。 */
function parseInlineMarkerFromField(str: string): { channel: string } | undefined {
  if (!str.startsWith(NUL)) return undefined;
  const rest = str.slice(NUL.length);
  const colonIdx = rest.indexOf(":");
  let literal: string;
  if (colonIdx >= 0) {
    literal = rest.slice(0, colonIdx + 1); // 含 ":"，normalizeChannelName 会去尾部 ":"
  } else {
    literal = rest;
  }
  if (literal === "") return undefined;
  return { channel: normalizeChannelName(literal) };
}

/** 从 select.title 解析 channel（payload 从 options[0] 取）。 */
function parseFromMarkerString(
  title: string | undefined,
  options: string[] | undefined,
): ParsedChannel {
  if (title === undefined) return {};
  const channel = parseMarkerFromField(title);
  if (channel === undefined) return {};
  let payload: unknown;
  if (options !== undefined && options.length > 0) {
    try {
      payload = JSON.parse(options[0]);
    } catch {
      payload = undefined; // JSON parse 失败：不抛，channel 仍解析
    }
  }
  return { channel, channelPayload: payload };
}

/** 从 setWidget.widgetLines[0] 解析 channel（payload 从同行 marker 后取）。 */
function parseFromMarkerArray(
  widgetLines: string[] | undefined,
): ParsedChannel {
  if (widgetLines === undefined || widgetLines.length === 0) return {};
  const firstLine = widgetLines[0];
  if (typeof firstLine !== "string") return {};
  const parsed = parseInlineMarkerFromField(firstLine);
  if (parsed === undefined) return {};
  let payload: unknown;
  const rest = firstLine.slice(NUL.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx >= 0) {
    const jsonStr = rest.slice(colonIdx + 1);
    if (jsonStr !== "") {
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        payload = undefined;
      }
    }
  }
  return { channel: parsed.channel, channelPayload: payload };
}

/** 按 method 分派解析 channel（边界均不抛错）。 */
export function parseChannel(req: ExtensionUiRequestLike): ParsedChannel {
  switch (req.method) {
    case "select":
      return parseFromMarkerString(req.title, req.options);
    case "setWidget":
      return parseFromMarkerArray(req.widgetLines);
    default:
      return {};
  }
}

/** 创建 channel 注册表实例（进程级单例形态，由宿主侧持有）。 */
export function createUiChannelRegistry(): UiChannelRegistry {
  const handlers = new Map<string, ChannelHandler>();
  return {
    register(channel: string, handler: ChannelHandler): void {
      handlers.set(channel, handler);
    },
    resolve(channel: string): ChannelHandler | undefined {
      return handlers.get(channel);
    },
    list(): string[] {
      return Array.from(handlers.keys());
    },
  };
}
