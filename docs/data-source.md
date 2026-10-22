# 数据接入

## 数据边界

Slurm Panel 的真实模式读取既有 gpuq 队列的 SQLite 数据库，以及任务关联的日志和进度文件。Slurm 作业 ID 对应常驻消费者；任务列表中的 ID 对应 gpuq 实验任务，两者不互换。

本项目不包含调度器、训练代码或 Slurm 安装脚本。HTTP 服务直接读取 SQLite 和文件；独立 GPU 采集服务通过固定参数调用 `nvidia-smi`，不在网页请求中探测硬件。纯 Slurm 集群需要实现适配器，将集群数据转换为同样的任务、消费者和日志结构。

## SQLite 结构

当前适配器使用以下表。字段类型和其余字段由外部 gpuq 维护，面板不执行迁移。

| 表 | 读取的主要字段 |
| --- | --- |
| `jobs` | `id`, `name`, `argv`, `cwd`, `environment`, `state`, `created`, `updated`, `attempt_count`, `message` |
| `attempts` | `job_id`, `number`, `gpu`, `state`, `slurm_job_id`, `log_path`, `created`, `started`, `finished`, `exit_code`, `message` |
| `workers` | `gpu`, `slurm_job_id`, `heartbeat` |
| `meta` | `key`, `value`；使用 `paused` 与 `manager_heartbeat` |

`argv` 是 JSON 字符串数组，`environment` 是 JSON 对象。服务端只读取指定输出目录提示与可选的 `PANEL_DISPLAY_NAME`，不公开完整提交环境。任务保留原始 `name`，以 `display_name` 提供精简标题。新任务建议直接使用简短名称，将种子、轮数、权重、日期和恢复参数留在命令与配置中。不要将真实数据库复制进仓库作为示例。

列表查询在 SQLite 中对全部历史执行筛选、统计和分页，不再以最近 200 条作为完整历史。请求只读取当前页及活跃任务的进度文件；面板另每 5 秒后台采样活跃任务，浏览器关闭后也继续。已经结束且未显示的实验不扫描文件。本队列的 GPU 任务关联从全部活跃任务建立，与当前页、搜索和状态筛选无关；全机进程另由监控快照提供。

数据库通过 Node.js 内置的 [`node:sqlite`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) 以只读方式打开。读取活跃 WAL 数据库时，面板需要访问同目录下的 `-wal`、`-shm` 文件；不要只复制单独的 `.sqlite3` 主文件来展示正在更新的队列。

## 进度文件

适配器从任务的工作目录、输出参数及指定环境变量定位候选目录：

- 环境变量：`V6B_OUTPUT`、`OUTPUT_DIR`、`RUN_DIR`、`TRAIN_OUTPUT_DIR`。
- 命令参数：`--output`、`--output-dir`、`--run-dir`，支持分开和值使用等号两种形式。
- 绝对路径 shell 脚本的父目录，以及任务工作目录。

相对路径以任务工作目录为基准。输出参数指向普通文件时，不会将它当作目录扫描。目录中的 `status.json` 和 `progress.json` 限制为 1 MiB；尝试日志中的结构化 JSON 行也可提供进度。

只接受任务创建之后的进度文件。有 `queue.GPUQ_JOB_ID` 时必须与当前任务 ID 匹配，避免把复用目录中的其他任务进度显示到当前任务。多个来源优先使用带有记录时间的结构化日志（`record`）和独立进度文件（`file`），按各自记录时间或文件修改时间选择较新的一份；只有这些来源都不可用时，才使用面板观察到的无时间字段日志（`observed`）。进行中的 JSON 文件暂时不完整时，下次刷新继续读取。

推荐字段包括 `phase`、`current_epoch`（从 1 开始的当前轮次）、`completed_epochs`（已完整完成轮数）、`total_epochs`、`batch/batches`（本轮完成批次/总批次）、`updates/total_updates`、损失和训练吞吐。没有结构化进度时，任务状态和日志仍可查询。面板由这些记录计算进度与时间估计，不推断实验成绩或队列完成状态。

`total_epochs`、`epochs` 或 `max_epochs` 可报告总轮数，也可从提交命令中的 `--epochs`、`--max-epochs`、`--num-epochs` 读取。兼容旧 `epoch`：同时有 batch 时按当前轮次理解，否则按已完成轮数理解；`step/planned_steps` 兼容为 `updates/total_updates`。新脚本用明确字段避免轮次歧义。

`telemetry.epoch_percent` 按 `batch/batches` 生成。`telemetry.total_percent` 优先按完整更新步数计算，其次按 `(completed_epochs + batch/batches) / total_epochs` 计算，缺少这些信息时保留明确上报的百分比。兼容字段 `percent/percent_kind` 保留原有预算语义，预算百分比不作为完成工作量外推依据。列表不再展示 seed 和总轮数标签，配置仍保留在 argv 中。已开始的运行任务超过 10 分钟没有结构化进度更新时，返回 `stale: true` 和实际经过秒数，供界面提示；它不修改队列状态或训练行为。

进度时间通过 `updated_source` 区分：`record` 是结构化日志中的 `timestamp`、`updated_at`、`time` 或 `updated`；`file` 是独立进度 JSON 文件的修改时间；`observed` 是缺少时间字段的日志记录被面板首次观察或内容变化的时间。普通文本日志追加不会刷新已观察结构化记录的时间。面板首次读取没有时间的旧日志时，无法倒推它此前已静默多久，重启面板也会重新建立这类观察记录；它不代表脚本实际更新时间。存在带时间的记录或独立进度文件时，优先使用这些来源。

## 加权预计结束时间

面板后台记录各任务、各尝试的真实进度区间，以完成工作量为基础计算耗时，按 300 秒半衰期对近期区间赋予更大权重。跨轮区间实际发生的常规验证耗时会进入样本；不同尝试分别统计，进度回退后重新建立该段历史。重复读取相同记录不生成新样本，普通文本日志追加也不刷新进度时间。

任务的 `estimate` 为 `null` 或 `{remaining_seconds, end_at, scope, method, sample_count, updated}`。`method` 为 `recency_weighted`；没有足够进度变化时不编造时间。默认 `scope=training_and_periodic_validation`，表示训练与观察到的常规验证。脚本明确提供 `final_evaluation_seconds` 时，将其追加并使用 `scope=full_task`；未知最终评估不能被包装为已计入。

可配置 `ETA_STATE_FILE` 持久化采样历史。记录只保存任务/尝试关联及进度时间数据，独立于只读队列数据库；重启面板后恢复。`eta_seconds` 等脚本剩余时间字段保留兼容，但页面预计结束时间采用面板估计，训练预算截止时间不代表完整任务完成。

同一次尝试会保留脚本明确报告的总步数、总轮数和最终评估耗时，后续记录省略时沿用该计划。实际总步数优先于命令中的旧轮数设置；总进度计数使用与百分比相同的单位。明确改变计划或开始新尝试时重新积累对应样本，旧日志重放不覆盖较新的计划。初始化、加载数据等准备阶段不计入训练速率。

## GPU 指标快照

`GPU_METRICS_FILE` 指向独立采集服务或兼容 exporter 生成的 JSON 文件。HTTP 服务不执行 GPU 探测命令，快照缺失、采集失败或超过 30 秒未更新时返回 `metrics: null`。规范化结构：

```json
{
  "gpus": [{
    "gpu": 0,
    "utilization_percent": 70,
    "utilization_5m_percent": 65,
    "utilization_window_seconds": 300,
    "memory_used_bytes": 12884901888,
    "memory_total_bytes": 25769803776,
    "process_count": 1,
    "processes": [{
      "pid": 1234,
      "user": "researcher",
      "name": "python",
      "type": "C",
      "memory_used_bytes": 12884901888
    }],
    "updated": 1800000000
  }]
}
```

仓库的 [GPU 采集服务](../scripts/gpu-metrics.js) 每 5 秒获取全机显卡状态与所有用户的计算/图形进程，并原子替换快照。显存是当前值，`utilization_5m_percent` 是最近 300 秒的时间加权平均；初始不足 5 分钟时，`utilization_window_seconds` 表示实际窗口。进程仅公开 PID、用户名、程序 basename、类型和显存，不采集完整命令行。采集历史随快照保存，重启后继续形成同一滚动窗口。

也支持现有快照的 `utilization/total_mib/free_mib`，MiB 转为字节；无 `updated` 时使用快照文件修改时间。只有瞬时利用率时不会伪称 5 分钟均值。未知值保留 `null`，真实 0 保留 0。GPU 状态由全机指标生成，不再仅凭本队列 `job_ids` 判断；消费者心跳仍独立展示。部署方式见 [部署说明](deployment.md#gpu-监控与-eta-历史)。

## 产物元数据

`getArtifacts(id)` 只检查提交环境中的输出目录和明确的输出命令参数，返回目录、文件名、路径、大小和修改时间。只列出模型、结构化结果和图像等已知产物类型，最多 200 个，不读取正文、不递归进入子目录、不跟随目录条目中的软链接。未明确指定输出路径时返回空列表，不将整个项目工作目录当作产物。

## 日志

尝试日志来源由数据库中的 `log_path` 决定。项目日志仅查找候选目录中的 `run.log` 和 `train.log`，并检查修改时间。日志接口只接受任务详情已列出的来源键，每次最多返回尾部 256 KiB，移除终端 ANSI 控制序列。

日志可能含有命令输出、文件路径或凭据。接入真实队列前，应按实际数据范围设置服务账户的读取权限和访问入口。

## 新适配器

数据层接口为 `listJobs(options)`、`getJob(id)`、`getLog(id, key)`、`getLogSource(id, key)`、`getArtifacts(id)` 和 `close()`。不存在的任务或日志来源返回 `null`。`getLogSource` 只返回任务已公布日志的来源，不接受任意路径。演示适配器额外提供内存中的 `cancelJob(id)`，仅影响当前演示进程中的虚构任务。参考 `src/data/` 中的两种实现；HTTP 服务负责路由与响应。
