// src/security/encryptionService.js
// AES-256-GCM Verschlüsselung für die SQLite-Datenbankdatei.
//
// Dateistruktur (binär, alle Längen fix):
//   [0..15]   salt      (16 Bytes) – zufällig, pro Verschlüsselung neu
//   [16..27]  iv        (12 Bytes) – Initialization Vector für GCM
//   [28..43]  authTag   (16 Bytes) – GCM Authentication Tag (Integritätsschutz)
//   [44..]    ciphertext           – verschlüsselte Datenbankdaten
//
// Key Derivation: PBKDF2-SHA512, 210.000 Iterationen (OWASP-Empfehlung 2024)
// Cipher:         AES-256-GCM (authentifizierte Verschlüsselung)
//
// Sicherheitseigenschaften:
//   - salt:    verhindert Rainbow-Table-Angriffe auf das Passwort
//   - iv:      jede Verschlüsselung erzeugt einzigartigen Ciphertext
//   - authTag: erkennt Manipulation der verschlüsselten Datei (→ falsches PW-Fehler)

'use strict';

const crypto = require('crypto');

// ── Konstanten ────────────────────────────────────────────────────────────
const SALT_LEN    = 16;   // Bytes
const IV_LEN      = 12;   // Bytes (GCM-Standard)
const TAG_LEN     = 16;   // Bytes (GCM Authentication Tag)
const KEY_LEN     = 32;   // Bytes → AES-256
const ITERATIONS  = 210_000;
const DIGEST      = 'sha512';
const ALGORITHM   = 'aes-256-gcm';

// Magic-Bytes: erste 4 Bytes jeder verschlüsselten Datei
// Damit kann Migration (unverschlüsselt erkannt) sicher prüfen.
const MAGIC = Buffer.from('FKDB');  // FinanzKompass DataBase
const MAGIC_LEN = MAGIC.length;

// Gesamter Header-Offset bis zum Ciphertext
const HEADER_LEN = MAGIC_LEN + SALT_LEN + IV_LEN + TAG_LEN;
// Offsets:                    0           4           20     32     48

/**
 * Leitet einen 256-Bit AES-Schlüssel aus Passwort + Salt ab.
 * Synchron — PBKDF2 blockiert kurz den Main-Thread (~100ms).
 * Das ist beim App-Start einmalig akzeptabel.
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
}

/**
 * Verschlüsselt Rohdaten (Uint8Array | Buffer) mit dem gegebenen Passwort.
 * Gibt einen Buffer zurück der direkt auf Disk geschrieben werden kann.
 *
 * @param {Uint8Array|Buffer} data      – Rohdaten (z.B. db.export())
 * @param {string}            password  – Benutzerpasswort (bleibt im RAM)
 * @returns {Buffer}
 */
function encrypt(data, password) {
  if (!password || typeof password !== 'string' || password.length === 0) {
    throw new Error('Passwort darf nicht leer sein.');
  }

  const salt       = crypto.randomBytes(SALT_LEN);
  const iv         = crypto.randomBytes(IV_LEN);
  const key        = deriveKey(password, salt);

  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext  = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag    = cipher.getAuthTag();  // 16 Bytes GCM Tag

  // Struktur: MAGIC | salt | iv | authTag | ciphertext
  return Buffer.concat([MAGIC, salt, iv, authTag, ciphertext]);
}

/**
 * Entschlüsselt einen Buffer der mit encrypt() erstellt wurde.
 * Wirft einen expliziten Fehler wenn Passwort falsch oder Datei beschädigt.
 *
 * @param {Buffer} buffer     – Inhalt der verschlüsselten Datei
 * @param {string} password   – Benutzerpasswort
 * @returns {Uint8Array}      – Rohdaten der SQLite-Datenbank
 */
function decrypt(buffer, password) {
  if (!password || typeof password !== 'string' || password.length === 0) {
    throw new Error('Passwort darf nicht leer sein.');
  }
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  if (buffer.length < HEADER_LEN + 1) {
    throw new Error('Falsches Passwort oder beschädigte Datenbank.');
  }

  // Magic prüfen
  const magic = buffer.slice(0, MAGIC_LEN);
  if (!magic.equals(MAGIC)) {
    throw new Error('Falsches Passwort oder beschädigte Datenbank.');
  }

  // Header auslesen
  let offset    = MAGIC_LEN;
  const salt    = buffer.slice(offset, offset + SALT_LEN);   offset += SALT_LEN;
  const iv      = buffer.slice(offset, offset + IV_LEN);      offset += IV_LEN;
  const authTag = buffer.slice(offset, offset + TAG_LEN);     offset += TAG_LEN;
  const ciphertext = buffer.slice(offset);

  const key = deriveKey(password, salt);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    // GCM-Authentifizierungsfehler → falsches Passwort oder manipulierte Datei
    throw new Error('Falsches Passwort oder beschädigte Datenbank.');
  }

  return new Uint8Array(plaintext);
}

/**
 * Prüft ob ein Buffer eine verschlüsselte FinanzKompass-Datenbank ist.
 * Erkennt die Magic-Bytes → false = unverschlüsselt (Migration nötig).
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isEncrypted(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MAGIC_LEN) return false;
  return buffer.slice(0, MAGIC_LEN).equals(MAGIC);
}

module.exports = { encrypt, decrypt, isEncrypted };
