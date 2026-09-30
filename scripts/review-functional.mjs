// 功能复核回归：断言修复后的行为，全部数据位于test-results隔离目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../dist/server/serverFactory.js';
import { loadEnv } from '../dist/server/env.js';
import { chromium } from '@playwright/test';

fs.mkdirSync('test-results', { recursive: true });
const dataDir = fs.mkdtempSync(path.resolve('test-results', 'review-data-'));
const app = createServer(loadEnv({ dataDir, port: 3000, appRoot: process.cwd() }));
app.start(false);
const server = http.createServer(app.app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let session;
let cookie;
const results = [];
async function bootstrap() {
  const r = await fetch(`${base}/api/session`);
  cookie = r.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  session = await r.json();
}
async function req(method, url, body) {
  const r = await fetch(base + url, { method, headers: {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    'X-Data-Epoch': String(session.dataEpoch),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const orderPayload = {
  parentName: '复核虚构家长', parentWechat: 'review-parent', parentPhone: '13800001234',
  childGrade: '初三', subjects: '数学', learningSituation: '基础一般', tutoringGoal: '提高成绩',
  teachingMode: 'offline', locationDetail: '测试小区', publicArea: '测试区',
  weeklySchedule: '周六上午', publicSchedule: '周六上午', sessionsPerWeek: 1, sessionMinutes: 90,
  expectedStartDate: null, hourlyPayCents: 15000, payNegotiable: true, genderPreference: 'any',
  teacherRequirements: '原始要求', publicRequirements: '原始公开要求', notes: '必须保留的备注',
};
const teacherPayload = {
  teacherName: '复核虚构老师', gender: 'female', wechat: 'review-teacher', phone: '13900001234',
  university: '测试大学', major: '数学', studyYear: '大三', teachableSubjectsGrades: '初中数学',
  achievements: '原成绩说明', teachingExperience: '暂无', strengthsAndPlan: '基础巩固',
  availableSchedule: '周六上午', earliestStartDate: null, acceptsOrderPay: true,
  expectedHourlyPayCents: null, canAttendTrial: true, trialConstraints: '', notes: '老师原备注',
};
let browser;
try {
  await bootstrap();
  const order = (await req('POST', '/api/orders', orderPayload)).body.order;
  const teacher = (await req('POST', `/api/orders/${order.id}/applications`, teacherPayload)).body.application;

  const lookup = await req('GET', `/api/orders/${order.orderNo}`);
  assert.equal(lookup.status, 200);
  results.push({ case: 'public-order-number-lookup', status: lookup.status, body: lookup.body });

  app.clock.setOffsetMs(60_000);
  const noop = await req('PATCH', `/api/orders/${order.id}?version=${order.version}`, orderPayload);
  assert.equal(noop.body.changed, false);
  assert.equal(noop.body.order.updatedAt, order.updatedAt);
  results.push({ case: 'unchanged-full-save', changed: noop.body.changed,
    beforeUpdatedAt: order.updatedAt, afterUpdatedAt: noop.body.order.updatedAt });
  const partial = await req('PATCH', `/api/orders/${order.id}?version=${noop.body.order.version}`, { parentPhone: '13800009999' });
  assert.equal(partial.body.order.notes, orderPayload.notes);
  assert.equal(partial.body.order.teacherRequirements, orderPayload.teacherRequirements);
  assert.equal(partial.body.order.publicRequirements, orderPayload.publicRequirements);
  results.push({ case: 'partial-update-erases-other-fields', status: partial.status,
    teacherRequirements: partial.body.order.teacherRequirements,
    publicRequirements: partial.body.order.publicRequirements, notes: partial.body.order.notes });

  const targetMs = Date.parse('2026-09-30T17:00:00Z'); // Hong Kong 01:00 next day.
  app.clock.setOffsetMs(targetMs - Date.now());
  await app.scheduler.triggerNow();
  assert.equal(app.runtime.load().dailyBackup.lastSuccessDateHk, '2026-10-01');
  results.push({ case: 'startup-at-01-00', serverTime: app.clock.iso(),
    dailyBackupSucceeded: app.runtime.load().dailyBackup.lastSuccessDateHk });
  app.clock.setOffsetMs(0);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${base}/#/applications/${teacher.id}`);
  await page.getByRole('heading', { name: /费用面板/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: '编辑老师资料' }).count(), 1);
  results.push({ case: 'teacher-edit-ui', editButtons: await page.getByRole('button', { name: /编辑/ }).count(),
    editLinks: await page.getByRole('link', { name: /编辑/ }).count() });

  const entry = await app.backups.createBackup('manual');
  const zip = app.backups.getBackupFile(entry.id).absolutePath;
  let validated = await app.restores.validate(zip);
  const originalBackup = app.backups.performBackupLocked.bind(app.backups);
  let reached;
  const reachedPromise = new Promise(resolve => { reached = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.backups.performBackupLocked = async kind => {
    const result = await originalBackup(kind);
    if (kind === 'pre-restore') { reached(); await gate; }
    return result;
  };
  const restoring = app.restores.commit(validated.token);
  await reachedPromise;
  const during = await req('POST', '/api/orders', { ...orderPayload, parentName: '恢复中新增的记录' });
  release();
  await restoring;
  assert.equal(during.status, 503);
  app.backups.performBackupLocked = originalBackup;
  await bootstrap();
  const safety = app.backups.listBackups().entries.filter(e => e.kind === 'pre-restore').at(-1);
  const safetyPreview = await app.restores.validate(app.backups.getBackupFile(safety.id).absolutePath);
  results.push({ case: 'write-during-restore', writeStatus: during.status,
    safetyBackupOrderCount: safetyPreview.preview.counts.orders });

  validated = await app.restores.validate(zip);
  app.clock.setOffsetMs(16 * 60_000);
  await assert.rejects(app.restores.commit(validated.token), { code: 'TOKEN_INVALID' });
  results.push({ case: 'expired-restore-token', accepted: false, elapsedMinutes: 16 });
  app.clock.setOffsetMs(0);

  const originalSave = app.runtime.save.bind(app.runtime);
  validated = await app.restores.validate(zip);
  const currentId = app.runtime.load().activeGenerationId;
  const currentEpoch = app.runtime.load().dataEpoch;
  await bootstrap();
  const later = await req('POST', '/api/orders', { ...orderPayload, parentName: '应当在恢复失败后保留' });
  app.runtime.save = () => {
    if (app.runtime.load().activeGenerationId !== currentId) throw new Error('Review fault: runtime save failed');
    return originalSave();
  };
  let restoreError;
  try { await app.restores.commit(validated.token); } catch (e) { restoreError = e.message; }
  app.runtime.save = originalSave;
  assert.equal(app.active.generationId, currentId);
  assert.equal(app.runtime.load().dataEpoch, currentEpoch);
  assert.ok(app.repo.getOrderById(later.body.order.id));
  results.push({ case: 'restore-save-failure-rollback', error: restoreError,
    originalGeneration: currentId, actualGeneration: app.active.generationId,
    originalEpoch: currentEpoch, actualEpoch: app.runtime.load().dataEpoch,
    latestOrderStillPresent: !!app.repo.getOrderById(later.body.order.id) });
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  app.stop();
  fs.writeFileSync('test-results/functional-review.json', JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results, null, 2));
  console.log(`Isolated test data retained at ${dataDir}`);
}
