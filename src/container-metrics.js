'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class ContainerMetrics {
  constructor(options = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1000;
    this.diskPath = options.diskPath ?? '/';
    this.includeLoopback = options.includeLoopback ?? false;

    // Uptime source:
    //  - 'auto' (default): try pid1 epoch method, if it looks like host pid namespace, fall back to process.uptime
    //  - 'pid1': always use pid1 epoch method
    //  - 'process': always use process.uptime
    this.uptimeSource = (options.uptimeSource || 'auto').toLowerCase();

    // When cgroup memory.max is 'max' or unknown, Komari expects a non-zero ram.total.
    // 'host' (default): use os.totalmem() as fallback
    // 'zero': keep 0
    this.ramTotalFallback = (options.ramTotalFallback || 'host').toLowerCase();

    this._prev = null;
    this._cgroup = null;
  }

  async snapshot() {
    if (!this._cgroup) this._cgroup = await this._detectCgroup();

    const now = Date.now();

    const [basicSystem, cgroupCpuMemSwap, load, disk, netDev, conn, proc, uptime] = await Promise.all([
      this._getSystemBasic(),
      this._getCgroupCpuMemSwap(),
      this._getLoadAvg(),
      this._getDiskUsage(this.diskPath),
      this._getNetDev(),
      this._getConnSummary(),
      this._getProcessAndThreads(),
      this._getContainerUptimeSeconds()
    ]);

    const computed = this._computeRates(now, cgroupCpuMemSwap, netDev);

    return {
      at: new Date(now).toISOString(),
      system: {
        ...basicSystem,
        diskTotalBytes: disk.totalBytes,
        memLimitBytes: cgroupCpuMemSwap.mem.limitBytes,
        swapLimitBytes: cgroupCpuMemSwap.swap.limitBytes,
        cgroupMode: this._cgroup?.mode || null
      },
      metrics: {
        cpu: {
          usagePercentOfLimit: computed.cpuPercentOfLimit,
          usagePercentOfHost: computed.cpuPercentOfHost,
          limitCores: cgroupCpuMemSwap.cpu.limitCores
        },
        ram: { total: cgroupCpuMemSwap.mem.limitBytes, used: cgroupCpuMemSwap.mem.usageBytes },
        swap: { total: cgroupCpuMemSwap.swap.limitBytes, used: cgroupCpuMemSwap.swap.usageBytes },
        load,
        disk: { total: disk.totalBytes, used: disk.usedBytes },
        network: {
          upBps: computed.txBps,
          downBps: computed.rxBps,
          totalUpBytes: computed.totalTxBytes,
          totalDownBytes: computed.totalRxBytes,
          byInterface: netDev,
          ips: basicSystem.ips
        },
        connections: conn,
        process: proc.processCount,
        threads: proc.threadCount,
        uptimeSeconds: uptime
      }
    };
  }

  async getBasicInfoForKomari(agentVersion = 'node-agent/1.0.7') {
    if (!this._cgroup) this._cgroup = await this._detectCgroup();
    const sys = await this._getSystemBasic();
    const c = await this._getCgroupCpuMemSwap();
    const disk = await this._getDiskUsage(this.diskPath);

    const ipv4 = sys.ips.ipv4 ?? '';
    const ipv6 = sys.ips.ipv6 ?? '';

    return {
      arch: sys.arch,
      cpu_cores: sys.cpuCores,
      cpu_name: sys.cpuModel,
      disk_total: disk.totalBytes ?? 0,
      ipv4,
      ipv6,
      mem_total: c.mem.limitBytes ?? 0,
      swap_total: c.swap.limitBytes ?? 0,
      os: sys.osPretty ?? sys.platform,
      kernel_version: sys.kernel,
      version: agentVersion,
      virtualization: 'Docker'
    };
  }

  async _getSystemBasic() {
    const [osRelease, cpuModel] = await Promise.all([
      this._readOsRelease(),
      this._readCpuModel()
    ]);

    const arch = os.arch();
    const cpuCoresHost = (os.cpus() || []).length || 1;
    const ips = this._pickIps();

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      kernel: os.release(),
      arch,
      cpuModel,
      cpuCores: cpuCoresHost,
      osRelease,
      osPretty: osRelease?.PRETTY_NAME || null,
      ips
    };
  }

  _pickIps() {
    const nets = os.networkInterfaces();
    let ipv4 = null;
    let ipv6 = null;
    for (const [name, arr] of Object.entries(nets)) {
      if (!this.includeLoopback && name === 'lo') continue;
      for (const x of (arr || [])) {
        if (x.internal) continue;
        if (x.family === 'IPv4' && !ipv4) ipv4 = x.address;
        if (x.family === 'IPv6' && !ipv6) ipv6 = x.address;
      }
    }
    return { ipv4, ipv6 };
  }

  async _readOsRelease() {
    const text = await this._readFileSafe('/etc/os-release');
    if (!text) return null;
    const obj = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim().replace(/^"/, '').replace(/"$/, '');
      obj[m[1]] = v;
    }
    return obj;
  }

  async _readCpuModel() {
    const text = await this._readFileSafe('/proc/cpuinfo');
    if (!text) return null;
    const model = (text.match(/^model name\s*:\s*(.+)$/m) || [])[1]
      || (text.match(/^Hardware\s*:\s*(.+)$/m) || [])[1]
      || (text.match(/^Processor\s*:\s*(.+)$/m) || [])[1];
    return model ? model.trim() : null;
  }

  async _getLoadAvg() {
    const [l1, l5, l15] = os.loadavg();
    return { load1: l1, load5: l5, load15: l15 };
  }

  async _getContainerUptimeSeconds() {
    if (this.uptimeSource === 'process') {
      return process.uptime();
    }

    // auto/pid1: compute based on PID 1 start time
    const pid1Uptime = await this._pid1UptimeSeconds().catch(() => null);

    if (this.uptimeSource === 'pid1') {
      return pid1Uptime ?? process.uptime();
    }

    // auto:
    // If PID namespace is shared with host, /proc/1 likely refers to host init and uptime will be host uptime.
    // Detect via /proc/1/cgroup: host often contains only "/" (cgroup v1) or "0::/" (v2 root).
    // In that case, fall back to process.uptime().
    const isHostPid1 = await this._looksLikeHostPid1();
    if (isHostPid1) {
      return process.uptime();
    }

    // Otherwise use pid1 uptime if available.
    return pid1Uptime ?? process.uptime();
  }

  async _looksLikeHostPid1() {
    const cg1 = await this._readFileSafe('/proc/1/cgroup');
    if (!cg1) return false;
    const lines = cg1.trim().split('\n').filter(Boolean);

    // Common host patterns:
    // - cgroup v2 root: "0::/"
    // - cgroup v1 root: ":/" or ending with ":/"
    // If all lines end with ":/" or are exactly "0::/", we treat as host pid1.
    let hostish = true
    for (const ln of lines) {
      if (ln === '0::/') continue;
      if (ln.endsWith(':/') || ln.endsWith('::/')) continue;
      // container often has /docker/<id> or /kubepods/... etc
      return false;
    }
    return true;
  }

  async _pid1UptimeSeconds() {
    const [stat1, statBoot] = await Promise.all([
      this._readFileSafe('/proc/1/stat'),
      this._readFileSafe('/proc/stat')
    ]);
    if (!stat1 || !statBoot) throw new Error('missing /proc files');

    const rparen = stat1.lastIndexOf(')');
    if (rparen < 0) throw new Error('bad /proc/1/stat');
    const after = stat1.slice(rparen + 2);
    const parts = after.trim().split(/\s+/);
    const startTicksStr = parts[20];
    const startTicks = Number(startTicksStr);
    if (!Number.isFinite(startTicks)) throw new Error('bad starttime');

    const btimeMatch = statBoot.match(/^btime\s+(\d+)$/m);
    if (!btimeMatch) throw new Error('missing btime');
    const btime = Number(btimeMatch[1]);

    let clkTck = 100;
    try {
      const { stdout } = await execFileAsync('getconf', ['CLK_TCK'], { timeout: 1000 });
      const v = Number(String(stdout).trim());
      if (Number.isFinite(v) && v > 0) clkTck = v;
    } catch {
      // keep default
    }

    const startSecondsSinceBoot = startTicks / clkTck;
    const startEpoch = btime + startSecondsSinceBoot;
    const nowEpoch = Date.now() / 1000;
    return Math.max(0, nowEpoch - startEpoch);
  }

  async _detectCgroup() {
    const isV2 = await this._exists('/sys/fs/cgroup/cgroup.controllers');
    if (isV2) {
      return {
        mode: 'v2',
        p: {
          cpuStat: '/sys/fs/cgroup/cpu.stat',
          cpuMax: '/sys/fs/cgroup/cpu.max',
          memCur: '/sys/fs/cgroup/memory.current',
          memMax: '/sys/fs/cgroup/memory.max',
          swapCur: '/sys/fs/cgroup/memory.swap.current',
          swapMax: '/sys/fs/cgroup/memory.swap.max'
        }
      };
    }

    const cg = await this._readFileSafe('/proc/self/cgroup') || '';
    const map = {};
    for (const line of cg.trim().split('\n')) {
      const parts = line.split(':');
      if (parts.length !== 3) continue;
      const controllers = parts[1].split(',').filter(Boolean);
      const rel = parts[2];
      for (const c of controllers) map[c] = rel;
    }

    const cpuacct = map.cpuacct ? path.join('/sys/fs/cgroup/cpuacct', map.cpuacct) : null;
    const cpu = map.cpu ? path.join('/sys/fs/cgroup/cpu', map.cpu) : null;
    const mem = map.memory ? path.join('/sys/fs/cgroup/memory', map.memory) : null;

    return {
      mode: 'v1',
      p: {
        cpuacctUsage: cpuacct ? path.join(cpuacct, 'cpuacct.usage') : null,
        cpuQuota: cpu ? path.join(cpu, 'cpu.cfs_quota_us') : null,
        cpuPeriod: cpu ? path.join(cpu, 'cpu.cfs_period_us') : null,
        memUsage: mem ? path.join(mem, 'memory.usage_in_bytes') : null,
        memLimit: mem ? path.join(mem, 'memory.limit_in_bytes') : null,
        memswUsage: mem ? path.join(mem, 'memory.memsw.usage_in_bytes') : null,
        memswLimit: mem ? path.join(mem, 'memory.memsw.limit_in_bytes') : null
      }
    };
  }

  async _getCgroupCpuMemSwap() {
    if (!this._cgroup) this._cgroup = await this._detectCgroup();
    const { mode, p } = this._cgroup;

    if (mode === 'v2') {
      const [cpuStat, cpuMax, memCur, memMax, swapCur, swapMax] = await Promise.all([
        this._readFileSafe(p.cpuStat),
        this._readFileSafe(p.cpuMax),
        this._readFileSafe(p.memCur),
        this._readFileSafe(p.memMax),
        this._readFileSafe(p.swapCur),
        this._readFileSafe(p.swapMax)
      ]);

      const kv = this._parseKeyValue(cpuStat);
      const usageUsec = kv.usage_usec ?? 0;
      const limitCores = this._parseCpuMax(cpuMax);

      const memUsageBytes = this._toInt(memCur);
      let memLimitBytes = (memMax && memMax.trim() !== 'max') ? this._toInt(memMax) : null;
      if (!memLimitBytes || memLimitBytes <= 0) {
        if (this.ramTotalFallback === 'host') memLimitBytes = os.totalmem();
        else memLimitBytes = 0;
      }

      const swapUsageBytes = this._toInt(swapCur) ?? 0;
      const swapLimitBytes = (swapMax && swapMax.trim() !== 'max') ? (this._toInt(swapMax) ?? 0) : 0;

      return {
        cpu: { usageSeconds: usageUsec / 1e6, limitCores },
        mem: { usageBytes: memUsageBytes, limitBytes: memLimitBytes },
        swap: { usageBytes: swapUsageBytes, limitBytes: swapLimitBytes }
      };
    }

    const [usageNs, quotaUs, periodUs, memUsage, memLimit, memswUsage, memswLimit] = await Promise.all([
      this._readFileSafe(p.cpuacctUsage),
      this._readFileSafe(p.cpuQuota),
      this._readFileSafe(p.cpuPeriod),
      this._readFileSafe(p.memUsage),
      this._readFileSafe(p.memLimit),
      this._readFileSafe(p.memswUsage),
      this._readFileSafe(p.memswLimit)
    ]);

    const cpuUsageSeconds = (this._toInt(usageNs) ?? 0) / 1e9;

    let limitCores = null;
    const q = this._toInt(quotaUs);
    const per = this._toInt(periodUs);
    if (q != null && per != null && q > 0 && per > 0) limitCores = q / per;

    const memUsageBytes = this._toInt(memUsage);
    let memLimitBytes = this._toInt(memLimit);
    if (!memLimitBytes || memLimitBytes >= Number.MAX_SAFE_INTEGER / 2) {
      memLimitBytes = (this.ramTotalFallback === 'host') ? os.totalmem() : 0;
    }

    const memswUsageBytes = this._toInt(memswUsage);
    const memswLimitBytes = this._toInt(memswLimit);
    let swapUsageBytes = 0;
    let swapLimitBytes = 0;
    if (memswUsageBytes != null && memUsageBytes != null) {
      swapUsageBytes = Math.max(0, memswUsageBytes - memUsageBytes);
    }
    if (memswLimitBytes != null && memLimitBytes != null) {
      swapLimitBytes = Math.max(0, memswLimitBytes - memLimitBytes);
    }

    return {
      cpu: { usageSeconds: cpuUsageSeconds, limitCores },
      mem: { usageBytes: memUsageBytes, limitBytes: memLimitBytes },
      swap: { usageBytes: swapUsageBytes, limitBytes: swapLimitBytes }
    };
  }

  _parseKeyValue(text) {
    const out = {};
    if (!text) return out;
    for (const line of text.trim().split('\n')) {
      const [k, v] = line.trim().split(/\s+/);
      if (k) out[k] = this._toInt(v);
    }
    return out;
  }

  _parseCpuMax(text) {
    if (!text) return null;
    const [quota, period] = text.trim().split(/\s+/);
    if (!quota || !period) return null;
    if (quota === 'max') return null;
    const q = this._toInt(quota);
    const per = this._toInt(period);
    if (q != null && per != null && per > 0) return q / per;
    return null;
  }

  async _getDiskUsage(targetPath) {
    try {
      const { stdout } = await execFileAsync('df', ['-kP', targetPath], { timeout: 2000 });
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return { totalBytes: null, usedBytes: null };
      const cols = lines[1].split(/\s+/);
      const totalKB = this._toInt(cols[cols.length - 5]);
      const usedKB = this._toInt(cols[cols.length - 4]);
      return { totalBytes: totalKB != null ? totalKB * 1024 : null, usedBytes: usedKB != null ? usedKB * 1024 : null };
    } catch {
      return { totalBytes: null, usedBytes: null };
    }
  }

  async _getNetDev() {
    const text = await this._readFileSafe('/proc/net/dev') || '';
    const lines = text.trim().split('\n');
    const out = {};
    for (let i = 2; i < lines.length; i++) {
      const [ifacePart, rest] = lines[i].split(':');
      if (!rest) continue;
      const iface = ifacePart.trim();
      if (!this.includeLoopback && iface === 'lo') continue;
      const cols = rest.trim().split(/\s+/);
      if (cols.length < 16) continue;
      out[iface] = { rxBytes: this._toInt(cols[0]) ?? 0, txBytes: this._toInt(cols[8]) ?? 0 };
    }
    return out;
  }

  async _getConnSummary() {
    const [tcp, tcp6, udp, udp6, unix] = await Promise.all([
      this._readFileSafe('/proc/net/tcp'),
      this._readFileSafe('/proc/net/tcp6'),
      this._readFileSafe('/proc/net/udp'),
      this._readFileSafe('/proc/net/udp6'),
      this._readFileSafe('/proc/net/unix')
    ]);

    const count = (t) => {
      if (!t) return 0;
      const lines = t.trim().split('\n');
      return Math.max(0, lines.length - 1);
    };

    return { tcp: count(tcp) + count(tcp6), udp: count(udp) + count(udp6), unix: count(unix) };
  }

  async _getProcessAndThreads() {
    const entries = await fs.promises.readdir('/proc').catch(() => []);
    const pids = entries.filter(x => /^\d+$/.test(x));
    let processCount = 0;
    let threadCount = 0;

    const concurrency = 50;
    let idx = 0;

    const worker = async () => {
      while (idx < pids.length) {
        const pid = pids[idx++];
        const status = await this._readFileSafe(`/proc/${pid}/status`);
        if (!status) continue;
        processCount++;
        const m = status.match(/^Threads:\s+(\d+)/m);
        if (m) threadCount += parseInt(m[1], 10);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, pids.length) }, worker));
    return { processCount, threadCount };
  }

  _computeRates(now, cgroup, netDev) {
    const hostCores = (os.cpus() || []).length || 1;
    const limitCores = cgroup.cpu.limitCores ?? hostCores;

    let totalRx = 0, totalTx = 0;
    for (const s of Object.values(netDev)) {
      totalRx += s.rxBytes;
      totalTx += s.txBytes;
    }

    let rxBps = 0, txBps = 0;
    let cpuPercentOfHost = null;
    let cpuPercentOfLimit = null;

    if (this._prev) {
      const dt = (now - this._prev.at) / 1000;
      if (dt > 0) {
        rxBps = (totalRx - this._prev.totalRx) / dt;
        txBps = (totalTx - this._prev.totalTx) / dt;
        const dCpu = cgroup.cpu.usageSeconds - this._prev.cpuUsageSeconds;
        cpuPercentOfHost = (dCpu / (dt * hostCores)) * 100;
        cpuPercentOfLimit = (dCpu / (dt * limitCores)) * 100;
      }
    }

    this._prev = { at: now, cpuUsageSeconds: cgroup.cpu.usageSeconds, totalRx, totalTx };

    return { rxBps: Math.max(0, rxBps), txBps: Math.max(0, txBps), totalRxBytes: totalRx, totalTxBytes: totalTx, cpuPercentOfHost, cpuPercentOfLimit };
  }

  async _exists(p) {
    try { await fs.promises.access(p, fs.constants.F_OK); return true; }
    catch { return false; }
  }

  async _readFileSafe(p) {
    if (!p) return null;
    try { return await fs.promises.readFile(p, 'utf8'); }
    catch { return null; }
  }

  _toInt(x) {
    if (x == null) return null;
    const n = parseInt(String(x).trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
}

module.exports = { ContainerMetrics };
