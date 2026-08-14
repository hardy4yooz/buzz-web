# Buzz Web

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/hardy4yooz/buzz-web/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hardy4yooz/buzz-web/actions/workflows/ci.yml)

Buzz Web 是一个连接 [Buzz](https://github.com/block/buzz) Relay 的独立浏览器客户端。它
不打包、也不修改 Relay，即可在现代浏览器中提供频道、私聊、线程、Reaction、搜索、
媒体、Inbox、邀请、远程 Agent、在线状态和 NIP-34 仓库浏览等核心协作能力。

> [!IMPORTANT]
> 这是一个独立 Web 客户端，不是 Block 官方产品。使用前必须已有 Buzz Relay；本仓库
> 不包含 Relay、桌面客户端、移动客户端或 AI 模型。

## 当前能力

| 功能域 | 当前可用 | 主要限制 |
| --- | --- | --- |
| 身份 | NIP-07、加密多身份保险库、创建身份、编辑 Profile、`ncryptsec` 备份与恢复 | 本地私钥解锁后仍存在于页面内存，共享设备优先使用 NIP-07 |
| 消息 | 频道、私聊、线程、Reaction、@ 提及、搜索、上传、编辑/删除、隔离草稿、输入状态、在线状态和 NIP-RS 已读状态 | 写操作受 Relay 权限控制；加密同步已读状态要求签名器支持 NIP-44 |
| Inbox | 提及、私聊、线程回复、Workflow 审批、筛选和 Relay 同步的未读状态 | NIP-RS 前沿只能递增，因此手动标记未读仍保存在当前设备 |
| 成员 | 频道发现、收藏、静音/归档、成员目录、角色修改、移除成员、Relay 成员接入和限时邀请 | 成员及管理操作最终受 Relay 权限控制 |
| Agents | 发现远程 Agent、查看状态、管理频道权限、发起私聊、按配置启动服务 | 本机 Agent 创建和完整运行时配置仍属于桌面端能力 |
| Projects | 浏览 NIP-34 仓库公告、Refs、目录、文件、提交和 Clone 地址 | 暂不支持发布、Issue、PR、Review 和 Merge |

尚不可用的操作会直接隐藏，不展示无效占位按钮。后续计划及验收标准见
[ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。

## 架构

```text
浏览器
  |-- WSS：NIP-42 身份认证与事件 ----------> Buzz Relay
  |-- HTTPS：NIP-98 查询、邀请、媒体、Git -> Buzz Relay
  `-- HTTPS：签名的启动请求（可选） -------> Agent Control -> systemd
```

浏览器只是 Relay 客户端。Prompt、消息、仓库事件和 Agent 回复会按照所连接 Relay 的
策略存储。可选的 `agent-control` 只负责启动白名单内的 systemd unit，不接收 `nsec`、
模型凭据或 Agent 环境文件。

## 快速开始

需要 Node.js 24 和 npm。

```bash
cd web
npm ci
npm run dev
```

打开 `http://localhost:5173`。开发模板默认连接 `ws://localhost:3000`；Relay 使用其他地址时，
必须在 `web/public/config.json` 中明确设置 `relayUrl`：

```json
{
  "communityName": "Buzz",
  "relayUrl": "wss://buzz.example.com",
  "features": {
    "projects": false,
    "forum": false
  },
  "agents": []
}
```

`config.json` 在运行时获取，始终属于公开资源。不要在其中写入 `nsec`、Relay API token、
owner 私钥、模型凭据或私有服务地址。Agent 名称通常来自 Relay 成员关系和 kind `0`
Profile 事件；`agents` 只是在事件尚未到达时提供展示兜底，也可在配置 Agent Control 后
标记哪些已知 Agent 能被启动。

实验功能入口由 Relay 部署公开的 `features` 配置控制。即使配置暂时落后，Relay 中已经
存在 NIP-34 仓库公告或 Forum 频道时，对应内容仍可被发现。Buzz Desktop 的实验开关只
保存在该设备，Relay 不会同步这些开关，所以它不能直接控制 Web 端入口。

## 身份与数据安全

- NIP-07 将签名留在浏览器扩展中，在共享设备上应优先使用。
- 导入的 `nsec` 可以通过 PBKDF2 和 AES-GCM 加密后保存到 IndexedDB；解锁期间私钥仍会
  存在于页面主线程内存。
- 客户端不会把身份私钥发送给 Relay 或 Agent Control。
- 仓库 HTML 只有在用户主动点击后才运行，并放在不具备同源权限的 sandbox iframe 中；
  不得为该 sandbox 增加 `allow-same-origin`。
- 私有 Relay 仍必须正确配置成员和频道权限；公开 Web 静态资源本身不会让 Relay 数据
  自动变成公开数据。

漏洞报告和生产部署注意事项见 [SECURITY.md](SECURITY.md)。

## 国际化

界面读取浏览器第一偏好语言。中文 locale 使用简体中文，其他 locale 使用英文；日期和
相对时间也跟随当前语言。Relay 返回的消息、用户名、频道名、仓库内容和服务端错误详情
保持原始语言，不做机器翻译。

所有新增的界面文案，包括标签、placeholder、tooltip、空状态和错误信息，都必须通过
`web/src/shared/i18n/index.ts` 的 `t()` 输出，并同时提供 `en` 与 `zh-CN`。

## 验证

```bash
cd web
npm run typecheck
npm test
npm run check
npm run test:e2e

cd ../agent-control
npm ci
npm test
```

Playwright 除桌面和移动交互外，还会显式验证英文及简体中文浏览器 locale。

## 生产部署

[`deploy/`](deploy/README.md) 中的通用 Compose 栈会构建只读容器，在 `/app/` 下提供
页面，并暴露 `/app/healthz`。每个环境需要单独设置监听地址、端口和公开运行时配置：

```bash
docker compose -f deploy/compose.yml config
docker compose -f deploy/compose.yml build --pull
docker compose -f deploy/compose.yml up -d
```

相关运维文档：

- [Web 部署](deploy/README.md)
- [Relay 部署参考](docs/relay-deployment.zh-CN.md)
- [远程 Agent 接入](docs/remote-agent.zh-CN.md)
- [Agent Control 辅助服务](agent-control/README.md)

## 目录结构

```text
web/             React/Vite 浏览器客户端
agent-control/   可选的 NIP-98 保护 Agent 启动服务
deploy/          生产容器和反向代理示例
docs/            运维文档
```

业务功能位于 `web/src/features`，应用路由位于 `web/src/app`，协议、配置、通用 UI、
主题和国际化位于 `web/src/shared`。更详细的贡献约束见 [AGENTS.md](AGENTS.md) 和
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 上游与许可证

Buzz 协议行为、视觉资源和兼容客户端代码来源于
[block/buzz](https://github.com/block/buzz)。本仓库按 [Apache License 2.0](LICENSE)
发布，归属说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Apache 许可证不授予
任何商标权。
