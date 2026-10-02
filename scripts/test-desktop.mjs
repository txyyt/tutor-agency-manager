// 在真实 Electron 运行环境中验证 SQLite、窗口、隔离数据、启停备份和附件。
// DESKTOP_TEST_EXECUTABLE 可指向打包后的 exe；默认测试开发入口。
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { spawn } from 'node:child_process';
import { validOrderPayload } from '../tests/helpers/testServer.ts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-desktop-test-'));
const customBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-desktop-backups-'));
const launchOptions = {
  ...(process.env.DESKTOP_TEST_EXECUTABLE ? { executablePath: process.env.DESKTOP_TEST_EXECUTABLE, args: [] } : { args: ['.'] }),
  env: { ...process.env, DESKTOP_DATA_DIR: dataDir, DESKTOP_SMOKE_TEST: '1' }, timeout: 60_000,
};
let desktop;
try {
  desktop = await electron.launch(launchOptions);
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: '订单工作台' }).waitFor({ timeout: 60_000 });
  const info = await desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { min: win.getMinimumSize(), preferences: win.webContents.getLastWebPreferences() };
  });
  assert.deepEqual(info.min, [1100, 720]);
  assert.equal(info.preferences.nodeIntegration, false);
  assert.equal(info.preferences.contextIsolation, true);
  assert.equal(info.preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await desktop.evaluate(({ shell, dialog }) => {
    globalThis.openedBackupDirectories = [];
    shell.openPath = async directory => {
      globalThis.openedBackupDirectories.push(directory);
      return globalThis.backupFolderError ?? '';
    };
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.folderDialogOptions = options;
      return globalThis.folderDialogResult ?? { canceled: true, filePaths: [] };
    };
  });
  await page.goto(`${new URL(page.url()).origin}/#/maintenance`);
  const openFolder = page.getByRole('button', { name: '打开备份文件夹', exact: true });
  await expect(openFolder).toBeEnabled();
  await openFolder.click();
  await expect.poll(() => desktop.evaluate(() => globalThis.openedBackupDirectories.at(-1))).toBe(path.join(dataDir, 'backups'));
  const backupDirectoryInput = page.locator('.backup-directory-field input');
  const chooseFolder = page.getByRole('button', { name: '选择文件夹', exact: true });
  await chooseFolder.click();
  await expect(chooseFolder).toBeEnabled();
  await expect(backupDirectoryInput).toHaveValue('');
  assert.equal(await desktop.evaluate(() => globalThis.folderDialogOptions.defaultPath), path.join(dataDir, 'backups'));
  assert.deepEqual(await desktop.evaluate(() => globalThis.folderDialogOptions.properties), ['openDirectory', 'createDirectory']);
  await desktop.evaluate((_electron, directory) => { globalThis.folderDialogResult = { canceled: false, filePaths: [directory] }; }, customBackupDir);
  await chooseFolder.click();
  await expect(backupDirectoryInput).toHaveValue(customBackupDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).backupSettings.autoBackupDir, null);
  await expect(openFolder).toBeDisabled();
  await expect(openFolder).toHaveAttribute('title', '请先保存目录设置');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('dialog', { name: '迁移已有备份并切换目录？' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).backupSettings.autoBackupDir, null);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('dialog', { name: '迁移已有备份并切换目录？' }).getByRole('button', { name: '确认迁移并保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  await expect(page.getByRole('status')).toBeInViewport();
  assert.ok((await page.getByRole('status').boundingBox()).y >= (await page.locator('.topbar').boundingBox()).height);
  await expect(openFolder).toBeEnabled();
  const migratedEntries = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups/index.json'), 'utf8'));
  assert.ok(migratedEntries.every(entry => entry.dirPath.startsWith(customBackupDir + path.sep)));
  assert.ok(migratedEntries.every(entry => !fs.existsSync(path.join(dataDir, 'backups', 'lifecycle', entry.fileName))));
  await openFolder.click();
  await expect.poll(() => desktop.evaluate(() => globalThis.openedBackupDirectories.at(-1))).toBe(customBackupDir);
  await desktop.evaluate(() => { globalThis.backupFolderError = '模拟打开失败'; });
  await openFolder.click();
  await expect(page.getByText(/无法打开备份文件夹：模拟打开失败/).first()).toBeVisible();
  assert.ok((await page.getByRole('alert').boundingBox()).y >= (await page.locator('.topbar').boundingBox()).height);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await desktop.evaluate(() => { globalThis.backupFolderError = ''; });
  await backupDirectoryInput.fill('');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('dialog', { name: '迁移已有备份并切换目录？' }).getByRole('button', { name: '确认迁移并保存', exact: true }).click();
  await expect(openFolder).toBeEnabled();
  await openFolder.click();
  await expect.poll(() => desktop.evaluate(() => globalThis.openedBackupDirectories.at(-1))).toBe(path.join(dataDir, 'backups'));
  await page.goto(`${new URL(page.url()).origin}/#/`);
  assert.equal(await page.locator('#tam-desktop-titlebar').evaluate(host => host.parentElement.classList.contains('topbar')), true);
  assert.equal(await page.locator('.topbar').evaluate(bar => bar.getBoundingClientRect().top), 0);
  await page.goto(`${new URL(page.url()).origin}/#/orders/new`);
  await page.locator('.field', { hasText: '家长称呼' }).locator('input').waitFor();
  const scrollPanel = page.locator('.workspace > main.container');
  await scrollPanel.evaluate(panel => panel.scrollTo(0, 400));
  await expect.poll(() => scrollPanel.evaluate(panel => panel.scrollTop)).toBe(400);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.equal(await page.locator('.topbar').evaluate(bar => bar.getBoundingClientRect().top), 0);
  assert.equal(await scrollPanel.evaluate(panel => getComputedStyle(panel, '::-webkit-scrollbar').width), '6px');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '老师报名', exact: true }).click();
  await expect.poll(() => scrollPanel.evaluate(panel => panel.scrollTop)).toBe(0);
  await page.goBack();
  await expect.poll(() => scrollPanel.evaluate(panel => panel.scrollTop)).toBe(400);
  await page.goto(`${new URL(page.url()).origin}/#/`);
  await page.getByRole('heading', { name: '订单工作台' }).waitFor();
  fs.mkdirSync('test-results/desktop', { recursive: true });
  await page.screenshot({ path: `test-results/desktop/${process.env.DESKTOP_TEST_EXECUTABLE ? 'packaged' : 'development'}.png` });
  await expect(page.getByRole('button', { name: '最大化窗口', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await expect(page.getByRole('button', { name: '还原窗口', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
  await desktop.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); });
  await page.getByRole('button', { name: '关闭到托盘', exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  assert.ok(fs.existsSync(path.join(dataDir, 'instance.lock')));
  assert.equal(await page.evaluate(async () => (await fetch('/api/health')).status), 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'backups/index.json'), 'utf8')).length, 1);
  const executable = await desktop.evaluate(({ app }) => app.getPath('exe'));
  const second = spawn(executable, process.env.DESKTOP_TEST_EXECUTABLE ? [] : ['.'], { env: launchOptions.env, stdio: 'ignore', windowsHide: true });
  const secondCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('重复启动未及时退出')); }, 15_000);
    second.once('error', error => { clearTimeout(timer); reject(error); });
    second.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(secondCode, 0);
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'backups/index.json'), 'utf8')).length, 1);
  const order = await page.evaluate(async payload => {
    const session = await fetch('/api/session').then(response => response.json());
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'X-Data-Epoch': String(session.dataEpoch) }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).order;
  }, validOrderPayload({ parentName: '桌面验收模拟家长' }));
  await page.goto(`${new URL(page.url()).origin}/#/orders/${order.id}/apply`);
  await page.locator('.paste-box textarea').fill(fs.readFileSync('tests/fixtures/acceptance/teachers/A1.txt', 'utf8').replaceAll('{{订单A编号}}', order.orderNo));
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await page.getByLabel('报名简历附件').setInputFiles(['tests/fixtures/acceptance/attachments/acceptance-resume.pdf', 'tests/fixtures/acceptance/attachments/image-01.png']);
  await page.getByRole('button', { name: '保存报名（状态：已报名）' }).click();
  await page.waitForURL(/#\/applications\/\d+$/);
  await expect(page.locator('.attach-list li')).toHaveCount(2);
  await page.getByRole('button', { name: '复制老师信息（发家长）', exact: true }).click();
  await expect(page.getByText('已复制', { exact: true })).toBeVisible();
  await page.locator('.attach-list li').filter({ hasText: 'image-01.png' }).getByRole('button', { name: '预览', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '附件预览', exact: true });
  await expect.poll(() => modal.locator('img').evaluate(image => image.naturalWidth)).toBe(128);
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.attach-list li').filter({ hasText: 'acceptance-resume.pdf' }).getByRole('button', { name: '预览', exact: true }).click();
  modal = page.getByRole('dialog', { name: '附件预览', exact: true });
  await expect(modal.locator('iframe')).toHaveAttribute('src', /^blob:/);
  const pdfHeader = await modal.locator('iframe').evaluate(async frame => (await (await fetch(frame.src)).text()).slice(0, 5));
  assert.equal(pdfHeader, '%PDF-');
  await modal.getByRole('link', { name: '打开原文件', exact: true }).click();
  // PDF原生查看器在云端Windows上不一定暴露Playwright Page；验证实际Electron窗口。
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => win.webContents.getURL()).find(url => url.startsWith('blob:'))), { timeout: 30_000 }).toMatch(/^blob:/);
  await desktop.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().startsWith('blob:')) win.close(); });
  const downloadPath = path.join(dataDir, 'downloaded-resume.pdf');
  await desktop.evaluate(({ session }, destination) => session.defaultSession.once('will-download', (_event, item) => item.setSavePath(destination)), downloadPath);
  await modal.getByRole('button', { name: '下载原文件', exact: true }).click();
  await expect.poll(() => fs.existsSync(downloadPath)).toBe(true);
  await expect.poll(() => fs.statSync(downloadPath).size).toBe(fs.statSync('tests/fixtures/acceptance/attachments/acceptance-resume.pdf').size);
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto(`${new URL(page.url()).origin}/#/orders/${order.id}`);
  const candidate = page.locator('table.list a[href^="#/applications/"]').first();
  await candidate.waitFor();
  const savedTop = await scrollPanel.evaluate(panel => { const top = Math.min(300, panel.scrollHeight - panel.clientHeight); panel.scrollTo(0, top); return top; });
  assert.ok(savedTop > 0);
  await candidate.evaluate(link => link.click());
  await page.waitForURL(/#\/applications\/\d+$/);
  await expect.poll(() => scrollPanel.evaluate(panel => panel.scrollTop)).toBe(0);
  await page.route(`**/api/orders/${order.id}`, async route => { await new Promise(resolve => setTimeout(resolve, 350)); await route.continue(); });
  await page.getByRole('button', { name: '← 返回上一页', exact: true }).click();
  await expect.poll(() => scrollPanel.evaluate(panel => panel.scrollTop)).toBe(savedTop);
  await page.unroute(`**/api/orders/${order.id}`);
  await page.goto(`${new URL(page.url()).origin}/#/`);
  await page.getByRole('link', { name: '新建订单', exact: true }).click();
  const parentInput = page.locator('.field', { hasText: '家长称呼' }).locator('input');
  await parentInput.fill('桌面测试家长');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  assert.ok(fs.existsSync(path.join(dataDir, 'instance.lock')));
  // app.quit 进入与托盘“退出”相同的正式退出保护流程。
  await desktop.evaluate(({ app }) => app.quit());
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改并退出？' })).toBeVisible();
  await page.getByRole('dialog', { name: '放弃未保存的修改并退出？' }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(parentInput).toHaveValue('桌面测试家长');
  await desktop.evaluate(({ app }) => app.quit());
  await page.getByRole('button', { name: '确认放弃', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(dataDir, 'instance.lock')), { timeout: 60_000 }).toBe(false);
  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups/index.json'), 'utf8'));
  assert.deepEqual(entries.map(entry => entry.kind), ['startup', 'shutdown']);
  for (const entry of entries) assert.ok(fs.existsSync(path.join(entry.dirPath, entry.fileName)));
  const latest = entries.at(-1);
  const backup = await JSZip.loadAsync(fs.readFileSync(path.join(latest.dirPath, latest.fileName)));
  const manifest = JSON.parse(await backup.file('manifest.json').async('string'));
  assert.equal(manifest.counts.orders, 1);
  assert.equal(manifest.counts.applications, 1);
  await desktop.close().catch(() => {});
  desktop = await electron.launch(launchOptions);
  const reopened = await desktop.firstWindow();
  await reopened.getByRole('heading', { name: '订单工作台' }).waitFor({ timeout: 60_000 });
  await expect(reopened.getByText('桌面验收模拟家长', { exact: true })).toBeVisible();
  await desktop.evaluate(({ app }) => app.quit());
  await expect.poll(() => fs.existsSync(path.join(dataDir, 'instance.lock')), { timeout: 60_000 }).toBe(false);
  const afterRestart = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups/index.json'), 'utf8'));
  assert.deepEqual(afterRestart.map(entry => entry.kind), ['startup', 'shutdown', 'startup', 'shutdown']);
  console.log('桌面验收通过：自定义最小化/最大化/还原、关闭到托盘不停止服务、重复启动恢复窗口、退出确认与备份，以及原有附件和持久化流程。');
} catch (error) {
  // CI失败时保留模拟环境的日志和截图，避免只看到退出码。
  fs.mkdirSync('test-results/desktop', { recursive: true });
  const log = path.join(dataDir, 'logs/desktop.log');
  if (fs.existsSync(log)) fs.copyFileSync(log, 'test-results/desktop/backend.log');
  const page = desktop?.windows()[0];
  if (page) await page.screenshot({ path: 'test-results/desktop/failure.png', timeout: 5000 }).catch(() => {});
  if (process.env.GITHUB_ACTIONS === 'true') {
    const message = String(error.stack ?? error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Electron桌面验收失败::${message}`);
  }
  throw error;
} finally {
  if (desktop) {
    for (const page of desktop.windows()) {
      await page.evaluate(() => document.querySelectorAll('form[data-dirty]').forEach(form => form.removeAttribute('data-dirty'))).catch(() => {});
      await page.getByRole('dialog', { name: '放弃未保存的修改并退出？' }).getByRole('button', { name: '确认放弃', exact: true }).click({ timeout: 1000 }).catch(() => {});
    }
    await desktop.close().catch(() => {});
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(customBackupDir, { recursive: true, force: true });
}
