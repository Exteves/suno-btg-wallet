import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndpoint, storedUrl, paginationOf, nextPageUrl, bulkUrl } from '../src/suno-kb/endpoints.js';
import { findCollections, describeItem, scopeOf, totalOf } from '../src/suno-kb/normalize.js';
import { KnowledgeStore, collectionDate } from '../src/suno-kb/store.js';
import { loadDailyConfig } from '../src/suno-kb/config.js';
import { contentSource, htmlToText, jsonText, parseContent, collectReportContents } from '../src/suno-kb/content.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { notificationFor } from '../src/suno-kb/health.js';
import { paginate } from '../src/suno-kb/collector.js';
import { toastScript } from '../src/windows-notify.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gw = path => `https://membros-api-gateway.suno.com.br/api/${path}`;

test('classifica endpoints de leitura e recusa áreas pessoais', () => {
  assert.equal(classifyEndpoint(gw('v2/reports/v2/list?per_page=10&page=0')).kind, 'report');
  assert.equal(classifyEndpoint(gw('v1/wallets/assets?wallet=dividendos-1')).kind, 'wallet_asset');
  assert.equal(classifyEndpoint(gw('v1/wallets/coverage-universe?page=1&limit=20')).kind, 'coverage');
  assert.equal(classifyEndpoint(gw('v1/nossos-fundos')).kind, 'fund');
  const search = classifyEndpoint(gw('v1/reports/users/12345/search?term=x&wpUserId=99'));
  assert.equal(search.template, 'v1/reports/users/{user}/search');
  assert.deepEqual(search.query, { term: 'x' });
  for (const path of ['v1/wallets/getMyWallet', 'v1/wallets/patrimonyAssetsPosition', 'v1/user/me', 'v1/Wallet/movements',
    'v1/wallets/allWalletsMyInvestiments', 'v2/reports/view/10?userId=1', 'v1/wallets/profitabilityMain']) {
    assert.equal(classifyEndpoint(gw(path)).decision, 'personal', path);
  }
  assert.equal(classifyEndpoint(gw('v2/reports/v2/list'), 'POST').decision, 'not_get');
  assert.equal(classifyEndpoint('https://evil.example/api/v1/nossos-fundos').decision, 'ignored');
  assert.equal(classifyEndpoint(gw('v9/desconhecido')).decision, 'unclassified');
  assert.equal(classifyEndpoint(gw('v1/wallets/bias/abc')).template, 'v1/wallets/bias/{id}');
});

test('URL armazenada não leva identificadores do usuário', () => {
  const url = storedUrl(gw('v1/reports/users/1234567/search?term=a&userId=1234567&wpUserId=9'));
  assert.ok(!url.includes('1234567') && !url.includes('wpUserId') && url.includes('term=a'));
});

test('paginação muda somente a posição', () => {
  const info = paginationOf(gw('v2/reports/v2/list?per_page=10&page=0&categories[]=suno-fiis'));
  assert.equal(info.pageKey, 'page');
  assert.equal(new URL(nextPageUrl(gw('v2/reports/v2/list?per_page=10&page=0'), info, 10)).searchParams.get('page'), '1');
  const offset = paginationOf(gw('v1/reports/users/1/search?limit=12&offset=24'));
  assert.equal(new URL(nextPageUrl(gw('v1/reports/users/1/search?limit=12&offset=24'), offset, 12)).searchParams.get('offset'), '36');
  assert.equal(paginationOf(gw('v1/nossos-fundos')), null);
  assert.equal(paginationOf(gw('v2/reports/v2/list?page=2&per_page=5')).seriesKey, paginationOf(gw('v2/reports/v2/list?per_page=5&page=7')).seriesKey);
});

test('encontra listas e campos comuns', () => {
  const body = { fundos: [{ id: 1, nome: 'Fundo A', ticker: 'SNCI11' }], cotacoes: [{ ticker: 'SNCI11', price: 9.5 }], total: 1 };
  const found = findCollections(body);
  assert.deepEqual(found.map(c => c.path), ['fundos', 'cotacoes']);
  assert.deepEqual(describeItem({ asset: { ticker: 'petr4', name: 'Petrobras' }, peso: '10%' }), { key: 'PETR4', ticker: 'PETR4', title: 'Petrobras', published: null });
  assert.equal(describeItem({ title: { rendered: '<b>Rel</b>' }, id: 7 }).title, 'Rel');
  assert.match(describeItem({ foo: 1 }).key, /^hash:/);
  assert.equal(scopeOf({ kind: 'wallet_asset', query: { wallet: 'dividendos-1' } }), 'dividendos-1');
  assert.equal(scopeOf({ kind: 'coverage', query: { page: '2', limit: '20', category: 'acoes' } }), 'category=acoes');
});

test('data de coleta usa o fuso de São Paulo', () => {
  assert.equal(collectionDate(new Date('2026-11-24T01:30:00Z')), '2026-11-23');
});

test('base acumula relatórios e registra composição diária com entradas e saídas', () => {
  let now = new Date('2026-11-23T22:00:00Z');
  const store = new KnowledgeStore(':memory:', { now: () => now });
  const report = classifyEndpoint(gw('v2/reports/v2/list?per_page=2&page=0'));
  const wallet = classifyEndpoint(gw('v1/wallets/assets?wallet=dividendos'));
  const assets = (...tickers) => ({ data: tickers.map((ticker, i) => ({ ticker, peso: `${i + 1}%`, email: 'x@y.com' })) });

  store.start('manual');
  let r = store.ingest({ classified: report, url: 'u', body: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }], status: 200, via: 'page' });
  assert.deepEqual(r.freshKeys, ['1', '2']);
  store.ingest({ classified: wallet, url: 'u', body: assets('PETR4', 'VALE3'), status: 200, via: 'page' });
  store.finish('captured', {});

  now = new Date('2026-11-24T22:00:00Z');
  store.start('timer');
  r = store.ingest({ classified: report, url: 'u', body: [{ id: 3, title: 'C' }, { id: 1, title: 'A' }], status: 200, via: 'page' });
  assert.deepEqual(r.freshKeys, ['3']);
  store.ingest({ classified: wallet, url: 'u', body: assets('PETR4', 'ITUB4'), status: 200, via: 'page' });
  store.finish('captured', {});

  assert.equal(store.db.prepare('SELECT count(*) n FROM reports').get().n, 3);
  assert.equal(store.db.prepare("SELECT first_seen_at FROM reports WHERE item_key='1'").get().first_seen_at, '2026-11-23T22:00:00.000Z');
  assert.equal(store.db.prepare("SELECT count(*) n FROM wallet_positions WHERE collection_date='2026-11-24'").get().n, 2);
  const changes = store.db.prepare('SELECT change, ticker FROM composition_changes ORDER BY change, ticker').all().map(row => `${row.change}:${row.ticker}`);
  assert.deepEqual(changes, ['entrou:ITUB4', 'saiu:VALE3']);
  // Dados pessoais conhecidos são removidos antes de gravar.
  assert.ok(!store.db.prepare('SELECT group_concat(json) j FROM blobs').get().j.includes('x@y.com'));
  // O mesmo conteúdo em dias diferentes não duplica o JSON.
  assert.equal(store.db.prepare("SELECT count(*) n FROM blobs WHERE json LIKE '%PETR4%' AND json NOT LIKE '%VALE3%' AND json NOT LIKE '%ITUB4%'").get().n, 1);
  store.close();
});

test('configuração diária válida', async () => {
  const config = await loadDailyConfig('suno-daily.config.json');
  assert.deepEqual(config.sections.map(s => s.name), ['relatorios', 'carteiras', 'cobertura', 'fundos']);
});

test('pedido completo e total anunciado pela API', () => {
  const raw = gw('v1/wallets/wallets-events?wallet_id=w&page=1');
  const url = new URL(bulkUrl(raw, paginationOf(raw), 341));
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('limit'), '341');
  assert.equal(totalOf({ count: 255, list: [] }), 255);
  assert.equal(totalOf({ assets: [], total_entries: 131 }), 131);
  assert.equal(totalOf([1, 2]), null);
  assert.deepEqual(classifyEndpoint(gw('v2/search?per_page=12&page=0')).collections, ['report.list']);
});

test('ticker aninhado em assets e reindexação a partir das respostas brutas', () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-23T22:00:00Z') });
  const classified = classifyEndpoint(gw('v1/wallets/assets?wallet=valor-recomendada'));
  store.start('manual');
  store.ingest({ classified, url: storedUrl(gw('v1/wallets/assets?wallet=valor-recomendada')), status: 200, via: 'page',
    body: { assets: [{ id: 'row-1', allocation: 5, assets: { ticker: 'TAEE11', name: 'Taesa' } }], has_access: true } });
  store.finish('captured', {});
  const row = () => store.db.prepare('SELECT item_key, ticker, title FROM wallet_positions').get();
  assert.deepEqual({ ...row() }, { item_key: 'TAEE11', ticker: 'TAEE11', title: 'Taesa' });
  store.db.exec("UPDATE observations SET ticker=NULL, item_key='x'");
  assert.equal(store.reindex(url => classifyEndpoint(url, 'GET')), 1);
  assert.deepEqual({ ...row() }, { item_key: 'TAEE11', ticker: 'TAEE11', title: 'Taesa' });
  assert.ok(storedUrl(gw('v1/wallets/1e32b952-3f74-4bd5-ae7e-1107d3746bd7/benchmark-rentability')).includes('1e32b952'));
  store.close();
});

test('lista de relatórios ignora ofertas de produto sem id', () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-23T22:00:00Z') });
  store.start('manual');
  store.ingest({ classified: classifyEndpoint(gw('v2/reports/v2/list?per_page=2&page=0')), url: 'u', status: 200, via: 'page',
    body: [{ id: 1, title: 'A', slug: 'a' }, { slug: 'suno-black', title: 'Suno Black', product_id: '1', link: 'https://checkout.example/x' }] });
  assert.deepEqual(store.db.prepare('SELECT item_key FROM reports').all().map(r => r.item_key), ['1']);
  store.close();
});

test('origem e texto do conteúdo de cada formato de relatório', async () => {
  assert.equal(contentSource({ type: 'e-reader', slug: 'analise-setorial-13' }).url, gw('v1/reports/ereader/analise-setorial-13'));
  assert.equal(contentSource({ type: 'analysis', slug: 'engie-egie3-57200' }).format, 'ereader');
  assert.equal(contentSource({ type: 'pdf', slug: 'x' }).url, gw('v2/reports/view/x'));
  assert.equal(contentSource({ type: 'html-content', slug: 'suno-call-1' }).url, gw('v2/reports/list?slug=suno-call-1'));
  assert.equal(contentSource({ type: 'edition', slug: 'radar-fiis-1' }).url, 'https://api.sunocore.com.br/reports/api/public/editions/radar-fiis-1');
  assert.equal(contentSource({ type: 'pdf', slug: '../user/me' }), null);
  assert.equal(contentSource({ type: 'video', slug: 'x' }), null);
  assert.equal(htmlToText('<p>Track&#038;Field &amp; <b>B3</b></p><ul><li>um</li></ul>'), 'Track&Field & B3\n• um');
  const ereader = { title: 'Engie', content: [{ id: '__a', type: 'h2', text: 'Resumo' }, { id: '__b', type: 'p', text: 'A empresa segue com bons dividendos.' }],
    logo: 'https://x/y.png', created_at: 'uma data qualquer com espaços' };
  assert.equal(jsonText(ereader), 'Engie\nResumo\nA empresa segue com bons dividendos.');
  const json = Buffer.from(JSON.stringify({ reports: [{ slug: 'suno-call-1', title: 'Call', content: '<p>Texto do call.</p>' }] }));
  assert.equal((await parseContent('html', { body: json, contentType: 'text/html' }, { slug: 'suno-call-1' })).text, 'Call\n\nTexto do call.');
  const edition = Buffer.from(JSON.stringify({ value: { title: 'Radar', contents: [{ asset: { ticker: 'ALZR11' }, analysis: 'O fundo mantém vacância baixa e contratos longos.' }] } }));
  assert.match((await parseContent('edition', { body: edition, contentType: 'application/json' }, { slug: 'radar-1' })).text, /vacância baixa/);
  assert.equal((await parseContent('pdf', { body: Buffer.from('<html>'), contentType: 'text/html' }, { slug: 'x' })).error, 'NOT_PDF');
});

test('PDF com padrão de CPF no texto não é guardado em disco', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suno-pdf-'));
  const pdf = { body: Buffer.from('%PDF-1.7 fake'), contentType: 'application/pdf' };
  const kept = await parseContent('pdf', pdf, { reportKey: '1', slug: 'a', pdfDir: dir, extractPdf: async () => 'Relatório\fpágina 2' });
  assert.ok(existsSync(kept.file.path) && kept.text === 'Relatório\n\npágina 2');
  const stamped = await parseContent('pdf', pdf, { reportKey: '2', slug: 'b', pdfDir: dir, extractPdf: async () => 'Licenciado para 123.456.789-00' });
  assert.equal(stamped.file.path, null);
  assert.equal(stamped.detail, 'PDF_NOT_KEPT_PERSONAL_PATTERN');
  assert.ok(!stamped.text.includes('123.456.789-00') && !existsSync(join(dir, '2-b.pdf')));
  rmSync(dir, { recursive: true, force: true });
});

test('download de conteúdos: renova a sessão no 401, registra sem acesso e indisponível, e indexa o texto', async () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-23T22:00:00Z') });
  store.start('manual');
  store.ingest({ classified: classifyEndpoint(gw('v2/reports/v2/list?per_page=4&page=0')), url: 'u', status: 200, via: 'page', body: [
    { id: 1, title: 'Engie', slug: 'engie', type: 'analysis', published_at: '2026-11-19', user_metadata: { has_access: true } },
    { id: 2, title: 'Fechado', slug: 'fechado', type: 'analysis', published_at: '2026-11-18', user_metadata: { has_access: false } },
    { id: 3, title: 'Sumiu', slug: 'sumiu', type: 'e-reader', published_at: '2026-11-17', user_metadata: { has_access: true } },
    { id: 4, title: 'Vídeo', slug: 'video', type: 'video', published_at: '2026-11-16', user_metadata: { has_access: true } },
  ] });
  let token = 'old';
  let refreshed = 0;
  const calls = [];
  const request = async (url, headers) => {
    calls.push(url);
    if (headers['x-auth'] !== 'new') return { status: 401, contentType: 'application/json', body: Buffer.from('{}') };
    if (url.endsWith('/sumiu')) return { status: 404, contentType: 'application/json', body: Buffer.from('{}') };
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ title: 'Engie', content: [{ text: 'Tese de investimento em energia elétrica.' }] })) };
  };
  const result = await collectReportContents({ store, request, headers: () => ({ 'x-auth': token }), limit: 10, delayMs: 0, pdfDir: '/nao-usado',
    refreshAuth: async () => { refreshed++; token = 'new'; return true; } });
  assert.equal(refreshed, 1);
  assert.deepEqual({ ok: result.stats.ok, no_access: result.stats.no_access, unavailable: result.stats.unavailable, unsupported: result.stats.unsupported },
    { ok: 1, no_access: 1, unavailable: 1, unsupported: 1 });
  assert.ok(calls.every(url => !url.includes('fechado') && !url.includes('video')));
  assert.equal(store.db.prepare("SELECT report_key FROM report_text WHERE report_text MATCH 'eletrica'").get().report_key, '1');
  assert.equal(store.db.prepare("SELECT content_status FROM report_documents WHERE item_key='1'").get().content_status, 'ok');
  assert.equal(store.pendingReportContents(10).length, 0);
  // Access granted later: the report becomes pending again.
  store.ingest({ classified: classifyEndpoint(gw('v2/reports/v2/list?per_page=4&page=0')), url: 'u', status: 200, via: 'page',
    body: [{ id: 2, title: 'Fechado', slug: 'fechado', type: 'analysis', user_metadata: { has_access: true } }] });
  assert.deepEqual(store.pendingReportContents(10).map(r => r.item_key), ['2']);
  // Session lost for good: stops and reports it.
  token = 'old';
  const lost = await collectReportContents({ store, request, headers: () => ({ 'x-auth': token }), limit: 10, delayMs: 0, pdfDir: '/x', refreshAuth: async () => false });
  assert.equal(lost.authLost, true);
  store.close();
});

test('notificação só quando a coleta agendada precisa de atenção', () => {
  const fresh = { stale: false, hoursSinceData: 2 };
  assert.equal(notificationFor('0', fresh), null);
  assert.equal(notificationFor('4', fresh), null);
  assert.match(notificationFor('3', fresh).title, /login/);
  assert.match(notificationFor('2', fresh).title, /parcial/);
  assert.match(notificationFor('1', fresh).title, /falhou/);
  assert.match(notificationFor('timeout', fresh).title, /falhou/);
  assert.match(notificationFor('0', { stale: true, hoursSinceData: 75 }).message, /3 dia/);
  // Texts are quoted for PowerShell: a single quote cannot end the string.
  assert.ok(toastScript("a'b", 'c\nd').includes("'a''b'") && toastScript('x', 'c\nd').includes("'c d'"));
});

test('relatórios anteriores à data de corte: sem conteúdo e sem paginação', async () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-24T22:00:00Z') });
  store.start('timer');
  const r = store.ingest({ classified: classifyEndpoint(gw('v2/reports/v2/list?per_page=2&page=0')), url: 'u', status: 200, via: 'page', body: [
    { id: 10, title: 'Novo', slug: 'novo', type: 'e-reader', published_at: '2026-11-24T11:00:00Z', user_metadata: { has_access: true } },
    { id: 9, title: 'Antigo', slug: 'antigo', type: 'e-reader', published_at: '2026-11-20T11:00:00Z', user_metadata: { has_access: true } },
  ] });
  assert.equal(r.latestPublished.slice(0, 10), '2026-11-24');
  assert.deepEqual(store.pendingReportContents(10, 3, '2026-11-23').map(x => x.item_key), ['10']);
  assert.equal(store.pendingReportContents(10, 3).length, 2);
  assert.deepEqual(store.contentCounts('2026-11-23'), { pendente: 1 });
  store.close();
  const config = await loadDailyConfig('suno-daily.config.json');
  assert.match(config.reportsSince, /^\d{4}-\d{2}-\d{2}$/);
});

test('paginação de relatórios para na data de corte', async () => {
  const store = new KnowledgeStore(':memory:', { now: () => new Date('2026-11-24T22:00:00Z') });
  store.start('timer');
  const url = gw('v2/reports/v2/list?per_page=2&page=0');
  const page = n => [{ id: 100 - 2 * n, published_at: `2026-11-${24 - 2 * n}T11:00:00Z` }, { id: 99 - 2 * n, published_at: `2026-11-${23 - 2 * n}T11:00:00Z` }];
  const requested = [];
  const fetchPage = async target => { const n = Number(new URL(target).searchParams.get('page')); requested.push(n);
    return { status: () => 200, json: async () => page(n) }; };
  const config = { reportsSince: '2026-11-23', navigationTimeoutMs: 1000, pagination: { delayMs: 0, maxBulkItems: 0, maxPagesPerSeries: { default: 50 } } };
  const series = (lastLatest, fresh = 2) => ({ url, info: paginationOf(url), headers: {}, classified: classifyEndpoint(url), lastCount: 2,
    keys: new Set(['100', '99']), fresh, total: null, lastLatest, firstPosition: 0, done: false });
  const recorder = { full: false, stats: { stored: 0, items: 0 }, series: new Map([['s', series('2026-11-24T11:00:00Z')]]) };
  await paginate(fetchPage, recorder, store, config, () => {});
  assert.deepEqual(requested, [1]);   // page 1 is already before the cutoff: stop
  recorder.series = new Map([['s', series('2026-11-20T11:00:00Z')]]);
  await paginate(fetchPage, recorder, store, config, () => {});
  assert.deepEqual(requested, [1]);   // the page itself loaded only old reports: no paging
  store.close();
});
