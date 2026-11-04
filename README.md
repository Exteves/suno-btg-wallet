# Coletor Suno → SQLite

Também há coleta do catálogo BTG, com login manual e sessão temporária:
`npm run scrape:btg`. Consulte [o guia do BTG](docs/BTG.md) para operação, configuração,
limites de cobertura e o registro privado do objetivo de alocação. As duas fontes
compartilham o banco e permanecem identificadas separadamente.

O BTG está configurado para as cinco listas de renda fixa e fundos indicadas pelo
usuário, com rolagem progressiva e relatório por página. As demais categorias não
são percorridas. Veja [escopo e critérios de conclusão](docs/BTG.md#escopo-atual-cinco-listas-com-carregamento-progressivo).

Se o login funciona no Chrome manual e falha no navegador iniciado pelo Playwright,
há uma conexão local opcional: `npm run btg:browser`, login manual e depois
`npm run scrape:btg -- --cdp http://127.0.0.1:9222` em outro terminal. Consulte o
guia BTG para isolamento da janela anônima, limpeza e limites de compatibilidade.

Coleta pontual com Playwright para pesquisar os dados disponíveis em **Portfólio**
e **Carteiras**, quando você for iniciar ou rebalancear uma carteira. Não há
agendamento nem integração de negociação. `--purpose` identifica a finalidade da
consulta; não inicia ou rebalanceia uma carteira na Suno ou no BTG.

**Estado atual:** implementação de SQLite, sessão criptografada e diagnóstico pronta; integração
com a Suno autenticada ainda não validada. A rota `/carteiras` e os seletores
iniciais são hipóteses configuráveis. O ambiente de desenvolvimento não conseguiu
resolver o domínio da Suno nem iniciar o Chromium por restrições do ambiente.
Não foi feita coleta da sua conta e não é possível afirmar cobertura integral.

## Executar

Requisitos: Node.js 24 ou superior, terminal interativo, ambiente gráfico e acesso
à Suno. No Linux/WSL, é preciso ter as dependências do Chromium e um display
funcional (por exemplo, WSLg).

```sh
npm ci
npm run browser:install
npm run doctor
npm run login
npm run scrape -- --purpose start
# Em outra ocasião:
npm run scrape -- --purpose rebalance
```

Se faltarem bibliotecas do Chromium no Linux, instale-as na sua máquina com
`npx playwright install-deps chromium`. É possível escolher um Chromium instalado
usando `--browser-path /caminho/do/chromium`.

Na primeira execução, faça login **diretamente no navegador**, incluindo eventual
segundo fator, e abra Portfólio. Pressione Enter no terminal somente quando a página
autenticada estiver pronta. `npm run login` apenas autentica e salva a sessão;
`scrape` também permite esse primeiro login. Não coloque senha, CPF ou códigos no
chat, na linha de comando ou nos arquivos de configuração.

O coletor fecha o navegador ao terminar e salva `privado/suno.sqlite`. Cada
execução acrescenta um histórico; não sobrescreve a coleta anterior. Outro banco
pode ser escolhido com `--db privado/outro.sqlite`.

## Sessão persistente

A persistência usa o **Secret Service do Linux**, através de `secret-tool`. No
Ubuntu/WSL, instale os componentes na máquina local, por exemplo:

```sh
sudo apt install libsecret-tools gnome-keyring
```

O serviço precisa estar disponível no D-Bus da sua sessão de usuário, com uma
coleção padrão criada e desbloqueada. A instalação dos pacotes sozinha não garante
isso, especialmente no WSL. Configure o chaveiro com senha pelo gerenciador gráfico
de senhas do Linux; não use um chaveiro sem senha. O diagnóstico verifica acesso ao
serviço, mas a permissão de gravação é conferida ao salvar a sessão. Nesta versão,
outros sistemas operacionais podem usar `--no-session`.

A sessão é criptografada com **AES-256-GCM**, chave aleatória de 256 bits e nonce
novo a cada gravação. O arquivo fica em `privado/auth/suno.session.enc.json`, com
permissão 0600; a chave fica no chaveiro, separada do projeto. O estado é
descriptografado em memória e entregue ao Playwright como objeto, sem arquivo
temporário de estado em texto aberto. A gravação do arquivo criptografado é
atômica. Chaveiro ausente, bloqueado ou inacessível impede a persistência; não há
fallback sem criptografia. A proteção da chave depende da configuração do chaveiro
e da segurança da sua sessão do sistema operacional.

São retidos cookies de primeira parte da Suno e entradas de localStorage com nomes
relacionados à autenticação. Perfis, informações financeiras, rastreamento, origens
externas, formulários, sessionStorage e IndexedDB não são persistidos. Entradas JSON
com campos pessoais/credenciais proibidos são descartadas; tokens opacos não são
decodificados. Se a autenticação usar uma chave com outro nome, configure somente
seu **nome** em `sessionLocalStorageKeys`, após inspeção local. Provedores externos
ou formatos não cobertos podem exigir novo login; a restauração real na Suno ainda
precisa de validação.

`sessionTtlHours` limita a reutilização local a até 168 horas (sete dias) desde a
última gravação. A Suno pode expirar ou revogar a sessão antes disso. Após expiração
local, o arquivo e sua chave são removidos e um novo login é necessário. Falhas de
autenticação detectadas durante a coleta também removem a sessão local.

Enquanto `authenticatedSelector` estiver vazio, **cada execução pede confirmação
com Enter**, mesmo após restaurar os cookies; isso não exige digitar novamente a
senha quando a sessão ainda for válida. Depois de confirmar um seletor exclusivo
da página autenticada, configure-o para permitir confirmação automática. Rotas ou
cookies sozinhos não são tratados como prova de autenticação.

```sh
npm run login                     # Primeiro login ou renovação manual
npm run scrape -- --purpose start # Reutiliza sessão e coleta
npm run session:forget            # Remove o arquivo e a chave locais
npm run scrape -- --purpose start --no-session # Login manual sem persistência
```

Remover a sessão local não revoga uma sessão no servidor. Para revogação, use os
controles de segurança da Suno manualmente. Um arquivo corrompido ou uma chave
perdida geram erro explícito; o coletor não os substitui silenciosamente. Se o
arquivo estiver corrompido, a remoção local pode deixar uma chave órfã no chaveiro,
que pode ser excluída no gerenciador gráfico pelo rótulo do coletor.

## Diagnosticar falhas

```sh
npm run doctor
```

O diagnóstico verifica o lançamento do Chromium com interface, a resolução DNS
da Suno e a disponibilidade do chaveiro, sem ler sua sessão salva ou registrar
credenciais. As mensagens do coletor também distinguem essas causas; exceções
brutas do Playwright continuam excluídas dos logs.

Na consulta de 2026-11-02 neste ambiente:

| Código | Causa confirmada | Próximo passo |
| --- | --- | --- |
| `BROWSER_PERMISSION_DENIED` | O ambiente negou uma operação de socket do Chromium (`Operation not permitted`), antes do login. | Executar em um terminal local fora deste ambiente restrito. Reinstalar o Chromium não remove essa restrição. |
| `NETWORK_DNS_FAILED` | O domínio da Suno não resolveu (`EAI_AGAIN`). | Verificar rede/DNS no ambiente de execução. |
| `KEYRING_TOOL_MISSING` | `secret-tool` não está instalado. | Instalar e configurar Secret Service para persistência, ou usar `--no-session`. |

O bloqueio de navegador é a causa imediata das tentativas anteriores. A falha DNS é
um bloqueio adicional confirmado por uma consulta separada. A ausência do chaveiro
é um requisito da nova persistência, não a causa das falhas anteriores. Nenhum
dado da conta foi coletado. Depois de resolver o ambiente, ainda é necessário
validar as rotas e os seletores reais abaixo.

## O que é coletado

- Texto renderizado, títulos, tabelas e suas linhas, cards e links dentro do escopo.
- Páginas descobertas por links em `/portfolio` e `/carteiras`, incluindo detalhes
  de carteiras quando esses detalhes usam rotas dentro do escopo.
- Conteúdo revelado por rolagem da janela, com snapshots intermediários para
  preservar linhas que desapareçam em listas virtualizadas.
- Abas, expansões e paginação quando seus controles de consulta estiverem
  explicitamente configurados.
- Origem, data/hora UTC, finalidade, classificação de área, falhas e limites de cada
  execução. Valores monetários e percentuais permanecem como exibidos, sem inferir
  moedas, converter separadores ou inventar números.

“Tudo” aqui significa o conteúdo financeiro renderizado e acessível dentro das
rotas e controles configurados. Não inclui código da aplicação, estado interno de
autenticação, respostas brutas de API, downloads, PDFs, conteúdo bloqueado pela
assinatura, iframes, gráficos em canvas ou pontos acessíveis apenas por hover.
Esses formatos exigem um adaptador depois da inspeção autenticada. Gráficos podem
ter legendas coletadas, sem que a série inteira tenha sido extraída.

Não se presume que a área Portfólio contenha posições pessoais. `source_kind`
separa `portfolio_area` de `suno_wallet_area`; `ownership` só classifica
`user_positions` ou `suno_recommendation` quando o título/cabeçalho o indica.
Nos demais casos, fica `unknown`. Essa classificação é uma heurística que deve
ser conferida na primeira execução.

## Ajustar ao layout autenticado

Edite `suno.config.json` após inspecionar as páginas no navegador:

1. Confirme `walletsPath` e inclua em `scopePaths` os prefixos reais dos detalhes.
   O domínio de produção fica limitado a `https://investidor.suno.com.br`.
2. Ajuste `contentSelector` para o contêiner principal e `readySelector` para um
   elemento que indique que os dados terminaram de carregar.
3. Ajuste `walletLinkSelector` se os links de carteiras tiverem um seletor próprio.
   Cards sem links precisam de um adaptador; o coletor não clica em cards genéricos.
4. Configure `views`, `nextSelector` e/ou `loadMoreSelector` para controles de
   consulta conhecidos. Se ambos os seletores de paginação forem preenchidos,
   `loadMoreSelector` tem precedência. Se os controles variarem por tipo de página,
   use seletores CSS que cubram os controles corretos de cada página.
5. Configure `recordMappings` se quiser registros de ativos em colunas próprias.
   As tabelas e linhas originais são salvas mesmo sem esse mapeamento.
6. Compare a lista de carteiras, quantidade de ativos, abas, paginação e eventuais
   listas com rolagem interna com o banco. Só então marque `layoutVerified: true`.
   Isso remove o aviso de layout não validado, sem provar por si só a cobertura.

Exemplos ilustrativos; **não são seletores ou cabeçalhos confirmados da Suno**:

```json
{
  "views": [
    {
      "name": "composicao",
      "kind": "tab",
      "pathPrefix": "/carteiras/",
      "selector": "[role=tab]:has-text('Composição')"
    }
  ],
  "nextSelector": "button[aria-label='Próxima página']",
  "recordMappings": [
    {
      "name": "composicao",
      "caption": "Composição",
      "columns": {
        "identifier": "Ticker",
        "quantity": "Quantidade",
        "weight": "Peso",
        "price": "Preço",
        "value": "Valor"
      }
    }
  ]
}
```

Os cabeçalhos são comparados literalmente. Também é possível usar índices de
coluna a partir de zero. Omita campos ausentes. O mapeamento não presume que uma
linha seja uma posição pessoal: a origem e a classificação acompanham o registro.

Durante a coleta, requisições que alteram estado são bloqueadas por padrão:
somente GET, HEAD e OPTIONS passam, e rotas conhecidas de alteração são recusadas.
Se a Suno carregar dados por GraphQL via POST, é possível adicionar o caminho
inspecionado a `readOnlyGraphqlPaths`. Somente operações com texto de consulta
explícito passam; mutations, subscriptions e operações persistidas são recusadas.
POSTs REST não são liberados. Bloqueios aparecem em `issues`, inclusive quando
podem ter impedido o carregamento de dados. O login manual acontece antes desse
bloqueio, pois a autenticação normalmente precisa de POST.

## Consultar o banco

Use um cliente SQLite local. Não envie o arquivo a visualizadores externos.

```sql
SELECT id, started_at, purpose, status, summary_json
FROM runs ORDER BY id DESC;

SELECT code, detail FROM issues WHERE run_id = 1;

SELECT p.source_url, s.captured_at, s.ownership,
       t.headers_json, r.cells_json
FROM table_rows r
JOIN data_tables t ON t.id = r.table_id
JOIN snapshots s ON s.id = t.snapshot_id
JOIN pages p ON p.id = s.page_id
WHERE p.run_id = 1
ORDER BY p.id, s.id, t.table_index, r.row_index;

-- Disponível quando recordMappings estiver configurado:
SELECT identifier, quantity_text, weight_text, price_text,
       source_url, ownership, captured_at
FROM collected_records WHERE run_id = 1;
```

Tabelas: `runs`, `pages`, `snapshots`, `data_tables`, `table_rows`, `cards`,
`links`, `records`, `issues`. A view `collected_records` reúne os ativos mapeados
com a origem. Snapshots idênticos são deduplicados dentro de uma página/aba da
mesma execução. Snapshots intermediários podem repetir ativos entre si; eles não
devem ser somados como posições.

O resultado `captured` significa que o percurso configurado terminou sem avisos,
não uma garantia de que todos os dados existentes no site foram extraídos.
`partial` indica conteúdo salvo com avisos/limites/falhas; `failed` indica que
nenhum snapshot foi salvo. Códigos de saída: 0, 2 e 1, respectivamente. Limites de
páginas, rolagem e paginação geram avisos. Abas não configuradas, ausência de
detalhes de carteiras e rolagem interna detectável também geram avisos.

## Privacidade

`privado/` e bancos SQLite ficam no `.gitignore`. Diretórios do banco usam
permissão 0700 e o arquivo 0600 em sistemas POSIX. O banco contém dados
financeiros e **não é criptografado**; as permissões não substituem proteção do
dispositivo. Não há commit, push ou upload automático.

Por autorização do usuário, o programa persiste somente o estado de autenticação
filtrado no cofre criptografado descrito acima. Senhas e códigos de MFA não são
solicitados pelo programa nem gravados. Não usa perfil
persistente, screenshots, vídeo, HAR ou traces. O Chromium usa um perfil
temporário durante a execução, que o Playwright tenta remover ao fechar. Uma
interrupção abrupta pode impedir essa limpeza. Não habilite logs de depuração do
navegador durante uma sessão privada.

Formulários, inputs, scripts e elementos marcados `data-private` são excluídos da
extração. Há remoção de padrões conhecidos de CPF, credenciais, email e números
de conta rotulados, inclusive colunas de tabelas. Formatos de identificação novos
ou sem rótulo exigem ajustar os filtros antes da coleta real; filtros por padrão
não são garantia contra qualquer mudança no site. Nunca forneça credenciais ao
coletor como dados a serem armazenados.

O tráfego normal do navegador segue a aplicação Suno e seus provedores de login e
recursos. O coletor não envia o banco a outros serviços. Isso não elimina o
processamento ou o histórico da sessão pelo provedor do assistente.

## Verificação

```sh
npm test               # SQLite, criptografia, sessão, diagnóstico e políticas
npm run test:browser   # Chromium real com respostas sintéticas, sem conta Suno
npm run test:all
```

Os testes de navegador cobrem descoberta de carteiras, paginação, abas, lazy
loading, privacidade, bloqueio de escrita, expiração de login e restauração de cookies
e tokens em um novo contexto a partir do cofre criptografado. Usam interceptação
do Playwright, sem servidor local ou acesso à Suno. Ainda precisam ser executados
em um ambiente que permita iniciar o Chromium. Os 48 testes unitários passaram
em 2026-11-04, incluindo criptografia autenticada, adulteração, expiração, remoção,
chaveiro indisponível, confirmação de login, catálogo BTG, migração e plano de
alocação, opções de navegador, transferência de sessão em memória e diagnóstico de
login sem conteúdo privado. Os testes de navegador ficaram
impedidos pelas restrições do ambiente; a integração real com o chaveiro e a Suno
permanece sem validação. Os testes unitários usam um chaveiro simulado e dados
sintéticos, sem acessar credenciais do sistema.

Referências de implementação: [autenticação no Playwright](https://playwright.dev/docs/auth)
e [SQLite no Node.js](https://nodejs.org/api/sqlite.html),
[criptografia no Node.js](https://nodejs.org/api/crypto.html),
[Secret Service](https://specifications.freedesktop.org/secret-service/latest/)
e [implementação oficial do secret-tool](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c).
