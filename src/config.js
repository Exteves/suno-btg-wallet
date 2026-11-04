import { readFile } from 'node:fs/promises';
import { scopedUrl, collectionPolicy } from './policy.js';

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.provider ??= 'suno';
  const origins = { suno: 'https://investidor.suno.com.br', btg: 'https://app.btgpactual.com' };
  const base = new URL(config.baseUrl);
  if (!origins[config.provider] || base.origin !== origins[config.provider] || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Domínio de produção incompatível com o provedor.');
  }
  for (const key of ['scopePaths', 'queryKeys', 'readOnlyGraphqlPaths', 'views', 'recordMappings']) {
    if (!Array.isArray(config[key])) throw new Error(`Configuração inválida: ${key}.`);
  }
  for (const key of ['maxPages', 'maxPaginationPages', 'maxScrollSteps', 'settleMs', 'navigationTimeoutMs']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Configuração inválida: ${key}.`);
  }
  config.entryPath ??= config.portfolioPath;
  config.loginPath ??= config.provider === 'btg' ? '/login' : config.entryPath;
  if (typeof config.loginPath !== 'string' || !config.loginPath.startsWith('/') || config.loginPath.startsWith('//')) throw new Error('Rota de login inválida.');
  const login = new URL(config.loginPath, config.baseUrl);
  if (login.origin !== base.origin || login.search || login.hash || login.username || login.password
    || (!scopedUrl(config.loginPath, config) && !['/', '/login', '/login/'].includes(login.pathname))) throw new Error('Rota de login fora do escopo permitido.');
  config.seedPaths ??= [config.portfolioPath, config.walletsPath];
  if (!Array.isArray(config.seedPaths) || !config.seedPaths.length || config.seedPaths.some(path => typeof path !== 'string' || !scopedUrl(path, config))
    || !scopedUrl(config.entryPath, config)) throw new Error('Rotas iniciais fora do escopo.');
  config.collectionPaths ??= null;
  config.followDiscoveredLinks ??= true;
  if (typeof config.followDiscoveredLinks !== 'boolean'
    || (config.collectionPaths !== null && (!Array.isArray(config.collectionPaths) || !config.collectionPaths.length
      || config.collectionPaths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
        || !scopedUrl(path, config) || new URL(path, config.baseUrl).pathname !== path)
      || config.seedPaths.some(path => !scopedUrl(path, collectionPolicy(config)))))) throw new Error('Rotas de coleta inválidas.');
  config.scrollIdleMs ??= 3000;
  config.scrollBottomSamples ??= 3;
  config.maxScrollDurationMs ??= 300000;
  config.scrollNoProgressMs ??= 45000;
  config.progressIntervalMs ??= 10000;
  for (const key of ['scrollIdleMs', 'scrollBottomSamples', 'maxScrollDurationMs', 'scrollNoProgressMs', 'progressIntervalMs']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Configuração inválida: ${key}.`);
  }
  if (config.maxScrollDurationMs <= config.scrollIdleMs) throw new Error('O limite de rolagem deve superar a espera no final da lista.');
  if (config.scrollNoProgressMs <= config.scrollIdleMs) throw new Error('O limite sem progresso deve superar a espera no final da lista.');
  if (typeof config.contentSelector !== 'string' || !config.contentSelector) throw new Error('contentSelector obrigatório.');
  for (const view of config.views) {
    if (!view.name || !view.selector || (view.kind !== 'tab' && view.kind !== 'expand')) {
      throw new Error('Cada view precisa de name, selector e kind (tab ou expand).');
    }
  }
  for (const mapping of config.recordMappings) {
    if (!mapping.name || mapping.columns?.identifier == null) throw new Error('Mapeamento precisa de name e columns.identifier.');
  }
  config.sessionTtlHours ??= 168;
  config.sessionLocalStorageKeys ??= [];
  config.authenticatedSelector ??= null;
  config.authServiceWorkers ??= config.provider === 'btg' ? 'allow' : 'block';
  if (!['allow', 'block'].includes(config.authServiceWorkers)) throw new Error('Configuração inválida: authServiceWorkers.');
  config.cardSelector ??= 'article,[role=listitem],[data-wallet],[data-carteira]';
  config.autoTabs ??= false;
  config.autoCategoryButtons ??= false;
  config.categoryTabNames ??= [];
  config.autoScrollContainer ??= false;
  config.maxTabs ??= 30;
  config.scrollContainerSelector ??= null;
  config.productFieldMappings ??= {};
  config.categoryPathMappings ??= [];
  config.expectedCategories ??= [];
  config.detailButtonSelector ??= null;
  config.detailDialogSelector ??= null;
  config.detailCloseSelector ??= null;
  config.maxProductDetails ??= 500;
  config.productNameSelector ??= '[data-product-name],h1';
  if (![config.detailButtonSelector, config.detailDialogSelector, config.detailCloseSelector].every(value => value === null || typeof value === 'string')
    || (config.detailButtonSelector && (!config.detailDialogSelector || !config.detailCloseSelector))
    || !Number.isInteger(config.maxProductDetails) || config.maxProductDetails < 1 || typeof config.productNameSelector !== 'string') throw new Error('Configuração inválida: detalhes de produtos.');
  if (typeof config.cardSelector !== 'string' || typeof config.autoTabs !== 'boolean' || !Number.isInteger(config.maxTabs) || config.maxTabs < 1
    || (config.scrollContainerSelector !== null && typeof config.scrollContainerSelector !== 'string')
    || !config.productFieldMappings || typeof config.productFieldMappings !== 'object' || Array.isArray(config.productFieldMappings)
    || !Object.values(config.productFieldMappings).every(value => typeof value === 'string')
    || !Array.isArray(config.categoryPathMappings) || !config.categoryPathMappings.every(mapping => typeof mapping.pathPrefix === 'string' && typeof mapping.category === 'string')
    || !Array.isArray(config.expectedCategories) || !config.expectedCategories.every(category => typeof category === 'string')
    || !Array.isArray(config.categoryTabNames) || !config.categoryTabNames.every(name => typeof name === 'string')
    || typeof config.autoCategoryButtons !== 'boolean' || typeof config.autoScrollContainer !== 'boolean') throw new Error('Configuração inválida: catálogo.');
  if (!Number.isInteger(config.sessionTtlHours) || config.sessionTtlHours < 1 || config.sessionTtlHours > 168
    || !Array.isArray(config.sessionLocalStorageKeys) || !config.sessionLocalStorageKeys.every(key => typeof key === 'string')
    || (config.authenticatedSelector !== null && (typeof config.authenticatedSelector !== 'string' || !config.authenticatedSelector.trim()))) {
    throw new Error('Configuração inválida: sessão/autenticação.');
  }
  return config;
}
