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

列表查询在 SQLite 中对全部历史执行筛选、统计和分页，不再以最近 200 条作为完整历史。每次请求只读取当前页及活跃任务的进度文件；已经结束且未显示的实验不扫描文件。GPU 执行器关联从全部活跃任务建立，与当前页、搜索和状态筛选无关。

数据库通过 Node.js 内置的 [`node:sqlite`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) 以只读方式打开。读取活跃 WAL 数据库时，面板需要访问同目录下的 `-wal`、`-shm` 文件；不要只复制单独的 `.sqlite3` 主文件来展示正在更新的队列。

## 进度文件

适配器从任务的工作目录、输出参数及指定环境变量定位候选目录：

- 环境变量：`V6B_OUTPUT`、`OUTPUT_DIR`、`RUN_DIR`、`TRAIN_OUTPUT_DIR`。
- 命令参数：`--output`、`--output-dir`、`--run-dir`，支持分开和值使用等号两种形式。
- 绝对路径 shell 脚本的父目录，以及任务工作目录。

相对路径以任务工作目录为基准。输出参数指向普通文件时，不会将它当作目录扫描。目录中的 `status.json` 和 `progress.json` 限制为 1 MiB；尝试日志中的结构化 JSON 行也可提供进度。

只接受任务创建之后的进度文件。有 `queue.GPUQ_JOB_ID` 时必须与当前任务 ID 匹配，避免把复用目录中的其他任务进度显示到当前任务。多个来源优先使用带有记录时间的结构化日志（`record`）和独立进度文件（`file`），按各自记录时间或文件修改时间选择较新的一份；只有这些来源都不可用时，才使用面板观察到的无时间字段日志（`observed`）。进行中的 JSON 文件暂时不完整时，下次刷新继续读取。

常见字段包括 `phase`/`state`、`epoch`、`batch`、`updates`、`progress_percent`、损失、训练吞吐与预算截止时间。没有结构化进度时，任务状态和日志仍可查询。所有指标都来自训练脚本，不由面板推断实验成绩或完成状态。

`total_epochs`、`epochs` 或 `max_epochs` 可报告总轮数，也可从提交命令中的 `--epochs`、`--max-epochs`、`--num-epochs` 读取。只有没有预算百分比且同时知道当前轮数和总轮数时，才生成轮数百分比；已有预算百分比保留其语义。`eta_seconds` 或 `estimated_remaining_seconds` 是脚本报告的剩余秒数，不从训练预算推断完整任务的完成时间。

`tags` 仅解析命令中明确报告的 `--stride`、`--seed` 与轮数。已开始的运行任务超过 10 分钟没有结构化进度更新时，返回 `stale: true` 和实际经过秒数，供界面提示；它不修改队列状态或训练行为。

进度时间通过 `updated_source` 区分：`record` 是结构化日志中的 `timestamp`、`updated_at`、`time` 或 `updated`；`file` 是独立进度 JSON 文件的修改时间；`observed` 是缺少时间字段的日志记录被面板首次观察或内容变化的时间。普通文本日志追加不会刷新已观察结构化记录的时间。面板首次读取没有时间的旧日志时，无法倒推它此前已静默多久，重启面板也会重新建立这类观察记录；它不代表脚本实际更新时间。存在带时间的记录或独立进度文件时，优先使用这些来源。

## GPU 指标快照

`GPU_METRICS_FILE` 指向调度器或既有 exporter 生成的 JSON 文件。面板不执行 GPU 探测命令，未提供数据时返回 `metrics: null`。支持规范化结构：

```json
{
  "gpus": [{
    "gpu": 0,
    "utilization_percent": 96,
    "memory_used_bytes": 19971597926,
    "memory_total_bytes": 25769803776,
    "updated": 1800000000
  }]
}
```

也支持现有 `gpuq status --json` 的 `utilization`、`total_mib` 和 `free_mib` 字段。MiB 转为字节；没有 `updated` 时使用快照文件的修改时间。响应只包含标准化指标和快照时间，不包含 exporter 的其他字段或源文件路径。执行器状态仅表示队列当前记录的任务关联；心跳时间单独展示，不将它等同于硬件利用率。

例如，既有调度侧定时导出步骤可原子替换快照文件（此命令应由调度侧运行）：

```bash
gpuq status --json > /srv/gpuq/metrics/gpus.json.tmp
mv /srv/gpuq/metrics/gpus.json.tmp /srv/gpuq/metrics/gpus.json
```

## 产物元数据

`getArtifacts(id)` 只检查提交环境中的输出目录和明确的输出命令参数，返回目录、文件名、路径、大小和修改时间。只列出模型、结构化结果和图像等已知产物类型，最多 200 个，不读取正文、不递归进入子目录、不跟随目录条目中的软链接。未明确指定输出路径时返回空列表，不将整个项目工作目录当作产物。

## 日志

尝试日志来源由数据库中的 `log_path` 决定。项目日志仅查找候选目录中的 `run.log` 和 `train.log`，并检查修改时间。日志接口只接受任务详情已列出的来源键，每次最多返回尾部 256 KiB，移除终端 ANSI 控制序列。

日志可能含有命令输出、文件路径或凭据。接入真实队列前，应按实际数据范围设置服务账户的读取权限和访问入口。

## 新适配器

数据层接口为 `listJobs(options)`、`getJob(id)`、`getLog(id, key)`、`getLogSource(id, key)`、`getArtifacts(id)` 和 `close()`。不存在的任务或日志来源返回 `null`。`getLogSource` 只返回任务已公布日志的来源，不接受任意路径。演示适配器额外提供内存中的 `cancelJob(id)`，仅影响当前演示进程中的虚构任务。参考 `src/data/` 中的两种实现；HTTP 服务负责路由与响应。
