// 跨盘备份迁移：先复制校验，持久化提交后才删源；启动时对账，失败副本可重用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BackupIndexEntry, BackupSettings } from '../../shared/types.js';
import type { DataPaths } from '../paths.js';
import type { RuntimeConfigStore } from '../runtimeConfig.js';

interface Move {
  id: string; source: string; target: string; temporary: string;
  sha256: string; sizeBytes: number; created: boolean;
}
interface Migration {
  phase: 'prepared' | 'committed';
  originalSettings: BackupSettings; nextSettings: BackupSettings;
  originalIndex: BackupIndexEntry[]; nextIndex: BackupIndexEntry[]; moves: Move[];
  pendingDirectories?: string[];
}

function atomicJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

function matches(file: string, expected: { sha256: string; sizeBytes: number }): boolean {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== expected.sizeBytes) return false;
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(256 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let read: number;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    return hash.digest('hex') === expected.sha256;
  } finally { fs.closeSync(fd); }
}

export class BackupMigration {
  private file: string;
  constructor(private paths: DataPaths, private runtime: RuntimeConfigStore) {
    this.file = path.join(paths.dataDir, 'backup-migration.json');
  }
  private load(): Migration | null {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) as Migration : null;
  }
  pendingCount(): number { const state = this.load(); return (state?.moves.length ?? 0) + (state?.pendingDirectories?.length ?? 0); }

  /** prepared 从未删除源，恢复旧指针；committed 保留新指针，只继续清理旧副本。 */
  reconcile(): string[] {
    const state = this.load();
    if (!state) return [];
    if (state.phase === 'prepared') {
      atomicJson(this.paths.backupsIndex, state.originalIndex);
      this.runtime.mutate(cfg => { cfg.backupSettings = state.originalSettings; });
      for (const move of state.moves) {
        if (fs.existsSync(move.temporary)) fs.unlinkSync(move.temporary);
        if (move.created && matches(move.target, move)) fs.unlinkSync(move.target);
      }
      fs.unlinkSync(this.file);
      return [];
    }
    return this.cleanup(state);
  }

  private cleanup(state: Migration): string[] {
    const warnings: string[] = [];
    const remaining: Move[] = [];
    const index = JSON.parse(fs.readFileSync(this.paths.backupsIndex, 'utf8')) as BackupIndexEntry[];
    for (const move of state.moves) {
      try {
        if (fs.existsSync(move.source)) {
          // 被轮换删除的备份也应删除遗留旧副本；仍在列表的先确认新副本完整。
          if (index.some(e => e.id === move.id) && !matches(move.target, move)) throw new Error('新副本校验失败，保留旧文件');
          if (!matches(move.source, move)) throw new Error('旧文件内容已变化，保留文件');
          fs.unlinkSync(move.source);
        }
      } catch (error) {
        remaining.push(move);
        warnings.push(`${move.source}：${(error as Error).message}`);
      }
    }
    // 只删除旧分类目录本身，不递归删除，不删除用户选择的总目录。
    // 包括未曾生成过备份的空分类目录；失败时保留日志，下次启动/重试继续。
    const categories = ['manual', 'daily', 'lifecycle', 'safety'];
    const oldRoot = state.originalSettings.autoBackupDir ?? this.paths.backupsRoot;
    const newRoot = path.resolve(state.nextSettings.autoBackupDir ?? this.paths.backupsRoot);
    const directories = new Set([...categories.map(category => path.resolve(oldRoot, category)), ...state.originalIndex.map(entry => path.resolve(entry.dirPath)).filter(directory => categories.includes(path.basename(directory))), ...(state.pendingDirectories ?? [])]);
    const activePaths = [newRoot, ...index.map(entry => path.resolve(entry.dirPath))];
    const pendingDirectories: string[] = [];
    for (const directory of directories) {
      // 新目录可能位于旧目录内部，此时不能删除新目录的任何父级。
      if (activePaths.some(active => { const relative = path.relative(directory, active); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); })) continue;
      try {
        let linked = false;
        for (let ancestor = directory; ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
          if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) { linked = true; break; }
        }
        if (linked) continue;
        fs.rmdirSync(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(code ?? '')) continue;
        pendingDirectories.push(directory);
        warnings.push(`${directory}：空备份目录未清理，${(error as Error).message}`);
      }
    }
    state.moves = remaining;
    state.pendingDirectories = pendingDirectories;
    if (remaining.length || pendingDirectories.length) atomicJson(this.file, state);
    else fs.unlinkSync(this.file);
    return warnings;
  }

  /** 调用者须持有维护锁；只迁移已登记且完整的备份。 */
  migrate(nextSettings: BackupSettings, directoryFor: (entry: BackupIndexEntry) => string): { migratedCount: number; skippedMissingCount: number; warnings: string[] } {
    const previousWarnings = this.reconcile();
    if (previousWarnings.length) throw new Error('上次迁移的旧文件或空目录尚未清理，请先点击“重试清理旧目录”');
    const index = fs.existsSync(this.paths.backupsIndex)
      ? JSON.parse(fs.readFileSync(this.paths.backupsIndex, 'utf8')) as BackupIndexEntry[] : [];
    const moves: Move[] = [];
    const targets = new Set<string>();
    let skippedMissingCount = 0;
    const nextIndex = index.flatMap(entry => {
      if (path.basename(entry.fileName) !== entry.fileName) throw new Error('备份文件名不合法');
      const directory = directoryFor(entry);
      for (let ancestor = path.resolve(directory); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
        if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`迁移目标不能包含目录链接：${ancestor}`);
      }
      const source = path.resolve(entry.dirPath, entry.fileName);
      try { fs.statSync(source); }
      catch (error) {
        // 仅处理确定丢失的记录；磁盘/网络根目录不可访问或权限错误仍明确拒绝。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!fs.existsSync(path.parse(source).root)) throw new Error(`原备份磁盘无法访问：${source}，请连接磁盘后重试`);
        skippedMissingCount++;
        return [];
      }
      const target = path.resolve(directory, entry.fileName);
      if (targets.has(target.toLowerCase())) throw new Error(`迁移目标重名：${target}`);
      targets.add(target.toLowerCase());
      if (!matches(source, entry)) throw new Error(`原备份缺失或校验失败：${source}，目录未切换`);
      if (source.toLowerCase() !== target.toLowerCase()) {
        if (fs.existsSync(target) && !matches(target, entry)) throw new Error(`新目录存在不同内容的同名文件：${target}，不会覆盖`);
        moves.push({ id: entry.id, source, target, temporary: `${target}.migration-${crypto.randomUUID()}.tmp`, sha256: entry.sha256, sizeBytes: entry.sizeBytes, created: false });
      }
      return [{ ...entry, dirPath: directory }];
    });
    const state: Migration = { phase: 'prepared', originalSettings: structuredClone(this.runtime.load().backupSettings), nextSettings, originalIndex: index, nextIndex, moves };
    atomicJson(this.file, state);
    try {
      for (const move of moves) {
        fs.mkdirSync(path.dirname(move.target), { recursive: true });
        if (!fs.existsSync(move.target)) {
          fs.copyFileSync(move.source, move.temporary, fs.constants.COPYFILE_EXCL);
          if (!matches(move.temporary, move)) throw new Error(`复制校验失败：${move.source}`);
          // 完整临时副本一次落位，避免中断留下半个目标ZIP；优先使用不会覆盖同名文件的硬链接。
          try { fs.linkSync(move.temporary, move.target); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(code ?? '')) throw error;
            // FAT/部分网络盘不支持硬链接；临时文件在同目录，改名仍是同卷操作。
            if (fs.existsSync(move.target)) throw new Error(`目标文件已存在，不会覆盖：${move.target}`);
            fs.renameSync(move.temporary, move.target);
          }
          move.created = true;
          atomicJson(this.file, state);
          if (fs.existsSync(move.temporary)) fs.unlinkSync(move.temporary);
        }
        if (!matches(move.target, move)) throw new Error(`目标备份校验失败：${move.target}`);
      }
      atomicJson(this.paths.backupsIndex, nextIndex);
      this.runtime.mutate(cfg => { cfg.backupSettings = nextSettings; });
      state.phase = 'committed';
      atomicJson(this.file, state);
    } catch (error) {
      // 提交日志写入失败时也按 prepared 回滚；此阶段源文件均保留。
      state.phase = 'prepared';
      atomicJson(this.file, state);
      this.reconcile();
      throw error;
    }
    return { migratedCount: moves.length, skippedMissingCount, warnings: this.cleanup(state) };
  }
}
