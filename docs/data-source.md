# 数据接入

## 数据边界

Slurm Panel 的真实模式读取既有 gpuq 队列的 SQLite 数据库，以及任务关联的日志和进度文件。Slurm 作业 ID 对应常驻消费者；任务列表中的 ID 对应 gpuq 实验任务，两者不互换。

本项目不包含调度器、训练代码或 Slurm 安装脚本，也不调用 Python 后端或 shell 命令获取数据。纯 Slurm 集群需要实现适配器，将集群数据转换为同样的任务、消费者和日志结构。

## SQLite 结构

当前适配器使用以下表。字段类型和其余字段由外部 gpuq 维护，面板不执行迁移。

| 表 | 读取的主要字段 |
| --- | --- |
| `jobs` | `id`, `name`, `argv`, `cwd`, `environment`, `state`, `created`, `updated`, `attempt_count`, `message` |
| `attempts` | `job_id`, `number`, `gpu`, `state`, `slurm_job_id`, `log_path`, `created`, `started`, `finished`, `exit_code`, `message` |
| `workers` | `gpu`, `slurm_job_id`, `heartbeat` |
| `meta` | `key`, `value`；使用 `paused` 与 `manager_heartbeat` |

`argv` 是 JSON 字符串数组，`environment` 是 JSON 对象。`environment` 只在服务端用于定位产物目录，不对客户端公开。不要将真实数据库复制进仓库作为示例。

数据库通过 Node.js 内置的 [`node:sqlite`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) 以只读方式打开。读取活跃 WAL 数据库时，面板需要访问同目录下的 `-wal`、`-shm` 文件；不要只复制单独的 `.sqlite3` 主文件来展示正在更新的队列。

## 进度文件

适配器从任务的工作目录、输出参数及指定环境变量定位候选目录：

- 环境变量：`V6B_OUTPUT`、`OUTPUT_DIR`、`RUN_DIR`、`TRAIN_OUTPUT_DIR`。
- 命令参数：`--output`、`--output-dir`、`--run-dir`，支持分开和值使用等号两种形式。
- 绝对路径 shell 脚本的父目录，以及任务工作目录。

相对路径以任务工作目录为基准。输出参数指向普通文件时，不会将它当作目录扫描。目录中的 `status.json` 和 `progress.json` 限制为 1 MiB；尝试日志中的结构化 JSON 行也可提供进度。

只接受任务创建之后的进度文件。有 `queue.GPUQ_JOB_ID` 时必须与当前任务 ID 匹配，避免把复用目录中的其他任务进度显示到当前任务。多个来源按文件更新时间选取最新的一份；进行中的 JSON 文件暂时不完整时，下次刷新继续读取。

常见字段包括 `phase`/`state`、`epoch`、`batch`、`updates`、`progress_percent`、损失、训练吞吐与预算截止时间。没有结构化进度时，任务状态和日志仍可查询。所有指标都来自训练脚本，不由面板推断实验成绩或完成状态。

## 日志

尝试日志来源由数据库中的 `log_path` 决定。项目日志仅查找候选目录中的 `run.log` 和 `train.log`，并检查修改时间。日志接口只接受任务详情已列出的来源键，每次最多返回尾部 256 KiB，移除终端 ANSI 控制序列。

日志可能含有命令输出、文件路径或凭据。接入真实队列前，应按实际数据范围设置服务账户的读取权限和访问入口。

## 新适配器

数据层接口为 `listJobs()`、`getJob(id)`、`getLog(id, key)` 和 `close()`。不存在的任务或日志来源返回 `null`。参考 `src/data/` 中的虚构数据实现和 SQLite 实现；HTTP 服务负责路由与响应，不参与队列调度。
