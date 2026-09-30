// 统一错误类型与HTTP错误契约：{code,message,fieldErrors?}
export class AppError extends Error {
  status: number;
  code: string;
  fieldErrors?: Record<string, string>;
  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (code: string, message: string, fieldErrors?: Record<string, string>) =>
  new AppError(400, code, message, fieldErrors);
export const unauthorizedOrigin = (message: string) => new AppError(403, 'UNTRUSTED_ORIGIN', message);
export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, fieldErrors?: Record<string, string>) =>
  new AppError(409, code, message, fieldErrors);
export const payloadTooLarge = (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const maintenanceUnavailable = (message: string) =>
  new AppError(503, 'MAINTENANCE', message);
