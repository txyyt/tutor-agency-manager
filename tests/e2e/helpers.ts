// E2E API客户端：与集成测试同构的会话/CSRF/epoch处理（直接打127.0.0.1:3300）。
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export class UiClient {
  private csrfToken = '';
  private dataEpoch = 0;
  constructor(private request: APIRequestContext) {}

  async bootstrap(): Promise<void> {
    const res = await this.request.get('/api/session');
    const setCookie = (res.headers()['set-cookie'] ?? '').split(';')[0] ?? '';
    const body = await res.json();
    this.csrfToken = body.csrfToken;
    this.dataEpoch = body.dataEpoch;
    void setCookie;
  }

  private async req(method: string, path: string, data?: unknown): Promise<{ status: number; body: any }> {
    const res = await this.request.fetch(path, {
      method,
      headers: {
        'X-CSRF-Token': this.csrfToken,
        'X-Data-Epoch': String(this.dataEpoch),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      data: data === undefined ? undefined : JSON.stringify(data),
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status() === 409 && body?.code === 'DATA_EPOCH_CONFLICT') {
      await this.bootstrap();
      return this.req(method, path, data);
    }
    return { status: res.status(), body };
  }

  get<T = any>(path: string) {
    return this.req('GET', path) as Promise<{ status: number; body: T }>;
  }
  post<T = any>(path: string, data?: unknown) {
    return this.req('POST', path, data) as Promise<{ status: number; body: T }>;
  }
  patch<T = any>(path: string, data?: unknown) {
    return this.req('PATCH', path, data) as Promise<{ status: number; body: T }>;
  }
  delete<T = any>(path: string) {
    return this.req('DELETE', path) as Promise<{ status: number; body: T }>;
  }
}

export function orderPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    parentName: 'E2E家长',
    parentWechat: `e2e-wx-${Math.random().toString(36).slice(2, 8)}`,
    parentPhone: '13811112222',
    childGrade: '初二',
    subjects: '数学',
    learningSituation: '基础一般',
    tutoringGoal: '期末提分',
    teachingMode: 'offline',
    locationDetail: '测试小区',
    publicArea: '测试区',
    weeklySchedule: '周六 9:00—11:00',
    publicSchedule: '周六上午',
    sessionsPerWeek: 1,
    sessionMinutes: 120,
    expectedStartDate: null,
    hourlyPayCents: 15000,
    payNegotiable: true,
    genderPreference: 'any',
    teacherRequirements: '有经验',
    publicRequirements: '有教学经验',
    notes: '',
    ...overrides,
  };
}

export async function seedOrder(client: UiClient, overrides?: Record<string, unknown>) {
  const res = await client.post('/api/orders', orderPayload(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order;
}

export async function seedApplication(client: UiClient, orderId: number, overrides?: Record<string, unknown>) {
  const res = await client.post(`/api/orders/${orderId}/applications`, {
    teacherName: 'E2E老师',
    gender: 'female',
    wechat: 'e2e-tx',
    phone: '13933334444',
    university: '测试大学',
    major: '数学',
    studyYear: '大三',
    teachableSubjectsGrades: '初中数学',
    achievements: '',
    teachingExperience: '暂无',
    strengthsAndPlan: '认真负责',
    availableSchedule: '周六',
    earliestStartDate: null,
    acceptsOrderPay: true,
    expectedHourlyPayCents: null,
    canAttendTrial: true,
    trialConstraints: '',
    notes: '',
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.application;
}

export async function appActionUi(client: UiClient, applicationId: number, action: string, extra?: Record<string, unknown>) {
  const d = await client.get(`/api/applications/${applicationId}`);
  const res = await client.post(`/api/applications/${applicationId}/actions`, {
    action,
    version: d.body.application.version,
    orderVersion: d.body.order.version,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

export async function financeUi(client: UiClient, applicationId: number, body: Record<string, unknown>) {
  const d = await client.get(`/api/applications/${applicationId}`);
  const res = await client.post(`/api/applications/${applicationId}/finance`, {
    operationId: crypto.randomUUID(),
    version: d.body.application.version,
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

export async function settleAndComplete(client: UiClient, orderId: number, applicationId: number): Promise<void> {
  await appActionUi(client, applicationId, 'recommend');
  await appActionUi(client, applicationId, 'schedule-trial');
  await financeUi(client, applicationId, { type: 'set-fees', agencyFeeCents: 30000, depositDueCents: 10000 });
  await financeUi(client, applicationId, { type: 'receive-deposit', amountCents: 10000 });
  const od = await client.get(`/api/orders/${orderId}`);
  await client.post(`/api/orders/${orderId}/actions`, { action: 'start-trial', version: od.body.order.version });
  await appActionUi(client, applicationId, 'pass', { confirmCooperation: true });
  await financeUi(client, applicationId, { type: 'receive-supplement', amountCents: 20000 });
  const od2 = await client.get(`/api/orders/${orderId}`);
  const done = await client.post(`/api/orders/${orderId}/actions`, { action: 'complete', version: od2.body.order.version });
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
}

/** 页面内注入时间控制（走页面会话，复用CSRF） */
export async function timeTravel(page: Page, offsetMs: number): Promise<void> {
  const result = await page.evaluate(async (ms) => {
    const session = (await fetch('/api/session').then((r) => r.json())) as { csrfToken: string; dataEpoch: number };
    const res = await fetch('/api/test/clock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'X-Data-Epoch': String(session.dataEpoch) },
      body: JSON.stringify({ offsetMs: ms }),
    });
    return res.status;
  }, offsetMs);
  expect(result).toBe(200);
}
