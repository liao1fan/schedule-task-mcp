# MCP Sampling 机制实现指南

## 📋 文档结构

### **第一部分：核心概念与架构**

#### 1. 什么是 MCP Sampling
- Sampling 机制的原理（服务器反向调用客户端）
- 使用场景（定时任务、异步触发等）
- 与普通 MCP 工具调用的区别

#### 2. Sampling 工作流程图
```
定时任务触发 → MCP Server 发送 sampling/createMessage 请求
                  ↓
Client 接收请求 → sampling_callback 被调用
                  ↓
Agent 执行任务 → 返回结果给 Server
                  ↓
Server 记录历史 → 任务完成
```

#### 3. 关键组件说明
- MCP Server 端：如何发送 `sampling/createMessage` 请求
- Client 端：如何实现 `sampling_callback`
- 两端的数据结构对应关系

---

## **第二部分：使用 MCP 官方 API 实现（纯 Python）**

**适用场景**：不使用 OpenAI Agents SDK，直接使用 MCP Python SDK

### 2.1 Server 端实现（以 schedule-task-mcp 为例）

```typescript
// 关键代码：发送 sampling 请求
const response = await this.mcpServer.request(
  {
    method: 'sampling/createMessage',
    params: {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: task.agent_prompt  // 任务描述
        }
      }],
      includeContext: 'allServers',
      maxTokens: 2000
    }
  },
  CreateMessageResultSchema,
  { timeout: this.samplingTimeoutMs }
);
```

### 2.2 Client 端实现（使用 MCP Python SDK）

**完整示例代码**：

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import CreateMessageResult, TextContent

async def sampling_callback(context, params):
    """
    处理 sampling/createMessage 请求

    Args:
        context: MCP 上下文（未使用）
        params: 包含 messages 的请求参数

    Returns:
        CreateMessageResult: 符合 MCP 规范的响应
    """
    # 1. 提取任务描述
    user_message = params.messages[0].content.text

    # 2. 执行任务（这里可以调用 OpenAI API、本地模型等）
    result_text = await execute_task(user_message)

    # 3. 返回符合规范的响应
    return CreateMessageResult(
        model="gpt-4o-mini",
        role="assistant",
        content=TextContent(type="text", text=result_text),
        stopReason="endTurn"
    )

async def execute_task(task_description: str) -> str:
    """实际执行任务的逻辑"""
    # 示例：调用 OpenAI API
    from openai import AsyncOpenAI
    client = AsyncOpenAI()

    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": task_description}]
    )

    return response.choices[0].message.content

async def main():
    # 配置 MCP 服务器参数
    server_params = StdioServerParameters(
        command="npx",
        args=["-y", "schedule-task-mcp"],
        env={
            "SCHEDULE_TASK_TIMEZONE": "Asia/Shanghai",
            "SCHEDULE_TASK_DB_PATH": "./data/tasks.db",
        }
    )

    # 连接到 MCP 服务器（关键：传入 sampling_callback）
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(
            read,
            write,
            sampling_callback=sampling_callback  # ✨ 关键参数
        ) as session:
            await session.initialize()

            # 创建定时任务
            await session.call_tool(
                "create_task",
                arguments={
                    "trigger_type": "cron",
                    "trigger_config": {"expression": "0 9 * * *"},
                    "agent_prompt": "检查新视频并发送邮件"
                }
            )

            # 保持连接，等待定时任务触发
            await asyncio.Event().wait()  # 永久等待
```

**关键点说明**：
1. `sampling_callback` 签名：`async def sampling_callback(context, params)`
2. `params.messages` 包含用户消息
3. 返回值必须是 `CreateMessageResult` 类型
4. ClientSession 必须保持运行，不能退出

---

## **第三部分：使用 OpenAI Agents SDK 实现（Python）**

**适用场景**：使用 OpenAI Agents SDK 构建 Agent 系统，需要支持 MCP Sampling

### 3.1 修改 Agents SDK 的 `server.py`

**为什么需要修改**：
- 官方 `agents.mcp.server` 模块不支持 `sampling_callback` 参数
- 需要在三个地方添加支持：
  1. `_MCPServerWithClientSession.__init__`
  2. `_MCPServerWithClientSession.connect`
  3. `MCPServerStdio.__init__`

**修改步骤**：

```bash
# 1. 备份原文件
cp /path/to/site-packages/agents/mcp/server.py \
   /path/to/site-packages/agents/mcp/server.py.backup

# 2. 替换为修改版（见 juya_agent 项目中的 server.py）
cp server.py /path/to/site-packages/agents/mcp/server.py
```

**关键修改点**：

```python
# 修改 1: __init__ 添加参数
class _MCPServerWithClientSession(MCPServer, abc.ABC):
    def __init__(
        self,
        ...,
        sampling_callback: Callable | None = None,  # ✨ 新增
    ):
        self.sampling_callback = sampling_callback

# 修改 2: connect 时传递 callback
session = await self.exit_stack.enter_async_context(
    ClientSession(
        read,
        write,
        ...,
        sampling_callback=self.sampling_callback,  # ✨ 新增
    )
)

# 修改 3: MCPServerStdio 转发参数
class MCPServerStdio(_MCPServerWithClientSession):
    def __init__(
        self,
        ...,
        sampling_callback: Callable | None = None,  # ✨ 新增
    ):
        super().__init__(
            ...,
            sampling_callback,  # ✨ 转发
        )
```

### 3.2 实现 sampling_callback（使用 Agent）

**完整示例代码**：

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio
from mcp.types import CreateMessageResult, TextContent

# 定义你的 Agent
orchestrator_agent = Agent(
    name="task_executor",
    instructions="执行定时任务",
    model="gpt-4o-mini",
    tools=[check_videos, send_email, ...]
)

def create_sampling_callback(agent):
    """
    创建 sampling callback，使用指定的 Agent 执行任务

    Args:
        agent: Agent 实例

    Returns:
        async function: sampling callback
    """
    async def sampling_callback(context, params):
        # 1. 提取任务描述
        task_description = ""
        for message in params.messages:
            if message.role == "user":
                content = message.content
                if hasattr(content, 'text'):
                    task_description = content.text
                elif isinstance(content, dict):
                    task_description = content.get('text', '')
                break

        print(f"🔔 收到定时任务: {task_description}")

        try:
            # 2. 使用 Agent 执行任务
            result = await Runner.run(
                starting_agent=agent,
                input=task_description,
                max_turns=10
            )

            response_text = str(result.final_output)
            print(f"✅ 任务完成: {response_text[:200]}...")

            # 3. 返回结果
            return CreateMessageResult(
                model=agent.model or "gpt-4o-mini",
                role="assistant",
                content=TextContent(type="text", text=response_text),
                stopReason="endTurn"
            )

        except Exception as e:
            error_msg = f"任务执行失败: {str(e)}"
            print(f"❌ {error_msg}")

            return CreateMessageResult(
                model=agent.model or "gpt-4o-mini",
                role="assistant",
                content=TextContent(type="text", text=error_msg),
                stopReason="endTurn"
            )

    return sampling_callback

# 3.3 使用修改后的 MCPServerStdio
async def main():
    # 创建 callback
    callback = create_sampling_callback(orchestrator_agent)

    # 创建 MCP Server（✨ 使用修改后的版本）
    mcp_server = MCPServerStdio(
        name="schedule-task-mcp",
        params={
            "command": "npx",
            "args": ["-y", "schedule-task-mcp"],
            "env": {
                "SCHEDULE_TASK_TIMEZONE": "Asia/Shanghai",
            }
        },
        sampling_callback=callback,  # ✨ 关键参数
    )

    # 连接并使用
    async with mcp_server as server:
        # 创建带 MCP 工具的 Agent
        agent_with_mcp = Agent(
            name=orchestrator_agent.name,
            instructions=orchestrator_agent.instructions,
            model=orchestrator_agent.model,
            tools=orchestrator_agent.tools,
            mcp_servers=[server],  # 添加 MCP 工具
        )

        # 执行任务或保持运行
        await keep_alive()
```

**关键点说明**：
1. 必须先修改 `agents.mcp.server` 模块
2. `create_sampling_callback` 返回的函数签名与 MCP 官方 API 相同
3. Agent 可以调用工具，比纯 OpenAI API 更强大
4. 需要使用 `async with` 保持连接

---

## **第四部分：两种方案对比**

| 特性 | MCP 官方 API | OpenAI Agents SDK |
|------|-------------|-------------------|
| **复杂度** | 低 | 中（需要修改 SDK） |
| **功能** | 基础（需手动实现工具调用） | 强大（自动工具调用、推理） |
| **适用场景** | 简单任务、自定义逻辑 | 复杂工作流、多工具协调 |
| **维护成本** | 低 | 中（SDK 更新需重新修改） |
| **灵活性** | 高 | 中 |

**推荐选择**：
- 如果只需要简单的定时回调 → MCP 官方 API
- 如果需要复杂的 Agent 行为 → OpenAI Agents SDK

---

## 参考资源

- **MCP 规范**：https://spec.modelcontextprotocol.io/
- **schedule-task-mcp**：https://github.com/liao1fan/schedule-task-mcp
- **OpenAI Agents SDK**：https://github.com/openai/agents-sdk-python
- **示例项目 juya_agent**：完整的视频监控系统实现
