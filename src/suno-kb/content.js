// Full content of Suno reports, fetched directly from the endpoints the
// report reader itself uses (mapped on 2026-11-23). Read-only GETs with the
// session headers kept in memory; nothing here marks a report as read.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { redact, scrubObject, privateDirectory } from '../privacy.js';
import { GATEWAY_HOST } from './endpoints.js';

export const EDITIONS_HOST = 'api.sunocore.com.br';
const SLUG = /^[a-z0-9][a-z0-9-]{0,200}$/i;
const MAX_BYTES = 150 * 1024 * 1024;

// Report type (from the list) → where its content lives.
export function contentSource({ type, slug }) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  const gateway = path => `https://${GATEWAY_HOST}/api/${path}`;
  switch (type) {
    case 'e-reader': case 'analysis': return { format: 'ereader', url: gateway(`v1/reports/ereader/${slug}`) };
    case 'pdf': return { format: 'pdf', url: gateway(`v2/reports/view/${slug}`) };
    case 'html-content': return { format: 'html', url: gateway(`v2/reports/list?slug=${slug}`) };
    case 'edition': return { format: 'edition', url: `https://${EDITIONS_HOST}/reports/api/public/editions/${slug}` };
    default: return null;
  }
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', ordm: 'º', ordf: 'ª', deg: '°' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const headingKeys = new Set(['text', 'title', 'subTitle', 'sub_title', 'subtitle', 'summary']);
const skipNames = /^(?:id|_id|uuid|slug|url|uri|href|link|logo.*|image.*|icon.*|avatar.*|audio.*|thumbnail.*|file.*|color|date.*|status|type|position|paragraph_type|markups)$/i;
const skipKey = key => skipNames.test(key) || /(?:_at|At)$/.test(key);

// Prose of a JSON document in reading order: every `text`/title field plus any
// other sentence-like string (editions keep their analyses in varied fields).
export function jsonText(body) {
  const out = [];
  const walk = (node, key) => {
    if (typeof node === 'string') {
      const value = node.trim();
      if (!value || /^https?:\/\//.test(value)) return;
      if (headingKeys.has(key) || (/\s/.test(value) && value.length >= 25)) {
        const text = /<[a-z][\s\S]*>/i.test(value) ? htmlToText(value) : decodeEntities(value);
        if (text && out.at(-1) !== text) out.push(text);
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, key); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) if (!skipKey(k)) walk(v, k);
  };
  walk(body, null);
  return out.join('\n');
}

function runPdftotext(buffer) {
  return new Promise(resolve => {
    const child = spawn('pdftotext', ['-q', '-layout', '-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null); });
    child.stdin.end(buffer);
  });
}

const cpfPattern = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;

// Turns one successful response into what is stored. PDFs go to disk unless
// their text shows a CPF-like stamp, in which case only redacted text is kept.
export async function parseContent(format, { body, contentType }, { reportKey, slug, pdfDir, extractPdf = runPdftotext }) {
  if (format === 'pdf') {
    if (!/pdf/i.test(contentType) || body.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'NOT_PDF' };
    const raw = await extractPdf(body);
    const text = raw === null ? null : raw.replace(/\f/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    const file = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
    if (text && cpfPattern.test(text)) return { text: redact(text), detail: 'PDF_NOT_KEPT_PERSONAL_PATTERN', file: { ...file, path: null } };
    privateDirectory(pdfDir);
    const path = join(pdfDir, `${reportKey}-${slug}.pdf`);
    writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return { text: text === null ? null : redact(text), detail: text === null ? 'PDF_TEXT_UNAVAILABLE' : null, file: { ...file, path } };
  }
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch { return { error: 'NOT_JSON' }; }
  const clean = scrubObject(json);
  if (format === 'html') {
    const report = (clean.reports || []).find(r => r?.slug === slug) || clean.reports?.[0];
    if (!report?.content) return { error: 'EMPTY' };
    return { json: report, text: redact([report.title, report.subtitle, htmlToText(report.content)].filter(Boolean).join('\n\n')) };
  }
  const document = format === 'edition' ? clean.value ?? clean : clean;
  if (!document || typeof document !== 'object' || (format === 'ereader' && !document.content)) return { error: 'EMPTY' };
  return { json: document, text: redact(jsonText(document)) };
}

// Downloads pending report contents, newest first, at a fixed pace.
// request(url, headers) → { status, contentType, body: Buffer }.
// refreshAuth() makes the app renew its token (headers() then returns it).
export async function collectReportContents({ store, request, headers, refreshAuth, limit, delayMs, pdfDir,
  refreshEveryMs = 15 * 60000, maxAttempts = 3, onProgress = () => {}, extractPdf, shouldStop = () => false, now = Date.now }) {
  const stats = { attempted: 0, ok: 0, no_access: 0, unsupported: 0, unavailable: 0, error: 0, bytes: 0 };
  const pending = store.pendingReportContents(limit, maxAttempts);
  stats.pending = pending.length;
  let lastRefresh = now();
  for (const report of pending) {
    if (shouldStop()) return { stats, interrupted: true };
    const base = { reportKey: report.item_key, slug: report.slug, type: report.type, title: report.title };
    if (report.has_access === 0) { store.saveReportContent({ ...base, status: 'no_access' }); stats.no_access++; continue; }
    const source = contentSource(report);
    if (!source) { store.saveReportContent({ ...base, status: 'unsupported' }); stats.unsupported++; continue; }
    if (now() - lastRefresh > refreshEveryMs) { await refreshAuth(); lastRefresh = now(); }
    stats.attempted++;
    onProgress({ ...base, index: stats.attempted, total: pending.length });
    let response;
    try {
      response = await request(source.url, headers());
      if (response.status === 401) {
        if (!(await refreshAuth())) return { stats, authLost: true };
        lastRefresh = now();
        response = await request(source.url, headers());
        if (response.status === 401) return { stats, authLost: true };
      }
    } catch (error) {
      response = { status: 0, error: error.name === 'TimeoutError' ? 'TIMEOUT' : 'REQUEST_FAILED' };
    }
    const saved = { ...base, format: source.format, url: source.url, httpStatus: response.status };
    if (response.status === 200 && response.body?.length > MAX_BYTES) {
      store.saveReportContent({ ...saved, status: 'error', detail: 'TOO_LARGE' }); stats.error++;
    } else if (response.status === 200) {
      const parsed = await parseContent(source.format, response, { reportKey: report.item_key, slug: report.slug, pdfDir, extractPdf });
      if (parsed.error) { store.saveReportContent({ ...saved, status: 'error', detail: parsed.error }); stats.error++; }
      else {
        store.saveReportContent({ ...saved, status: 'ok', json: parsed.json, text: parsed.text, detail: parsed.detail,
          file: parsed.file && { ...parsed.file, path: parsed.file.path && relative(process.cwd(), parsed.file.path) } });
        stats.ok++;
        stats.bytes += response.body.length;
      }
    } else if (response.status === 403 || response.status === 404) {
      store.saveReportContent({ ...saved, status: 'unavailable' }); stats.unavailable++;
    } else {
      store.saveReportContent({ ...saved, status: 'error', detail: response.error || `HTTP_${response.status}` }); stats.error++;
    }
    await sleep(delayMs);
  }
  return { stats };
}
