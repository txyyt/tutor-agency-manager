// 开发模式：同时启动后端(tsx watch)与前端(vite dev, /api代理到127.0.0.1:3000)。
import { spawn } from 'node:child_process';

const procs = [];

function start(name, cmd, args, color) {
  const p = spawn(cmd, args, {
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const forward = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        console.log(tag, line);
      }
    });
  };
  forward(p.stdout);
  forward(p.stderr);
  p.on('exit', (code) => {
    console.log(tag, `退出（code=${code}）`);
    shutdown(code ?? 0);
  });
  procs.push(p);
  return p;
}

let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('server', 'npx', ['tsx', 'watch', 'src/server/main.ts'], '36');
start('client', 'npx', ['vite'], '35');
