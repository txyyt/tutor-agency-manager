import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import JSZip from 'jszip';
import { TestClient, createOrder } from '../helpers/testServer.js';
import type { BackupIndexEntry } from '../../src/shared/types.js';

it('真实服务启动/正常关闭都保存ZIP，等待写完退出，多次启停合计保留5份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-life-process-'));
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  for (let cycle = 0; cycle < 3; cycle++) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      env: { ...process.env, APP_DATA_DIR: dir, APP_PORT: String(port), APP_ALLOW_TIME_CONTROL: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    const exited = once(child, 'exit');
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    child.stderr!.on('data', chunk => { output += chunk.toString(); });
    try {
      await expect.poll(() => output, { timeout: 10_000 }).toContain('已启动:');
      if (cycle === 0) {
        const client = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 }); await client.bootstrap(); await createOrder(client);
      }
    } finally {
      if (child.connected) child.send('tam:shutdown');
      const [code] = await exited; expect(code).toBe(0);
    }
    expect(output).toContain('关闭备份已保存');
  }
  const entries = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'index.json'), 'utf8')) as BackupIndexEntry[];
  const lifecycle = entries.filter(e => e.kind === 'startup' || e.kind === 'shutdown');
  expect(lifecycle).toHaveLength(5); expect(lifecycle.at(-1)?.kind).toBe('shutdown');
  const latest = lifecycle.at(-1)!;
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(latest.dirPath, latest.fileName)));
  expect(JSON.parse(await zip.file('manifest.json')!.async('string')).counts.orders).toBe(1);
}, 30_000);


it('开发启动器退出也等待后端关闭备份，不强杀后端', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-dev-life-'));
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    env: { ...process.env, APP_DATA_DIR: dir, APP_PORT: String(port), APP_ALLOW_TIME_CONTROL: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = ''; const exited = once(child, 'exit');
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  child.stderr!.on('data', chunk => { output += chunk.toString(); });
  try { await expect.poll(() => output, { timeout: 10_000 }).toContain('已启动:'); }
  finally { if (child.connected) child.send('tam:shutdown'); await exited; }
  const entries = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'index.json'), 'utf8')) as BackupIndexEntry[];
  expect(entries.map(e => e.kind)).toEqual(['startup', 'shutdown']);
  expect(fs.existsSync(path.join(dir, 'instance.lock'))).toBe(false);
}, 30_000);
