# 远程化 Demos · remote

> 远程化功能的视觉原型。对应方案文档 [`docs/feature-map/2026-07-26-remote.md`](../../feature-map/2026-07-26-remote.md)。
> 设计 tokens 遵循 [`docs/page-design/design-tokens.md`](../design-tokens.md)（zcode 冷蓝暗色）。

## Demos

| # | 文件 | 场景 | 对应方案章节 |
|---|---|---|---|
| 01 | [01-server-bootstrap.html](01-server-bootstrap.html) | **服务端首启输出**：三种网络拓扑（Tailscale / 局域网 / 公网反代）下的终端输出，含 APP deep link / URL+Token 文本 / QR 码三种引导字符串 | §6.3 服务端首启输出 |
| 02 | [02-client-connect.html](02-client-connect.html) | **客户端连接入口**：桌面 APP 欢迎屏（剪贴板探测）/ Web 粘贴框 / 手机 APP 三条路径（扫码 / 微信转发 / deep link） | §6.4 客户端粘贴连接流程 |
| 03 | [03-mobile-shell.html](03-mobile-shell.html) | **手机端主界面**：桌面三栏 vs 移动布局对比，含移动 shell（抽屉 + 底部 tab + composer + presence 设备列表） | §4.3 客户端代码复用 + §8.3 移动 renderer |
| 04 | [04-remote-connect-entry.html](04-remote-connect-entry.html) | **桌面 APP 远程连接入口**：directory popover 的「远程连接」动作（v1 stub 实化）→ modal（粘贴/手动/已保存三 tab）→ 连接成功 | §6.4 客户端连接流程（桌面 APP 路径） |

## 查看方式

浏览器直接打开 HTML 文件即可。三个 demo 都是纯静态，无依赖。

```bash
# macOS 快速打开
open docs/page-design/remote/01-server-bootstrap.html
open docs/page-design/remote/02-client-connect.html
open docs/page-design/remote/03-mobile-shell.html
```

## 设计要点

### 连接字符串（Bootstrap URL）
统一用自定义 scheme `xyz-agent://connect?url=<WS_URL>&token=<TOKEN>`。三种分发形态：
- **APP deep link**：PC/Mac APP 点击/粘贴唤起（Electron `setAsDefaultProtocolClient`）
- **纯文本 URL+Token**：Web 网页端粘贴、微信转发、手抄
- **QR 码**：手机 APP 扫码（内容 = deep link）

### 客户端配置最小集
**URL + token 两项**，不暴露反代/TLS 细节。反代是服务器侧的事，对客户端透明。

### 移动布局核心差异
- 桌面 sidebar 常驻 → 移动收进抽屉（汉堡菜单唤起）
- 桌面 nav 左栏 → 移动底部 tab
- 砍 TrafficLight / 安全区 / BrowserPane drawer / 全局快捷键
- 共享 xyz-ui 组件库 + 业务逻辑（stores/api/composables 非桌面部分）

## 待高保真校准

- [ ] tokens 中标注「补全」的项（accent-soft color-mix 等）在实际渲染下的表现
- [ ] 手机 frame 尺寸（当前 300×600，真机比例需调整）
- [ ] QR 码图案是示意，真实场景用 runtime 生成的 QR
- [ ] presence 设备列表的图标和文案
