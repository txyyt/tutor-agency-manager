// E2E启动器：隔离临时数据目录 + 127.0.0.1:3300 + 测试时间控制。由Playwright webServer调用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(process.cwd(), 'test-results', 'e2e-data-'));
const port = Number(process.env.E2E_PORT ?? 3300);

const child = spawn(process.execPath, ['dist/server/main.js'], {
  env: {
    ...process.env,
    APP_DATA_DIR: dataDir,
    APP_PORT: String(port),
    APP_ALLOW_TIME_CONTROL: '1',
  },
  stdio: 'inherit',
});

function shutdown() {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

// 就绪等待由Playwright的url轮询完成；这里保持进程存活
child.on('exit', (code) => {
  console.error(`[e2e-server] 服务退出 code=${code}`);
  process.exit(code ?? 1);
});
void http;
