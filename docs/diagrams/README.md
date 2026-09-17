# LibreChat Agent 架构文档

> 基于 LibreChat 代码库实际代码分析生成。包含交互式 HTML 架构图、流程图、时序图、生命周期图、数据流图和用户故事。

## 交互式图表索引

所有图表均为独立的 HTML 文件，支持暗/亮主题切换、平移缩放、搜索聚焦、PNG/SVG 导出。

| # | 图表 | 类型 | 文件 |
|---|---|---|---|
| 1 | [系统架构图](librechat-agent-architecture.html) | Architecture | `librechat-agent-architecture.html` |
| 2 | [请求生命周期时序图](librechat-request-sequence.html) | Sequence | `librechat-request-sequence.html` |
| 3 | [Agent 运行生命周期](librechat-agent-lifecycle.html) | Lifecycle | `librechat-agent-lifecycle.html` |
| 4 | [HITL 工具审批工作流](librechat-hitl-workflow.html) | Workflow | `librechat-hitl-workflow.html` |
| 5 | [消息与状态数据流](librechat-data-flow.html) | Data Flow | `librechat-data-flow.html` |

### 图表说明

#### 1. 系统架构图（Architecture）
展示 LibreChat Agent 系统的分层架构：
- **前端层**：React SPA（Marketplace + Chat）
- **API 服务器**：Express 路由 → 控制器 → 服务层 → AgentClient
- **TS 后端**：`packages/api` 中的 `initializeAgent`、`createRun`、多 Agent 发现
- **SDK + 数据层**：LangGraph Run、MongoDB、Redis
- **外部服务**：BMW Beacon LLM、MCP Servers

#### 2. 请求生命周期时序图（Sequence）
从用户发送消息到响应完成的完整时序：
- 初始化阶段：协议协商 → 客户端工厂 → TS Agent 设置
- 执行阶段：LLM 生成 → 工具执行 → 循环
- 完成阶段：消息持久化 → Job 完成 → SSE 响应

#### 3. Agent 运行生命周期（Lifecycle）
Agent 运行的状态机：
- 主路径：Queued → Initializing → Running → Streaming → Completed
- 人工等待：HITL 审批暂停、中途引导注入
- 恢复与终止：失败重试、取消、超时

#### 4. HITL 工具审批工作流（Workflow）
Human-in-the-Loop 工具审批的完整流程：
- 检测：LLM 工具调用 → 策略检查 → 暂停
- 通知：持久化 → SSE 通知用户
- 决策：用户批准或拒绝
- 结果：执行工具或中止运行

#### 5. 消息与状态数据流（Data Flow）
数据在系统中的流动路径：
- 输入：用户消息 → 预存储
- 处理：Agent Run → 内容聚合 + 检查点
- 持久化：saveMessage → MongoDB + Redis
- 存储：消息、任务、检查点、文件

---

## 用户故事

### US-01: 用户发送消息并接收流式响应

**作为** 一个 LibreChat 用户，
**我希望** 在聊天界面发送消息并实时看到 Agent 的流式响应，
**以便** 快速获得答案而不必等待完整响应生成。

**验收标准：**
- 用户在 Footer 输入框输入消息并提交
- 系统通过 SSE 流式返回 Agent 响应
- 响应过程中可以看到文本逐步生成
- 响应完成后消息持久化到 MongoDB

**相关图表：** [请求生命周期时序图](librechat-request-sequence.html) | [系统架构图](librechat-agent-architecture.html)

---

### US-02: 用户创建并配置自定义 Agent

**作为** 一个高级用户，
**我希望** 在 Agent Marketplace 中创建自定义 Agent，设置指令、选择模型、配置工具，
**以便** 将 Agent 定制为我的特定工作流。

**验收标准：**
- 通过 `client/src/components/Agents/Marketplace.tsx` 创建 Agent
- 可设置 Agent 名称、系统指令、模型选择
- 可选择启用的 MCP 工具和系统工具
- 可配置交接（handoff）到其他 Agent
- Agent 配置保存到 MongoDB

**相关图表：** [系统架构图](librechat-agent-architecture.html)

---

### US-03: 用户在 Agent 执行中途注入新指令

**作为** 一个用户，
**我希望** 在 Agent 正在执行时发送中途引导消息来改变方向，
**以便** 纠正 Agent 的方向或补充信息而不必等待完成。

**验收标准：**
- Agent 执行中用户可发送 steer 消息
- 系统在 PostToolBatch 边界注入引导
- 前端显示 steer chip，替换为内联内容
- 引导通过索引偏移保证一致性
- 引导事件通过 Redis XADD 持久化（durable）

**相关图表：** [Agent 运行生命周期](librechat-agent-lifecycle.html) | [请求生命周期时序图](librechat-request-sequence.html)

---

### US-04: 用户审批工具执行（HITL）

**作为** 一个用户，
**我希望** 在 Agent 执行敏感工具前获得审批提示，
**以便** 控制工具的执行并防止意外操作。

**验收标准：**
- Agent 工具调用触发 HITL 审批策略检查
- 审批请求通过 SSE `requires_action` 事件通知用户
- 用户看到工具名称和参数
- 用户可选择批准或拒绝
- 批准后 Agent 恢复执行工具
- 拒绝后 Agent 处理拒绝结果
- 超时后 ApprovalTtl 自动清理

**相关图表：** [HITL 工具审批工作流](librechat-hitl-workflow.html) | [Agent 运行生命周期](librechat-agent-lifecycle.html)

---

### US-05: 系统在断线后恢复 Agent 运行

**作为** 一个用户，
**我希望** 在网络断线后重新连接并恢复 Agent 运行，
**以便** 不丢失已生成的内容和运行状态。

**验收标准：**
- 断线时 Redis 中保留 GenerationJob 和检查点
- 重新连接后 ResumeAgentController 恢复运行
- 从 Redis XADD 日志回放已生成的 chunk
- 从 LangGraph checkpoint 重建状态
- 内容聚合器恢复到断线前的状态

**相关图表：** [请求生命周期时序图](librechat-request-sequence.html) | [消息与状态数据流](librechat-data-flow.html)

---

### US-06: 多 Agent 协作处理复杂任务

**作为** 一个用户，
**我希望** 主 Agent 将任务交接给专门的子 Agent，
**以便** 利用不同 Agent 的专长处理复杂任务。

**验收标准：**
- 主 Agent 通过 BFS 发现连接的 Agent 图
- 支持交接（handoff）：主 Agent 将控制权转给交接 Agent
- 支持子 Agent 生成（spawn）：主 Agent 创建隔离上下文的子 Agent
- 支持子 Agent 图：多成员子 Agent 图内交接
- 所有 Agent 共享会话状态（thread_id）
- 子 Agent 用量聚合到主 Agent

**相关图表：** [系统架构图](librechat-agent-architecture.html)

---

### US-07: 系统追踪 Token 用量并扣减余额

**作为** 系统管理员，
**我希望** 系统精确追踪每个 Agent 运行的 Token 用量并扣减用户余额，
**以便** 管理成本和计费。

**验收标准：**
- `usageEmitSink` 收集主 Agent Token 用量
- `subagentUsageSink` 聚合子 Agent 用量
- 活动标签归集工具调用成本
- 用量数据随 `saveMessage` 持久化
- 余额交易在完成后扣减

**相关图表：** [消息与状态数据流](librechat-data-flow.html)

---

### US-08: 用户连接 MCP 服务器扩展工具能力

**作为** 一个用户，
**我希望** 连接外部 MCP 服务器（如缺陷数据库）来扩展 Agent 的工具能力，
**以便** Agent 可以查询和操作外部系统。

**验收标准：**
- MCP Manager 支持通过 stdio/SSE/streamable HTTP 连接
- OAuth 流程由 MCP Manager 处理
- 工具缓存通过 `getMCPServerTools()` 加载
- 工具延迟加载（defer_loading）按需执行
- BMW 缺陷数据库 MCP Server 可连接并查询

**相关图表：** [系统架构图](librechat-agent-architecture.html)

---

### US-09: 系统在请求并发时控制负载

**作为** 系统管理员，
**我希望** 系统控制每个用户的并发请求数量，
**以便** 防止过载并保证服务质量。

**验收标准：**
- `checkAndIncrementPendingRequest` 控制并发
- 超过限制时拒绝新请求
- 请求完成后 `decrementPendingRequest` 释放
- Redis GenerationJobManager 追踪活跃作业

**相关图表：** [请求生命周期时序图](librechat-request-sequence.html)

---

### US-10: 系统异步生成会话标题和提取记忆

**作为** 一个用户，
**我希望** 系统在响应完成后自动生成会话标题和提取记忆，
**以便** 浏览历史会话和积累上下文。

**验收标准：**
- `addTitle` 在响应完成后异步调用 LLM 生成标题
- `runMemory` 在后台提取记忆
- 标题更新到会话文档
- 记忆保存到 MongoDB
- 异步任务不阻塞响应返回

**相关图表：** [请求生命周期时序图](librechat-request-sequence.html) | [消息与状态数据流](librechat-data-flow.html)

---

## 技术架构总结

LibreChat 的 Agent 架构是一个高度模块化的多 Agent 系统，核心设计要点：

1. **分层清晰**: 前端 → 路由 → 控制器 → 服务 → TS 包 → SDK → 外部服务
2. **TypeScript 迁移**: 新代码在 `packages/api` (TS)，旧代码在 `api/` (JS)，渐进迁移
3. **多 Agent 图**: 通过 BFS 发现连接的 Agent，支持交接（handoff）和子 Agent（spawn）
4. **可恢复流式**: 基于 Redis 的 GenerationJobManager，支持断线重连和 HITL 恢复
5. **工具系统**: MCP + 系统工具 + Actions + 代码工具 + 技能，支持延迟加载
6. **中途引导**: 用户可在 Agent 执行中途注入新指令，通过索引偏移保证一致性
7. **HITL 审批**: 工具执行可暂停等待用户审批，基于 LangGraph checkpoint
8. **用量追踪**: 精确的 Token 计费、子 Agent 用量聚合、活动标签成本归集

## 关键文件索引

| 层级 | 文件 | 核心职责 |
|---|---|---|
| 路由 | `api/server/routes/agents/v1.js` | Agent CRUD + 分类 |
| 路由 | `api/server/routes/agents/openai.js` | OpenAI 兼容聊天端点 |
| 控制器 | `api/server/controllers/agents/request.js` | `ResumableAgentController` — 主请求入口 |
| 控制器 | `api/server/controllers/agents/resume.js` | `ResumeAgentController` — 恢复/HITL |
| 控制器 | `api/server/controllers/agents/client.js` | `AgentClient` — 核心 Agent 客户端 |
| 控制器 | `api/server/controllers/agents/callbacks.js` | 事件回调 |
| 控制器 | `api/server/controllers/agents/steer.js` | 中途引导 |
| 服务 | `api/server/services/Endpoints/agents/initialize.js` | `initializeClient()` — 客户端工厂 |
| 服务 | `api/server/services/MCP.js` | MCP 服务器连接、OAuth、工具 |
| TS 后端 | `packages/api/src/agents/initialize.ts` | `initializeAgent()` — Agent 初始化核心 |
| TS 后端 | `packages/api/src/agents/run.ts` | `createRun()` — LangGraph 运行构建 |
| TS 后端 | `packages/api/src/agents/discovery.ts` | 多 Agent 图发现 (BFS) |
| TS 后端 | `packages/api/src/agents/hitl/policy.ts` | 工具审批策略 |
| 前端 | `client/src/components/Agents/Marketplace.tsx` | Agent 市场 UI |
| 前端 | `client/src/components/Chat/Footer.tsx` | 聊天输入 + 工具栏 |
