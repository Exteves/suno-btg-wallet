// Normalizes the BTG consolidated position, as loaded by the app's home page:
// GET /investments/api/statement-position/allocation/{account}/type/MARKET/summary
// (format mapped 2026-11-24). Classes: CC (conta investimento), VT (valores em
// trânsito), RV (renda variável, by sub-list) and RF (renda fixa, one row per
// title). Unknown classes are kept as totals and reported, never guessed.
import { scrubWallet } from './scrub.js';

export const ALLOCATION_PATH = /^\/investments\/api\/statement-position\/allocation\/[^/]+\/type\/MARKET\/summary$/;
const CASH_CLASSES = new Set(['CC', 'VT']);
const EQUITY_CATEGORY = {
  equityStock: 'acao', equityFII: 'fii', equityListedFunds: 'fii', equityETF: 'etf', equityBDR: 'bdr',
  equityOption: 'opcao', equityForward: 'termo', equityStockLending: 'aluguel', equityCollateral: 'garantia',
  equityRecommendedPortfolio: 'carteira_recomendada', equityStructuredProduct: 'estruturado',
};

const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !value.startsWith('0001') ? value.slice(0, 10) : null;
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim().replace(/\s{2,}/g, ' ') : null;
const round2 = value => Math.round(value * 100) / 100;

function equityPosition(category, p) {
  return {
    category, ticker: text(p.ticker), isin: text(p.isinCode), description: text(p.description), issuer: text(p.issuer),
    sector: text(p.sectorDescription), quantity: num(p.quantity), price: num(p.marketPrice),
    grossValue: num(p.grossValue), netValue: num(p.grossValue) === null ? null : p.grossValue - (num(p.incomeTax) || 0),
    investedValue: num(p.investedValue), averagePrice: num(p.averagePrice), incomeTax: num(p.incomeTax), iofTax: null,
    issueDate: null, maturityDate: null, indexName: null, rate: null, rateType: null, dailyLiquidity: null,
  };
}

function fixedIncomePosition(p) {
  return {
    category: text(p.accountingGroupCode) || 'renda_fixa', ticker: text(p.ticker), isin: text(p.isin) || text(p.cetipCode),
    description: text(p.ticker), issuer: text(p.issuer), sector: null, quantity: num(p.quantity), price: num(p.price),
    grossValue: num(p.grossValue), netValue: num(p.netValue), investedValue: num(p.totalInitialInvestment),
    averagePrice: num(p.averageCostPrice), incomeTax: num(p.incomeTax), iofTax: num(p.iofTax),
    issueDate: day(p.issueDate), maturityDate: day(p.maturityDate), indexName: text(p.referenceIndexName),
    rate: text(p.indexYieldRate), rateType: text(p.rateType), dailyLiquidity: typeof p.isDailyLiquidity === 'boolean' ? p.isDailyLiquidity : null,
  };
}

// The position arrays inside one RV sub-list (field names vary by sub-list).
const positionArrays = list => Object.values(list || {}).filter(v => Array.isArray(v) && v.every(i => i && typeof i === 'object'));

export function parseAllocation(input) {
  const body = scrubWallet(input);
  if (!body || !Array.isArray(body.summary)) return { error: 'UNEXPECTED_FORMAT' };
  const classes = [];
  const positions = [];
  const issues = [];
  for (const group of body.summary) {
    const classId = text(group?.id) || '?';
    const value = num(group?.positionValue);
    const parsed = [];
    const assets = group?.assets || {};
    if (classId === 'RV' && assets.equity) {
      for (const [key, list] of Object.entries(assets.equity)) {
        const items = positionArrays(list).flat();
        if (items.length && !EQUITY_CATEGORY[key]) issues.push({ code: 'CATEGORY_UNKNOWN', classId, key });
        for (const p of items) parsed.push({ ...equityPosition(EQUITY_CATEGORY[key] || key, p), raw: p });
      }
    } else if (classId === 'RF' && Array.isArray(assets.fixedIncomes)) {
      for (const p of assets.fixedIncomes) parsed.push({ ...fixedIncomePosition(p), raw: p });
    } else if (!CASH_CLASSES.has(classId) && value) {
      issues.push({ code: 'CLASS_NOT_PARSED', classId, name: text(group?.name) });
    }
    if (parsed.length && value !== null) {
      const sum = parsed.reduce((total, p) => total + (p.grossValue || 0), 0);
      if (Math.abs(sum - value) > 0.05) issues.push({ code: 'CLASS_TOTAL_MISMATCH', classId, classValue: value, positionsSum: round2(sum) });
    }
    classes.push({ classId, name: text(group?.name), value, positions: parsed.length, parsed: parsed.length > 0 || CASH_CLASSES.has(classId) });
    positions.push(...parsed.map(p => ({ classId, ...p })));
  }
  const total = num(body.totalAmmount ?? body.totalAmount);
  const classSum = classes.reduce((sum, c) => sum + (c.value || 0), 0);
  if (total !== null && Math.abs(classSum - total) > 0.05) issues.push({ code: 'TOTAL_MISMATCH', total, classSum: round2(classSum) });
  return { positionDate: day(body.positionDate), total, classes, positions, issues, raw: body };
}
