// API客户端：自动携带CSRF令牌与data_epoch；统一中文错误信息。
export class ApiError extends Error {
  code: string;
  status: number;
  fieldErrors?: Record<string, string>;
  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

interface SessionInfo {
  csrfToken: string;
  dataEpoch: number;
  appVersion: string;
  allowTimeControl: boolean;
  displayTimezone: string;
  serverTime: string;
}

let session: SessionInfo | null = null;

export async function ensureSession(): Promise<SessionInfo> {
  if (session) return session;
  const res = await fetch('/api/session');
  if (!res.ok) throw new Error('无法连接本机服务');
  session = (await res.json()) as SessionInfo;
  return session;
}

export async function refreshSession(): Promise<SessionInfo> {
  session = null;
  return ensureSession();
}

export function getSession(): SessionInfo | null {
  return session;
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  await ensureSession();
  const headers: Record<string, string> = {
    'X-CSRF-Token': session!.csrfToken,
    'X-Data-Epoch': String(session!.dataEpoch),
  };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (isForm) {
      payload = body as FormData;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'NETWORK', '无法连接本机服务，请确认服务已启动');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = data as { code?: string; message?: string; fieldErrors?: Record<string, string> } | null;
    if (err?.code === 'DATA_EPOCH_CONFLICT') {
      await refreshSession();
    }
    if (err?.code === 'UNTRUSTED_ORIGIN' && /会话/.test(err.message ?? '')) {
      session = null;
      await ensureSession();
    }
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? `请求失败（${res.status}）`, err?.fieldErrors);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postForm: <T>(path: string, form: FormData) => request<T>('POST', path, form, true),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** 下载二进制（附件/备份/导出），复用CSRF头 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  await ensureSession();
  const res = await fetch(path, {
    headers: { 'X-CSRF-Token': session!.csrfToken, 'X-Data-Epoch': String(session!.dataEpoch) },
  });
  if (!res.ok) {
    let message = `下载失败（${res.status}）`;
    try {
      const data = await res.json();
      if (data?.message) message = data.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, 'DOWNLOAD_FAILED', message);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const utf8Match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const asciiMatch = /filename="([^"]+)"/.exec(disposition);
  const name = utf8Match ? decodeURIComponent(utf8Match[1]!) : (asciiMatch?.[1] ?? fallbackName);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 获取文本（预览导出内容用） */
export async function fetchText(path: string): Promise<string> {
  await ensureSession();
  const res = await fetch(path, {
    headers: { 'X-CSRF-Token': session!.csrfToken, 'X-Data-Epoch': String(session!.dataEpoch) },
  });
  if (!res.ok) throw new ApiError(res.status, 'FETCH_FAILED', `获取失败（${res.status}）`);
  return res.text();
}
