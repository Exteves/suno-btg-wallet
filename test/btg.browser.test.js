import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store } from '../src/database.js';
import { collect } from '../src/crawler.js';
import { loadConfig, selectCollectionPaths } from '../src/config.js';

async function legacyFixtureConfig() {
  const defaults = await loadConfig('btg.config.json');
  return { ...defaults, seedPaths: [defaults.entryPath], collectionPaths: null, followDiscoveredLinks: true,
    autoTabs: true, autoCategoryButtons: true, maxPages: 20, scrollIdleMs: 30, scrollBottomSamples: 3,
    categoryPathMappings: [], expectedCategories: ['fixed_income', 'real_estate_funds', 'international_equities', 'brazilian_equities'] };
}

test('funds recover once from a stalled browser query, retaining products and respecting the selected page', { timeout: 30000 }, async () => {
  const defaults = selectCollectionPaths(await loadConfig('btg.config.json'), ['/produtos-de-investimento/fundos-de-investimento']);
  const store = new Store(':memory:');
  const stalled = [];
  let browser;
  let documents = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 500 } });
    await context.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/investments/api/fund-subscription/v2/account') {
        const batch = route.request().postDataJSON().page;
        if (documents === 1 && batch === 1) { stalled.push(route); return; }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: Array.from({ length: 4 }, (_, i) => batch * 4 + i) }) });
      }
      assert.equal(path, defaults.seedPaths[0]);
      assert.equal(route.request().method(), 'GET');
      documents++;
      for (const old of stalled.splice(0)) await old.abort().catch(() => {});
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><main>
        <h1>Fundos de investimento</h1><div id="list" style="height:180px;overflow:auto">
        <table><tr><th>Produto</th></tr><tbody id="rows"></tbody></table></div>
        <script>
          const list=document.querySelector('#list'), rows=document.querySelector('#rows');
          let count=0, pending=false;
          async function load(){
            if(pending||count>=8)return;
            pending=true;list.setAttribute('aria-busy','true');
            const response=await fetch('/investments/api/fund-subscription/v2/account',{
              method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page:count/4,pageSize:4})});
            const data=await response.json();
            rows.insertAdjacentHTML('beforeend',data.items.map(id=>'<tr style="height:60px"><td>Fundo sintético '+id+'</td></tr>').join(''));
            count+=data.items.length;pending=false;list.setAttribute('aria-busy','false');
          }
          list.addEventListener('scroll',()=>{if(list.scrollTop+list.clientHeight>=list.scrollHeight-2)void load();});
          void load();
        </script></main>` });
    });
    const page = await context.newPage();
    const config = { ...defaults, settleMs: 10, scrollIdleMs: 30, scrollNoProgressMs: 150, navigationTimeoutMs: 3000,
      maxScrollDurationMs: 5000, scrollDurationByPath: {}, maxScrollSteps: 300 };
    const result = await collect({ page, config, store, purpose: 'start' });
    assert.equal(documents, 2);
    assert.equal(result.pagesFailed, 0);
    assert.equal(result.pageResults.length, 1);
    assert.equal(result.pageResults[0].scrollCompletion, 'end_observed');
    assert.equal(result.pageResults[0].scrollReloads, 1);
    assert.equal(result.pageResults[0].distinctProductRecords, 8);
    assert.equal(store.db.prepare("SELECT count(*) n FROM issues WHERE code='SCROLL_RELOAD_AFTER_STALL'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM issues WHERE code='SCROLL_LOADING_STALLED'").get().n, 0);
  } finally { await browser?.close(); store.close(); }
});

test('five exact BTG routes capture incremental and virtualized internal lists without crawling other categories', { timeout: 30000 }, async () => {
  const defaults = await loadConfig('btg.config.json');
  const store = new Store(':memory:');
  let browser;
  const navigated = [];
  let dataReads = 0;
  let writes = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 500 } });
    await context.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      const catalogPost = /^\/investments\/api\/fixed-income\/accounts\/TEST-ACCOUNT\/fixedincomes$/.test(path)
        || path === '/investments/api/fund-subscription/v2/account';
      if (path.startsWith('/investments/api/') && route.request().method() === (catalogPost ? 'POST' : 'GET')) {
        dataReads++;
        return route.fulfill({ contentType: 'application/json', body: '{"ready":true}' });
      }
      if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 500, body: '' }); }
      if (route.request().isNavigationRequest()) navigated.push(path);
      const virtual = path.endsWith('/credito-bancario');
      const apiPath = path.endsWith('/credito-bancario') ? '/investments/api/fixed-income/accounts/TEST-ACCOUNT/fixedincomes'
        : path.endsWith('/titulos-publicos') ? '/investments/api/government-bond/account/TEST-ACCOUNT'
        : path.endsWith('/tesouro-direto') ? '/investments/api/treasury/buy/account/TEST-ACCOUNT/bonds'
        : path.endsWith('/fundos-de-investimento') ? '/investments/api/fund-subscription/v2/account'
        : '/investments/api/fixed-income/combo/account/TEST-ACCOUNT';
      const usesPost = path.endsWith('/credito-bancario') || path.endsWith('/fundos-de-investimento');
      // Include an ancestor scroller and a document scrollbar as well as a
      // descendant scroller, to catch choosing the wrong scroll surface.
      const table = '<table><tr><th>Produto e risco</th><th>Aplicação mínima</th></tr><tbody id="rows"></tbody></table>';
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body style="min-height:1600px">
        ${virtual ? `<div id="viewport" style="height:180px;overflow:auto;scroll-behavior:smooth"><main style="height:1440px"><h1>Renda fixa</h1>${table}</main></div>`
          : `<main><h1>${path.endsWith('/fundos-de-investimento') ? 'Fundos de investimento' : 'Renda fixa'}</h1><div id="viewport" style="height:180px;overflow:auto;scroll-behavior:smooth">${table}</div></main>`}
        <a href="/produtos-de-investimento/criptoativos">Criptoativos</a>
        <div role="progressbar" aria-valuenow="100" aria-valuemax="100">Concluído</div>
        <button type="button" onclick="window.tradeClicks++">Investir</button>
        <script>
          window.tradeClicks=0;
          const viewport=document.querySelector('#viewport'), rows=document.querySelector('#rows');
          viewport.setAttribute('aria-busy','true');
          (async()=>{
          const response=await fetch('${apiPath}', ${usesPost
            ? `{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${virtual
              ? "{page:0,orderByColumn:'maturity',orderByDirection:'ASC'}"
              : "{accountNumber:'TEST-ACCOUNT',filters:{search:''},page:0,pageSize:50}"})}`
            : '{}'});
          if(!response.ok) throw new Error('synthetic API read failed');
          await response.json();viewport.setAttribute('aria-busy','false');
          let count=6, pending=false;
          const render=(start,end)=>{rows.innerHTML=Array.from({length:end-start},(_,i)=>'<tr style="height:40px"><td>Produto sintético '+(start+i)+'</td><td>R$ 100,00</td></tr>').join('');};
          if (${virtual}) {
            document.querySelector('table').style.position='sticky';document.querySelector('table').style.top='0';
            const virtualRender=()=>{const start=Math.min(15,Math.floor(viewport.scrollTop/80));render(start,start+3);};
            viewport.addEventListener('scroll',virtualRender);virtualRender();
          } else {
            render(0,count);
            viewport.addEventListener('scroll',()=>{
              if(!pending && count<18 && viewport.scrollTop+viewport.clientHeight>=viewport.scrollHeight-2){
                pending=true;viewport.setAttribute('aria-busy','true');
                setTimeout(()=>{count+=6;render(0,count);pending=false;viewport.setAttribute('aria-busy','false');},150);
              }
            });
          }
          })().catch(()=>{document.querySelector('main').insertAdjacentHTML('beforeend','<p>Não foi possível carregar as informações</p>');});
        </script></body></html>` });
    });
    const page = await context.newPage();
    const config = { ...defaults, settleMs: 10, scrollIdleMs: 80, maxScrollDurationMs: 5000, maxScrollSteps: 300 };
    const result = await collect({ page, config, store, purpose: 'start' });
    assert.equal(result.pagesCaptured, 5);
    assert.equal(result.pagesFailed, 0);
    assert.deepEqual(navigated, defaults.seedPaths);
    assert.equal(dataReads, 5);
    assert.equal(result.pageResults.length, 5);
    for (const report of result.pageResults) {
      assert.equal(report.status, 'captured', report.url);
      assert.equal(report.scrollCompletion, 'end_observed', report.url);
      assert.equal(report.distinctProductRecords, 18, report.url);
      assert.ok(report.productObservations >= 18);
    }
    assert.equal(result.distinctProductRecords, 90);
    assert.equal(await page.evaluate(() => window.tradeClicks), 0);
    assert.equal(writes, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM issues WHERE code IN ('SCROLL_LIMIT_REACHED','SCROLL_TIME_LIMIT_REACHED','SCROLL_CONTAINER_UNCONFIRMED','UNCONFIGURED_TABS')").get().n, 0);
  } finally { await browser?.close(); store.close(); }
});

test('category tiles without roles navigate to catalog routes and headerless offer tables retain their own titles', { timeout: 30000 }, async () => {
  const defaults = await legacyFixtureConfig();
  const store = new Store(':memory:');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const landing = new URL(route.request().url()).pathname === '/produtos-de-investimento';
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><main>
        <h1>${landing ? 'Produtos de investimento' : 'Renda Fixa'}</h1>
        ${landing ? `<div style="cursor:pointer" onclick="location.href='/renda-fixa'"><span>Renda Fixa</span><p>Consulte o catálogo.</p></div>` : ''}
        <form><div><header><span class="product-name">CDB Sintético A</span></header><table>
          <tr><td>Tipo</td><td>CDB</td></tr><tr><td>Aplicação min.</td><td>R$ 500,00</td></tr>
          <tr><td>Rentab. 12M</td><td>9,20%</td></tr></table><button type="submit">Investir</button></div></form>
        <article><h3>CDB Sintético B</h3><table><tr><td>Tipo</td><td>CDB</td></tr>
          <tr><td>Liquidez</td><td>D+1</td></tr></table></article>
        <div><h3>Ambíguo A</h3><h3>Ambíguo B</h3><table><tr><td>Liquidez</td><td>D+2</td></tr></table></div>
        <div><table><tr><td>Rentab. 12M</td><td>8,30%</td></tr></table></div>
        </main><script>window.tradeClicks=0;document.querySelector('form').onsubmit=event=>{event.preventDefault();window.tradeClicks++};</script>
        </body></html>` });
    });
    const page = await context.newPage();
    const config = { ...defaults, settleMs: 10, maxScrollSteps: 10 };
    const result = await collect({ page, config, store, purpose: 'start' });
    assert.equal(result.pagesFailed, 0);
    assert.ok(result.productObservations > 0);
    const names = store.db.prepare('SELECT DISTINCT name FROM catalog_products').all().map(row => row.name).sort();
    assert.deepEqual(names, ['CDB Sintético A', 'CDB Sintético B']);
    assert.ok(store.db.prepare('SELECT snapshot_id,count(*) n FROM catalog_products GROUP BY snapshot_id').all().every(row => row.n === 2));
    const row = store.db.prepare("SELECT * FROM catalog_observations WHERE name='CDB Sintético A' AND view_name='auto:Renda Fixa'").get();
    assert.equal(row.source_url, `${defaults.baseUrl}/renda-fixa`);
    assert.equal(row.minimum_text, 'R$ 500,00');
    assert.equal(row.rate_text, null);
    assert.equal(JSON.parse(row.raw_fields_json)['Rentab. 12M'], '9,20%');
    assert.equal(await page.evaluate(() => window.tradeClicks), 0);
    assert.ok(store.db.prepare("SELECT count(*) n FROM issues WHERE code='PRODUCT_TABLE_TITLES_UNRESOLVED'").get().n > 0);
  } finally { await browser?.close(); store.close(); }
});

test('BTG browser fixture traverses categories, pagination and consultation details without clicking investment actions', { timeout: 60000 }, async () => {
  const defaults = await legacyFixtureConfig();
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
    assert.equal(page.url(), 'about:blank'); // Same starting state as a transferred CDP session.
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
