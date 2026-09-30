// 环境配置：只监听127.0.0.1；数据目录可用APP_DATA_DIR重定向（测试/CLI使用隔离目录）。
import path from 'node:path';

export interface Env {
  appRoot: string; // 项目根（迁移、dist/client所在）
  dataDir: string;
  port: number;
  host: '127.0.0.1';
  appVersion: string;
  allowTimeControl: boolean;
  distClientDir: string;
  migrationDir: string;
}

export function loadEnv(overrides?: Partial<Pick<Env, 'dataDir' | 'port' | 'appRoot'>>): Env {
  const appRoot = overrides?.appRoot ?? process.env.APP_ROOT ?? process.cwd();
  const dataDir = overrides?.dataDir ?? process.env.APP_DATA_DIR ?? path.join(appRoot, 'data');
  const port = overrides?.port ?? Number(process.env.APP_PORT ?? 3000);
  const host = '127.0.0.1' as const;
  const allowTimeControl = process.env.APP_ALLOW_TIME_CONTROL === '1';
  const distClientDir = path.join(appRoot, 'dist', 'client');
  const migrationDir = path.join(appRoot, 'migrations');
  const appVersion = '1.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT无效：${process.env.APP_PORT}`);
  }
  return { appRoot, dataDir, port, host, appVersion, allowTimeControl, distClientDir, migrationDir };
}
