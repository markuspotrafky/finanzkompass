// src/preload.js – Sichere Brücke zwischen Renderer und Main
const { contextBridge, ipcRenderer } = require('electron');

// Alle erlaubten Kanäle werden hier explizit freigegeben
contextBridge.exposeInMainWorld('api', {

// Dashboard
  dashboard: {
    getData: () => ipcRenderer.invoke('dashboard:getData'),
  },

  // Auswertungen
  analytics: {
    getData: () => ipcRenderer.invoke('analytics:getData'),
  },

  // Konten
  accounts: {
    getAll:      ()           => ipcRenderer.invoke('accounts:getAll'),
    create:      (data)       => ipcRenderer.invoke('accounts:create', data),
    delete:      (id)         => ipcRenderer.invoke('accounts:delete', id),
    updateType:  (id, typ)    => ipcRenderer.invoke('accounts:updateType', id, typ),
    update:      (id, data)   => ipcRenderer.invoke('accounts:update', id, data),
  },

  // Transaktionen
  transactions: {
    getAll:  ()     => ipcRenderer.invoke('transactions:getAll'),
    create:  (data) => ipcRenderer.invoke('transactions:create', data),
    delete:  (id)   => ipcRenderer.invoke('transactions:delete', id),
    adjust:  (data) => ipcRenderer.invoke('transactions:adjust', data),
  },

  // Kategorien
  categories: {
    getAll:  ()         => ipcRenderer.invoke('categories:getAll'),
    create:  (data)     => ipcRenderer.invoke('categories:create', data),
    update:  (id, data) => ipcRenderer.invoke('categories:update', id, data),
    delete:  (id)       => ipcRenderer.invoke('categories:delete', id),
  },

  // Geplante Transaktionen
  scheduled: {
    getAll:  ()     => ipcRenderer.invoke('scheduled:getAll'),
    create:  (data) => ipcRenderer.invoke('scheduled:create', data),
    delete:  (id)   => ipcRenderer.invoke('scheduled:delete', id),
  },

  // Verteilungen
  distributions: {
    getAll:  ()     => ipcRenderer.invoke('distributions:getAll'),
    create:  (data) => ipcRenderer.invoke('distributions:create', data),
    delete:  (id)   => ipcRenderer.invoke('distributions:delete', id),
  },

  // Rücklagen
  reserves: {
    getAll:        ()          => ipcRenderer.invoke('reserves:getAll'),
    create:        (data)      => ipcRenderer.invoke('reserves:create', data),
    updateAmount:  (id, amt)   => ipcRenderer.invoke('reserves:updateAmount', id, amt),
    delete:        (id)        => ipcRenderer.invoke('reserves:delete', id),
  },

  // Ratenkäufe
  installments: {
    getAll:      ()           => ipcRenderer.invoke('installments:getAll'),
    create:      (data)       => ipcRenderer.invoke('installments:create', data),
    updatePaid:  (id, paid)   => ipcRenderer.invoke('installments:updatePaid', id, paid),
    delete:      (id)         => ipcRenderer.invoke('installments:delete', id),
  },

  // Einstellungen
  settings: {
    getDbPath:    () => ipcRenderer.invoke('settings:getDbPath'),
    changeDbPath: () => ipcRenderer.invoke('settings:changeDbPath'),
  },

  // Fenster-Fokus (behebt Electron Input-Fokus-Problem)
  window: {
    focus: () => ipcRenderer.invoke('window:focus'),
  },

  // Startup-Ereignisse vom Main-Prozess empfangen
  onStartupBooked: (callback) => {
    ipcRenderer.on('startup:booked', (_, count) => callback(count));
  },

  // ── Auto-Updater ─────────────────────────────────────────────────────────
  // update:downloaded  → { version, releaseNotes }
  // update:installNow  → App beenden + Update installieren
  //
  // onUpdateDownloaded: ipcRenderer.once() statt .on() — verhindert doppelten
  // Banner wenn Seite neu geladen wird (z.B. durch Entwickler-Reload).
  updater: {
    onUpdateDownloaded: (callback) => {
      // Alte Listener entfernen bevor neuer gesetzt wird (Schutz vor Mehrfach-Banner)
      ipcRenderer.removeAllListeners('update:downloaded');
      ipcRenderer.on('update:downloaded', (_, info) => callback(info));
    },
    installNow: () => ipcRenderer.invoke('update:installNow'),
  },
});
