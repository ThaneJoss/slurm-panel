# 部署

示例路径统一使用 `/opt/slurm-panel` 和 `/srv/gpuq`，请按自己的环境调整。源码公开发布与真实队列公开访问是两件事；真实日志应通过内网或具有身份验证的反向代理提供访问。

## Node.js 服务

安装 Node.js 24+ 和 pnpm 12.4.2，将项目放到部署目录，运行：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

设置监听地址、数据模式和数据库路径，使用 `pnpm start` 前台启动。项目没有前端编译步骤，也没有第三方运行时依赖。生产环境的进程管理器也可直接执行：

```bash
node --env-file-if-exists=.env src/server/index.js
```

使用已有反向代理时将流量转发到 `http://127.0.0.1:5013`，配置访问认证后再开放真实数据入口。

## systemd

[slurm-panel.service](../deploy/slurm-panel.service) 提供系统服务模板。使用前准备独立服务用户、项目目录和 `.env`，调整 `User`、`Group`、`WorkingDirectory`、`EnvironmentFile` 与 Node.js 的实际路径，再安装该单元：

```bash
sudo cp deploy/slurm-panel.service /etc/systemd/system/slurm-panel.service
sudo systemctl daemon-reload
sudo systemctl enable --now slurm-panel
journalctl -u slurm-panel -n 50 --no-pager
```

模板通过 `EnvironmentFile` 加载配置。默认只读部署中，服务用户需能读取队列与日志。无需重启 Slurm 或 gpuq 消费者来运行面板。

## GPU 监控与 ETA 历史

HTTP 服务只读取监控快照。使用仓库附带的独立 [GPU 采集单元](../deploy/gpu-metrics.service) 时，先按实际环境调整服务用户、工作目录、Node.js 和 `nvidia-smi` 路径。该用户需能读取 NVIDIA 全机状态和 `/proc` 进程归属；采集不按用户名或 gpuq 任务过滤，也不影响调度。

采集单元使用以下变量：

| 变量 | 默认值/要求 | 含义 |
| --- | --- | --- |
| `GPU_METRICS_FILE` | 必填绝对路径 | 当前快照及最近采样历史 |
| `GPU_METRICS_INTERVAL_MS` | `5000` | 采样间隔，毫秒 |
| `NVIDIA_SMI_COMMAND` | `nvidia-smi` | 独立采集服务使用的可执行文件 |

例如将采集快照写入 `/var/lib/slurm-panel/gpus.json`，在面板 `.env` 中配置同一路径，并可启用 ETA 历史持久化：

```dotenv
GPU_METRICS_FILE=/var/lib/slurm-panel/gpus.json
ETA_STATE_FILE=/var/lib/slurm-panel/eta.json
```

面板与采集器使用相同服务账户读取受限文件，状态目录需对写入它的服务可写。示例单元使用 `StateDirectory=slurm-panel` 创建 `/var/lib/slurm-panel`；自定义路径时相应配置目录权限和 systemd 写入范围。ETA 文件由面板写入，GPU 文件由采集器写入，队列数据库仍只读。

```bash
sudo cp deploy/gpu-metrics.service /etc/systemd/system/slurm-panel-gpu-metrics.service
sudo systemctl daemon-reload
sudo systemctl enable --now slurm-panel-gpu-metrics
sudo systemctl restart slurm-panel
```

采集器每 5 秒原子替换快照，显存显示当前占用，利用率按最近 300 秒时间加权平均；不足 5 分钟时页面注明实际采集窗口。采集失败将状态写为不可用，不把旧值或缺失值改为 0。面板将超过 30 秒的快照视为过期。采样历史随快照保存，重启采集器后可继续滚动窗口。

面板在没有访问者时也每 5 秒采集任务进度。`ETA_STATE_FILE` 可选，省略时采样历史仅保存在内存。独立监控不要求在日常提交和任务跟进中手动运行 `gpuq status` 或 GPU 探测。

## Docker 演示

```bash
docker compose -f deploy/compose.yaml up -d --build
```

打开 <http://127.0.0.1:5013>。Compose 示例固定使用演示数据，仅将宿主机回环地址映射到容器端口。镜像直接运行 Node.js，无需在镜像中安装 pnpm 或 Python。

## Docker 接入真实队列

容器内需要同时访问 SQLite 文件、WAL/SHM 文件，以及数据库记录所指向的进度和日志文件。**挂载目标必须保留原有绝对路径**，这样数据库中的路径在容器中才能解析。只挂载数据库主文件无法完整接入。

下面以全部任务产物位于 `/srv/gpuq` 为例：

```bash
docker build -t slurm-panel .
docker run -d --name slurm-panel \
  --user "$(id -u):$(id -g)" \
  --read-only \
  --tmpfs /tmp \
  -p 127.0.0.1:5013:5013 \
  -e HOST=0.0.0.0 \
  -e PANEL_MODE=gpuq \
  -e GPUQ_DATABASE=/srv/gpuq/state/queue.sqlite3 \
  --mount type=bind,src=/srv/gpuq,dst=/srv/gpuq,readonly \
  slurm-panel
```

任务产物分布在其他目录时，逐一添加保留绝对路径的只读挂载。`--user` 应对应有读取权限的 UID/GID；数据库和日志由其他用户组管理时，还需要配置相应的只读访问权限。不要为了面板而放开整个队列目录的写权限。

## 启用真实任务取消

演示模式中的取消操作仅修改虚构数据。接入真实队列后，面板默认保持只读；只有需要由面板取消任务时才设置：

```dotenv
ENABLE_JOB_CONTROL=1
JOB_CONTROL_TOKEN=replace-with-your-operator-token
GPUQ_COMMAND=/usr/local/bin/gpuq
PANEL_PUBLIC_ORIGIN=https://panel.example.com
```

令牌通过部署环境提供，不能提交到仓库。服务用户必须已有取消目标 gpuq 任务的权限，且 `GPUQ_COMMAND` 指向现有命令；后端调用固定参数 `gpuq cancel <任务 ID>`，不经 shell 执行。HTTP 成功响应只说明取消请求已提交，界面随后根据队列记录显示实际状态。

默认 Docker 镜像包含面板程序和演示数据。若要在容器里启用真实取消，还需要自行提供可用的 gpuq CLI 及其已有调度环境；单独只读挂载数据库不能赋予取消能力。宿主机已有 gpuq 时可使用 Node.js/systemd 部署。

## 发布源码

仓库仅包含程序、虚构演示数据、文档和部署模板。`.gitignore` 排除环境文件、数据库及其 WAL/SHM、日志和依赖目录。发布前检查 Git 暂存区中的实际文件，确认本地部署配置和真实任务产物没有被加入版本控制。MIT 许可证位于仓库根目录。
