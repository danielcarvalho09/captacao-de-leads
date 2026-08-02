module.exports = {
  apps: [
    {
      name: 'validee-outreach',
      script: 'src/web/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Chrome (via puppeteer) as vezes vaza memoria em sessoes muito longas;
      // isso forca um restart limpo antes que a VPS fique sem RAM. A sessao
      // do WhatsApp continua salva em disco, entao reconecta sozinho.
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
