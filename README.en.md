# Slurm Panel

The dashboard queries complete queue history with server-side filtering, sorting and pagination. Queue assignments cover all active gpuq jobs, while the independent GPU monitor covers every user's compute and graphics processes. HTTP requests read `GPU_METRICS_FILE` snapshots without probing hardware. Set `PANEL_CLUSTER_NAME` for cluster branding and `PANEL_TITLE` for the page title (default: `实验进度`). See [data integration](docs/data-source.md) for snapshot formats and progress semantics.

![Slurm Panel with fictional demo data](docs/assets/demo.png)

[Mobile layout preview](docs/assets/demo-mobile.png)

[简体中文](README.md)

An experiment dashboard built with **Node.js and pnpm**. Live queues are read-only by default, with optional authenticated job cancellation. It displays the actual gpuq tasks managed by persistent Slurm consumers, including training progress, attempt history and logs. The backend reads SQLite and local files directly, with no Python web service or third-party runtime dependencies.

The included demo uses fictional data and runs without Slurm, GPUs or gpuq. Live mode targets the custom gpuq SQLite schema described in [data-source.md](docs/data-source.md); connecting another Slurm deployment requires a matching adapter.

## Run the demo

Requires Node.js **24+** and pnpm **12.4.2**. See the [pnpm installation guide](https://pnpm.io/installation).

```bash
pnpm install --frozen-lockfile
pnpm demo
```

Open <http://127.0.0.1:5013>. The demo command forces fictional data even if `.env` selects live mode. Use `pnpm dev` for server watch mode; the frontend uses native ES modules and needs no build step.

## Connect a queue

```bash
cp .env.example .env
```

Set `PANEL_MODE=gpuq` and an absolute `GPUQ_DATABASE` path, then run `pnpm start`. The service account must be able to read the database, its WAL/SHM files, and the referenced progress/log directories. The database is opened read-only and is never initialized by this app. The external gpuq scheduler continues to handle task submission and scheduling.

Live responses include task commands, working directories, file paths and log content, which may be private. The default listener is loopback only. Provide access through a trusted network or an authenticated reverse proxy; this application has no login system. Keep real queue data and `.env` out of the published repository.

## Features

- Search and filter tasks, with state summaries and consumer heartbeats.
- View Slurm consumer IDs, attempts and exit status.
- Display separate per-epoch and total progress, updates, losses and throughput.
- Calculate end-time estimates from observed progress with greater weight on recent intervals; sample in the background and optionally persist history.
- Show every user's GPU processes, current memory usage and time-weighted utilization over the last five minutes.
- Select and follow queue/project logs with periodic refresh.
- Download complete logs and inspect metadata for associated output files.
- Simulate cancellation in demo mode, or optionally request live cancellation through gpuq with an operator token.
- Responsive layout, configurable title, time zone and Slurm-web link.

Live mode only queries queue data by default. Enabling cancellation requires both `ENABLE_JOB_CONTROL=1` and `JOB_CONTROL_TOKEN`; the backend sends the request through the existing gpuq command, then reads the actual state from the queue. End-time estimates state their scope; unknown final-evaluation time is not presented as included. Budget progress or a zero ETA does not establish completion.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PANEL_MODE` | `demo` | `demo` or `gpuq` |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `5013` | HTTP port |
| `GPUQ_DATABASE` | unset | Required absolute database path in live mode |
| `GPU_METRICS_FILE` | unset | Absolute GPU snapshot path from the independent collector or a compatible exporter |
| `ETA_STATE_FILE` | unset | Optional absolute path for progress history written by the panel |
| `PANEL_CLUSTER_NAME` | `SLURM` | Cluster name |
| `PANEL_TITLE` | `实验进度` | Page title |
| `SLURM_WEB_URL` | unset | Optional HTTP(S) Slurm-web link |
| `TZ` | unset | Optional IANA zone; otherwise the browser's zone |
| `REFRESH_INTERVAL_MS` | `5000` | Refresh interval in milliseconds |
| `ENABLE_JOB_CONTROL` | `0` | Set to `1` to allow live cancellation requests |
| `JOB_CONTROL_TOKEN` | unset | Required server-side operator token for live cancellation |
| `GPUQ_COMMAND` | `gpuq` | Existing executable invoked with fixed cancellation arguments |
| `PANEL_PUBLIC_ORIGIN` | unset | Page origin behind an HTTPS proxy, such as `https://panel.example.com` |

See [configuration and API](docs/configuration.md), [data source](docs/data-source.md) and [deployment](docs/deployment.md), including the independent collector and writable state directory. Use concise job names; a submitted `PANEL_DISPLAY_NAME` can provide a short display title while preserving the recorded name. The detailed guides are in Chinese.

## Development

The source is organized into `src/server/`, `src/data/`, `scripts/`, `public/`, `examples/`, `tests/`, `e2e/`, `deploy/` and `docs/`. `pnpm dev` needs no build step. `pnpm install` includes development dependencies; running the backend and frontend requires no third-party packages.

- `pnpm test` uses the built-in Node.js test runner.
- `pnpm test:browser` runs Playwright 1.61.1 browser regressions through `e2e/check-ui.js`.

The [CI caller](.github/workflows/ci.yml) reuses [ThaneJoss/github-ci](https://github.com/ThaneJoss/github-ci) at `main`, declaring only Node.js 24, pnpm 12.4.2, the lockfile and `pnpm test`. Pull requests, merge queues and updates to `main` run the Node tests and the template's dependency audit; manual dispatch is also available.

The caller uses the template's explicit `node` profile to accommodate native HTML/CSS and deployment files. Browser regressions are separate and run through the Slurm commands below when needed.

Install Chromium once before running browser regressions:

```bash
pnpm exec playwright install chromium
```

In environments that require Slurm for test execution, submit both commands to the scheduler:

```bash
gpuq submit --name slurm-panel-tests --cwd /opt/slurm-panel -- pnpm test
gpuq submit --name slurm-panel-browser --cwd /opt/slurm-panel -- pnpm test:browser
```

Commit messages and Pull Request descriptions use Chinese. Do not commit real databases, logs, local environment settings or machine-specific deployment details.

The redesigned dashboard includes five separate status summaries, server-side filters and pagination, linked GPU executors, and four task detail tabs. See the [dashboard guide](docs/dashboard.md) for interactions and data-source boundaries.

## License

[MIT](LICENSE)
