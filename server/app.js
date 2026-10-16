import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  computeSlots, nowInSP, isValidDate, addDays, weekdayOf, getSettings, fmtMin,
} from './availability.js';
import {
  hashPassword, verifyPassword, createSession, getSessionAdmin, destroySession,
  parseCookies, makeRateLimiter,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Envie os dados como JSON.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 50_000) throw new HttpError(413, 'Requisição grande demais.');
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}

// ---------- validações ----------
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (!/^[1-9]{2}9?\d{8}$/.test(d) || (d.length === 11 && d[2] !== '9')) return null;
  return d;
}
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function parseTimeToMin(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 24 && Number(m[2]) < 60 && v <= 1440 ? v : null;
}

export function createApp(db, { onSetupCode, bookingLimit = 20 } = {}) {
  const loginLimiter = makeRateLimiter(8, 10 * 60 * 1000);
  const bookingLimiter = makeRateLimiter(bookingLimit, 10 * 60 * 1000);
  const state = { setupCode: null };
  const adminCount = () => db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (!adminCount()) {
    state.setupCode = process.env.ADMIN_SETUP_CODE || crypto.randomBytes(6).toString('hex');
    onSetupCode?.(state.setupCode);
  }

  const ip = (req) => req.socket.remoteAddress || 'x';
  const cookieOf = (req) => parseCookies(req.headers.cookie).rl_admin;
  const requireAdmin = (req) => {
    const admin = getSessionAdmin(db, cookieOf(req));
    if (!admin) throw new HttpError(401, 'Não autenticado.');
    return admin;
  };

  const withTx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  };

  const publicService = (s) => ({
    id: s.id, name: s.name, price_cents: s.price_cents, price_from: !!s.price_from,
    duration_min: s.duration_min, bookable: !!s.duration_min,
  });

  // ---------- rotas públicas ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler });

  route('GET', '/api/public', () => {
    const services = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort_order, id').all().map(publicService);
    const barbers = db.prepare('SELECT id, name FROM barbers WHERE active = 1 ORDER BY id').all();
    const hours = db.prepare('SELECT * FROM business_hours ORDER BY weekday').all();
    const cfg = getSettings(db);
    return { services, barbers, hours, max_days_ahead: cfg.max_days_ahead, today: nowInSP().date };
  });

  route('GET', '/api/availability', (req, res, url) => {
    const serviceId = Number(url.searchParams.get('service'));
    const barberId = Number(url.searchParams.get('barber'));
    const date = url.searchParams.get('date') || '';
    const r = computeSlots(db, { serviceId, barberId, date });
    return { date, reason: r.reason, slots: r.slots.map((m) => ({ minutes: m, time: fmtMin(m) })) };
  });

  route('GET', '/api/availability/days', (req, res, url) => {
    const serviceId = Number(url.searchParams.get('service'));
    const barberId = Number(url.searchParams.get('barber'));
    const cfg = getSettings(db);
    const today = nowInSP().date;
    const days = {};
    for (let i = 0; i <= cfg.max_days_ahead; i++) {
      const d = addDays(today, i);
      days[d] = computeSlots(db, { serviceId, barberId, date: d }).slots.length > 0;
    }
    return { days };
  });

  route('POST', '/api/bookings', async (req) => {
    if (!bookingLimiter(ip(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readJson(req);
    const key = String(b.request_key ?? '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new HttpError(400, 'Requisição inválida.');
    const name = cleanName(b.name);
    if (name.length < 2 || name.length > 80) throw new HttpError(422, 'Informe seu nome (2 a 80 caracteres).', { field: 'name' });
    const phone = normalizePhone(b.phone);
    if (!phone) throw new HttpError(422, 'Informe um WhatsApp válido com DDD.', { field: 'phone' });
    if (b.consent !== true) throw new HttpError(422, 'É necessário concordar com o uso dos dados para agendar.', { field: 'consent' });
    const serviceId = Number(b.service_id), barberId = Number(b.barber_id);
    const date = String(b.date ?? '');
    const start = Number(b.start_min);
    if (!Number.isInteger(start)) throw new HttpError(422, 'Horário inválido.');

    return withTx(() => {
      // Idempotência: clique repetido / reenvio devolve a mesma reserva.
      const existing = db.prepare('SELECT * FROM appointments WHERE token = ?').get(key);
      if (existing) return { booking: bookingView(db, existing), duplicate: true };

      const { slots, reason } = computeSlots(db, { serviceId, barberId, date });
      if (reason === 'servico_sem_duracao') throw new HttpError(409, 'Este serviço ainda não está disponível para agendamento online.');
      if (!slots.includes(start)) throw new HttpError(409, 'Esse horário acabou de ficar indisponível. Escolha outro.', { code: 'slot_taken' });

      const service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
      const info = db.prepare(`INSERT INTO appointments
        (barber_id, service_id, service_name, price_cents, customer_name, customer_phone, date, start_min, end_min, status, token)
        VALUES (?,?,?,?,?,?,?,?,?,'pendente',?)`)
        .run(barberId, serviceId, service.name, service.price_cents, name, phone, date, start, start + service.duration_min, key);
      const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(info.lastInsertRowid));
      return { booking: bookingView(db, row), duplicate: false };
    });
  });

  // ---------- admin: autenticação ----------
  route('GET', '/api/admin/status', (req) => ({
    setup_required: adminCount() === 0,
    authenticated: !!getSessionAdmin(db, cookieOf(req)),
  }));

  route('POST', '/api/admin/setup', async (req) => {
    if (!loginLimiter(ip(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde.');
    const b = await readJson(req);
    if (adminCount() > 0) throw new HttpError(409, 'O administrador já foi configurado.');
    const given = Buffer.from(String(b.code ?? ''));
    const real = Buffer.from(state.setupCode ?? '');
    if (!real.length || given.length !== real.length || !crypto.timingSafeEqual(given, real)) throw new HttpError(403, 'Código de configuração inválido.');
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, 'E-mail inválido.');
    if (String(b.password ?? '').length < 10) throw new HttpError(422, 'A senha precisa ter ao menos 10 caracteres.');
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?,?)').run(email, hashPassword(b.password));
    state.setupCode = null;
    return { ok: true };
  });

  route('POST', '/api/admin/login', async (req, res) => {
    if (!loginLimiter(ip(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(b.email ?? '').trim().toLowerCase());
    // Faz o hash mesmo se o e-mail não existe, para não vazar a existência da conta pelo tempo.
    const ok = admin ? verifyPassword(String(b.password ?? ''), admin.password_hash)
      : (verifyPassword('x', hashPassword('y')), false);
    if (!ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
    const { token, maxAgeSec } = createSession(db, admin.id);
    const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rl_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`);
    return { ok: true, email: admin.email };
  });

  route('POST', '/api/admin/logout', (req, res) => {
    destroySession(db, cookieOf(req));
    res.setHeader('Set-Cookie', 'rl_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  // ---------- admin: agendamentos ----------
  const adminView = (a) => ({
    id: a.id, barber_id: a.barber_id, service_id: a.service_id, service_name: a.service_name,
    price_cents: a.price_cents, customer_name: a.customer_name, customer_phone: a.customer_phone,
    date: a.date, start_min: a.start_min, end_min: a.end_min, start: fmtMin(a.start_min), end: fmtMin(a.end_min),
    status: a.status, created_at: a.created_at,
  });

  route('GET', '/api/admin/appointments', (req, res, url) => {
    requireAdmin(req);
    const date = url.searchParams.get('date');
    const mode = url.searchParams.get('mode');
    let rows;
    if (date) {
      if (!isValidDate(date)) throw new HttpError(400, 'Data inválida.');
      rows = db.prepare('SELECT * FROM appointments WHERE date = ? ORDER BY start_min').all(date);
    } else if (mode === 'canceled') {
      rows = db.prepare("SELECT * FROM appointments WHERE status = 'cancelado' ORDER BY date DESC, start_min DESC LIMIT 200").all();
    } else {
      const t = nowInSP();
      rows = db.prepare("SELECT * FROM appointments WHERE status IN ('pendente','confirmado') AND (date > ? OR (date = ? AND end_min >= ?)) ORDER BY date, start_min LIMIT 500").all(t.date, t.date, t.minutes);
    }
    return { appointments: rows.map(adminView) };
  });

  route('PATCH', '/api/admin/appointments/(\\d+)', async (req, res, url, m) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!['pendente', 'confirmado', 'concluido', 'cancelado'].includes(b.status)) throw new HttpError(422, 'Status inválido.');
    return withTx(() => {
      const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(m[1]));
      if (!a) throw new HttpError(404, 'Agendamento não encontrado.');
      if (a.status === 'cancelado' && b.status !== 'cancelado') {
        // reativar: precisa conferir se o horário ainda está livre
        const clash = db.prepare("SELECT 1 FROM appointments WHERE barber_id = ? AND date = ? AND status != 'cancelado' AND id != ? AND start_min < ? AND end_min > ?")
          .get(a.barber_id, a.date, a.id, a.end_min, a.start_min);
        if (clash) throw new HttpError(409, 'Não é possível reativar: o horário já foi ocupado por outro agendamento.');
      }
      db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(b.status, a.id);
      return { appointment: adminView(db.prepare('SELECT * FROM appointments WHERE id = ?').get(a.id)) };
    });
  });

  // ---------- admin: serviços ----------
  const serviceFields = (b, partial) => {
    const out = {};
    if (!partial || b.name !== undefined) {
      const n = cleanName(b.name);
      if (n.length < 2 || n.length > 80) throw new HttpError(422, 'Nome do serviço inválido.');
      out.name = n;
    }
    if (!partial || b.price_cents !== undefined) {
      if (!intIn(b.price_cents, 0, 10_000_000)) throw new HttpError(422, 'Preço inválido.');
      out.price_cents = b.price_cents;
    }
    if (b.price_from !== undefined) out.price_from = b.price_from ? 1 : 0;
    if (b.duration_min !== undefined) {
      if (b.duration_min !== null && !intIn(b.duration_min, 5, 720)) throw new HttpError(422, 'Duração deve ficar entre 5 e 720 minutos (ou vazia).');
      out.duration_min = b.duration_min;
    }
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    if (b.sort_order !== undefined && intIn(b.sort_order, 0, 10000)) out.sort_order = b.sort_order;
    return out;
  };

  route('GET', '/api/admin/services', (req) => {
    requireAdmin(req);
    return { services: db.prepare('SELECT * FROM services ORDER BY sort_order, id').all() };
  });
  route('POST', '/api/admin/services', async (req) => {
    requireAdmin(req);
    const f = serviceFields(await readJson(req), false);
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM services').get().m;
    const info = db.prepare('INSERT INTO services (name, price_cents, price_from, duration_min, active, sort_order) VALUES (?,?,?,?,?,?)')
      .run(f.name, f.price_cents, f.price_from ?? 0, f.duration_min ?? null, f.active ?? 1, max + 1);
    return { service: db.prepare('SELECT * FROM services WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
  route('PATCH', '/api/admin/services/(\\d+)', async (req, res, url, m) => {
    requireAdmin(req);
    const f = serviceFields(await readJson(req), true);
    const keys = Object.keys(f);
    if (!keys.length) throw new HttpError(422, 'Nada para atualizar.');
    const r = db.prepare(`UPDATE services SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), Number(m[1]));
    if (!r.changes) throw new HttpError(404, 'Serviço não encontrado.');
    return { service: db.prepare('SELECT * FROM services WHERE id = ?').get(Number(m[1])) };
  });

  // ---------- admin: barbeiros ----------
  route('GET', '/api/admin/barbers', (req) => { requireAdmin(req); return { barbers: db.prepare('SELECT * FROM barbers ORDER BY id').all() }; });
  route('POST', '/api/admin/barbers', async (req) => {
    requireAdmin(req);
    const n = cleanName((await readJson(req)).name);
    if (n.length < 2 || n.length > 60) throw new HttpError(422, 'Nome inválido.');
    const info = db.prepare('INSERT INTO barbers (name) VALUES (?)').run(n);
    return { barber: db.prepare('SELECT * FROM barbers WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
  route('PATCH', '/api/admin/barbers/(\\d+)', async (req, res, url, m) => {
    requireAdmin(req);
    const b = await readJson(req);
    const id = Number(m[1]);
    if (!db.prepare('SELECT 1 FROM barbers WHERE id = ?').get(id)) throw new HttpError(404, 'Barbeiro não encontrado.');
    if (b.name !== undefined) {
      const n = cleanName(b.name);
      if (n.length < 2 || n.length > 60) throw new HttpError(422, 'Nome inválido.');
      db.prepare('UPDATE barbers SET name = ? WHERE id = ?').run(n, id);
    }
    if (b.active !== undefined) {
      if (!b.active && db.prepare('SELECT COUNT(*) c FROM barbers WHERE active = 1 AND id != ?').get(id).c === 0)
        throw new HttpError(409, 'Mantenha ao menos um barbeiro ativo.');
      db.prepare('UPDATE barbers SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id);
    }
    return { barber: db.prepare('SELECT * FROM barbers WHERE id = ?').get(id) };
  });

  // ---------- admin: horários, configurações e bloqueios ----------
  route('GET', '/api/admin/hours', (req) => {
    requireAdmin(req);
    return { hours: db.prepare('SELECT * FROM business_hours ORDER BY weekday').all(), settings: getSettings(db) };
  });
  route('PUT', '/api/admin/hours', async (req) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!Array.isArray(b.hours) || b.hours.length !== 7) throw new HttpError(422, 'Informe os 7 dias da semana.');
    withTx(() => {
      for (const h of b.hours) {
        const start = typeof h.start === 'string' ? parseTimeToMin(h.start) : null;
        const end = typeof h.end === 'string' ? parseTimeToMin(h.end) : null;
        if (!intIn(h.weekday, 0, 6) || start === null || end === null || (h.open && start >= end))
          throw new HttpError(422, 'Horário de funcionamento inválido.');
        db.prepare('UPDATE business_hours SET open = ?, start_min = ?, end_min = ? WHERE weekday = ?').run(h.open ? 1 : 0, start, end, h.weekday);
      }
      if (b.settings) {
        const s = b.settings;
        const rules = { slot_step_min: [5, 120], buffer_min: [0, 120], max_days_ahead: [1, 365], min_notice_min: [0, 1440] };
        for (const [k, [lo, hi]] of Object.entries(rules)) {
          if (s[k] === undefined) continue;
          if (!intIn(s[k], lo, hi)) throw new HttpError(422, `Configuração inválida: ${k}.`);
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(s[k]), k);
        }
      }
    });
    return { hours: db.prepare('SELECT * FROM business_hours ORDER BY weekday').all(), settings: getSettings(db) };
  });

  route('GET', '/api/admin/blocks', (req) => {
    requireAdmin(req);
    const t = nowInSP().date;
    return { blocks: db.prepare('SELECT * FROM blocks WHERE date >= ? ORDER BY date, start_min').all(t) };
  });
  route('POST', '/api/admin/blocks', async (req) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!isValidDate(String(b.date))) throw new HttpError(422, 'Data inválida.');
    let start = 0, end = 1440;
    if (!b.all_day) {
      start = parseTimeToMin(b.start); end = parseTimeToMin(b.end);
      if (start === null || end === null || start >= end) throw new HttpError(422, 'Intervalo de horário inválido.');
    }
    const barberId = b.barber_id ? Number(b.barber_id) : null;
    if (barberId && !db.prepare('SELECT 1 FROM barbers WHERE id = ?').get(barberId)) throw new HttpError(422, 'Barbeiro inválido.');
    const reason = cleanName(b.reason).slice(0, 120);
    const info = db.prepare('INSERT INTO blocks (barber_id, date, start_min, end_min, reason) VALUES (?,?,?,?,?)').run(barberId, b.date, start, end, reason);
    // Avisa sobre agendamentos já existentes dentro do bloqueio (não são cancelados automaticamente).
    const conflicts = db.prepare("SELECT * FROM appointments WHERE date = ? AND status != 'cancelado' AND start_min < ? AND end_min > ? AND (? IS NULL OR barber_id = ?)")
      .all(b.date, end, start, barberId, barberId).map(adminView);
    return { block: db.prepare('SELECT * FROM blocks WHERE id = ?').get(Number(info.lastInsertRowid)), conflicts };
  });
  route('DELETE', '/api/admin/blocks/(\\d+)', (req, res, url, m) => {
    requireAdmin(req);
    const r = db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(m[1]));
    if (!r.changes) throw new HttpError(404, 'Bloqueio não encontrado.');
    return { ok: true };
  });

  // ---------- arquivos estáticos ----------
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/admin') { res.writeHead(301, { Location: '/admin/' }); return res.end(); }
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Não encontrado.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Não encontrado.');
    const ext = path.extname(file).toLowerCase();
    const isAsset = /\.(woff2|png|jpg|jpeg|webp|svg|ico)$/.test(ext);
    send(res, 200, fs.readFileSync(file), {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const out = await r.handler(req, res, url, m);
          return send(res, 200, out);
        }
        throw new HttpError(404, 'Rota não encontrada.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) {
        if (req.url.startsWith('/api/')) return send(res, e.status, { error: e.message, ...e.extra });
        return send(res, e.status, `<!doctype html><meta charset="utf-8"><title>${e.status}</title><body style="background:#0a0a0a;color:#eee;font-family:sans-serif;padding:3rem"><h1>${e.status}</h1><p>${e.message}</p><p><a style="color:#d4a62a" href="/">Voltar ao início</a></p>`, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      console.error(e);
      send(res, 500, { error: 'Erro interno. Tente novamente em instantes.' });
    }
  });
}

function bookingView(db, a) {
  return {
    id: a.id, service_name: a.service_name, price_cents: a.price_cents,
    customer_name: a.customer_name, date: a.date, start: fmtMin(a.start_min), end: fmtMin(a.end_min),
    status: a.status,
    barber_name: db.prepare('SELECT name FROM barbers WHERE id = ?').get(a.barber_id)?.name,
  };
}
