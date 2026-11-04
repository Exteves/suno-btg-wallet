# Catálogo BTG com Playwright e SQLite

O coletor abre `https://app.btgpactual.com/login` para autenticação manual. Após
login/MFA, abra **Produtos de investimento** no menu e confirme com Enter no
terminal. A coleta então registra o catálogo apresentado à sua sessão. Consulte
também [README](../README.md) para instalação do Node.js e Chromium.

## Escopo atual: cinco listas com carregamento progressivo

A coleta abre diretamente estas rotas, na ordem abaixo:

1. `/produtos-de-investimento/renda-fixa/credito-bancario`
2. `/produtos-de-investimento/renda-fixa/titulos-publicos`
3. `/produtos-de-investimento/renda-fixa/tesouro-direto`
4. `/produtos-de-investimento/renda-fixa`
5. `/produtos-de-investimento/fundos-de-investimento`

`collectionPaths` limita a navegação de coleta a esses caminhos exatos.
`followDiscoveredLinks: false`, `autoTabs: false` e `views: []` evitam percorrer
outros produtos/categorias ou permutações de abas. A página inicial do catálogo
continua disponível para confirmar o login e selecionar a aba CDP, antes da coleta.
O histórico anterior do SQLite permanece preservado.

Cada lista começa no topo. O coletor salva a janela inicial e cada janela revelada
após avançar cerca de 70% da área visível, incluindo listas virtualizadas que
substituem linhas sem aumentar a altura total. Detecta áreas internas descendentes
ou ancestrais de `main`, mesmo quando o documento também tem rolagem. Havendo
várias listas independentes e ambíguas, registra aviso para configurar
`scrollContainerSelector`.

O fim é observado quando há pelo menos três amostras no final da lista, durante
10 segundos sem alterações de conteúdo/geometria, sem indicador de carregamento e
sem consultas de dados permitidas pendentes. Isso é um critério de estabilização,
não comprovação de catálogo integral. `scrollIdleMs`, `scrollBottomSamples`,
`maxScrollSteps` (1500) e `maxScrollDurationMs` (300000) controlam esse percurso.
Limites atingidos geram avisos e conclusão parcial, não uma indicação de fim.
Os tempos de navegação e operações do Playwright têm seus próprios limites.

Durante a rolagem, o terminal informa a cada aproximadamente 10 segundos o tempo,
passo, registros distintos já salvos e se está percorrendo, confirmando o fim ou
aguardando indicador/consultas. Cada página também tem uma mensagem de encerramento.
`progressIntervalMs` configura esse intervalo; as mensagens são emitidas entre
amostras, sem imprimir ativos, valores ou credenciais.

Se conteúdo, posição e dimensões não mudarem durante `scrollNoProgressMs` (45000),
um carregamento persistente encerra aquela lista como parcial, com
`scrollCompletion: "loading_stalled"` e `SCROLL_LOADING_STALLED`. Os dados já salvos
permanecem. Isso não deve ser tratado como catálogo completo. Leituras de fundo
sem relação com produtos não impedem o fim da lista; os erros dessas leituras
continuam no diagnóstico. Uma barra de progresso já no valor máximo não conta
como carregamento. Mudanças apenas no índice DOM usado para descrever o contêiner
também não reiniciam a espera de estabilidade.

Se um processo já estiver executando ao atualizar o código, ele continua usando
os módulos carregados anteriormente. Deixe-o concluir para preservar o percurso;
as mudanças entram na próxima execução. Não inicie outra coleta em paralelo.

O JSON final inclui `pageResults`: URL, status, snapshots, observações, registros
distintos e `scrollCompletion` de cada página. `end_observed` indica fim estável;
`time_limit`, `step_limit`, `container_unconfirmed` e `scroll_stalled` indicam
interrupção da rolagem. Uma página com mensagem de falha no carregamento fica
`failed`, com `APPLICATION_LOAD_ERROR`; as demais continuam sendo consultadas.
Uma página capturada sem produtos identificados fica `no_products` e gera
`NO_PRODUCTS_ON_PAGE`.
`scrollSteps` e `scrollElapsedMs` registram o percurso; `loading_stalled` também é
uma interrupção parcial por ausência de progresso, não um fim observado.

HTTP 401 em uma API de produtos é tratado separadamente: interrompe a coleta com
`API_AUTHENTICATION_REQUIRED`, `reauthenticationRequired: true` e indicação das
páginas não visitadas. Não continua pelas cinco páginas com a mesma autorização
recusada. Um 403 permanece erro de acesso distinto; um 401 de recurso sem relação
com o catálogo não é usado para invalidar a sessão. Uma resposta de sucesso na
mesma consulta limpa a indicação de 401 caso o frontend já tenha se recuperado.

Se houver 401, confira primeiro a página de títulos públicos na janela manual,
recarregando-a antes de iniciar a coleta. Se pedir login ou falhar, autentique
novamente. Para uma sessão nova, encerre o Chrome temporário pelo primeiro terminal
com Ctrl+C, execute `npm run btg:browser`, faça login/MFA e confirme que a lista
permanece acessível após recarregar. Depois conecte o coletor pelo comando CDP.
Se a lista funcionar na janela manual, mas o contexto de coleta receber 401,
isso exige investigar a transferência da sessão; não comprova expiração da sessão
manual, nem autoriza retirar os bloqueios. A mensagem de página confirmada no
terminal não é uma verificação das APIs no contexto novo.

`productObservations` conta observações em todos os snapshots, inclusive repetições.
`distinctProductRecords` remove repetições pelo fingerprint de URL e campos literais;
não garante identidades financeiras distintas nem funde ofertas de mesmo nome.
Os cabeçalhos `Produto e risco` e `Aplicação min.` são reconhecidos, preservando
seus textos originais. As categorias esperadas agora são renda fixa e fundos de
investimento; FIIs e ações não são exigidos nesta coleta restrita.

Na execução 6, o filtro genérico de `account`/`buy` bloqueou endpoints usados nos
módulos das listas. As exceções de leitura agora aceitam somente GET XHR/fetch na
origem da aplicação ou em subdomínio HTTPS do BTG (porta padrão), nestes formatos:

- `/investments/api/fixed-income/accounts/<id>/fixedincomes`
- `/investments/api/fixed-income/combo/account/<id>`
- `/investments/api/government-bond/account/<id>`
- `/investments/api/treasury/buy/account/<id>/bonds`
- `/investments/api/fund-subscription/v2/account`

Os IDs são segmentos alfanuméricos com hífen/underscore; sufixos de operação,
navegação, origens externas, portas alternativas, parâmetros de sobrescrita de
operação e métodos de escrita não recebem exceção. Alterações de preferências e
outros caminhos de conta continuam recusados.

A execução 7 confirmou POSTs no carregamento das listas de crédito bancário e
fundos. `src/catalog-query.js` adiciona exceções para os caminhos exatos
`fixed-income/accounts/<id>/fixedincomes` e `fund-subscription/v2/account`, somente
na origem da aplicação, como XHR/fetch do frame principal da página correspondente.
A chamada de crédito também pode partir da página geral de renda fixa. Não há
replay, construção de payloads ou fallback para outro método: o coletor só deixa
prosseguir a chamada produzida pelo próprio frontend.

O corpo deve ser um objeto contendo apenas campos de contexto, filtros,
paginação e ordenação reconhecidos. Valores, arrays e profundidade são limitados;
campos de ordem, ativo a aplicar, valor/quantidade de operação, confirmação,
credenciais ou estrutura desconhecida são recusados. Filtros podem especificar
limites mínimos/máximos de pesquisa; `amount` e `quantity` de operação são recusados,
inclusive aninhados. Os valores são inspecionados somente em memória, sem gravação.
A interpretação como consulta decorre da página de origem e da estrutura aceita;
não foi localizado um contrato público dessas APIs. Os corpos reais não foram
disponibilizados, portanto a compatibilidade da lista de campos exige nova coleta.

POST recusado nesses dois endpoints inclui `query_check`: `UNRECOGNIZED_FIELD`,
`TRANSACTION_FIELD`, `INVALID_STRUCTURE`, `INVALID_VALUE` ou `BODY_UNAVAILABLE`.
São códigos fixos; campos e valores privados do corpo não aparecem no diagnóstico.
Não substituir uma recusa de estrutura desconhecida por permissão genérica de POST.

Quando `query_check` for `UNRECOGNIZED_FIELD`, `query_fields` lista somente rótulos
de campos e seus tipos (`string`, `number`, `array`, etc.), sem valores. O número
de descritores e a profundidade são limitados. Rótulos numéricos/dinâmicos,
credenciais e identificadores opacos são removidos; números de conta, CPF, tokens,
valores financeiros e conteúdo de pesquisa não são registrados. Isso permite
avaliar o formato efetivamente enviado pelo frontend sem adivinhar novos campos.
Esses descritores não liberam automaticamente uma consulta recusada.

`REQUEST_BLOCKED_READ_ONLY` guarda agora método, tipo de recurso, classificação da
origem e caminho sanitizado. `pageResults[].blockedRequestTypes` mostra somente os
caminhos de investimentos bloqueados; telemetria continua registrada em `issues`.
`DATA_REQUEST_HTTP_ERROR` e `DATA_REQUEST_FAILED` registram status HTTP ou códigos
fixos de rede das leituras permitidas, também em `dataRequestFailures` por página.
Não são registrados domínios completos, parâmetros, headers, payloads, mensagens
brutas ou respostas das APIs; IDs de conta/cliente são removidos dos caminhos.

A rolagem usa movimentos imediatos e confirma ausência de progresso em múltiplas
amostras antes de declarar `scroll_stalled`. Isso evita confundir uma posição
observada durante uma animação com uma lista imóvel. O estado numérico de rolagem
fica em `scrollState` quando a rolagem trava. Referência: [scrollTo no MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTo).

## Quando o acesso manual funciona e a abertura pelo Playwright falha

Há um modo opcional que abre o Chrome instalado em um processo separado e só
conecta o Playwright após você autenticar e abrir o catálogo. Ele não altera
user-agent, indicadores de automação, certificados ou políticas do site. O BTG
pode continuar recusando a conexão ou a coleta; esse modo não é uma garantia de
compatibilidade nem de autorização da automação pelo banco.

No **primeiro terminal**, execute:

```sh
npm run btg:browser
```

Uma janela anônima será criada em um Chrome com diretório auxiliar temporário,
separado do seu perfil habitual. Faça login/MFA manualmente e abra **Produtos de
investimento** pelo menu. Deixe somente uma aba desse catálogo aberta.

No **segundo terminal**, execute:

```sh
npm run scrape:btg -- --cdp http://127.0.0.1:9222
```

Confirme com Enter a aba que deseja consultar. A porta de depuração dá controle
ao Chrome dessa sessão; por isso o utilitário usa somente `127.0.0.1` e um perfil
descartável. Não a exponha à rede nem aponte o coletor ao seu perfil habitual. O
coletor recusa endpoints externos, URLs com credenciais/parâmetros e abas em
contextos comuns. A janela anônima é criada pela API oficial `Target.createBrowserContext`.

Se uma versão anterior terminou com `pagesCaptured: 0`, `pagesFailed: 0` e apenas
avisos de catálogo, havia um erro na fila inicial: a rota relativa do catálogo era
resolvida contra a aba nova `about:blank`. Esse problema foi corrigido; as rotas
iniciais usam a origem configurada do site. Se todas as rotas iniciais forem
recusadas por configuração/escopo, a execução agora informa
`failureReason: "INITIAL_URLS_REJECTED"`, em vez de apenas avisos de catálogo.
Execuções anteriores permanecem no histórico do SQLite.

Uma página capturada com `productObservations: 0` pode ser a página inicial de
categorias, sem identificação dos produtos destacados. Na execução 4, o SQLite
continha 16 tabelas sem cabeçalhos, com pares rótulo/valor; o extrator anterior não
associava essas tabelas aos títulos dos produtos e não encontrou links de categorias.
Agora o coletor tenta associá-las a um título único no contêiner de cada oferta,
reconhece `Aplicação min.` e busca categorias em tiles interativos e atributos
`routerlink`/`data-href`. Retornos `Rentab. 12M` ficam como campos literais, sem serem
convertidos em taxa oferecida. A integração com o layout real ainda exige nova coleta.

`PRODUCT_TABLE_TITLES_UNRESOLVED` indica tabelas cujo título não foi associado com
segurança; o aviso inclui somente índices e tags ancestrais para ajuste estrutural.
`CATALOG_CATEGORIES_NOT_FOUND` indica ausência de controles de categoria reconhecidos.
`blockedRequests` conta requisições recusadas pela política de consulta, inclusive
telemetria; não corresponde ao número de produtos perdidos. Não liberar POSTs
genéricos ou alterações de preferências para tentar zerar esse contador.

Os caminhos nos avisos de bloqueio agora removem identificadores de conta/cliente.
Ao abrir o banco, o coletor também sanitiza avisos antigos desse tipo, preservando
o status, os snapshots e as contagens das execuções anteriores.

O programa não exporta cookies ou estado bancário para arquivo. A transferência
usa, somente em memória, cookies BTG do contexto anônimo selecionado e
localStorage/sessionStorage da página da aplicação. O contexto recebe um novo
destino de coleta com service workers bloqueados e a política de consulta. O
estado completo do perfil de origem não é acessado. Neste modo, IndexedDB e chaves
vinculadas ao contexto de origem não são transferidos; se forem exigidos para
autenticação, a transferência pode falhar e será necessário avaliar uma forma de
acesso suportada pelo BTG. Não liberar operações ou retirar proteções para tentar
manter uma sessão recusada.

O catálogo é escolhido pelo ID do alvo e do contexto anônimo, evitando capturar
cookies do contexto padrão que o Playwright pode usar ao representar sessões CDP
pré-existentes. A janela manual não é fechada pelo coletor. Ao terminar a coleta,
feche as janelas desse Chrome e encerre o primeiro terminal com **Ctrl+C**. O
utilitário encerra seu próprio processo e remove o diretório auxiliar. Uma
interrupção abrupta pode impedir a limpeza; não há promessa de apagamento físico
ou ausência de arquivos temporários internos do navegador.

Se a porta estiver ocupada, escolha outra no primeiro terminal e use o mesmo
número no segundo:

```sh
npm run btg:browser -- --port 9333
npm run scrape:btg -- --cdp http://127.0.0.1:9333
```

`btg:browser` usa `google-chrome` por padrão; `--browser-path /caminho/do/chrome`
seleciona outro executável instalado. `--cdp` é exclusivo do BTG e não pode ser
combinado com `--browser-channel`, `--browser-path`, `--diagnose-login` ou modos de
login/persistência do coletor. Ele conecta à sessão já aberta; não inicia login.
Não é possível habilitar CDP retroativamente na janela usada no teste manual.

Referências: [conexão CDP no Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
e [isolamento de depuração no Chrome](https://developer.chrome.com/blog/remote-debugging-port).
A integração com o BTG permanece pendente de validação real. Os testes dessa
conexão usam protocolo simulado, sem contas ou credenciais reais.

## Executar

```sh
npm run doctor -- --source btg
npm run scrape:btg
```

Depois do login, abra **Produtos de investimento** e pressione Enter no terminal.
Não envie senha, CPF ou códigos ao chat/terminal. O BTG usa uma sessão temporária:
este comando não requer `secret-tool`, não restaura a sessão da Suno e não salva
cookies/tokens bancários. O navegador fecha no fim.

Durante o login, `authServiceWorkers: "allow"` permite o funcionamento normal dos
service workers do site. Após a confirmação com Enter, o programa transfere
cookies, localStorage, IndexedDB e sessionStorage de primeira parte **somente em
memória** para outro contexto temporário, com service workers bloqueados. O
contexto de autenticação é fechado antes da coleta. Não há arquivo de estado de
sessão do BTG. Essa separação preserva a interceptação das requisições durante a
coleta; não implica que todo mecanismo de autenticação bancária seja portável
entre contextos. Se a sessão não puder ser reutilizada, interrompa a coleta e
verifique o fluxo; não libere requisições de negociação para tentar resolver.

## Quando o login fica carregando

O ponto de entrada foi corrigido em 2026-11-04: antes o programa abria diretamente
`/produtos-de-investimento` sem autenticação; agora usa `loginPath: "/login"` e
mantém `entryPath` e o escopo da coleta no catálogo. Esse é o fluxo descrito na
[orientação oficial do BTG](https://banking.btgpactual.com/ajuda/contacorrente/informederendimentos).
O ajuste corrige a ordem de navegação, mas não comprova que era a causa de todos
os erros de acesso. `/login` só é aberto antes da coleta; não foi incluído no
escopo de navegação automática após a autenticação.

Se o diagnóstico mostrar `ready_state: "complete"`, nenhum campo visível,
`SCRIPT_MODULE_LOAD_ERROR` e HTTP 403 de script na origem `application`, o
documento foi carregado e houve falha de carregamento de JavaScript da aplicação.
Isso é compatível com a tela branca, sem identificar o motivo da recusa do script.
Uma requisição recusada na mesma origem ainda pode corresponder a uma camada de
CDN/segurança; não é prova de bloqueio específico da conta ou de automação.

Teste a correção com a coleta normal, que mantém a janela aberta para você entrar:

```sh
npm run scrape:btg -- --browser-channel chrome
```

Se `/login` também permanecer branco, compare com a mesma URL aberta manualmente
no mesmo Chrome/sistema/rede, fora do Playwright. Não repita instalações ou altere
proteções do navegador como solução presumida. Essa comparação ainda é necessária
para avaliar uma recusa de acesso que não pode ser reproduzida neste ambiente.

Uma versão anterior bloqueava service workers antes de qualquer credencial, o
que pode afetar aplicações que dependem deles. A configuração foi ajustada, mas
essa hipótese ainda não foi confirmada na página real do BTG. O bloqueio de
requisições da coleta só é instalado depois do login; ele não era a causa do
travamento relatado antes das credenciais.

Primeiro, execute novamente `npm run scrape:btg`. Compare o comportamento com seu
navegador habitual na mesma máquina/rede. Para testar o Chrome ou Edge instalado:

```sh
npm run scrape:btg -- --browser-channel chrome
# Ou:
npm run scrape:btg -- --browser-channel msedge
```

O navegador escolhido precisa estar instalado **no mesmo sistema em que o Node
executa**; um Chrome do Windows não fica automaticamente disponível como canal
Chrome no Linux/WSL. `--browser-path` continua disponível para um executável
compatível, mas não pode ser combinado com `--browser-channel`. Não há alteração
de user-agent, ocultação de automação, desativação de certificados ou uso de perfil
pessoal persistente. Essa opção testa compatibilidade do navegador; não contorna
controles de acesso do banco.

Se a tela continuar travada, execute o diagnóstico sem digitar credenciais:

```sh
npm run scrape:btg -- --diagnose-login
# Opcionalmente, no navegador instalado:
npm run scrape:btg -- --browser-channel chrome --diagnose-login
```

O modo observa o carregamento por 15 segundos após DOMContentLoaded, imprime um
resumo no terminal e fecha a janela. Se a navegação falhar antes disso, imprime a
causa e as contagens disponíveis. Não acessa o cofre de sessão, não coleta produtos
e não abre o banco SQLite. A navegação inicial respeita o timeout configurado.

O resumo contém somente versão do navegador, modo dos service workers, códigos
de falha de rede, status HTTP, tipos de recurso e contagens de erros JavaScript/
console. O campo `origin_scope` distingue `application` (origem da aplicação),
`provider` (outro domínio do mesmo provedor), `external` (serviço externo) e
`unknown` (sem classificação). Essa classificação é derivada em memória, sem
registrar o domínio ou o endereço. Console/JavaScript ficam em `unknown`, pois os
endereços dentro de mensagens não são extraídos. Recurso externo não significa recurso dispensável:
serviços externos podem participar do login.

Desde a versão 2 do diagnóstico, o resumo inclui `diagnostic_version: 2`.
Somente no modo `--diagnose-login`, anterior às credenciais, mensagens de console e
exceções são classificadas em memória em códigos fixos: `CORS_ERROR`,
`CONTENT_SECURITY_POLICY_ERROR`, `SCRIPT_MIME_TYPE_ERROR`,
`SCRIPT_MODULE_LOAD_ERROR`, `SERVICE_WORKER_ERROR`, `BROWSER_STORAGE_ERROR`,
`UNSUPPORTED_BROWSER_MESSAGE` e tipos genéricos de exceção JavaScript. O texto é
descartado, não impresso nem salvo; parâmetros, objetos de console e stacks não
são coletados. Durante uma coleta normal, o monitor continua apenas contando erros
genéricos, sem inspecionar suas mensagens. As categorias indicam padrões de erro,
sem provar causa ou autorizar desabilitar CORS/CSP, certificados ou outras proteções.

`page_state` registra o estado de carregamento do documento e quantidades de campos,
formulários e indicadores de ocupação visíveis no documento principal. Não lê
valores, rótulos, texto, títulos ou endereços da página. As contagens não cobrem
controles dentro de iframes ou shadow DOM, nem comprovam que o formulário de login
esteja pronto. A observação tem limite de dois segundos e pode aparecer como
`unavailable`.

URLs, caminhos, parâmetros, cabeçalhos, corpos, mensagens brutas, conteúdo
de página e credenciais não são registrados. Nenhum relatório é enviado a serviços
externos. As contagens ajudam a investigar; um status 401/403 ou erro JavaScript
isolado não comprova a causa nem implica credenciais incorretas. Um resumo sem
eventos também não comprova que o formulário de login carregou.

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

A configuração atual percorre somente as cinco listas especificadas acima e sua
rolagem progressiva. Descoberta de links, abas e outras categorias fica desativada.
Paginação por botão, se alguma lista a exigir, depende de `nextSelector` ou
`loadMoreSelector` validado; um botão detectado sem configuração gera aviso.

Detalhes em janelas de consulta podem ser coletados configurando, em conjunto,
`detailButtonSelector`, `detailDialogSelector` e `detailCloseSelector`. O nome do
produto na janela pode precisar de `productNameSelector`. O coletor guarda o
conteúdo e fecha a janela antes de continuar. Esses seletores iniciam vazios: sem
inspeção autenticada não é possível confirmar o comportamento dos controles reais.
Botões de detalhes detectados sem configuração geram
`PRODUCT_DETAILS_NOT_EXPANDED`. Links para outras rotas de detalhes não são
seguidos na configuração atual.

Os botões **Investir, Aplicar, Comprar, Vender, Resgatar, Simular, Reservar** e
controles de alteração não são acionados automaticamente. Requisições de escrita
são bloqueadas após o login, assim como navegação principal fora do escopo. O
login manual acontece antes desse bloqueio. POST é aceito apenas para as duas
consultas de catálogo com validação descritas acima ou GraphQL explicitamente de
consulta e com caminho permitido. Os demais POSTs permanecem bloqueados.

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
- `loginPath`: entrada pública de autenticação; `entryPath` permanece sendo o catálogo.
- `seedPaths` e `collectionPaths`: as cinco rotas solicitadas, com escopo exato durante a coleta.
- `followDiscoveredLinks`, `autoTabs`, `views`: manter desativados/vazios para este escopo.
- `cardSelector` e `productNameSelector`: identificação dos cards e detalhes.
- `productFieldMappings`: nomes literais dos cabeçalhos fora dos sinônimos conhecidos.
- `categoryPathMappings`: associações confirmadas entre `pathPrefix` e `category`.
- `nextSelector`, `loadMoreSelector`, `scrollContainerSelector`: controles de listagem.
- `scrollIdleMs`, `scrollBottomSamples`, `scrollNoProgressMs`, `maxScrollSteps`, `maxScrollDurationMs`: estabilização e limites da rolagem.
- `progressIntervalMs`: frequência das mensagens durante a rolagem.
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
`npm run test:browser` inclui uma página de login sintética que aguarda um service
worker, transferência de sessão em memória, e páginas do BTG com categorias, paginação,
janela de detalhes e botões de negociação que não devem ser acionados.

Em 2026-11-03, este ambiente continua impedindo o lançamento do Chromium
(`BROWSER_PERMISSION_DENIED`) e a resolução DNS do BTG (`NETWORK_DNS_FAILED`). A
consulta pública da URL fornecida não expôs conteúdo legível. Nenhuma coleta
autenticada do BTG foi realizada; execute o comando em um terminal local com rede
e ambiente gráfico funcionais para validar os seletores reais.
