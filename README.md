# Dev Port Manager 🛠️

> 🌐 简体中文 | [English](README.en.md)

本机开发服务器端口管理工具：网页实时查看端口占用、解析进程名与 PID、一键停止进程。

- 后端：Node.js + Express（`lsof` / `ss` / `netstat` 检测端口与定位 PID）
- 前端：React 18（UMD 免构建，运行时已固化在 `public/vendor/`，`npm install` 时自动重建）
- 存储：`ports.json`（自定义端口持久化，自动创建，已加入 `.gitignore`）

> 开源协议：[MIT](./LICENSE)

![界面截图](screenshot.png)

*界面截图：端口列表实时状态、占用进程与 PID、停止进程、添加端口与自动刷新；右上角可切换中英文。*

## 快速开始

前置要求：**Node.js ≥ 16**（React 18 的 UMD 构建已锁定版本，无需任何打包工具）。

```bash
cd dev-port-manager
npm install
npm start
```

浏览器打开 **http://localhost:3081** 即可。

> 工具自身端口可通过环境变量修改：`SERVER_PORT=3082 npm start`

## 功能说明

| 功能 | 说明 |
| --- | --- |
| 预置端口 | `5173、3000、5174、8080、3001`，首次启动自动写入 `ports.json` |
| 添加/删除端口 | 顶栏输入端口号添加；每行「删除」按钮移除（仅移除监控，不影响进程） |
| 状态检测 | 每次刷新实时查询：空闲（绿）/ 占用（红），占用时显示进程名 + PID + 命令行 |
| 停止进程 | 点击「停止进程」：Unix 先 SIGTERM 优雅退出，仍占用则 SIGKILL 兜底 |
| 自动刷新 | 工具栏可选关闭 / 每 3 秒 / 每 5 秒 / 每 10 秒 |
| 错误提示 | 杀不掉（系统进程、权限不足）时返回明确错误，不会静默失败 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ports` | 端口列表 + 实时占用状态 |
| POST | `/api/ports` | 添加端口，body `{ "port": 6001 }` |
| DELETE | `/api/ports/:port` | 从列表移除端口 |
| POST | `/api/kill/:port` | 终止占用该端口的进程 |

## 检测机制（跨平台）

| 平台 | 端口→PID | 进程名 | 终止 |
| --- | --- | --- | --- |
| macOS / Linux | `lsof -nP -iTCP -sTCP:LISTEN`（缺失时降级 `ss -ltnp`；Linux 再无则读 `/proc/net/tcp` + inode 映射） | `ps -o pid=,comm=,args=` | `process.kill` SIGTERM → SIGKILL |
| Windows | `netstat -ano -p tcp` | `tasklist /FO CSV /NH` | `process.kill`（TerminateProcess） |

## 常见问题

- **页面打开空白，控制台报 `ReactDOM is not defined` 或资源 404**：先按 `Ctrl+F5` 强制刷新；确认是从浏览器直接访问 `http://localhost:3081`（不要经过代理/预览窗口）。若为手工复制的副本，重新执行 `npm install`（会重建 `public/vendor` 下的前端运行时）再重启。页面本身内置了加载失败自诊断提示，会直接告诉你是哪个资源没加载。
- **停止失败**：提示「权限不足」→ 用管理员/root 身份重新运行工具；提示「仍被占用」→ 进程忽略信号（如系统服务），需手动处理。
- **工具自身端口被占**：启动时报 `EADDRINUSE`，用 `SERVER_PORT=xxxx` 换端口即可。
- **误删端口**：直接编辑 `ports.json` 把端口加回去，或退出重来（默认端口会在文件损坏/缺失时重建）。删除监控不会终止进程，可放心操作。
- **自我保护**：列表中即使加入工具自身端口，终止请求也会被后端拒绝并给出提示。