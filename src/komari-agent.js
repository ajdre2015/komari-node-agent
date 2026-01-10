'use strict';

const WebSocket = require('ws');
const { ContainerMetrics } = require('./container-metrics');
const { Logger } = require('./logger');

class KomariAgent {
  constructor(options) {
    if (!options?.endpoint || !options?.token) throw new Error('endpoint 和 token 必填');

    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.token = options.token;

    this.reportIntervalMs = options.reportIntervalMs ?? 1000;
    this.infoIntervalMs = options.infoIntervalMs ?? 5 * 60 * 1000;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5000;

    this.agentVersion = options.agentVersion ?? 'node-agent/1.0.7';
    this.disableRemoteExec = options.disableRemoteExec ?? true;
    this.attachThreadsToMessage = options.attachThreadsToMessage ?? false;

    this.log = options.logger || new Logger({ prefix: 'komari-node-agent' });
    this.logPayload = options.logPayload ?? false;
    this.logWsSend = options.logWsSend ?? false;
    this.logWsEvery = Number.isFinite(options.logWsEvery) ? options.logWsEvery : 1;
    if (this.logWsEvery < 1) this.logWsEvery = 1;

    this.metrics = new ContainerMetrics({
      sampleIntervalMs: this.reportIntervalMs,
      ...(options.metricsOptions || {})
    });

    this._ws = null;
    this._reportTimer = null;
    this._infoTimer = null;
    this._stopped = true;
    this._seq = 0;
  }

  async start() {
    this._stopped = false;
    this.log.info('Agent start invoked');

    try {
      const warm = await this.metrics.snapshot();
      this.log.info(`Warmup snapshot ok (cgroup=${warm.system.cgroupMode}, uptime≈${Math.floor(warm.metrics.uptimeSeconds || 0)}s)`);
    } catch (e) {
      this.log.warn('Warmup snapshot failed (will retry later)', e?.stack || e);
    }

    await this.uploadBasicInfo().catch((e) => {
      this.log.error('Initial uploadBasicInfo failed', e?.stack || e);
    });

    this._infoTimer = setInterval(() => {
      this.uploadBasicInfo().catch((e) => {
        this.log.error('Periodic uploadBasicInfo failed', e?.stack || e);
      });
    }, this.infoIntervalMs);

    this._connectWebSocket();
  }

  stop() {
    this.log.warn('Agent stop invoked');
    this._stopped = true;

    if (this._infoTimer) clearInterval(this._infoTimer);
    if (this._reportTimer) clearInterval(this._reportTimer);
    this._infoTimer = null;
    this._reportTimer = null;

    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  async uploadBasicInfo() {
    const url = `${this.endpoint}/api/clients/uploadBasicInfo?token=${encodeURIComponent(this.token)}`;
    const body = await this.metrics.getBasicInfoForKomari(this.agentVersion);

    this.log.info(`uploadBasicInfo -> ${url.replace(this.token, '***')}`);
    if (this.logPayload) this.log.debug('uploadBasicInfo payload', body);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      this.log.error('uploadBasicInfo network error', e?.stack || e);
      throw e;
    }

    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      this.log.error(`uploadBasicInfo failed: HTTP ${res.status}`, txt);
      throw new Error(`uploadBasicInfo failed: ${res.status}`);
    }

    this.log.info(`uploadBasicInfo success: HTTP ${res.status}`);
    if (this.logPayload && txt) this.log.debug('uploadBasicInfo response body', txt);
  }

  _connectWebSocket() {
    if (this._stopped) return;

    const wsUrl = this._toWsUrl(`${this.endpoint}/api/clients/report?token=${encodeURIComponent(this.token)}`);
    this.log.info(`WebSocket connecting -> ${wsUrl.replace(this.token, '***')}`);

    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: 8000,
      perMessageDeflate: false
    });
    this._ws = ws;

    ws.on('open', () => {
      this.log.info('WebSocket connected');

      if (this._reportTimer) clearInterval(this._reportTimer);
      this._reportTimer = setInterval(() => {
        this._sendReport().catch((e) => this.log.error('sendReport failed', e?.stack || e));
      }, this.reportIntervalMs);

      this._sendReport().catch((e) => this.log.error('sendReport failed', e?.stack || e));
    });

    ws.on('message', (buf) => {
      const s = buf.toString('utf8');
      this.log.debug('WebSocket message received', s);
    });

    ws.on('close', (code, reason) => {
      this.log.warn(`WebSocket closed: code=${code} reason=${reason?.toString?.() || ''}`);
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log.error('WebSocket error', err?.stack || err);
      try { ws.close(); } catch {}
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;

    if (this._reportTimer) clearInterval(this._reportTimer);
    this._reportTimer = null;

    this.log.info(`Reconnecting in ${this.reconnectIntervalMs}ms...`);
    setTimeout(() => {
      if (!this._stopped) this._connectWebSocket();
    }, this.reconnectIntervalMs);
  }

  async _sendReport() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      this.log.debug('sendReport skipped: ws not open');
      return;
    }

    const snap = await this.metrics.snapshot();

    const uptimeInt = Number.isFinite(snap.metrics.uptimeSeconds) ? Math.floor(snap.metrics.uptimeSeconds) : 0;

    const payload = {
      cpu: { usage: this._clamp(snap.metrics.cpu.usagePercentOfLimit ?? 0, 0, 999) },
      ram: { total: snap.metrics.ram.total ?? 0, used: snap.metrics.ram.used ?? 0 },
      swap: { total: snap.metrics.swap.total ?? 0, used: snap.metrics.swap.used ?? 0 },
      load: snap.metrics.load,
      disk: { total: snap.metrics.disk.total ?? 0, used: snap.metrics.disk.used ?? 0 },
      network: {
        up: Math.max(0, Math.floor(snap.metrics.network.upBps ?? 0)),
        down: Math.max(0, Math.floor(snap.metrics.network.downBps ?? 0)),
        totalUp: snap.metrics.network.totalUpBytes ?? 0,
        totalDown: snap.metrics.network.totalDownBytes ?? 0
      },
      connections: {
        tcp: snap.metrics.connections.tcp ?? 0,
        udp: snap.metrics.connections.udp ?? 0
      },
      uptime: uptimeInt,
      process: snap.metrics.process ?? 0,
      message: this.attachThreadsToMessage ? `threads=${snap.metrics.threads}` : ''
    };

    this._seq += 1;

    if (this.logWsSend && (this._seq % this.logWsEvery === 0)) {
      const json = JSON.stringify(payload);
      const max = Number(process.env.LOG_WS_MAXLEN || 8000);
      const out = json.length > max ? (json.slice(0, max) + `...<truncated ${json.length - max} chars>`) : json;
      this.log.debug(`ws.send seq=${this._seq} bytes=${json.length} -> ${out}`);
    }

    this._ws.send(JSON.stringify(payload));
  }

  _toWsUrl(httpUrl) {
    return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  }

  _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }
}

module.exports = { KomariAgent };
