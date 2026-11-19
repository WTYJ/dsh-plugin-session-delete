# dsh-plugin-session-delete

[中文](#中文) | [English](#english)

## 中文

给 DeepSeek Harness 侧栏补上官方缺失的**删除会话**能力：会话行「⋯」菜单里多一项「删除会话」，确认后永久删除该会话的全部本地记录。

### 为什么要单独做插件

DSH `0.2.1-rc.2` 的会话 API 只有归档（`workspace/archiveSession`）和取消归档，没有删除。归档只是把会话从侧栏隐藏，日志文件仍在磁盘上。本插件补上真正的删除。

### 功能

| 入口 | 行为 |
|---|---|
| 会话行「⋯」菜单 → **删除会话** | 永久删除该会话的本地记录，不可恢复 |

一次删除会清理：

1. **会话日志目录** `~/.dsh/sessions/<项目目录>/<会话 ID>/`
2. **投影缓存** `~/.dsh/storages/session_projcache/sessions/<会话 ID>.json`
3. **PRTS 检索数据** `~/.dsh/storages/prts_inv_*.json` 中 `sessionId` 指向该会话的文件
4. **账目**：归档该 ID 并从工作区会话列表中摘除，避免残留条目

### 安全设计

- **红色危险确认框**，明示「不可恢复」，并显示会话标题
- **运行中 / 已打开的会话一律拒绝删除**（返回 `live`），防止把正在写入的日志从进程底下抽走
- **沙箱内删除**：`workspace-write` 模式下，以会话所属项目目录为沙箱根，只删 `<root>/<会话ID>/` 这一个目录
- **路径校验**：目标目录必须以会话 ID 结尾、且父目录不等于自身，否则拒绝执行
- **先删文件、后做账目**：文件删除失败时账目完全不变，不会留下「已隐藏但没删掉」的状态
- **幂等**：已删除的会话返回 `missing` 而不是报错

### 实现要点

- **Client 半**用官方 slot API（`sidebar.workspaces.session.menu.item`）注册菜单项，**不克隆 DOM、不用 MutationObserver**，DSH 升级侧栏结构时不容易坏
- **Host 半**只注册一条同源路由 `POST /dsh-plugin-session-delete/delete`，浏览器 `fetch` 调用
- 不 `require` 任何 DSH Client 包（官方明确禁止），菜单按钮用原生元素 + `--dsw-alias-*` 设计变量自绘，主题自动跟随
- 文案跟随 GUI 语言（中文 / English）

### 安装

把整个 `dsh-plugin-session-delete` 目录交给对方，对方任选一种：

**方式 A — 插件管理界面（最简单的推荐方式）**

DSH 设置 → 插件 → 安装，填入该目录的**绝对路径**，例如
`C:\Users\someone\Downloads\dsh-plugin-session-delete`
（从「插件市场」/Plugin Hub 的本地安装入口选择这个文件夹也可以。）

**方式 B — 命令行**

```bash
dsh plugin --profile <profile 名> add "C:\Users\someone\Downloads\dsh-plugin-session-delete"
```

`desktop` profile 由 Electron 应用托管，命令行会拒绝；这种情况用方式 A，或手动方式 C。

**方式 C — 手动**

1. 把目录复制进 `~/.dsh/profiles/<profile>/node_modules/`
2. 在 profile 的 `package.json` 的 `dsh.profile.bundles` 末尾加上 `"dsh-plugin-session-delete"`
3. 重启 DSH

三种方式都要**重启 DSH** 才会加载 client bundle。

### 分发形式

- **目录（推荐）**：直接压缩成 zip 发过去，对方解压后用上面的方式 A 安装。不需要 npm 账号，也没有网络依赖。
- **tarball**：`npm pack` 生成 `.tgz`，对方用 `dsh plugin add <路径>.tgz` 安装。
- **git**：推到 GitHub 等仓库，对方 `dsh plugin add github:用户名/仓库名`。

不要直接用 `dsh-plugin-session-delete` 这个名字从 npm 装——npm 上已有同名的第三方包，内容不同。

### 兼容性

- 开发并验证于 DSH `0.2.1-rc.2`（desktop `0.2.1-rc.2`）
- **无第三方 npm 依赖**：Host 半只用 Node 内置模块（`node:fs/promises`、`node:path`、`node:os`）；Client 半只用平台模块表里的 `react`
- 依赖 Host 服务：`webServer`、`shell`、`sessionPersistence`、`workspaceRegistry`、`sessions`
- 依赖 Client 服务：`slots`、`sessions`、`locale`
- Windows / Linux / macOS

> DSH 版本差异：本插件依赖 `sidebar.workspaces.session.menu.item` 这个 slot 与
> `sessionPersistence.list()/locate()` 的返回形状。若对方 DSH 版本明显不同而菜单项
> 没出现，先确认这两处；插件本身不会因为版本不同而破坏 DSH 启动。

### 已知限制

- 运行中的会话需要先关闭（或重启 DSH）才能删除
- 会话行菜单是 `list` slot，插件通过它注册；若 DSH 大版本改掉这个 slot 名，需要跟进
- 不删除会话引用的附件对象（`~/.dsh/attachments/` 是内容寻址共享存储，可能被其他会话引用）

## English

Adds the **Delete session** capability the DSH sidebar is missing: a "Delete session" row in a session's "⋯" menu that permanently removes every local record of that session after confirmation.

### Why a plugin

DSH `0.2.1-rc.2` exposes archive (`workspace/archiveSession`) but no delete. Archiving only hides a session from the sidebar; its log stays on disk. This plugin performs the real removal.

### What one delete removes

1. The session log directory `~/.dsh/sessions/<project-dir>/<session-id>/`
2. Its projection-cache record `~/.dsh/storages/session_projcache/sessions/<session-id>.json`
3. Any PRTS investigation store under `~/.dsh/storages/prts_inv_*.json` whose `sessionId` names it
4. Its accounting: the id is archived and detached from every Workspace

### Safety

- Danger-styled confirmation naming the session and stating it cannot be undone
- Live sessions are refused (`live`), so no running log is pulled out from under its writer
- Removal runs inside the sandbox with the session's project directory as the `workspace-write` root, targeting exactly `<root>/<session-id>/`
- Path guards: the target must end with the session id and must not be its own parent
- Files are removed before any bookkeeping, so a failure never hides a session it did not delete
- Idempotent: an already-deleted session reports `missing` rather than failing

### Implementation

- The client half registers into the official `sidebar.workspaces.session.menu.item` slot — no DOM cloning, no MutationObserver
- The host half exposes one same-origin route, `POST /dsh-plugin-session-delete/delete`
- No DSH Client package is `require`d; the menu button is a native element styled with `--dsw-alias-*` tokens, so it follows the active theme
- UI text follows the GUI language (Chinese / English)

### Install

```bash
dsh plugin --profile <profile> add /path/to/dsh-plugin-session-delete
```

Or manually: place this directory in the profile's `node_modules` and add the `insert` row shown above to the profile's `cordis.patch.yml`. Restart DSH.

### Compatibility

Verified against DSH `0.2.1-rc.2`. Host services: `webServer`, `shell`, `sessionPersistence`, `workspaceRegistry`, `sessions`. Client services: `slots`, `sessions`, `locale`. Windows / Linux / macOS.

### Known limitations

- A running session must be closed (or DSH restarted) before it can be deleted
- The plugin rides the `sidebar.workspaces.session.menu.item` slot; a major DSH release renaming that slot needs a follow-up
- Attachment objects under `~/.dsh/attachments/` are content-addressed and shared, so they are left alone

## License

MIT
