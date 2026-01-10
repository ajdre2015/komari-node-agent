'use strict';

const { KomariAgent } = require('./src/komari-agent');
const { Logger } = require('./src/logger');

const log = new Logger({ prefix: 'komari-node-agent' });

process.on('unhandledRejection', (reason) => {
  log.error('UnhandledPromiseRejection', reason);
});

process.on('uncaughtException', (err) => {
  log.error('UncaughtException', err?.stack || err);
  process.exit(1);
});

const endpoint = process.env.KOMARI_ENDPOINT;
const token = process.env.KOMARI_TOKEN;

if (!endpoint || !token) {
  log.error('Missing env: KOMARI_ENDPOINT and KOMARI_TOKEN are required');
  process.exit(1);
}

const cfg = {
  endpoint,
  token: token.slice(0, 6) + '***',
  reportIntervalMs: Number(process.env.REPORT_INTERVAL_MS || 1000),
  infoIntervalMs: Number(process.env.INFO_INTERVAL_MS || 5 * 60 * 1000),
  reconnectIntervalMs: Number(process.env.RECONNECT_INTERVAL_MS || 5000),
  diskPath: process.env.DISK_PATH || '/',
  uptimeSource: process.env.UPTIME_SOURCE || 'auto',
  logLevel: process.env.LOG_LEVEL || 'info',
  logPayload: process.env.LOG_PAYLOAD || 'false',
  logWsSend: process.env.LOG_WS_SEND || 'false',
  logWsEvery: process.env.LOG_WS_EVERY || '1',
  ramFallback: process.env.RAM_TOTAL_FALLBACK || 'host'
};

log.info('Starting agent with config', cfg);

const agent = new KomariAgent({
  endpoint,
  token,
  reportIntervalMs: Number(process.env.REPORT_INTERVAL_MS || 1000),
  infoIntervalMs: Number(process.env.INFO_INTERVAL_MS || 5 * 60 * 1000),
  reconnectIntervalMs: Number(process.env.RECONNECT_INTERVAL_MS || 5000),
  agentVersion: process.env.AGENT_VERSION || 'node-agent/1.0.7',
  disableRemoteExec: (process.env.DISABLE_REMOTE_EXEC ?? 'true') !== 'false',
  attachThreadsToMessage: false,
  metricsOptions: {
    diskPath: process.env.DISK_PATH || '/',
    includeLoopback: false,
    uptimeSource: process.env.UPTIME_SOURCE || 'auto',
    ramTotalFallback: process.env.RAM_TOTAL_FALLBACK || 'host'
  },
  logger: log,
  logPayload: (process.env.LOG_PAYLOAD || 'false') === 'true',
  logWsSend: (process.env.LOG_WS_SEND || 'false') === 'true',
  logWsEvery: Number(process.env.LOG_WS_EVERY || 1)
});

agent.start().catch((e) => {
  log.error('agent start failed', e?.stack || e);
  process.exit(1);
});

process.on('SIGINT', () => {
  log.warn('SIGINT received, stopping...');
  agent.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.warn('SIGTERM received, stopping...');
  agent.stop();
  process.exit(0);
});
