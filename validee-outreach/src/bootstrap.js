const fs = require('fs');
const path = require('path');

// Em container, o volume persistente e montado em /app/config e comeca VAZIO,
// escondendo o que a imagem trazia nesse caminho. Por isso a imagem guarda os
// arquivos-semente em /app/defaults e, no boot, copiamos para o volume so o
// que ainda nao existe la. Assim um deploy novo nunca sobrescreve o que o
// usuario ja configurou pelo painel, mas tambem nunca sobe sem o template.
const CONFIG_DIR = path.resolve(process.cwd(), 'config');
const DEFAULTS_DIR = path.resolve(process.cwd(), 'defaults');

function seedConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(DEFAULTS_DIR)) {
    return { seeded: [], skipped: [] };
  }

  const seeded = [];
  const skipped = [];

  for (const file of fs.readdirSync(DEFAULTS_DIR)) {
    const target = path.join(CONFIG_DIR, file);
    if (fs.existsSync(target)) {
      skipped.push(file);
      continue;
    }
    fs.copyFileSync(path.join(DEFAULTS_DIR, file), target);
    seeded.push(file);
  }

  if (seeded.length) {
    console.log(`Config inicializada a partir de defaults/: ${seeded.join(', ')}`);
  }
  return { seeded, skipped };
}

module.exports = { seedConfigDir, CONFIG_DIR, DEFAULTS_DIR };
