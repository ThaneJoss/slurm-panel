# Slurm Panel

[English](README.en.md)

使用 **Node.js + pnpm** 的只读实验进度面板。展示 Slurm 常驻消费者背后的 gpuq 实际任务、训练脚本报告的进度和日志。后端直接读取 SQLite 与文件，不需要 Python Web 服务，也没有第三方运行时依赖。

项目提供虚构数据演示，可在没有 Slurm、GPU 或 gpuq 的电脑上启动。真实数据模式对接本文档描述的自定义 gpuq SQLite 结构；已有 Slurm 集群需要先提供相应的数据适配器。

![Slurm Panel 虚构数据演示](docs/assets/demo.png)

## 功能

- 任务状态汇总，按名称、任务 ID 和状态筛选。
- 查看消费者心跳、Slurm 作业 ID、任务尝试历史及退出状态。
- 展示训练脚本报告的 epoch、batch、更新步数、损失、吞吐与预算进度。
- 查看队列日志、项目日志，切换来源并跟随更新。
- 定时刷新，适配桌面和手机屏幕。
- 配置标题、时区及已有 Slurm-web 的跳转地址。

面板只提供查询，不提交、取消或重试任务，不探测 GPU。预算百分比和预算结束时间来自训练脚本，不代表验证和最终评估已经完成。

## 快速开始

需要 Node.js **24 或更新版本**和 pnpm **12.4.2**；安装方法见 [pnpm 官方文档](https://pnpm.io/installation)。

```bash
pnpm install --frozen-lockfile
pnpm demo
```

打开 <http://127.0.0.1:5013>。演示模式使用仓库中的虚构数据，不读取真实队列。`pnpm demo` 会强制使用演示模式，即使本地 `.env` 配置了其他模式。

开发时运行 `pnpm dev`，Node.js 会在服务源码变化时重新启动。静态前端使用原生 ES modules，修改后刷新浏览器即可；无需编译前端。

## 连接真实队列

```bash
cp .env.example .env
```

修改 `.env`：

```dotenv
PANEL_MODE=gpuq
GPUQ_DATABASE=/srv/gpuq/state/queue.sqlite3
HOST=127.0.0.1
PORT=5013
PANEL_TITLE=Slurm Panel
```

```bash
pnpm start
```

运行面板的用户需要读取数据库、SQLite WAL/SHM 文件和相关日志/进度目录的权限。数据库以只读方式打开，程序不会创建或初始化队列。gpuq 调度器独立运行；现有任务提交与调度流程继续由它负责。

真实模式会显示任务名称、命令、工作目录、日志路径与日志正文，其中可能包含私有信息。默认仅监听本机回环地址。通过内网或已经配置身份验证的反向代理提供访问；面板本身不提供登录功能。公开发布源码时，不要将真实队列文件和 `.env` 加入仓库。

参见 [数据接入](docs/data-source.md)、[配置和接口](docs/configuration.md) 与 [部署说明](docs/deployment.md)。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PANEL_MODE` | `demo` | `demo` 使用虚构数据；`gpuq` 读取真实队列 |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `5013` | HTTP 端口 |
| `GPUQ_DATABASE` | 无 | `gpuq` 模式必须配置的数据库绝对路径 |
| `GPU_METRICS_FILE` | 无 | 调度侧 GPU 指标 JSON 快照的绝对路径 |
| `PANEL_CLUSTER_NAME` | `SLURM` | 页首集群名称 |
| `PANEL_TITLE` | `实验进度` | 页面标题 |
| `SLURM_WEB_URL` | 无 | 可选的 Slurm-web HTTP(S) 地址 |
| `TZ` | 无 | 可选 IANA 时区；未设置时前端使用浏览器时区 |
| `REFRESH_INTERVAL_MS` | `5000` | 自动刷新间隔，毫秒 |

## 项目结构

```text
src/server/       HTTP 服务、配置与路由
src/data/         gpuq SQLite 适配器与演示数据适配器
public/           原生 JavaScript、HTML 与 CSS
examples/         可公开的虚构演示数据
tests/            Node.js 数据层和 HTTP 接口测试
e2e/check-ui.js   Playwright 浏览器回归入口
deploy/           systemd 和 Docker Compose 示例
docs/             接入、配置与部署说明
```

## 开发与验证

`pnpm dev` 无需构建。`pnpm install` 会安装开发依赖；后端和页面运行没有第三方依赖。

- `pnpm test` 使用 Node.js 内置测试运行器。
- `pnpm test:browser` 使用 Playwright 1.61.1 执行浏览器回归。

首次运行浏览器回归前安装 Chromium：

```bash
pnpm exec playwright install chromium
```

需要遵循 Slurm 调度约定的环境，应将两个测试命令提交给调度器，例如：

```bash
gpuq submit --name slurm-panel-tests --cwd /opt/slurm-panel -- pnpm test
gpuq submit --name slurm-panel-browser --cwd /opt/slurm-panel -- pnpm test:browser
```

使用调度器日志和任务退出状态确认测试结果。Git 提交和 Pull Request 使用中文说明；提交前确认没有包含真实数据库、日志、环境配置或本机专属部署信息。

## 许可证

[MIT](LICENSE)
