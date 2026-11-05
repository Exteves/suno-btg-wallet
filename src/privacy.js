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

// Request paths can contain account/customer identifiers even without a query.
// Diagnostics need only the route shape, never those identifiers.
export function diagnosticPath(raw) {
  try {
    const path = decodeURIComponent(new URL(raw, 'https://diagnostic.invalid').pathname);
    return redact(path)
      .replace(/(\/(?:accounts?|contas?|clients?|customers?|users?|clientes?|usuarios?)\/)[^/]+/gi, '$1[REMOVIDO]')
      .replace(/\b\d{6,}\b/g, '[REMOVIDO]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[REMOVIDO]');
  } catch { return '[CAMINHO REMOVIDO]'; }
}

function queryFieldLabel(value) {
  // Schema labels only. Drop numeric/dynamic identifiers, credential labels,
  // opaque long strings and runs of uppercase characters; never include values.
  return typeof value === 'string' && /^[A-Za-z][A-Za-z_]{0,39}$/.test(value)
    && !/token|secret|password|senha|cookie|authorization|signature|session|otp|cpf|email/i.test(value)
    && !/[A-Z]{3,}/.test(value) ? value : '[FIELD_REMOVED]';
}

export function queryFieldSchema(body) {
  const fields = [];
  const visit = (value, path, depth) => {
    if (depth > 5 || fields.length >= 80 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { if (value.length) visit(value[0], path, depth + 1); return; }
    for (const key of Object.keys(value).slice(0, 60)) {
      if (fields.length >= 80) break;
      const label = queryFieldLabel(key);
      const next = [...path, label];
      const item = value[key];
      const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
      fields.push({ path: next.join('.'), type: ['null', 'array', 'object', 'string', 'number', 'boolean'].includes(type) ? type : 'unknown' });
      if (label !== '[FIELD_REMOVED]') visit(item, next, depth + 1);
    }
  };
  visit(body, [], 0);
  return fields;
}

function scrubQueryFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, 80).map(field => ({
    path: typeof field?.path === 'string' ? field.path.split('.').slice(0, 6).map(queryFieldLabel).join('.') : '[FIELD_REMOVED]',
    type: ['null', 'array', 'object', 'string', 'number', 'boolean'].includes(field?.type) ? field.type : 'unknown',
  }));
}

export function scrubRequestDiagnostic(value) {
  if (typeof value === 'string') return diagnosticPath(value);
  const entry = value && typeof value === 'object' ? value : {};
  const clean = {
    path: typeof entry.path === 'string' ? diagnosticPath(entry.path) : '[CAMINHO REMOVIDO]',
    method: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method) ? entry.method : 'OTHER',
    resource_type: ['xhr', 'fetch', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'eventsource', 'ping'].includes(entry.resource_type) ? entry.resource_type : 'other',
    origin_scope: ['application', 'provider', 'external', 'unknown'].includes(entry.origin_scope) ? entry.origin_scope : 'unknown',
  };
  if (Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599) clean.status = entry.status;
  if (Number.isSafeInteger(entry.ageMs) && entry.ageMs >= 0) clean.ageMs = entry.ageMs;
  if (['awaiting_response', 'receiving_body'].includes(entry.stage)) clean.stage = entry.stage;
  if (['INVALID_STRUCTURE', 'TRANSACTION_FIELD', 'INVALID_VALUE', 'UNRECOGNIZED_FIELD', 'BODY_UNAVAILABLE'].includes(entry.query_check)) clean.query_check = entry.query_check;
  if (clean.query_check === 'UNRECOGNIZED_FIELD' && Array.isArray(entry.query_fields)) clean.query_fields = scrubQueryFields(entry.query_fields);
  if (['ERR_ABORTED', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_FAILED', 'ERR_BLOCKED_BY_CLIENT',
    'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_INTERNET_DISCONNECTED', 'ERR_CERT_AUTHORITY_INVALID', 'NETWORK_ERROR'].includes(entry.failure)) clean.failure = entry.failure;
  return clean;
}
