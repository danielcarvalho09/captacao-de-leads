# Deploy em produção

Duas formas de deixar isso rodando 24/7. Se você usa **EasyPanel** na sua VPS da Hostinger, use a
Opção A — é a que faz sentido pro seu caso. A Opção B fica documentada como alternativa (VPS pura,
sem EasyPanel).

## 0. O que isso resolve (e o que não resolve)

- **Resolve**: o processo cair (falta de memória, erro do Chrome, etc.) e reiniciar sozinho,
  mantendo a sessão do WhatsApp salva (não precisa escanear QR de novo).
- **Não resolve**: o WhatsApp em si tem uma regra própria — se o celular que gerou o QR ficar
  **mais de ~14 dias sem internet**, o WhatsApp desloga o dispositivo vinculado por conta própria
  (isso é do WhatsApp, nenhum código evita). Mantenha o celular do número ligado e com internet de
  vez em quando.

---

## Opção A — EasyPanel (recomendado, é o seu caso)

O EasyPanel roda tudo em containers Docker. Já deixei um `Dockerfile` pronto no projeto — ele
instala as bibliotecas que o Chrome precisa pra rodar sem interface gráfica e já baixa o Chrome do
Puppeteer durante o build da imagem.

### A.1. Subir o código para um repositório Git

O EasyPanel builda a partir de um repositório (GitHub, GitLab, etc). Se ainda não tem um:

```bash
cd validee-outreach
git init
git add .
git commit -m "Deploy inicial"
```

Crie um repositório (pode ser privado) no GitHub e faça o push.

> **Importante**: o `.gitignore` já exclui `.env`, `.wwebjs_auth/` e os arquivos gerados em
> `config/` (leads, log, settings, apify-config) — nada disso vai pro repositório, o que é
> correto. Eles vivem só no volume persistente configurado no passo A.4.

### A.2. Criar o serviço no EasyPanel

1. No EasyPanel, abra (ou crie) um **Project**.
2. Clique em **+ Service** → **App**.
3. Conecte o repositório Git que você acabou de criar.
4. Na aba **Build**, escolha **Dockerfile** (o caminho padrão `Dockerfile` na raiz já é o que está
   no projeto — não precisa mudar nada).
5. Clique em **Deploy**. O primeiro build demora um pouco mais (baixa o Chrome, ~200MB).

### A.3. Variáveis de ambiente

Na aba **Environment** do serviço, cole (ajustando os valores):

```
PORT=3000
DASHBOARD_USER=escolha_um_usuario
DASHBOARD_PASSWORD=escolha_uma_senha_forte
ENABLE_SCHEDULER=true
TZ=America/Sao_Paulo
APIFY_TOKEN=seu_token_do_apify
```

> **`ENABLE_SCHEDULER=true` é o que liga o disparo automático.** Sem essa variável o painel
> funciona normalmente, mas nada é enviado sozinho — só pelo botão "Disparar agora". Confira no log
> do serviço: no boot ele imprime `Disparo automatico LIGADO` ou `DESLIGADO`.
>
> **`APIFY_TOKEN`** definido aqui **tem precedência** sobre o painel e sobrevive a deploy, porque
> variável de ambiente vive na configuração do serviço, não no disco do container. É a forma
> recomendada em servidor. Quando definido, o campo de token no painel fica desativado.
>
> Isso resolve o token — mas **não resolve os leads**: dados gerados não cabem em variável de
> ambiente. Sem o volume em `/app/config` você perde os leads e, pior, o `log-envios.csv`, que é o
> que impede mandar mensagem repetida para quem já foi contatado.
>
> **`TZ`** já vem embutido na imagem como `America/Sao_Paulo`. Só defina aqui se você operar em
> outro fuso. Se o fuso estiver errado, as janelas de horário não batem: o container em UTC
> enxerga 15:30 quando em Brasília são 12:30, e o disparo nunca acontece na hora certa.

`DASHBOARD_USER`/`DASHBOARD_PASSWORD` são **obrigatórios** aqui — sem eles, o painel fica exposto
publicamente sem senha assim que você configurar o domínio no passo A.5. O token do Apify, a
mensagem e o resto você configura depois direto pelo painel, como já faz hoje.

Clique em **Save** e depois **Deploy** de novo pra aplicar.

### A.4. Persistência de dados (crítico — não pule isso)

**É isto que faz o token do Apify e a sessão do WhatsApp sobreviverem a um deploy.** Sem os dois
volumes abaixo, todo novo deploy recria o container do zero: o token some, os leads somem e o
WhatsApp volta pedindo QR. Na
aba **Storage** do serviço, adicione dois **Volume mounts** (tipo "Volume", gerenciado pelo
próprio EasyPanel):

| Mount path no container | Pra quê |
|---|---|
| `/app/config` | leads, log de envios, configurações de disparo e da Apify, mensagem |
| `/app/.wwebjs_auth` | sessão autenticada do WhatsApp (evita pedir QR de novo a cada deploy) |

Depois de adicionar os volumes, faça um novo **Deploy** pra aplicar (o EasyPanel avisa que mudanças
de storage exigem reimplantar).


> **Como o container lida com isso**: a imagem guarda os arquivos-semente em `/app/defaults` e,
> a cada boot, o `src/bootstrap.js` copia para `/app/config` **apenas o que ainda não existe lá**.
> Ou seja: o primeiro deploy popula o volume com a mensagem padrão, e os deploys seguintes nunca
> sobrescrevem o que você editou pelo painel.

### A.5. Domínio e HTTPS

Na aba **Domains** do serviço:

1. Defina a **porta exposta** como `3000` (a mesma do `PORT` configurado).
2. Adicione um domínio (um subdomínio seu, ou use o domínio automático que o EasyPanel oferece).
3. Ative o **Let's Encrypt** — o EasyPanel emite o certificado HTTPS sozinho.

### A.6. Primeira conexão do WhatsApp

Acesse a URL/domínio que o EasyPanel te deu — o navegador vai pedir o usuário/senha do
`DASHBOARD_USER`/`DASHBOARD_PASSWORD`. Depois disso é igual ao uso local: vá em **WhatsApp**,
clique em **Conectar**, escaneie o QR, e configure a copy/token da Apify em **Copy & disparo** /
**Apify**.

### A.7. Atualizações depois

Se ativar o deploy automático (webhook do GitHub) no EasyPanel, basta dar `git push` que ele
reconstrói e reinicia sozinho. Ou clique em **Deploy** manualmente na interface.

---

## Opção B — VPS pura, sem EasyPanel (PM2 + systemd)

### B.1. Acessar a VPS

```bash
ssh root@SEU_IP_DA_VPS
```

### B.2. Instalar Node.js e dependências do Chrome headless

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 fonts-liberation libappindicator3-1 xdg-utils
```

### B.3. Enviar o código

Da sua máquina:

```bash
rsync -avz --exclude node_modules --exclude .wwebjs_auth \
  "validee-outreach/" root@SEU_IP_DA_VPS:/opt/validee-outreach/
```

### B.4. Instalar dependências

```bash
cd /opt/validee-outreach
npm install
npx puppeteer browsers install chrome
```

### B.5. Configurar o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha `PORT`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD` e `ENABLE_SCHEDULER=true` (mesmas regras
da Opção A). **Não rode `npm run send:schedule` separado** se `ENABLE_SCHEDULER=true` — os dois
processos abririam sessões próprias do WhatsApp e disputariam o mesmo perfil do Chrome.

### B.6. Primeira conexão do WhatsApp (via túnel SSH)

```bash
node src/web/server.js
```

Em outro terminal, na sua máquina:

```bash
ssh -L 3000:localhost:3000 root@SEU_IP_DA_VPS
```

Abra `http://localhost:3000`, conecte o WhatsApp, depois `Ctrl+C` no processo da VPS.

### B.7. Subir com PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

O `pm2 startup` imprime um comando pra copiar e rodar — registra o PM2 como serviço do sistema,
sobrevivendo a reboots.

```bash
pm2 status
pm2 logs validee-outreach
pm2 restart validee-outreach
```

### B.8. Liberar acesso externo (opcional)

Só depois de configurar usuário/senha no `.env`:

```bash
ufw allow from SEU_IP_FIXO to any port 3000
ufw enable
```
