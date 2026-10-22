# 配置和 HTTP 接口

`pnpm start` 与 `pnpm dev` 从项目工作目录加载可选的 `.env` 文件，已经导出的环境变量优先。`pnpm demo` 强制选择演示数据，其余监听和显示配置仍可使用环境变量。

完整变量表见 [README](../README.md#配置)。`GPUQ_DATABASE` 使用绝对路径；真实模式必须指向已经存在的队列。`SLURM_WEB_URL` 仅接受 HTTP(S) 地址。`TZ` 为可选的 IANA 时区，如 `UTC` 或 `Asia/Shanghai`；未设置时，浏览器按访问者的本地时区显示时间。

## 接口

所有接口只接受查询；返回 JSON。时间字段沿用 gpuq 的 Unix 秒时间戳，训练脚本报告的预算截止时间也可能是 ISO 时间字符串。

| 路径 | 内容 |
| --- | --- |
| `GET /api/health` | 服务健康信息 |
| `GET /api/config` | 页面配置 `{title, slurmWebUrl, refreshIntervalMs, timeZone, mode}` |
| `GET /api/jobs` | 最近 200 条任务、消费者、全队列状态计数、调度暂停状态、心跳与服务端当前时间 |
| `GET /api/jobs/:id` | 单任务详情、尝试历史和可用日志来源 |
| `GET /api/jobs/:id/logs/:key` | 选定来源的日志尾部、更新时间与来源路径 |

日志来源的 `key` 由详情接口返回，例如 `attempt-1` 或 `project-2`。客户端不能传入文件路径。不存在的任务或日志来源返回 `404`。

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
