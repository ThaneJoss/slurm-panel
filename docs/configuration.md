# 配置和 HTTP 接口

`PANEL_CLUSTER_NAME` 设置页首集群名称，默认 `SLURM`；`PANEL_TITLE` 默认 `实验进度`。可选 `GPU_METRICS_FILE` 为独立采集服务或兼容 exporter 的快照绝对路径；`ETA_STATE_FILE` 为面板进度采样历史的持久化绝对路径。两者都不通过公共配置接口返回，也不写入队列数据库。

任务列表 `GET /api/jobs` 支持：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `page` / `pageSize` | `1` / `10` | 每页最多 100 条；超出末页时返回末页 |
| `q` | 空 | 按任务名或 ID 搜索 |
| `state` | `all` | `all`、`active`、`queued`、`succeeded`、`failed`、`cancelled` |
| `sort` | `active` | 运行优先、`newest` 或 `oldest` |
| `range` | `all` | `all`、`24h`、`7d`、`30d`，按任务创建时间筛选 |
| `staleOnly` | `0` | `1` 只返回超过 10 分钟未更新进度的运行任务 |

响应包含 `pagination: {page, pageSize, total, totalPages}`，以及时间范围内的 `summary: {total, active, queued, succeeded, failed, cancelled, stale}`。状态卡统计不受搜索、状态标签或过期提示筛选影响。空结果仍返回第 1 页和 1 个总页数。非法参数返回 HTTP 400。

`workers[].job_ids` 包含对应 GPU 的本队列全部活跃任务 ID。GPU 的 `state` 依据全机快照显示 `running/idle/unknown`，不能只从本队列任务推断整卡空闲。`metrics` 来自外部快照，缺失或超过 30 秒未更新时为 `null`；消费者心跳另行保留。

`GET /api/config` 额外返回 `clusterName` 与 `capabilities`。`artifacts` 和 `logDownload` 为 `true`；`cancelJobs` 在演示模式或真实取消已启用时为 `true`。`cancellationRequiresToken` 仅在真实取消已启用时为 `true`。

`pnpm start` 与 `pnpm dev` 从项目工作目录加载可选的 `.env` 文件，已经导出的环境变量优先。`pnpm demo` 强制选择演示数据，其余监听和显示配置仍可使用环境变量。

完整变量表见 [README](../README.md#配置)。`GPUQ_DATABASE` 使用绝对路径；真实模式必须指向已经存在的队列。`SLURM_WEB_URL` 仅接受 HTTP(S) 地址。`TZ` 为可选的 IANA 时区，如 `UTC` 或 `Asia/Shanghai`；未设置时，浏览器按访问者的本地时区显示时间。

## 接口

查询接口接受 `GET` 和 `HEAD`；取消任务使用单独的 `POST` 接口。除完整日志下载返回文本外，其余接口返回 JSON。时间字段沿用 gpuq 的 Unix 秒时间戳，训练脚本报告的预算截止时间也可能是 ISO 时间字符串。

| 路径 | 内容 |
| --- | --- |
| `GET /api/health` | 服务健康信息 |
| `GET /api/config` | 页面配置、集群名和当前可用交互能力；不返回数据库路径或操作令牌 |
| `GET /api/jobs` | 完整历史上的筛选分页任务、消费者、范围内状态统计、调度暂停状态、心跳与服务端当前时间 |
| `GET /api/jobs/:id` | 单任务详情、尝试历史和可用日志来源 |
| `GET /api/jobs/:id/logs/:key` | 选定来源的日志尾部、更新时间与来源路径 |
| `GET /api/jobs/:id/logs/:key/download` | 以附件下载选定来源的完整日志，保留文件原有文本 |
| `GET /api/jobs/:id/artifacts` | 已知输出目录与产物文件的名称、大小和修改时间 |
| `POST /api/jobs/:id/cancel` | 演示模式取消虚构任务，或经授权向真实 gpuq 请求取消 |

日志来源的 `key` 由详情接口返回，例如 `attempt-1` 或 `project-0-train`。客户端不能传入文件路径。不存在的任务或日志来源返回 `404`。

任务列表保留原面板的响应形状：

```json
{
  "jobs": [],
  "workers": [],
  "counts": {},
  "paused": false,
  "manager_heartbeat": 0,
  "now": 0
}
```

每条任务包含 `id`、原始 `name`、精简的 `display_name`、`argv`、`cwd`、`state`、`created`、`updated`、`attempt_count`、`message`、最新 `attempt`、`telemetry` 和面板计算的 `estimate`。详情额外包含 `attempts` 和 `logs`。提交环境不整体公开；服务端只读取指定输出目录提示和可选的 `PANEL_DISPLAY_NAME`。

`telemetry.epoch_percent` 为本轮进度，`telemetry.total_percent` 为总进度。`estimate` 为 `null` 或 `{remaining_seconds, end_at, scope, method, sample_count, updated}`；`method=recency_weighted` 表示近期加权。`scope=training_and_periodic_validation` 只涵盖训练与观察到的常规验证，明确提供最终评估时长时为 `full_task`。算法与进度字段见 [数据接入](data-source.md)。

`workers[].metrics` 包含当前 `memory_used_bytes/memory_total_bytes`、瞬时 `utilization_percent`、页面采用的 `utilization_5m_percent`、实际均值窗口 `utilization_window_seconds`、`updated`、`process_count` 及全部用户的 `processes`。进程条目为 `{pid, user, name, type, memory_used_bytes}`；`type` 可为计算或图形类型。未知值保持 `null`，瞬时值不能冒充 5 分钟均值。

响应不缓存。静态资源由同一个 Node.js HTTP 服务提供，不需要外部 CDN、跨域配置或独立前端服务器。

## 操作能力

`capabilities` 包含 `cancelJobs`、`cancellationRequiresToken`、`artifacts` 和 `logDownload`。前端据此显示可用操作。产物接口仅返回关联目录的文件信息；完整日志下载使用任务详情中已列出的日志来源键，客户端不能指定文件路径。

真实模式默认不开放取消操作。配置 `ENABLE_JOB_CONTROL=1` 时还必须提供 `JOB_CONTROL_TOKEN`。`GPUQ_COMMAND` 可指定已有 gpuq 可执行文件，默认从 `PATH` 查找 `gpuq`。这些值只留在服务端。

取消请求需要 `Content-Type: application/json` 与 JSON 对象请求体，例如 `{}`。真实模式还需要 `Authorization: Bearer <操作令牌>`。带有 `Origin` 的请求必须匹配页面来源；通过 HTTPS 反向代理访问时，用 `PANEL_PUBLIC_ORIGIN=https://panel.example.com` 指定实际来源，不能包含路径。

成功向真实队列发送命令返回 `202` 和 `state: "cancellation_requested"`，表示请求已经提交；任务是否停止仍以随后读取的队列状态为准。演示模式只修改内存中的虚构任务，返回 `200` 和 `state: "cancelled"`。已结束的任务返回 `409`；未启用取消操作返回 `403`；令牌缺失或错误返回 `401`。
