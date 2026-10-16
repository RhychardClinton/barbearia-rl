const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const dateShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try { res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('Sem conexão com o servidor.'), { network: true }); }
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erro inesperado.'), { status: res.status, data });
  return data;
}

let toastT;
function toast(text, bad = false) {
  $('.toast')?.remove();
  const t = h('div', { class: `toast ${bad ? 'bad' : ''}`, role: 'status' }, text);
  document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4500);
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) {
    if (e.status === 401) return start();
    toast(e.message, true);
  }
};

// ---------- login / configuração ----------
function authView(setup) {
  const email = h('input', { id: 'a-email', type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'a-pass', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? '10' : '1' });
  const code = setup ? h('input', { id: 'a-code', type: 'text', autocomplete: 'off', required: true }) : null;
  const err = h('div', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'a-card login', novalidate: true },
    h('img', { src: '/img/logo-raw.png', alt: 'Barbearia RL', width: '190', height: '104' }),
    h('h2', { class: 'bk-title' }, setup ? 'Criar administrador' : 'Entrar no painel'),
    setup ? h('p', { class: 'fine' }, 'Primeiro acesso. Use o código de configuração mostrado no terminal do servidor e defina e-mail e senha (mínimo de 10 caracteres).') : null,
    code ? h('div', { class: 'field' }, h('label', { for: 'a-code' }, 'Código de configuração'), code) : null,
    h('div', { class: 'field' }, h('label', { for: 'a-email' }, 'E-mail'), email),
    h('div', { class: 'field' }, h('label', { for: 'a-pass' }, 'Senha'), pass),
    err,
    h('button', { class: 'btn btn-gold', type: 'submit' }, setup ? 'Criar e entrar' : 'Entrar'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      if (setup) await api('/api/admin/setup', { method: 'POST', body: { code: code.value.trim(), email: email.value, password: pass.value } });
      await api('/api/admin/login', { method: 'POST', body: { email: email.value, password: pass.value } });
      start();
    } catch (ex) { err.textContent = ex.message; }
  });
  app.replaceChildren(form);
  (code || email).focus();
}

// ---------- shell ----------
const TABS = [['agenda', 'Agenda'], ['servicos', 'Serviços'], ['horarios', 'Horários e bloqueios'], ['barbeiros', 'Barbeiros']];
let tab = 'agenda';

function shell(content) {
  const bar = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; views[id](); } }, label)));
  app.replaceChildren(h('div', { class: 'a-wrap' },
    h('div', { class: 'a-top' },
      h('a', { href: '/', 'aria-label': 'Ver site' }, h('img', { src: '/img/logo-raw.png', alt: 'Barbearia RL', width: '190', height: '104' })),
      h('div', { class: 'who' }, h('a', { class: 'link', href: '/' }, 'Ver site'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); start(); } }, 'Sair'))),
    bar, h('section', { class: 'panel' }, content)));
}

// ---------- agenda ----------
let agenda = { mode: 'day', date: null };
async function viewAgenda() {
  if (!agenda.date) agenda.date = (await fetch('/api/public').then((r) => r.json())).today;
  const holder = h('div', {}, h('p', { class: 'state' }, 'Carregando…'));
  const dateI = h('input', { id: 'ag-date', type: 'date', value: agenda.date });
  dateI.addEventListener('change', () => { if (dateI.value) { agenda.date = dateI.value; agenda.mode = 'day'; viewAgenda(); } });
  const seg = (m, label) => h('button', { type: 'button', 'aria-pressed': String(agenda.mode === m), onclick: () => { agenda.mode = m; viewAgenda(); } }, label);
  shell([
    h('h2', {}, 'Agenda'),
    h('div', { class: 'toolbar' },
      h('div', { class: 'seg' }, seg('day', 'Por dia'), seg('upcoming', 'Próximos'), seg('canceled', 'Cancelados')),
      agenda.mode === 'day' ? h('div', { class: 'field' }, h('label', { for: 'ag-date' }, 'Data'), dateI) : null),
    holder]);
  const q = agenda.mode === 'day' ? `date=${agenda.date}` : agenda.mode === 'upcoming' ? 'mode=upcoming' : 'mode=canceled';
  try {
    const { appointments } = await api(`/api/admin/appointments?${q}`);
    holder.replaceChildren(listAppointments(appointments));
  } catch (e) { if (e.status === 401) return start(); holder.replaceChildren(h('p', { class: 'notice bad' }, e.message)); }
}

function listAppointments(items) {
  if (!items.length) return h('p', { class: 'state' }, agenda.mode === 'day' ? 'Nenhum agendamento neste dia.' : 'Nada por aqui.');
  const ul = h('ul', { class: 'appts' });
  for (const a of items) {
    const set = (status) => guard(async () => { await api(`/api/admin/appointments/${a.id}`, { method: 'PATCH', body: { status } }); toast('Status atualizado.'); viewAgenda(); });
    const wa = `https://wa.me/55${a.customer_phone}?text=${encodeURIComponent(`Olá, ${a.customer_name}! Aqui é da Barbearia RL sobre seu horário: ${a.service_name}, ${dateLong(a.date)} às ${a.start}.`)}`;
    const acts = [];
    if (a.status === 'pendente') acts.push(h('button', { class: 'btn btn-gold btn-sm', type: 'button', onclick: set('confirmado') }, 'Confirmar'));
    if (a.status === 'pendente' || a.status === 'confirmado') acts.push(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: set('concluido') }, 'Concluir'));
    if (a.status !== 'cancelado' && a.status !== 'concluido') acts.push(h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: () => { if (confirm(`Cancelar o horário de ${a.customer_name}?`)) set('cancelado')(); } }, 'Cancelar'));
    if (a.status === 'cancelado') acts.push(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: set('pendente') }, 'Reativar'));
    acts.push(h('a', { class: 'btn btn-ghost btn-sm', href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp'));
    ul.append(h('li', { class: 'a-card appt' },
      h('time', {}, a.start, h('small', {}, agenda.mode === 'day' ? `até ${a.end}` : dateShort(a.date))),
      h('div', {}, h('h3', {}, a.customer_name, h('span', { class: `badge ${a.status}` }, a.status)),
        h('div', { class: 'meta' }, `${a.service_name} · ${brl(a.price_cents)} · ${a.customer_phone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')}`)),
      h('div', { class: 'actions' }, acts)));
  }
  return ul;
}

// ---------- serviços ----------
async function viewServicos() {
  const { services } = await api('/api/admin/services');
  const rows = services.map((s) => {
    const name = h('input', { type: 'text', value: s.name, 'aria-label': 'Nome', maxlength: '80' });
    const price = h('input', { type: 'text', inputmode: 'decimal', value: (s.price_cents / 100).toFixed(2).replace('.', ','), 'aria-label': 'Preço em reais' });
    const from = h('input', { type: 'checkbox', 'aria-label': 'Preço inicial (a partir de)' }); from.checked = !!s.price_from;
    const dur = h('input', { type: 'number', min: '5', max: '720', step: '5', value: s.duration_min ?? '', placeholder: 'definir', 'aria-label': 'Duração em minutos' });
    const active = h('input', { type: 'checkbox', 'aria-label': 'Ativo' }); active.checked = !!s.active;
    const save = guard(async () => {
      const cents = Math.round(Number(price.value.replace(/\./g, '').replace(',', '.')) * 100);
      await api(`/api/admin/services/${s.id}`, { method: 'PATCH', body: { name: name.value, price_cents: cents, price_from: from.checked, duration_min: dur.value === '' ? null : Number(dur.value), active: active.checked } });
      toast(`“${name.value}” salvo.`); viewServicos();
    });
    return h('tr', {}, h('td', {}, name), h('td', {}, price), h('td', {}, from), h('td', {}, dur), h('td', {}, active),
      h('td', {}, s.duration_min ? h('span', { class: 'badge confirmado' }, 'online') : h('span', { class: 'badge pendente' }, 'sem duração')),
      h('td', {}, h('button', { class: 'btn btn-gold btn-sm', type: 'button', onclick: save }, 'Salvar')));
  });
  const nName = h('input', { id: 'n-name', type: 'text', maxlength: '80' });
  const nPrice = h('input', { id: 'n-price', type: 'text', inputmode: 'decimal', placeholder: '0,00' });
  const nDur = h('input', { id: 'n-dur', type: 'number', min: '5', max: '720', step: '5' });
  shell([h('h2', {}, 'Serviços e preços'),
    h('p', { class: 'notice' }, 'Um serviço só aparece para agendamento online depois que você definir a duração (em minutos). Sem duração, o cliente é orientado a chamar no WhatsApp.'),
    h('div', { class: 'a-card table-wrap' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Serviço', 'Preço (R$)', 'A partir de', 'Duração (min)', 'Ativo', 'Agenda', ''].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, rows))),
    h('h2', { class: 'sub-h' }, 'Novo serviço'),
    h('div', { class: 'a-card grid-form' },
      h('div', { class: 'field' }, h('label', { for: 'n-name' }, 'Nome'), nName),
      h('div', { class: 'field' }, h('label', { for: 'n-price' }, 'Preço (R$)'), nPrice),
      h('div', { class: 'field' }, h('label', { for: 'n-dur' }, 'Duração (min)'), nDur),
      h('button', { class: 'btn btn-gold', type: 'button', onclick: guard(async () => {
        const cents = Math.round(Number(nPrice.value.replace(/\./g, '').replace(',', '.')) * 100);
        await api('/api/admin/services', { method: 'POST', body: { name: nName.value, price_cents: cents, duration_min: nDur.value ? Number(nDur.value) : null } });
        toast('Serviço criado.'); viewServicos();
      }) }, 'Adicionar'))]);
}

// ---------- horários e bloqueios ----------
async function viewHorarios() {
  const [{ hours, settings }, { blocks }, { barbers }] = await Promise.all([api('/api/admin/hours'), api('/api/admin/blocks'), api('/api/admin/barbers')]);
  const order = [2, 3, 4, 5, 6, 0, 1];
  const inputs = {};
  const rows = order.map((d) => {
    const x = hours.find((y) => y.weekday === d);
    const open = h('input', { type: 'checkbox', 'aria-label': `${DAYS[d]} aberto` }); open.checked = !!x.open;
    const s = h('input', { type: 'time', value: fmtMin(x.start_min), 'aria-label': 'Abre' });
    const e = h('input', { type: 'time', value: fmtMin(x.end_min), 'aria-label': 'Fecha' });
    inputs[d] = { open, s, e };
    return h('tr', {}, h('th', { scope: 'row' }, DAYS[d]), h('td', {}, open), h('td', {}, s), h('td', {}, e));
  });
  const num = (id, v, min, max) => h('input', { id, type: 'number', value: v, min, max });
  const step = num('s-step', settings.slot_step_min, 5, 120), buf = num('s-buf', settings.buffer_min, 0, 120), ahead = num('s-ahead', settings.max_days_ahead, 1, 365), notice = num('s-notice', settings.min_notice_min, 0, 1440);
  const saveHours = guard(async () => {
    await api('/api/admin/hours', { method: 'PUT', body: {
      hours: order.map((d) => ({ weekday: d, open: inputs[d].open.checked, start: inputs[d].s.value, end: inputs[d].e.value })),
      settings: { slot_step_min: Number(step.value), buffer_min: Number(buf.value), max_days_ahead: Number(ahead.value), min_notice_min: Number(notice.value) } } });
    toast('Horários salvos.');
  });

  const bDate = h('input', { id: 'b-date', type: 'date' });
  const bAll = h('input', { id: 'b-all', type: 'checkbox' }); bAll.checked = true;
  const bS = h('input', { id: 'b-s', type: 'time', value: '12:00' }), bE = h('input', { id: 'b-e', type: 'time', value: '14:00' });
  const bWho = h('select', { id: 'b-who' }, h('option', { value: '' }, 'Todos os barbeiros'), barbers.filter((b) => b.active).map((b) => h('option', { value: b.id }, b.name)));
  const bWhy = h('input', { id: 'b-why', type: 'text', maxlength: '120', placeholder: 'Ex.: folga, consulta' });
  const addBlock = guard(async () => {
    const r = await api('/api/admin/blocks', { method: 'POST', body: { date: bDate.value, all_day: bAll.checked, start: bS.value, end: bE.value, barber_id: bWho.value || null, reason: bWhy.value } });
    toast(r.conflicts.length ? `Bloqueio criado. Atenção: ${r.conflicts.length} agendamento(s) já existem nesse período — cancele ou remarque manualmente.` : 'Bloqueio criado.', !!r.conflicts.length);
    viewHorarios();
  });
  const blockRows = blocks.map((b) => h('tr', {}, h('td', {}, dateShort(b.date)),
    h('td', {}, b.end_min - b.start_min >= 1440 ? 'Dia inteiro' : `${fmtMin(b.start_min)} – ${fmtMin(b.end_min)}`),
    h('td', {}, b.barber_id ? (barbers.find((x) => x.id === b.barber_id)?.name || '—') : 'Todos'), h('td', {}, b.reason || '—'),
    h('td', {}, h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: guard(async () => { await api(`/api/admin/blocks/${b.id}`, { method: 'DELETE' }); toast('Bloqueio removido.'); viewHorarios(); }) }, 'Remover'))));

  shell([h('h2', {}, 'Horário de funcionamento'),
    h('div', { class: 'a-card table-wrap' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Dia', 'Aberto', 'Abre', 'Fecha'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows))),
    h('div', { class: 'a-card grid-form', style: false },
      h('div', { class: 'field' }, h('label', { for: 's-step' }, 'Intervalo entre horários (min)'), step),
      h('div', { class: 'field' }, h('label', { for: 's-buf' }, 'Folga entre atendimentos (min)'), buf),
      h('div', { class: 'field' }, h('label', { for: 's-notice' }, 'Antecedência mínima (min)'), notice),
      h('div', { class: 'field' }, h('label', { for: 's-ahead' }, 'Agenda aberta por (dias)'), ahead),
      h('button', { class: 'btn btn-gold', type: 'button', onclick: saveHours }, 'Salvar horários')),
    h('h2', { class: 'sub-h' }, 'Folgas e bloqueios'),
    h('div', { class: 'a-card grid-form' },
      h('div', { class: 'field' }, h('label', { for: 'b-date' }, 'Data'), bDate),
      h('div', { class: 'field' }, h('label', { class: 'check', for: 'b-all' }, bAll, 'Dia inteiro')),
      h('div', { class: 'field' }, h('label', { for: 'b-s' }, 'Das'), bS), h('div', { class: 'field' }, h('label', { for: 'b-e' }, 'Até'), bE),
      h('div', { class: 'field' }, h('label', { for: 'b-who' }, 'Barbeiro'), bWho),
      h('div', { class: 'field' }, h('label', { for: 'b-why' }, 'Motivo'), bWhy),
      h('button', { class: 'btn btn-gold', type: 'button', onclick: addBlock }, 'Bloquear')),
    blocks.length ? h('div', { class: 'a-card table-wrap' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Data', 'Período', 'Barbeiro', 'Motivo', ''].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, blockRows))) : h('p', { class: 'fine' }, 'Nenhum bloqueio futuro.')]);
}

// ---------- barbeiros ----------
async function viewBarbeiros() {
  const { barbers } = await api('/api/admin/barbers');
  const rows = barbers.map((b) => {
    const name = h('input', { type: 'text', value: b.name, 'aria-label': 'Nome', maxlength: '60' });
    return h('tr', {}, h('td', {}, name), h('td', {}, b.active ? h('span', { class: 'badge confirmado' }, 'ativo') : h('span', { class: 'badge cancelado' }, 'inativo')),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-gold btn-sm', type: 'button', onclick: guard(async () => { await api(`/api/admin/barbers/${b.id}`, { method: 'PATCH', body: { name: name.value } }); toast('Salvo.'); viewBarbeiros(); }) }, 'Salvar nome'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: guard(async () => { await api(`/api/admin/barbers/${b.id}`, { method: 'PATCH', body: { active: !b.active } }); viewBarbeiros(); }) }, b.active ? 'Desativar' : 'Ativar')));
  });
  const nName = h('input', { id: 'bn', type: 'text', maxlength: '60' });
  shell([h('h2', {}, 'Barbeiros'),
    h('p', { class: 'notice' }, 'Com um único barbeiro ativo, o cliente não precisa escolher. Com dois ou mais, o passo de escolha aparece no agendamento.'),
    h('div', { class: 'a-card table-wrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Nome', 'Situação', ''].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows))),
    h('div', { class: 'a-card grid-form' }, h('div', { class: 'field' }, h('label', { for: 'bn' }, 'Novo barbeiro'), nName),
      h('button', { class: 'btn btn-gold', type: 'button', onclick: guard(async () => { await api('/api/admin/barbers', { method: 'POST', body: { name: nName.value } }); toast('Barbeiro cadastrado.'); viewBarbeiros(); }) }, 'Adicionar'))]);
}

const views = {
  agenda: guard(viewAgenda), servicos: guard(viewServicos), horarios: guard(viewHorarios), barbeiros: guard(viewBarbeiros),
};

async function start() {
  try {
    const st = await api('/api/admin/status');
    if (st.setup_required) return authView(true);
    if (!st.authenticated) return authView(false);
    views[tab]();
  } catch (e) { app.replaceChildren(h('p', { class: 'notice bad' }, e.message)); }
}
start();
