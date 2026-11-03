import { redactUrl } from './privacy.js';

const unsafePath = /(?:^|[\/_-])(?:comprar|vender|buy|sell|order|orders|ordem|ordens|enviar|boleta|operar|negociar|trade|trading|investir|aplicar|aplicacao|resgatar|resgate|redeem|withdraw|reservar|reserva|subscricao|subscribe|transferir|transfer|delete|excluir|remover|logout|sair|settings|configuracoes|perfil|profile|account|conta|edit|editar|adicionar|create|criar|rebalancear|balancear)(?:[\/_-]|$)/i;
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
  return config.scopePaths.some(prefix => path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`)) ? safe : null;
}

export function discoverCatalogRoute(raw, label, config) {
  if (config.provider !== 'btg' || !config.categoryTabNames?.some(name => fold(name) === fold(label.replace(/\s*\(\d+\)$/, '')))) return null;
  const safe = safeReadUrl(raw, config);
  if (!safe) return null;
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

export function maySend(request, config) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
    if (request.isNavigationRequest?.() && !request.frame().parentFrame() && !scopedUrl(request.url(), config)) return false;
    // Prevent state-changing links during collection; static assets may be external.
    try { return !unsafePath.test(fold(decodeURIComponent(new URL(request.url()).pathname))); }
    catch { return false; }
  }
  if (request.method() !== 'POST') return false;
  try {
    const url = new URL(request.url());
    return url.origin === new URL(config.baseUrl).origin
      && config.readOnlyGraphqlPaths.includes(url.pathname)
      && isQueryBody(request.postDataJSON());
  } catch { return false; }
}

export async function installReadOnlyGuard(context, config, onBlock) {
  await context.route('**/*', async route => {
    if (maySend(route.request(), config)) return route.fallback();
    // Never persist request headers, query strings, or bodies.
    onBlock(redactUrl(new URL(route.request().url()).pathname));
    return route.abort('blockedbyclient');
  });
}
