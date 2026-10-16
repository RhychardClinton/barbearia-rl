// Regras de disponibilidade. Todas as datas são "YYYY-MM-DD" no fuso America/Sao_Paulo.
export const TZ = 'America/Sao_Paulo';

export function nowInSP(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  const hour = Number(g('hour')) % 24;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: hour * 60 + Number(g('minute')) };
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function weekdayOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=dom ... 6=sáb
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function getSettings(db) {
  const o = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) o[r.key] = Number(r.value);
  return o;
}

/** Retorna a lista de horários (minutos desde 00:00) livres para o serviço/barbeiro/data. */
export function computeSlots(db, { serviceId, barberId, date, now = new Date() }) {
  const reasonFail = (reason) => ({ slots: [], reason });
  if (!isValidDate(date)) return reasonFail('data_invalida');
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) return reasonFail('servico_inexistente');
  if (!service.duration_min) return reasonFail('servico_sem_duracao');
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1').get(barberId);
  if (!barber) return reasonFail('barbeiro_inexistente');

  const cfg = getSettings(db);
  const today = nowInSP(now);
  if (date < today.date) return reasonFail('data_passada');
  if (date > addDays(today.date, cfg.max_days_ahead)) return reasonFail('data_distante');

  const hours = db.prepare('SELECT * FROM business_hours WHERE weekday = ?').get(weekdayOf(date));
  if (!hours || !hours.open) return reasonFail('fechado');

  const busy = [];
  for (const a of db.prepare("SELECT start_min, end_min FROM appointments WHERE barber_id = ? AND date = ? AND status != 'cancelado'").all(barberId, date)) {
    busy.push([a.start_min - cfg.buffer_min, a.end_min + cfg.buffer_min]);
  }
  for (const b of db.prepare('SELECT start_min, end_min FROM blocks WHERE date = ? AND (barber_id IS NULL OR barber_id = ?)').all(date, barberId)) {
    busy.push([b.start_min, b.end_min]);
  }

  const slots = [];
  const minStart = date === today.date ? today.minutes + cfg.min_notice_min : 0;
  for (let t = hours.start_min; t + service.duration_min <= hours.end_min; t += cfg.slot_step_min) {
    if (t < minStart) continue;
    const end = t + service.duration_min;
    if (busy.some(([s, e]) => t < e && end > s)) continue;
    slots.push(t);
  }
  return { slots, reason: slots.length ? null : 'sem_horarios' };
}

export function fmtMin(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
