// src/main.js – Electron Hauptprozess
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

const config             = require('./config');
const db                 = require('./db/database');
const financeService     = require('./logic/financeService');
const reserveService     = require('./logic/reserveService');
const installmentService = require('./logic/installmentService');
const autoService        = require('./logic/autoService');

// ── Single-Instance-Lock ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Fenster-Referenzen ────────────────────────────────────────────────────
let splashWindow = null;
let mainWindow   = null;

// ══════════════════════════════════════════════════════════════════════════
// AUTO-UPDATER
// ══════════════════════════════════════════════════════════════════════════
function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[Updater] Entwicklungsmodus — deaktiviert.');
    return;
  }
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.error('[Updater] nicht gefunden:', e.message);
    return;
  }
  autoUpdater.logger = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => console.log('[Updater] Suche…'));
  autoUpdater.on('update-available',    (i) => console.log(`[Updater] v${i.version} verfügbar`));
  autoUpdater.on('update-not-available',(i) => console.log(`[Updater] v${i.version} aktuell`));
  autoUpdater.on('download-progress',   (p) => console.log(`[Updater] ${Math.round(p.percent)}%`));
  autoUpdater.on('error',               (e) => console.error('[Updater]', e.message ?? e));

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] v${info.version} heruntergeladen`);
    const send = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:downloaded', {
          version: info.version, releaseNotes: info.releaseNotes || null,
        });
      }
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      send();
    } else {
      const t = setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed()) { clearInterval(t); setTimeout(send, 1500); }
      }, 500);
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e =>
      console.error('[Updater] checkForUpdates:', e.message ?? e)
    );
  }, 5000);

  ipcMain.handle('update:installNow', () => autoUpdater.quitAndInstall(false, true));
}

// ── Splash Screen ─────────────────────────────────────────────────────────
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400, height: 320, frame: false, resizable: false,
    center: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#0B0F17', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });
  splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

async function setSplashProgress(percent, text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    await splashWindow.webContents.executeJavaScript(
      `window.setProgress && window.setProgress(${percent}, ${JSON.stringify(text)})`
    );
  } catch (_) {}
}

// ── Haupt-Fenster ─────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    show: false, backgroundColor: '#0B0F17',
    title: 'FinanzKompass',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return mainWindow;
}

// ── Datenbankpfad ─────────────────────────────────────────────────────────
async function resolveDbPath() {
  const saved = config.get('dbPath');
  if (saved && fs.existsSync(path.dirname(saved))) return saved;

  const result = await dialog.showMessageBox(splashWindow, {
    type: 'question', title: 'FinanzKompass – Speicherort',
    message: 'Wo soll die Datenbank gespeichert werden?',
    detail: 'Empfehlung: OneDrive- oder Sync-Ordner für automatisches Backup.',
    buttons: ['Ordner wählen', 'Standard verwenden'], defaultId: 0, cancelId: 1,
  });

  if (result.response === 0) {
    const r = await dialog.showOpenDialog(splashWindow, {
      title: 'Speicherort wählen', properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Hier speichern',
    });
    if (!r.canceled && r.filePaths.length > 0) {
      const dbFile = path.join(r.filePaths[0], 'finanzkompass.db');
      config.set('dbPath', dbFile);
      return dbFile;
    }
  }

  const def = path.join(app.getPath('userData'), 'finanzkompass.db');
  config.set('dbPath', def);
  return def;
}

// ── App-Start ─────────────────────────────────────────────────────────────
async function startApp() {
  try {
    createSplashWindow();
    await setSplashProgress(10, 'Speicherort ermitteln…');

    const dbPath = await resolveDbPath();
    await setSplashProgress(25, 'Datenbank laden…');

    await db.initialize(dbPath);
    await setSplashProgress(50, 'Datenbank bereit');

    let bookedCount = 0;
    await new Promise(resolve => setImmediate(async () => {
      try {
        await setSplashProgress(65, 'Buchungen verarbeiten…');
        bookedCount = db.processScheduled();
        await setSplashProgress(80, 'Rücklagen aktualisieren…');
        autoService.processReserves();
        await setSplashProgress(90, 'Ratenkäufe aktualisieren…');
        autoService.processInstallments();
      } catch (e) { console.error('Start-Automatik:', e); }
      resolve();
    }));

    await setSplashProgress(100, 'Bereit!');
    createMainWindow();

    await new Promise(resolve => mainWindow.once('ready-to-show', resolve));
    mainWindow.show();

    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close(); splashWindow = null;
      }
    }, 200);

    if (bookedCount > 0) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('startup:booked', bookedCount);
      }, 1000);
    }

    initAutoUpdater();

  } catch (e) {
    console.error('Kritischer Startfehler:', e);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    await dialog.showErrorBox('FinanzKompass – Startfehler',
      `Die App konnte nicht gestartet werden:\n\n${e.message}\n\nBitte starte die App neu.`);
    app.quit();
  }
}

app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('browser-window-focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
    }, 50);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// IPC Handler
// ══════════════════════════════════════════════════════════════════════════

ipcMain.handle('accounts:getAll',     ()          => db.getAllAccounts());
ipcMain.handle('accounts:create',     (_, d)      => db.createAccount(d));
ipcMain.handle('accounts:delete',     (_, id)     => db.deleteAccount(id));
ipcMain.handle('accounts:updateType', (_, id, t)  => db.updateAccountType(id, t));
ipcMain.handle('accounts:update',     (_, id, d)  => db.updateAccount(id, d));

ipcMain.handle('transactions:getAll', ()      => db.getAllTransactions());
ipcMain.handle('transactions:create', (_, d)  => db.createTransaction(d));
ipcMain.handle('transactions:delete', (_, id) => db.deleteTransaction(id));
ipcMain.handle('transactions:adjust', (_, d)  => db.createAdjustment(d));

ipcMain.handle('dashboard:getData', () => financeService.getDashboardData());
ipcMain.handle('analytics:getData', () => financeService.getAnalyticsData());

ipcMain.handle('categories:getAll',   ()           => db.getAllCategories());
ipcMain.handle('categories:create',   (_, d)       => db.createCategory(d));
ipcMain.handle('categories:update',   (_, id, d)   => db.updateCategory(id, d));
ipcMain.handle('categories:delete',   (_, id)      => db.deleteCategory(id));

ipcMain.handle('scheduled:getAll',  ()      => db.getAllScheduled());
ipcMain.handle('scheduled:create',  (_, d)  => db.createScheduled(d));
ipcMain.handle('scheduled:delete',  (_, id) => db.deleteScheduled(id));

ipcMain.handle('distributions:getAll',  ()      => db.getAllDistributions());
ipcMain.handle('distributions:create',  (_, d)  => db.createDistribution(d));
ipcMain.handle('distributions:delete',  (_, id) => db.deleteDistribution(id));

ipcMain.handle('reserves:getAll',       ()            => reserveService.getAllReservesWithProgress());
ipcMain.handle('reserves:create',       (_, d)        => reserveService.createReserve(d));
ipcMain.handle('reserves:updateAmount', (_, id, amt)  => reserveService.updateReserveAmount(id, amt));
ipcMain.handle('reserves:delete',       (_, id)       => reserveService.deleteReserve(id));

ipcMain.handle('installments:getAll',     ()             => installmentService.getAllInstallmentsWithProgress());
ipcMain.handle('installments:create',     (_, d)         => installmentService.createInstallment(d));
ipcMain.handle('installments:updatePaid', (_, id, paid)  => installmentService.updateInstallmentPaidMonths(id, paid));
ipcMain.handle('installments:delete',     (_, id)        => installmentService.deleteInstallment(id));

ipcMain.handle('settings:getDbPath', () => db.getDbPath());

ipcMain.handle('settings:changeDbPath', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Neuen Speicherort wählen',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Hier speichern',
  });
  if (result.canceled || !result.filePaths.length) return { success: false, reason: 'Abgebrochen' };

  const newPath = path.join(result.filePaths[0], 'finanzkompass.db');
  const oldPath = db.getDbPath();
  try {
    if (oldPath && fs.existsSync(oldPath)) fs.copyFileSync(oldPath, newPath);
    config.set('dbPath', newPath);
    return { success: true, path: newPath };
  } catch (e) {
    return { success: false, reason: e.message };
  }
});

ipcMain.handle('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus(); mainWindow.webContents.focus();
      }
    }, 30);
  }
});
// Hinweis: ipcMain.handle('update:installNow') ist in initAutoUpdater() registriert
