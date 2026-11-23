# Coleta diária Suno → base de conhecimento

Coleta **somente leitura** de Relatórios (lista e conteúdo integral), Carteiras
(cada carteira e suas abas), Cobertura Suno e Nossos Fundos, uma vez por dia, em
`privado/suno-conhecimento.sqlite`.

## Primeiro uso

```sh
npm run daily            # abre o navegador; faça login/MFA nele e pressione Enter
```

A sessão fica no cofre criptografado (`privado/auth/`, chave no Secret Service) e
é regravada a cada coleta bem-sucedida. Nas próximas execuções não há Enter: o
login é confirmado por uma resposta **autorizada** da API da Suno, não por cookie
ou rota. A primeira coleta percorre todo o histórico de relatórios; as seguintes
param assim que uma página só traz relatórios já conhecidos
(`npm run daily:full` refaz o percurso completo).

## Agendamento e como não esquecer

Três peças, instaladas uma vez:

1. `npm run schedule:install [-- HH:MM]`: timer systemd (abaixo).
2. `npm run schedule:windows`: tarefa "Suno - manter WSL ativo" no Agendador de
   Tarefas do Windows. No logon ela inicia o WSL sem janela e o mantém ativo, para
   o timer rodar sem terminal aberto. Remover: `npm run schedule:windows -- remover`.
3. Notificação do Windows após cada execução agendada (`src/daily-notify.js`):
   login necessário, falha, coleta parcial ou mais de 48 h sem coleta com dados.
   Execuções sem problema não notificam.

`npm run daily:status` mostra as últimas coletas, o atraso, o conteúdo pendente,
o próximo horário, a tarefa do Windows e a validade local da sessão.

Não verificado: se o chaveiro do Linux continua desbloqueado depois de reiniciar o
Windows. Se não continuar, a coleta falha e a notificação avisa.

`npm run schedule:install [-- HH:MM]` instala um timer systemd de usuário
(padrão 19:30, após o fechamento do mercado). `Persistent=true`: se o WSL estava
desligado no horário, a coleta roda quando ele for iniciado. Requer o WSLg, porque
o Cloudflare da Suno bloqueia o Chromium headless (verificado em 2026-11-23); uma
janela do navegador abre durante a coleta.

```sh
systemctl --user list-timers suno-daily.timer
journalctl --user -u suno-daily -n 100       # log da última execução
systemctl --user start suno-daily             # rodar agora
systemctl --user disable --now suno-daily.timer
```

Códigos de saída: 0 completo, 2 parcial (dados gravados com avisos), 3 login
necessário (rode `npm run daily` num terminal), 4 outra coleta em andamento, 1 falha.
O chaveiro precisa estar desbloqueado na sessão Linux.

## Como os dados são obtidos

O site é uma SPA que lê `membros-api-gateway.suno.com.br/api/`. O coletor navega
pelas páginas e grava as respostas JSON que a própria página carrega, filtradas
por uma lista de endpoints de conteúdo (`src/suno-kb/endpoints.js`). Paginação:
repete o mesmo GET mudando apenas `page`/`offset`, com cabeçalhos mantidos só em
memória e 0,8 s entre chamadas. Endpoints pessoais (Meus Investimentos,
patrimônio, transações, perfil, corretoras) **nunca são gravados**; só o formato
do caminho vai para `endpoint_inventory`. POST/PUT/DELETE são bloqueados, exceto
a renovação de token da própria aplicação. Abas com rótulos de ação (comprar,
investir…) e links fora das quatro seções não são acionados.

### Comportamentos verificados na Suno (2026-11-23)

- O app só renderiza as carteiras se o POST `v1/user/show-update-cpf` (consulta de
  um flag, sem alteração de conta) passar; sem ele toda rota cai em `/error`. É o
  único POST liberado além da renovação de token.
- `/relatorios` lista via `v2/search` (só `report.list` é gravado; notícias não).
- Eventos das carteiras: a API ignora `page` a partir da 2ª página, mas aceita
  `limit`; o coletor pede tudo de uma vez quando o total anunciado (`count`) não
  fecha. A cobertura (base 1) recusa `limit` grande (HTTP 400) e é paginada.
- Carteiras fora da assinatura respondem `has_access:false` com lista vazia
  (hoje: ETFs internacionais, Internacional, Small Caps).
- `PAGINATION_INCOMPLETE` indica lista diária com menos itens que o total da API.

Opções: `--wait-login N` espera o login na janela sem terminal interativo;
`npm run daily:reindex` recalcula itens/observações a partir das respostas brutas.

## Conteúdo dos relatórios

Cada relatório da lista tem um `type`; o conteúdo vem do mesmo endpoint que o
leitor do site usa (mapeado em 2026-11-23):

| type | Endpoint | Guardado |
| --- | --- | --- |
| `e-reader`, `analysis` | gateway `v1/reports/ereader/{slug}` | JSON em blocos |
| `pdf` | gateway `v2/reports/view/{slug}` | arquivo em `privado/relatorios/pdf/` + texto (`pdftotext`) |
| `html-content` | gateway `v2/reports/list?slug={slug}` | o relatório com o HTML |
| `edition` (Radar FIIs) | `api.sunocore.com.br/reports/api/public/editions/{slug}` | JSON da edição |

São GETs diretos com os cabeçalhos da sessão mantidos em memória, um a cada 0,8 s;
a página `/relatorios` é reaberta a cada 15 min (ou num 401) para o app renovar o
token. O site tenta marcar o relatório como lido (PUT/PATCH); isso fica bloqueado.
Cada coleta diária baixa até 300 pendentes, do mais novo ao mais antigo;
`npm run daily:conteudo` baixa todos de uma vez (carga inicial, horas). Essas
execuções ficam com status `content_ok`/`content_partial`, fora das views diárias.
Sem acesso (`has_access:false`) vira `no_access` e é refeito quando o acesso aparece;
erros são refeitos até 3 vezes. Um PDF cujo texto tenha padrão de CPF não é guardado
(fica só o texto, mascarado). Um relatório é baixado uma vez; edições posteriores da
Suno no mesmo relatório não são rebaixadas.

```sql
-- Busca por texto (sem acento, sem maiúsculas)
SELECT d.title, d.published, snippet(report_text, 2, '[', ']', '…', 12)
FROM report_text JOIN report_documents d ON d.item_key=report_text.report_key
WHERE report_text MATCH 'taee11 OR taesa' ORDER BY d.published DESC LIMIT 20;
```

## Tabelas e views

| Objeto | Conteúdo |
| --- | --- |
| `runs` | uma linha por execução, `collection_date` no fuso de São Paulo |
| `responses` + `blobs` | cada resposta JSON bruta (sem dados pessoais conhecidos), deduplicada por hash |
| `items` / `item_revisions` | catálogo cumulativo: primeira/última vez visto, cada versão |
| `observations` | estado diário de listas (carteiras, cobertura, fundos) |
| `reports` | relatórios acumulados |
| `report_contents`, `report_text` | conteúdo de cada relatório (status, arquivo, JSON) e texto pesquisável (FTS5) |
| `report_documents` | relatório + status do conteúdo + JSON + texto |
| `wallet_positions`, `coverage_daily`, `funds_daily` | estado de cada dia (última execução do dia) |
| `composition_changes` | ativos que entraram/saíram entre dias coletados |
| `pages`, `page_texts` | rotas visitadas e texto renderizado |
| `issues`, `endpoint_inventory` | avisos e endpoints não gravados |

```sql
SELECT collection_date, scope_key, ticker, json_extract(data_json, '$.precoTeto')
FROM wallet_positions ORDER BY collection_date DESC, scope_key, item_index;

SELECT * FROM composition_changes ORDER BY collection_date DESC;
SELECT title, published, first_seen_at FROM reports ORDER BY first_seen_at DESC LIMIT 20;
```

## Limites conhecidos

- O JSON é sempre guardado inteiro; `ticker`/`title` são extraídos por
  heurística (renda fixa não tem ticker). Ao mudar a heurística, rode `daily:reindex`.
- O texto dos PDFs vem do `pdftotext`; tabelas e gráficos em imagem não viram texto.
- Carteiras sem assinatura podem redirecionar (`PAGE_REDIRECTED`).
- Valores ficam como a API envia; nada é convertido ou inventado.
