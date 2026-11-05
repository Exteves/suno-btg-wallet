# Contexto — 2026-11-02

## Execução BTG 13: fundos com consulta pendente e recuperação limitada — 2026-11-05

Usuário enviou run13 partial: crédito 666/end_observed, títulos 41/end_observed,
Tesouro 36/end_observed, renda fixa geral um/end_observed, fundos 480/loading_stalled.
Total 1224 fingerprints distintos; sem falhas de página. Estado final de fundos
mostra documento no fundo, busy=false, ao menos uma consulta pendente, sem mudanças
por 46184ms. SQLite confirmou somente SCROLL_LOADING_STALLED além dos avisos
normais. Não houve HTTP 401/403 nem erro de rede registrado. Não afirmar que chegou
ao fim, nem que falta de erro HTTP prova consulta saudável: o observador antigo
não guardava endpoint/idade/etapa das pendências.

watchCollectionLoads agora conserva temporização em memória e expõe apenas path
sanitizado, método/tipo/origem, ageMs, estágio e status numérico das consultas de
catálogo em voo (limite 20). Sem headers, query, body ou dados privados. Navegação
controlada/main-frame limpa pendências do documento antigo; iframe não limpa.
401 confirmado permanece até sucesso da mesma consulta, não some por reload.

Adicionado walkWithRecovery: uma recarga por padrão no BTG após loading_stalled,
com snapshots anteriores preservados e orçamentos de tempo/passos compartilhados
entre tentativas e espera da recarga. Não refaz fetch/POST manualmente nem altera
payloads/guard. A própria página é recarregada no contexto de coleta; sessão manual
continua separada. Sem recarga para 401, exceções de acesso, time_limit ou step_limit.
SCROLL_RELOAD_AFTER_STALL e scrollRecoveries registram a tentativa e pendências;
se persistir, final permanece parcial com pendingRequests e scrollReloads.

Nova opção BTG --only-path, repetível, aceita somente seeds exatas já configuradas.
Reduz collectionPaths/fila/maxPages/categorias esperadas e mantém login/CDP igual.
Permite repetir apenas /produtos-de-investimento/fundos-de-investimento sem
recapturar as quatro listas concluídas; resultado vira nova run, não apaga histórico.

83 testes unitários passaram: leitura de pendências sanitizadas, limpeza por
documento, retenção de 401, recuperação com relógio simulado, preservação de janelas,
uma tentativa máxima, orçamento não reiniciado, erro de autenticação propagado e
seleção de caminhos sem ampliar escopo. CLI --help validada. Fixture real de browser
preparada para POST de fundos preso, reload e captura posterior completa; ainda
não validada neste ambiente que já bloqueou lançamento do Chromium. Documentação
oficial Playwright Page.reload/framenavigated/Request consultada sem dados privados.
Não reclassificar run13 como sucesso; solução precisa de nova coleta autenticada.

## Execução BTG 12: fundos cortados pelo orçamento global — 2026-11-05

Usuário enviou execução 12 partial com cinco páginas capturadas e zero falhas:
crédito 590 registros distintos/end_observed; títulos públicos 30/end_observed;
Tesouro 36/end_observed; renda fixa geral um/end_observed; fundos 530/time_limit
aos 300493ms. Total 1187 fingerprints distintos, não necessariamente ativos únicos.
Consulta local confirmou somente SCROLL_TIME_LIMIT_REACHED como falha de percurso,
além dos avisos normais de layout/cobertura/requisições bloqueadas. Os logs mostram
novos lotes em fundos no fim do orçamento; não considerar essa lista completa nem
usar os 659 registros da execução 11 como meta garantida (ofertas/campos variam).

Adicionado scrollDurationByPath, validado para caminhos exatos já permitidos,
com valores inteiros finitos maiores que a espera de estabilidade. Configuração
BTG dá 900000ms (15min) a fundos e preserva 300000ms para as outras listas.
scrollConfigForPage aplica cópia do orçamento apenas à rota da página atual; não
muda política de requisições, escopo, passos, estabilidade ou inatividade de 45s.
Terminal mostra tempo/limite e resumo por página inclui scrollTimeLimitMs.
Histórico da execução 12 não foi modificado. Sem commit automático das novas
alterações: usuário havia solicitado commit de mudanças anteriores, e o repositório
estava limpo no início deste turno; este ajuste é posterior.

79 testes unitários passaram. Regressão de relógio simulado confirma que fundos
consegue terminar após cinco minutos, outras listas continuam limitadas e a
configuração original não é mutada. Configuração rejeita rotas fora do escopo,
queries, arrays e durações inválidas. Não foram necessários novos seletores nem
testes de navegador para o cálculo de tempo; validação do novo orçamento no BTG
depende da próxima coleta manual/CDP. Não afirmar completude antes de end_observed.

## Execução BTG 11 concluída nas cinco páginas — 2026-11-04

Ao perguntar "e agora?", usuário já tinha executado a versão atual. Consulta
somente leitura ao SQLite confirmou run11 finalizada às 22:21:30 UTC, em cerca de
6m42s, com cinco páginas capturadas, zero falhas e end_observed nas cinco listas.
141 snapshots, 43889 observações e 788 fingerprints distintos: crédito bancário
51, títulos públicos 41, Tesouro Direto 36, página geral de renda fixa um, fundos
659. Categorias: fixed_income 129 registros, investment_funds 659. São registros
por fonte/campos, não 788 ativos financeiros únicos nem posições do usuário.

Status global partial decorre somente de LAYOUT_NOT_VERIFIED, CATALOG_VISIBILITY_LIMIT
e 48 REQUEST_BLOCKED_READ_ONLY. Não houve erros de API, campos recusados, categorias
desconhecidas/não confirmadas ou limites de rolagem. Caminhos bloqueados são os de
coleta/rum/replay/delivery/pixel e homebroker-onboarding; não liberar mais endpoints
apenas para zerar avisos. Não mudar layoutVerified sem comparar cobertura real.
Coleta do percurso configurado funcionou; não afirmar totalidade do catálogo do BTG
ou disponibilidade para comprar. Histórico permanece intacto, sem nova navegação,
credenciais, alteração de conta ou escrita nos dados de runs pelo agente.
Run10 também já havia terminado partial às 20:38:56 UTC; não está mais executando.

## Execução BTG 10: aparente travamento e progresso silencioso — 2026-11-04

Usuário relatou parada no terminal em página 3 (Tesouro). Leitura somente de
metadados SQLite confirmou processo ainda running e avançando: primeiro títulos
41 registros e Tesouro 36 já capturados, ambos com SCROLL_TIME_LIMIT_REACHED;
depois página geral capturada com um registro e fundos em coleta. Na última
consulta durante este trabalho, fundos já tinha 5290 observações e 230 fingerprints
distintos. São registros de catálogo, não posições nem comprovação de 230 ativos
financeiros únicos. Não terminar/interromper esse processo pelo agente nem alterar
seus registros; pode deixar concluir. Alterações de código não atualizam o processo
Node já aberto, e não deve haver outra coleta em paralelo.

Diagnóstico de crédito agora trouxe os campos reais page:number,
orderByColumn:string e orderByDirection:string, sem valores. As duas propriedades
de ordenação foram adicionadas à validação positiva; ordens/operações continuam
recusadas. Não foram inventados campos adicionais nem lidos valores do body.

Melhorias para próxima execução: progresso aproximadamente a cada 10s durante
rolagem, com tempo/passo/contagem/espera, e encerramento por página. Final só depende
das consultas de produtos em voo, não de qualquer fetch do mesmo provedor;
diagnóstico de erros continua cobrindo leituras permitidas. Barras com valor máximo
já atingido não contam como loading. Índice DOM do contêiner deixa de integrar
assinatura de estabilidade, pois nós externos podem alterá-lo sem mudar a lista.

scrollNoProgressMs=45000 encerra parcial com loading_stalled e SCROLL_LOADING_STALLED
se lista/posição/dimensões ficam iguais e busy/consultas persistem; não declarar fim
nem ignorar carregamento pendente. Mudanças reais reiniciam o limite de inatividade.
Mantido limite global 300000ms e dados de cada janela, inclusive última amostra.
Config progressIntervalMs=10000; resumo acrescenta scrollSteps/scrollElapsedMs.
Não afirmar qual sinal exato prendeu a execução antiga: o banco mostra snapshots
estáveis e limites, mas não captura o estado DOM/rede de cada passo. MDN progressbar
e documentação oficial Playwright Page consultados sem dados privados.

78 testes unitários passaram, cobrindo inatividade com busy/rede, progresso,
índice DOM instável, leituras de fundo, reset por dados novos e nomes de ordenação
observados. Fixture de navegador preparada com progressbar concluído e o POST de
crédito observado; execução real das alterações continua pendente, pelo bloqueio
Chromium já demonstrado aqui. Run10/histórico permanecem intactos.

## Execução BTG 9: APIs retornam 401 e crédito tem campo desconhecido — 2026-11-04

Usuário enviou execução 9 failed, zero snapshots/produtos, cinco páginas falhas.
Confirmado no SQLite: sete DATA_REQUEST_HTTP_ERROR com status 401, inclusive GETs
de títulos/Tesouro e POST permitido de fundos. Crédito ainda foi recusado por
UNRECOGNIZED_FIELD. São causas diferentes; liberar mais POSTs não resolve 401.
HTTP 401 indica ausência de credenciais válidas para o recurso, mas não prova
expiração versus estado insuficiente no contexto transferido. Não afirmar causa
específica sem comparação com janela manual. Fontes oficiais MDN 401 e Playwright
Authentication consultadas sem dados privados.

Metadados temporais: execução 7 terminou por volta de 16:50 UTC; a 8 rodou de 17:30
a 17:46 UTC e ficou partial (47 registros distintos em títulos, um Tesouro e dois
na página geral; três time_limit e duas falhas). A 9 ocorreu 18:00 UTC e falhou
rapidamente. Isso não estabelece TTL nem motivo da falha. Nenhum token foi
inspecionado/decodificado; nenhum dado financeiro de produtos foi lido.

Corrigido tratamento de autenticação: watchCollectionLoads acompanha 401 de APIs
BTG de produtos e limpa o sinal se a mesma consulta tiver sucesso. collect()
prioriza API_AUTHENTICATION_REQUIRED, para após a primeira página afetada, marca
reauthenticationRequired/failureReason e páginas não visitadas; não gera avisos
secundários de identificação/categorias nessa parada. CLI deixa de afirmar login
confirmado antes de testar APIs no contexto novo, e orienta nova autenticação.
Transferência de cookies/storage não foi alterada especulativamente; segue em
memória, workers bloqueados e sem estado BTG em disco. Pergunta opcional enviada:
se títulos públicos ainda mostra ativos após refresh na janela manual, antes da
coleta; sem resposta até esta anotação.

Para campos desconhecidos de consultas, guard agora emite query_fields com rótulos
de campos/tipos somente, sem valores. Limites de tamanho/profundidade e remoção
de rótulos numéricos/dinâmicos, credenciais e strings opacas; sanitização repetida
na fronteira SQLite. Isso não altera a validação positiva nem libera campos novos.
Não pedir bodies, HAR, headers ou tokens ao usuário. A leitura dos nomes reais dos
campos desconhecidos depende da próxima coleta; não inventar um mapeamento.

73 testes unitários passaram, cobrindo parada em 401 com HTML 200, distinção de
403/recursos não relacionados, recuperação e privacidade dos descritores.
Nenhuma nova sessão foi acessada pelo agente nem registros 7/8/9 reclassificados.
Teste de navegador permanece dependente do terminal local, pois este ambiente
já impediu Chromium. Para retomar: primeiro comparar lista recarregada na janela
manual; se expirada, novo login/MFA antes de conectar CDP. Se manual funciona e
cópia recebe 401, investigar transferência sem retirar guard nem tentar bypass.

## Execução BTG 7: três páginas coletadas, duas consultas POST bloqueadas — 2026-11-04

Usuário enviou execução 7: três páginas capturadas e duas falhas, 79 registros
distintos (41 títulos públicos, 36 Tesouro Direto, dois da página geral de renda
fixa), todos com end_observed nas páginas capturadas. Consulta local confirmou as
contagens e que os dois APPLICATION_LOAD_ERROR correspondem a crédito bancário e
fundos. Seus avisos agora comprovam método POST, origem application e tipo fetch
nos endpoints fixed-income/accounts/.../fixedincomes e fund-subscription/v2/account.
Homebroker-onboarding GET continua bloqueado; não foi necessário às três páginas.

Adicionado src/catalog-query.js: exceções somente para esses dois POSTs exatos,
produzidos como fetch/XHR pelo frame principal da página de origem correspondente,
na mesma origem BTG, sem query/hash no endpoint nem sufixos. Crédito também pode
ser consultado na página geral de renda fixa. Validação positiva de corpo objeto
com contexto/filtros/paginação/ordenação reconhecidos, limites de tamanho/estrutura;
campos transacionais, amount/quantity/productId/fundId, confirmação, credenciais e
campos desconhecidos são recusados. Somente encaminha a chamada do frontend, sem
fabricar payloads, repetir POSTs ou ampliar navegação. Suno/GraphQL não alterados.

Os corpos reais dessas chamadas não foram gravados nem disponibilizados. A
semântica de consulta é inferida do disparo ao abrir a lista e da estrutura
permitida; não foi encontrado contrato público oficial. A compatibilidade ainda
precisa de validação real. Se o corpo diferir da lista de campos, continuará
recusado com query_check fixo (UNRECOGNIZED_FIELD/TRANSACTION_FIELD/etc.). Nunca
liberar POST genérico para contornar isso nem afirmar que as duas páginas já
foram coletadas. Não persistir payloads ou valores; diagnóstico só retorna códigos.

70 testes unitários passaram, incluindo contexto exato, schemas positivos,
recusa de ordens, estruturas desconhecidas, origens externas e sanitização de
query_check. Fixture de navegador agora usa POST nos dois caminhos observados e
GET nos outros três; teste de navegador continua sem validação neste ambiente
que já bloqueou Chromium no lançamento. Execução 7/histórico preservados.

## Execução BTG 6: filtro bloqueava leituras das próprias listas — 2026-11-04

Usuário informou quatro APPLICATION_LOAD_ERROR (crédito bancário, títulos
públicos, Tesouro Direto e fundos), uma página parcial de renda fixa com dois
registros e scroll_stalled. Metadados locais confirmam bloqueios de caminhos dos
módulos fixed-income/accounts/.../fixedincomes, fixed-income/combo/account/...,
government-bond/account/... e treasury/buy/account/.../bonds, além de fundos.
Registros antigos não guardam método/origem; não afirmar que são todos GET nem
que isso comprova a causa total. Nenhum valor/identificador de conta foi copiado.
Importante: fixed-income/accounts/.../fixedincomes usa accounts no plural, que
não coincide com a regra antiga singular account. Esse bloqueio sugere POST ou
outro método/nav, não prova bloqueio de GET. A correção GET pode ser insuficiente
para crédito e fundos. Não afirmar solução completa antes de observar método e
verificar semântica de eventual POST de consulta.

Erro concreto: unsafePath bloqueava GET de dados contendo account/buy. Exceções
agora são padrões completos desses cinco caminhos, somente GET XHR/fetch da
origem da aplicação ou subdomínio HTTPS btgpactual.com em porta padrão. IDs somente
alfanuméricos com hífen/underscore. Sufixos de ordens, navegações, métodos de escrita,
outros caminhos de conta e parâmetros de sobrescrita de operação seguem recusados.
Exceção de fundos deixa de depender de origem idêntica à aplicação. POSTs não foram
liberados; se a consulta de fundos usar POST, falta inspecionar sua semântica.

Avisos de bloqueio agora guardam caminho sanitizado, método, resource_type e
origin_scope, sem domínio, query, headers, bodies ou credenciais. Sanitização
também na fronteira SQLite; metadados fora do esquema são descartados. Por página,
blockedRequestTypes inclui somente paths de investimentos. watchCollectionLoads
registra DATA_REQUEST_HTTP_ERROR / DATA_REQUEST_FAILED para leituras permitidas,
com status/códigos fixos e caminhos sanitizados, em dataRequestFailures.

Bug independente na rolagem: comparar apenas a posição síncrona podia declarar
scroll_stalled mesmo após a posição se mover durante a espera. Agora usa scrollTo
instant, compara posição observada depois da espera e exige amostras consecutivas
sem conteúdo/posição novos. scrollState numérico é incluído em caso de travamento.
MDN Element.scrollTo e documentação oficial Playwright Request consultados;
nenhuma informação privada foi enviada às buscas.

67 testes unitários passaram, incluindo os endpoints observados, recusa de
POST/operações/origens externas, sanitização de metadados, erros HTTP/rede e
movimento de rolagem após espera. Fixture de navegador agora depende de GETs nos
cinco endpoints e usa CSS scroll-behavior:smooth; validação real continua pendente
pela restrição Chromium já comprovada no ambiente. Não alteramos status/dados da
execução 6 nem fizemos nova consulta autenticada.
Pergunta opcional enviada ao usuário: se crédito bancário carrega os ativos na
janela manual antes de conectar o scraper. Sem resposta até esta anotação.

## Escopo BTG restrito a cinco listas progressivas — 2026-11-04

Usuário substituiu o escopo de todas as categorias por somente estas rotas:
/produtos-de-investimento/renda-fixa/credito-bancario,
/produtos-de-investimento/renda-fixa/titulos-publicos,
/produtos-de-investimento/renda-fixa/tesouro-direto,
/produtos-de-investimento/renda-fixa e
/produtos-de-investimento/fundos-de-investimento.
Informou carregamento progressivo por rolagem. Não apagar histórico de outras
categorias; a exclusão é da navegação nas próximas coletas.

Execução 5 inspecionada somente por metadados: 30 snapshots, 42 observações, todas
na view Criptoativos com categoria unknown; limite de categorias atingido e abas
revisitadas em permutações. Renda fixa tinha cabeçalhos Produto e risco,
Vencimento, Taxa, Aplicação mínima, Estoque; o primeiro não tinha alias. Fundos
mostrava Não foi possível carregar as informações e tabela vazia. Não considerar
a execução 5 completa nem as observações como carteira do usuário.

Configuração agora usa cinco seeds, collectionPaths exatos, maxPages=5, sem
followDiscoveredLinks/autoTabs/autoCategoryButtons/views. Login/CDP pode continuar
na página inicial do catálogo; collectionPolicy faz cópia com escopo exato somente
após autenticação, inclusive para guard, extração e descoberta. Espera somente
fixed_income e investment_funds, com evidência de caminho configurado.

Novo src/scroll.js: captura inicial e cada avanço de 70% da área visível, detecta
rolagem interna em descendentes/ancestrais mesmo com documento também rolável,
observa alterações de conteúdo/posição/altura e leituras permitidas pendentes.
Fim exige três amostras e 10 segundos estáveis no final, sem busy/requests em voo.
Limites de 1500 avanços e 300000ms geram avisos; amostras capturadas até o limite
ficam preservadas, inclusive última janela. Nada garante completude do catálogo.

Reconhece cabeçalho Produto e risco preservando o valor combinado literal. Mensagem
de falha de carregamento vira APPLICATION_LOAD_ERROR, e consulta as páginas
seguintes. pageResults mostra URL, status, snapshots, contagens e scrollCompletion;
sem produtos gera NO_PRODUCTS_ON_PAGE. distinctProductRecords usa fingerprint de
fonte/campos, sem prometer identidade de ativos nem confundir com posições.

Dependência /investments/api/fund-subscription/v2/account aparecia entre bloqueios
da execução 5. Exceção somente para GET XHR/fetch desse caminho exato na origem
BTG; POST/navegação/rotas arbitrárias de conta/preferências seguem recusados.
A amostra antiga não guarda método e não comprova causalidade na falha de fundos.
Não capturar respostas da API ou identificadores de conta. URLs públicas das cinco
páginas também não ficaram acessíveis pela ferramenta web nesta sessão.

62 testes unitários passaram, incluindo escopo exato, cabeçalho observado,
configuração inválida, revelação atrasada, virtualização, alterações de altura,
limites, busy, observação de rede e falha de carregamento. Fixture de navegador
para cinco rotas com listas incrementais/virtualizadas e scroll interno preparada,
mas Chromium encerrou no lançamento com Operation not permitted neste ambiente.
Sem coleta real adicional nem alteração de registros das execuções anteriores.
Validar pelo mesmo comando CDP no terminal local e conferir os cinco pageResults.

## Execução BTG 4: tabelas sem identificação e categorias não descobertas — 2026-11-04

Usuário informou execução 4 partial: uma página/snapshot, 16 avisos, 32 requisições
bloqueadas e zero produtos. Inspeção local confirmou nove avisos de caminhos
bloqueados e os sete avisos de layout/catálogo. Snapshot contém 16 tabelas sem
cabeçalhos, com pares rótulo/valor (rentabilidade histórica e aplicação mínima),
zero cards reconhecidos e zero links aceitos. Texto geral mostra página inicial
de categorias; não comprova catálogo integral nem identidade de 16 produtos.

Extrator passa a associar tabelas verticais a título único em contêiner próprio,
com seletores semânticos/de nome/título, mantendo casos ambíguos sem identificação.
Aplicação min. reconhecida; Rentab. 12M permanece campo literal sem virar taxa
oferecida. Busca categorias por texto exato em elementos interativos mesmo sem
role, além de routerlink/data-href. Durante clique reconhecido, permite somente
rotas de catálogo da mesma origem já admitidas pela descoberta de links; sem
liberar POSTs genéricos, operações ou preferências. Novos avisos estruturais:
PRODUCT_TABLE_TITLES_UNRESOLVED e CATALOG_CATEGORIES_NOT_FOUND.

Encontrada falha de privacidade nos avisos antigos: caminhos de APIs podiam incluir
identificadores de conta/cliente. Sanitização específica adicionada na gravação e
abertura do banco, incluindo histórico; aplicada ao banco local. Não copiar esses
valores para contexto/logs. Execução 4 continua partial, com snapshot e contagens
preservados; nenhuma observação de produto foi inventada retroativamente.

51 testes unitários passaram. Fixture de navegador cobre cards de categoria sem
role, tabelas verticais, títulos ambíguos e recusa de operações, mas não pôde ser
executada: Chromium encerra no lançamento com Operation not permitted neste
ambiente. Nova coleta real pelo usuário é necessária para validar os seletores.
Com Chrome manual aberto no catálogo, repetir
npm run scrape:btg -- --cdp http://127.0.0.1:9222.

## Execução BTG 3 com fila vazia — 2026-11-04

Usuário informou runId 3, failed, zero páginas capturadas/falhas/snapshots/bloqueios
e sete avisos. Consulta somente leitura aos metadados do SQLite confirmou provider
BTG e nenhuma linha em pages; os sete avisos eram LAYOUT_NOT_VERIFIED,
NO_PRODUCTS_IDENTIFIED, quatro CATEGORY_NOT_CONFIRMED e CATALOG_VISIBILITY_LIMIT.
Nenhum detalhe de ativos, valores ou sessão foi lido para essa investigação.

Causa confirmada no código: após transferir a sessão para um contexto de coleta,
a aba começa em about:blank. collect() resolvia seedPaths relativos usando page.url()
como base; new URL('/produtos-de-investimento','about:blank') falhava e a URL era
descartada silenciosamente. Corrigido: seeds resolvidos contra config.baseUrl;
links descobertos continuam usando a página de origem. Fila inicial vazia agora
gera INITIAL_URLS_REJECTED e failureReason explícito antes de qualquer navegação.

48 testes unitários passaram, incluindo regressão sobre about:blank, origem de
seeds Suno com aba de outro domínio, e rejeição explícita de todas as seeds inválidas.
Fixture BTG de navegador também inicia em about:blank; teste real segue dependente
do ambiente local. Histórico da execução 3 preservado; não marcar como sucesso nem
inventar produtos. Reexecutar o mesmo comando CDP com o Chrome manual ainda aberto.

## Comparação manual confirmada e conexão local opcional — 2026-11-04

Usuário confirmou que o formulário funciona no Chrome aberto manualmente, conforme
comparação solicitada no mesmo ambiente. A falha ocorre no caminho de abertura
automatizada; isso não identifica qual argumento/contexto ou proteção interfere.

Adicionada opção explícita, ainda sem validação real no BTG:
1. `npm run btg:browser` abre Chrome instalado, com diretório auxiliar em /tmp,
   porta somente 127.0.0.1 e janela anônima criada por Target.createBrowserContext.
   Usuário autentica manualmente e abre o catálogo. Nenhum perfil habitual é usado.
2. `npm run scrape:btg -- --cdp http://127.0.0.1:9222` conecta após o login,
   escolhe somente uma aba do catálogo em contexto anônimo e transfere cookies
   BTG/localStorage/sessionStorage em memória para um contexto de coleta novo,
   com workers bloqueados e política somente consulta. Não usa storageState do
   wrapper padrão CDP, que poderia acessar outro perfil. Captura cookies pelo ID
   correto via Storage.getCookies. Não transfere IndexedDB no caminho CDP.
3. Ao terminar, fechar janelas e Ctrl+C no primeiro terminal encerra o Chrome
   próprio e remove o diretório auxiliar; interrupção abrupta pode impedir limpeza.

O coletor desconecta de CDP ao terminar e fecha apenas seu contexto criado para
coleta; preserva a janela manual. Endpoints externos, credenciais/parâmetros em
endpoints, perfis comuns e catálogos ambíguos são recusados. Não há estado bancário
exportado, stealth, alteração de user-agent ou desativação de proteções. Não afirmar
que esse modo garante acesso: o banco pode recusar de novo ou exigir estado de
autenticação que não seja portável entre contextos. Seguir docs/BTG.md.

45 testes unitários passaram, incluindo protocolo simulado, seleção por contexto,
transferência mínima e restrição local. Chrome/CDP real e banco ainda não validados
neste ambiente restrito. Nenhuma sessão do usuário foi conectada pelo agente.
Teste de inicialização do utilitário aqui falhou em requireFreePort, antes de
criar diretório de perfil ou iniciar Chrome, com CDP_PORT_UNAVAILABLE. Não dizer que
o fluxo manual/CDP já funcionou no banco nem sugerir que outra porta contorna a
restrição deste ambiente. O usuário deve validar em seu terminal local.

## Access Denied após refresh — 2026-11-04

Usuário informou que /login continua branco e que um refresh passa a mostrar
Access Denied; perguntou se pode estar relacionado ao Playwright. Isso reforça a
hipótese de recusa pela camada de segurança do site, mas não confirma motivo nem
bloqueio de automação específico. Chrome com --browser-channel continua controlado
pelo Playwright. Comparação com Chrome manual anônimo no mesmo Ubuntu/WSL e rede
ainda é a informação necessária; foi solicitada por pergunta assíncrona.

Chrome agora existe neste Ubuntu (/usr/bin/google-chrome, /opt/google/chrome/chrome),
mas nova tentativa de diagnóstico do agente segue bloqueada antes de abrir janela
(BROWSER_PERMISSION_DENIED), além de falha DNS. Não confundir esses bloqueios do
agente com o HTTP 403 observado na máquina do usuário. Não continuar alterações
especulativas, novas reinstalações ou retirada de proteções antes da comparação.

Relato Mozilla 2026511 e documentação MDN Navigator.webdriver consultados novamente:
há relato de interferência da proteção do BTG em navegador automatizado headless em
outro ambiente. É evidência de plausibilidade, não diagnóstico conclusivo para a
execução visível deste usuário. Não implementar stealth ou ocultação de automação.

## Tela branca BTG e ponto de entrada — 2026-11-04

Usuário confirmou tela branca e enviou diagnóstico v2: ready_state complete,
zero campos/formulários/indicadores visíveis, HTTP 403 de XHR e script na origem
application, SCRIPT_MODULE_LOAD_ERROR, script ERR_ABORTED, dois fetch externos
ERR_ABORTED e oito erros de console ERR_CONNECTION_REFUSED sem origem conhecida.
HTML carregado e falha de módulo JS são compatíveis com a tela branca; motivo da
recusa ainda desconhecido. Não atribuir ERR_CONNECTION_REFUSED a localhost sem
evidência nem dizer que o banco bloqueou automação/conta de forma comprovada.

Erro concreto no fluxo: CLI abria diretamente entryPath do catálogo antes do
login. Orientação oficial BTG localizada em
https://banking.btgpactual.com/ajuda/contacorrente/informederendimentos aponta
https://app.btgpactual.com/login e depois menu Produtos de investimento. Adicionado
loginPath='/login' ao BTG; Suno usa seu entryPath anterior. Autenticação abre loginPath;
coleta mantém entryPath/seeds/escopo do catálogo. Rota pública de login não foi
liberada no guard de coleta. Diagnóstico informa initial_navigation='login'.

37 testes unitários passaram, incluindo rejeição de rotas externas, credenciais
em parâmetros e rotas de operação como entrada de login. Fixture de navegador foi
atualizada para negar catálogo sem autenticação e iniciar em /login; não executada
aqui por restrições de Chromium. Não afirmar correção do login real. Teste indicado:
npm run scrape:btg -- --browser-channel chrome (modo normal, com janela para login).
Se /login seguir branco, falta comparação com Chrome aberto manualmente no mesmo
sistema/rede; não continuar trocando navegador/instalando ou removendo proteções.

Pesquisa adicional: relato primário de compatibilidade Mozilla em
https://bugzilla.mozilla.org/show_bug.cgi?id=2026511 descreve lentidão em Firefox
e bloqueio de Chrome headless em outro ambiente. Não extrapolar esse relato como
diagnóstico confirmado para o Chrome visível do usuário.

## Diagnóstico BTG atualizado — 2026-11-04

Usuário reenviou o mesmo resumo: Chrome 156.0.8078.79, service workers allow, 12
erros genéricos de console e dois fetch externos ERR_ABORTED, sem HTTP 403
registrado nessa amostra. Não tratar colagens repetidas como execuções distintas.
O resumo não comprova login funcional, ausência global de bloqueios nem a causa
dos erros. A comparação com navegador manual segue sem resposta. Pergunta enviada
agora sobre se o formulário chegou a aparecer ou continuou carregando.

Foi reconhecido que o diagnóstico era genérico demais. Agora --diagnose-login
habilita classificação de mensagens apenas em memória, antes das credenciais,
emitindo códigos fixos para CORS, CSP, MIME, módulos JS, workers, armazenamento e
exceções JS. Não registrar texto bruto, URLs, stacks, valores ou objetos de console.
Coletas normais mantêm apenas contagens genéricas. Acrescentado diagnostic_version:2
e page_state com contagens estruturais do documento principal, sem valores/textos.
Essas contagens não comprovam que o formulário está pronto e não cobrem iframes/
shadow DOM. 36 testes unitários passaram; navegador real segue não validado neste
ambiente. Não afirmar que alterar configurações de browser resolveu o login.

## Login BTG carregando antes de credenciais — 2026-11-03

Segundo diagnóstico do usuário: Chrome 156.0.8078.79, workers allow, HTTP 403 em
fetch e script, dez erros de console e um script ERR_ABORTED. Portanto trocar do
Chromium incluído para Chrome não resolveu. Ainda sem comparação fornecida com
navegador habitual não automatizado, na mesma máquina/rede. Não repetir instalação
ou troca de navegador como se fosse solução confirmada. A causa/criticidade dos
403 segue desconhecida; podem envolver a aplicação ou dependências externas.

Diagnóstico agora inclui origin_scope application/provider/external/unknown, sem
guardar domínio, caminho, parâmetros ou conteúdo. CLI passa a configuração ao
coletor de diagnóstico; apenas endereços de recursos com falha são classificados
em memória e descartados. 32 testes unitários passaram. Pedir novo resumo com
classificação e a comparação com navegador habitual; não solicitar HAR, cookies,
tokens ou logs brutos. Nenhuma proteção de acesso foi removida.

Diagnóstico enviado pelo usuário após o ajuste: bundled-chromium 156.0.8078.4,
auth_service_workers=allow, HTTP 403 em um script e um XHR, 15 erros genéricos de
console, um ERR_ABORTED de script e dois de fetch. Isso confirma recusa HTTP para
alguns recursos, mas não identifica origem, criticidade ou motivo. Não afirmar
bloqueio de automação, erro de senha ou dependência de service worker como causas
comprovadas. O diagnóstico não mostrou falhas DNS, diferentemente do ambiente do
agente. Próximo teste de compatibilidade: Chrome/Edge instalado no mesmo sistema
do Node usando --browser-channel e --diagnose-login, comparado ao navegador normal
na mesma máquina/rede. Chrome/Edge não foram encontrados no PATH ou caminhos padrão
deste Ubuntu durante a verificação; pode ser necessária instalação local. Não usar
stealth, spoofing ou desativar proteções para tentar resolver os 403.

Usuário relatou que o navegador aberto pelo scraper carrega indefinidamente antes
de digitar credenciais. Não confundir com o bloqueio de lançamento no ambiente do
agente: na máquina do usuário o navegador efetivamente abre. Causa real ainda não
confirmada. Pergunta enviada sobre funcionamento no navegador habitual, sem
resposta até esta atualização. Evitar atribuir a causa ao banco ou à rede sem dados.

Foi identificado serviceWorkers='block' também durante autenticação. Agora BTG
usa authServiceWorkers='allow' no login e transfere estado apenas em memória para
outro contexto temporário com service workers bloqueados na coleta. Inclui
cookies/localStorage/IndexedDB e sessionStorage da origem principal; sem gravar
sessão do BTG. O contexto de autenticação é fechado antes da coleta. Não habilitar
service workers no contexto de coleta nem remover os bloqueios de escrita.

Novas opções: --browser-channel chrome|msedge|chromium (alternativa exclusiva a
--browser-path) e --diagnose-login. O diagnóstico é anterior às credenciais, dura
15 segundos após DOMContentLoaded e mostra apenas códigos/contagens, sem URLs,
mensagens brutas, headers, bodies, conteúdo ou credenciais. Não coleta produtos,
acessa cofre ou abre SQLite. Ver docs/BTG.md. Testes unitários atuais: 31 passaram;
regressão com service worker em navegador real foi preparada, mas o ambiente do
agente continua sem permitir Chromium. A mudança não comprova correção do login
real; pedir somente o resumo seguro de diagnóstico se o travamento persistir.

Referências: documentação oficial Playwright /docs/service-workers e /docs/browsers
consultadas em 2026-11-03. Bloquear workers pode alterar comportamento de aplicações;
isso é uma hipótese técnica, não evidência de dependência específica do BTG.

## Atualização em 2026-11-03 — BTG e objetivo privado

Usuário solicitou coletor Playwright de todos os produtos exibidos em
https://app.btgpactual.com/produtos-de-investimento, com login manual e armazenamento
SQLite para apoiar futura consolidação com Portfólio/Carteiras da Suno. A alocação
informada está em `privado/plano-carteira.json`, sem copiar números para contexto
versionável. O plano foi registrado no banco existente como objetivo do usuário,
separado de posições, recomendações e produtos observados.

Novo comando `npm run scrape:btg`, configuração `btg.config.json` e guia
`docs/BTG.md`. Banco compartilhado padrão: `privado/suno.sqlite`, por compatibilidade.
Migração aditiva v2: runs.provider, snapshots.captured_url, catalog_products,
catalog_observations, allocation_plans e allocation_targets. `npm run wallet:plan`
registra o plano de forma idempotente. BTG tem sessão temporária; a persistência
anterior continua restrita à Suno. Nenhuma operação financeira foi autorizada.

Testes unitários atuais: 24 passaram. Os testes de navegador incluem fixture BTG,
mas continuam impedidos pelas restrições locais. `npm run doctor -- --source btg`
confirmou bloqueio Chromium (Operation not permitted) e falha de DNS do BTG.
Nenhuma sessão ou coleta real do BTG foi obtida. Consulta pública da URL via web
não retornou conteúdo legível. Falta validar seletores, categorias, paginação,
detalhes e APIs de consulta com a página autenticada. Não afirmar catálogo integral,
disponibilidade para compra ou carteira consolidada por produtos sem essa validação.

## Histórico anterior

Pedido: criar coletor Playwright das áreas Portfólio e Carteiras da Suno,
incluindo carteiras disponíveis, com armazenamento SQLite. Uso pontual ao iniciar
ou rebalancear uma carteira. Não foi autorizada nenhuma operação financeira nem
alteração de conta. BTG permanece fora desta implementação.

Implementação em Node.js 24+, Playwright e SQLite nativo. O usuário autorizou
explicitamente persistência criptografada do login em 2026-11-02; AGENTS.md foi
atualizado com essa exceção limitada. Login/MFA continuam manuais. Estado filtrado
em `privado/auth/suno.session.enc.json` (AES-256-GCM), chave aleatória de 256 bits
no chaveiro Linux Secret Service via secret-tool. Sem fallback em texto aberto,
sem senha ou códigos persistidos, sem chave no projeto ou variáveis de ambiente.
Dados financeiros em `privado/suno.sqlite`, ignorado pelo versionamento. Nenhuma
coleta real ou credencial foi disponibilizada.

`npm test`: 17 testes unitários passaram, incluindo sessão/criptografia com chaveiro
simulado e dados sintéticos. Testes de navegador foram preparados,
mas o ambiente impediu a execução: rede/DNS indisponível para a Suno; Chromium
inicialmente sem libasound e, com a biblioteca disponível, bloqueado na criação de
seu processo de sandbox. Não houve execução autenticada. Não solicitar credenciais
no chat; o usuário pode autenticar diretamente no navegador na máquina local.

Pendências de integração: confirmar rota Carteiras e detalhes, seletores de
conteúdo/prontidão, abas/paginação, eventuais APIs de consulta GraphQL, rolagem
interna e cabeçalhos de ativos. `layoutVerified` permanece false. `/carteiras` é
uma hipótese, não uma rota verificada. Ver README para operação e limitações.

Fontes consultadas em 2026-11-02: URL da Suno fornecida pelo usuário (inacessível
neste ambiente); documentação oficial Playwright /docs/auth e Node /api/sqlite.html.

Nova tentativa em 2026-11-02, a pedido do usuário: executado
`npm run scrape -- --purpose start` em terminal interativo. Falhou antes do login.
A dependência libasound continua ausente no caminho padrão; mesmo fornecendo uma
biblioteca já disponível em /tmp, o Chromium com interface foi bloqueado por
`setsockopt: Operation not permitted`. Nenhum dado da conta foi coletado.

Diagnóstico atual (`npm run doctor`, 2026-11-02): Chromium continua bloqueado com
BROWSER_PERMISSION_DENIED, DNS da Suno falha com EAI_AGAIN/NETWORK_DNS_FAILED e o
utilitário secret-tool está ausente (KEYRING_TOOL_MISSING). O bloqueio do Chromium
é a causa imediata das falhas anteriores; o chaveiro ausente afeta a nova
persistência. Não foi possível validar integração real com navegador, Suno ou
chaveiro neste ambiente. Não contornar as restrições nem prometer funcionamento
completo após instalação de dependências: as rotas/seletores seguem não validados.

Comandos: `npm run login`, `npm run scrape -- --purpose start|rebalance`,
`npm run session:forget`, `npm run doctor`. `--no-session` mantém login manual sem
persistência. authenticatedSelector continua null, exigindo Enter para confirmar
Portfólio mesmo ao reutilizar sessão. Expiração local máxima de sete dias;
expiração/revogação da Suno pode ocorrer antes. Ver README para configurar chaveiro,
limites do estado filtrado e o diagnóstico. Nenhum commit, upload ou publicação.
