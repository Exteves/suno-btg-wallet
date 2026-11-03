import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store } from '../src/database.js';
import { collect } from '../src/crawler.js';
import { loadConfig } from '../src/config.js';

test('BTG browser fixture traverses categories, pagination and consultation details without clicking investment actions', { timeout: 60000 }, async () => {
  const defaults = await loadConfig('btg.config.json');
  let browser;
  const store = new Store(':memory:');
  let writes = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      if (route.request().method() === 'POST') { writes++; await route.fulfill({ body: 'Unexpected write' }); return; }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <!doctype html><html><head><meta charset="utf-8"><title>Catálogo sintético</title></head><body>
        <header>CPF 123.456.789-00</header><main>
        <h1>Produtos de investimento</h1>
        <div role="tablist">
          <button type="button" role="tab" aria-selected="true">Renda fixa</button>
          <button type="button" role="tab" aria-selected="false">Fundos imobiliários</button>
          <button type="button" role="tab" aria-selected="false">Ações brasileiras</button>
          <button type="button" role="tab" aria-selected="false">Ações internacionais</button>
        </div><table id="products"></table>
        <button type="button" data-next>Próxima página</button>
        <a href="/produtos-de-investimento/investir">Investir</a>
        </main>
        <div id="product-dialog" role="dialog" style="display:none">
          <h1 data-product-name>CDB Exemplo</h1><dl>
            <dt>Emissor</dt><dd>Banco Fictício</dd><dt>Rentabilidade</dt><dd>105% CDI</dd>
            <dt>Vencimento</dt><dd>01/01/2031</dd>
          </dl><button type="button" data-close>Fechar</button>
        </div>
        <script>
          window.tradeClicks=0;
          let current='Renda fixa', pageIndex=0;
          const table=document.querySelector('#products');
          const next=document.querySelector('[data-next]');
          const render=()=>{
            const values={
              'Renda fixa':['CDB Exemplo '+pageIndex,'','CDB'],
              'Fundos imobiliários':['Fundo Exemplo','TEST11','FII'],
              'Ações brasileiras':['Empresa Exemplo','TEST3','Ações brasileiras'],
              'Ações internacionais':['Example Corp','EXMP','Ações internacionais']
            }[current];
            table.innerHTML='<tr><th>Produto</th><th>Ticker</th><th>Tipo</th><th>Consulta</th><th>Operar</th></tr><tr><td>'+values[0]+'</td><td>'+values[1]+'</td><td>'+values[2]+'</td><td><button type="button" data-detail>Ver detalhes</button></td><td><button type="button" data-trade>Investir</button></td></tr>';
            next.disabled=current!=='Renda fixa'||pageIndex>0;
            table.querySelector('[data-detail]').onclick=()=>document.querySelector('#product-dialog').style.display='block';
            table.querySelector('[data-trade]').onclick=()=>{window.tradeClicks++;fetch('/produtos-de-investimento/ordens',{method:'POST'});};
          };
          document.querySelectorAll('[role=tab]').forEach(tab=>tab.onclick=()=>{
            document.querySelectorAll('[role=tab]').forEach(other=>other.setAttribute('aria-selected',String(other===tab)));
            current=tab.innerText;pageIndex=0;render();
          });
          next.onclick=()=>{pageIndex++;render();};
          document.querySelector('[data-close]').onclick=()=>document.querySelector('#product-dialog').style.display='none';
          render();
        </script></body></html>` });
    });
    const page = await context.newPage();
    await page.goto(`${defaults.baseUrl}${defaults.entryPath}`);
    const config = { ...defaults, layoutVerified: true, settleMs: 10, nextSelector: '[data-next]',
      detailButtonSelector: '[data-detail]', detailDialogSelector: '#product-dialog', detailCloseSelector: '[data-close]' };
    const result = await collect({ page, config, store, purpose: 'start' });
    assert.equal(result.pagesFailed, 0);
    assert.ok(result.productObservations > 0);
    const categories = store.db.prepare('SELECT DISTINCT category FROM catalog_observations').all().map(row => row.category);
    for (const category of defaults.expectedCategories) assert.ok(categories.includes(category), category);
    assert.ok(store.db.prepare("SELECT count(*) n FROM snapshots WHERE view_name LIKE '%:detail'").get().n > 0);
    assert.ok(store.db.prepare("SELECT count(*) n FROM catalog_products WHERE name='CDB Exemplo 1'").get().n > 0);
    assert.equal(await page.evaluate(() => window.tradeClicks), 0);
    assert.equal(writes, 0);
    assert.ok(!store.db.prepare('SELECT visible_text FROM snapshots').all().some(row => row.visible_text.includes('123.456.789-00')));
    assert.equal(store.db.prepare("SELECT count(*) n FROM pages WHERE source_url LIKE '%/investir%'").get().n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM issues WHERE code='CATEGORY_NOT_CONFIRMED'").get().n, 0);
    assert.equal(result.status, 'partial'); // Visibility is limited to the catalog exposed to this login.
  } finally { await browser?.close(); store.close(); }
});
