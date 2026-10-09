# Agent 实时观察活动

[English](agent-observer-activity.md) | [简体中文](agent-observer-activity.zh-CN.md)

Buzz Web 可以显示兼容 Buzz Agent Runtime 发出的实时执行状态。这是一个只读 Relay 功能：
它不会增加 Agent 控制服务、启动进程或持久保存活动记录。

## Relay 协议

兼容 Runtime 会发布临时 Nostr kind `24200` 事件，并带有以下 Tag：

- `p`：已认证 Owner 的公钥
- `agent`：发出事件的 Agent 公钥
- `frame`：`telemetry`

事件签名公钥必须与 `agent` Tag 一致。事件内容使用 NIP-44 从 Agent 加密给 Owner，并包含
一个观察帧或批量 Envelope。帧包含 `seq`、`timestamp`、`kind`、可选的 `channelId`、
`sessionId` 和 `turnId`，以及协议定义的 Payload。

完成 NIP-42 认证后，Web 客户端会为 kind `24200` 保持一个持久订阅，并将 `#p` 设为当前
Owner 公钥。客户端先验证 Tag 和签名身份，再在本地解密内容。当 NIP-07 或导入的本地
Signer 支持 NIP-44 Peer 解密时，两者都可以使用。

## 频道与身份边界

Relay 订阅按 Owner 隔离，界面还会进一步限制为当前频道中的 Agent。只有带明确频道 id 的
帧，或其 Agent 与 Turn/Session 已通过频道帧建立关联时，才会显示。无法关联的帧会被丢弃，
不会展示到所有频道。

其他 Relay 成员无法解密这些活动，除非他们使用同一个 Owner 身份。共享 Owner 身份的人也
共享该身份的解密能力，因此部署仍应为不同成员使用独立身份。

## 展示与保留

紧凑状态会区分工作中、思考中、使用工具、回复中、安静、正在重新连接和已断开。安静仅表示
没有观察到新帧，并不代表 Agent 已确定卡住。

Activity 面板采用保守的语义白名单：仅展示生命周期状态、工具名称，以及存在时的有界 Shell
命令。已知凭据格式和绝对路径会被脱敏。原始工具输出、消息/思考内容、任意工具参数和协议
JSON 均不会渲染。即使 Runtime 自身也执行脱敏，客户端仍必须保留这一边界。

浏览器内存最多保留最新 120 个活动帧，并限制单个事件明文大小和批量帧数。观察 Payload 不会写入 IndexedDB、localStorage、
分析系统、日志或其他服务。面板宽度偏好可以保存，但其中不包含观察数据。不支持 NIP-44 的
Signer 会显示不可用状态，客户端不会尝试解密。

## 兼容性与测试

此功能不需要 Relay 配置开关或私有 Endpoint。部署需要兼容 Buzz 的 Relay，以及能够发出
上述观察协议的 Agent Runtime。没有观察帧时，客户端会正常降级。

自动化覆盖只使用生成的密钥和合成帧。测试涵盖签名与 Envelope 验证、NIP-44 路由、批处理、
去重、歧义频道关联、有界且脱敏的展示、新鲜度、订阅生命周期，以及响应式 Activity 视图。
