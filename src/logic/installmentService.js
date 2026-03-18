// src/logic/installmentService.js – Berechnungslogik für Ratenkäufe
const db = require('../db/database');

function getAllInstallmentsWithProgress() {
  const items = db.getAllInstallments();
  return items.map(inst => {
    const safePaid   = Math.min(inst.paid_months, inst.total_months);
    const progress   = inst.total_months > 0
      ? Math.min(100, Math.round((safePaid / inst.total_months) * 100))
      : 0;
    const paidAmount = safePaid * inst.monthly_rate;
    const remaining  = Math.max(0, inst.total_amount - paidAmount);
    const monthsLeft = inst.total_months - safePaid;
    const isComplete = safePaid >= inst.total_months;

    // Enddatum berechnen — addMonthsSafe verhindert Rollover (z.B. 31. Jan + 6 → 3. Aug)
    let endDate = null;
    if (inst.start_date && inst.total_months > 0) {
      endDate = db.addMonthsSafe(inst.start_date, inst.total_months);
    }

    return { ...inst, paid_months: safePaid, progress, paidAmount, remaining, monthsLeft, isComplete, endDate };
  });
}

function createInstallment(data)                        { return db.createInstallment(data); }
function updateInstallmentPaidMonths(id, paid_months)   { return db.updateInstallmentPaidMonths(id, paid_months); }
function deleteInstallment(id)                          { return db.deleteInstallment(id); }

module.exports = { getAllInstallmentsWithProgress, createInstallment, updateInstallmentPaidMonths, deleteInstallment };
