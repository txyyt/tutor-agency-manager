// 集成测试基建：临时数据目录 + 随机端口真实HTTP服务 + 会话/CSRF/epoch客户端。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, type AppServer } from '../../src/server/serverFactory.js';
import { loadEnv } from '../../src/server/env.js';

export interface TestServer {
  app: AppServer;
  port: number;
  dataDir: string;
  client: TestClient;
  rawClient: (opts: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    noHeaders?: boolean;
    rawBody?: Buffer;
    contentType?: string;
  }) => Promise<{ status: number; body: unknown; headers: Headers; text: string }>;
  close(): void;
}

export interface TestClientState {
  cookie: string;
  csrfToken: string;
  dataEpoch: number;
}

export class TestClient {
  constructor(
    private port: number,
    public state: TestClientState,
  ) {}

  async bootstrap(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/session`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    const body = (await res.json()) as { csrfToken: string; dataEpoch: number };
    this.state.cookie = cookie;
    this.state.csrfToken = body.csrfToken;
    this.state.dataEpoch = body.dataEpoch;
  }

  refreshEpoch(epoch: number): void {
    this.state.dataEpoch = epoch;
  }

  async request(
    method: string,
    reqPath: string,
    body?: unknown,
    opts?: { headers?: Record<string, string>; skipCsrf?: boolean; skipEpoch?: boolean },
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const doSend = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (!opts?.skipCsrf) headers['X-CSRF-Token'] = this.state.csrfToken;
      if (!opts?.skipEpoch) headers['X-Data-Epoch'] = String(this.state.dataEpoch);
      if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
      if (this.state.cookie) headers['Cookie'] = this.state.cookie;
      return fetch(`http://127.0.0.1:${this.port}${reqPath}`, {
        method,
        headers,
        body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
      });
    };
    let res = await doSend();
    // 与真实前端一致：恢复后epoch变化 → 刷新会话并重试一次（写入请求有幂等保护）
    if (res.status === 409) {
      const cloneText = await res.clone().text();
      let code = '';
      try {
        code = (JSON.parse(cloneText) as { code?: string }).code ?? '';
      } catch {
        code = '';
      }
      if (code === 'DATA_EPOCH_CONFLICT') {
        await this.bootstrap();
        res = await doSend();
      }
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get<T = any>(reqPath: string): Promise<{ status: number; body: T; headers: Headers }> {
    return this.request('GET', reqPath) as Promise<{ status: number; body: T; headers: Headers }>;
  }
  post<T = any>(reqPath: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<{ status: number; body: T; headers: Headers }> {
    return this.request('POST', reqPath, body, opts);
  }
  postForm<T = any>(reqPath: string, form: FormData): Promise<{ status: number; body: T; headers: Headers }> {
    return this.request('POST', reqPath, form) as Promise<{ status: number; body: T; headers: Headers }>;
  }
  patch<T = any>(reqPath: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
    return this.request('PATCH', reqPath, body) as Promise<{ status: number; body: T; headers: Headers }>;
  }
  delete<T = any>(reqPath: string): Promise<{ status: number; body: T; headers: Headers }> {
    return this.request('DELETE', reqPath) as Promise<{ status: number; body: T; headers: Headers }>;
  }
}

export async function startTestServer(opts?: { allowTimeControl?: boolean; dataDir?: string }): Promise<TestServer> {
  const dataDir = opts?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tam-it-'));
  if (opts?.allowTimeControl) process.env.APP_ALLOW_TIME_CONTROL = '1';
  else delete process.env.APP_ALLOW_TIME_CONTROL;
  const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
  const appServer = createServer(env);
  appServer.start(false);
  const httpServer = http.createServer(appServer.app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
  const port = address.port;
  const client = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 });
  await client.bootstrap();

  const rawClient: TestServer['rawClient'] = async (o) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (!o.noHeaders) {
      if (!headers['X-CSRF-Token']) headers['X-CSRF-Token'] = client.state.csrfToken;
      if (!headers['X-Data-Epoch']) headers['X-Data-Epoch'] = String(client.state.dataEpoch);
      if (!headers['Cookie'] && client.state.cookie) headers['Cookie'] = client.state.cookie;
    }
    if (o.body !== undefined && !o.rawBody) headers['Content-Type'] = o.contentType ?? 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${o.path}`, {
      method: o.method,
      headers,
      body: o.rawBody ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };

  return {
    app: appServer,
    port,
    dataDir,
    client,
    rawClient,
    close() {
      httpServer.close();
      appServer.stop();
      if (!opts?.dataDir) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {
          /* Windows文件句柄延迟：忽略 */
        }
      }
    },
  };
}

// ---------- 业务seed辅助 ----------

export function validOrderPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    parentName: '王家长',
    parentWechat: 'parent-wechat-001',
    parentPhone: '13800001234',
    childGrade: '初三',
    subjects: '数学',
    learningSituation: '基础薄弱，成绩中等',
    tutoringGoal: '巩固基础、提高解题能力',
    teachingMode: 'offline',
    locationDetail: '阳光小区',
    publicArea: '城东区',
    weeklySchedule: '周二、周四 19:00—21:00',
    publicSchedule: '周二、周四晚间',
    sessionsPerWeek: 2,
    sessionMinutes: 90,
    expectedStartDate: null,
    hourlyPayCents: 15000,
    payNegotiable: true,
    genderPreference: 'any',
    teacherRequirements: '有经验优先',
    publicRequirements: '有教学经验',
    notes: '内部备注',
    ...overrides,
  };
}

export function validApplicationPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    teacherName: '李老师',
    gender: 'female',
    wechat: 'teacher-wx-001',
    phone: '13900005678',
    university: '示范大学',
    major: '数学与应用数学',
    studyYear: '大三',
    teachableSubjectsGrades: '初中数学、高中数学',
    achievements: '高考数学140分（2023年，满分150）',
    teachingExperience: '初二数学，一学期',
    strengthsAndPlan: '擅长基础巩固，先梳理知识点再刷题',
    availableSchedule: '周二、周四 19:00—21:00',
    earliestStartDate: null,
    acceptsOrderPay: true,
    expectedHourlyPayCents: null,
    canAttendTrial: true,
    trialConstraints: '',
    notes: '',
    ...overrides,
  };
}

export async function createOrder(client: TestClient, overrides?: Record<string, unknown>): Promise<any> {
  const res = await client.post('/api/orders', validOrderPayload(overrides));
  if (res.status !== 201) throw new Error(`创建订单失败：${JSON.stringify(res.body)}`);
  return res.body.order;
}

export async function createApplication(client: TestClient, orderId: number, overrides?: Record<string, unknown>): Promise<any> {
  const res = await client.post(`/api/orders/${orderId}/applications`, validApplicationPayload(overrides));
  if (res.status !== 201) throw new Error(`创建报名失败：${JSON.stringify(res.body)}`);
  return res.body.application;
}

export async function doFinance(client: TestClient, applicationId: number, body: Record<string, unknown>): Promise<any> {
  // 自动携带最新version（财务幂等由operationId保证，version仅防并发覆盖）
  const d = await client.get(`/api/applications/${applicationId}`);
  const currentVersion = (d.body as any).application.version;
  const res = await client.post(`/api/applications/${applicationId}/finance`, {
    operationId: crypto.randomUUID(),
    ...body,
    version: currentVersion, // 财务操作始终用最新版本；幂等由operationId保证
  });
  return res;
}

export async function appAction(client: TestClient, applicationId: number, action: string, extra?: Record<string, unknown>): Promise<any> {
  const d = await client.get(`/api/applications/${applicationId}`);
  const app = (d.body as any).application;
  const version = (extra?.version as number | undefined) ?? app.version;
  const orderVersion = (extra?.orderVersion as number | undefined) ?? (d.body as any).order.version;
  const res = await client.post(`/api/applications/${applicationId}/actions`, {
    action,
    version,
    orderVersion,
    ...extra,
  });
  if (res.status >= 300) throw new Error(`报名动作${action}失败：${JSON.stringify(res.body)}`);
  return res.body;
}

export async function orderAction(client: TestClient, orderId: number, action: string, extra?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const order = (await client.get(`/api/orders/${orderId}`)).body as any;
  const res = await client.post(`/api/orders/${orderId}/actions`, { action, version: order.order.version, ...extra });
  return res;
}

export async function getDetail(client: TestClient, orderId: number): Promise<any> {
  return (await client.get(`/api/orders/${orderId}`)).body;
}
