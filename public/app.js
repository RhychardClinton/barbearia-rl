// Barbearia RL — site público e fluxo de agendamento.
const CONTACT = {
  // WhatsApp que recebe a mensagem pré-preenchida após o agendamento (somente dígitos, com 55).
  whatsapp: '5511989990929',
  whatsappLabel: '(11) 98999-0929',
};

const $ = (s, r = document) => r.querySelector(s);
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
const dateShort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const e = new Error('Sem conexão com o servidor. Verifique sua internet e tente de novo.');
    e.network = true;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* corpo vazio */ }
  if (!res.ok) {
    const e = new Error(data.error || 'Não foi possível concluir. Tente novamente.');
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

// ---------- página ----------
let PUBLIC = null;

function setupHeader() {
  const toggle = $('#menuToggle'), nav = $('#nav');
  const close = () => { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', 'Abrir menu'); };
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a, button')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#year').textContent = new Date().getFullYear();
}

async function loadGallery() {
  const ul = $('#gallery');
  let items = [];
  try { items = await (await fetch('/gallery.json')).json(); } catch { /* sem galeria */ }
  if (!items.length) {
    ul.append(h('li', { class: 'empty' }, 'Em breve: fotos reais dos cortes da Barbearia RL.'));
    return;
  }
  for (const it of items) ul.append(h('li', {}, h('img', { src: it.src, alt: it.alt, loading: 'lazy', decoding: 'async' })));
}

function renderServices() {
  const ul = $('#servicesList');
  ul.replaceChildren();
  for (const s of PUBLIC.services) {
    ul.append(h('li', { class: 'service reveal' },
      h('h3', {}, s.name),
      h('div', { class: 'service-row' },
        h('div', { class: 'price' }, s.price_from ? h('small', {}, 'a partir de') : null, brl(s.price_cents)),
        h('button', { class: 'btn btn-ghost', type: 'button', 'data-service': s.id }, 'Agendar'),
      )));
  }
  ul.addEventListener('click', (e) => {
    const b = e.target.closest('[data-service]');
    if (b) openBooking(Number(b.dataset.service));
  });
}

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function renderHours() {
  const hrs = PUBLIC.hours;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
  const rows = [];
  for (const d of [2, 3, 4, 5, 6, 0, 1]) {
    const x = hrs.find((y) => y.weekday === d);
    rows.push(h('tr', {}, h('th', { scope: 'row' }, DAY_NAMES[d]), h('td', {}, x.open ? `${fmt(x.start_min)} às ${fmt(x.end_min)}` : 'Fechado')));
  }
  $('#hoursTable tbody').replaceChildren(...rows);
}

function setupReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.12 });
  els.forEach((e) => io.observe(e));
}

// ---------- agendamento ----------
const dlg = $('#bookingDialog');
const bk = {};
const body = $('#bkBody'), foot = $('#bkFoot');

function resetBooking(serviceId) {
  Object.keys(bk).forEach((k) => delete bk[k]);
  Object.assign(bk, {
    step: 'servico', service: null, barber: PUBLIC.barbers.length === 1 ? PUBLIC.barbers[0] : null,
    date: null, slot: null, name: '', phone: '', consent: false, key: null, submitting: false,
    month: null, days: null, slots: null, slotsReason: null, notice: null, errors: {},
  });
  if (serviceId) {
    const s = PUBLIC.services.find((x) => x.id === serviceId);
    if (s && s.bookable) bk.service = s;
  }
}

function steps() {
  const list = ['servico'];
  if (PUBLIC.barbers.length > 1) list.push('barbeiro');
  list.push('data', 'dados', 'resumo');
  return list;
}

async function openBooking(serviceId) {
  if (!PUBLIC) { window.open(`https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent('Olá! Gostaria de agendar um horário na Barbearia RL.')}`, '_blank', 'noopener'); return; }
  resetBooking(serviceId);
  if (bk.service) bk.step = nextStep('servico');
  dlg.showModal();
  render();
  if (bk.step === 'data') loadDays();
}

function nextStep(cur) { const s = steps(); return s[Math.min(s.indexOf(cur) + 1, s.length - 1)]; }
function prevStep(cur) { const s = steps(); return s[Math.max(s.indexOf(cur) - 1, 0)]; }

function go(step) {
  bk.step = step; bk.notice = null;
  render();
  if (step === 'data' && !bk.days) loadDays();
  body.scrollTop = 0;
}

function waLink(text) { return `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent(text)}`; }

function render() {
  body.replaceChildren(); foot.replaceChildren();
  const list = steps();
  const idx = list.indexOf(bk.step);
  const done = bk.step === 'sucesso';
  $('#bkStepLabel').textContent = done ? 'Solicitação enviada' : `Passo ${idx + 1} de ${list.length}`;
  $('#bkBar').style.width = `${done ? 100 : ((idx + 1) / list.length) * 100}%`;
  if (bk.notice) body.append(h('div', { class: `notice ${bk.notice.bad ? 'bad' : ''}`, role: 'alert' }, bk.notice.text));
  ({ servico: stepServico, barbeiro: stepBarbeiro, data: stepData, dados: stepDados, resumo: stepResumo, sucesso: stepSucesso })[bk.step]();
}

const backBtn = () => h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go(prevStep(bk.step)) }, 'Voltar');
const nextBtn = (label, onclick, disabled) => h('button', { class: 'btn btn-gold', type: 'button', onclick, disabled }, label);

function stepServico() {
  const bookable = PUBLIC.services.filter((s) => s.bookable);
  body.append(h('p', { class: 'bk-title' }, 'Qual serviço você quer?'));
  if (!bookable.length) {
    body.append(h('div', { class: 'notice' }, 'O agendamento online ainda está sendo liberado. Enquanto isso, chame a barbearia no WhatsApp para marcar seu horário.'),
      h('a', { class: 'btn btn-gold', href: waLink('Olá! Gostaria de agendar um horário na Barbearia RL.'), target: '_blank', rel: 'noopener' }, `Chamar no WhatsApp ${CONTACT.whatsappLabel}`));
    return;
  }
  const ul = h('ul', { class: 'opt-list' });
  for (const s of PUBLIC.services) {
    ul.append(h('li', {}, h('button', {
      class: 'opt', type: 'button', 'aria-pressed': String(bk.service?.id === s.id), disabled: !s.bookable,
      onclick: () => { bk.service = s; bk.days = null; bk.date = null; bk.slot = null; go(nextStep('servico')); },
    }, h('span', {}, s.name, h('small', {}, s.bookable ? `${s.duration_min} min${s.price_from ? ' · valor final conforme o procedimento' : ''}` : 'Agende pelo WhatsApp')),
    h('span', { class: 'p' }, (s.price_from ? 'a partir de ' : '') + brl(s.price_cents)))));
  }
  body.append(ul);
}

function stepBarbeiro() {
  body.append(h('p', { class: 'bk-title' }, 'Com qual barbeiro?'));
  const ul = h('ul', { class: 'opt-list' });
  for (const b of PUBLIC.barbers) {
    ul.append(h('li', {}, h('button', { class: 'opt', type: 'button', 'aria-pressed': String(bk.barber?.id === b.id),
      onclick: () => { bk.barber = b; bk.days = null; bk.date = null; bk.slot = null; go(nextStep('barbeiro')); } }, h('span', {}, b.name))));
  }
  body.append(ul);
  foot.append(backBtn());
}

async function loadDays() {
  bk.days = null; render();
  body.replaceChildren(h('div', { class: 'state' }, h('div', { class: 'spinner' }), 'Buscando datas disponíveis…'));
  try {
    const r = await api(`/api/availability/days?service=${bk.service.id}&barber=${bk.barber.id}`);
    bk.days = r.days;
    const first = Object.keys(r.days).find((d) => r.days[d]);
    bk.month = (bk.date || first || PUBLIC.today).slice(0, 7);
    bk.loadError = null;
  } catch (e) {
    bk.loadError = e.message;
  }
  if (bk.step === 'data') render();
}

async function pickDate(d) {
  bk.date = d; bk.slot = null; bk.slots = null; bk.slotsReason = null; render();
  try {
    const r = await api(`/api/availability?service=${bk.service.id}&barber=${bk.barber.id}&date=${d}`);
    bk.slots = r.slots; bk.slotsReason = r.reason; bk.slotsError = null;
  } catch (e) { bk.slotsError = e.message; bk.slots = []; }
  if (bk.step === 'data' && bk.date === d) render();
}

function stepData() {
  body.append(h('p', { class: 'bk-title' }, 'Escolha o dia e o horário'));
  foot.append(backBtn());
  if (bk.loadError) {
    body.append(h('div', { class: 'notice bad', role: 'alert' }, bk.loadError), h('button', { class: 'btn btn-ghost', type: 'button', onclick: loadDays }, 'Tentar novamente'));
    return;
  }
  if (!bk.days) { body.append(h('div', { class: 'state' }, h('div', { class: 'spinner' }), 'Buscando datas disponíveis…')); return; }
  const avail = Object.keys(bk.days).filter((d) => bk.days[d]);
  if (!avail.length) { body.append(h('div', { class: 'notice' }, 'Não há horários livres nos próximos dias para este serviço. Fale com a barbearia pelo WhatsApp.')); return; }

  const [y, m] = bk.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const monthRaw = first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(' de ', ' ');
  const monthLabel = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1);
  const keys = Object.keys(bk.days);
  const minM = keys[0].slice(0, 7), maxM = keys.at(-1).slice(0, 7);
  const shift = (n) => { const d = new Date(y, m - 1 + n, 1); bk.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; render(); };
  body.append(h('div', { class: 'cal-head' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mês anterior', disabled: bk.month <= minM, onclick: () => shift(-1) }, '‹'),
    h('strong', { 'aria-live': 'polite' }, monthLabel),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Próximo mês', disabled: bk.month >= maxM, onclick: () => shift(1) }, '›')));
  const cal = h('div', { class: 'cal', role: 'group', 'aria-label': 'Datas' });
  ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].forEach((l, i) => cal.append(h('div', { class: 'dow', 'aria-hidden': 'true' }, l)));
  for (let i = 0; i < first.getDay(); i++) cal.append(h('div', { class: 'x' }));
  const days = new Date(y, m, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const ds = `${bk.month}-${String(d).padStart(2, '0')}`;
    const ok = !!bk.days[ds];
    cal.append(h('button', { type: 'button', disabled: !ok, 'aria-pressed': String(bk.date === ds), 'aria-label': ok ? dateLong(ds) : `${dateLong(ds)} — indisponível`, onclick: () => pickDate(ds) }, String(d)));
  }
  body.append(cal);

  if (bk.date) {
    body.append(h('p', { class: 'sub' }, `Horários · ${dateLong(bk.date)}`));
    if (bk.slotsError) body.append(h('div', { class: 'notice bad', role: 'alert' }, bk.slotsError), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => pickDate(bk.date) }, 'Tentar novamente'));
    else if (!bk.slots) body.append(h('div', { class: 'state' }, h('div', { class: 'spinner' }), 'Carregando horários…'));
    else if (!bk.slots.length) body.append(h('div', { class: 'notice' }, 'Nenhum horário livre neste dia. Escolha outra data.'));
    else {
      const wrap = h('div', { class: 'slots', role: 'group', 'aria-label': 'Horários disponíveis' });
      for (const s of bk.slots) wrap.append(h('button', { class: 'slot', type: 'button', 'aria-pressed': String(bk.slot?.minutes === s.minutes), onclick: () => { bk.slot = s; render(); } }, s.time));
      body.append(wrap);
    }
  }
  foot.append(nextBtn('Continuar', () => go('dados'), !bk.slot));
}

function formatPhone(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
const phoneOk = (v) => { const d = v.replace(/\D/g, ''); return /^[1-9]{2}9?\d{8}$/.test(d) && (d.length === 10 || d[2] === '9'); };

function stepDados() {
  body.append(h('p', { class: 'bk-title' }, 'Seus dados'));
  const nameI = h('input', { id: 'f-name', type: 'text', autocomplete: 'name', maxlength: '80', value: bk.name, 'aria-describedby': 'e-name' });
  const phoneI = h('input', { id: 'f-phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', placeholder: '(11) 90000-0000', value: bk.phone, 'aria-describedby': 'e-phone' });
  const consentI = h('input', { id: 'f-consent', type: 'checkbox' }); consentI.checked = bk.consent;
  const eName = h('div', { class: 'err', id: 'e-name' }), ePhone = h('div', { class: 'err', id: 'e-phone' }), eConsent = h('div', { class: 'err', id: 'e-consent' });
  phoneI.addEventListener('input', () => { phoneI.value = formatPhone(phoneI.value); });
  const validate = () => {
    bk.name = nameI.value.replace(/\s+/g, ' ').trim(); bk.phone = phoneI.value; bk.consent = consentI.checked;
    const errs = {};
    if (bk.name.length < 2) errs.name = 'Informe seu nome.';
    if (!phoneOk(bk.phone)) errs.phone = 'Informe um WhatsApp válido com DDD.';
    if (!bk.consent) errs.consent = 'Para agendar, é preciso concordar com o uso dos dados.';
    eName.textContent = errs.name || ''; ePhone.textContent = errs.phone || ''; eConsent.textContent = errs.consent || '';
    nameI.setAttribute('aria-invalid', String(!!errs.name)); phoneI.setAttribute('aria-invalid', String(!!errs.phone));
    return !Object.keys(errs).length;
  };
  body.append(
    h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Nome'), nameI, eName),
    h('div', { class: 'field' }, h('label', { for: 'f-phone' }, 'WhatsApp (com DDD)'), phoneI, ePhone),
    h('div', { class: 'field' }, h('label', { class: 'check', for: 'f-consent' }, consentI,
      h('span', {}, 'Concordo que a Barbearia RL use meu nome e WhatsApp somente para gerenciar e confirmar este agendamento (LGPD).')), eConsent),
  );
  foot.append(backBtn(), nextBtn('Revisar', () => { if (validate()) { bk.key = null; go('resumo'); } }));
  if (bk.errors.name) eName.textContent = bk.errors.name;
  if (bk.errors.phone) ePhone.textContent = bk.errors.phone;
  setTimeout(() => nameI.focus(), 50);
}

function stepResumo() {
  body.append(h('p', { class: 'bk-title' }, 'Confira seu agendamento'));
  const row = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
  body.append(h('dl', { class: 'summary' },
    row('Serviço', bk.service.name),
    PUBLIC.barbers.length > 1 ? row('Barbeiro', bk.barber.name) : null,
    row('Data', dateLong(bk.date)),
    row('Horário', `${bk.slot.time} (${bk.service.duration_min} min)`),
    row('Valor', (bk.service.price_from ? 'a partir de ' : '') + brl(bk.service.price_cents)),
    row('Nome', bk.name),
    row('WhatsApp', bk.phone),
  ), h('p', { class: 'fine' }, 'Seu horário só é reservado depois que o servidor confirmar. A barbearia pode entrar em contato pelo WhatsApp para confirmar.'));
  const btn = nextBtn(bk.submitting ? 'Enviando…' : 'Confirmar agendamento', submit, bk.submitting);
  foot.append(h('button', { class: 'btn btn-ghost', type: 'button', disabled: bk.submitting, onclick: () => go('dados') }, 'Voltar'), btn);
}

async function submit() {
  if (bk.submitting) return;               // evita cliques repetidos
  bk.submitting = true;
  bk.key = bk.key || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-rlbooking`);
  bk.notice = null; render();
  try {
    const r = await api('/api/bookings', { method: 'POST', body: {
      request_key: bk.key, service_id: bk.service.id, barber_id: bk.barber.id, date: bk.date, start_min: bk.slot.minutes,
      name: bk.name, phone: bk.phone, consent: bk.consent,
    } });
    bk.booking = r.booking; bk.submitting = false;
    go('sucesso');
  } catch (e) {
    bk.submitting = false;
    if (e.status === 409) {                // horário tomado: volta para escolher outro
      bk.key = null; bk.slot = null; bk.days = null;
      bk.notice = { bad: true, text: e.message };
      bk.step = 'data'; render(); loadDays().then(() => bk.date && pickDate(bk.date));
      return;
    }
    if (e.status === 422) {
      bk.errors = { [e.data?.field || '']: e.message };
      bk.notice = { bad: true, text: e.message }; bk.step = 'dados'; render(); return;
    }
    // Erro de rede ou servidor: mantém a mesma chave, então tentar de novo nunca duplica a reserva.
    bk.notice = { bad: true, text: e.network ? e.message : `${e.message} Se o problema continuar, chame no WhatsApp.` };
    render();
  }
}

function stepSucesso() {
  const b = bk.booking;
  const msg = `Olá! Fiz uma solicitação de agendamento pelo site da Barbearia RL:\n\n` +
    `Serviço: ${b.service_name}\nData: ${dateLong(b.date)}\nHorário: ${b.start}\nNome: ${b.customer_name}\n\nPode confirmar, por favor?`;
  body.append(
    h('div', { class: 'success-mark', 'aria-hidden': 'true' }, '✓'),
    h('p', { class: 'bk-title', style: false }, 'Solicitação registrada!'),
    h('dl', { class: 'summary' },
      h('div', {}, h('dt', {}, 'Serviço'), h('dd', {}, b.service_name)),
      h('div', {}, h('dt', {}, 'Data'), h('dd', {}, dateLong(b.date))),
      h('div', {}, h('dt', {}, 'Horário'), h('dd', {}, `${b.start} às ${b.end}`)),
      h('div', {}, h('dt', {}, 'Situação'), h('dd', {}, 'Aguardando confirmação')),
    ),
    h('div', { class: 'notice' }, 'Seu horário está reservado e a barbearia vai confirmá-lo. O site não envia mensagens sozinho: se quiser avisar agora, toque no botão abaixo para abrir o WhatsApp com a mensagem pronta.'),
    h('p', { class: 'fine' }, `Barbearia RL · Rua Palmeira, 242 – Cidade Soberana, Guarulhos · ${CONTACT.whatsappLabel} · @rl_barbeariasb`),
  );
  foot.append(
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Fechar'),
    h('a', { class: 'btn btn-gold', href: waLink(msg), target: '_blank', rel: 'noopener' }, 'Abrir WhatsApp com a mensagem'),
  );
}

// ---------- inicialização ----------
async function init() {
  setupHeader();
  document.addEventListener('click', (e) => { if (e.target.closest('[data-open-booking]')) openBooking(); });
  $('#bkClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  loadGallery();
  try {
    PUBLIC = await api('/api/public');
    renderServices(); renderHours();
  } catch (e) {
    $('#servicesList').replaceChildren(h('li', { class: 'muted' }, 'Não foi possível carregar os serviços agora. Tente atualizar a página ou chame no WhatsApp.'));
  }
  setupReveal();
}
init();
