---
name: navegador
description: Como abrir, usar e verificar páginas no navegador do painel ao lado da conversa (plugin navegador, terminal-browser). Use sempre que for testar, mostrar ou demonstrar algo no navegador, inclusive localhost, ou quando a pessoa pedir pra ver uma página.
---

# Navegador no painel

O plugin navegador mostra um navegador de verdade (terminal-browser) num painel
ao lado da conversa, com um card embaixo que lista cada passo seu. A pessoa vê
o que você faz, então trabalhe de um jeito que dê pra acompanhar.

## Fluxo

1. **Abrir:** ferramenta `mcp__navegador__open` com a URL (`localhost:3000`
   funciona). Pra trocar de página com o painel aberto, chame a mesma
   ferramenta de novo: ela troca o endereço na mesma aba.
   Não use `terminal-browser action -- open`: ele abre uma segunda aba, e as
   refs (`@eN`) passam a falhar com "Unknown ref". Se acontecer:
   `terminal-browser action -- tab close 1`.
2. **Agir:** `terminal-browser action -- snapshot -i`, depois `click @eN`,
   `fill @eN "texto"`, `press Enter`, `scroll down 600`, `get title`…
   (CLI compatível com o agent-browser). A ref expira quando a página se
   redesenha: tire o snapshot logo antes do clique.
3. **Verificar:** `wait --text "…"`, `wait --url "…"`, `wait --fn "…"` ou
   `is visible|checked|enabled <seletor>`. Esses entram no placar de
   verificações do card. `wait 500` é só pausa e não conta.
4. **Terminar:** sempre `terminal-browser action done`. Fecha o card com o
   relatório e mostra a tela final na página.

## Como escrever os comandos

- A `description` do Bash vira o título do card: escreva a intenção
  ("Marcar duas tarefas como feitas"), não o comando.
- Agrupe ações relacionadas num Bash só, encadeadas com `&&`. Cada uma aparece
  como "próximo" no card e avança conforme roda.
- Escreva `terminal-browser action -- …` literalmente, como comando (não dentro
  de variável ou função): o plugin lê esse texto pra montar o card. Comando
  montado numa variável (`$B click …`) funciona, mas some do card.
- Com mais de um navegador aberto (outra sessão também com o painel), o CLI
  recusa com "several browsers match". Use a chave que o
  `mcp__navegador__open` devolveu: `terminal-browser action --browser <chave> -- …`.

## Exemplo

```bash
terminal-browser action -- fill @e3 "oi" && terminal-browser action -- press Enter && terminal-browser action -- wait --text "Enviado"
```

## Code mode: `tb-look` + `tb-run` (+ `tb-record`) — padrão pra fluxos

Cada `action` e cada snapshot entram inteiros na conversa. Pra fluxo com mais
de ~3 ações (e2e, formulário, login, regressão), escreva um roteiro Playwright
e rode de uma vez com `tb-run`. Ele conecta por CDP no **mesmo navegador do
painel** (a pessoa vê tudo, com cursor e contorno no alvo), cada passo aparece
no card, e só o resumo volta:

- sucesso: `✓ roteiro ok · 9 passos · 3/3 verificações · 2.9s` + url, seus
  `log(...)`, avisos (texto ambíguo, painel pequeno) e requisições 4xx/5xx;
- falha: o passo, o erro curto, url, requisições com erro, erros de JavaScript,
  caminho de um print e as primeiras 40 linhas da árvore de acessibilidade,
  capturados na hora da falha.

Divisão de trabalho:
1. **Explorar** tela desconhecida: `tb-look [escopo]`. Só controles, títulos e
   o texto ao lado de cada controle, no formato que vira localizador
   (`button "Entrar"` → `getByRole('button', { name: 'Entrar' })`); linha de
   tabela sai inteira, sem repetir célula por célula.
   `tb-look --secao "Pagamento"` (a seção de um título), `tb-look form`,
   `tb-look 'role=dialog' --linhas 40`, `--tudo` inclui os textos. Prefira
   isso a `snapshot -i`.
2. **Executar**: `tb-run` com o fluxo inteiro. Na falha, corrija o roteiro e
   rode de novo; não volte pro passo a passo.
3. **Fluxo que a pessoa sabe fazer e você não** (raro): `tb-record` em segundo
   plano; ela faz o fluxo no painel e clica em "parar" no selo vermelho; sai um
   `.mjs` pra você completar com verificações. Não é a gravação de evidência:
   "gravar o teste" é `tb-run --evidencia` (abaixo).

```bash
tb-run --limpo - <<'EOF'
await goto('http://localhost:3000/login')
await fill(page.getByLabel('E-mail'), 'teste@ex.com')
await type(page.getByLabel('CPF'), '12345678901')      // tecla a tecla: máscara
await api('/api/login', { method: 'POST', status: 200, json: { ok: true } },
  () => click(page.getByRole('button', { name: 'Entrar' })))
const resumo = page.getByRole('region', { name: 'Resumo' })
await see('Bem-vindo')
await see('Plano Pro', { em: resumo })
log('saldo:', await page.getByTestId('saldo').textContent())
EOF
```

**No escopo do roteiro:**
- Ações com destaque no alvo (cada uma é um passo, com o nome do elemento no
  card): `click(alvo)`, `fill(alvo, texto)`, `type(alvo, texto)`,
  `select(alvo, valor)`, `hover(alvo)`, `press('Enter')`, `goto(url)`. `alvo`
  é um localizador (`page.getByRole(…)`) ou um seletor em string. Último
  argumento opcional: o rótulo do passo.
- `see(texto, opções)`: texto visível, **palavra inteira e diferenciando
  maiúsculas** (`see('Logado')` não passa em "Deslogado" nem em "logado").
  `{ em: região }` procura só dentro dela (use sempre que a palavra puder
  aparecer em outro lugar); `{ exact: true }` exige o texto inteiro do
  elemento; `{ parcial: true }` aceita pedaço sem diferenciar maiúsculas; um
  `RegExp` vai como está; `{ timeout: ms }`. Se o texto aparece em mais de um
  lugar, a saída avisa (`{ varios: true }` cala o aviso).
- `api(url, opções, ação?)`: a requisição que a tela dispara. `url` é pedaço
  ou `RegExp`; opções `method`, `status` (número ou função; padrão < 400),
  `json` (corpo esperado, contido no recebido; aceita RegExp nos valores),
  `timeout`. Com ação: `await api('/x', {…}, () => click(…))`. Sem ação:
  `const r = api('/x'); await click(…); await r`. Devolve `{ status, body }`.
- `check(rótulo, fn)`: verificação livre; falha se lançar ou devolver `false`.
- `step(rótulo, fn)`: passo livre (qualquer código Playwright).
- `log(...)`: o que você quer de volta na saída. `net`: requisições com erro
  até agora (`{ m, u, s }`). `page`, `context`, `sleep(ms)`.
- Código fora de passo roda, mas não aparece no card.
- Use localizadores do Playwright, não refs `@eN` (essas só valem no `action`).

**Suíte e opções:**
- Roteiro reutilizável num arquivo: `export default async ({ page, click, see, api, … }) => { … }`.
  `tb-run e2e/` roda todos os `.mjs` da pasta em ordem (os que começam com `_`
  ficam de fora, pra helpers); uma etapa no card e uma linha na saída por roteiro.
- `--limpo`: apaga localStorage, sessionStorage, IndexedDB e cookies da origem
  antes de cada roteiro/rodada (e de cada origem nova que o `goto` abrir).
  Use sempre que o app guarda progresso ou login.
- `--repetir N`: roda cada roteiro N vezes; `estável 5/5` ou `instável 3/5 ·
  onde falhou: “passo” 2x`, com a primeira falha detalhada.
- `--falhar-em-5xx` e `--falhar-em-erro-js`: resposta 5xx ou erro de
  JavaScript na página reprovam o roteiro (sem a flag, só aparecem na saída).
- `--celular` (iPhone 390x844, toque, user agent) ou `--tela 1280` (largura;
  altura = a do painel; `1280x800` fixa as duas): emulação desfeita no fim.
  O painel mostra a página em tamanho real, então tela mais larga que ele sai
  **cortada à direita no painel e no vídeo** (a saída avisa). Pra evidência,
  rode sem `--tela`; use `--tela` só pra testar layout de desktop quando o
  painel está estreito e um elemento "some" (`element is outside of the
  viewport`, aviso de "painel pequeno"). Alternativa: a pessoa alarga o painel
  ou aperta Cmd − nele.
- `--evidencia` = `--relatorio` + `--video` (mp4 do painel, ffmpeg). O
  relatório tem um print por passo e abas **Rede** e **Console** como no
  DevTools: toda requisição (método, status, tipo, duração, tamanho,
  cabeçalhos, payload, resposta de API), filtros e busca. O tempo de cada
  passo, requisição e linha de console pula o vídeo pra lá. Segredo sai
  mascarado (`•••`): cabeçalhos de credencial e campos de senha, token, CPF e
  cartão no corpo e na URL. Corpo de documento HTML não é guardado (pode ter
  token embutido). Enquanto grava, a página mostra o selo **● REC** com
  cronômetro e o card mostra "● REC" no título.
  `--titulo "…"` dá nome ao relatório.

**"Faz o teste gravando" / "com evidência" / "pra mandar pra alguém":**
1. `tb-run <roteiro> --enviar --relatorio-em <scratchpad>/evidencia-<nome> --titulo "<Projeto · fluxo>" --projeto <nome>`
   (mais `--limpo` e as flags de reprovação que fizerem sentido). `--enviar`
   já liga `--evidencia`, manda pro Worker das evidências (token em
   `~/.config/navegador/evidencias.env`) e imprime `link: …/e/<uuid>`.
2. Devolva esse link. Ele abre em qualquer navegador, sem conta, por 7 dias
   (validade em `evidence_runs.expires_at`; estender ou revogar = mudar a linha).
   Prints e rede podem ter dado do sistema testado: o mascaramento é por nome
   de campo, então avise se for tela sensível.
   Configurar uma máquina (uma vez): `~/.config/navegador/evidencias.env`, com
   permissão 600, contendo `EVIDENCE_URL=https://<servidor de evidências>` e
   `EVIDENCE_TOKEN=<token de envio>` (o mesmo valor do secret `UPLOAD_TOKEN` do
   Worker). O token só cria evidência; quem não tiver pede a quem mantém o
   servidor do time. Nunca peça nem cole o token no chat: ele vai direto pro
   arquivo (por exemplo, `pbpaste` pra dentro dele).
3. Plano B, se a saída disser `envio falhou` (sem `evidencias.env`, token recusado, Worker fora):
   use `--evidencia` e publique o `index.html` com a ferramenta **Artifact**
   (`root` = a pasta, `files` = `video.mp4`, `passos/NNN.jpg`, `falha-*.png`).
   Esse link só abre pra quem tem acesso à conta do claude.ai de quem publicou.
- `--salvar-sessao s.json` (no fim, se passou) e `--sessao s.json` (antes):
  cookies e localStorage **só do site da página atual**. Logue uma vez e reuse.
  O arquivo tem segredo: fora do git.
- `--browser <chave>`, `--timeout <ms>` (padrão 10000 por ação), `--pausa <ms>`
  entre passos (padrão 250; `0` roda seco), `--sem-print`.
- Trocar só o hash da URL com `page.goto` não recarrega: use `page.reload()`.
- Termine com `terminal-browser action done`, como no fluxo normal.
