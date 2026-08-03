// Normalizacao unica de telefone, usada TANTO pelo scraper (para deduplicar
// leads) QUANTO pelo sender (para enviar). Precisa ser a mesma funcao nos dois
// lugares: se o scraper deduplicar pelo numero cru e o sender normalizar na
// hora do envio, o mesmo telefone escrito de duas formas ("16997076960" e
// "5516997076960") vira dois leads e recebe a mensagem duas vezes.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // Sem DDI e com cara de numero brasileiro (DDD + 8 ou 9 digitos): assume Brasil.
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }
  return digits;
}

// DDI+DDD+numero: 12 digitos (fixo/8) ou 13 (celular/9) apos normalizar.
function hasValidPhone(raw) {
  const digits = normalizePhone(raw);
  return digits.length >= 10 && digits.length <= 13;
}

module.exports = { normalizePhone, hasValidPhone };
