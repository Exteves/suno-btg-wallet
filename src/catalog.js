import { createHash } from 'node:crypto';
import { fold } from './policy.js';

const aliases = {
  name: ['produto', 'produto e risco', 'nome', 'nome do produto', 'ativo', 'titulo', 'fundo', 'nome do fundo'],
  ticker: ['ticker', 'codigo de negociacao', 'codigo b3'],
  isin: ['isin', 'codigo isin'],
  product_cnpj: ['cnpj do fundo', 'cnpj da classe', 'cnpj do produto'],
  external_id: ['id do produto', 'codigo do produto'],
  issuer: ['emissor', 'instituicao emissora', 'banco emissor'],
  category_text: ['categoria', 'classe', 'classe de ativo', 'classe do ativo'],
  product_type: ['tipo', 'tipo de produto', 'tipo do produto'],
  rate_text: ['taxa', 'rentabilidade', 'remuneracao', 'taxa indicativa'],
  maturity_text: ['vencimento', 'data de vencimento'],
  liquidity_text: ['liquidez', 'prazo de liquidez'],
  minimum_text: ['aplicacao minima', 'aplicacao min.', 'investimento minimo', 'valor minimo'],
  price_text: ['preco', 'cotacao', 'preco unitario', 'pu'],
  currency: ['moeda'],
  risk_text: ['risco', 'classificacao de risco', 'perfil de risco'],
  guarantee_text: ['garantia', 'garantias', 'fgc'],
  fees_text: ['taxas', 'taxa de administracao', 'custos'],
  tax_text: ['tributacao', 'imposto de renda', 'ir'],
  redemption_text: ['prazo de resgate', 'cotizacao', 'resgate', 'carencia'],
  restrictions_text: ['restricoes', 'publico alvo', 'publico-alvo'],
};

export function classifyCategory(text) {
  const value = fold(text);
  if (/\bbdrs?\b/.test(value)) return 'bdr';
  if (/\betfs?\b/.test(value)) return 'etf';
  const found = [];
  if (/\brenda fixa\b|\b(?:cdb|lci|lca|lc|cri|cra|debentures?|tesouro)\b/.test(value)) found.push('fixed_income');
  if (/\bfiis?\b|fundos? imobiliarios?/.test(value)) found.push('real_estate_funds');
  if (/acoes (?:internacionais|americanas|no exterior|do exterior)|international equities/.test(value)) found.push('international_equities');
  if (/acoes (?:brasileiras|nacionais|brasil)|brazilian equities/.test(value)) found.push('brazilian_equities');
  if (found.length === 1) return found[0];
  if (!found.length && /fundos? de investimento/.test(value)) return 'investment_funds';
  return 'unknown';
}

function mapFields(raw, mappings) {
  const result = {};
  for (const [label, value] of Object.entries(raw)) {
    if (!value || value === '[REMOVIDO]') continue;
    const name = Object.keys(aliases).find(key => mappings[key] === label || aliases[key].includes(fold(label)));
    if (name && result[name] === undefined) result[name] = String(value).trim();
  }
  return result;
}

export function labeledFields(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]{1,80}):\s*(.+)$/);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

export function catalogProducts(data, { url, view, config }) {
  const candidates = [];
  for (const [tableIndex, table] of data.tables.entries()) {
    for (const [rowIndex, row] of table.rows.entries()) {
      const fields = Object.fromEntries(row.map((value, i) => [table.headers[i] || `column_${i + 1}`, value]));
      candidates.push({ fields, location: { kind: 'table', tableIndex, rowIndex } });
    }
  }
  for (const [index, block] of (data.productBlocks || []).entries()) {
    candidates.push({ fields: { ...labeledFields(block.text), ...block.fields, ...(block.name ? { Produto: block.name } : {}) }, location: { kind: 'block', index } });
  }
  const products = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const fields = mapFields(candidate.fields, config.productFieldMappings || {});
    if (!fields.name && !fields.ticker && !fields.isin && !fields.external_id && !fields.product_cnpj) continue;
    const pathMapping = (config.categoryPathMappings || []).filter(mapping => new URL(url).pathname.startsWith(mapping.pathPrefix)).sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
    const explicit = [fields.category_text, fields.product_type].filter(Boolean).join(' ');
    const pageEvidence = [...(data.activeTabs || []), data.headings[0] || '', view === 'default' ? '' : view].join(' ');
    const explicitCategory = classifyCategory(explicit);
    const genericType = !explicit || /^(?:acao|acoes|renda variavel|fundo|fundos|outros)$/.test(fold(explicit));
    const category = explicitCategory !== 'unknown' ? explicitCategory : pathMapping?.category || (genericType ? classifyCategory(pageEvidence) : 'unknown');
    const categoryEvidence = explicitCategory !== 'unknown' ? explicit : [explicit, pathMapping ? `configured-path:${pathMapping.pathPrefix}` : pageEvidence].filter(Boolean).join(' | ');
    const identity = fields.isin ? `isin:${fields.isin.trim().toUpperCase()}`
      : fields.product_cnpj ? `cnpj:${fields.product_cnpj.replace(/\D/g, '')}`
      : fields.ticker ? `ticker:${fields.ticker.trim().toUpperCase()}`
      : fields.external_id ? `id:${fields.external_id}` : null;
    const fingerprint = createHash('sha256').update(JSON.stringify([url, fields, candidate.fields])).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    products.push({ ...fields, category, category_evidence: categoryEvidence, identity, fingerprint,
      raw_fields: candidate.fields, location: candidate.location });
  }
  return products;
}
