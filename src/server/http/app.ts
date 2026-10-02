// Express应用：安全中间件（Host/Origin/CSRF/data_epoch/维护门）+ 全部API路由 + 静态页面。
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZodError, z } from 'zod';
import { tx } from '../transaction.js';
import {
  LIMITS,
  type ApplicationRecord,
  type BackupKind,
  type FinanceState,
  type OrderRecord,
} from '../../shared/types.js';
import {
  APPLICATION_STATUS_LABELS,
  DISPLAY_TIMEZONE,
  ORDER_STATUS_LABELS,
} from '../../shared/types.js';
import { computeFinanceState, financeContextFor } from '../../shared/finance.js';
import { buildCandidateSummaries, buildRecruitingText, buildFeeNotice } from '../../shared/textgen.js';
import { getTemplate } from '../../shared/templates.js';
import {
  ParseStructureError,
  parentDraftToForm,
  parseTemplate,
  teacherDraftToForm,
} from '../../shared/parsing/parseTemplate.js';
import type { Repository } from '../repository.js';
import { hkDateString } from '../../shared/datetime.js';
import { AppError, badRequest, conflict, notFound, unauthorizedOrigin } from '../errors.js';
import type { ActiveData } from '../activeData.js';
import type { Clock } from '../clock.js';
import type { RuntimeConfigStore } from '../runtimeConfig.js';
import type { DataPaths } from '../paths.js';
import type { OrderService } from '../services/orderService.js';
import type { ApplicationService } from '../services/applicationService.js';
import type { AttachmentService, UploadedFile } from '../services/attachmentService.js';
import type { CleanupService } from '../services/cleanupService.js';
import type { BackupService } from '../services/backupService.js';
import type { RestoreService } from '../services/restoreService.js';
import type { Scheduler } from '../services/schedulerService.js';
import type { MaintenanceMutex } from '../locks.js';
import {
  applicationActionSchema,
  applicationCreateSchema,
  applicationUpdateSchema,
  backupSettingsSchema,
  financeCorrectionSchema,
  financeSchema,
  orderActionSchema,
  orderCreateSchema,
  orderUpdateSchema,
  parseImportSchema,
  recommendationsSchema,
} from '../schemas.js';

interface Services {
  env: { port: number; host: string; appVersion: string; allowTimeControl: boolean; distClientDir: string };
  clock: Clock;
  runtime: RuntimeConfigStore;
  paths: DataPaths;
  active: ActiveData;
  repo: Repository;
  orders: OrderService;
  applications: ApplicationService;
  attachments: AttachmentService;
  cleanup: CleanupService;
  backups: BackupService;
  restores: RestoreService;
  scheduler: Scheduler;
  maintenance: MaintenanceMutex;
  onRecordChanged: () => void; // 编号高水位落盘等
}

interface SessionState {
  csrfToken: string;
  createdAt: string;
}

export interface MaintenanceOperation {
  id: string;
  type: 'backup' | 'restore' | 'cleanup';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  result?: unknown;
  error?: string;
}

export function createApp(svc: Services): Express {
  const app = express();
  const sessions = new Map<string, SessionState>();
  const operations = new Map<string, MaintenanceOperation>();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---- 安全：Host/Origin 校验（本机服务，拒绝外部主机名/网页发起的请求） ----
  const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const isLocalHostHeader = (h: string): boolean => {
    const hostname = h.replace(/:\d+$/, '');
    return LOCAL_HOSTNAMES.has(hostname);
  };
  const isLocalOrigin = (o: string): boolean => {
    try {
      const u = new URL(o);
      return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTNAMES.has(u.hostname);
    } catch {
      return false;
    }
  };
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!isLocalHostHeader(host)) {
      return next(unauthorizedOrigin(`Host“${host}”不是本机服务地址，已拒绝（只允许127.0.0.1/localhost）`));
    }
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) {
      return next(unauthorizedOrigin(`来源“${origin}”不受信任，已拒绝（只允许本机页面）`));
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // ---- 会话与CSRF ----
  function parseCookies(req: Request): Record<string, string> {
    const header = req.headers.cookie ?? '';
    const out: Record<string, string> = {};
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
  }

  function getSession(req: Request): SessionState | null {
    const sid = parseCookies(req).tam_session;
    if (!sid) return null;
    return sessions.get(sid) ?? null;
  }

  app.get('/api/session', (req, res) => {
    const cookies = parseCookies(req);
    let sid = cookies.tam_session;
    let session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      sid = crypto.randomUUID();
      session = { csrfToken: crypto.randomUUID(), createdAt: svc.clock.iso() };
      sessions.set(sid, session);
      res.setHeader('Set-Cookie', `tam_session=${sid}; Path=/; HttpOnly; SameSite=Strict`);
    }
    res.json({
      csrfToken: session.csrfToken,
      dataEpoch: svc.runtime.load().dataEpoch,
      appVersion: svc.env.appVersion,
      allowTimeControl: svc.env.allowTimeControl,
      displayTimezone: DISPLAY_TIMEZONE,
      serverTime: svc.clock.iso(),
    });
  });

  // ---- 维护门：恢复切换期间暂停读写（进度端点除外） ----
  const MAINTENANCE_EXEMPT = ['/maintenance/operations/', '/session', '/health'];
  app.use('/api', (req, res, next) => {
    if (!svc.active.isOpen && !MAINTENANCE_EXEMPT.some((p) => req.path.startsWith(p))) {
      return next(new AppError(503, 'MAINTENANCE', '数据正在恢复切换，请稍后刷新页面重试'));
    }
    next();
  });

  // ---- CSRF + data_epoch：所有变更请求 ----
  const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  app.use('/api', (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    if (svc.maintenance.isHeld) {
      return next(new AppError(503, 'MAINTENANCE', '正在执行数据维护，请稍后重试；本次修改尚未保存'));
    }
    const session = getSession(req);
    if (!session) {
      return next(unauthorizedOrigin('缺少本机会话，请刷新页面后重试'));
    }
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token !== session.csrfToken) {
      return next(unauthorizedOrigin('缺少或错误的CSRF令牌：请刷新页面后重试'));
    }
    const epoch = req.headers['x-data-epoch'];
    const currentEpoch = String(svc.runtime.load().dataEpoch);
    if (epoch !== currentEpoch) {
      return next(conflict('DATA_EPOCH_CONFLICT', '页面数据已过期（可能刚完成恢复），请刷新页面后再试'));
    }
    next();
  });

  // ---- 工具 ----
  function validate<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
    try {
      return schema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of err.issues) {
          const key = issue.path.join('.') || '_';
          if (!fieldErrors[key]) fieldErrors[key] = issue.message;
        }
        throw badRequest('VALIDATION_FAILED', '填写有误，请检查标出的字段', fieldErrors);
      }
      throw err;
    }
  }

  function financeOf(app: ApplicationRecord, order: OrderRecord): FinanceState {
    const ctx = financeContextFor(app.status, order.status, order.currentApplicationId === app.id);
    return computeFinanceState(app, ctx);
  }

  function registerOperation(type: MaintenanceOperation['type']): MaintenanceOperation {
    const op: MaintenanceOperation = {
      id: crypto.randomUUID(),
      type,
      status: 'running',
      startedAt: svc.clock.iso(),
      finishedAt: null,
    };
    operations.set(op.id, op);
    return op;
  }

  function finishOperation(op: MaintenanceOperation, result?: unknown, error?: string): void {
    op.status = error ? 'failed' : 'succeeded';
    op.finishedAt = svc.clock.iso();
    op.result = result;
    op.error = error;
  }

  // ---- 基础路由 ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, appVersion: svc.env.appVersion });
  });

  app.get('/api/dashboard', (_req, res) => {
    res.json(svc.orders.dashboard());
  });

  // ---- 订单 ----
  app.get('/api/orders', (req, res) => {
    const q = req.query;
    res.json(
      svc.orders.listOrders({
        q: typeof q.q === 'string' && q.q.trim() ? q.q.trim() : undefined,
        status: typeof q.status === 'string' && q.status ? q.status : undefined,
        subject: typeof q.subject === 'string' && q.subject ? q.subject : undefined,
        grade: typeof q.grade === 'string' && q.grade ? q.grade : undefined,
        dateFrom: typeof q.dateFrom === 'string' && q.dateFrom ? q.dateFrom : undefined,
        dateTo: typeof q.dateTo === 'string' && q.dateTo ? q.dateTo : undefined,
        needsAction: q.needsAction === '1',
        sort: validate(z.enum(['updated-desc', 'updated-asc', 'number-desc', 'number-asc']).default('updated-desc'), q.sort),
        tasksFirst: q.tasksFirst !== '0',
        page: Number(q.page ?? 1) || 1,
        pageSize: Number(q.pageSize ?? 20) || 20,
      }),
    );
  });

  app.post('/api/orders', (req, res) => {
    const body = validate(orderCreateSchema, req.body);
    const result = svc.orders.createOrder(body, {
      sourceTemplateText: body.sourceTemplateText ?? null,
      creationRequestId: body.creationRequestId ?? null,
    });
    svc.onRecordChanged();
    res.status(result.duplicated ? 200 : 201).json(result);
  });

  app.get('/api/orders/:id', (req, res) => {
    const order = svc.orders.getOrderByNoOrId(String(req.params.id));
    if (!order) throw notFound('订单不存在，请核对订单编号或ID');
    const apps = svc.repo.listApplicationsOfOrder(order.id);
    const applications = apps.map((a) => ({
      ...a,
      finance: financeOf(a, order),
      isCurrent: order.currentApplicationId === a.id,
      isMatched: order.matchedApplicationId === a.id,
    }));
    res.json({ order, applications });
  });

  app.patch('/api/orders/:id', (req, res) => {
    const body = validate(orderUpdateSchema, req.body);
    const version = Number(req.query.version ?? req.body?.version);
    if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', '缺少version（并发保护）');
    const result = svc.orders.updateGeneral(Number(req.params.id), body, version);
    res.json(result);
  });

  app.post('/api/orders/:id/actions', (req, res) => {
    const body = validate(orderActionSchema, req.body);
    const result = svc.orders.orderAction(Number(req.params.id), body.action, body, body.version);
    res.json(result);
  });

  const registrationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.maxAttachmentBytes, files: LIMITS.maxAttachmentsPerApplication } });
  function checkUploadGeneration(req: Request): void {
    if (svc.maintenance.isHeld || !svc.active.isOpen) throw new AppError(503, 'MAINTENANCE', '正在执行数据维护，本次资料尚未保存');
    if (req.headers['x-data-epoch'] !== String(svc.runtime.load().dataEpoch)) throw conflict('DATA_EPOCH_CONFLICT', '数据已恢复，请刷新后重新保存');
  }
  function uploadedFiles(req: Request): UploadedFile[] {
    return (req.files as Express.Multer.File[] ?? []).map(f => ({ fieldName: f.fieldname, originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'), mimeType: f.mimetype, size: f.size, buffer: f.buffer }));
  }
  app.post('/api/orders/:id/applications', (req, res, next) => {
    const save = () => {
      try {
        checkUploadGeneration(req);
        const input = req.is('multipart/form-data') ? JSON.parse(String(req.body?.payload ?? '{}')) : req.body;
        const body = validate(applicationCreateSchema, input);
        const orderId = Number(req.params.id);
        if (body.sourceTemplateText) {
          const parsedNo = extractOrderNoFromText(body.sourceTemplateText);
          const order = svc.orders.getOrder(orderId);
          if (parsedNo && parsedNo !== order.orderNo) throw conflict('ORDER_NO_MISMATCH', `粘贴原文中的订单编号（${parsedNo}）与本订单（${order.orderNo}）不一致，已阻止保存`);
        }
        const result = tx(svc.active.proxy, () => {
          const created = svc.applications.createApplication(orderId, body, body);
          const files = uploadedFiles(req);
          if (files.length && !created.duplicated) created.application = svc.attachments.upload(created.application.id, files, created.application.version).application;
          return created;
        });
        svc.onRecordChanged();
        res.status(result.duplicated ? 200 : 201).json(result);
      } catch (error) {
        next(error instanceof SyntaxError ? badRequest('VALIDATION_FAILED', '报名资料格式无效') : error);
      }
    };
    if (req.is('multipart/form-data')) registrationUpload.array('files')(req, res, err => err ? next(mapMulterError(err)) : save());
    else save();
  });

  app.post('/api/orders/:id/recommendations', (req, res) => {
    const body = validate(recommendationsSchema, req.body);
    const order = svc.orders.getOrder(Number(req.params.id));
    const apps = svc.repo.listApplicationsOfOrder(order.id);
    const selected = body.applicationIds.map((id) => {
      const app = apps.find((a) => a.id === id);
      if (!app) throw badRequest('VALIDATION_FAILED', `报名${id}不属于本订单，不能混入其他订单的候选`);
      return app;
    });
    if (body.mode === 'summary') {
      res.json({ text: buildCandidateSummaries(order, selected), order });
      return;
    }
    // mark-recommended：先全部校验再执行，要么全部成功要么无变更
    const invalid = selected.find((a) => !['submitted', 'recommended'].includes(a.status));
    if (invalid) {
      throw conflict(
        'STATE_CONFLICT',
        `报名 ${invalid.applicationNo}（${APPLICATION_STATUS_LABELS[invalid.status]}）不能标为已推荐。已推荐重复标记无变化；不能把待试课/通过/终止记录标推荐`,
      );
    }
    const changed: number[] = [];
    for (const a of selected) {
      if (a.status === 'submitted') {
        svc.applications.applicationAction(a.id, 'recommend', {}, a.version);
        changed.push(a.id);
      }
    }
    res.json({ marked: changed.length, message: `已标记${changed.length}位为已推荐（发送家长后请手动标记）` });
  });

  // ---- 报名 ----
  app.get('/api/applications/:id', (req, res) => {
    const app = svc.applications.getApplication(Number(req.params.id));
    const order = svc.orders.getOrder(app.orderId);
    res.json({
      application: { ...app, finance: financeOf(app, order), isCurrent: order.currentApplicationId === app.id },
      order,
    });
  });

  app.patch('/api/applications/:id', (req, res) => {
    const body = validate(applicationUpdateSchema, req.body);
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', '缺少version（并发保护）');
    const result = svc.applications.updateGeneral(Number(req.params.id), body, version);
    res.json(result);
  });

  app.post('/api/applications/:id/profile', (req, res, next) => {
    registrationUpload.array('files')(req, res, err => {
      if (err) return next(mapMulterError(err));
      try {
        checkUploadGeneration(req);
        const input = JSON.parse(String(req.body?.payload ?? '{}'));
        const body = validate(applicationUpdateSchema, input);
        if (!Number.isInteger(input.version)) throw badRequest('VALIDATION_FAILED', '缺少资料版本');
        const result = tx(svc.active.proxy, () => {
          const r = svc.applications.updateGeneral(Number(req.params.id), body, input.version);
          const files = uploadedFiles(req);
          if (files.length) r.application = svc.attachments.upload(r.application.id, files, r.application.version).application;
          return r;
        });
        res.json(result);
      } catch (error) { next(error instanceof SyntaxError ? badRequest('VALIDATION_FAILED', '资料格式无效') : error); }
    });
  });

  app.post('/api/applications/:id/actions', (req, res) => {
    const body = validate(applicationActionSchema, req.body);
    const result = svc.applications.applicationAction(Number(req.params.id), body.action, body, body.version);
    res.json(result);
  });

  app.post('/api/applications/:id/finance', (req, res) => {
    const body = validate(financeSchema, req.body);
    const result = svc.applications.financeOperation(Number(req.params.id), body, body.version);
    res.json(result);
  });

  app.post('/api/applications/:id/finance/corrections', (req, res) => {
    const body = validate(financeCorrectionSchema, req.body);
    const result = svc.applications.financeCorrection(Number(req.params.id), body, body.version);
    res.json(result);
  });

  app.get('/api/applications/:id/fee-notice', (req, res) => {
    const app = svc.applications.getApplication(Number(req.params.id));
    const order = svc.orders.getOrder(app.orderId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(buildFeeNotice(app, order.orderNo));
  });

  // 合并业务操作：一次确认、一组事务；重试相同操作ID不会重复收款或重复安排。
  const workflowSchema = z.object({
    action: z.enum(['schedule', 'prepare', 'receive-start', 'start', 'pass', 'fail', 'withdraw', 'direct', 'settle', 'refund', 'complete']),
    operationId: z.string().uuid(), version: z.number().int(), orderVersion: z.number().int(),
    agencyFeeCents: z.number().int().min(0).optional(), depositDueCents: z.number().int().min(0).optional(),
    amountCents: z.number().int().min(0).optional(),
  });
  app.post('/api/applications/:id/workflow', (req, res) => {
    const body = validate(workflowSchema, req.body);
    const id = Number(req.params.id);
    const { version, orderVersion, ...payload } = body;
    const result = tx(svc.active.proxy, () => {
      let application = svc.applications.getApplication(id);
      let order = svc.orders.getOrder(application.orderId);
      const old = application.financeOperations.find(o => o.operationId === body.operationId);
      if (old) {
        if (old.type !== 'workflow' || JSON.stringify(old.payload) !== JSON.stringify(payload)) throw conflict('OPERATION_ID_CONFLICT', '操作ID已用于其他内容');
        return { application, order, message: '该操作已保存，未重复执行', replayed: true };
      }
      if (application.version !== version || order.version !== orderVersion) throw conflict('VERSION_CONFLICT', '资料或订单已变化，请刷新后重试');
      const action = (name: string) => {
        const r = svc.applications.applicationAction(id, name, { orderVersion: order.version }, application.version);
        application = r.application; order = r.order;
      };
      const finance = (type: 'set-fees' | 'receive-deposit' | 'receive-supplement' | 'refund-deposit' | 'refund-supplement', amountCents?: number) => {
        application = svc.applications.financeOperation(id, { type, operationId: crypto.randomUUID(), amountCents, agencyFeeCents: body.agencyFeeCents, depositDueCents: body.depositDueCents }, application.version).application;
      };
      let completionMessage = '';
      const tryComplete = () => {
        order = svc.orders.getOrder(order.id);
        if (order.status !== 'reviewing' || !order.currentApplicationId) return;
        try { order = svc.orders.orderAction(order.id, 'complete', {}, order.version).order; }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== 'COMPLETION_BLOCKED') throw error;
          completionMessage = error.message;
        }
      };
      if (['prepare', 'receive-start', 'start', 'settle', 'complete'].includes(body.action) && order.currentApplicationId !== id) throw conflict('STATE_CONFLICT', '请操作本单当前老师');
      switch (body.action) {
        case 'schedule':
          action('schedule-trial'); finance('set-fees');
          if ((body.amountCents ?? 0) > 0) finance('receive-deposit', body.amountCents);
          break;
        case 'prepare':
          if (order.status !== 'awaiting_trial') throw conflict('STATE_CONFLICT', '只能在待试课阶段登记保证金');
          finance('set-fees'); if ((body.amountCents ?? 0) > 0) finance('receive-deposit', body.amountCents); break;
        case 'receive-start': {
          if (order.status !== 'awaiting_trial') throw conflict('STATE_CONFLICT', '只能在待试课阶段确认保证金');
          if ((body.amountCents ?? 0) <= 0) throw conflict('INVALID_AMOUNT', '请填写实际收到的保证金金额');
          finance('receive-deposit', body.amountCents);
          if (financeOf(application, order).pendingDepositCents === 0) {
            order = svc.orders.orderAction(order.id, 'start-trial', {}, order.version).order;
            completionMessage = '保证金已收齐，试课已开始';
          } else completionMessage = '本次保证金已登记，收齐后开始试课';
          break;
        }
        case 'start': order = svc.orders.orderAction(order.id, 'start-trial', {}, order.version).order; break;
        case 'pass': action('pass'); if ((body.amountCents ?? 0) > 0) finance('receive-supplement', body.amountCents); tryComplete(); break;
        case 'direct':
          action('direct-cooperation');
          if (body.agencyFeeCents !== undefined) finance('set-fees');
          if ((body.amountCents ?? 0) > 0) finance('receive-supplement', body.amountCents);
          tryComplete(); break;
        case 'fail': action('fail'); break;
        case 'withdraw': action('withdraw'); break;
        case 'settle':
          if (order.status !== 'reviewing') throw conflict('STATE_CONFLICT', '只能在待结算阶段收取中介费');
          if (body.agencyFeeCents !== undefined) {
            if (application.agencyFeeCents !== null) throw conflict('STATE_CONFLICT', '中介费已约定，调整金额请使用更正登记');
            finance('set-fees');
          }
          if ((body.amountCents ?? 0) > 0) finance('receive-supplement', body.amountCents);
          else if (application.agencyFeeCents !== 0) throw conflict('INVALID_AMOUNT', '请填写实际收到的中介费金额');
          tryComplete(); break;
        case 'refund': {
          const pending = financeOf(application, order).pendingRefundCents;
          const amount = body.amountCents ?? 0;
          if (amount <= 0 || amount > pending) throw conflict('INVALID_AMOUNT', '本次退款必须大于0且不超过待退款金额');
          const deposit = Math.min(amount, application.depositReceivedCents - application.depositRefundedCents);
          if (deposit > 0) finance('refund-deposit', deposit);
          if (amount > deposit) finance('refund-supplement', amount - deposit);
          tryComplete(); break;
        }
        case 'complete': order = svc.orders.orderAction(order.id, 'complete', {}, order.version).order; break;
      }
      application = svc.applications.getApplication(id);
      const record = { operationId: body.operationId, type: 'workflow', payload, before: {}, after: {}, applied: true, at: svc.clock.iso() };
      svc.active.proxy.prepare('UPDATE applications SET finance_operations_json = ? WHERE id = ?').run(JSON.stringify([...application.financeOperations, record]), id);
      return { application: svc.applications.getApplication(id), order, message: order.status === 'completed' ? '费用已结清，订单已完成' : completionMessage || '操作已保存', replayed: false };
    });
    res.json(result);
  });

  // 删除前锁内备份；未结清款项不能被删除操作抹去。
  async function deleteRecord(req: Request, res: Response, kind: 'order' | 'application'): Promise<void> {
    const version = Number(req.query.version);
    if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', '缺少版本，请刷新重试');
    const epoch = req.headers['x-data-epoch'];
    await svc.maintenance.runExclusive(async () => {
      if (epoch !== String(svc.runtime.load().dataEpoch)) throw conflict('DATA_EPOCH_CONFLICT', '数据已恢复，请刷新后重试');
      const application = kind === 'application' ? svc.applications.getApplication(Number(req.params.id)) : null;
      const order = svc.orders.getOrder(application?.orderId ?? Number(req.params.id));
      const record = application ?? order;
      if (record.version !== version) throw conflict('VERSION_CONFLICT', '记录已变化，请刷新后重试');
      const apps = application ? [application] : svc.repo.listApplicationsOfOrder(order.id);
      if (apps.some(a => a.id === order.currentApplicationId) && ['awaiting_trial', 'trialing'].includes(order.status)) throw conflict('DELETE_ACTIVE_TRIAL', '请先登记老师退出或取消订单，再删除正在试课的记录');
      if (application && order.matchedApplicationId === application.id) throw conflict('DELETE_MATCHED', '成交老师关联已完成订单，请从订单详情删除整单');
      if (apps.some(a => {
        const f = financeOf(a, order);
        return order.status === 'completed' ? (!f.settled || f.pendingRefundCents > 0) : f.netReceivedCents !== 0;
      })) throw conflict('DELETE_UNSETTLED', '存在未结清款项，请先退款或完成结算，再删除');
      const hasHistory = order.status === 'completed' || apps.some(a => a.depositReceivedCents > 0 || a.feeSupplementReceivedCents > 0 || a.financeOperations.some(o => o.type === 'correction'));
      const no = application?.applicationNo ?? order.orderNo;
      if (hasHistory && req.query.confirmHistory !== no) throw conflict('DELETE_CONFIRM_REQUIRED', `存在费用历史，请输入 ${no} 再次确认删除`);
      const backup = await svc.backups.performBackupLocked('pre-delete');
      tx(svc.active.proxy, () => {
        if (application) {
          if (order.currentApplicationId === application.id) svc.active.proxy.prepare("UPDATE orders SET current_application_id = NULL, status = 'recruiting', version = version + 1, updated_at = ? WHERE id = ?").run(svc.clock.iso(), order.id);
          svc.active.proxy.prepare('DELETE FROM applications WHERE id = ?').run(application.id);
        } else {
          // 订单与报名双向引用：先在同一事务中解除订单指向老师的引用。
          svc.active.proxy.prepare('UPDATE orders SET current_application_id = NULL, matched_application_id = NULL WHERE id = ?').run(order.id);
          svc.active.proxy.prepare('DELETE FROM applications WHERE order_id = ?').run(order.id);
          svc.active.proxy.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
        }
      });
      for (const a of apps) for (const file of a.attachments) svc.attachments.removeAttachmentFile(file.storagePath);
      res.json({ deleted: true, backupId: backup.id, applicationsDeleted: apps.length });
    });
  }
  app.delete('/api/orders/:id', async (req, res) => { await deleteRecord(req, res, 'order'); });
  app.delete('/api/applications/:id', async (req, res) => { await deleteRecord(req, res, 'application'); });

  // ---- 附件 ----
  const uploadAttachment = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIMITS.maxAttachmentBytes, files: LIMITS.maxAttachmentsPerApplication },
  });

  app.post('/api/applications/:id/attachments', (req, res, next) => {
    uploadAttachment.array('files', LIMITS.maxAttachmentsPerApplication)(req, res, (err) => {
      if (err) return next(mapMulterError(err));
      try {
        // multipart读取期间可能开始恢复；不得将旧页面上传写入新数据代。
        if (svc.maintenance.isHeld || !svc.active.isOpen) {
          throw new AppError(503, 'MAINTENANCE', '正在执行数据维护，附件尚未保存，请稍后重试');
        }
        if (req.headers['x-data-epoch'] !== String(svc.runtime.load().dataEpoch)) {
          throw conflict('DATA_EPOCH_CONFLICT', '数据已恢复，请刷新页面后重新上传附件');
        }
        const version = Number(req.body?.version);
        if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', '缺少version（并发保护）');
        const files: UploadedFile[] = (req.files as Express.Multer.File[] ?? []).map((f) => ({
          fieldName: f.fieldname,
          // multer按latin1解码multipart文件名；浏览器实际发送UTF-8字节 → 还原
          originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
          mimeType: f.mimetype,
          size: f.size,
          buffer: f.buffer,
        }));
        const result = svc.attachments.upload(Number(req.params.id), files, version);
        res.status(201).json(result);
      } catch (e) {
        next(e);
      }
    });
  });

  function sendAttachment(req: Request, res: Response, inline: boolean): void {
    const { meta, absolutePath } = svc.attachments.getAttachment(Number(req.params.id), String(req.params.fileId));
    const encodedName = encodeURIComponent(meta.originalName);
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Length', String(meta.size));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="attachment${path.extname(meta.originalName) || ''}"; filename*=UTF-8''${encodedName}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(absolutePath).pipe(res);
  }

  app.get('/api/applications/:id/attachments/:fileId', (req, res) => sendAttachment(req, res, false));
  app.get('/api/applications/:id/attachments/:fileId/preview', (req, res) => sendAttachment(req, res, true));

  app.delete('/api/applications/:id/attachments/:fileId', (req, res) => {
    const version = Number(req.query.version);
    if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', '缺少version（并发保护）');
    const result = svc.attachments.delete(Number(req.params.id), String(req.params.fileId), version);
    if (result.deletedFile) svc.attachments.removeAttachmentFile(result.deletedFile);
    res.json(result);
  });

  // ---- 模板与导出 ----
  app.get('/api/templates/:name', (req, res) => {
    const name = String(req.params.name);
    if (name !== 'parent' && name !== 'teacher') throw notFound('模板不存在');
    res.json({ name, text: getTemplate(name) });
  });

  app.get('/api/exports/recruiting', (req, res) => {
    // 全部招募中订单，不受分页/筛选影响
    const recruiting: OrderRecord[] = [];
    const pageSize = 100;
    for (let page = 1; ; page++) {
      const { items, total } = svc.orders.listOrders({ status: 'recruiting', page, pageSize });
      recruiting.push(...items);
      if (recruiting.length >= total || items.length === 0) break;
    }
    const text = buildRecruitingText(recruiting);
    const stamp = svc.clock.iso().slice(0, 19).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="recruiting-${stamp}.txt"; filename*=UTF-8''${encodeURIComponent(`招募导出-${stamp}.txt`)}`);
    res.send(text);
  });

  // ---- 粘贴解析（不写库） ----
  app.post('/api/imports/parse', (req, res) => {
    const body = validate(parseImportSchema, req.body);
    const ctx = { hkToday: hkDateString(svc.clock.iso()) };
    try {
      const result = parseTemplate(body.kind, body.text, ctx);
      let orderInfo: { orderId: number; orderNo: string; status: string; statusLabel: string; canApply: boolean } | null = null;
      let orderMismatch: string | null = null;
      if (result.orderNo) {
        const order = svc.orders.getOrderByNoOrId(result.orderNo);
        if (!order) {
          orderInfo = null;
          result.fieldErrors.orderNo = `订单编号“${result.orderNo}”不存在，请核对后修改`;
        } else {
          const statusLabel = ORDER_STATUS_LABELS[order.status];
          const canApply = ['recruiting', 'awaiting_trial', 'trialing'].includes(order.status);
          orderInfo = { orderId: order.id, orderNo: order.orderNo, status: order.status, statusLabel, canApply };
          if (body.contextOrderId && order.id !== body.contextOrderId) {
            orderMismatch = `原文编号指向订单 ${order.orderNo}，与当前页面订单不一致`;
          }
          if (!canApply) {
            result.fieldErrors.orderNo = `订单 ${order.orderNo} 当前状态为“${statusLabel}”，不能接收报名`;
          }
        }
      }
      const form = body.kind === 'parent' ? parentDraftToForm(result.draft) : teacherDraftToForm(result.draft);
      res.json({ ...result, form, orderInfo, orderMismatch });
    } catch (err) {
      if (err instanceof ParseStructureError) {
        throw badRequest(err.code, err.message);
      }
      throw err;
    }
  });

  // ---- 清理 ----
  app.get('/api/cleanup/preview', (_req, res) => {
    res.json(svc.cleanup.preview());
  });

  app.post('/api/cleanup/run', async (req, res, next) => {
    try {
      const op = registerOperation('cleanup');
      try {
        const result = await svc.cleanup.run();
        finishOperation(op, result);
        res.json({ operationId: op.id, ...result });
      } catch (err) {
        finishOperation(op, undefined, (err as Error).message);
        throw err;
      }
    } catch (e) {
      next(e);
    }
  });

  // ---- 备份 ----
  app.get('/api/backups', (_req, res) => {
    res.json({ ...svc.backups.listBackups(), scheduler: svc.scheduler.status() });
  });

  app.post('/api/backups', async (req, res, next) => {
    try {
      const kind = (req.body?.kind as BackupKind) ?? 'manual';
      if (!['daily', 'manual'].includes(kind)) throw badRequest('VALIDATION_FAILED', '手动备份类型只能是daily/manual');
      const op = registerOperation('backup');
      try {
        const entry = await svc.backups.createBackup(kind);
        finishOperation(op, { entry });
        res.status(201).json({ operationId: op.id, entry });
      } catch (err) {
        finishOperation(op, undefined, (err as Error).message);
        throw err;
      }
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/backups/:id/download', (req, res) => {
    const { entry, absolutePath } = svc.backups.getBackupFile(String(req.params.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(entry.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename="${entry.fileName}"; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`);
    fs.createReadStream(absolutePath).pipe(res);
  });

  app.delete('/api/backups/:id', (req, res) => {
    svc.backups.deleteBackup(String(req.params.id));
    res.json({ ok: true });
  });

  app.patch('/api/backups/settings', async (req, res) => {
    const body = validate(backupSettingsSchema, req.body);
    const migrationResult = await svc.backups.updateSettings(body);
    res.json({ ...svc.backups.listBackups(), migrationResult });
  });

  app.post('/api/backups/migration/retry-cleanup', async (_req, res) => {
    res.json(await svc.backups.retryMigrationCleanup());
  });

  // ---- 恢复 ----
  app.post('/api/restores/validate-existing', async (req, res) => {
    const { backupId } = validate(z.object({ backupId: z.string().uuid() }), req.body);
    const backup = svc.backups.getBackupFile(backupId);
    res.json(await svc.restores.validate(backup.absolutePath));
  });
  app.post('/api/restores/validate', (req, res, next) => {
    const limit = svc.runtime.load().backupSettings.importMaxUploadBytes;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 1 } });
    upload.single('file')(req, res, (err) => {
      if (err) return next(mapMulterError(err));
      (async () => {
        const file = (req.file as Express.Multer.File | undefined);
        if (!file) throw badRequest('NO_FILE', '没有上传备份包');
        const tmpZip = path.join(svc.paths.stagingDir, `upload-${crypto.randomUUID()}.zip`);
        fs.mkdirSync(svc.paths.stagingDir, { recursive: true });
        fs.writeFileSync(tmpZip, file.buffer);
        try {
          const result = await svc.restores.validate(tmpZip);
          res.json(result);
        } finally {
          try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
        }
      })().catch((e) => next(e));
    });
  });

  app.post('/api/restores/commit', async (req, res, next) => {
    try {
      const token = String(req.body?.token ?? '');
      const op = registerOperation('restore');
      try {
        const result = await svc.restores.commit(token);
        // 恢复成功后自动检查到期规则：清理失败不影响恢复结果
        let cleanupSummary: unknown = null;
        try {
          cleanupSummary = await svc.cleanup.run();
        } catch (e) {
          cleanupSummary = { error: (e as Error).message };
        }
        finishOperation(op, { result, cleanupSummary });
        res.json({ operationId: op.id, ...result, cleanupSummary });
      } catch (err) {
        finishOperation(op, undefined, (err as Error).message);
        throw err;
      }
    } catch (e) {
      next(e);
    }
  });

  // ---- 维护状态 ----
  app.get('/api/maintenance/operations/:id', (req, res) => {
    const op = operations.get(String(req.params.id));
    if (!op) throw notFound('操作不存在');
    res.json(op);
  });

  app.get('/api/maintenance/status', (_req, res) => {
    const cfg = svc.runtime.load();
    res.json({
      dataEpoch: cfg.dataEpoch,
      activeGenerationId: cfg.activeGenerationId,
      activeGenerationPath: svc.active.genDir,
      dataDir: svc.paths.dataDir,
      scheduler: svc.scheduler.status(),
      numberHighWater: cfg.numberHighWater,
      appVersion: svc.env.appVersion,
    });
  });

  // ---- 测试辅助（仅测试环境启用） ----
  app.post('/api/test/clock', (req, res) => {
    if (!svc.env.allowTimeControl) throw notFound('未启用时间控制');
    const offsetMs = Number(req.body?.offsetMs ?? 0);
    if (!Number.isFinite(offsetMs)) throw badRequest('VALIDATION_FAILED', 'offsetMs必须是数字');
    svc.clock.setOffsetMs(offsetMs);
    res.json({ offsetMs, now: svc.clock.iso() });
  });

  // ---- 静态页面 ----
  if (fs.existsSync(svc.env.distClientDir)) {
    app.use(express.static(svc.env.distClientDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(svc.env.distClientDir, 'index.html'));
    });
  }

  // ---- 404与错误处理 ----
  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  });

   
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      res.status(err.status).json(body);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ code: 'VALIDATION_FAILED', message: '请求参数有误' });
      return;
    }
    console.error('[UNEXPECTED]', err);
    res.status(500).json({ code: 'INTERNAL', message: '服务器内部错误，请重试或查看日志' });
  });

  return app;
}

function mapMulterError(err: unknown): AppError {
  const e = err as { code?: string; message?: string; field?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', `文件超过大小上限：${e.message ?? ''}`);
  }
  if (e?.code === 'LIMIT_FILE_COUNT') {
    return badRequest('TOO_MANY_FILES', '文件数量超过上限');
  }
  if (e?.code === 'LIMIT_UNEXPECTED_FILE') {
    return badRequest('VALIDATION_FAILED', `意外的上传字段：${e.field ?? ''}`);
  }
  if (err instanceof AppError) return err;
  return badRequest('UPLOAD_FAILED', (err as Error).message ?? '上传失败');
}

function extractOrderNoFromText(text: string): string | null {
  const m = /报名订单编号[：:]\s*([^\s\n]+)/.exec(text);
  return m?.[1] ?? null;
}
export type { Services };
