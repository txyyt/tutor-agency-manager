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
    const openFolder = page.getByRole('button', { name: '打开备份文件夹', exact: true });
    await expect(openFolder).toBeDisabled();
    await expect(openFolder).toHaveAttribute('title', '桌面版可直接打开文件夹');
    await expect(page.getByRole('button', { name: '选择文件夹', exact: true })).toBeDisabled();
    await expect(page.locator('dt').filter({ hasText: '备份目录' })).toHaveCount(0);
    await page.getByRole('button', { name: '立即备份' }).click();
    await expect(page.getByRole('status')).toContainText('手动备份完成');
    await expect(page.getByRole('status')).toBeInViewport();
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

  test('备份列表和恢复选择器均最新在前，同一时间后生成的优先', async ({ page }) => {
    await client.post('/api/backups', { kind: 'manual' });
    await client.post('/api/backups', { kind: 'manual' });
    const result = await client.get('/api/backups');
    const entries = result.body.entries;
    const expected = [...entries].reverse().sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
    await page.goto('#/maintenance');
    const rows = page.locator('.card', { hasText: '备份列表' }).locator('table tbody tr');
    await expect(rows.first()).toContainText(expected[0].fileName);
    const options = page.getByLabel('从已有备份中选择', { exact: true }).locator('option');
    await expect(options.nth(1)).toHaveAttribute('value', expected[0].id);
    await page.route('**/api/backups', async route => {
      const response = await route.fetch();
      const body = await response.json();
      const latest = body.entries.slice(-2);
      latest.forEach((entry: { createdAtUtc: string }) => { entry.createdAtUtc = '2099-01-01T00:00:00.000Z'; });
      await route.fulfill({ response, json: { ...body, entries: latest } });
    });
    await page.reload();
    await expect(rows.first()).toContainText(entries.at(-1).fileName);
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
    await expect(page.getByRole('dialog', { name: '恢复完成', exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: '恢复完成', exact: true }).getByRole('button', { name: '知道了' }).click();
    await expect(page.locator('body')).not.toContainText('恢复后应消失的订单');
    fs.rmSync(filePath, { force: true });
  });

  test('恢复区域可选择已有备份，校验后确认恢复，列表没有直接恢复按钮', async ({ page }) => {
    const backup = (await client.post('/api/backups', { kind: 'manual' })).body.entry;
    const order = await seedOrder(client, { parentName: '已有备份恢复后消失' });
    await page.goto('#/maintenance');
    await expect(page.locator('table.list').getByRole('button', { name: '恢复', exact: true })).toHaveCount(0);
    await page.getByLabel('从已有备份中选择').selectOption(backup.id);
    await page.getByRole('button', { name: '校验所选备份', exact: true }).click();
    await expect(page.locator('.paste-result')).toContainText('校验通过，恢复预览');
    expect((await client.get(`/api/orders/${order.id}`)).status).toBe(200);
    await page.getByRole('button', { name: '确认恢复（替换当前数据）', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).click();
    await page.waitForURL(/#\/$/, { timeout: 30_000 });
    await expect(page.getByRole('dialog', { name: '恢复完成', exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: '恢复完成', exact: true }).getByRole('button', { name: '知道了' }).click();
    await client.bootstrap(); expect((await client.get(`/api/orders/${order.id}`)).status).toBe(404);
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
    await timeTravel(page, 0);
  });

  test('AC45界面：定时保留固定5份，时间仍可配置', async ({ page }) => {
    await page.goto('#/maintenance');
    await expect(page.locator('.field', { hasText: '定时备份保留份数' })).toHaveCount(0);
    expect((await client.get('/api/backups')).body.settings.dailyKeepCount).toBe(5);
    await page.getByLabel('每日备份时间（北京时间）').fill('21:30');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByRole('status')).toContainText('设置已保存');
    await expect(page.getByRole('status')).toBeInViewport();
    await page.reload();
    expect((await client.get('/api/backups')).body.settings.dailyKeepCount).toBe(5);
    await expect(page.getByLabel('每日备份时间（北京时间）')).toHaveValue('21:30');
    await expect(page.getByText('上传的备份ZIP文件本身允许的最大大小。', { exact: true })).toBeVisible();
    await page.getByLabel('每日备份时间（北京时间）').fill('02:00');
    await page.getByRole('button', { name: '保存设置' }).click();
  });

  test('保存和备份失败显示可见错误，重试成功；处理中禁用按钮', async ({ page }) => {
    await page.goto('#/maintenance');
    await page.getByRole('button', { name: '保存设置', exact: true }).waitFor();
    for (const operation of [
      { url: '**/api/backups/settings', button: '保存设置', pending: '保存中…', success: '设置已保存' },
      { url: '**/api/backups', button: '立即备份', pending: '备份中…', success: '手动备份完成' },
    ]) {
      let release: () => void = () => {};
      const blocked = new Promise<void>(resolve => { release = resolve; });
      await page.route(operation.url, async route => {
        if (route.request().method() === 'GET') return route.continue();
        await blocked;
        await route.fulfill({ status: 500, json: { code: 'TEST_FAILURE', message: `${operation.button}模拟失败` } });
      });
      await page.getByRole('button', { name: operation.button, exact: true }).click();
      await expect(page.getByRole('button', { name: operation.pending, exact: true })).toBeDisabled();
      release();
      await expect(page.getByRole('alert')).toContainText(`${operation.button}模拟失败`);
      await expect(page.getByRole('alert')).toBeInViewport();
      expect((await page.getByRole('alert').boundingBox())!.y).toBeGreaterThanOrEqual(80);
      await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.getByRole('button', { name: operation.button, exact: true }).click();
      await expect(page.getByRole('alert')).toContainText(`${operation.button}模拟失败`);
      await expect(page.getByRole('status')).toHaveCount(0);
      await page.unroute(operation.url);
      await page.getByRole('button', { name: operation.button, exact: true }).click();
      await expect(page.getByRole('status')).toContainText(operation.success);
      await expect(page.getByRole('status')).toBeInViewport();
      expect((await page.getByRole('status').boundingBox())!.y).toBeGreaterThanOrEqual(80);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    }
  });

  test('切换备份目录先确认，取消不迁移，确认后旧文件移除且仍能恢复', async ({ page }) => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ui-migration-'));
    const original = (await client.get('/api/backups')).body.settings.autoBackupDir;
    const entry = (await client.post('/api/backups', { kind: 'manual' })).body.entry;
    const source = path.join(entry.dirPath, entry.fileName);
    try {
      await page.goto('#/maintenance');
      await page.locator('.backup-directory-field input').fill(target);
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '迁移已有备份并切换目录？' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      expect((await client.get('/api/backups')).body.settings.autoBackupDir).toBe(original);
      expect(fs.existsSync(source)).toBe(true);
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '迁移已有备份并切换目录？' });
      await dialog.getByRole('button', { name: '确认迁移并保存', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(/设置已保存，已迁移\d+份备份/);
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.existsSync(path.join(target, 'manual', entry.fileName))).toBe(true);
      expect((await client.post('/api/restores/validate-existing', { backupId: entry.id })).status).toBe(200);
    } finally {
      await client.patch('/api/backups/settings', { autoBackupDir: original, confirmMigration: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
