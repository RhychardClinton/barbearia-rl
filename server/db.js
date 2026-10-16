import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS barbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      price_from INTEGER NOT NULL DEFAULT 0,
      duration_min INTEGER CHECK (duration_min IS NULL OR duration_min > 0),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS business_hours (
      weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
      open INTEGER NOT NULL DEFAULT 0,
      start_min INTEGER NOT NULL DEFAULT 540,
      end_min INTEGER NOT NULL DEFAULT 1200
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER NOT NULL REFERENCES barbers(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      service_name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','confirmado','concluido','cancelado')),
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_day ON appointments(barber_id, date);
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER REFERENCES barbers(id),
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL DEFAULT 0,
      end_min INTEGER NOT NULL DEFAULT 1440,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  seed(db);
  return db;
}

function seed(db) {
  const hasServices = db.prepare('SELECT COUNT(*) c FROM services').get().c;
  if (!hasServices) {
    // Preços conforme a tabela de valores da barbearia. Durações ficam em branco (NULL)
    // até o administrador configurar: serviço sem duração não aparece no agendamento.
    const list = [
      ['Corte', 4000, 0], ['Barba', 2000, 0], ['Corte + barba', 6000, 0],
      ['Sobrancelhas', 1000, 0], ['Corte + barba + sobrancelhas', 6000, 0],
      ['Corte + platinado', 14000, 0], ['Corte + luzes', 13000, 0],
      ['Progressiva', 5000, 1], ['Relaxamento', 2500, 1], ['Botox', 3000, 1],
      ['Limpeza de pele', 1500, 0],
    ];
    const ins = db.prepare('INSERT INTO services (name, price_cents, price_from, sort_order) VALUES (?,?,?,?)');
    list.forEach((s, i) => ins.run(s[0], s[1], s[2], i));
  }
  if (!db.prepare('SELECT COUNT(*) c FROM barbers').get().c) {
    db.prepare("INSERT INTO barbers (name) VALUES ('Barbeiro RL')").run();
  }
  if (!db.prepare('SELECT COUNT(*) c FROM business_hours').get().c) {
    const ins = db.prepare('INSERT INTO business_hours (weekday, open, start_min, end_min) VALUES (?,?,?,?)');
    for (let d = 0; d < 7; d++) ins.run(d, d >= 2 && d <= 6 ? 1 : 0, 540, 1200); // ter(2)..sáb(6)
  }
  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  setDefault.run('slot_step_min', '15');      // granularidade dos horários oferecidos
  setDefault.run('buffer_min', '0');          // intervalo entre atendimentos
  setDefault.run('max_days_ahead', '60');
  setDefault.run('min_notice_min', '30');     // antecedência mínima
}
