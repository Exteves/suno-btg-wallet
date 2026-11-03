import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export function redact(value) {
  return String(value ?? '')
    .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, '[CPF REMOVIDO]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REMOVIDO]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[TOKEN REMOVIDO]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[CREDENCIAL REMOVIDA]')
    .replace(/((?:senha|password|token|cookie|authorization|c[oó]digo de (?:acesso|autentica[çc][aã]o|verifica[çc][aã]o)|verification code|otp)(?:\s*[:=]\s*|[ \t]*\n\s*))[^\n,;]+/gi, '$1[REMOVIDO]')
    .replace(/((?:n[uú]mero (?:da |de )?conta|conta(?:\s+(?:corrente|banc[aá]ria|investimento))?|ag[eê]ncia)\s*[:#=-]?\s*)\d[\d.\s-]*/gi, '$1[REMOVIDO]');
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function privatePath(path) {
  const root = resolve('privado');
  const target = resolve(path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('O banco deve estar dentro de privado/.');
  }
  return target;
}

export function scrubObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrubObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k),
      /^(?:password|senha|token|cookie|authorization|cpf|account_number|numero_conta|otp)$/i.test(k) ? '[REMOVIDO]' : scrubObject(v)]));
  }
  return value;
}

export function scrubSnapshot(input) {
  const data = scrubObject(input);
  const sensitive = /\b(?:cpf|conta|ag[eê]ncia|account|senha|password|token|cookie|email|e-mail|otp|autentica[çc][aã]o|verification)\b/i;
  for (const table of data.tables) {
    table.rows = table.rows.map(cells => cells.map((cell, index) =>
      sensitive.test(table.headers[index] || '') || (index > 0 && sensitive.test(cells[0] || '')) ? '[REMOVIDO]' : cell));
  }
  for (const block of data.productBlocks || []) {
    block.fields = Object.fromEntries(Object.entries(block.fields).map(([label, value]) => [label, sensitive.test(label) ? '[REMOVIDO]' : value]));
  }
  for (const link of data.links || []) link.url = redactUrl(link.url);
  if (data.sourceUrl) data.sourceUrl = redactUrl(data.sourceUrl);
  return data;
}

export function redactUrl(url) {
  try {
    const decoded = decodeURIComponent(url);
    const clean = redact(decoded);
    return clean === decoded ? url : clean;
  } catch { return '[URL INVÁLIDA]'; }
}
