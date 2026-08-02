# Validee Outreach

Sistema de prospecção fria da Validee: raspa leads (nome, telefone, rating, endereço) de nichos
no Google Maps via Apify e dispara **apenas a primeira mensagem** de contato pelo WhatsApp, de
forma controlada e humanizada. O restante da conversa é sempre manual.

O sistema tem trava dupla de segurança para proteger o número que dispara:

- **Limite diário de mensagens** (padrão 15/dia, configurável, mas nunca removido).
- **Janelas de horário fixas**: terça a quinta, 7h–8h, 12h–14h ou 18h30–20h. Fora disso, nada é
  disparado — nem mesmo quando o comando é chamado manualmente.
- **Delay aleatório** entre 45 e 120 segundos entre um envio e outro (nunca um intervalo fixo).

## 1. Pré-requisitos

- Node.js 18+
- Uma conta no [Apify](https://apify.com) com créditos para rodar o Actor de Google Maps
  (`compass/crawler-google-places` ou similar)
- Um número de WhatsApp dedicado para o disparo (recomendado não usar seu WhatsApp pessoal
  principal, pelo risco de restrição da conta)

## 2. Instalação

```bash
cd validee-outreach
npm install
```

## 3. Configuração (`.env`)

O `.env` só é obrigatório para customizar a porta do painel web. Tudo o resto (token do Apify,
termos de busca, limite diário, delay, janelas de horário, mensagem) é configurado depois pelo
próprio painel web e fica salvo em arquivos dentro de `config/`. Ainda assim, copiar o exemplo é
uma forma rápida de já deixar valores iniciais preenchidos:

```bash
cp .env.example .env
```

| Variável | Descrição |
|---|---|
| `PORT` | Porta do painel web (padrão 3000) |
| `APIFY_TOKEN`, `APIFY_ACTOR_ID`, `SEARCH_TERM`, `SEARCH_LOCATION`, `MAX_LEADS`, `MIN_RATING`, `MAX_RATING` | Valores iniciais usados só para criar `config/apify-config.json` na primeira vez — depois disso, edite pelo painel em `/apify.html` |
| `DAILY_LIMIT`, `MIN_DELAY_SECONDS`, `MAX_DELAY_SECONDS` | Idem, mas para `config/settings.json` — depois disso, edite em `/copy.html` |

## 4. Painel web

```bash
npm run web
```

Abre um painel em `http://localhost:3000` (ou a porta definida em `PORT`) com 5 páginas. A ideia é
que, depois de instalado, você não precise mais tocar em terminal nem editar arquivos à mão:

- **WhatsApp** (`/whatsapp.html`) — clique em "Conectar" para gerar o QR code na tela sempre que
  quiser. A sessão fica salva localmente, então não pede QR de novo nas próximas vezes.
  "Desconectar" faz logout de verdade, para trocar de número.
- **Copy & disparo** (`/copy.html`) — editar a mensagem de abertura e ajustar limite diário, delay
  entre envios e as janelas de horário permitidas. O painel nunca deixa configurar um valor fora
  da faixa segura (ex: limite diário acima de 40, delay abaixo de 20s, ou zero janelas de
  horário) — isso é proposital, é a proteção contra ban.
- **Apify** (`/apify.html`) — cole o token da API do Apify (Settings > Integrations na conta
  Apify), o termo de busca, a localização e a faixa de rating direto na tela; o token nunca é
  reexibido depois de salvo, só os últimos 4 caracteres para conferência. A mesma página tem um
  botão **"Rodar scraper agora"**, que chama o Apify de verdade e mostra o resultado real (quantos
  leads novos entraram, quantos já existiam, quantos foram descartados), e mais abaixo mostra o
  uso/limite do plano Apify no mês.
- **Relatórios** (`/reports.html`) — números pós-disparo: total de leads por status, quota
  consumida hoje, taxa de sucesso geral, envios por dia e a lista dos envios/erros mais recentes.

As configurações de disparo (`config/settings.json`) e do Apify (`config/apify-config.json`) são
lidas a cada execução — dá pra ajustar pelo painel mesmo com o `send:schedule` já rodando há dias,
sem precisar reiniciar nada. Nenhum desses dois arquivos é versionado no git (contêm dado sensível
e dados gerados).

## 5. Rodar o scraper

Pelo painel web (`/apify.html`, botão "Rodar scraper agora") ou pelo terminal:

```bash
npm run scrape
```

Busca no Google Maps via Apify e acrescenta os leads novos a `config/leads.csv` (colunas: `nome,
telefone, rating, endereco, status, atualizado_em`). Rodar de novo não apaga o que já existe: leads
com o mesmo telefone são pulados, então o histórico de quem já foi contatado nunca se perde. Leads
sem telefone válido ou fora da faixa de rating configurada são descartados.

## 6. Rodar o sender

### Disparo manual único

```bash
npm run send:now
```

Só dispara de fato se o horário atual estiver dentro de uma das janelas permitidas. Fora da
janela, o comando avisa e não faz nada.

### Disparo automático agendado

```bash
npm run send:schedule
```

Sobe um processo (`node-cron`) que verifica a cada 15 minutos se está dentro de uma janela
permitida e, se estiver, dispara a fila de leads pendentes automaticamente. Deixe esse processo
rodando (ex: em um `screen`/`tmux`, ou com um gerenciador como `pm2`) durante a semana.

Em ambos os modos, o sender:

- Pula leads já marcados como `enviado` ou `erro` em `config/leads.csv`.
- Personaliza a mensagem de `config/message-template.txt` trocando `{nome}` pelo nome do negócio.
- Atualiza o status do lead (`enviado` ou `erro`) e o timestamp no próprio `leads.csv`.
- Registra cada tentativa em `config/log-envios.csv` (telefone, nome, timestamp, status).
- Se um envio falhar (número inválido, sem WhatsApp, etc.), marca `erro` e segue para o próximo
  lead sem travar a fila.
- Ao bater o limite diário, para e informa quantos leads ficaram pendentes para o dia seguinte.

## 7. Personalizando a mensagem

Edite pelo painel web (`/copy.html`) ou diretamente em `config/message-template.txt`. Use `{nome}`
onde quiser que entre o nome do negócio. Mantenha a mensagem curta (2–3 frases) e sem cara de
disparo em massa — é só o gancho inicial, a conversa real é sempre feita manualmente por você
depois.

## 8. Deploy em produção (VPS)

Para deixar isso rodando 24/7 numa VPS (ex: Hostinger) em vez do seu computador, com PM2 cuidando
de reiniciar sozinho se cair e sobreviver a reboots, veja o [DEPLOY.md](DEPLOY.md).

## 9. Erros comuns

- **"Arquivo de leads não encontrado"**: rode `npm run scrape` antes do sender.
- **QR code não aparece / erro ao conectar**: abra `/whatsapp.html` — se o status ficar em "Erro
  ao conectar", a mensagem detalhada aparece na tela. A causa mais comum é o Chromium do Puppeteer
  não ter sido baixado corretamente na instalação (erro do tipo `Failed to launch the browser
  process`). Nesse caso rode:
  ```bash
  npx puppeteer browsers install chrome
  ```
  Se o erro persistir mesmo depois disso, apague a pasta baixada (algo como
  `~/.cache/puppeteer/chrome/mac_arm-<versao>`) e rode o comando de novo para forçar um download
  limpo.
- **Sessão do WhatsApp caiu no meio do dia**: o `--schedule` não derruba o processo; ele loga o
  erro e tenta reconectar (novo QR, visível em `/whatsapp.html`) na próxima verificação dentro da
  janela.
- **"Token do Apify não configurado" / erro ao rodar o scraper**: confira em `/apify.html` se o
  token foi salvo (o campo mostra "Token atual termina em ••••XXXX" quando está configurado). Um
  erro tipo "authentication token is not valid" vindo do próprio Apify significa que o token
  colado está incorreto ou expirado — gere um novo em Settings > Integrations na conta Apify.
