# Codex Account Switcher / Codex切号器

Codex Account Switcher 是一个面向 Windows 的 Codex切号器、Codex账号切换工具，用来管理多个 ChatGPT 登录型 Codex 账号。它会加密保存每个账号的 `auth.json` 快照，并在切换账号时原子覆盖当前用户的 `%USERPROFILE%\.codex\auth.json`。

常见搜索词：Codex切号器、codex切号器、Codex账号切换、codex账号切换、Codex账号切号、codex账号切号、Codex切换账号、codex切换账号、Codex多账号、codex多账号、Codex账号管理、ChatGPT账号切换、OpenAI账号切换。

## 功能

- 通过浏览器登录添加账号，登录失败时可自动切换到设备码登录。
- 导入当前 Live `auth.json`，或一次多选导入多个 JSON 文件。
- 导出账号为多个独立 JSON 文件，每个账号一个，文件名按昵称/邮箱生成。
- 切换账号前自动备份现有 Live `auth.json`。
- 刷新账号邮箱、套餐、5 小时额度、7 天额度和状态。
- 批量刷新使用有限并发，避免大量账号串行等待。
- 支持额度筛选、额度排序、复制账号、删除账号和一键预热。

## 界面操作

- `添加账号`：启动 Codex app-server 登录流程，并通过浏览器完成授权。
- `导入当前 Live`：把当前 `%USERPROFILE%\.codex\auth.json` 加入账号列表。
- `从 JSON 导入`：支持多选标准 `auth.json` 文件；导入后会自动刷新本次导入的账号信息。
- `导出 JSON`：选择目录后，为每个账号写出一个明文 JSON 文件。
- `刷新全部`：并发刷新列表中的账号信息。
- `一键预热`：对命中条件的账号发送一次最小消息，促使额度数据更新。

## 项目结构

```text
src/main/              Electron 主进程、账号服务、Codex RPC、存储和打包路径
src/preload/           安全暴露给渲染层的 IPC API
src/renderer/          React 单页界面
src/shared/            主进程和渲染层共用类型、额度展示逻辑
resources/             可选放置随包分发的 Codex 可执行文件
```

关键文件：

- `src/main/index.ts`：窗口创建、IPC 注册、导入导出对话框。
- `src/main/account-service.ts`：账号导入、导出、切换、刷新、预热和删除。
- `src/main/codex-rpc.ts`：通过 `codex app-server` 做 JSON-RPC 通信。
- `src/main/crypto-blob.ts`：用 Electron `safeStorage` 加密/解密账号快照。
- `src/main/auth-atomic.ts`：备份和原子写入 Live `auth.json`。
- `src/renderer/src/App.tsx`：桌面端主界面。

## 数据位置

- 账号元数据和加密快照：Electron `userData` 下的 `data/` 目录，通常在 `%APPDATA%\codex-account-switcher\data\`。
- Live 认证文件：`%USERPROFILE%\.codex\auth.json`。
- 切换账号前备份：`%USERPROFILE%\.codex\auth.json.bak.<timestamp>`。

本地保存的账号快照使用 Electron `safeStorage` 加密。导出的 JSON 文件是明文凭据，等同账号登录令牌备份，不要提交到 Git、网盘共享目录或聊天窗口。

## Codex CLI

应用需要能运行 `codex app-server`。解析顺序：

1. 打包资源目录中的 `resources/codex.exe`、`codex.cmd` 或 `codex`。
2. Windows `where codex`。
3. 当前 `PATH`。
4. `%APPDATA%\npm\codex.cmd`。
5. Node 安装目录和常见本地安装目录。

如果没有找到 Codex CLI，刷新额度、登录添加和预热会失败。

## 开发

```bash
npm install
npm run dev
```

## 测试

```bash
npm test
```

## 构建

```bash
npm run build
```

构建流程先运行 `electron-vite build`，再用 `electron-builder` 输出 Windows portable 和 NSIS 安装包。产物目录是 `release-fixed/`。

`package.json` 中使用 `cross-env CSC_IDENTITY_AUTO_DISCOVERY=false`，用于避免未配置代码签名环境时被自动签名流程阻断。

## 调试预热

可通过环境变量或参数导出单个账号的预热诊断信息：

```bash
CODEX_DEBUG_WARMUP_ID=<account-id> CODEX_DEBUG_OUT=warmup-debug.json npm run dev
```

或：

```bash
npm run dev -- --debug-warmup <account-id> --debug-out warmup-debug.json
```

`warmup-debug.json` 可能包含账号和请求诊断信息，不要提交。

## 常见问题

### 找不到 Codex CLI

确认终端中能执行 `codex app-server`，或把可执行文件放入 `resources/` 后重新打包。

### 账号显示 app-server 失败

通常是 Codex CLI 不可用、登录状态过期、网络失败或 app-server 协议调用失败。可以先刷新单个账号，仍失败再重新登录或重新导入该账号的 `auth.json`。

### Live 与列表高亮不一致

应用使用稳定指纹匹配 Live `auth.json` 和账号列表。若 token 刷新导致原始指纹变化，列表刷新时会尝试补齐稳定指纹；仍不匹配时可使用 `导入当前 Live`。

### safeStorage 不可用

本工具依赖 Electron `safeStorage`。如果系统加密能力不可用，账号快照无法加密保存，需要先修复系统凭据/加密环境。

## 安全提醒

- 加密快照只适合保存在本机应用数据目录。
- `导出 JSON` 输出的是明文 `auth.json`，请按密钥文件处理。
- 不要把真实 `auth.json`、导出目录、`.enc` 快照或调试输出提交到仓库。
- 项目默认忽略构建产物和本地工作记录，发布前仍建议执行一次敏感词扫描。
