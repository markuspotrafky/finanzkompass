// src/config.js – Persistente App-Konfiguration (JSON-Datei)
// Speichert: Datenbankpfad, letztes Ausführungsdatum der Automatiken
const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

// Konfigurationsdatei liegt immer im Standard-AppData-Ordner
// (unabhängig davon, wo die DB liegt)
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Config lesen fehlgeschlagen:', e.message);
  }
  return {};
}

function save(data) {
  try {
    const current = load();
    const merged  = { ...current, ...data };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) {
    console.error('Config speichern fehlgeschlagen:', e.message);
  }
}

function get(key, fallback = null) {
  return load()[key] ?? fallback;
}

function set(key, value) {
  return save({ [key]: value });
}

module.exports = { load, save, get, set, CONFIG_PATH };
