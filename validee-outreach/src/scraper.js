require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ApifyClient } = require('apify-client');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { loadConfig } = require('./apify-config');

const { LEADS_CSV_PATH = 'config/leads.csv' } = process.env;
const LEADS_COLUMNS = ['nome', 'telefone', 'rating', 'endereco', 'status', 'atualizado_em'];

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// Um telefone valido para o Brasil tem DDI+DDD+numero (10 a 13 digitos).
function hasValidPhone(digits) {
  return digits.length >= 10 && digits.length <= 13;
}

// O actor compass/crawler-google-places (e forks) variam levemente os nomes
// dos campos de saida entre versoes, entao tentamos alguns aliases conhecidos.
function normalizeItem(item) {
  const nome = item.title || item.name || '';
  const telefoneBruto = item.phoneUnformatted || item.phone || item.phoneNumber || '';
  const rating = item.totalScore ?? item.rating ?? item.stars ?? null;
  const endereco = item.address || item.street || item.fullAddress || '';

  return {
    nome: nome.trim(),
    telefone: onlyDigits(telefoneBruto),
    rating: rating !== null ? Number(rating) : null,
    endereco: endereco.trim(),
  };
}

function resolvePath(p) {
  return path.resolve(process.cwd(), p);
}

function loadExistingLeads() {
  const csvPath = resolvePath(LEADS_CSV_PATH);
  if (!fs.existsSync(csvPath)) {
    return [];
  }
  const content = fs.readFileSync(csvPath, 'utf8');
  if (!content.trim()) {
    return [];
  }
  return parse(content, { columns: true, skip_empty_lines: true });
}

async function scrapeLeads() {
  const config = loadConfig();

  if (!config.token) {
    throw new Error('Token do Apify nao configurado. Defina em /apify.html ou no .env (APIFY_TOKEN).');
  }
  if (!config.searchTerm || !config.searchLocation) {
    throw new Error('Termo de busca e localizacao precisam estar configurados em /apify.html.');
  }

  const client = new ApifyClient({ token: config.token });

  console.log(`Buscando "${config.searchTerm}" em "${config.searchLocation}" (ate ${config.maxLeads} leads)...`);

  const run = await client.actor(config.actorId).call({
    searchStringsArray: [config.searchTerm],
    locationQuery: config.searchLocation,
    maxCrawledPlacesPerSearch: config.maxLeads,
    language: 'pt-BR',
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`Actor retornou ${items.length} resultados brutos.`);

  // Preserva leads ja existentes (e o status deles) e so acrescenta os que
  // ainda nao estao no CSV, para rodar o scraper varias vezes sem perder
  // o historico de quem ja foi contatado.
  const existingLeads = loadExistingLeads();
  const existingPhones = new Set(existingLeads.map((l) => l.telefone));

  let addedCount = 0;
  let duplicateCount = 0;
  let discardedCount = 0;

  for (const raw of items) {
    const lead = normalizeItem(raw);

    if (!hasValidPhone(lead.telefone) || lead.rating === null || Number.isNaN(lead.rating)) {
      discardedCount += 1;
      continue;
    }
    if (lead.rating < config.minRating || lead.rating > config.maxRating) {
      discardedCount += 1;
      continue;
    }
    if (existingPhones.has(lead.telefone)) {
      duplicateCount += 1;
      continue;
    }

    existingLeads.push({
      nome: lead.nome,
      telefone: lead.telefone,
      rating: lead.rating,
      endereco: lead.endereco,
      status: 'pendente',
      atualizado_em: '',
    });
    existingPhones.add(lead.telefone);
    addedCount += 1;
  }

  console.log(
    `${addedCount} leads novos adicionados, ${duplicateCount} ja existiam, ${discardedCount} descartados (rating/telefone).`
  );

  const csvPath = resolvePath(LEADS_CSV_PATH);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const csvContent = stringify(existingLeads, { header: true, columns: LEADS_COLUMNS });
  fs.writeFileSync(csvPath, csvContent, 'utf8');

  console.log(`Leads salvos em ${csvPath} (total: ${existingLeads.length}).`);

  return { added: addedCount, duplicates: duplicateCount, discarded: discardedCount, total: existingLeads.length };
}

if (require.main === module) {
  scrapeLeads().catch((err) => {
    console.error('Erro ao rodar o scraper:', err.message);
    process.exit(1);
  });
}

module.exports = { scrapeLeads };
