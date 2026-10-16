import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'barbearia.db');
const port = Number(process.env.PORT || 3000);

const db = openDb(dbFile);
const server = createApp(db, {
  onSetupCode: (code) => {
    console.log('\n==============================================================');
    console.log(' Nenhum administrador cadastrado ainda.');
    console.log(` Abra /admin/ e use este código de configuração: ${code}`);
    console.log(' (o código só vale até o primeiro administrador ser criado)');
    console.log('==============================================================\n');
  },
});
server.listen(port, () => console.log(`Barbearia RL rodando em http://localhost:${port}`));
