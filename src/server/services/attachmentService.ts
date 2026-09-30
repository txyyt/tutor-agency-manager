// 附件：上传（全量校验后一次提交）、受控下载/预览、删除、未引用文件清理。
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIMITS, type AttachmentMeta, type ApplicationRecord } from '../../shared/types.js';
import { conflict, notFound, payloadTooLarge } from '../errors.js';
import { tx } from '../transaction.js';
import type { Clock } from '../clock.js';
import type { Repository } from '../repository.js';
import type { ActiveData } from '../activeData.js';
import { maintenanceUnavailable } from '../errors.js';

const MAGIC_CHECKS: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
];

export interface UploadedFile {
  fieldName: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

export class AttachmentService {
  constructor(
    private deps: {
      db: DatabaseSync;
      repo: Repository;
      clock: Clock;
      active: ActiveData;
    },
  ) {}

  /** 全部文件校验通过才提交元数据；任一失败不留半组记录 */
  upload(
    applicationId: number,
    files: UploadedFile[],
    version: number,
  ): { application: ApplicationRecord; added: AttachmentMeta[] } {
    if (files.length === 0) throw conflict('NO_FILES', '没有选择任何文件');
    return tx(this.deps.db, () => {
      const app = this.deps.repo.getApplicationById(applicationId);
      if (!app) throw notFound(`报名不存在（id=${applicationId}）`);
      if (app.version !== version) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const order = this.deps.repo.getOrderById(app.orderId)!;
      if (order.status === 'completed') throw conflict('STATE_CONFLICT', '订单已完成，不能变更附件');
      if (app.attachments.length + files.length > LIMITS.maxAttachmentsPerApplication) {
        throw conflict(
          'TOO_MANY_FILES',
          `附件最多${LIMITS.maxAttachmentsPerApplication}个（已有${app.attachments.length}个）`,
        );
      }
      const dir = this.deps.active.ensureAttachmentsDir();
      const added: AttachmentMeta[] = [];
      const writtenPaths: string[] = [];
      try {
        for (const f of files) {
          if (f.size > LIMITS.maxAttachmentBytes) {
            throw payloadTooLarge(`文件“${f.originalName}”超过${LIMITS.maxAttachmentBytes / 1024 / 1024}MB上限`);
          }
          const magic = MAGIC_CHECKS.find((m) => m.mime === f.mimeType);
          if (!magic || !magic.test(f.buffer)) {
            throw conflict(
              'UNSUPPORTED_FILE_TYPE',
              `文件“${f.originalName}”类型无效：仅支持 PDF/JPEG/PNG（服务端已校验内容，HTML/可执行文件会被拒绝）`,
            );
          }
          const fileId = crypto.randomUUID();
          const storagePath = fileId;
          const abs = path.join(dir, storagePath);
          fs.writeFileSync(abs, f.buffer);
          writtenPaths.push(abs);
          added.push({
            fileId,
            originalName: f.originalName,
            storagePath,
            size: f.size,
            mimeType: f.mimeType,
            uploadedAt: this.deps.clock.iso(),
          });
        }
        const nextMeta = [...app.attachments, ...added];
        this.deps.db
          .prepare('UPDATE applications SET attachments_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(JSON.stringify(nextMeta), this.deps.clock.iso(), applicationId, version);
        return { application: this.deps.repo.getApplicationById(applicationId)!, added };
      } catch (err) {
        // 失败：清理本次写入的文件（未引用文件也会被周期清理兜底）
        for (const p of writtenPaths) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    });
  }

  getAttachment(applicationId: number, fileId: string): { meta: AttachmentMeta; absolutePath: string } {
    const app = this.deps.repo.getApplicationById(applicationId);
    if (!app) throw notFound('报名不存在');
    const meta = app.attachments.find((a) => a.fileId === fileId);
    if (!meta) throw notFound('附件不存在');
    // 存储名严格校验：只允许uuid格式，防路径穿越
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.storagePath)) {
      throw conflict('INVALID_STORAGE_PATH', '附件存储路径异常');
    }
    const abs = path.join(this.deps.active.attachmentsDir, meta.storagePath);
    if (!fs.existsSync(abs)) throw notFound('附件文件已丢失，请从备份恢复');
    return { meta, absolutePath: abs };
  }

  delete(applicationId: number, fileId: string, version: number): { application: ApplicationRecord; deletedFile: string | null } {
    return tx(this.deps.db, () => {
      const app = this.deps.repo.getApplicationById(applicationId);
      if (!app) throw notFound('报名不存在');
      if (app.version !== version) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const order = this.deps.repo.getOrderById(app.orderId)!;
      if (order.status === 'completed') throw conflict('STATE_CONFLICT', '订单已完成，不能变更附件');
      const meta = app.attachments.find((a) => a.fileId === fileId);
      if (!meta) throw notFound('附件不存在');
      const next = app.attachments.filter((a) => a.fileId !== fileId);
      this.deps.db
        .prepare('UPDATE applications SET attachments_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(JSON.stringify(next), this.deps.clock.iso(), applicationId, version);
      return { application: this.deps.repo.getApplicationById(applicationId)!, deletedFile: meta.storagePath };
    });
  }

  /** 删除附件文件（提交后执行）；失败返回false由未引用清理兜底重试 */
  removeAttachmentFile(storagePath: string): boolean {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(storagePath)) return false;
      const abs = path.join(this.deps.active.attachmentsDir, storagePath);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** 清理未被任何报名引用的附件文件（启动/清理/上传失败后兜底） */
  sweepUnreferenced(): { removed: number; failed: number } {
    const db = this.deps.db;
    const rows = db.prepare('SELECT attachments_json FROM applications').all() as Array<{ attachments_json: string }>;
    const referenced = new Set<string>();
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.attachments_json) as AttachmentMeta[];
        for (const a of arr) referenced.add(a.storagePath);
      } catch {
        /* ignore */
      }
    }
    let removed = 0;
    let failed = 0;
    let dir: string;
    try {
      dir = this.deps.active.attachmentsDir;
    } catch (e) {
      void maintenanceUnavailable; // 已在维护态：跳过
      if ((e as { code?: string }).code === 'MAINTENANCE') return { removed: 0, failed: 0 };
      throw e;
    }
    if (!fs.existsSync(dir)) return { removed: 0, failed: 0 };
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      if (!referenced.has(name)) {
        try {
          fs.unlinkSync(path.join(dir, name));
          removed++;
        } catch {
          failed++;
        }
      }
    }
    return { removed, failed };
  }
}
