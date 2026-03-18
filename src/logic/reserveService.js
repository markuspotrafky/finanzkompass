// src/logic/reserveService.js – Berechnungslogik für Rücklagen
const db = require('../db/database');

// Intervall-Beschriftungen
const intervalLabels = { 1: 'Monatlich', 3: 'Vierteljährlich', 6: 'Halbjährlich', 12: 'Jährlich' };

// Berechnet den monatlichen Äquivalentbetrag aus Intervall und Restbetrag.
// Beispiel: 300€ vierteljährlich = 100€/Monat
function calcMonthlyEquivalent(amountPerInterval, intervalMonths) {
  if (!amountPerInterval || !intervalMonths) return 0;
  return amountPerInterval / intervalMonths;
}

// Berechnet den Abbuchungsbetrag pro Intervall aus Restbetrag.
// "Wie viel muss ich pro Abbuchung zurücklegen, um das Ziel zu erreichen?"
// Vereinfacht: wir speichern keinen Zielbetrag pro Abbuchung, sondern berechnen
// den monatlichen Äquivalent für die Anzeige.
function calcContributionPerInterval(remaining, intervalMonths) {
  // Gibt einfach den Restbetrag aufgeteilt auf Monate zurück (keine feste Laufzeit)
  return remaining > 0 ? remaining : 0;
}

function getAllReservesWithProgress() {
  const reserves = db.getAllReserves();
  return reserves.map(r => {
    const progress  = r.target_amount > 0
      ? Math.min(100, Math.round((r.current_amount / r.target_amount) * 100))
      : 0;
    const remaining = Math.max(0, r.target_amount - r.current_amount);

    // Nächster Abbuchungstag – first_due_date hat Vorrang vor dynamischer Berechnung
    const nextDeduction = getNextDeductionDate(r.deduction_day, r.interval_months, r.first_due_date);

    const intervalLabel = intervalLabels[r.interval_months] ?? `Alle ${r.interval_months} Monate`;

    return { ...r, progress, remaining, nextDeduction, intervalLabel };
  });
}

// Berechnet das nächste Fälligkeitsdatum.
// Wenn first_due_date gesetzt ist und in der Zukunft liegt, wird es direkt zurückgegeben.
// Danach greift die reguläre Berechnung aus deduction_day + interval_months.
// addMonthsSafe (aus database.js) verhindert Rollover bei kurzen Monaten.
function getNextDeductionDate(day, intervalMonths, firstDueDate = null) {
  const { addMonthsSafe } = require('../db/database');

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Hilfsfunktion: Tag auf letzten gültigen Tag des Monats klemmen
  function clampDay(y, m, d) {
    const lastDay = new Date(y, m + 1, 0).getDate(); // m ist 0-basiert
    return Math.min(d, lastDay);
  }

  // first_due_date: wenn heute oder in der Zukunft → direkt verwenden
  if (firstDueDate) {
    const fdd = new Date(firstDueDate);
    fdd.setHours(0, 0, 0, 0);
    if (fdd >= now) return firstDueDate;
  }

  // Reguläre Berechnung: nächster Termin mit deduction_day
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-basiert

  const candidateDay = clampDay(year, month, day);
  const candidate    = new Date(year, month, candidateDay);

  if (candidate <= now) {
    // Termin in diesem Monat bereits vorbei → nächstes Intervall via addMonthsSafe
    const baseDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(candidateDay).padStart(2, '0')}`;
    return addMonthsSafe(baseDate, intervalMonths);
  }

  return `${year}-${String(month + 1).padStart(2, '0')}-${String(candidateDay).padStart(2, '0')}`;
}

function createReserve(data)                     { return db.createReserve(data); }
function updateReserveAmount(id, current_amount) { return db.updateReserveAmount(id, current_amount); }
function deleteReserve(id)                       { return db.deleteReserve(id); }

module.exports = {
  getAllReservesWithProgress,
  createReserve, updateReserveAmount, deleteReserve,
  intervalLabels
};
