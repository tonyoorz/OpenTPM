# LibreChat Agent 架构图

> 基于代码库实际代码分析生成。涵盖架构总览、核心组件、请求时序、多 Agent 协作、HITL 审批流程等。

---

## 1. 总体架构图（分层视图）

```mermaid
graph TB
    subgraph Client["前端层 (client/src)"]
        UI["React SPA<br/>Agents/Marketplace.tsx"]
        ChatUI["Chat 组件<br/>Footer.tsx, Chat.tsx"]
        SSEClient["SSE 事件消费<br/>EventSource"]
    end

    subgraph Routes["路由层 (api/server/routes)"]
        AgentRoutes["agents/v1.js<br/>agents/openai.js<br/>agents/responses.js"]
        ConvoRoutes["convos.js<br/>子Agent线程路由"]
    end

    subgraph Controllers["控制器层 (api/server/controllers/agents)"]
        RequestCtrl["request.js<br/>ResumableAgentController"]
        ResumeCtrl["resume.js<br/>ResumeAgentController"]
        V1Ctrl["v1.js<br/>Agent CRUD"]
        OpenAICtrl["openai.js<br/>OpenAI兼容"]
        ResponsesCtrl["responses.js<br/>Responses API"]
        Protocol["protocol.js<br/>协议协商 v1/v2"]
        Callbacks["callbacks.js<br/>事件回调处理"]
        Errors["errors.js"]
        SteerCtrl["steer.js<br/>中途引导"]
    end

    subgraph Services["服务层 (api/server/services)"]
        InitClient["Endpoints/agents/initialize.js<br/>initializeClient()"]
        MCPService["MCP.js<br/>MCP服务器管理"]
        ToolService["ToolService.js<br/>工具加载"]
        ConfigSvc["Config.js<br/>配置/工具缓存"]
        FileSvc["Files/permissions<br/>文件权限"]
        PermSvc["PermissionService<br/>权限检查"]
        ScheduleSvc["Schedules/<br/>定时任务"]
    end

    subgraph PackagesAPI["TypeScript后端 (packages/api/src/agents)"]
        InitAgent["initialize.ts<br/>initializeAgent()"]
        RunEngine["run.ts<br/>createRun()"]
        Discovery["discovery.ts<br/>多Agent图发现"]
        Selection["selection.ts<br/>子Agent选择"]
        Memory["memory.ts<br/>记忆处理"]
        Skills["skills.ts<br/>技能注入"]
        Intent["intent.ts<br/>工具意图"]
        HITL["hitl/policy.ts<br/>审批策略"]
        Background["background.ts<br/>后台任务"]
        ActivityLabels["activityLabels/<br/>活动标签"]
    end

    subgraph SDK["@librechat/agents SDK"]
        Run["Run 类<br/>LangGraph运行时"]
        ContentAgg["createContentAggregator<br/>内容聚合"]
        MultiAgent["MultiAgentGraph<br/>多Agent图"]
        Checkpointer["Checkpointer<br/>检查点持久化"]
    end

    subgraph DataLayer["数据层"]
        MongoDB[("MongoDB<br/>消息/Agent/会话")]
        Redis[("Redis<br/>任务/流/缓存")]
        Models["models/index.js<br/>数据访问层"]
    end

    subgraph External["外部服务"]
        LLM["LLM Provider<br/>(Beacon模型)"]
        MCPServers["MCP Servers<br/>(缺陷数据库等)"]
    end

    UI --> AgentRoutes
    ChatUI --> AgentRoutes
    SSEClient -.->|SSE| ChatUI

    AgentRoutes --> RequestCtrl
    AgentRoutes --> V1Ctrl
    AgentRoutes --> OpenAICtrl
    AgentRoutes --> ResponsesCtrl
    ConvoRoutes --> RequestCtrl

    RequestCtrl --> InitClient
    ResumeCtrl --> InitClient
    OpenAICtrl --> InitClient
    ResponsesCtrl --> InitClient

    InitClient --> InitAgent
    InitClient --> MCPService
    InitClient --> ToolService
    InitClient --> PermSvc
    InitClient --> ConfigSvc
    InitClient --> FileSvc

    InitAgent --> RunEngine
    InitAgent --> Discovery
    InitAgent --> Skills
    InitAgent --> Memory
    InitAgent --> HITL
    InitAgent --> Background
    InitAgent --> Intent

    RunEngine --> Run
    Run --> MultiAgent
    Run --> Checkpointer
    Run --> ContentAgg

    Callbacks --> SSEClient
    Callbacks --> Models

    Models --> MongoDB
    Checkpointer --> Redis
    MCPService --> MCPServers
    Run --> LLM

    style Client fill:#1a1a2e,color:#e0e0e0
    style Controllers fill:#16213e,color:#e0e0e0
    style PackagesAPI fill:#0f3460,color:#e0e0e0
    style SDK fill:#533483,color:#e0e0e0
    style DataLayer fill:#1a1a2e,color:#e0e0e0
    style External fill:#2d1b1b,color:#e0e0e0
```

---

## 2. 核心组件关系图（AgentClient 内部结构）

```mermaid
graph LR
    subgraph AgentClient["AgentClient (client.js)"]
        direction TB

        subgraph Init["初始化阶段"]
            BuildMsgs["buildMessages()<br/>消息格式化+token计数"]
            UseMemory["useMemory()<br/>记忆加载"]
            ResolveMCP["resolveConfigServers()<br/>MCP配置解析"]
            AgentScoped["buildAgentScopedContext()<br/>Agent级别上下文"]
        end

        subgraph Run["运行阶段 (chatCompletion)"]
            FormatMsg["formatAgentMessages()<br/>SDK消息格式化"]
            SkillPrime["injectSkillPrimes()<br/>技能注入"]
            CreateRun["createRun()<br/>构建LangGraph运行"]
            ProcessStream["run.processStream()<br/>流式执行"]
            HandleInterrupt["handleRunInterrupt()<br/>HITL暂停处理"]
        end

        subgraph Streaming["流式输出"]
            ContentParts["contentParts[]<br/>内容片段聚合"]
            StepMap["stepMap<br/>运行步骤映射"]
            UsageSink["usageEmitSink[]<br/>用量收集"]
            ContextSink["contextUsageSink<br/>上下文用量"]
        end

        subgraph Labels["活动标签（可选）"]
            ActivityLabel["buildActivityLabelWiring()<br/>工具活动标签"]
            ActivityPhase["buildActivityPhaseWiring()<br/>阶段摘要"]
            ReasoningLabel["buildReasoningLabelWiring()<br/>推理标签"]
        end

        subgraph Steer["中途引导"]
            SteerWiring["buildSteerWiring()<br/>引导注入"]
            SteerOffset["steerOffsetState<br/>索引偏移"]
        end

        subgraph Subagent["子Agent管理"]
            SubAgg["subagentAggregatorsByToolCallId<br/>子Agent内容聚合"]
            SubUsage["subagentUsageSink<br/>子Agent用量"]
        end
    end

    subgraph BaseClient["BaseClient (继承)"]
        BaseSend["sendMessage()<br/>消息持久化"]
        BaseTitle["titleConvo()<br/>标题生成"]
    end

    subgraph EventHandlers["事件处理器 (callbacks.js)"]
        DefaultHandlers["getDefaultHandlers()<br/>默认事件处理器"]
        ToolEndCB["createToolEndCallback()<br/>工具结束回调"]
        AttachEmit["createAttachmentEmitter()<br/>附件发射"]
    end

    BaseClient --> AgentClient
    Init --> Run
    Run --> Streaming
    Run --> Labels
    Run --> Steer
    Run --> Subagent
    EventHandlers --> Streaming
    HandleInterrupt -.->|暂停时| Redis

    style AgentClient fill:#0f3460,color:#e0e0e0
    style BaseClient fill:#1a1a2e,color:#e0e0e0
    style EventHandlers fill:#16213e,color:#e0e0e0
```

---

## 3. 完整请求时序图（从用户消息到响应完成）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户/前端
    participant R as Express路由
    participant RC as ResumableAgentController<br/>(request.js)
    participant IC as initializeClient<br/>(initialize.js)
    participant IA as initializeAgent<br/>(packages/api TS)
    participant AC as AgentClient<br/>(client.js)
    participant SDK as createRun + Run<br/>(@librechat/agents)
    participant LLM as LLM Provider
    participant MCP as MCP Servers
    participant DB as MongoDB
    participant RD as Redis
    participant SSE as SSE流

    U->>R: POST /api/agents/chat (消息+conversationId)
    R->>RC: ResumableAgentController(req, res, next, initializeClient, addTitle)

    rect rgb(20, 30, 50)
        Note over RC: 阶段1: 请求预处理
        RC->>RC: negotiateNewGenerationProtocol(req)
        RC->>RC: 验证 clientRequestId, overrideId 等
        RC->>RC: resolveConversationAnchor (获取会话时间戳)
        RC->>RC: getPreliminaryUserMessage (预存用户消息)
        RC->>RD: GenerationJobManager.createJob(streamId)
        RC->>RC: checkAndIncrementPendingRequest (并发控制)
    end

    rect rgb(30, 50, 30)
        Note over RC,IC: 阶段2: 客户端初始化
        RC->>IC: initializeClient({req, res, signal, endpointOption, jobCreatedAt})
        IC->>IC: Promise.all([memoryAvailable, accessibleSkillIds,<br/>skillStates, validatedPrimaryAgent, requestConversation])

        IC->>IA: initializeAgent({req, agent, loadTools, ...})
        IA->>IA: getProviderConfig (解析Provider配置)
        IA->>IA: resolveToolApprovalPolicy (HITL策略)
        IA->>IA: registerCodeExecutionTools (代码执行工具)
        IA->>IA: registerMemoryTools (记忆工具)
        IA->>IA: injectSkillCatalog (技能目录)
        IA->>IA: buildHITLRunWiring (HITL接线)
        IA-->>IC: primaryConfig (已初始化的Agent配置)

        IC->>IC: discoverConnectedAgents (BFS发现多Agent图)
        IC->>IC: processAddedConvo (多会话Agent)
        IC->>IC: buildSubagentThreadTaskConfig (子Agent任务)

        IC->>AC: new AgentClient({req, res, agent, contentParts,<br/>eventHandlers, agentConfigs, ...})
        IC-->>RC: {client, userMCPAuthMap}
    end

    rect rgb(50, 30, 20)
        Note over RC,AC: 阶段3: 消息构建
        RC->>AC: client.sendCompletion(payload, {onProgress, abortController})
        AC->>AC: buildMessages(messages, parentMessageId)
        AC->>AC: formatMessage (每条消息格式化)
        AC->>AC: countTokens (token计数)
        AC->>AC: useMemory() (加载记忆)
        AC->>AC: resolveConfigServers (MCP配置)
        AC->>AC: buildAgentScopedContext (Agent级上下文)
        AC->>AC: applyContextToAgent (应用到所有Agent)
        AC-->>AC: {prompt, promptTokens, messages}
    end

    rect rgb(40, 20, 50)
        Note over AC,SDK: 阶段4: 运行创建与执行
        AC->>AC: chatCompletion({payload, abortController})
        AC->>AC: formatAgentMessages (SDK格式化)
        AC->>AC: injectSkillPrimes (技能注入)
        AC->>AC: buildSteerWiring (引导接线)
        AC->>AC: buildActivityLabelWiring (活动标签接线)

        AC->>SDK: createRun({agents, messages, customHandlers,<br/>steering, hitlCapable, signal, ...})
        SDK->>SDK: MultiAgentGraph 构建
        SDK->>SDK: Checkpointer 挂载
        SDK-->>AC: Run 实例

        AC->>SDK: run.processStream({messages}, config)
        SDK-->>SSE: 流式事件 (on_run_step, on_message,<br/>on_tool_call, on_tool_end, ...)

        loop 工具调用循环
            SDK->>LLM: 请求LLM生成
            LLM-->>SDK: 响应 (可能含tool_calls)

            alt 有工具调用
                SDK->>MCP: 执行MCP工具
                MCP-->>SDK: 工具结果
                SDK-->>SSE: on_tool_end 事件

                alt HITL审批触发
                    SDK->>SDK: 暂停运行 (interrupt)
                    SDK->>RD: 持久化pending action
                    SDK-->>SSE: requires_action 事件
                    SSE-->>U: 显示审批请求
                    Note over U: 等待用户审批...
                end
            end

            SDK->>DB: (异步)保存消息
            SDK-->>SSE: on_token_usage 事件
        end

        SDK-->>AC: 运行完成
        AC->>AC: handleRunInterrupt (检查HITL暂停)
        AC->>AC: settleActivityLabels (结算标签)
        AC->>AC: finalizeSubagentContent (子Agent内容)
        AC->>AC: buildResponseMetadata (构建元数据)
    end

    rect rgb(20, 40, 40)
        Note over RC,U: 阶段5: 响应完成
        AC-->>RC: {completion, metadata}
        RC->>DB: saveMessage (保存响应消息)
        RC->>RD: GenerationJobManager.completeJob
        RC->>RC: finishResumableRequest (清理)
        RC->>RC: decrementPendingRequest
        RC-->>SSE: 最终事件
        SSE-->>U: 渲染完整响应

        par 异步任务
            RC->>AC: addTitle (标题生成)
            AC->>LLM: 生成会话标题
            AC->>DB: 更新会话标题
        and 记忆处理
            AC->>AC: runMemory (记忆提取)
            AC->>DB: 保存记忆
        end
    end
```

---

## 4. 多 Agent 协作架构图

```mermaid
graph TB
    subgraph UserRequest["用户请求"]
        Msg["用户消息"]
    end

    subgraph AgentGraph["LangGraph 多Agent图"]
        direction TB

        subgraph PrimaryAgent["主Agent"]
            PA_Config["Agent配置<br/>instructions, tools, model"]
            PA_Tools["工具集<br/>MCP工具 + 系统工具"]
            PA_LLM["LLM调用<br/>(Beacon模型)"]
        end

        subgraph HandoffAgents["交接Agent (通过edges连接)"]
            HA1["Agent B<br/>(如: 翻译Agent)"]
            HA2["Agent C<br/>(如: 分析Agent)"]
        end

        subgraph SubAgents["子Agent (通过subagent工具生成)"]
            SA1["子Agent 1<br/>(隔离上下文)"]
            SA2["子Agent 2<br/>(隔离上下文)"]
        end

        subgraph SubagentGraph["子Agent图 (多成员)"]
            SG1["图成员 A"]
            SG2["图成员 B"]
        end
    end

    subgraph Discovery["发现阶段 (discovery.ts)"]
        BFS["BFS遍历<br/>discoverConnectedAgents()"]
        Edges["边过滤<br/>edges配置"]
        Pruning["不可达Agent裁剪"]
    end

    subgraph SharedState["共享运行状态"]
        ConvState["会话状态<br/>thread_id"]
        Checkpoint["检查点<br/>LangGraph checkpoint"]
        SharedCtx["共享上下文<br/>RAG/文件/记忆"]
    end

    Msg --> BFS
    BFS --> PA_Config
    BFS --> HA1
    BFS --> HA2
    Edges --> BFS
    Pruning --> BFS

    PA_Config --> PA_Tools
    PA_Tools --> PA_LLM

    PA_LLM -.->|交接| HA1
    PA_LLM -.->|交接| HA2
    PA_LLM -.->|生成子Agent| SA1
    PA_LLM -.->|生成子Agent| SA2
    PA_LLM -.->|生成子Agent图| SG1
    SG1 -.->|图内交接| SG2

    PA_LLM --> SharedCtx
    HA1 --> SharedCtx
    SA1 --> Checkpoint
    SG1 --> Checkpoint

    ConvState --> PA_LLM
    ConvState --> HA1

    style PrimaryAgent fill:#0f3460,color:#e0e0e0
    style HandoffAgents fill:#16213e,color:#e0e0e0
    style SubAgents fill:#533483,color:#e0e0e0
    style SubagentGraph fill:#3c1361,color:#e0e0e0
```

---

## 5. HITL（Human-in-the-Loop）审批时序图

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant SSE as SSE流
    participant RC as ResumableAgentController
    participant AC as AgentClient
    participant Run as LangGraph Run
    participant RD as Redis
    participant DB as MongoDB

    U->>RC: 发送消息
    RC->>AC: sendCompletion()
    AC->>Run: processStream()

    Run->>Run: LLM请求 → tool_calls
    Run->>Run: 检查工具审批策略<br/>(resolveToolApprovalPolicy)

    alt 需要审批
        Run->>Run: 触发 interrupt (暂停)
        Run->>RD: 持久化 pending action<br/>(GenerationJobManager)
        Run-->>SSE: requires_action 事件
        SSE-->>U: 显示工具审批对话框

        Note over U: 用户看到工具名、参数<br/>选择批准或拒绝

        alt 用户批准
            U->>RC: POST /api/agents/resume<br/>(action: approve)
            RC->>RC: ResumeAgentController
            RC->>RD: 获取job + checkpoint
            RC->>AC: initializeClient (重建client)
            AC->>Run: resume (注入审批结果)
            Run->>Run: 执行工具
            Run-->>SSE: on_tool_end
            Run->>Run: 继续LLM循环
        else 用户拒绝
            U->>RC: POST /api/agents/resume<br/>(action: reject)
            RC->>Run: resume (注入拒绝)
            Run->>Run: 处理拒绝结果
            Run-->>SSE: 终止或继续
        else 超时
            Note over RD: ApprovalTtl 过期<br/>Job自动清理
            RD-->>U: 超时通知
        end
    else 自动批准 / 无需审批
        Run->>Run: 直接执行工具
        Run-->>SSE: on_tool_end
    end

    Run-->>AC: 完成
    AC->>DB: 保存最终响应
    AC-->>SSE: 最终事件
    SSE-->>U: 渲染响应
```

---

## 6. 工具系统架构图

```mermaid
graph TB
    subgraph ToolSources["工具来源"]
        SystemTools["系统工具<br/>execute_code, file_search,<br/>web_search, memory"]
        MCPTools["MCP工具<br/>(缺陷数据库等)"]
        ActionTools["Action工具<br/>(OpenAPI定义)"]
        CodeTools["代码工具<br/>create_file, edit_file"]
        SkillTools["技能工具<br/>skill (SKILL.md)"]
    end

    subgraph ToolLoading["工具加载层"]
        ToolLoader["createToolLoader()<br/>(initialize.js)"]
        LoadAgentTools["loadAgentTools()<br/>(ToolService.js)"]
        LoadExec["loadToolsForExecution()<br/>按需加载"]
        DeferLoad["defer_loading<br/>延迟加载机制"]
    end

    subgraph ToolRegistry["工具注册表"]
        Registry["LCToolRegistry<br/>(Map结构)"]
        ToolDef["工具定义<br/>(JSON Schema)"]
        ToolCtx["工具上下文<br/>MCP auth, code env"]
    end

    subgraph MCPManager["MCP管理 (MCP.js)"]
        MCPRegistry["MCPServersRegistry<br/>服务器注册"]
        MCPConn["连接管理<br/>stdio/SSE/streamable"]
        MCPOAuth["OAuth处理<br/>认证流程"]
        MCPToolsCache["工具缓存<br/>getMCPServerTools()"]
    end

    subgraph Runtime["运行时"]
        ToolSearch["tool_search<br/>工具发现"]
        ToolExec["ON_TOOL_EXECUTE<br/>工具执行回调"]
        ToolEnd["ToolEndCallback<br/>工具结束处理"]
        Attach["AttachmentEmitter<br/>附件发射"]
    end

    SystemTools --> ToolLoader
    MCPTools --> MCPManager
    ActionTools --> ToolLoader
    CodeTools --> ToolLoader
    SkillTools --> ToolLoader

    ToolLoader --> LoadAgentTools
    LoadAgentTools --> LoadExec
    LoadExec --> DeferLoad

    LoadAgentTools --> Registry
    MCPManager --> MCPToolsCache
    MCPToolsCache --> Registry
    Registry --> ToolDef
    Registry --> ToolCtx

    DeferLoad --> Runtime
    Registry --> Runtime
    ToolSearch --> DeferLoad

    Runtime --> ToolExec
    ToolExec --> ToolEnd
    ToolEnd --> Attach

    style ToolSources fill:#1a1a2e,color:#e0e0e0
    style ToolLoading fill:#16213e,color:#e0e0e0
    style ToolRegistry fill:#0f3460,color:#e0e0e0
    style MCPManager fill:#533483,color:#e0e0e0
    style Runtime fill:#2d1b1b,color:#e0e0e0
```

---

## 7. 流式输出与可恢复机制图

```mermaid
graph TB
    subgraph Generation["生成作业管理 (GenerationJobManager)"]
        JobCreate["createJob<br/>创建作业"]
        JobStore["Job存储<br/>(Redis)"]
        StreamPub["流发布<br/>Pub/Sub"]
        ChunkLog["Chunk日志<br/>(Redis XADD)"]
        JobAbort["abortJob<br/>终止作业"]
        JobComplete["completeJob<br/>完成作业"]
    end

    subgraph Streaming["流式输出"]
        ContentAgg["createContentAggregator<br/>内容聚合器"]
        EventHandlers["事件处理器<br/>(getDefaultHandlers)"]
        SendEvent["sendEvent<br/>SSE发射"]
        Offset["SteerOffsetState<br/>索引偏移管理"]
    end

    subgraph Reconnect["断线重连"]
        Resume["ResumeAgentController<br/>(resume.js)"]
        ChunkReplay["Chunk回放<br/>(从XADD日志)"]
        StateRebuild["状态重建<br/>(checkpoint恢复)"]
    end

    subgraph Protocol["协议协商"]
        V1["Protocol v1<br/>(JSON轮询)"]
        V2["Protocol v2<br/>(SSE流)"]
        Negotiate["negotiateNewGenerationProtocol<br/>协商版本"]
    end

    JobCreate --> JobStore
    JobStore --> StreamPub
    JobStore --> ChunkLog

    ContentAgg --> EventHandlers
    EventHandlers --> SendEvent
    SendEvent --> StreamPub
    Offset --> ContentAgg

    StreamPub -.->|断线| Reconnect
    Resume --> ChunkReplay
    ChunkReplay --> StateRebuild
    StateRebuild --> ContentAgg

    Negotiate --> V1
    Negotiate --> V2
    V2 --> StreamPub
    V1 --> JobStore

    JobAbort --> JobStore
    JobComplete --> JobStore

    style Generation fill:#1a1a2e,color:#e0e0e0
    style Streaming fill:#0f3460,color:#e0e0e0
    style Reconnect fill:#533483,color:#e0e0e0
    style Protocol fill:#2d1b1b,color:#e0e0e0
```

---

## 8. 中途引导（Steering）机制图

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant SSE as SSE流
    participant AC as AgentClient
    participant Run as LangGraph Run
    participant Drain as SteerDrainHook

    U->>AC: 发送中途消息 (steer)
    AC->>AC: 排入 steer 队列

    Note over Run: Agent正在执行工具调用...

    Run->>Drain: PostToolBatch 边界触发
    Drain->>Drain: 从队列取出 steer 项

    Drain->>AC: applySteerPart(streamId, item)
    AC->>AC: contentParts.push(steer part)
    AC->>AC: steerOffsetState.offset += 1
    AC->>SSE: on_steer_applied 事件<br/>(durable: true, XADD)

    alt SDK支持 PreemptBoundary
        Drain->>Drain: createSteerPreemptBoundaryHook
        Drain->>Drain: createSteerPreemptPoll
        Note over Drain: 在文本生成中插入引导<br/>字节级一致的注入
    end

    Drain->>AC: buildSteerMedia (编码文件附件)
    AC-->>Run: 注入引导到图状态
    Run->>Run: 继续执行 (带新引导)

    Note over U: 前端看到 steer chip<br/>替换为内联内容
```

---

## 9. 数据流与持久化架构图

```mermaid
graph LR
    subgraph RequestFlow["请求流"]
        UserMsg["用户消息"]
        PrelimSave["预存用户消息<br/>(PreliminaryUserMessage)"]
        JobMeta["Job元数据<br/>(Redis)"]
    end

    subgraph RunFlow["运行流"]
        Checkpoint["LangGraph Checkpoint<br/>(每步状态)"]
        ContentParts["ContentParts[]<br/>(流式内容)"]
        StepMap["StepMap<br/>(步骤→索引)"]
        Usage["Usage收集<br/>(token用量)"]
    end

    subgraph PersistFlow["持久化流"]
        MsgSave["saveMessage<br/>(消息保存)"]
        ConvoUpdate["更新会话<br/>(标题等)"]
        FileSave["文件保存<br/>(工具产出)"]
        MemorySave["记忆保存<br/>(记忆Agent)"]
        BalanceTx["余额交易<br/>(费用扣减)"]
    end

    subgraph Storage["存储"]
        Mongo[("MongoDB")]
        Redis[("Redis")]
        S3["S3/文件存储"]
    end

    UserMsg --> PrelimSave
    PrelimSave --> Mongo
    PrelimSave --> JobMeta
    JobMeta --> Redis

    Checkpoint --> Redis
    ContentParts --> MsgSave
    StepMap --> MsgSave
    Usage --> MsgSave

    MsgSave --> Mongo
    ConvoUpdate --> Mongo
    FileSave --> S3
    FileSave --> Mongo
    MemorySave --> Mongo
    BalanceTx --> Mongo

    Usage --> BalanceTx

    style RequestFlow fill:#1a1a2e,color:#e0e0e0
    style RunFlow fill:#0f3460,color:#e0e0e0
    style PersistFlow fill:#16213e,color:#e0e0e0
    style Storage fill:#2d1b1b,color:#e0e0e0
```

---

## 10. 关键文件索引

| 层级 | 文件 | 核心职责 |
|---|---|---|
| **路由** | `api/server/routes/agents/v1.js` | Agent CRUD + 分类 |
| **路由** | `api/server/routes/agents/openai.js` | OpenAI 兼容聊天端点 |
| **路由** | `api/server/routes/agents/responses.js` | Responses API 端点 |
| **控制器** | `api/server/controllers/agents/request.js` | `ResumableAgentController` — 主请求入口 |
| **控制器** | `api/server/controllers/agents/resume.js` | `ResumeAgentController` — 恢复/HITL |
| **控制器** | `api/server/controllers/agents/client.js` | `AgentClient` — 核心 Agent 客户端 (4611行) |
| **控制器** | `api/server/controllers/agents/v1.js` | Agent CRUD 逻辑 (创建/更新/删除) |
| **控制器** | `api/server/controllers/agents/callbacks.js` | 事件回调 (工具结束、附件、进度) |
| **控制器** | `api/server/controllers/agents/protocol.js` | v1/v2 协议协商 |
| **控制器** | `api/server/controllers/agents/steer.js` | 中途引导 |
| **控制器** | `api/server/controllers/agents/errors.js` | 错误处理 |
| **服务** | `api/server/services/Endpoints/agents/initialize.js` | `initializeClient()` — 客户端工厂 |
| **服务** | `api/server/services/MCP.js` | MCP 服务器连接、OAuth、工具 |
| **服务** | `api/server/services/Config.js` | 配置缓存、工具缓存 |
| **服务** | `api/server/services/ToolService.js` | `loadAgentTools`, `loadToolsForExecution` |
| **TS后端** | `packages/api/src/agents/initialize.ts` | `initializeAgent()` — Agent初始化核心 |
| **TS后端** | `packages/api/src/agents/run.ts` | `createRun()` — LangGraph运行构建 |
| **TS后端** | `packages/api/src/agents/discovery.ts` | 多Agent图发现 (BFS) |
| **TS后端** | `packages/api/src/agents/memory.ts` | 记忆工具注册 |
| **TS后端** | `packages/api/src/agents/skills.ts` | 技能注入、priming |
| **TS后端** | `packages/api/src/agents/hitl/policy.ts` | 工具审批策略 |
| **TS后端** | `packages/api/src/agents/background.ts` | 后台任务工具 |
| **SDK** | `@librechat/agents` (外部仓库) | Run, MultiAgentGraph, Checkpointer |
| **前端** | `client/src/components/Agents/Marketplace.tsx` | Agent 市场 UI |
| **前端** | `client/src/components/Chat/Footer.tsx` | 聊天输入 + 工具栏 |

---

## 11. BMW Beacon 环境下的特定架构

```mermaid
graph TB
    subgraph Browser["浏览器"]
        LibreChatUI["LibreChat 前端<br/>10.165.22.10:3080"]
    end

    subgraph LibreChatBackend["LibreChat 后端"]
        AgentEndpoint["agents 端点<br/>ENDPOINTS=custom"]
        AgentClient["AgentClient"]
        createRun["createRun()"]
    end

    subgraph Beacon["BMW Beacon LLM"]
        Personal["personal 通道<br/>(日常对话模型)"]
        GoLive["golive 通道<br/>(生产模型)"]
    end

    subgraph VizionPlugin["vizion-lab 缺陷插件"]
        PiAgent["π式 Agent<br/>(结构化推理)"]
        DefectMCP["BMW缺陷数据库<br/>MCP Server"]
    end

    subgraph Models["模型路由 (6个模型)"]
        M1["模型1 → personal"]
        M2["模型2 → personal"]
        M3["模型3 → golive"]
        M4["模型4 → golive"]
        M5["模型5 → personal"]
        M6["模型6 → golive"]
    end

    LibreChatUI -->|HTTP/SSE| AgentEndpoint
    AgentEndpoint --> AgentClient
    AgentClient --> createRun

    createRun -->|API调用| Beacon
    createRun -->|工具调用| VizionPlugin

    AgentClient --> PiAgent
    PiAgent --> DefectMCP

    AgentClient --> Models
    Models --> Personal
    Models --> GoLive

    style Beacon fill:#1a1a2e,color:#e0e0e0
    style VizionPlugin fill:#533483,color:#e0e0e0
    style Models fill:#0f3460,color:#e0e0e0
```

---

## 总结

LibreChat 的 Agent 架构是一个高度模块化的多Agent系统，核心设计要点：

1. **分层清晰**: 前端 → 路由 → 控制器 → 服务 → TS包 → SDK → 外部服务
2. **TypeScript迁移**: 新代码在 `packages/api` (TS)，旧代码在 `api/` (JS)，渐进迁移
3. **多Agent图**: 通过 BFS 发现连接的 Agent，支持交接(handoff)和子Agent(spawn)
4. **可恢复流式**: 基于 Redis 的 GenerationJobManager，支持断线重连和 HITL 恢复
5. **工具系统**: MCP + 系统工具 + Actions + 代码工具 + 技能，支持延迟加载
6. **中途引导**: 用户可在Agent执行中途注入新指令，通过索引偏移保证一致性
7. **HITL审批**: 工具执行可暂停等待用户审批，基于 LangGraph checkpoint
8. **用量追踪**: 精确的token计费、子Agent用量聚合、活动标签成本归集
