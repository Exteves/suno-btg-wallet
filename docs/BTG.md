# Catálogo BTG com Playwright e SQLite

O coletor abre `https://app.btgpactual.com/produtos-de-investimento`, aguarda seu
login/MFA no navegador e registra o catálogo apresentado à sua sessão. Consulte
também [README](../README.md) para instalação do Node.js e Chromium.

## Executar

```sh
npm run doctor -- --source btg
npm run scrape:btg
```

Depois do login, abra **Produtos de investimento** e pressione Enter no terminal.
Não envie senha, CPF ou códigos ao chat/terminal. O BTG usa uma sessão temporária:
este comando não requer `secret-tool`, não restaura a sessão da Suno e não salva
cookies/tokens bancários. O navegador fecha no fim.

O banco padrão é `privado/suno.sqlite`, compartilhado com as coletas da Suno. O
nome foi mantido para preservar o histórico existente. A coluna `runs.provider`
distingue as origens. As alterações de estrutura são aditivas; nenhum histórico
anterior é apagado. Para escolher outro arquivo:

```sh
npm run scrape:btg -- --db privado/outro.sqlite
# Use o mesmo caminho na coleta Suno se desejar reunir as fontes nesse banco:
npm run scrape -- --purpose start --db privado/outro.sqlite
```

`--purpose start|rebalance` registra somente a finalidade da consulta. Não inicia
ou rebalanceia uma carteira nas plataformas.

## Dados e alcance

São preservados texto renderizado, tabelas, linhas, cards e descrições rotuladas,
com fonte, data/hora UTC, categoria, aba e página. Campos identificados incluem
produto, ticker, ISIN, CNPJ do fundo, emissor, tipo, taxa, vencimento, liquidez,
aplicação mínima, preço, moeda, risco, garantias, custos, tributação, carência e
restrições. Campos adicionais permanecem em `raw_fields_json` e nos snapshots.
Um campo ausente permanece nulo; taxas e valores são textos literais da fonte.

A coleta percorre links de detalhes dentro do escopo e controles de categorias
reconhecidos que realmente existam na página. Links de categorias podem acrescentar
rotas como `/renda-fixa` ao escopo em memória quando o rótulo é reconhecido, o
domínio é o mesmo e o caminho é compatível com consulta de produtos. Não há lista
de URLs de produtos inventada nem tentativa de enumerar IDs não exibidos.

Abas e botões de categoria com nomes em `categoryTabNames` são percorridos com
limite de `maxTabs`. Paginação depende de `nextSelector` ou `loadMoreSelector`
validado. Cada rolagem salva o conteúdo antes de avançar, preservando linhas
virtualizadas já renderizadas. Uma área interna de rolagem pode ser detectada
automaticamente quando for a única; múltiplas áreas exigem
`scrollContainerSelector` e geram aviso quando ambíguas.

Detalhes em janelas de consulta podem ser coletados configurando, em conjunto,
`detailButtonSelector`, `detailDialogSelector` e `detailCloseSelector`. O nome do
produto na janela pode precisar de `productNameSelector`. O coletor guarda o
conteúdo e fecha a janela antes de continuar. Esses seletores iniciam vazios: sem
inspeção autenticada não é possível confirmar o comportamento dos controles reais.
Botões de detalhes detectados sem configuração geram
`PRODUCT_DETAILS_NOT_EXPANDED`. Detalhes em links são seguidos pelo escopo normal.

Os botões **Investir, Aplicar, Comprar, Vender, Resgatar, Simular, Reservar** e
controles de alteração não são acionados automaticamente. Requisições de escrita
são bloqueadas após o login, assim como navegação principal fora do escopo. O
login manual acontece antes desse bloqueio. Caso os dados dependam de uma API POST,
não libere requisições genéricas: as consultas precisam ser inspecionadas; apenas
GraphQL explicitamente de consulta e com caminho permitido é suportado hoje.

O catálogo pode variar por perfil, filtros, horário, estoque e habilitações da
conta. Ele não garante o universo de investimentos do BTG ou das bolsas. Produtos
que só possam ser acessados por um fluxo de negociação ficam pendentes. Cotações
ao vivo, disponibilidade para aplicação, PDFs, gráficos em canvas, iframes e
informações não renderizadas não são presumidos.

`availability = 'observed_in_catalog'` significa **observado no catálogo**, sem
confirmar disponibilidade para compra. As categorias esperadas não confirmadas
geram `CATEGORY_NOT_CONFIRMED`. BDRs, ETFs e fundos de investimento genéricos
permanecem separados de ações internacionais e FIIs. Uma seção genérica chamada
“Ações” fica sem classificação geográfica até haver evidência explícita.

O coletor BTG registra `CATALOG_VISIBILITY_LIMIT` e retorna `partial` (código de
saída 2) mesmo quando termina o percurso disponível: esse resultado não deve ser
interpretado como falha de gravação. Nenhum snapshot salvo resulta em `failed`
(código 1). Leia `issues` para distinguir esse limite dos erros de coleta.

## Ajustar à página real

Edite `btg.config.json` depois de inspecionar a página autenticada. A rota inicial
foi fornecida pelo usuário; os seletores internos ainda não foram confirmados.

- `contentSelector` e `readySelector`: contêiner e indicação de dados carregados.
- `cardSelector` e `productNameSelector`: identificação dos cards e detalhes.
- `productFieldMappings`: nomes literais dos cabeçalhos fora dos sinônimos conhecidos.
- `categoryPathMappings`: associações confirmadas entre `pathPrefix` e `category`.
- `views`: abas/expansões adicionais, com seletor de consulta explícito.
- `nextSelector`, `loadMoreSelector`, `scrollContainerSelector`: controles de listagem.
- `authenticatedSelector`: elemento exclusivo da página autenticada, se confirmado.
- `expectedCategories`: classes esperadas para o objetivo de pesquisa, sem supor oferta.

Compare contagens de cada categoria, páginas, detalhes e filtros com o banco antes
de alterar `layoutVerified`. Esse campo não verifica cobertura por si só. Não
alterar configurações da conta ou tentar contornar habilitações/assinaturas.

## Consultar produtos e comparar fontes

```sql
SELECT id, provider, started_at, purpose, status, summary_json
FROM runs ORDER BY id DESC;

SELECT code, detail FROM issues WHERE run_id = 1;

SELECT name, ticker, isin, issuer, category, rate_text, maturity_text,
       liquidity_text, minimum_text, risk_text, guarantee_text,
       availability, source_url, captured_at
FROM catalog_observations
WHERE provider = 'btg' AND run_id = 1;
```

`catalog_products` contém observações de produtos identificados;
`catalog_observations` acrescenta origem e data. Snapshots intermediários podem
repetir um produto com informações iguais ou atualizadas: não some observações
como se fossem posições pessoais. Nomes iguais não são usados para fundir ofertas
de emissores diferentes. Sem identificador público estável, `identity` fica nulo.

Uma comparação inicial com a Suno pode usar identificadores **exatos**, se o
mapeamento de ativos da Suno já estiver configurado:

```sql
SELECT DISTINCT s.identifier, b.name, b.category, b.source_url
FROM collected_records s
JOIN catalog_observations b ON upper(trim(s.identifier)) = upper(trim(b.ticker))
WHERE s.ownership = 'suno_recommendation' AND b.provider = 'btg';
```

A ausência de correspondência significa apenas que o ativo não foi localizado
nos dados coletados. Não comprova indisponibilidade no BTG. Posições pessoais,
recomendações e catálogo são fontes diferentes, sem equivalência presumida.

## Objetivo de alocação

O objetivo informado pelo usuário fica exclusivamente em
`privado/plano-carteira.json` e nas tabelas `allocation_plans` e
`allocation_targets`, fora do versionamento. Para registrá-lo novamente ou em
outro banco:

```sh
npm run wallet:plan
npm run wallet:plan -- --db privado/outro.sqlite
```

O registro é idempotente e conserva o total em centavos. Percentuais usam pontos
base (10.000 = 100%). O objetivo não é uma posição existente nem uma escolha de
produtos. A consolidação por ativos exige validar a coleta Suno/BTG e as
correspondências; o coletor não distribui dinheiro automaticamente nem envia ordens.

## Validação

`npm test` cobre política de consulta, separação entre fontes, campos literais,
identificação/classificação, migração do banco e conservação dos centavos do plano.
`npm run test:browser` inclui páginas sintéticas do BTG com categorias, paginação,
janela de detalhes e botões de negociação que não devem ser acionados.

Em 2026-11-03, este ambiente continua impedindo o lançamento do Chromium
(`BROWSER_PERMISSION_DENIED`) e a resolução DNS do BTG (`NETWORK_DNS_FAILED`). A
consulta pública da URL fornecida não expôs conteúdo legível. Nenhuma coleta
autenticada do BTG foi realizada; execute o comando em um terminal local com rede
e ambiente gráfico funcionais para validar os seletores reais.
