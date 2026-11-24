import { readFile } from 'node:fs/promises';

const positive = value => Number.isInteger(value) && value > 0;

export async function loadDailyConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const base = new URL(config.baseUrl);
  if (base.origin !== 'https://investidor.suno.com.br' || base.pathname !== '/' || base.search || base.hash) throw new Error('baseUrl');
  const route = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && new URL(value, base).origin === base.origin
    && new URL(value, base).pathname === value;
  if (!route(config.authCheckPath) || !Array.isArray(config.sections) || !config.sections.length) throw new Error('sections');
  const names = new Set();
  for (const section of config.sections) {
    if (typeof section.name !== 'string' || !section.name || names.has(section.name) || !route(section.path)
      || (section.discoverPrefix !== undefined && (!route(section.discoverPrefix) || !section.discoverPrefix.endsWith('/')))) throw new Error('section');
    names.add(section.name);
  }
  for (const key of ['maxPages', 'maxDiscoveredPerSection', 'maxLinkDepth', 'maxTabsPerPage', 'settleQuietMs', 'settleTimeoutMs',
    'navigationTimeoutMs', 'authTimeoutMs', 'runTimeoutMinutes', 'sessionTtlHours']) if (!positive(config[key])) throw new Error(key);
  if (config.sessionTtlHours > 168 || !Array.isArray(config.sessionLocalStorageKeys)) throw new Error('session');
  const pagination = config.pagination;
  if (!pagination || !Number.isInteger(pagination.delayMs) || pagination.delayMs < 200 || !pagination.maxPagesPerSeries
    || !Object.values(pagination.maxPagesPerSeries).every(n => Number.isInteger(n) && n >= 0) || !('default' in pagination.maxPagesPerSeries)) throw new Error('pagination');
  pagination.maxBulkItems ??= 2000;
  if (!Number.isInteger(pagination.maxBulkItems) || pagination.maxBulkItems < 0) throw new Error('pagination');
  // Reports older than this date (YYYY-MM-DD, published) are not wanted: lists stop
  // paging there and their content is not downloaded.
  if (config.reportsSince !== undefined && (typeof config.reportsSince !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.reportsSince)
    || Number.isNaN(Date.parse(config.reportsSince)))) throw new Error('reportsSince');
  config.reportsSince ??= null;
  // Report contents: a few hundred per daily run; `daily:conteudo` drains the backlog.
  const content = config.content = { maxPerRun: 300, maxPerContentRun: 10000, contentRunTimeoutMinutes: 300, refreshMinutes: 15,
    maxAttempts: 3, pdfDir: 'privado/relatorios/pdf', ...config.content };
  for (const key of ['maxPerContentRun', 'contentRunTimeoutMinutes', 'refreshMinutes', 'maxAttempts']) if (!positive(content[key])) throw new Error(`content.${key}`);
  if (!Number.isInteger(content.maxPerRun) || content.maxPerRun < 0) throw new Error('content.maxPerRun');
  if (typeof content.pdfDir !== 'string' || !content.pdfDir.startsWith('privado/') || content.pdfDir.includes('..')) throw new Error('content.pdfDir');
  return config;
}
