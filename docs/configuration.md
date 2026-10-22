# 配置和 HTTP 接口

`PANEL_CLUSTER_NAME` 设置页首集群名称，默认 `SLURM`；`PANEL_TITLE` 默认 `实验进度`。可选 `GPU_METRICS_FILE` 必须是调度侧 GPU 指标快照的绝对路径，该路径不通过公共配置接口返回。

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

`workers[].job_ids` 包含对应 GPU 的全部活跃任务 ID；`state` 为 `running`、`idle` 或没有心跳记录时的 `unknown`。`metrics` 来自外部快照，缺失时为 `null`。

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

每条任务包含 `id`、`name`、`argv`、`cwd`、`state`、`created`、`updated`、`attempt_count`、`message`、最新 `attempt` 和 `telemetry`。详情额外包含 `attempts` 和 `logs`。提交环境不作为接口字段返回，服务端仅从指定的输出目录变量中查找进度文件。

响应不缓存。静态资源由同一个 Node.js HTTP 服务提供，不需要外部 CDN、跨域配置或独立前端服务器。

## 操作能力

`capabilities` 包含 `cancelJobs`、`cancellationRequiresToken`、`artifacts` 和 `logDownload`。前端据此显示可用操作。产物接口仅返回关联目录的文件信息；完整日志下载使用任务详情中已列出的日志来源键，客户端不能指定文件路径。

真实模式默认不开放取消操作。配置 `ENABLE_JOB_CONTROL=1` 时还必须提供 `JOB_CONTROL_TOKEN`。`GPUQ_COMMAND` 可指定已有 gpuq 可执行文件，默认从 `PATH` 查找 `gpuq`。这些值只留在服务端。

取消请求需要 `Content-Type: application/json` 与 JSON 对象请求体，例如 `{}`。真实模式还需要 `Authorization: Bearer <操作令牌>`。带有 `Origin` 的请求必须匹配页面来源；通过 HTTPS 反向代理访问时，用 `PANEL_PUBLIC_ORIGIN=https://panel.example.com` 指定实际来源，不能包含路径。

成功向真实队列发送命令返回 `202` 和 `state: "cancellation_requested"`，表示请求已经提交；任务是否停止仍以随后读取的队列状态为准。演示模式只修改内存中的虚构任务，返回 `200` 和 `state: "cancelled"`。已结束的任务返回 `409`；未启用取消操作返回 `403`；令牌缺失或错误返回 `401`。
