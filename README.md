# Barbearia RL — site e agendamento

Site público + agendamento online + painel administrativo. Node 22.13+ (sem dependências, banco SQLite embutido).

## Rodar

```bash
npm start            # http://localhost:3000   (PORT=8080 para trocar)
npm test             # 16 testes de API (agenda, conflitos, autenticação)
```

No primeiro start, o terminal mostra um **código de configuração**. Abra `/admin/`, informe o código, e-mail e senha (mín. 10 caracteres) para criar o administrador. Não existe senha padrão. Depois disso o código deixa de valer.

## Antes de liberar o agendamento

As durações **não foram inventadas**. Em `/admin/` → Serviços, informe a duração (min) de cada serviço; só os que tiverem duração aparecem para agendar online. Confira também Horários e bloqueios (terça a sábado, 09h–20h já vem configurado).

## Onde mexer

| O quê | Onde |
|---|---|
| WhatsApp que recebe a mensagem pós-agendamento | `CONTACT` no topo de `public/app.js` |
| Fotos da galeria | coloque em `public/img/` e liste em `public/gallery.json` |
| Preços, durações, barbeiros, horários, folgas | painel `/admin/` |
| Cores | variáveis no início de `public/styles.css` |

## Produção

- Banco: arquivo `data/barbearia.db` (`DB_FILE` para mudar). Use disco persistente e faça backup desse arquivo.
- Sirva atrás de HTTPS e defina `COOKIE_SECURE=1`.
- Hospedagem precisa rodar Node (VPS, Render, Railway, Fly etc.); não funciona em hospedagem só de arquivos estáticos.

## Como o agendamento evita conflito

A reserva é gravada em transação `BEGIN IMMEDIATE`; o servidor recalcula a disponibilidade dentro da transação antes de inserir, então duas pessoas nunca ficam com o mesmo horário. Cada pedido leva uma chave única, portanto clique duplo ou reenvio após falha de rede devolve a mesma reserva em vez de criar outra.
