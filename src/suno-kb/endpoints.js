import { diagnosticPath, redact } from '../privacy.js';

// Suno front-end (investidor.suno.com.br) reads its data from this gateway.
// Mapped from the public JavaScript bundles on 2026-11-23; shapes of the
// responses still need confirmation in an authenticated run.
export const GATEWAY_HOST = 'membros-api-gateway.suno.com.br';
export const GATEWAY_PREFIX = '/api/';

// Personal areas (own portfolio, broker integrations, transactions, profile)
// and actions are never stored, even when the page loads them.
const personal = [
  /^v\d\/user(?:\/|$)/i, /^v\d\/wallets\/(?:getMyWallet|patrimony|earning|allEarning|assetEarning|movements|transaction|insert|update|change|manualSwap|syncronization|inconsistenc|walletInconsistenc|getAllBrokers|createOrUpdateCEI|createUserAndToken|saveToken|verifyAuthenticate|allWalletsMyInvest|assetsFixedIncomePositions|profitability|compositionVolatility|generalStatisticsCategory|fixedIncomeAssets|walletCorporativeEvents|logout)/i,
  /^v\d\/(?:api\/)?Wallet\//, /^v\d\/BrokerIntegration\//i, /MyInvestiments/i,
  /^v\d\/reports\/(?:bookmarks|ereader|view)/i, /^v\d\/reports\/view/i, /^v\d\/pdf\//i,
  /^v\d\/(?:suno\/)?notifications?\//i, /^v\d\/events\//i, /^v\d\/auth\//i,
];

const rules = [
  { kind: 'report', pattern: /^v2\/reports\/v2\/(?:custom\/)?list$/ },
  { kind: 'report', pattern: /^v2\/reports\/list$/ },
  // The /relatorios page searches with an empty term; only its report list is kept.
  { kind: 'report', pattern: /^v2\/search$/, collections: ['report.list'] },
  { kind: 'report', pattern: /^v1\/reports\/users\/[^/]+\/search$/, template: 'v1/reports/users/{user}/search' },
  { kind: 'report_radar', pattern: /^v1\/reports\/radar-fiis\/resume$/ },
  { kind: 'wallet_asset', pattern: /^v1\/wallets\/assets$/ },
  { kind: 'wallet_asset', pattern: /^v1\/wallets\/assets\/[^/]+$/, template: 'v1/wallets/assets/{wallet}' },
  { kind: 'wallet_group', pattern: /^v1\/wallets\/user\/[^/]+\/groups$/, template: 'v1/wallets/user/{user}/groups' },
  { kind: 'wallet_event', pattern: /^v1\/wallets\/wallets-events$/ },
  { kind: 'coverage', pattern: /^v1\/wallets\/coverage-universe$/ },
  { kind: 'fund', pattern: /^v1\/nossos-fundos$/ },
  { kind: 'wallet_info', pattern: /^v1\/wallets\/(?:banking-issuers-rating|highs-lows|fiis-highs-lows|wallets-by-ticker)$/ },
  { kind: 'wallet_info', pattern: /^v1\/wallets\/(?:benchmark-rentability|bias)(?:\/[^/]+)?$/, template: path => path.split('/').slice(0, 3).join('/') + (path.split('/').length > 3 ? '/{id}' : '') },
  { kind: 'wallet_info', pattern: /^v1\/wallets\/provents\/fii\/[^/]+$/, template: 'v1/wallets/provents/fii/{ticker}' },
  { kind: 'wallet_info', pattern: /^v1\/wallets\/[0-9a-f-]{36}\/benchmark-rentability$/, template: 'v1/wallets/{wallet}/benchmark-rentability' },
];

// Query parameters that identify the user are dropped before storage.
const personalQuery = /^(?:user_?id|userId|wp_?user_?id|wpUserId|email|cpf|token|access_?token|auth)$/i;

export const CUMULATIVE_KINDS = new Set(['report', 'wallet_event']);
export const DAILY_SCOPED_KINDS = new Set(['wallet_asset', 'wallet_group', 'wallet_info', 'coverage', 'fund', 'report_radar']);

export function classifyEndpoint(raw, method = 'GET') {
  let url;
  try { url = new URL(raw); } catch { return { decision: 'ignored' }; }
  if (url.hostname !== GATEWAY_HOST || url.protocol !== 'https:' || url.username || url.password || url.port
    || !url.pathname.startsWith(GATEWAY_PREFIX)) return { decision: 'ignored' };
  const path = decodeURIComponent(url.pathname.slice(GATEWAY_PREFIX.length)).replace(/\/+$/, '');
  const shape = diagnosticPath(url.pathname);
  if (method !== 'GET') return { decision: 'not_get', shape };
  if (personal.some(pattern => pattern.test(path))) return { decision: 'personal', shape };
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    const template = typeof rule.template === 'function' ? rule.template(path) : rule.template ?? path;
    return { decision: 'stored', kind: rule.kind, template, path, shape, query: safeQuery(url), pathParam: path.split('/').at(-1),
      ...(rule.collections ? { collections: rule.collections } : {}) };
  }
  return { decision: 'unclassified', shape };
}

export function safeQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (personalQuery.test(key.replace(/\[\]$/, ''))) continue;
    const clean = redact(value);
    if (key in query) query[key] = [].concat(query[key], clean);
    else query[key] = clean;
  }
  return query;
}

// The stored URL keeps the route shape and non-personal parameters only.
export function storedUrl(raw) {
  const url = new URL(raw);
  // Only the user's id is removed from the path; wallet/asset ids are content.
  const path = redact(decodeURIComponent(url.pathname)).replace(/(\/users?\/)(?!refresh-token|show-)[^/]+/gi, '$1[REMOVIDO]');
  const out = new URL(`https://${url.hostname}${path}`);
  for (const [key, value] of url.searchParams) if (!personalQuery.test(key.replace(/\[\]$/, ''))) out.searchParams.append(key, redact(value));
  return out.href;
}

const pageKeys = ['page', 'pagina', 'p'];
const offsetKeys = ['offset', 'skip', 'start'];
const sizeKeys = ['per_page', 'perPage', 'limit', 'size', 'pageSize', 'page_size'];

// Pagination is inferred from the query the page itself sent. Only the
// position parameter changes; filters and page size stay as observed.
export function paginationOf(raw) {
  const url = new URL(raw);
  const pageKey = pageKeys.find(key => url.searchParams.has(key) && /^\d+$/.test(url.searchParams.get(key)));
  const offsetKey = offsetKeys.find(key => url.searchParams.has(key) && /^\d+$/.test(url.searchParams.get(key)));
  const sizeKey = sizeKeys.find(key => url.searchParams.has(key) && /^\d+$/.test(url.searchParams.get(key)));
  if (!pageKey && !offsetKey) return null;
  const series = new URL(url);
  for (const key of [pageKey, offsetKey].filter(Boolean)) series.searchParams.delete(key);
  series.searchParams.sort();
  return {
    seriesKey: series.href, pageKey, offsetKey, sizeKey,
    position: Number(url.searchParams.get(pageKey || offsetKey)),
    size: sizeKey ? Number(url.searchParams.get(sizeKey)) : null,
  };
}

// Same query asking for every item at once (first position, size = total).
export function bulkUrl(raw, info, total, firstPosition = 0) {
  const url = new URL(raw);
  // Lists may be 0- or 1-based: reuse the first position the page itself asked for.
  if (info.pageKey) url.searchParams.set(info.pageKey, String(firstPosition));
  else url.searchParams.set(info.offsetKey, '0');
  url.searchParams.set(info.sizeKey || 'limit', String(total));
  return url.href;
}

export function nextPageUrl(raw, info, itemCount) {
  const url = new URL(raw);
  if (info.pageKey) url.searchParams.set(info.pageKey, String(info.position + 1));
  else url.searchParams.set(info.offsetKey, String(info.position + (info.size || itemCount)));
  return url.href;
}
