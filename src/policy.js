import { diagnosticPath, queryFieldSchema } from './privacy.js';
import { catalogPostDecision, catalogPostRule } from './catalog-query.js';

const unsafePath = /(?:^|[\/_-])(?:comprar|vender|buy|sell|order|orders|ordem|ordens|enviar|boleta|operar|negociar|trade|trading|investir|aplicar|aplicacao|resgatar|resgate|redeem|withdraw|reservar|reserva|subscricao|subscribe|transferir|transfer|delete|excluir|remover|logout|sair|settings|configuracoes|perfil|profile|account|conta|edit|editar|adicionar|create|criar|rebalancear|balancear)(?:[\/_-]|$)/i;
const catalogGetPaths = [
  /^\/investments\/api\/fixed-income\/accounts\/[A-Za-z0-9_-]{1,128}\/fixedincomes$/,
  /^\/investments\/api\/fixed-income\/combo\/account\/[A-Za-z0-9_-]{1,128}$/,
  /^\/investments\/api\/government-bond\/account\/[A-Za-z0-9_-]{1,128}$/,
  /^\/investments\/api\/treasury\/buy\/account\/[A-Za-z0-9_-]{1,128}\/bonds$/,
  /^\/investments\/api\/fund-subscription\/v2\/account$/,
];
export const fold = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function safeReadUrl(raw, config, base = config.baseUrl) {
  try {
    const url = new URL(raw, base);
    if (url.origin !== new URL(config.baseUrl).origin || url.username || url.password) return null;
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (unsafePath.test(fold(decodedPath))) return null;
    // Unknown query parameters may contain credentials or trigger server actions.
    if ([...url.searchParams.keys()].some(k => !config.queryKeys.includes(k))) return null;
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function scopedUrl(raw, config, base = config.baseUrl) {
  const safe = safeReadUrl(raw, config, base);
  if (!safe) return null;
  const path = new URL(safe).pathname;
  return config.scopePaths.some(prefix => path === prefix || (!config.exactScope && path.startsWith(`${prefix.replace(/\/$/, '')}/`))) ? safe : null;
}

// Authentication can still start on the catalog landing page. Collection gets
// its own exact route allowlist without changing the manual-login configuration.
export function collectionPolicy(config) {
  return config.collectionPaths ? { ...config, scopePaths: [...config.collectionPaths], exactScope: true } : config;
}

export function discoverCatalogRoute(raw, label, config) {
  if (config.provider !== 'btg' || !config.categoryTabNames?.some(name => fold(name) === fold(label.replace(/\s*\(\d+\)$/, '')))) return null;
  const safe = safeReadUrl(raw, config);
  if (!safe) return null;
  if (config.exactScope && !scopedUrl(safe, config)) return null;
  const path = new URL(safe).pathname;
  // Discover actual category links, never a generic account/dashboard route.
  if (!/(?:^|\/)(?:renda-fixa|renda-variavel|fundos(?:-imobiliarios|-de-investimento)?|acoes(?:-brasileiras|-internacionais)?|tesouro(?:-direto)?|previdencia|coe|etfs?|bdrs?|criptoativos|alternativos|ofertas-publicas|produtos-de-investimento)(?:\/|$)/.test(fold(path))) return null;
  return path;
}

export function sourceKind(url, config) {
  if (config.provider === 'btg') return 'btg_catalog';
  const path = new URL(url).pathname;
  return path === config.walletsPath || path.startsWith(`${config.walletsPath}/`)
    ? 'suno_wallet_area' : 'portfolio_area';
}

export function unsafeControlLabel(label) {
  return /\b(?:comprar|vender|investir|aplicar|resgatar|operar|negociar|buy|sell|trade|redeem|withdraw|excluir|deletar|remover|adicionar|salvar|confirmar|enviar|transferir|rebalancear|balancear|criar|editar|assinar|simular|reservar)\b/i.test(fold(label));
}

export function ownership(title, headings) {
  const text = fold([title, ...headings].join(' '));
  if (/carteira(?:s)? recomendada(?:s)?/.test(text)) return 'suno_recommendation';
  if (/minha(?:s)? carteira(?:s)?|meu(?:s)? portfolio(?:s)?|minhas posicoes/.test(text)) return 'user_positions';
  return 'unknown';
}

export function isQueryBody(body) {
  const entries = Array.isArray(body) ? body : [body];
  return entries.length > 0 && entries.every(entry => {
    if (!entry || typeof entry.query !== 'string') return false;
    const query = entry.query.replace(/#[^\n]*/g, '').trim();
    // Conservative: reject mutations, subscriptions, and persisted operations.
    return /^(?:query\b|\{)/.test(query) && !/\b(?:mutation|subscription)\b/.test(query);
  });
}

export function requestOriginScope(request, config) {
  try {
    const url = new URL(request.url());
    if (!['https:', 'http:'].includes(url.protocol)) return 'unknown';
    if (url.origin === new URL(config.baseUrl).origin) return 'application';
    const domain = config.provider === 'btg' ? 'btgpactual.com' : config.provider === 'suno' ? 'suno.com.br' : null;
    return domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? 'provider' : 'external';
  } catch { return 'unknown'; }
}

function isCatalogGet(request, config) {
  if (config.provider !== 'btg' || request.method() !== 'GET' || request.isNavigationRequest?.()
    || !['xhr', 'fetch'].includes(request.resourceType?.())) return false;
  try {
    const url = new URL(request.url());
    const origin = requestOriginScope(request, config);
    if (url.username || url.password || !['application', 'provider'].includes(origin)
      || (origin === 'provider' && (url.protocol !== 'https:' || url.port))) return false;
    if ([...url.searchParams.keys()].some(key => /^(?:action|operation|method|_method)$/i.test(key))) return false;
    return catalogGetPaths.some(pattern => pattern.test(url.pathname));
  } catch { return false; }
}

export function maySend(request, config, categoryLabel = null) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
    if (request.isNavigationRequest?.() && !request.frame().parentFrame() && !scopedUrl(request.url(), config)
      && !discoverCatalogRoute(request.url(), categoryLabel || '', config)) return false;
    // These exact catalog route shapes were blocked in run 6 by the broad
    // account/buy filter. Only data GETs are exempt; writes and navigations
    // still pass through the original deny policy.
    if (isCatalogGet(request, config)) return true;
    // Prevent state-changing links during collection; static assets may be external.
    try { return !unsafePath.test(fold(decodeURIComponent(new URL(request.url()).pathname))); }
    catch { return false; }
  }
  if (request.method() !== 'POST') return false;
  if (catalogPostRule(request, config)) return catalogPostDecision(request, config).allowed;
  try {
    const url = new URL(request.url());
    return url.origin === new URL(config.baseUrl).origin
      && config.readOnlyGraphqlPaths.includes(url.pathname)
      && isQueryBody(request.postDataJSON());
  } catch { return false; }
}

export async function installReadOnlyGuard(context, config, onBlock, categoryLabel = () => null) {
  await context.route('**/*', async route => {
    if (maySend(route.request(), config, categoryLabel())) return route.fallback();
    // Never persist request headers, query strings, or bodies.
    const request = route.request();
    const query = catalogPostRule(request, config) ? catalogPostDecision(request, config) : null;
    let fields;
    if (query?.reason === 'UNRECOGNIZED_FIELD') {
      try { fields = queryFieldSchema(request.postDataJSON()); } catch { /* No raw errors or values. */ }
    }
    onBlock(diagnosticPath(request.url()), {
      method: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) ? request.method() : 'OTHER',
      resource_type: ['xhr', 'fetch', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'eventsource', 'ping'].includes(request.resourceType?.()) ? request.resourceType() : 'other',
      origin_scope: requestOriginScope(request, config),
      ...(query ? { query_check: query.reason } : {}),
      ...(fields ? { query_fields: fields } : {}),
    });
    return route.abort('blockedbyclient');
  });
}
