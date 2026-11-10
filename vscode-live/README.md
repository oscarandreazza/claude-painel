# vscode-live

VS Code de verdade no painel do Claude Code, na pasta da sessão, com o que o Claude edita aparecendo ao vivo.

- `/vscode` abre o VS Code no painel do navegador (plugin `navegador`) na pasta onde o `claude` foi aberto. Se o servidor não estiver no ar, sobe; se já estiver (outro terminal subiu), reaproveita.
- `/vscode <pasta>` abre outra pasta (relativa à da sessão, ou absoluta).
- `/vscode stop` desliga o servidor.

Quando o Claude edita um arquivo da pasta aberta, a extensão **Claude Live** (que o `/vscode` instala no servidor):

- expande a árvore até o arquivo e o seleciona (`claudeLive.revealInExplorer`);
- anima a aba e a árvore enquanto a edição acontece (badge girando, cor pulsando) e depois marca o arquivo com um `C` verde;
- abre o diff antes × depois de tudo que o Claude mudou no arquivo desde que a janela abriu (`claudeLive.openAs`: `diff` ou `file`), com quem editou e o tamanho no título ("relatorio.ts · Nilumi (+12 −3)"). O "antes" é reconstruído desfazendo os trechos alterados no texto atual, então não depende de o VS Code ler o arquivo antes da escrita, e o diff nunca vem vazio;
- rola suave até o trecho e mostra o texto novo sendo digitado, com cursor verde (`claudeLive.typewriter`, `claudeLive.typingSpeed`; cada edição fica entre 0,6 e 2,5 s, e uma edição nova no meio termina a anterior na hora);
- acende as linhas mudadas em verde, com "◀ Claude" ao lado, apagando aos poucos;
- mostra na aba **Claude** da barra lateral (ícone de quatro quadrados), em **Editando**, a árvore do que ele tocou: pastas com "N alterados", arquivos com "+12 −3 · 15:40", e o arquivo em edição com ícone girando e "editando…", destacado e com a árvore aberta até ele; a linha do topo diz quem está editando o quê e o ícone da aba mostra quantos arquivos ele mexeu (clique abre o diff). O histórico da sessão sobrevive a um cmd+r;
- marca no Explorer, com ✎ e uma cor só, os arquivos que ele editou nesta sessão (as pastas acima ficam na mesma cor); o +/− e a hora aparecem ao passar o mouse;
- mapa de impacto (`claudeLive.impactMap`): os arquivos que importam um arquivo editado ganham ⇠ âmbar no Explorer ("usa carrinho.ts, editado por Nilumi") e aparecem em "usado por N" embaixo dele na árvore Editando: o que vale testar junto. Lê os imports de TS/JS (relativos, aliases do tsconfig, `.js` que aponta pra `.ts`, `require`), um projeto por vez, só quando um arquivo dele é editado;
- abre e pinta de azul o trecho que ele está lendo, com "👁 <nome> lendo" (`claudeLive.showReads`), e marca o arquivo com ◉ no Explorer enquanto lê. Vale pro Read e pras leituras por comando (`sed -n`, `head`, `cat`, `awk 'NR>=10 && NR<=40'`), avisadas quando o comando começa;
- nas buscas por comando (`rg`, `grep`, `git grep`), os arquivos encontrados ganham ⌕ no Explorer por uns segundos, e a barra de status diz o padrão e quantos achou. Só caminhos e linhas vão pra ponte, nunca o conteúdo;
- mostra "Claude editando…" na barra de status.

Erros do typecheck, do lint e dos testes que o Claude roda (`tsc`/`npm run typecheck`, `eslint`/`npm run lint`, `vitest`, `jest`) viram marcações no editor e no painel Problems, com a mensagem escrita na própria linha. Do comando só vão pra ponte o arquivo, a linha e a mensagem de cada erro; quando a ferramenta roda de novo e passa, as marcações dela somem. (O Error Lens instalado não roda em modo restrito; esse texto na linha é do próprio Claude Live.)

Na aba **Claude**, a seção **Agentes** (só com o Elo instalado) mostra os agentes conectados, com estado e pasta, o que cada um mexeu por último (quando a sessão dele também abriu o `/vscode`) e os pedidos em aberto entre eles. Se outro agente mexer num arquivo que esta sessão também mexeu, aparece um aviso.

Pra falar com o Claude a partir do editor: selecione um trecho, clique com o botão direito em **Perguntar ao Claude…** (ou Ctrl+⌥+K), escreva a pergunta e ela cai na caixa de digitação do Claude Code desta sessão, com o caminho, as linhas e o código; confira e aperte Enter lá. Nada é enviado sozinho: qualquer programa do seu usuário consegue escrever no arquivo que leva o pedido, então o envio é sempre seu. **Mandar trecho pro prompt do Claude** põe só o trecho, sem pergunta.

Os rótulos usam o nome de quem agiu: o subagente, ou o nome da sessão no Elo (`elo name`), ou "Claude" quando não tem Elo.

Pra navegar entre projetos sem sair do painel:

- **Pastas**, embaixo de Editando na mesma aba (ou o botão 📁 da barra de status): árvore nativa de pastas com os ícones do tema, partindo da pasta onde a sessão do Claude começou (ou de `claudeLive.projectsRoot`). A raiz é o primeiro item; a setinha abre as subpastas; a branch aparece ao lado quando é repositório; ao passar o mouse, dois botões abrem a pasta no VS Code ou ao lado (pasta sem subpastas abre com um clique). No topo: 🏠 volta pra pasta da sessão (e abre ela), ↑ sobe um nível. Pasta com edição do Claude em andamento pisca;
- **Ctrl+⌥+O**: busca rápida pelas pastas da raiz e pelos repositórios um nível abaixo.

Aparência: o botão 🎨 na barra de status abre o seletor de tema (as setas já mostram o tema, Enter fica, clicar fora volta pro de antes; o Esc não chega até a página, o Claude Code fica com ele) e liga ou desliga o fundo preto por cima do tema (`claudeLive.blackBackground`). O Claude Live instala uma vez, se faltarem, o Material Icon Theme, o Error Lens (erros escritos na própria linha) e os temas One Dark Pro, Tokyo Night, Catppuccin, Dracula e GitHub; desinstalou, não volta.

Formatar é só à mão: **Ctrl+⌥+F** ou clique direito → Format Document, com os formatadores que já vêm no VS Code (TypeScript, JavaScript, JSON, HTML, CSS), que funcionam em modo restrito. Formatar ao salvar, colar ou digitar fica desligado. Formatadores (Prettier, ESLint) não vêm instalados: o VS Code do painel abre as pastas em modo restrito, onde eles ficam desligados, e o salvamento automático por tempo não dispara "formatar ao salvar".

Atalhos com Cmd não chegam do terminal até a página: o VS Code do painel salva sozinho 1 s depois da última tecla, e **Ctrl+S** salva na hora.

Cada janela só reage às edições da sessão que abriu ela (e dos subagentes dela), dentro das pastas abertas. O VS Code começa no tema escuro com fundo preto, com ícones do Material Icon Theme, sem o chat de IA do lado e sem marcar letras acentuadas.

## Modo restrito

O VS Code abre pasta desconhecida em modo restrito: Git, Error Lens, formatadores e o terminal integrado ficam desligados. Pra ter tudo, confie na pasta onde você trabalha: F1 → **Workspaces: Manage Workspace Trust** → **Trust**. Confiar numa pasta vale pras subpastas dela; uma pasta de fora (um repositório baixado, por exemplo) continua perguntando. O Claude Live funciona igual nos dois modos.

## Como funciona

- Servidor: `code serve-web` da CLI oficial do VS Code em `~/.local/share/vscode-cli/code`, só em `127.0.0.1:8765`, com token em `~/.local/share/vscode-cli/token`. Sem o token, qualquer site aberto no navegador poderia falar com o terminal do VS Code.
- Ponte: a cada Edit/Write (início e fim, com as linhas e o +/−), Read (as linhas lidas), Grep/Glob (o padrão) o mod grava um evento; comandos não (a conversa já mostra),, com a sessão, o nome no Elo e o subagente, em `~/.claude/claude-live/bridge/<sessão>.json`, um arquivo por sessão pra duas sessões não apagarem o evento uma da outra. A extensão lê só o arquivo da sessão da janela (todos, numa janela sem sessão) a cada 100 ms, e um arquivo lido pela metade fica pra volta seguinte. No sentido contrário, o VS Code grava os pedidos do "Perguntar ao Claude" em `~/.claude/claude-live/inbox/<sessão>.json`; o mod lê a cada meio segundo e só preenche a caixa de digitação (sem caracteres de controle, até 12 mil caracteres), nunca envia.

- Privacidade: a ponte leva os caminhos e linhas que o Claude lê e edita, então só é gravada numa sessão que rodou `/vscode`; sem ele, nada vai pro disco. A pasta `~/.claude/claude-live` fica só do seu usuário (700), e no fim da sessão o mod apaga a ponte, a caixa de entrada e o workspace dela.

- Janela e sessão: o `/vscode` abre a pasta direto (`?folder=`), sempre o mesmo endereço, pra pergunta "confia nos autores?" do VS Code não voltar (um workspace novo por sessão fazia ela voltar a cada sessão). Qual sessão é dona da janela vai em `~/.claude/claude-live/windows/<pasta>.json`; a extensão lê ao carregar e guarda pra aquela janela, então duas sessões na mesma pasta não se misturam.

## Requisitos

- CLI do VS Code (macOS, arm64) descompactada em `~/.local/share/vscode-cli/code`: https://code.visualstudio.com/download
- Plugin `navegador` do mesmo marketplace, com a ferramenta do agente ligada.
