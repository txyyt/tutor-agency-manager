// 入口：单实例、只监听127.0.0.1、启动/正常关闭备份、可注入时间控制仅测试环境。
import http from 'node:http';
import { createServer } from './serverFactory.js';
import { loadEnv } from './env.js';

// Electron utilityProcess 的消息通道；普通 Node 启动不包含此属性。
const parentPort = (process as unknown as { parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void } }).parentPort;

async function main(): Promise<void> {
  const env = loadEnv();
  const server = createServer(env);
  const reconciliation = server.start(false);
  const httpServer = http.createServer(server.app);
  let startupTask: Promise<void> = Promise.resolve();

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('[tutor-agency-manager] 正在停止，等待关闭备份完成…');
    server.scheduler.stop();
    await startupTask;
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    try {
      await server.scheduler.lifecycleBackup('shutdown');
      console.log('[tutor-agency-manager] 关闭备份已保存');
    } catch (error) {
      parentPort?.postMessage({ type: 'backup-error', message: (error as Error).message });
      console.error('[BACKUP] 关闭备份失败，业务数据仍保留：', error);
    } finally {
      server.stop();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('message', message => { if (message === 'tam:shutdown') void shutdown(); });
  parentPort?.on('message', event => { if (event.data === 'tam:shutdown') void shutdown(); });
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
  });
  startupTask = server.scheduler.lifecycleBackup('startup').catch(error => { parentPort?.postMessage({ type: 'startup-warning', message: (error as Error).message }); console.error('[BACKUP] 启动备份失败，业务数据未删除：', error); });
  await startupTask;
  if (stopping) return;
  server.scheduler.start();
  // 只监听回环地址：不提供局域网/公网访问
  httpServer.listen(env.port, env.host, () => {
    const address = httpServer.address();
    if (address && typeof address !== 'string') env.port = address.port;
    parentPort?.postMessage({ type: 'ready', url: `http://${env.host}:${env.port}` });
    console.log(`[tutor-agency-manager] 已启动: http://${env.host}:${env.port}`);
    console.log(`[tutor-agency-manager] 数据目录: ${server.paths.dataDir}`);
    console.log(`[tutor-agency-manager] 活动数据代: ${server.runtime.load().activeGenerationId} (data_epoch=${server.runtime.load().dataEpoch})`);
    if (reconciliation.restoreNotes.length > 0) {
      for (const note of reconciliation.restoreNotes) console.log(`[tutor-agency-manager] ${note}`);
    }
    if (server.env.allowTimeControl) {
      console.log('[tutor-agency-manager] 警告：测试时间控制已启用（APP_ALLOW_TIME_CONTROL=1），仅限测试环境');
    }
  });


}

void main().catch(error => { parentPort?.postMessage({ type: 'startup-error', message: (error as Error).message }); console.error('[STARTUP]', error); process.exitCode = 1; });
