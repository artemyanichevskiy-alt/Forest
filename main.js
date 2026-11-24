const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const core = require('./core');

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 700, minWidth: 940, minHeight: 620,
    backgroundColor: '#0a120c', title: 'Fortress Launcher', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
}
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

app.whenReady().then(() => { core.init(app.getPath('appData'), send); createWindow(); });
app.on('window-all-closed', () => app.quit());

ipcMain.handle('api', async (_e, name, ...args) => {
  try {
    if (!core.api[name]) throw new Error('Unknown api: ' + name);
    return { ok: true, data: await core.api[name](...args) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
