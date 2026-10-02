import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray, utilityProcess } from 'electron';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

app.setName('TutorAgencyManager');
// 固定标识，升级及安装目录变化不会改变业务数据位置。
app.setPath('userData', path.join(app.getPath('appData'), 'TutorAgencyManager'));
const development = !app.isPackaged;
const smokeTest = process.env.DESKTOP_SMOKE_TEST === '1';
const dataDir = development || smokeTest
  ? path.resolve(process.env.DESKTOP_DATA_DIR ?? '.desktop-dev/data')
  : path.join(app.getPath('userData'), 'data');
const profileDir = smokeTest ? path.join(dataDir, 'profile') : development ? path.resolve('.desktop-dev/profile') : app.getPath('userData');
if (development || smokeTest) app.setPath('userData', profileDir);
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('sessionData', profileDir);
let window;
let tray;
let backend;
let backendExited;
let backendUrl = '';
let quitting = false;
let allowQuit = false;
let backupError = '';
let logFile;

function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    if (window && !window.isDestroyed() && backendUrl) {
      // 托盘退出时先显示窗口，保证未保存确认可见。
      showWindow();
      const confirmed = await window.webContents.executeJavaScript(`new Promise(resolve => {
        if (!document.querySelector('form[data-dirty="true"]')) return resolve(true);
        window.dispatchEvent(new CustomEvent('tam:desktop-close', { detail: { resolve } }));
      })`);
      if (!confirmed) { quitting = false; return; }
    }
    window?.setTitle('正在保存关闭备份，请稍候…');
    if (backend?.pid) {
      backend.postMessage('tam:shutdown');
      await backendExited;
    }
    if (backupError) await dialog.showMessageBox({ type: 'warning', title: '关闭备份失败', message: '本次关闭备份未保存成功，业务数据仍保留。', detail: backupError, buttons: ['知道了'] });
    allowQuit = true;
    tray?.destroy();
    app.quit();
  } catch (error) {
    quitting = false;
    log(String(error));
    dialog.showErrorBox('退出失败', `程序尚未关闭，请重试。\n${error.message}`);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!allowQuit) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { if (!quitting) void quit(); });
  app.whenReady().then(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    const logDir = path.join(smokeTest ? dataDir : path.dirname(dataDir), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'desktop.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.previous`);
    Menu.setApplicationMenu(null);
    const root = app.getAppPath();
    window = new BrowserWindow({
      width: 1440, height: 900, minWidth: 1100, minHeight: 720,
      title: '家教中介管理系统', backgroundColor: '#f4f7fa', show: false,
      frame: false, icon: path.join(root, 'desktop/icon.ico'),
      webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: development },
    });
    tray = new Tray(path.join(root, 'desktop/icon.ico'));
    tray.setToolTip('家教中介管理系统 · 后台运行');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主窗口', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: () => { void quit(); } },
    ]));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    window.on('close', event => { if (!allowQuit) { event.preventDefault(); if (!quitting) window.hide(); } });
    ipcMain.handle('tam:choose-backup-folder', async event => {
      const url = event.senderFrame?.url ?? '';
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !backendUrl || !url.startsWith(`${backendUrl}/`)) throw new Error('文件夹操作来源不受信任');
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
      const result = await dialog.showOpenDialog(window, {
        title: '选择备份文件夹',
        defaultPath: config.backupSettings?.autoBackupDir ?? path.join(dataDir, 'backups'),
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选择此文件夹',
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('tam:open-backup-folder', async event => {
      const url = event.senderFrame?.url ?? '';
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !backendUrl || !url.startsWith(`${backendUrl}/`)) throw new Error('文件夹操作来源不受信任');
      // 只读取已经保存的设置，不接受页面传入任意路径。
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
      const directory = config.backupSettings?.autoBackupDir ?? path.join(dataDir, 'backups');
      fs.mkdirSync(directory, { recursive: true });
      const error = await shell.openPath(directory);
      if (error) throw new Error(`无法打开备份文件夹：${error}`);
    });
    ipcMain.handle('tam:window-control', (event, action) => {
      const url = event.senderFrame?.url ?? '';
      const trustedUrl = url === pathToFileURL(path.join(root, 'desktop/loading.html')).href || (backendUrl && url.startsWith(`${backendUrl}/`));
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedUrl) throw new Error('窗口操作来源不受信任');
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'hide') { if (!quitting) window.hide(); }
      else if (action !== 'state') throw new Error('不支持的窗口操作');
      return { maximized: window.isMaximized() };
    });
    const syncWindowState = () => window.webContents.send('tam:window-state', { maximized: window.isMaximized() });
    window.on('maximize', syncWindowState);
    window.on('unmaximize', syncWindowState);
    window.webContents.setWindowOpenHandler(({ url }) => {
      const allowed = backendUrl && (url.startsWith(`${backendUrl}/`) || url.startsWith(`blob:${backendUrl}/`));
      return allowed ? { action: 'allow', overrideBrowserWindowOptions: { minWidth: 800, minHeight: 600, frame: true, webPreferences: { preload: '', nodeIntegration: false, contextIsolation: true, sandbox: true } } } : { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (!backendUrl || new URL(url).origin !== backendUrl) event.preventDefault(); });
    await window.loadFile(path.join(root, 'desktop/loading.html'));
    window.show();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === window?.webContents && Boolean(backendUrl) && contents.getURL().startsWith(`${backendUrl}/`) && permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    });
    backend = utilityProcess.fork(path.join(root, 'dist/server/main.js'), [], {
      env: { ...process.env, APP_ROOT: root, APP_DATA_DIR: dataDir, APP_PORT: '0', APP_DESKTOP: '1', APP_ALLOW_TIME_CONTROL: '0' },
      stdio: 'pipe', serviceName: 'TutorAgencyBackend',
    });
    backend.stdout?.on('data', chunk => log(chunk.toString()));
    backend.stderr?.on('data', chunk => log(chunk.toString()));
    backendExited = new Promise(resolve => backend.once('exit', code => {
      log(`后台退出：${code}`);
      resolve(code);
      if (!quitting) { dialog.showErrorBox('后台服务已停止', `请重新启动软件。日志位置：\n${logFile}`); allowQuit = true; app.quit(); }
    }));
    const ready = new Promise((resolve, reject) => {
      backend.once('exit', () => reject(new Error('后台在启动期间退出')));
      backend.on('message', message => {
        if (message.type === 'ready') resolve(message.url);
        if (message.type === 'startup-error') reject(new Error(message.message));
        if (message.type === 'backup-error') backupError = message.message;
        if (message.type === 'startup-warning') dialog.showErrorBox('启动备份失败', `业务数据仍保留，系统可以继续使用。\n${message.message}`);
      });
    });
    backendUrl = await ready;
    if (quitting) return;
    await window.loadURL(backendUrl);
    // 启动期间用户已经隐藏到托盘时，服务就绪不再强制弹出。
  }).catch(async error => {
    if (quitting || allowQuit) return;
    dialog.showErrorBox('无法启动家教中介管理系统', `${error.message}\n数据目录：${dataDir}`);
    await quit();
  });
}
