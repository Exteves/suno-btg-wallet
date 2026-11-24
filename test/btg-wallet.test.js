import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOCATION_PATH, parseAllocation } from '../src/btg-wallet/parse.js';
import { WalletStore } from '../src/btg-wallet/store.js';
import { scrubWallet } from '../src/btg-wallet/scrub.js';

// Synthetic, in the shape mapped on 2026-11-24 (no real account data).
const stock = (ticker, quantity, price) => ({ accountNumber: '123456', ticker, isinCode: `BR${ticker}`, description: `${ticker}  ON   NM`,
  quantity, marketPrice: price, grossValue: quantity * price, incomeTax: 0, investedValue: quantity * price * 0.9, averagePrice: price * 0.9,
  sectorDescription: 'SETOR', lastTradeTime: '0001-01-01T00:00:00.000-0300' });
const fixture = () => ({
  accountNumber: '123456', positionDate: '2026-11-24T00:00:00.000-0300', totalAmmount: 1350,
  summary: [
    { id: 'CC', name: 'Conta Investimento', positionValue: 100, assets: { _type: 'market' } },
    { id: 'VT', name: 'Valores em Trânsito', positionValue: 0, assets: { _type: 'market' } },
    { id: 'RV', name: 'Renda Variável', positionValue: 750, assets: { _type: 'market', equity: {
      equityStock: { total: 500, equityStockPositions: [stock('AAAA3', 10, 30), stock('BBBB4', 20, 10)] },
      equityListedFunds: { total: 250, equityStockPositions: [stock('CCCC11', 25, 10)] },
      equityETF: { total: null, equityStockPositions: [] },
      equityStructuredProduct: { structuredProductsPositions: null, total: null },
    } } },
    { id: 'RF', name: 'Renda Fixa', positionValue: 500, assets: { _type: 'market', fixedIncomes: [{
      accountNumber: '123456', accountingGroupCode: 'CDB', ticker: 'CDB-XYZ', issuer: 'BANCO X', quantity: 1, price: 500,
      grossValue: 500, netValue: 490, totalInitialInvestment: 450, averageCostPrice: 450, incomeTax: 10, iofTax: 0,
      issueDate: '2025-01-08T00:00:00.000-0300', maturityDate: '2027-05-06T00:00:00.000-0300', referenceIndexName: 'CDI',
      indexYieldRate: '101,75% do CDI', rateType: 'POS', isDailyLiquidity: false, cetipCode: 'CDBXYZ',
      fixedIncomeAcquisitions: [{ accountNumber: '123456', tradeId: 99, transferId: '77' }],
    }] } },
  ],
});

test('allocation path matches only the consolidated MARKET summary', () => {
  assert.ok(ALLOCATION_PATH.test('/investments/api/statement-position/allocation/123/type/MARKET/summary'));
  assert.ok(!ALLOCATION_PATH.test('/investments/api/statement-position/summary/balance'));
  assert.ok(!ALLOCATION_PATH.test('/investments/api/statement-position/allocation/123/type/MARKET/summary/x'));
});

test('parses equities by sub-list and fixed income, with totals reconciled', () => {
  const parsed = parseAllocation(fixture());
  assert.equal(parsed.positionDate, '2026-11-24');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.positions.map(p => [p.classId, p.category, p.ticker]),
    [['RV', 'acao', 'AAAA3'], ['RV', 'acao', 'BBBB4'], ['RV', 'fii', 'CCCC11'], ['RF', 'CDB', 'CDB-XYZ']]);
  const cdb = parsed.positions[3];
  assert.equal(cdb.maturityDate, '2027-05-06');
  assert.equal(cdb.netValue, 490);
  assert.equal(cdb.rate, '101,75% do CDI');
  assert.equal(parsed.positions[0].description, 'AAAA3 ON NM');
});

test('account identifiers and trade ids never reach the stored JSON', () => {
  const parsed = parseAllocation(fixture());
  const text = JSON.stringify(parsed.raw) + JSON.stringify(parsed.positions.map(p => p.raw));
  assert.ok(!text.includes('123456'));
  assert.ok(!text.includes('"tradeId":99'));
  assert.equal(scrubWallet({ cpf: '1', nested: { email: 'a@b.c', ticker: 'X' } }).nested.ticker, 'X');
});

test('unknown class and mismatched totals are reported, not guessed', () => {
  const body = fixture();
  body.summary.push({ id: 'FD', name: 'Fundos', positionValue: 10, assets: { _type: 'market', funds: [] } });
  body.summary[2].positionValue = 700;
  const parsed = parseAllocation(body);
  assert.deepEqual(parsed.issues.map(i => i.code), ['CLASS_TOTAL_MISMATCH', 'CLASS_NOT_PARSED', 'TOTAL_MISMATCH']);
  assert.equal(parseAllocation({ foo: 1 }).error, 'UNEXPECTED_FORMAT');
});

test('snapshots accumulate and the latest views show shares of the total', () => {
  const store = new WalletStore(':memory:');
  store.saveSnapshot(parseAllocation(fixture()), { source: 'test', capturedAt: '2026-11-24T10:00:00Z' });
  const second = fixture();
  second.summary[0].positionValue = 50; second.totalAmmount = 1300;
  const { id, status } = store.saveSnapshot(parseAllocation(second), { source: 'test', capturedAt: '2026-12-01T10:00:00Z' });
  assert.deepEqual([id, status], [2, 'ok']);
  const latest = store.latest();
  assert.equal(latest.total_value, 1300);
  assert.equal(latest.positions.length, 4);
  assert.equal(latest.classes.find(c => c.class_id === 'RF').pct_of_total, 38.46);
  assert.equal(store.db.prepare('SELECT count(*) n FROM positions').get().n, 8);
  store.close();
});
