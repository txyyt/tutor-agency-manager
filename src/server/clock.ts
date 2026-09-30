// 可注入时钟：所有业务时间经由clock获取；测试可设置偏移实现时间旅行。
export class Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  iso(): string {
    return this.now().toISOString();
  }

  setOffsetMs(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }
}
