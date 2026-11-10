# navegador

Um navegador de verdade num painel ao lado da conversa do Claude Code, com um
card embaixo mostrando o que o agente está fazendo na página: cada passo
(clicar, digitar, rolar), as verificações que passaram ou falharam, o tempo e
as requisições de rede. No fim, um relatório no card e uma tela final na página.

Feito sobre o [terminal-browser](https://terminal-browser.sh). É um fork do
plugin `terminal-browser` 0.0.2 da zenbu-labs (MIT).

## O que precisa

- **Terminal com o protocolo de imagens do kitty e "unicode placeholders"**:
  [Ghostty](https://ghostty.org) ou [kitty](https://sw.kovidgoyal.net/kitty/).
  No Warp, no Terminal.app e dentro do tmux o painel não desenha a página.
- **terminal-browser**: `brew install terminal-browser` (ou
  `curl -fsSL https://terminal-browser.sh/install | bash`). Versão 0.15 ou mais nova.
- **jq**: `brew install jq`. Sem ele o navegador abre, mas o card só avança
  no fim de cada comando e não há desenho na página nem coluna de rede.
- **python3** (já vem no macOS com as ferramentas de linha de comando): só pra
  digitação letra por letra; sem ele, o texto entra de uma vez.
- Claude Code recente, com hooks de função ligados. Se o painel não aparecer,
  ponha em `~/.claude/settings.json`: `{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }`.

Ao abrir pela primeira vez, o plugin avisa se faltar `jq` ou `python3`.

## Instalar

```
claude plugin marketplace add <repositório ou pasta do marketplace>
claude plugin install navegador@oscar-mods
```

Desligue o plugin original `terminal-browser@terminal-browser` se ele estiver
instalado: os dois registram `/browser`.

## Usar

- `/browser [url]` abre o painel (sem url: a última página, ou a inicial).
  `/browser` de novo, ou `/browser close`, fecha.
- O agente abre sozinho com a ferramenta `mcp__navegador__open` e mexe na
  página com `terminal-browser action -- …`. A skill `navegador`, que vem no
  plugin, ensina o fluxo a ele: abrir, agir, verificar, `action done`.
- **Code mode:** `tb-look [escopo | --secao "Título"]` mostra um pedaço enxuto
  da página pra explorar; `tb-run roteiro.mjs` (ou `pasta/`, ou `-` com
  heredoc) roda roteiros Playwright inteiros no navegador do painel e devolve
  só o resumo; `tb-record` grava o que a pessoa faz no painel e gera o roteiro.
  O `tb-run` tem helpers com cursor e contorno no alvo, `see` com região,
  `api()` pra conferir a requisição que a tela dispara, `--limpo`,
  `--repetir N`, `--falhar-em-5xx`, `--falhar-em-erro-js`, `--celular`/`--tela`,
  `--relatorio` (HTML com print por passo e abas Rede e Console sincronizadas
  ao vídeo, com segredo mascarado), `--video` (mp4, precisa de ffmpeg; selo
  ● REC na tela enquanto grava), `--evidencia` (os dois), `--enviar` (manda a
  evidência pro Worker das evidências e devolve um link curto `…/e/<uuid>`; config
  em `~/.config/navegador/evidencias.env` com `EVIDENCE_URL` e `EVIDENCE_TOKEN`) e
  `--sessao`/`--salvar-sessao`. Os passos aparecem no card ao vivo,
  uma etapa por roteiro. Precisa de node 18+; na primeira vez instala o
  `playwright-core` em `runner/` (sem baixar navegador).
- O botão `[−]`/`[+]` no canto do card recolhe o card pra só título e barra.
- **Modo de trabalho:** quando a página do painel é um editor (título
  terminando em "Visual Studio Code" ou "code-server"), o card some e o
  navegador é reaberto sem a barra de endereço (`TERMINAL_BROWSER_NO_CHROME=1`),
  ocupando o painel inteiro. Ao sair do editor para outro site, ele volta com a
  barra. Cada troca reabre o navegador: pisca uma vez e a aba perde o histórico
  de voltar.

## Opções

Em `/plugin` → navegador → configurar, ou em `~/.claude/settings.json` em
`pluginConfigs`:

| opção | padrão | o que faz |
|---|---|---|
| `agentTool` | `true` | registra `mcp__navegador__open` e `mcp__navegador__close` pro agente |
| `background` | `#050505` | cor pintada atrás do navegador e do card; em tema claro, use o fundo do seu terminal |

## Como funciona (pra quem for mexer)

- `hooks/register.tsx`: o módulo do plugin. Sobe a ponte do terminal-browser
  (`terminal-browser claude-bridge launch`), desenha o painel e manda cada
  quadro da página por `$.ui.blit`. Lê os comandos Bash do agente pra montar o
  card, sem alterá-los, e define `TERMINAL_BROWSER_AGENT` (o wrapper
  `bin/tb-agent-browser`) no ambiente da sessão. Reescrever o comando num hook
  faz o auto mode recusar a chamada, por isso o plugin não faz isso.
- `hooks/card.tsx`: o card, como módulo de `Client`. Anima o spinner sozinho,
  sem redesenhar o painel.
- `hooks/picture.ts`: qual quadro vai no desenho e qual vai por blit. O
  terminal apaga cada quadro (shm) ao ler; mandar o mesmo duas vezes fazia a
  imagem piscar. Os testes em `picture.test.ts` guardam essa regra.
- `bin/tb-agent-browser`: wrapper do agent-browser. Desenha o cursor e a
  legenda na página (`assets/`) e grava um evento por ação em
  `~/.tbab/<navegador>/events.jsonl`, que o card lê pra avançar.
- `bin/tb-net`, `bin/tb-page-js`: rede e console pro card; tela final e legenda.
- `bin/tb-run`, `bin/tb-look`, `bin/tb-record` + `runner/`: o code mode.
  `lib.mjs` conecta com `chromium.connectOverCDP` na porta CDP do navegador
  (`terminal-browser ls --json`), acha a aba pelo `targetId`, emula tela e
  limpa origem; `tb-run.mjs` grava eventos `phase: "add"`/`"chapter"` no mesmo
  `events.jsonl` e o card cria passos e etapas conforme eles chegam;
  `report.mjs` faz o relatório e o vídeo (screencast do CDP + ffmpeg);
  `capture.mjs` grava rede e console com o tempo do vídeo e mascara segredo;
  `recorder.js` é o gravador injetado na página pelo `tb-record.mjs`. Prints
  saem por `Page.captureScreenshot`: o `page.screenshot` do Playwright desfaz
  a emulação de tela depois de uma navegação. O texto que o plugin desenha na
  página (legenda, cursor, selos, selo de gravação) fica em shadow root
  fechado, pra o `getByText` dos roteiros não achar.
- `skills/navegador/SKILL.md`: o fluxo que o agente segue.

Testes: `claude plugin test .` na pasta do plugin. Validação: `claude plugin validate .`.
