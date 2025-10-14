# Schedule-Task-MCP 发布指南

本指南说明如何完成 schedule-task-mcp 的发布。

---

## ✅ 已完成的步骤

1. ✅ 项目已创建并构建成功
2. ✅ GitHub 仓库已创建：https://github.com/liao1fan/schedule-task-mcp
3. ✅ 所有源代码已提交到本地 git

---

## 📤 需要手动完成的步骤

### 1. 推送代码到 GitHub

由于网络连接问题，需要手动推送：

```bash
cd /Users/liao1fan/personal/schedule-task-mcp

# 推送代码
git push -u origin main
```

如果遇到网络问题，可以尝试：
- 检查网络连接
- 使用 VPN
- 或稍后重试

### 2. 发布到 npm

**方法 1：浏览器登录**

```bash
cd /Users/liao1fan/personal/schedule-task-mcp

# 登录 npm（会打开浏览器）
npm login

# 发布包
npm publish --access public
```

**方法 2：使用 npm token**

如果有 npm access token：

```bash
echo "//registry.npmjs.org/:_authToken=YOUR_TOKEN" > ~/.npmrc
npm publish --access public
```

### 3. 验证发布

发布成功后，访问以下链接验证：
- npm: https://www.npmjs.com/package/schedule-task-mcp
- GitHub: https://github.com/liao1fan/schedule-task-mcp

---

## 📋 项目信息

**项目路径：** `/Users/liao1fan/personal/schedule-task-mcp`

**项目名称：** schedule-task-mcp

**版本：** 0.1.0

**描述：** MCP server for scheduled task management and execution with support for interval, cron, and date-based triggers

**主要功能：**
- ⏰ 支持 interval、cron、date 三种触发器类型
- 🔄 完整的任务管理（创建、更新、暂停、恢复、删除）
- 💾 持久化存储（JSON 文件）
- 🎯 可扩展架构（支持调用其他 MCP 工具）
- 📊 状态跟踪（上次运行、状态、下次运行）

---

## 🎯 与 juya 项目的关系

**schedule-task-mcp** 是一个通用的定时任务管理 MCP 工具。

**juya** 项目可以使用 schedule-task-mcp 来管理定时任务，例如：

```javascript
// 在 juya 中使用 schedule-task-mcp
{
  "name": "Monitor Bilibili videos",
  "trigger_type": "interval",
  "trigger_config": {
    "minutes": 5
  },
  "mcp_server": "juya-mcp",
  "mcp_tool": "check_new_videos",
  "mcp_arguments": {
    "count": 10
  }
}
```

这样，任何 agent 都可以使用 schedule-task-mcp 来管理各种定时任务。

---

## 📦 文件结构

```
schedule-task-mcp/
├── src/
│   ├── index.ts           # MCP 服务器主文件
│   ├── scheduler.ts       # 任务调度器
│   └── storage.ts         # 任务存储
├── dist/                  # 编译输出
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md             # 完整使用文档
├── LICENSE               # MIT License
└── PUBLISH_GUIDE.md      # 本文件
```

---

## 🚀 使用示例

安装后，用户可以在 Claude Desktop 中：

```
创建一个任务，每5分钟执行一次

列出所有任务

暂停任务 task-xxx

恢复任务 task-xxx

立即执行任务 task-xxx
```

---

## ⚠️ 注意事项

### npm 发布

- **首次发布需要 `--access public`**
- **包名必须唯一**（schedule-task-mcp 应该可用）
- **发布后无法删除**，只能废弃

### GitHub

- 仓库已创建为 **Public**
- 需要成功推送代码才能在 GitHub 上看到源码

---

## 🎉 下一步

发布成功后：

1. ✅ 更新 README 中的链接（如果需要）
2. ✅ 创建 GitHub Release（可选）
3. ✅ 测试 npm 安装：`npm install -g schedule-task-mcp`
4. ✅ 在 juya 项目中集成使用

---

**准备就绪！请按照上述步骤完成发布！** 🚀



npm run build
npm publish --otp=