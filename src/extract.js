import { scopedUrl, ownership, discoverCatalogRoute } from './policy.js';

export async function extract(page, config) {
  const data = await page.evaluate(({ provider, contentSelector, walletLinkSelector, cardSelector, productNameSelector, categoryTabNames = [] }) => {
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const roots = [...document.querySelectorAll(contentSelector)].filter(visible);
    const root = roots[0];
    if (!root) return null;
    const cleanText = el => {
      // Rendered content only: no inputs, embedded state, scripts, or auth/profile UI.
      const hidden = [...el.querySelectorAll('*')].filter(node => !visible(node));
      const clone = el.cloneNode(true);
      const originals = [...el.querySelectorAll('*')];
      const copies = [...clone.querySelectorAll('*')];
      for (const node of hidden) copies[originals.indexOf(node)]?.remove();
      clone.querySelectorAll('script,style,noscript,template,form,input,textarea,select,nav,header,[role=dialog],[autocomplete], [data-private]').forEach(node => node.remove());
      clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
      clone.querySelectorAll('p,div,section,article,tr,td,th,h1,h2,h3,h4,li').forEach(node => node.append('\n'));
      return (clone.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    };
    const tableElements = [...root.querySelectorAll('table,[role=table],[role=grid]')].filter(visible);
    const tables = tableElements.map(table => {
      const rows = [...table.querySelectorAll('tr,[role=row]')].filter(visible);
      const headerRows = rows.filter(row => row.querySelector('th,[role=columnheader]') && !row.querySelector('td,[role=cell],[role=gridcell]'));
      const headers = headerRows.length ? [...headerRows.at(-1).querySelectorAll('th,[role=columnheader]')].filter(visible).map(cleanText) : [];
      return {
        caption: cleanText(table.querySelector('caption') || table.querySelector('[role=heading]') || document.createElement('span')) || table.getAttribute('aria-label') || '',
        headers,
        rows: rows.filter(row => !headerRows.includes(row)).map(row => [...row.querySelectorAll('td,th,[role=cell],[role=gridcell],[role=rowheader]')].filter(visible).map(cleanText)).filter(cells => cells.length),
      };
    });
    const cardElements = [...root.querySelectorAll(cardSelector || 'article,[role=listitem],[data-wallet],[data-carteira]')].filter(visible);
    const fieldsOf = el => Object.fromEntries([...el.querySelectorAll('dt')].filter(visible).map(dt => {
      const dd = dt.nextElementSibling;
      return dd?.tagName === 'DD' && visible(dd) ? [cleanText(dt), cleanText(dd)] : ['', ''];
    }).filter(([key]) => key));
    const productBlocks = cardElements.map(el => ({
      name: cleanText(el.querySelector('[data-product-name],h2,h3,h4') || document.createElement('span')),
      fields: fieldsOf(el), text: cleanText(el),
    }));
    const unidentifiedTables = [];
    if (provider === 'btg') for (const [index, table] of tables.entries()) {
      // The BTG landing page uses one headerless label/value table per offer.
      // Bind it only to an unambiguous title in its own container; never treat
      // the metric label or a category heading as the product's name.
      if (table.headers.length || !table.rows.length || !table.rows.every(row => row.length === 2 && row[0])) continue;
      const fields = Object.fromEntries(table.rows);
      if (!Object.keys(fields).some(label => /rentab|aplica[çc][aã]o|vencimento|liquidez|cota[çc][aã]o/i.test(label))) continue;
      const element = tableElements[index];
      let container = element.parentElement;
      let found = false;
      const ancestors = [];
      const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      for (let depth = 0; container && container !== root && depth < 8; depth++, container = container.parentElement) {
        ancestors.push(container.tagName.toLowerCase());
        if (tableElements.filter(other => container.contains(other)).length !== 1) break;
        const titleSelector = '[data-product-name],h1,h2,h3,h4,[role=heading],legend,header,[slot=title],[class*=title i],[class*=name i]';
        const names = [...new Set([...container.querySelectorAll(titleSelector)].filter(el => visible(el)
          && !element.contains(el) && !el.closest('button,a,[role=button],nav,[data-private]'))
          .map(cleanText).filter(name => name && name.length <= 300 && !name.includes('\n')
            && !categoryTabNames.some(category => normalize(category) === normalize(name))
            && !Object.keys(fields).includes(name)
            && !/^(?:investir|aplicar|comprar|ver detalhes|detalhes)$/i.test(name)))];
        if (names.length > 1) break;
        if (names.length === 1) {
          const cardIndex = cardElements.findIndex((card, candidateIndex) => card.contains(element)
            && tableElements.filter(other => card.contains(other)).length === 1
            && (!productBlocks[candidateIndex].name || productBlocks[candidateIndex].name === names[0]));
          if (cardIndex >= 0) {
            Object.assign(productBlocks[cardIndex], { name: names[0], fields: { ...productBlocks[cardIndex].fields, ...fields }, tableIndex: index });
          } else productBlocks.push({ name: names[0], fields, text: '', tableIndex: index });
          found = true;
          break;
        }
      }
      if (!found) unidentifiedTables.push({ tableIndex: index, ancestors });
    }
    const detailFields = Object.fromEntries([...root.querySelectorAll('dl')].filter(el => visible(el) && !cardElements.some(card => card.contains(el))).flatMap(el => Object.entries(fieldsOf(el))));
    if (Object.keys(detailFields).length) productBlocks.push({ name: cleanText(root.querySelector(productNameSelector || '[data-product-name],h1') || document.createElement('span')), fields: detailFields, text: '' });
    return {
      title: document.title,
      headings: [...root.querySelectorAll('h1,h2,h3,h4,[role=heading]')].filter(visible).map(cleanText),
      text: cleanText(root), tables,
      cards: cardElements.map(cleanText).filter(Boolean),
      productBlocks,
      unidentifiedTables,
      activeTabs: [...root.querySelectorAll('[role=tab][aria-selected=true]')].filter(visible).map(cleanText),
      readControls: [...root.querySelectorAll('button,[role=button]')].filter(visible).map(el => ({ label: cleanText(el) || el.getAttribute('aria-label') || '' })),
      links: [...document.querySelectorAll(walletLinkSelector)].filter(visible).map(link => ({ label: cleanText(link),
        url: link.href || link.getAttribute('routerlink') || link.getAttribute('data-href') })).filter(link => link.url),
      scroll: { top: window.scrollY, height: document.documentElement.scrollHeight },
    };
  }, config);
  if (!data) throw Object.assign(new Error('CONTENT_ROOT_MISSING'), { code: 'CONTENT_ROOT_MISSING' });
  for (const link of data.links) {
    const path = discoverCatalogRoute(link.url, link.label, config);
    if (path && !config.scopePaths.includes(path)) config.scopePaths.push(path);
  }
  data.links = data.links.map(link => ({ ...link, url: scopedUrl(link.url, config, page.url()) })).filter(link => link.url);
  data.ownership = ownership(data.title, data.headings);
  if (config.provider === 'btg') data.ownership = 'catalog_offer';
  data.sourceUrl = scopedUrl(page.url(), config);
  // Scroll coordinates are not content and must not defeat duplicate detection.
  delete data.scroll;
  return data;
}

export async function assertReadable(page, config) {
  if (!scopedUrl(page.url(), config)) throw Object.assign(new Error('AUTH_OR_SCOPE_REDIRECT'), { code: 'AUTH_OR_SCOPE_REDIRECT' });
  if (await page.locator('input[type=password]:visible').count()) throw Object.assign(new Error('LOGIN_REQUIRED'), { code: 'LOGIN_REQUIRED' });
  const body = await page.locator('body').innerText();
  if (/verifique (?:que voc[eê]|se voc[eê]) [eé] humano|verify you are human|just a moment|access denied|acesso negado/i.test(body)) {
    throw Object.assign(new Error('ACCESS_CHALLENGE'), { code: 'ACCESS_CHALLENGE' });
  }
  const content = await page.locator(config.contentSelector).first().innerText().catch(() => '');
  if (/n[aã]o foi poss[ií]vel carregar (?:as )?informa[çc][oõ]es|erro ao carregar (?:os produtos|as informa[çc][oõ]es)/i.test(content)) {
    throw Object.assign(new Error('APPLICATION_LOAD_ERROR'), { code: 'APPLICATION_LOAD_ERROR' });
  }
  if (/sess[aã]o expirou|session expired|fa[çc]a (?:o )?login|entre (?:na|em sua) conta|acesse sua conta/i.test(body)
      && !(await page.locator('table:visible,[role=grid]:visible').count())) {
    throw Object.assign(new Error('LOGIN_REQUIRED'), { code: 'LOGIN_REQUIRED' });
  }
}

export async function settle(page, config) {
  if (config.readySelector) await page.locator(config.readySelector).first().waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await page.locator(config.contentSelector).first().waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  let previous = '';
  let stable = 0;
  const deadline = Date.now() + Math.max(5000, config.settleMs * 8);
  while (Date.now() < deadline) {
    await page.waitForTimeout(config.settleMs);
    const text = await page.locator(config.contentSelector).first().innerText();
    if (text && text === previous) stable++; else stable = 0;
    if (stable >= 2) return true;
    previous = text;
  }
  return false;
}
