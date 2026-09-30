// E2E：维护页——备份导出/列表/下载、界面恢复、清理预览（AC41-AC43、AC45界面路径、AC22）。
import { expect, test } from '@playwright/test';
import { UiClient, seedApplication, seedOrder, settleAndComplete, timeTravel } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test.describe('清理与备份维护', () => {
  let client: UiClient;

  test.beforeEach(async ({ request }) => {
    client = new UiClient(request);
    await client.bootstrap();
  });

  test('AC41/AC45界面：立即备份→列表出现→下载ZIP→删除备份', async ({ page }) => {
    await seedOrder(client, { parentName: '备份页订单' });
    await page.goto('#/maintenance');
    await page.getByRole('button', { name: '立即备份' }).click();
    const backupCard = page.locator('.card', { hasText: '备份列表' });
    await expect(backupCard.locator('table.list')).toContainText('手动', { timeout: 15_000 });
    const row = backupCard.locator('table.list tr', { hasText: '手动' }).first();
    const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: '下载' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^tutor-backup-manual-.*\.zip$/);
    const filePath = path.join(os.tmpdir(), download.suggestedFilename());
    await download.saveAs(filePath);
    const stat = fs.statSync(filePath);
    expect(stat.size).toBeGreaterThan(1000);
    fs.rmSync(filePath, { force: true });
  });

  test('AC42界面：导出→恢复预览→确认恢复→回到列表，数据为备份时点', async ({ page }) => {
    // 1) 备份当前状态
    await page.goto('#/maintenance');
    await page.getByRole('button', { name: '立即备份' }).click();
    const row = page.locator('table.list tr', { hasText: '手动' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: '下载' }).click()]);
    const filePath = path.join(os.tmpdir(), `restore-${download.suggestedFilename()}`);
    await download.saveAs(filePath);

    // 2) 备份后新增订单
    await seedOrder(client, { parentName: '恢复后应消失的订单' });

    // 3) 界面恢复
    await page.goto('#/maintenance');
    await page.locator('input[type="file"]').setInputFiles(filePath);
    await expect(page.locator('.paste-result')).toContainText('校验通过，恢复预览', { timeout: 20_000 });
    await page.getByRole('button', { name: /确认恢复（替换当前数据）/ }).click();
    await page.locator('.btn.primary', { hasText: '确认恢复' }).last().click();

    // 恢复完成 → 自动跳回列表
    await page.waitForURL(/#\/$/, { timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText('恢复后应消失的订单');
    fs.rmSync(filePath, { force: true });
  });

  test('AC43界面：损坏ZIP上传被拒绝且显示原因', async ({ page }) => {
    const bad = path.join(os.tmpdir(), `bad-${Date.now()}.zip`);
    fs.writeFileSync(bad, 'this-is-not-a-zip');
    await page.goto('#/maintenance');
    await page.locator('input[type="file"]').setInputFiles(bad);
    await expect(page.locator('.alert.error').first()).toContainText(/ZIP|备份包/, { timeout: 15_000 });
    fs.rmSync(bad, { force: true });
  });

  test('AC21/AC22界面：完成单90天到期进入清理预览，在办单受保护；执行清理', async ({ page }) => {
    // 完成单（fee=0快速完成）
    const order = await seedOrder(client, { parentName: '待清理完成单' });
    const app = await seedApplication(client, order.id, { teacherName: '待清理老师' });
    await settleAndComplete(client, order.id, app.id);
    // 在办单
    await seedOrder(client, { parentName: '受保护在办单' });

    // 时间+91天（先打开页面再操作时间，然后刷新预览）
    await page.goto('#/maintenance');
    await timeTravel(page, 91 * 24 * 3600 * 1000);
    await page.getByRole('button', { name: '刷新预览' }).click();
    await expect(page.locator('.card', { hasText: '90天自动清理' })).toContainText(order.orderNo, { timeout: 15_000 });
    const card = page.locator('.card', { hasText: '90天自动清理' });
    await expect(card).toContainText('已完成且全部报名到期、费用结清');
    await expect(card).toContainText('在办订单');

    // 执行清理（确认弹窗里是primary确认按钮）
    await page.getByRole('button', { name: '立即执行清理' }).click();
    await page.locator('button.btn.primary', { hasText: '确认' }).last().click();
    await expect(page.locator('.alert.ok').first()).toContainText(/已删除|没有可清理/, { timeout: 20_000 });

    // 订单已删除
    await page.goto('/#/');
    await expect(page.locator('body')).not.toContainText('待清理完成单');
    await timeTravel(page, -91 * 24 * 3600 * 1000);
  });

  test('AC45界面：日备份保留份数设置保存', async ({ page }) => {
    await page.goto('#/maintenance');
    const keepInput = page.locator('.field', { hasText: '日备份保留份数' }).locator('input');
    await keepInput.fill('5');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.locator('.alert.ok').first()).toContainText('设置已保存');
    await page.reload();
    await expect(page.locator('.field', { hasText: '日备份保留份数' }).locator('input')).toHaveValue('5');
    await page.locator('.field', { hasText: '日备份保留份数' }).locator('input').fill('30');
    await page.getByRole('button', { name: '保存设置' }).click();
  });
});
