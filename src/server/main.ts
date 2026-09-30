// 入口：单实例、只监听127.0.0.1、启动补做、可注入时间控制仅测试环境。
import http from 'node:http';
import { createServer } from './serverFactory.js';
import { loadEnv } from './env.js';

function main(): void {
  const env = loadEnv();
  const server = createServer(env);
  const reconciliation = server.start();

  const httpServer = http.createServer(server.app);
  // 只监听回环地址：不提供局域网/公网访问
  httpServer.listen(env.port, env.host, () => {
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

  const shutdown = (): void => {
    console.log('[tutor-agency-manager] 正在停止…');
    httpServer.close(() => {
      server.stop();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
  });
}

main();
