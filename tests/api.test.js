import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp, normalizePhone } from '../server/app.js';
import { nowInSP, addDays, weekdayOf } from '../server/availability.js';

let server, base, cookie, setupCode;

async function api(method, path, body, { auth = true, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, res };
}

const nextWeekday = (wd, minDaysAhead = 1) => {
  let d = addDays(nowInSP().date, minDaysAhead);
  while (weekdayOf(d) !== wd) d = addDays(d, 1);
  return d;
};
let keyN = 0;
const key = () => `test-key-${String(++keyN).padStart(6, '0')}-abcdefghij`;
const payload = (over = {}) => ({
  request_key: key(), name: 'Cliente Teste', phone: '(11) 91234-5678', consent: true,
  service_id: 1, barber_id: 1, ...over,
});

before(async () => {
  const db = openDb(':memory:');
  server = createApp(db, { bookingLimit: 1000, onSetupCode: (c) => { setupCode = c; } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('serviços e preços iniciais estão corretos e sem duração inventada', async () => {
  const { json } = await api('GET', '/api/public', null, { auth: false });
  assert.equal(json.services.length, 11);
  const by = Object.fromEntries(json.services.map((s) => [s.name, s]));
  assert.equal(by['Corte'].price_cents, 4000);
  assert.equal(by['Corte + platinado'].price_cents, 14000);
  assert.equal(by['Progressiva'].price_from, true);
  assert.equal(by['Limpeza de pele'].price_cents, 1500);
  assert.ok(json.services.every((s) => s.duration_min === null && !s.bookable));
});

test('serviço sem duração não libera horários nem aceita reserva', async () => {
  const date = nextWeekday(2);
  const a = await api('GET', `/api/availability?service=1&barber=1&date=${date}`, null, { auth: false });
  assert.equal(a.json.slots.length, 0);
  assert.equal(a.json.reason, 'servico_sem_duracao');
  const b = await api('POST', '/api/bookings', payload({ date, start_min: 600 }), { auth: false });
  assert.equal(b.status, 409);
});

test('painel admin: rotas protegidas e criação do primeiro admin com código', async () => {
  for (const p of ['/api/admin/appointments', '/api/admin/services', '/api/admin/hours', '/api/admin/blocks']) {
    assert.equal((await api('GET', p, null, { auth: false })).status, 401, p);
  }
  assert.equal((await api('PATCH', '/api/admin/services/1', { price_cents: 1 }, { auth: false })).status, 401);
  const bad = await api('POST', '/api/admin/setup', { code: 'errado', email: 'a@b.com', password: 'senhaforte123' }, { auth: false });
  assert.equal(bad.status, 403);
  const weak = await api('POST', '/api/admin/setup', { code: setupCode, email: 'dono@rl.com', password: 'curta' }, { auth: false });
  assert.equal(weak.status, 422);
  const ok = await api('POST', '/api/admin/setup', { code: setupCode, email: 'dono@rl.com', password: 'senhaforte123' }, { auth: false });
  assert.equal(ok.status, 200);
  const again = await api('POST', '/api/admin/setup', { code: setupCode, email: 'x@rl.com', password: 'senhaforte123' }, { auth: false });
  assert.equal(again.status, 409);
  const wrong = await api('POST', '/api/admin/login', { email: 'dono@rl.com', password: 'senhaerrada!!' }, { auth: false });
  assert.equal(wrong.status, 401);
  const login = await api('POST', '/api/admin/login', { email: 'dono@rl.com', password: 'senhaforte123' }, { auth: false });
  assert.equal(login.status, 200);
  const sc = login.res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  assert.equal((await api('GET', '/api/admin/services')).status, 200);
});

test('admin exige JSON (proteção contra formulários cross-site)', async () => {
  const r = await fetch(base + '/api/admin/services/1', { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"price_cents":1}' });
  assert.equal(r.status, 415);
});

test('admin configura duração e preço do serviço', async () => {
  const bad = await api('PATCH', '/api/admin/services/1', { duration_min: 2 });
  assert.equal(bad.status, 422);
  const r = await api('PATCH', '/api/admin/services/1', { duration_min: 40, price_cents: 4500 });
  assert.equal(r.status, 200);
  assert.equal(r.json.service.duration_min, 40);
  assert.equal(r.json.service.price_cents, 4500);
  await api('PATCH', '/api/admin/services/1', { price_cents: 4000 });
  await api('PATCH', '/api/admin/services/2', { duration_min: 30 });
});

test('disponibilidade respeita dias e horários de funcionamento', async () => {
  const tue = nextWeekday(2);
  const r = await api('GET', `/api/availability?service=1&barber=1&date=${tue}`, null, { auth: false });
  const times = r.json.slots.map((s) => s.time);
  assert.equal(times[0], '09:00');
  assert.equal(times.at(-1), '19:15'); // 19:15 + 40min = 19:55 <= 20:00; 19:30 já estoura
  assert.ok(!times.includes('19:30'));
  for (const wd of [0, 1]) {
    const d = nextWeekday(wd);
    const c = await api('GET', `/api/availability?service=1&barber=1&date=${d}`, null, { auth: false });
    assert.equal(c.json.reason, 'fechado'); assert.equal(c.json.slots.length, 0);
  }
  const past = await api('GET', `/api/availability?service=1&barber=1&date=${addDays(nowInSP().date, -3)}`, null, { auth: false });
  assert.equal(past.json.reason, 'data_passada');
});

test('validações de formulário', async () => {
  const date = nextWeekday(3);
  const base_ = { date, start_min: 600 };
  assert.equal((await api('POST', '/api/bookings', payload({ ...base_, name: 'A' }), { auth: false })).status, 422);
  assert.equal((await api('POST', '/api/bookings', payload({ ...base_, phone: '123' }), { auth: false })).status, 422);
  assert.equal((await api('POST', '/api/bookings', payload({ ...base_, consent: false }), { auth: false })).status, 422);
  assert.equal((await api('POST', '/api/bookings', { ...payload(base_), request_key: 'curta' }, { auth: false })).status, 400);
  assert.equal(normalizePhone('+55 (11) 98999-0929'), '11989990929');
  assert.equal(normalizePhone('(11) 3333-4444'), '1133334444');
  assert.equal(normalizePhone('(11) 81234-5678'), null);
});

test('reserva fora do horário, em dia fechado ou no passado é rejeitada', async () => {
  const tue = nextWeekday(2);
  assert.equal((await api('POST', '/api/bookings', payload({ date: tue, start_min: 8 * 60 }), { auth: false })).status, 409);
  assert.equal((await api('POST', '/api/bookings', payload({ date: tue, start_min: 19 * 60 + 30 }), { auth: false })).status, 409);
  assert.equal((await api('POST', '/api/bookings', payload({ date: tue, start_min: 601 }), { auth: false })).status, 409); // fora da grade de 15 min
  assert.equal((await api('POST', '/api/bookings', payload({ date: nextWeekday(1), start_min: 600 }), { auth: false })).status, 409);
  assert.equal((await api('POST', '/api/bookings', payload({ date: addDays(nowInSP().date, -7), start_min: 600 }), { auth: false })).status, 409);
});

test('reserva válida bloqueia o horário e impede sobreposição', async () => {
  const date = nextWeekday(4);
  const ok = await api('POST', '/api/bookings', payload({ date, start_min: 600 }), { auth: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.booking.start, '10:00'); assert.equal(ok.json.booking.end, '10:40');
  assert.equal(ok.json.booking.status, 'pendente');
  const av = await api('GET', `/api/availability?service=1&barber=1&date=${date}`, null, { auth: false });
  const times = av.json.slots.map((s) => s.time);
  for (const t of ['09:30', '09:45', '10:00', '10:15', '10:30']) assert.ok(!times.includes(t), t); // sobrepõem 10:00–10:40
  assert.ok(times.includes('09:15') && times.includes('10:45'));
  // outro serviço (30 min) também não pode sobrepor
  const clash = await api('POST', '/api/bookings', payload({ date, start_min: 630, service_id: 2 }), { auth: false });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, 'slot_taken');
  const adj = await api('POST', '/api/bookings', payload({ date, start_min: 645, service_id: 2 }), { auth: false });
  assert.equal(adj.status, 200);
});

test('cliques repetidos (mesma chave) não duplicam a reserva', async () => {
  const date = nextWeekday(5);
  const p = payload({ date, start_min: 720 });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => api('POST', '/api/bookings', p, { auth: false })));
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(a.json.booking.id, b.json.booking.id); assert.equal(b.json.booking.id, c.json.booking.id);
  const list = await api('GET', `/api/admin/appointments?date=${date}`);
  assert.equal(list.json.appointments.filter((x) => x.start_min === 720).length, 1);
});

test('concorrência: só uma de várias reservas simultâneas no mesmo horário vence', async () => {
  const date = nextWeekday(6);
  const results = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/api/bookings', payload({ date, start_min: 900 }), { auth: false })));
  const okCount = results.filter((r) => r.status === 200).length;
  assert.equal(okCount, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 11);
});

test('cancelar libera o horário; reativar só se continuar livre', async () => {
  const date = nextWeekday(2, 8);
  const a = await api('POST', '/api/bookings', payload({ date, start_min: 780 }), { auth: false });
  const id = a.json.booking.id;
  assert.equal((await api('PATCH', `/api/admin/appointments/${id}`, { status: 'confirmado' })).status, 200);
  assert.equal((await api('PATCH', `/api/admin/appointments/${id}`, { status: 'xyz' })).status, 422);
  assert.equal((await api('PATCH', `/api/admin/appointments/${id}`, { status: 'cancelado' })).status, 200);
  const canceled = await api('GET', '/api/admin/appointments?mode=canceled');
  assert.ok(canceled.json.appointments.some((x) => x.id === id));
  const av = await api('GET', `/api/availability?service=1&barber=1&date=${date}`, null, { auth: false });
  assert.ok(av.json.slots.some((s) => s.time === '13:00'));
  const again = await api('POST', '/api/bookings', payload({ date, start_min: 780 }), { auth: false });
  assert.equal(again.status, 200);
  const reactivate = await api('PATCH', `/api/admin/appointments/${id}`, { status: 'confirmado' });
  assert.equal(reactivate.status, 409);
  await api('PATCH', `/api/admin/appointments/${again.json.booking.id}`, { status: 'concluido' });
});

test('bloqueios de agenda removem horários e avisam sobre conflitos', async () => {
  const date = nextWeekday(3, 9);
  await api('POST', '/api/bookings', payload({ date, start_min: 840 }), { auth: false });
  const blk = await api('POST', '/api/admin/blocks', { date, start: '14:00', end: '16:00', reason: 'Médico' });
  assert.equal(blk.status, 200);
  assert.equal(blk.json.conflicts.length, 1);
  const av = await api('GET', `/api/availability?service=1&barber=1&date=${date}`, null, { auth: false });
  const times = av.json.slots.map((s) => s.time);
  assert.ok(!times.includes('14:00') && !times.includes('15:15') && times.includes('16:00') && times.includes('13:15'));
  assert.equal((await api('POST', '/api/bookings', payload({ date, start_min: 900 }), { auth: false })).status, 409);
  await api('DELETE', `/api/admin/blocks/${blk.json.block.id}`);
  const day = await api('POST', '/api/admin/blocks', { date: nextWeekday(4, 9), all_day: true, reason: 'Folga' });
  const av2 = await api('GET', `/api/availability?service=1&barber=1&date=${nextWeekday(4, 9)}`, null, { auth: false });
  assert.equal(av2.json.slots.length, 0);
  assert.equal(day.status, 200);
});

test('horário de funcionamento e intervalo entre atendimentos são configuráveis', async () => {
  const cur = (await api('GET', '/api/admin/hours')).json;
  const hours = cur.hours.map((h) => ({ weekday: h.weekday, open: !!h.open, start: '09:00', end: '20:00' }));
  const bad = await api('PUT', '/api/admin/hours', { hours: hours.map((h) => ({ ...h, start: '21:00' })) });
  assert.equal(bad.status, 422);
  const r = await api('PUT', '/api/admin/hours', { hours, settings: { buffer_min: 10 } });
  assert.equal(r.status, 200);
  const date = nextWeekday(2, 15);
  await api('POST', '/api/bookings', payload({ date, start_min: 600 }), { auth: false }); // 10:00–10:40 (+10 de intervalo)
  const times = (await api('GET', `/api/availability?service=1&barber=1&date=${date}`, null, { auth: false })).json.slots.map((s) => s.time);
  assert.ok(!times.includes('10:45') && times.includes('10:55') === false); // grade de 15min: 11:00 é o próximo
  assert.ok(times.includes('11:00'));
  await api('PUT', '/api/admin/hours', { hours, settings: { buffer_min: 0 } });
});

test('barbeiros: cadastrar, impedir desativar o último, agenda independente', async () => {
  const nb = await api('POST', '/api/admin/barbers', { name: 'Segundo Barbeiro' });
  assert.equal(nb.status, 200);
  const date = nextWeekday(5, 10);
  await api('POST', '/api/bookings', payload({ date, start_min: 600, barber_id: 1 }), { auth: false });
  const other = await api('POST', '/api/bookings', payload({ date, start_min: 600, barber_id: nb.json.barber.id }), { auth: false });
  assert.equal(other.status, 200); // barbeiros diferentes podem ter o mesmo horário
  assert.equal((await api('PATCH', `/api/admin/barbers/${nb.json.barber.id}`, { active: false })).status, 200);
  assert.equal((await api('PATCH', '/api/admin/barbers/1', { active: false })).status, 409);
});

test('logout encerra a sessão; arquivos estáticos e path traversal', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  const trav = await fetch(base + '/..%2Fserver%2Fdb.js');
  assert.equal(trav.status, 404);
  assert.equal((await fetch(base + '/server/db.js')).status, 404);
  assert.equal((await api('POST', '/api/admin/logout', {})).status, 200);
  assert.equal((await api('GET', '/api/admin/services')).status, 401);
});
