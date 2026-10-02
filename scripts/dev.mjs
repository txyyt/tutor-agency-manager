// 开发模式：前端Vite热更新；后端源码变化先完成关闭备份，再重新启动。
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';

let exiting = false;
let restarting = false;
let server;
let reloadTimer;
const watchers = [];

function launch(name, args, ipc = false) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.on('data', data => {
      buffered += data.toString();
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        console.log(`[${name}] ${buffered.slice(0, end)}`);
        buffered = buffered.slice(end + 1);
      }
    });
  }
  child.on('exit', code => {
    if (!exiting && !(name === 'server' && restarting)) void shutdown(code ?? 1);
  });
  child.on('error', error => { console.error(`[${name}]`, error); void shutdown(1); });
  return child;
}

function startServer() { return launch('server', ['--import', 'tsx', 'src/server/main.ts'], true); }
const client = launch('client', [path.join('node_modules', 'vite', 'bin', 'vite.js')]);
server = startServer();

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = once(child, 'exit');
  if (child.connected) child.send('tam:shutdown');
  await finished; // 不强杀后端，让关闭备份写完。
}

async function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  clearTimeout(reloadTimer);
  for (const watcher of watchers) watcher.close();
  client.kill();
  try { await stopServer(server); }
  finally { process.exit(code); }
}

for (const directory of ['src/server', 'src/shared']) {
  watchers.push(watch(directory, { recursive: true }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (exiting || restarting) return;
      restarting = true;
      try {
        console.log('[server] 源码变化，保存关闭备份后重启…');
        await stopServer(server);
        if (!exiting) server = startServer();
      } finally { restarting = false; }
    }, 300);
  }));
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

process.on('message', message => { if (message === 'tam:shutdown') void shutdown(); });
