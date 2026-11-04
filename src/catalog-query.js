// POST is also used for catalog searches. Recognize a bounded, positive schema
// of lookup context, filters, sorting and pagination, never transaction inputs.
// Values are examined only in memory and are never returned in diagnostics.
const normalize = value => value.replace(/[_-]/g, '').toLowerCase();
const containers = new Set(['filter', 'filters', 'criteria', 'parameters', 'params', 'pagination', 'pageable', 'pagerequest', 'sorting']);
const contextFields = new Set(['account', 'accountid', 'accountnumber', 'externalaccountnumber', 'bankaccountnumber', 'accountcode', 'conta', 'numeroconta']);
const pageFields = new Set(['page', 'pagenumber', 'pageindex', 'pagesize', 'size', 'limit', 'offset', 'skip', 'take']);
const sortFields = new Set(['sort', 'sortby', 'sortfield', 'orderby', 'orderbycolumn', 'orderbydirection', 'orderdirection', 'sortdirection', 'direction', 'ascending', 'descending']);
const filterFields = new Set([
  'search', 'searchterm', 'query', 'term', 'keyword', 'name', 'type', 'types', 'producttype', 'producttypes', 'assettype', 'assettypes',
  'category', 'categories', 'subcategory', 'subcategories', 'issuer', 'issuers', 'issuerid', 'issuerids', 'issuername',
  'rating', 'ratings', 'risk', 'risks', 'risklevel', 'indexer', 'indexers', 'index', 'indexes', 'currency',
  'liquidity', 'liquiditytype', 'liquiditytypes', 'maturity', 'maturityfrom', 'maturityto', 'minmaturity', 'maxmaturity',
  'startdate', 'enddate', 'duedatefrom', 'duedateto', 'minimumamount', 'maximumamount', 'minamount', 'maxamount',
  'minimumvalue', 'maximumvalue', 'minvalue', 'maxvalue', 'minimuminvestment', 'maximuminvestment', 'mininvestment', 'maxinvestment',
  'available', 'onlyavailable', 'includeunavailable', 'isavailable', 'secondarymarket', 'issecondarymarket', 'market', 'markets',
  'fundtype', 'fundtypes', 'fundclass', 'fundclasses', 'manager', 'managers', 'benchmark', 'benchmarks', 'cnpj',
]);
const transactionFields = new Set([
  'action', 'operation', 'method', 'command', 'order', 'orders', 'orderid', 'ordertype', 'side', 'buy', 'sell', 'subscribe',
  'subscription', 'subscriptionid', 'redeem', 'redemption', 'transfer', 'amount', 'quantity', 'price', 'unitprice', 'financialvalue',
  'investmentamount', 'subscriptionamount', 'fundid', 'productid', 'assetid', 'securityid', 'ticker', 'isin',
  'confirm', 'confirmation', 'acceptterms', 'termsaccepted', 'password', 'senha', 'token', 'signature', 'otp', 'mfa', 'transaction',
  'transactionid', 'create', 'update', 'delete', 'save',
]);

export function inspectCatalogQuery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { allowed: false, reason: 'INVALID_STRUCTURE' };
  let nodes = 0;
  const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 512)
    || (typeof value === 'number' && Number.isFinite(value));
  const leaf = value => scalar(value) || (Array.isArray(value) && value.length <= 500 && value.every(scalar));
  const visit = (object, depth) => {
    if (depth > 6 || ++nodes > 2000 || Object.keys(object).length > 60) return 'INVALID_STRUCTURE';
    for (const [rawKey, value] of Object.entries(object)) {
      const key = normalize(rawKey);
      if (transactionFields.has(key)) return 'TRANSACTION_FIELD';
      if (containers.has(key)) {
        if (value === null) continue;
        const entries = Array.isArray(value) ? value : [value];
        if (entries.length > 100) return 'INVALID_STRUCTURE';
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'INVALID_STRUCTURE';
          const error = visit(entry, depth + 1);
          if (error) return error;
        }
      } else if (contextFields.has(key)) {
        if (value !== null && !['string', 'number'].includes(typeof value)) return 'INVALID_VALUE';
        if (!scalar(value)) return 'INVALID_VALUE';
      } else if (pageFields.has(key)) {
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return 'INVALID_VALUE';
      } else if (sortFields.has(key) || filterFields.has(key)) {
        if (!leaf(value)) return 'INVALID_VALUE';
        if (key === 'query' && typeof value === 'string' && /^\s*(?:mutation|subscription)\b/i.test(value)) return 'TRANSACTION_FIELD';
      } else return 'UNRECOGNIZED_FIELD';
    }
    return null;
  };
  const reason = visit(body, 0);
  return reason ? { allowed: false, reason } : { allowed: true, reason: 'READ_QUERY' };
}

export function catalogPostRule(request, config) {
  if (config.provider !== 'btg' || request.method() !== 'POST' || request.isNavigationRequest?.()
    || !['fetch', 'xhr'].includes(request.resourceType?.())) return null;
  try {
    const url = new URL(request.url());
    if (url.origin !== new URL(config.baseUrl).origin || url.username || url.password || url.search || url.hash) return null;
    const frame = request.frame();
    if (frame.parentFrame()) return null;
    const source = new URL(frame.url());
    if (source.origin !== url.origin || source.username || source.password) return null;
    const base = '/produtos-de-investimento';
    if (/^\/investments\/api\/fixed-income\/accounts\/[A-Za-z0-9_-]{1,128}\/fixedincomes$/.test(url.pathname)
      && [`${base}/renda-fixa/credito-bancario`, `${base}/renda-fixa`].includes(source.pathname)) return 'bank_credit';
    if (url.pathname === '/investments/api/fund-subscription/v2/account'
      && source.pathname === `${base}/fundos-de-investimento`) return 'investment_funds';
  } catch { /* Missing/foreign frame context is never an approved catalog POST. */ }
  return null;
}

export function catalogPostDecision(request, config) {
  if (!catalogPostRule(request, config)) return { allowed: false, reason: 'NOT_CATALOG_QUERY' };
  try { return inspectCatalogQuery(request.postDataJSON()); }
  catch { return { allowed: false, reason: 'BODY_UNAVAILABLE' }; }
}
