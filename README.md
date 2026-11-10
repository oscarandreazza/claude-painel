# painel

Dois plugins do Claude Code que abrem ferramentas de verdade num painel ao
lado da conversa, onde você vê o agente trabalhando.

| Plugin | O que faz |
|---|---|
| **navegador** | Navegador (terminal-browser) no painel, com um card que mostra cada passo do agente. Code mode pra testes e2e: `tb-look` explora a tela sem encher o contexto, `tb-run` roda o fluxo inteiro como roteiro Playwright e devolve só o resumo; `--evidencia` grava vídeo, um print por passo, rede e console; `--enviar` manda a evidência pra um servidor e devolve um link curto pra compartilhar. |
| **vscode-live** | `/vscode` abre o VS Code web no painel, na pasta da sessão. A aba do arquivo que o Claude edita anima, as linhas mudadas acendem, e erros de typecheck/lint/teste viram marcações no editor. |

## Instalar

```bash
claude plugin marketplace add oscarandreazza/claude-painel
claude plugin install navegador@painel
claude plugin install vscode-live@painel
```

Depois, `/reload-plugins` (ou reinicie o Claude Code).

## O que precisa

- **Terminal com o protocolo de imagens do kitty:** [Ghostty](https://ghostty.org) ou [kitty](https://sw.kovidgoyal.net/kitty/). No Terminal.app, no Warp e dentro do tmux o painel não desenha.
- **terminal-browser** 0.15+: `brew install terminal-browser`.
- **Node 18+** (o `tb-run` instala o `playwright-core` sozinho na primeira vez, sem baixar navegador) e **jq** (`brew install jq`).
- **ffmpeg**, só pra gravar vídeo (`--evidencia`/`--enviar`): `brew install ffmpeg`.
- Desligue o plugin original `terminal-browser@terminal-browser`, se estiver instalado (os dois registram `/browser`).

Detalhes de cada plugin: [`navegador/README.md`](navegador/README.md) e [`vscode-live/README.md`](vscode-live/README.md).

## Compartilhar evidência (`tb-run --enviar`)

O `--enviar` precisa de um servidor de evidências (um Worker da Cloudflare com
Supabase) e de um token de envio, em `~/.config/navegador/evidencias.env`:

```
EVIDENCE_URL=https://<seu-servidor>
EVIDENCE_TOKEN=<token de envio>
```

Peça os dois a quem mantém o servidor do seu time. Sem eles, use
`--evidencia`: o relatório (vídeo, passos, rede e console) fica numa pasta
local, pronto pra abrir no navegador ou publicar.

## Licença

MIT. O navegador é um fork do plugin terminal-browser da Zenbu Labs (MIT).
