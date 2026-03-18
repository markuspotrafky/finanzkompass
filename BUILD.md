# FinanzKompass – Build-Anleitung

## Voraussetzungen

- **Node.js** 18 oder neuer: https://nodejs.org
- **Windows** (für .exe Build) oder Windows Subsystem for Linux

---

## Entwicklung starten

```bash
# Im finanzkompass-v2 Ordner:
npm install
npm start
```

---

## .exe Build erstellen

### Schritt 1 – Abhängigkeiten installieren

```bash
npm install
```

### Schritt 2 – Windows Installer (.exe) bauen

```bash
npm run build:win
```

**Output:** `dist/` Ordner mit:
- `FinanzKompass-Setup-1.0.0.exe` → Installer (empfohlen)
- `FinanzKompass-Portable-1.0.0.exe` → Portable Version (kein Install nötig)

---

## Build-Ergebnis

| Datei | Beschreibung |
|---|---|
| `FinanzKompass-Setup-1.0.0.exe` | Windows Installer mit Deinstallation, Desktop-Verknüpfung |
| `FinanzKompass-Portable-1.0.0.exe` | Läuft ohne Installation, ideal für USB-Stick |

---

## Häufige Build-Fehler

### `wine` nicht gefunden (Linux/Mac)
```bash
# Nur relevant wenn du auf Linux/Mac für Windows baust
# Entweder Wine installieren oder direkt auf Windows bauen
```

### WASM-Datei nicht gefunden
```bash
# Prüfe ob sql.js installiert ist:
ls node_modules/sql.js/dist/sql-wasm.wasm
# Falls nicht:
npm install
```

### electron-builder Fehler "NSIS not found"
```bash
npm install electron-builder --save-dev
```

---

## Projektstruktur

```
finanzkompass-v2/
├── assets/
│   ├── icon.ico       ← Windows App-Icon
│   ├── icon.png       ← 256×256 PNG Icon
│   └── icon_512.png   ← 512×512 PNG Icon
├── src/
│   ├── main.js        ← Electron Main Process (Splash + App-Start)
│   ├── preload.js     ← Sichere IPC-Brücke
│   ├── config.js      ← Persistente App-Konfiguration
│   ├── db/
│   │   └── database.js ← SQLite via sql.js
│   ├── logic/
│   │   ├── autoService.js
│   │   ├── financeService.js
│   │   ├── installmentService.js
│   │   └── reserveService.js
│   └── ui/
│       ├── index.html  ← Haupt-App
│       ├── splash.html ← Splash Screen (erscheint beim Start)
│       ├── app.js      ← Frontend-Logik
│       ├── style.css   ← Design
│       └── logo.png    ← App-Logo
├── package.json
└── BUILD.md
```

---

## Datenbank-Speicherort

Die Datenbank (`finanzkompass.db`) liegt **nicht** im App-Ordner, sondern:
- **Standard:** `C:\Users\<Name>\AppData\Roaming\FinanzKompass\finanzkompass.db`
- **Eigener Pfad:** Beim ersten Start auswählbar (z.B. OneDrive)

Die Datenbank bleibt beim Update/Neuinstall erhalten.
