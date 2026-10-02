import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('慢请求显示骨架，完成后退出加载状态', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/orders?*', async route => { await pending; await route.continue(); });
  try {
    await page.goto('/');
    await expect(page.getByRole('status', { name: '正在加载订单列表' })).toHaveClass(/visible/);
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  } finally { release(); }
  await expect(page.getByRole('status', { name: '正在加载订单列表' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '订单分页' })).toBeVisible();
});

test('加载失败显示错误，停止骨架等待', async ({ page }) => {
  await page.route('**/api/orders?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEMPORARY', message: '模拟服务暂不可用' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('模拟服务暂不可用');
  await expect(page.getByRole('status', { name: '正在加载订单列表' })).toHaveCount(0);
});

test('开屏离线可用，减少动态效果时显示完整静态标志', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(pathToFileURL(path.resolve('desktop/loading.html')).href);
  await expect(page.getByRole('heading', { name: '家教中介管理系统', exact: true })).toBeVisible();
  await expect(page.locator('.page-left')).toHaveCSS('stroke-dashoffset', '0px');
  await expect(page.locator('.logo-halo')).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('status')).toContainText('正在准备你的工作台');
});
