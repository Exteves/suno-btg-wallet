import { createHash } from 'node:crypto';

// The gateway's JSON shapes are not documented. Every item is kept in full;
// these helpers only find the item lists and promote common fields for
// querying. Unknown shapes still land in the database untouched.

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const hashOf = value => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const isItemList = value => Array.isArray(value) && value.length > 0 && value.filter(isRecord).length >= Math.ceil(value.length / 2);

// Lists of objects anywhere in the response, not nested inside another list
// already chosen (an asset's own sub-arrays stay inside the asset).
export function findCollections(body, maxDepth = 5) {
  const found = [];
  const visit = (value, path, depth) => {
    if (depth > maxDepth) return;
    if (isItemList(value)) { found.push({ path: path || '$', items: value.filter(isRecord) }); return; }
    if (isRecord(value)) for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1);
  };
  visit(body, '', 0);
  // A response that is a single object (e.g. one fund or one wallet summary).
  if (!found.length && isRecord(body)) {
    const inner = ['data', 'result', 'value'].map(key => body[key]).find(isRecord);
    found.push({ path: inner ? '$.inner' : '$', items: [inner || body], single: true });
  }
  return found;
}

const candidates = {
  key: ['id', 'ID', '_id', 'uuid', 'guid', 'post_id', 'postId', 'report_id', 'reportId', 'asset_id', 'assetId', 'fund_id', 'slug', 'ticker', 'code', 'codigo', 'symbol'],
  ticker: ['ticker', 'Ticker', 'tickerSymbol', 'symbol', 'codigo', 'code', 'asset_code', 'assetCode', 'ativo', 'papel'],
  title: ['title', 'titulo', 'post_title', 'name', 'nome', 'company', 'companyName', 'company_name', 'razao_social', 'fantasy_name', 'fantasyName', 'label', 'description'],
  published: ['published_at', 'publishedAt', 'publish_date', 'post_date', 'date', 'data', 'created_at', 'createdAt', 'date_gmt', 'updated_at', 'updatedAt'],
};

function pick(item, names, nestedKeys = ['asset', 'assets', 'ativo', 'company', 'fund', 'report', 'post']) {
  for (const name of names) {
    const value = item[name];
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') return String(value);
    if (isRecord(value) && typeof value.rendered === 'string') return value.rendered; // WordPress style
  }
  for (const nested of nestedKeys) if (isRecord(item[nested])) {
    const value = pick(item[nested], names, []);
    if (value) return value;
  }
  return null;
}

const tickerPattern = /^[A-Z]{4}\d{1,2}[A-Z]?$|^[A-Z0-9.^-]{1,12}$/;

// Daily lists (wallet composition, coverage) prefer the ticker as key so a
// position stays the same item across days even if row ids change.
export function describeItem(item, { preferTicker = true } = {}) {
  const raw = pick(item, candidates.ticker);
  const ticker = raw && tickerPattern.test(raw.trim().toUpperCase()) ? raw.trim().toUpperCase() : null;
  // The item's own id first; a nested asset id only when the item has none.
  const id = pick(item, candidates.key, []) || pick(item, candidates.key, ['asset', 'assets', 'ativo', 'fund', 'report', 'post']);
  const key = (preferTicker && ticker) || id || ticker;
  return {
    key: key ? String(key).slice(0, 300) : `hash:${hashOf(item).slice(0, 24)}`,
    ticker,
    title: pick(item, candidates.title)?.replace(/<[^>]+>/g, '').trim().slice(0, 500) || null,
    published: pick(item, candidates.published, ['report', 'post']),
  };
}

// Daily snapshots of wallets/coverage are keyed by what was asked: the wallet
// slug, the filter or the path id. Item keys never repeat inside one scope.
export function scopeOf(classified) {
  const q = classified.query || {};
  if (classified.kind === 'wallet_asset') return String(q.wallet || q.walletId || q.wallet_id || classified.pathParam || 'unknown');
  if (classified.kind === 'wallet_event') return String(q.wallet_id || q.wallet || 'unknown') + (q.wallet_group_id ? `#${q.wallet_group_id}` : '');
  if (classified.kind === 'wallet_group') return String(q.slug || 'all');
  if (classified.kind === 'wallet_info') return [classified.template, classified.pathParam !== classified.template.split('/').at(-1) ? classified.pathParam : null, q.wallet || q.slug].filter(Boolean).join('|');
  if (classified.kind === 'report_radar') return String(q.ticker || 'unknown');
  if (classified.kind === 'coverage') {
    const filters = Object.entries(q).filter(([key]) => !/^(?:page|limit|per_page|perPage|offset)$/.test(key))
      .map(([key, value]) => `${key}=${[].concat(value).join(',')}`).sort();
    return filters.length ? filters.join('&') : 'all';
  }
  return 'all';
}

// Total announced by the API, when present (count/total/total_entries...).
export function totalOf(body) {
  const names = ['total_entries', 'totalEntries', 'total', 'total_count', 'totalCount', 'count'];
  const levels = [body, body?.data, body?.meta, body?.pagination].filter(level => level && typeof level === 'object' && !Array.isArray(level));
  for (const level of levels) for (const name of names) if (Number.isSafeInteger(level[name]) && level[name] >= 0) return level[name];
  return null;
}
