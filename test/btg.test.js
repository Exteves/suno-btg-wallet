import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, selectCollectionPaths } from '../src/config.js';
import { Store } from '../src/database.js';
import { classifyCategory, catalogProducts } from '../src/catalog.js';
import { unsafeControlLabel, scopedUrl, maySend, sourceKind, discoverCatalogRoute, collectionPolicy } from '../src/policy.js';
import { allocate, savePlan } from '../src/allocation.js';
import { inspectCatalogQuery, catalogPostDecision } from '../src/catalog-query.js';

const config = await loadConfig('btg.config.json');
const url = `${config.baseUrl}/produtos-de-investimento/renda-fixa?page=2`;
function snapshot() {
  return { title: 'Catálogo de testes', headings: ['Renda fixa'], activeTabs: ['Renda fixa'],
    ownership: 'catalog_offer', text: 'Produtos sintéticos', sourceUrl: url, cards: [], links: [], productBlocks: [],
    tables: [{ caption: 'Ofertas', headers: ['Produto', 'Emissor', 'Taxa', 'Vencimento', 'Aplicação mínima', 'Tipo', 'Campo adicional'],
      rows: [['CDB Exemplo', 'Banco Fictício', '105,50% CDI', '01/01/2031', 'R$ 1.000,00', 'CDB', 'literal']] }],
  };
}

test('BTG config only permits its own catalog, never Suno sessions or trade/account links', () => {
  assert.equal(config.provider, 'btg');
  assert.equal(config.loginPath, '/login');
  assert.equal(config.entryPath, '/produtos-de-investimento');
  assert.equal(scopedUrl(config.loginPath, config), null); // Login is only allowed before the collection guard is installed.
  assert.equal(config.seedPaths.length, 5);
  assert.equal(sourceKind(url, config), 'btg_catalog');
  assert.equal(scopedUrl(url, config), url);
  for (const path of ['/produtos-de-investimento/comprar/1', '/produtos-de-investimento/investir/1', '/produtos-de-investimento/enviar-ordem', '/produtos-de-investimento/boleta/1', '/conta', 'https://investidor.suno.com.br/portfolio']) {
    assert.equal(scopedUrl(path, config), null, path);
  }
  for (const label of ['Investir', 'Aplicar', 'Comprar', 'Vender', 'Resgatar', 'Enviar ordem', 'Simular', 'Reservar']) assert.equal(unsafeControlLabel(label), true, label);
  for (const label of ['Ver detalhes', 'Fechar', 'Renda fixa', 'Próxima página']) assert.equal(unsafeControlLabel(label), false, label);
  const request = { method: () => 'GET', url: () => `${config.baseUrl}/conta`, isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) };
  assert.equal(maySend(request, config), false);
  assert.equal(discoverCatalogRoute('/renda-fixa', 'Renda fixa', config), '/renda-fixa');
  assert.equal(discoverCatalogRoute('/produtos-de-investimento/investir', 'Renda fixa', config), null);
  assert.equal(discoverCatalogRoute('/home', 'Renda fixa', config), null);
  assert.equal(discoverCatalogRoute('https://other.test/renda-fixa', 'Renda fixa', config), null);
});

test('BTG collects only the five requested routes, with no sibling, descendant or category discovery escape', () => {
  const only = collectionPolicy(config);
  const paths = ['/produtos-de-investimento/renda-fixa/credito-bancario', '/produtos-de-investimento/renda-fixa/titulos-publicos',
    '/produtos-de-investimento/renda-fixa/tesouro-direto', '/produtos-de-investimento/renda-fixa', '/produtos-de-investimento/fundos-de-investimento'];
  assert.deepEqual(config.seedPaths, paths);
  assert.deepEqual(config.collectionPaths, paths);
  assert.equal(config.followDiscoveredLinks, false);
  assert.equal(config.autoTabs, false);
  assert.equal(config.autoCategoryButtons, false);
  assert.equal(config.views.length, 0);
  for (const path of paths) assert.equal(scopedUrl(path, only), new URL(path, config.baseUrl).href);
  for (const path of ['/produtos-de-investimento', '/produtos-de-investimento/criptoativos', '/produtos-de-investimento/renda-variavel',
    '/produtos-de-investimento/renda-fixa/outro', '/produtos-de-investimento/fundos-de-investimento/detalhes/1']) {
    assert.equal(scopedUrl(path, only), null, path);
    assert.equal(discoverCatalogRoute(path, 'Renda fixa', only), null, path);
    const request = { method: () => 'GET', url: () => new URL(path, config.baseUrl).href,
      isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) };
    assert.equal(maySend(request, only, 'Renda fixa'), false, path);
  }
  // Login/CDP can still attach to the landing page before collection begins.
  assert.equal(scopedUrl('/produtos-de-investimento', config), `${config.baseUrl}/produtos-de-investimento`);
});

test('collection configuration rejects malformed route lists, seeds outside the list, and invalid scroll limits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collection-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  for (const change of [{ collectionPaths: [] }, { collectionPaths: 'all' },
    { collectionPaths: ['/produtos-de-investimento/renda-fixa?token=PRIVATE'] },
    { collectionPaths: ['https://other.test/renda-fixa'] }, { collectionPaths: ['/conta'] },
    { seedPaths: ['/produtos-de-investimento/criptoativos'] }, { followDiscoveredLinks: 'false' },
    { scrollIdleMs: 0 }, { scrollBottomSamples: 0 }, { maxScrollDurationMs: config.scrollIdleMs },
    { scrollNoProgressMs: config.scrollIdleMs }, { progressIntervalMs: 0 },
    { scrollDurationByPath: [] }, { scrollDurationByPath: 'PRIVATE' },
    { scrollDurationByPath: { '/produtos-de-investimento/fundos-de-investimento': 0 } },
    { scrollDurationByPath: { '/produtos-de-investimento/fundos-de-investimento': config.scrollIdleMs } },
    { scrollDurationByPath: { '/produtos-de-investimento/fundos-de-investimento': 900000.5 } },
    { scrollDurationByPath: { '/produtos-de-investimento/criptoativos': 900000 } },
    { scrollDurationByPath: { '/produtos-de-investimento/fundos-de-investimento?token=PRIVATE': 900000 } },
    { scrollReloadAttempts: -1 }, { scrollReloadAttempts: 1.5 }, { scrollReloadAttempts: 3 }, { scrollReloadAttempts: 'PRIVATE' }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change }));
    await assert.rejects(loadConfig(path), error => !error.message.includes('PRIVATE'));
  }
});

test('only-path selects existing catalog seeds and narrows coverage without changing login or widening navigation', () => {
  const funds = '/produtos-de-investimento/fundos-de-investimento';
  const selected = selectCollectionPaths(config, [funds, funds]);
  assert.deepEqual(selected.seedPaths, [funds]);
  assert.deepEqual(selected.collectionPaths, [funds]);
  assert.deepEqual(selected.expectedCategories, ['investment_funds']);
  assert.equal(selected.maxPages, 1);
  assert.equal(selected.entryPath, config.entryPath);
  assert.equal(selected.loginPath, config.loginPath);
  assert.equal(selected.scrollDurationByPath[funds], 900000);
  assert.equal(config.seedPaths.length, 5);
  assert.deepEqual(config.expectedCategories, ['fixed_income', 'investment_funds']);
  assert.equal(scopedUrl('/produtos-de-investimento/renda-fixa', collectionPolicy(selected)), null);
  for (const path of ['/produtos-de-investimento/criptoativos', '/conta', funds + '?token=PRIVATE', 'https://other.test' + funds]) {
    assert.throws(() => selectCollectionPaths(config, [path]), error => !error.message.includes('PRIVATE'));
  }
  assert.throws(() => selectCollectionPaths({ ...config, provider: 'suno' }, [funds]));
});

test('the observed Produto e risco header identifies fixed-income rows while preserving its literal combined value', () => {
  const data = snapshot();
  data.tables = [{ caption: '', headers: ['Produto e risco', 'Vencimento', 'Taxa', 'Aplicação mínima', 'Estoque', ''],
    rows: [['CDB Banco Sintético\nRisco médio', '01/01/2031', '110% CDI', 'R$ 100,00', 'R$ 5.000,00', 'Investir']] }];
  const [product] = catalogProducts(data, { url, view: 'default', config });
  assert.equal(product.name, 'CDB Banco Sintético\nRisco médio');
  assert.equal(product.raw_fields['Produto e risco'], product.name);
  assert.equal(product.raw_fields.Estoque, 'R$ 5.000,00');
  assert.equal(product.category, 'fixed_income');
});

test('catalog stores literal product fields and provenance without inventing currency, rate conversions or availability', () => {
  const data = snapshot();
  const products = catalogProducts(data, { url, view: 'default', config });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'CDB Exemplo');
  assert.equal(products[0].category, 'fixed_income');
  assert.equal(products[0].rate_text, '105,50% CDI');
  assert.equal(products[0].minimum_text, 'R$ 1.000,00');
  assert.equal(products[0].identity, null);
  assert.equal(products[0].currency, undefined);
  assert.equal(products[0].raw_fields['Campo adicional'], 'literal');
  data.tables[0].rows.push(['CDB Exemplo', 'Outro Banco Fictício', '106% CDI', '01/01/2031', 'R$ 1.000,00', 'CDB', 'outro']);
  const both = catalogProducts(data, { url, view: 'default', config });
  assert.equal(both.length, 2);
  assert.notEqual(both[0].fingerprint, both[1].fingerprint);
});

test('classification keeps BDRs, ETFs and generic funds separate from international stocks and FIIs', () => {
  assert.equal(classifyCategory('Ações internacionais'), 'international_equities');
  assert.equal(classifyCategory('Ações brasileiras'), 'brazilian_equities');
  assert.equal(classifyCategory('Fundos imobiliários'), 'real_estate_funds');
  assert.equal(classifyCategory('Fundos de investimento'), 'investment_funds');
  assert.equal(classifyCategory('BDRs de ações internacionais'), 'bdr');
  assert.equal(classifyCategory('ETF de ações brasileiras'), 'etf');
  assert.equal(classifyCategory('Ações'), 'unknown');
  assert.equal(classifyCategory('Renda fixa e ações brasileiras'), 'unknown');
});

test('product blocks and configured field aliases preserve identifiers without fabricating products from unlabelled text', () => {
  const data = snapshot();
  data.tables = [];
  data.productBlocks = [
    { name: 'Fundo de teste', fields: { Ticker: 'TEST11', Categoria: 'FII' }, text: 'Liquidez: D+2\nRisco: Alto' },
    { name: '', fields: {}, text: 'Texto não identificado' },
  ];
  const products = catalogProducts(data, { url, view: 'default', config });
  assert.equal(products.length, 1);
  assert.equal(products[0].identity, 'ticker:TEST11');
  assert.equal(products[0].category, 'real_estate_funds');
  assert.equal(products[0].liquidity_text, 'D+2');
  data.productBlocks = [{ name: 'Empresa de teste', fields: { Tipo: 'Ações', Ticker: 'EXMP' }, text: '' }];
  data.activeTabs = ['Ações internacionais'];
  data.headings = ['Produtos de investimento'];
  assert.equal(catalogProducts(data, { url, view: 'default', config: { ...config, categoryPathMappings: [] } })[0].category, 'international_equities');
});

test('vertical offer tables use their associated title and preserve historical returns without calling them an offered rate', () => {
  const data = snapshot();
  data.tables = [{ headers: [], rows: [['Rentab. 12M', '9,20%'], ['Aplicação min.', 'R$ 500,00']] }];
  assert.equal(catalogProducts(data, { url, view: 'default', config }).length, 0);
  data.productBlocks = [{ name: 'Fundo sintético', fields: Object.fromEntries(data.tables[0].rows), text: '' }];
  const [product] = catalogProducts(data, { url, view: 'default', config });
  assert.equal(product.name, 'Fundo sintético');
  assert.equal(product.minimum_text, 'R$ 500,00');
  assert.equal(product.raw_fields['Rentab. 12M'], '9,20%');
  assert.equal(product.rate_text, undefined);
});

test('a category tile can navigate only to recognized catalog routes during its click; write guards remain active', () => {
  const request = (path, method = 'GET') => ({ method: () => method, url: () => new URL(path, config.baseUrl).href,
    isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) });
  assert.equal(maySend(request('/renda-fixa'), config), false);
  assert.equal(maySend(request('/renda-fixa'), config, 'Renda Fixa'), true);
  for (const path of ['/conta', '/home', '/renda-fixa/comprar', '/renda-fixa?token=secret', 'https://other.test/renda-fixa']) {
    assert.equal(maySend(request(path), config, 'Renda Fixa'), false, path);
  }
  assert.equal(maySend(request('/renda-fixa', 'POST'), config, 'Renda Fixa'), false);
});

test('fund-page dependency permits only an exact first-party data GET, never an account write, navigation or subscription', () => {
  const only = collectionPolicy(config);
  const path = '/investments/api/fund-subscription/v2/account';
  const request = (url, method = 'GET', type = 'fetch', navigation = false) => ({ method: () => method,
    url: () => new URL(url, config.baseUrl).href, resourceType: () => type, isNavigationRequest: () => navigation,
    frame: () => ({ parentFrame: () => null }) });
  assert.equal(maySend(request(path), only), true);
  assert.equal(maySend(request(path, 'POST'), only), false);
  assert.equal(maySend(request(path, 'DELETE'), only), false);
  assert.equal(maySend(request(path, 'GET', 'document', true), only), false);
  assert.equal(maySend(request(path, 'GET', 'script'), only), false);
  assert.equal(maySend(request(`${path}/orders`), only), false);
  assert.equal(maySend(request(`${path}/12345`), only), false);
  assert.equal(maySend(request('https://other.test' + path), only), false);
  assert.equal(maySend(request('/investments/api/preferences/post-select-account', 'POST'), only), false);
});

test('observed fixed-income, government-bond and treasury catalog endpoints permit only exact first-party GET reads', () => {
  const only = collectionPolicy(config);
  const paths = ['/investments/api/fixed-income/accounts/TEST-ACCOUNT/fixedincomes',
    '/investments/api/fixed-income/combo/account/TEST-ACCOUNT', '/investments/api/government-bond/account/TEST-ACCOUNT',
    '/investments/api/treasury/buy/account/TEST-ACCOUNT/bonds', '/investments/api/fund-subscription/v2/account'];
  const request = (path, method = 'GET', origin = config.baseUrl, type = 'xhr', navigation = false) => ({ method: () => method,
    url: () => new URL(path, origin).href, resourceType: () => type, isNavigationRequest: () => navigation,
    frame: () => ({ parentFrame: () => null }) });
  for (const path of paths) {
    assert.equal(maySend(request(path), only), true, path);
    assert.equal(maySend(request(path, 'GET', 'https://api.btgpactual.com'), only), true, path);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(maySend(request(path, method), only), false, `${method} ${path}`);
    assert.equal(maySend(request(path, 'GET', config.baseUrl, 'document', true), only), false, path);
    assert.equal(maySend(request(path + '/orders'), only), false, path);
    assert.equal(maySend(request(path + '?action=buy'), only), false, path);
    assert.equal(maySend(request(path, 'GET', 'https://btgpactual.com.other.test'), only), false, path);
    assert.equal(maySend(request(path, 'GET', 'http://api.btgpactual.com'), only), false, path);
    assert.equal(maySend(request(path, 'GET', 'https://api.btgpactual.com:8443'), only), false, path);
  }
  for (const path of ['/investments/api/treasury/buy/account/TEST-ACCOUNT/bonds/confirm',
    '/investments/api/fixed-income/accounts/TEST-ACCOUNT/orders', '/investments/api/other/account/TEST-ACCOUNT',
    '/investments/api/homebroker-onboarding/account/TEST-ACCOUNT/client/TEST-CLIENT/homebroker/status']) {
    assert.equal(maySend(request(path), only), false, path);
  }
  assert.equal(maySend(request(paths[0]), { ...only, provider: 'suno' }), false);
});

function catalogPost(path, source, body, { origin = config.baseUrl, navigation = false, resource = 'fetch', childFrame = false } = {}) {
  return { method: () => 'POST', url: () => new URL(path, origin).href, resourceType: () => resource,
    isNavigationRequest: () => navigation, frame: () => ({ url: () => new URL(source, config.baseUrl).href, parentFrame: () => childFrame ? {} : null }),
    postDataJSON: () => body };
}

test('observed catalog POST searches allow only query bodies on their own catalog page and exact endpoint', () => {
  const only = collectionPolicy(config);
  const fixed = '/investments/api/fixed-income/accounts/TEST-ACCOUNT/fixedincomes';
  const funds = '/investments/api/fund-subscription/v2/account';
  const creditPage = '/produtos-de-investimento/renda-fixa/credito-bancario';
  const fundsPage = '/produtos-de-investimento/fundos-de-investimento';
  const body = { accountNumber: 'PRIVATE-ACCOUNT', filters: { productTypes: ['CDB'], minimumAmount: 100,
    issuers: ['Banco sintético'], maturityFrom: null }, pagination: { page: 0, pageSize: 50 }, sortBy: 'maturity', sortDirection: 'ASC' };
  assert.equal(maySend(catalogPost(fixed, creditPage, body), only), true);
  assert.equal(maySend(catalogPost(funds, fundsPage, { accountNumber: 'PRIVATE-ACCOUNT', filters: { search: '', fundTypes: [] }, page: 1, pageSize: 100 }), only), true);
  assert.equal(maySend(catalogPost(funds, fundsPage, {}), only), true);
  for (const request of [catalogPost(fixed, fundsPage, body), catalogPost(funds, creditPage, body),
    catalogPost(fixed, creditPage, body, { origin: 'https://api.btgpactual.com' }),
    catalogPost(fixed, creditPage, body, { origin: 'https://other.test' }),
    catalogPost(fixed, creditPage, body, { navigation: true }), catalogPost(fixed, creditPage, body, { resource: 'document' }),
    catalogPost(fixed, creditPage, body, { childFrame: true }), catalogPost(fixed + '/orders', creditPage, body),
    catalogPost(funds + '/subscribe', fundsPage, body), catalogPost(fixed + '?action=buy', creditPage, body)]) {
    assert.equal(maySend(request, only), false);
  }
  assert.equal(maySend(catalogPost(fixed, creditPage, body), { ...only, provider: 'suno' }), false);
});

test('catalog POST validators reject financial instructions, credentials, nested mutations, unknown fields and unparseable bodies', () => {
  for (const field of ['amount', 'quantity', 'price', 'investmentAmount', 'fundId', 'productId', 'action', 'operation', 'order',
    'confirm', 'acceptTerms', 'subscription', 'password', 'token', 'signature', 'otp']) {
    const result = inspectCatalogQuery({ filters: { [field]: 'PRIVATE' } });
    assert.equal(result.allowed, false, field);
    assert.equal(result.reason, 'TRANSACTION_FIELD', field);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  for (const body of [null, [], 'PRIVATE', { arbitrary: 'PRIVATE' }, { page: -1 }, { pageSize: 2.5 },
    { accountNumber: { action: 'buy' } }, { filters: { issuer: { value: 'PRIVATE' } } },
    { search: 'x'.repeat(513) }, { filters: Array.from({ length: 101 }, () => ({})) }]) {
    assert.equal(inspectCatalogQuery(body).allowed, false);
  }
  assert.equal(inspectCatalogQuery({ query: 'mutation { buy }' }).allowed, false);
  assert.equal(inspectCatalogQuery({ query: 'subscription { orders }' }).allowed, false);
  const request = catalogPost('/investments/api/fund-subscription/v2/account', '/produtos-de-investimento/fundos-de-investimento', {});
  request.postDataJSON = () => { throw new Error('PRIVATE-BODY'); };
  assert.deepEqual(catalogPostDecision(request, config), { allowed: false, reason: 'BODY_UNAVAILABLE' });
  assert.equal(maySend(request, config), false);
});

test('credit sorting fields observed in run 10 are accepted while unknown and transaction fields remain denied', () => {
  assert.deepEqual(inspectCatalogQuery({ page: 1, orderByColumn: 'maturity', orderByDirection: 'ASC' }), { allowed: true, reason: 'READ_QUERY' });
  assert.equal(inspectCatalogQuery({ page: 1, orderByColumn: 'maturity', orderByDirection: 'ASC', amount: 1000 }).allowed, false);
  assert.equal(inspectCatalogQuery({ page: 1, orderByColumn: { operation: 'buy' } }).allowed, false);
});

test('shared SQLite separates BTG catalog observations from Suno recommendations and deduplicates snapshots', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start('start', config);
    const page = store.page(run, `${config.baseUrl}/produtos-de-investimento`, 'btg_catalog');
    const data = snapshot();
    assert.equal(store.save(page, 'Renda fixa', 1, data, [], config), true);
    assert.equal(store.save(page, 'Renda fixa', 1, data, [], config), false);
    const record = store.db.prepare('SELECT * FROM catalog_observations').get();
    assert.equal(record.provider, 'btg');
    assert.equal(record.source_url, url);
    assert.equal(record.availability, 'observed_in_catalog');
    assert.equal(record.rate_text, '105,50% CDI');
    assert.equal(store.db.prepare('SELECT count(*) n FROM catalog_products').get().n, 1);
    const sunoRun = store.start('start', { provider: 'suno' });
    const sunoPage = store.page(sunoRun, 'https://investidor.suno.com.br/carteiras/teste', 'suno_wallet_area');
    store.save(sunoPage, 'default', 0, { ...data, ownership: 'suno_recommendation' });
    assert.equal(store.db.prepare('SELECT count(*) n FROM catalog_products').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n, 2);
  } finally { store.close(); }
});

test('migration preserves existing v1 Suno history and adds provider/catalog/planning tables', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'btg-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'history.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
    purpose TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', config_json TEXT NOT NULL, summary_json TEXT);
    INSERT INTO runs(started_at,purpose,config_json,status) VALUES('2020-01-01','start','{}','captured');
    PRAGMA user_version=1;`);
  old.close();
  const store = new Store(path);
  try {
    assert.equal(store.db.prepare('SELECT provider FROM runs WHERE id=1').get().provider, 'suno');
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=1').get().status, 'captured');
    const run = store.start('start', config);
    assert.equal(store.db.prepare('SELECT provider FROM runs WHERE id=?').get(run).provider, 'btg');
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { store.close(); }
});

test('allocation follows user weights exactly, conserves every cent and never turns a target into an existing position', () => {
  const input = { name: 'Synthetic plan', capital_cents: 10001, currency: 'BRL', source_note: 'Synthetic user-defined target',
    targets: [{ asset_class: 'a', weight_basis_points: 3333 }, { asset_class: 'b', weight_basis_points: 3333 }, { asset_class: 'c', weight_basis_points: 3334 }] };
  const result = allocate(input);
  assert.deepEqual(result.targets.map(target => target.amount_cents), [3333, 3333, 3335]);
  assert.equal(result.targets.reduce((sum, target) => sum + target.amount_cents, 0), input.capital_cents);
  assert.throws(() => allocate({ ...input, targets: input.targets.slice(1) }));
  assert.throws(() => allocate({ ...input, targets: [{ asset_class: 'a', weight_basis_points: 5000 }, { asset_class: 'a', weight_basis_points: 5000 }] }));
  const store = new Store(':memory:');
  try {
    const id = savePlan(store, input);
    assert.equal(savePlan(store, input), id);
    assert.equal(store.db.prepare('SELECT count(*) n FROM allocation_plans').get().n, 1);
    assert.equal(store.db.prepare('SELECT sum(amount_cents) n FROM allocation_targets').get().n, input.capital_cents);
    assert.equal(store.db.prepare('SELECT count(*) n FROM records').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM catalog_products').get().n, 0);
  } finally { store.close(); }
});
