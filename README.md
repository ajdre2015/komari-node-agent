# Komari Node Agent (v1.0.8)

一个运行在 Docker 容器内的 Komari 兼容监控 Agent：

- 启动/定时：HTTP 上报基础信息
- 持续：WebSocket(wss) 上报实时监控数据（默认 1 秒）

## 快速开始（Docker Compose）

1. 复制 `.env.example` 为 `.env` 并填入：

```bash
cp .env.example .env
```

2. 启动：

```bash
docker compose up -d --build

docker compose logs -f komari-node-agent
```

## 关键环境变量

- `REPORT_INTERVAL_MS`：实时上报间隔（默认 1000ms）
- `INFO_INTERVAL_MS`：基础信息上报间隔（默认 300000ms）
- `RECONNECT_INTERVAL_MS`：WS 断线重连间隔（默认 5000ms）
- `DISK_PATH`：磁盘统计路径（默认 /）

### 调试

- `LOG_LEVEL=debug`
- `LOG_WS_SEND=true`：打印 ws.send 的 JSON
- `LOG_WS_EVERY=10`：每 10 条打印一次（避免刷屏）
- `LOG_WS_MAXLEN=8000`：单条日志最大长度

### 容器 uptime 与 ram.total

- `UPTIME_SOURCE=auto|pid1|process`
  - auto：默认，尝试 pid1 推算，若判断 pid1 为宿主机则回退 process.uptime
  - process：强制 process.uptime（适合 pid namespace 与宿主机共享时）
  - pid1：强制 pid1 推算

- `RAM_TOTAL_FALLBACK=host|zero`
  - host：默认，cgroup 未限制时用 os.totalmem 兜底
  - zero：保持 0

更多设计与演进见 `DESIGN.md`。
