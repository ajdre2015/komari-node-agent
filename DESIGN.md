# 设计与开发文档（v1.0.7）

## 目标

实现 Komari Agent 的核心上报能力：
- HTTP POST 上传基础信息
- WebSocket 持续上传实时数据

## 模块划分

### 1) src/komari-agent.js（通讯层）

- `uploadBasicInfo()`：HTTP POST 上传基础信息
- `_connectWebSocket()`：建立 WS 连接、维护重连、周期发送 report
- `_sendReport()`：发送实时 JSON，并可选打印 ws.send 内容

### 2) src/container-metrics.js（采集层）

- CPU/内存/Swap：cgroup v2 优先，v1 fallback
- Disk：`df -kP`
- Network：`/proc/net/dev` diff 计算速率
- Connections：`/proc/net/tcp*` `udp*` 统计
- Uptime：支持 `UPTIME_SOURCE=auto|pid1|process`

#### uptime 设计

- `pid1`：通过 `/proc/1/stat` 的 starttime + `/proc/stat` 的 btime 推算进程启动时间，进而得到 uptime。
- `auto`：如果 `/proc/1/cgroup` 显示 pid1 更像宿主机（例如仅根路径），则回退为 `process.uptime()`。
- `process`：直接使用 Node 进程 uptime（通常等同容器生命周期）。

#### ram.total 兜底

当 `memory.max` 为 `max` 或无法识别时，为避免上报 `ram.total=0`，默认使用 `os.totalmem()` 作为兜底（可通过 `RAM_TOTAL_FALLBACK` 关闭）。

### 3) src/logger.js（日志层）

- 支持 `LOG_LEVEL` 分级
- WS send 内容日志：`LOG_WS_SEND=true` + `LOG_WS_EVERY`

## 版本演进摘要

- v1.0.0：基础实现
- v1.0.1：修复换行/转义导致的语法错误
- v1.0.2：加入大量日志
- v1.0.3：修复 cgroup 初始化时序
- v1.0.4：warmup 预热降低早期竞态
- v1.0.5：加入 ws.send JSON 日志
- v1.0.6：uptime 整数化与容器 uptime 尝试
- v1.0.7：uptime source 可选 + ram.total 兜底
