// src/logic/autoService.js – Automatische Rücklagen-Besparung & Ratenkauf-Aktualisierung
// Wird beim App-Start aufgerufen. Verhindert Doppelbuchungen über das Config-Datum.

const db     = require('../db/database');
const config = require('../config');

// Gibt YYYY-MM zurück, z.B. "2026-03"
function yearMonth(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function today() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── TEIL 1: Rücklagen automatisch besparen ────────────────────────────────
// Logik:
//   - Jede Rücklage hat interval_months und deduction_day
//   - Wir merken uns pro Rücklage das letzte besparungs-Monat in der Config
//   - Wenn aktueller Monat > letzter Monat → current_amount erhöhen
//   - Keine doppelte Buchung im selben Monat

function processReserves() {
  const reserves     = db.getAllReserves();
  const currentYM    = yearMonth(today());
  let   updated      = 0;

  reserves.forEach(r => {
    // Schlüssel pro Rücklage: letzter Sparmonat
    const configKey = `reserve_last_run_${r.id}`;
    const lastRun   = config.get(configKey, '');

    // Nur ausführen wenn aktueller Monat noch nicht bearbeitet wurde
    if (lastRun >= currentYM) return;

    // Nur wenn Ziel noch nicht erreicht
    if (r.current_amount >= r.target_amount) {
      config.set(configKey, currentYM);
      return;
    }

    // Abbuchungsbetrag berechnen: Restbetrag / Intervall = monatliches Äquivalent
    // Vereinfacht: wir buchen den monatlichen Äquivalent pro Intervall-Monat.
    // Da wir monatlich prüfen, buchen wir 1/interval_months des Intervallbetrags.
    // Für mehr Einfachheit: wir speichern keinen festen Monatsbetrag, sondern
    // nehmen an dass der Nutzer jeden Monat seinen Anteil zurücklegt.
    // → Wir erhöhen current_amount nur in den Monaten, in denen der deduction_day
    //   erreicht ist (oder bereits vorbei), und das Intervall passt.

    const shouldBook = isDeductionMonth(r, currentYM, lastRun);
    if (!shouldBook) {
      // Noch nicht am Abbuchungstag: Config NICHT setzen, damit später noch gebucht wird
      return;
    }

    // Monatlicher Äquivalentbetrag: target_amount-anteilig nach Intervall
    // Da kein fester Sparbetrag gespeichert wird, berechnen wir ihn dynamisch:
    // remaining / interval_months gibt den Betrag pro Monat im Intervall-Zyklus.
    const remaining   = r.target_amount - r.current_amount;
    const contribution = parseFloat((remaining / r.interval_months).toFixed(2));

    if (contribution <= 0) {
      config.set(configKey, currentYM);
      return;
    }

    const newAmount = Math.min(r.current_amount + contribution, r.target_amount);
    db.updateReserveAmount(r.id, parseFloat(newAmount.toFixed(2)));
    config.set(configKey, currentYM);
    updated++;
    console.log(`Rücklage „${r.name}": +${contribution.toFixed(2)}€ → ${newAmount.toFixed(2)}€`);
  });

  if (updated > 0) console.log(`Rücklagen automatisch aktualisiert: ${updated}`);
  return updated;
}

// Prüft ob im aktuellen Monat eine Abbuchung stattfinden soll.
// Berücksichtigt: interval_months und deduction_day.
function isDeductionMonth(reserve, currentYM, lastRunYM) {
  // Abbuchungstag im aktuellen Monat berechnen
  const [year, month] = currentYM.split('-').map(Number);
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const deductionDay   = Math.min(reserve.deduction_day, lastDayOfMonth);
  const todayDate      = new Date().getDate();

  // Noch nicht am Abbuchungstag angekommen
  if (todayDate < deductionDay) return false;

  // Wenn noch nie gebucht → buchen
  if (!lastRunYM) return true;

  // Monatsabstand seit letzter Buchung berechnen
  const [ly, lm] = lastRunYM.split('-').map(Number);
  const monthDiff = (year - ly) * 12 + (month - lm);

  // Nur buchen wenn genug Monate vergangen sind (Intervall)
  return monthDiff >= reserve.interval_months;
}

// ── TEIL 2: Ratenkäufe automatisch aktualisieren ──────────────────────────
// Logik:
//   - Für jeden Ratenkauf: wie viele Monate sind seit start_date vergangen?
//   - paid_months auf diesen Wert setzen (max total_months)
//   - Keine Doppelzählung: wir berechnen den Sollstand und vergleichen

function processInstallments() {
  const installments = db.getAllInstallments();
  const todayStr     = today();
  let   updated      = 0;

  installments.forEach(inst => {
    if (inst.paid_months >= inst.total_months) return; // bereits abgeschlossen

    // Vergangene Monate seit Startdatum berechnen
    const start     = new Date(inst.start_date);
    const now       = new Date(todayStr);
    const elapsed   = (now.getFullYear() - start.getFullYear()) * 12
                    + (now.getMonth() - start.getMonth());

    // Soll-Stand: vergangene Monate, max. total_months
    const shouldBe = Math.min(Math.max(0, elapsed), inst.total_months);

    // Nur erhöhen, nie verringern (Nutzer könnte manuell erhöht haben)
    if (shouldBe > inst.paid_months) {
      db.updateInstallmentPaidMonths(inst.id, shouldBe);
      updated++;
      console.log(`Ratenkauf „${inst.name}": paid_months ${inst.paid_months} → ${shouldBe}`);
    }
  });

  if (updated > 0) console.log(`Ratenkäufe automatisch aktualisiert: ${updated}`);
  return updated;
}

module.exports = { processReserves, processInstallments };
