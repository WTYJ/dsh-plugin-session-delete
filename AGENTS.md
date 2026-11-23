# AGENTS.md

本文件面向参与 `dsh-plugin-session-delete` 开发的 AI Agent 与协作者，约定项目约束与工作流红线。

## 发布与版本控制红线（必须遵守）

以下操作**必须收到用户的明确指令后才能执行**，严禁在未获明确授权时自主执行：

1. **定版本号 / 修改版本号**：不得擅自修改 `package.json` 中的 `version` 或创建/移动版本标签（`git tag`）。
2. **推送代码（Push）**：不得擅自执行 `git push`（包括推送分支或标签到远端仓库）。
3. **发布 Release**：不得擅自创建、编辑或删除 GitHub Release。

> 说明：常规开发任务中，可以正常修改代码、运行本地测试与检查；完成开发后向用户汇报变更结果，等待用户明确下达版本、推送或发布指令。

## 项目概览

- **定位**：DeepSeek Harness (DSH) 侧栏会话永久删除插件。
- **运行环境**：Node.js >= 22.19，ESM（`"type": "module"`），支持 Windows / Linux / macOS。
- **核心文件**：
  - `index.js` — Host 端（Cordis 插件），注册同源路由 `POST /dsh-plugin-session-delete/delete`，执行安全校验、沙箱内删除、派生存储清理与工作区账目摘除。
  - `lib/client.js` — Client 端（浏览器），通过官方 slot `sidebar.workspaces.session.menu.item` 注册菜单项，提供确认弹窗与多语言文案。
  - `cordis.patch.yml` — Cordis profile bundle patch 声明。
  - `locale/zh.json`、`locale/en.json` — 插件元信息多语言文案。
  - `package.json` — 插件清单与 `dsh` 注入声明。

## 开发约束

1. **零第三方依赖**：
   - Host 端仅使用 Node.js 内置模块（`node:*`）。
   - Client 端仅使用平台模块表提供的 `react`，**禁止** `require` 任何 `@deepseek-ai/dsh-client-*` 内部包。
2. **不侵入 DOM**：
   - 保持使用官方 slot API 注册 UI 入口，不使用 DOM 克隆或 `MutationObserver`。
   - 样式优先复用 `--dsw-alias-*` 设计变量，并兼顾 `body[data-ds-dark-theme]` 暗色主题。
3. **安全原则**：
   - 运行中 / 已打开的会话（`sessions.get(sessionId) !== undefined`）一律拒绝删除。
   - 严格校验路径与请求合法性，先删文件后做账目，保持幂等性。
   - 不删除 `~/.dsh/attachments/` 下的共享附件对象。
4. **多语言同步**：
   - 新增或修改面向用户的文案时，需同步维护中文与英文（`lib/client.js` 内 `TEXT` 表及 `locale/*.json`）。
5. **文档同步**：
   - 行为、路由、配置或安装方式变更时，同步更新 `README.md` 的中英文内容。
