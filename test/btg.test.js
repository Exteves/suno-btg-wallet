import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/database.js';
import { classifyCategory, catalogProducts } from '../src/catalog.js';
import { unsafeControlLabel, scopedUrl, maySend, sourceKind, discoverCatalogRoute } from '../src/policy.js';
import { allocate, savePlan } from '../src/allocation.js';

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
  assert.deepEqual(config.seedPaths, ['/produtos-de-investimento']);
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
  assert.equal(catalogProducts(data, { url, view: 'default', config })[0].category, 'international_equities');
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
