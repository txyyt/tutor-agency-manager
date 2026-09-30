// 命令行工具（备用方式）：cleanup-preview / cleanup / backup / restore --from <zip>
// CLI与界面共享同一业务服务与校验。CLI要求服务已停止（单实例锁互斥）。
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server/serverFactory.js';
import { loadEnv } from '../src/server/env.js';

interface CliArgs {
  command: string;
  from?: string;
  yes?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  const args: CliArgs = { command: command ?? '' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--from') args.from = rest[++i];
    if (rest[i] === '--yes') args.yes = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!['cleanup-preview', 'cleanup', 'backup', 'restore'].includes(args.command)) {
    console.error('用法：');
    console.error('  npm run cleanup:preview        # 预览90天到期清理');
    console.error('  npm run cleanup                # 执行清理（先备份再删）');
    console.error('  npm run backup                 # 手动创建完整备份');
    console.error('  npm run restore -- --from <备份ZIP路径> [--yes]   # 恢复（先备份当前数据）');
    process.exit(1);
  }
  const env = loadEnv();
  const server = createServer(env);
  server.start(false); // CLI不启动调度器（不重复触发每日备份/清理）
  try {
    switch (args.command) {
      case 'cleanup-preview': {
        const preview = server.cleanup.preview();
        console.log(`清理截止线（90天）：${preview.cutoffIso}`);
        console.log(`可删除：${preview.candidates.length}项`);
        for (const c of preview.candidates) console.log(`  [${c.type === 'order' ? '整单' : '报名'}] ${c.no}：${c.reason}`);
        console.log(`受保护：${preview.protectedItems.length}项`);
        for (const p of preview.protectedItems) console.log(`  [${p.type === 'order' ? '整单' : '报名'}] ${p.no}：${p.reason}`);
        if (!preview.hasCandidates) console.log('没有可清理数据（执行时不会生成备份）');
        break;
      }
      case 'cleanup': {
        const result = await server.cleanup.run();
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'backup': {
        const entry = await server.backups.createBackup('manual');
        console.log(`备份完成：${path.join(entry.dirPath, entry.fileName)}（${(entry.sizeBytes / 1024 / 1024).toFixed(2)}MB）`);
        break;
      }
      case 'restore': {
        if (!args.from) {
          console.error('restore 需要 --from <完整备份ZIP路径>');
          process.exit(1);
        }
        const zipPath = path.resolve(args.from);
        if (!fs.existsSync(zipPath)) {
          console.error(`文件不存在：${zipPath}`);
          process.exit(1);
        }
        console.log('正在校验备份包…');
        const { token, preview } = await server.restores.validate(zipPath);
        console.log(`备份时间：${preview.createdAtUtc}`);
        console.log(`包含订单 ${preview.counts.orders} 单、报名 ${preview.counts.applications} 条、附件 ${preview.counts.attachments} 个`);
        if (preview.migrated) console.log('（旧schema已迁移）');
        for (const w of preview.warnings) console.log(`警告：${w}`);
        if (!args.yes) {
          console.error('恢复将替换当前全部数据（备份之后新增/修改的数据将丢失）。确认请加 --yes');
          process.exit(1);
        }
        console.log('正在恢复（先自动备份当前数据，再原子切换）…');
        const result = await server.restores.commit(token);
        console.log(`恢复完成：新数据代 ${result.restoredCounts.orders}单/${result.restoredCounts.applications}报名，data_epoch=${result.epoch}`);
        break;
      }
      default:
        break;
    }
  } finally {
    server.stop();
  }
}

main().catch((err) => {
  console.error(`失败：${(err as Error).message}`);
  process.exit(1);
});
