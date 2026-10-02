// 沙箱预加载：只提供窗口控制和打开已保存备份目录，不暴露 Node 或任意 IPC。
/* eslint @typescript-eslint/no-require-imports: "off" */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tutorDesktop', {
  openBackupFolder: () => ipcRenderer.invoke('tam:open-backup-folder'),
  chooseBackupFolder: () => ipcRenderer.invoke('tam:choose-backup-folder'),
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopScroll = 'true';
  const style = document.createElement('style');
  style.textContent = `
    html:has(.workspace), body:has(.workspace) { height: 100%; overflow: hidden; }
    .workspace { height: 100vh; display: flex; flex-direction: column; }
    .workspace > .topbar { position: relative; flex: 0 0 72px; }
    .workspace > main.container { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    .topbar { -webkit-app-region: drag; padding-right: 20px !important; gap: 22px !important; }
    .topbar-meta { margin-left: auto; }
    .topbar a, .topbar button, .topbar input { -webkit-app-region: no-drag; }
    #tam-desktop-titlebar { flex: 0 0 auto; -webkit-app-region: no-drag; }
    #tam-desktop-titlebar.floating { position: fixed; right: 20px; top: 16px; z-index: 1000; }
    body:has(#tam-desktop-titlebar.floating)::before { content: ''; position: fixed; inset: 0 160px auto 0; height: 56px; -webkit-app-region: drag; }
    @media print {
      #tam-desktop-titlebar { display: none !important; }
      html:has(.workspace), body:has(.workspace) { height: auto; overflow: visible; }
      .workspace { height: auto; display: block; }
      .workspace > main.container { overflow: visible; }
    }
  `;
  document.head.append(style);
  const host = document.createElement('div');
  host.id = 'tam-desktop-titlebar';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      header { display: flex; align-items: center; color: #23332f; font: 12px 'Segoe UI', 'Microsoft YaHei', sans-serif; user-select: none; }
      .controls { display:flex; gap:6px; padding:3px; border-radius:12px; background:#f5f8f6; -webkit-app-region:no-drag; }
      button { width:34px; height:30px; border:0; border-radius:8px; background:transparent; color:#718279; display:grid; place-items:center; cursor:pointer; transition:background .15s,color .15s; }
      button:hover { background:#eaf6f0; color:#168568; }
      button:focus-visible { outline:2px solid #168568; outline-offset:-4px; }
      .hide:hover { background:#fcebea; color:#c25252; }
      svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
    </style>
    <header aria-label="桌面窗口控制">
      <div class="controls">
        <button aria-label="最小化窗口" title="最小化窗口" data-action="minimize"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
        <button aria-label="最大化窗口" title="最大化窗口" data-action="maximize"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg></button>
        <button class="hide" aria-label="关闭到托盘" title="关闭到托盘，后台继续运行" data-action="hide"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
    </header>`;
  const maximize = root.querySelector('[data-action="maximize"]');
  const sync = state => {
    const label = state.maximized ? '还原窗口' : '最大化窗口';
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
    maximize.innerHTML = state.maximized ? '<svg viewBox="0 0 24 24"><path d="M9 5h10v10M5 9h10v10H5z"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
  };
  const control = action => ipcRenderer.invoke('tam:window-control', action).then(sync).catch(() => {});
  root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => control(button.dataset.action)));
  ipcRenderer.on('tam:window-state', (_event, state) => sync(state));
  const mount = () => {
    const topbar = document.querySelector('.topbar');
    host.classList.toggle('floating', !topbar);
    if (topbar && host.parentElement !== topbar) topbar.append(host);
    else if (!topbar && host.parentElement !== document.body) document.body.append(host);
  };
  // React 工作台挂载前使用浮动按钮，挂载后融入原有顶栏，不新增横条。
  mount();
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
  control('state');
});
