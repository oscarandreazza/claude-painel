// Claude Live: lê o arquivo-ponte que o mod vscode-live do Claude Code escreve
// a cada edição e mostra no VS Code o que o Claude está mexendo:
// - a árvore expande até o arquivo e o seleciona;
// - a aba e a árvore animam enquanto ele edita (badge girando, cor pulsando);
// - abre o diff antes × depois de tudo que ele mudou no arquivo;
// - as linhas mudadas acendem em verde com "◀ <nome>" e apagam aos poucos;
// - o que ele lê acende em azul ("👁 <nome> lendo") e o que ele busca aparece
//   na barra de status;
// - a aba "Claude" (barra lateral) abre em "Editando": a árvore do que ele
//   tocou, com +/−, a hora e "editando…", o número de arquivos no ícone e a
//   árvore abrindo até o que está em edição; o Explorer marca com ✎ o que
//   ele editou;
// - "Perguntar ao Claude" manda o trecho selecionado pro prompt da sessão.
// <nome>: o subagente que agiu, ou o nome da sessão no Elo, ou "Claude".
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createProjectsView } = require('./projects')
const { createAgentsView } = require('./agents')
const { ImpactIndex } = require('./impact')

// Um arquivo de eventos por sessão do Claude Code: <sessão>.json.
const BRIDGES = path.join(os.homedir(), '.claude', 'claude-live', 'bridge')
const POLL_MS = 100
const BEFORE_SCHEME = 'claude-before'
// Rodinha laranja girando ao lado do arquivo em edição (o Explorer só aceita
// texto ali, então é um spinner de caracteres).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PULSE = ['charts.orange']
const FRAME_MS = 100
// Uma edição leva ~300 ms: a animação (rodinha laranja no Explorer, "editando…"
// na árvore) fica pelo menos este tempo pra ser vista.
const MIN_ACTIVE_MS = 2500
// Quanto o brilho verde fica aceso depois da digitação, antes de apagar.
const GLOW_HOLD_MS = 1500
// O brilho apaga em degraus: quantos e quanto dura cada um (FADE_MS).
const FADE_STEPS = 12
const FADE_MS = 250
const GREEN = '115, 201, 145'
// Digitação ao vivo: ms por caractere, com piso e teto por edição.
const TYPE_FRAME_MS = 30
const MIN_TYPING_MS = 600
const MAX_TYPING_MS = 2500

// Leitura: quanto tempo o trecho lido fica azul. Durante uma edição a tela não
// sai do diff pra mostrar leitura.
// Quanto tempo o trecho lido fica azul, com "👁 <nome> lendo".
const READ_HOLD_MS = 2500
const EDIT_BUSY_MS = 4000
const BLUE = '120, 160, 255'
// Arquivo e pasta mexidos pelo Claude: uma cor só (claudeLive.edited).
const EDITED_COLOR = new vscode.ThemeColor('claudeLive.edited')
const timeOf = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
// Quem agiu: o subagente, ou o nome da sessão no Elo, ou "Claude".
const whoOf = ev => ev.agent || ev.name || 'Claude'
const INBOX = path.join(os.homedir(), '.claude', 'claude-live', 'inbox')
// Vínculo janela → sessão que o /vscode grava: windows/<pasta codificada>.json.
const WINDOWS = path.join(os.homedir(), '.claude', 'claude-live', 'windows')
const bindingFile = folder => path.join(WINDOWS, `${encodeURIComponent(folder)}.json`)
function readBinding() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!folder) return {}
  try {
    return JSON.parse(fs.readFileSync(bindingFile(folder), 'utf8'))
  } catch {
    return {}
  }
}
function writeBinding(folder, binding) {
  fs.mkdirSync(WINDOWS, { recursive: true })
  const file = bindingFile(folder)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(binding))
  fs.renameSync(`${file}.tmp`, file)
}

/** fsPath -> quando começou a edição */
const active = new Map()
/** fsPath -> quem está editando (subagente, nome no Elo ou "Claude") */
const activeAgent = new Map()
/** fsPath -> { until, who }: arquivo que o Claude está lendo (olho no Explorer) */
const readingNow = new Map()
/** fsPath -> { until, pattern }: arquivo que uma busca dele achou (lupa no Explorer) */
const foundNow = new Map()
const FOUND_HOLD_MS = 8000
const READ_COLOR = new vscode.ThemeColor('claudeLive.read')
/** mapa de impacto: arquivo que importa um editado -> o editado que ele usa */
const impactedBy = new Map()
/** índice de imports por projeto (impact.js) */
let impact
const IMPACT_COLOR = new vscode.ThemeColor('claudeLive.impact')
/** fsPath -> { edits, adds, dels, at, isNew, who } do que o Claude já tocou nesta janela */
const touched = new Map()
/** fsPath -> conteúdo antes da primeira edição do Claude nesta janela */
const baselines = new Map()
let frame = 0
/** arquivo da ponte -> { mtimeMs, lastSeq } do que já foi lido */
const seen = new Map()
let poller
let ticker
/** a aba Projetos; avisada a cada início e fim de edição */
let projectsView

// ---------- configuração da janela ----------

// Fundo preto, como o terminal do Oscar. Uma cor que a pessoa já tenha
// personalizado continua valendo.
const BLACK = {
  'editor.background': '#000000',
  'editorGutter.background': '#000000',
  'minimap.background': '#000000',
  'sideBar.background': '#000000',
  'sideBarSectionHeader.background': '#000000',
  'activityBar.background': '#000000',
  'panel.background': '#000000',
  'terminal.background': '#000000',
  'titleBar.activeBackground': '#000000',
  'titleBar.inactiveBackground': '#000000',
  'statusBar.background': '#000000',
  'statusBar.noFolderBackground': '#000000',
  'editorGroupHeader.tabsBackground': '#000000',
  'tab.activeBackground': '#0a0a0a',
  'tab.inactiveBackground': '#000000',
  'breadcrumb.background': '#000000',
}
const DARK_THEME = 'Default Dark Modern'
const ICON_THEME_EXTENSION = 'PKief.material-icon-theme'
const ICON_THEME = 'material-icon-theme'

// O VS Code do painel é pra ver o que o Claude edita: sem chat de IA do lado,
// sem página de boas-vindas, sem quadrado em volta de letra acentuada.
const LAYOUT = {
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'workbench.startupEditor': 'none',
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'editor.smoothScrolling': true,
  'workbench.list.smoothScrolling': true,
  'editor.cursorSmoothCaretAnimation': 'on',
  // Painel estreito: linha comprida desce em vez de esconder o resto à direita.
  'editor.wordWrap': 'on',
  'diffEditor.wordWrap': 'on',
  // Diff sempre lado a lado (antes | depois), mesmo no painel estreito: sem
  // isso o VS Code troca sozinho pro diff em linha única quando falta espaço.
  'diffEditor.renderSideBySide': true,
  'diffEditor.useInlineViewWhenSpaceIsLimited': false,
  'editor.unicodeHighlight.nonBasicASCII': false,
  'editor.unicodeHighlight.ambiguousCharacters': false,
  // O aviso de modo restrito no topo: o modo continua, só some a faixa.
  'security.workspace.trust.banner': 'never',
  // Sem o quadro "confia nos autores?" ao abrir: a pasta continua em modo
  // restrito, só não pergunta (quando a configuração consegue ser gravada).
  'security.workspace.trust.startupPrompt': 'never',
  // Cmd+S não chega do terminal até a página: salva sozinho.
  'files.autoSave': 'afterDelay',
  'files.autoSaveDelay': 1000,
  // Formatar só à mão (Ctrl+⌥+F ou clique direito → Format Document), nunca
  // sozinho ao salvar ou colar.
  'editor.formatOnSave': false,
  'editor.formatOnPaste': false,
  'editor.formatOnType': false,
}

async function setIfDifferent(config, key, value, target) {
  if (JSON.stringify(config.get(key)) !== JSON.stringify(value)) await config.update(key, value, target)
}

// Extensões que o Claude Live instala uma vez (se faltarem): ícones, Error Lens
// e temas pro seletor 🎨. Cada uma é tentada só uma vez: desinstalada pela
// pessoa, não volta.
const BUNDLED = [
  'PKief.material-icon-theme',
  'usernamehw.errorlens',
  'zhuangtongfa.material-theme',
  'enkia.tokyo-night',
  'Catppuccin.catppuccin-vsc',
  'dracula-theme.theme-dracula',
  'GitHub.github-vscode-theme',
]
const BUNDLED_KEY = 'claudeLive.bundledTried'

async function installBundled(context) {
  const tried = new Set(context.globalState.get(BUNDLED_KEY, []))
  for (const id of BUNDLED) {
    if (tried.has(id) || vscode.extensions.getExtension(id)) continue
    tried.add(id)
    await context.globalState.update(BUNDLED_KEY, [...tried])
    await vscode.commands.executeCommand('workbench.extensions.installExtension', id).then(undefined, () => undefined)
  }
}

// Fundo preto por cima de qualquer tema (claudeLive.blackBackground): liga
// juntando as cores pretas às personalizações da pessoa (as dela vencem),
// desliga tirando só as que ainda estão com o valor que pusemos.
async function applyBlack(on) {
  const config = vscode.workspace.getConfiguration()
  const own = config.inspect('workbench.colorCustomizations')?.globalValue || {}
  let next
  if (on) {
    next = { ...BLACK, ...own }
  } else {
    next = { ...own }
    for (const [key, value] of Object.entries(BLACK)) if (next[key] === value) delete next[key]
  }
  if (JSON.stringify(next) !== JSON.stringify(own)) {
    await config.update('workbench.colorCustomizations', next, vscode.ConfigurationTarget.Global).then(undefined, () => undefined)
  }
}

const THEME_SET_KEY = 'claudeLive.themeSet'

async function applyDefaults(context) {
  const config = vscode.workspace.getConfiguration()
  const target = vscode.ConfigurationTarget.Global
  for (const [key, value] of Object.entries(LAYOUT)) {
    // Chave que esta versão não conhece: segue com o resto.
    await setIfDifferent(config, key, value, target).catch(() => undefined)
  }
  if (vscode.extensions.getExtension(ICON_THEME_EXTENSION)) {
    await setIfDifferent(config, 'workbench.iconTheme', ICON_THEME, target).catch(() => undefined)
  }
  // O tema escuro só na primeira vez: depois vale o que a pessoa escolher no 🎨.
  if (!context.globalState.get(THEME_SET_KEY, false)) {
    await setIfDifferent(config, 'window.autoDetectColorScheme', false, target).catch(() => undefined)
    await setIfDifferent(config, 'workbench.colorTheme', DARK_THEME, target).catch(() => undefined)
    await context.globalState.update(THEME_SET_KEY, true)
  }
  const claude = vscode.workspace.getConfiguration('claudeLive')
  await applyBlack(claude.get('blackBackground', claude.get('forceDark', true)))
}

// Temas do seletor 🎨: os das extensões instaladas, mais os que o Claude Live
// instala (caso o VS Code ainda não liste: tema de extensão da interface).
const KNOWN_THEMES = [
  ['Default Dark Modern', 'dark'], ['Default Dark+', 'dark'],
  ['One Dark Pro', 'dark'], ['One Dark Pro Darker', 'dark'], ['One Dark Pro Night Flat', 'dark'],
  ['Tokyo Night', 'dark'], ['Tokyo Night Storm', 'dark'],
  ['Catppuccin Mocha', 'dark'], ['Catppuccin Macchiato', 'dark'], ['Catppuccin Frappé', 'dark'],
  ['Dracula Theme', 'dark'], ['Dracula Theme Soft', 'dark'],
  ['GitHub Dark Default', 'dark'], ['GitHub Dark Dimmed', 'dark'],
  ['Default Light Modern', 'light'], ['Catppuccin Latte', 'light'], ['GitHub Light Default', 'light'], ['Tokyo Night Light', 'light'],
]

function themeList() {
  const byId = new Map(KNOWN_THEMES.map(([id, kind]) => [id, kind]))
  for (const ext of vscode.extensions.all) {
    for (const theme of ext.packageJSON?.contributes?.themes ?? []) {
      const id = theme.id || theme.label
      if (id && !byId.has(id)) byId.set(id, theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light' ? 'light' : 'dark')
    }
  }
  return [...byId]
}

// ---------- decorações na árvore e nas abas ----------

class Decorations {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeFileDecorations = this.emitter.event
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file') return undefined
    const p = uri.fsPath
    if (active.has(p)) {
      return new vscode.FileDecoration(
        SPINNER[frame % SPINNER.length],
        `${activeAgent.get(p) ?? 'Claude'} editando…`,
        new vscode.ThemeColor(PULSE[0]),
      )
    }
    // Pasta com um arquivo em edição dentro: o mesmo giro, mais discreto
    // (a árvore de Pastas e o Explorer mostram o caminho até o arquivo).
    const inside = [...active.keys()].find(file => file.startsWith(p + path.sep))
    if (inside) {
      return new vscode.FileDecoration(
        SPINNER[frame % SPINNER.length],
        `${activeAgent.get(inside) ?? 'Claude'} editando aqui dentro`,
        new vscode.ThemeColor(PULSE[0]),
      )
    }
    // Lendo agora (olho) ou achado numa busca dele (lupa), por uns segundos.
    const reading = readingNow.get(p)
    if (reading && reading.until > Date.now()) return new vscode.FileDecoration('◉', `${reading.who} lendo`, READ_COLOR)
    const found = foundNow.get(p)
    if (found && found.until > Date.now()) return new vscode.FileDecoration('⌕', `achado na busca “${found.pattern}”`, READ_COLOR)
    // Pasta com leitura ou achado dentro: a mesma cor, sem marca.
    const isLooking = [...readingNow, ...foundNow].some(([file, mark]) => mark.until > Date.now() && file.startsWith(p + path.sep))
    if (isLooking) return new vscode.FileDecoration(undefined, 'o Claude está olhando aqui dentro', READ_COLOR)
    // Editado nesta sessão: ✎ e a cor de editado; o +/− e a hora no tooltip.
    const info = touched.get(p)
    if (info) {
      return new vscode.FileDecoration('✎', `+${info.adds} −${info.dels} · ${info.who} às ${timeOf(info.at)}`, EDITED_COLOR)
    }
    // Usa um arquivo editado (mapa de impacto): pode ter sido afetado.
    const source = impactedBy.get(p)
    if (source) {
      return new vscode.FileDecoration('⇠', `usa ${path.basename(source)}, editado por ${touched.get(source)?.who ?? 'Claude'}`, IMPACT_COLOR)
    }
    // Pasta com arquivo editado dentro: só a cor, como o Git faz.
    let files = 0
    for (const file of touched.keys()) if (file.startsWith(p + path.sep)) files++
    if (files > 0) {
      return new vscode.FileDecoration(undefined, `${files} arquivo${files === 1 ? '' : 's'} editado${files === 1 ? '' : 's'} pelo Claude`, EDITED_COLOR)
    }
    return undefined
  }

  // O arquivo e as pastas acima dele, até a raiz de casa.
  refresh(paths) {
    const uris = new Set()
    for (const p of paths) {
      let current = p
      while (current.startsWith(os.homedir()) && !uris.has(current)) {
        uris.add(current)
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    this.emitter.fire([...uris].map(p => vscode.Uri.file(p)))
  }
}

// ---------- "Editados pelo Claude" no Explorer ----------

class EditedTree {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
  }

  refresh() {
    this.emitter.fire(undefined)
  }

  paths() {
    return [...new Set([...active.keys(), ...touched.keys()])]
  }

  // A pasta aberta que contém o arquivo; fora de todas, a pasta dele.
  rootOf(file) {
    const roots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath)
    return roots.filter(root => file.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0] ?? path.dirname(file)
  }

  childrenOf(dir, paths) {
    const children = new Map()
    for (const file of paths) {
      if (!file.startsWith(dir + path.sep)) continue
      const parts = file.slice(dir.length + 1).split(path.sep)
      const child = path.join(dir, parts[0])
      children.set(child, parts.length === 1 ? 'file' : 'dir')
    }
    return [...children]
      .map(([p, kind]) => ({ p, kind }))
      .sort((a, b) => (a.kind === b.kind ? path.basename(a.p).localeCompare(path.basename(b.p)) : a.kind === 'dir' ? -1 : 1))
  }

  roots() {
    return [...new Set(this.paths().map(file => this.rootOf(file)))]
  }

  getChildren(node) {
    const paths = this.paths()
    // Arquivo editado: quem importa ele (o que vale testar junto).
    if (node?.kind === 'file') return (impact?.dependents(node.p) ?? []).map(p => ({ p, kind: 'dep', of: node.p }))
    if (node?.kind === 'dep') return []
    if (node) return this.childrenOf(node.p, paths)
    const roots = this.roots()
    // Uma pasta só: começa direto no conteúdo dela, como no Explorer.
    return roots.length === 1 ? this.childrenOf(roots[0], paths) : roots.map(p => ({ p, kind: 'dir' }))
  }

  // Pra abrir a árvore até o arquivo em edição e destacar ele.
  getParent({ p, kind, of }) {
    if (kind === 'dep') return { p: of, kind: 'file' }
    const roots = this.roots()
    if (roots.includes(p)) return undefined
    const parent = path.dirname(p)
    if (roots.length === 1 && parent === roots[0]) return undefined
    return { p: parent, kind: 'dir' }
  }

  getTreeItem({ p, kind, of }) {
    if (kind === 'dir') {
      const item = new vscode.TreeItem(vscode.Uri.file(p), vscode.TreeItemCollapsibleState.Expanded)
      const inside = this.paths().filter(file => file.startsWith(p + path.sep))
      const editing = inside.some(file => active.has(file))
      item.id = `d:${p}`
      item.description = editing ? 'editando…' : `${inside.length} alterado${inside.length === 1 ? '' : 's'}`
      return item
    }
    if (kind === 'dep') {
      const dep = new vscode.TreeItem(vscode.Uri.file(p), vscode.TreeItemCollapsibleState.None)
      dep.id = `dep:${p}`
      dep.description = `usa ${path.basename(of)}`
      dep.command = { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.file(p)] }
      return dep
    }
    const users = impact?.dependents(p).length ?? 0
    const item = new vscode.TreeItem(vscode.Uri.file(p), users > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    const info = touched.get(p)
    item.id = `f:${p}`
    if (active.has(p)) {
      item.description = `${activeAgent.get(p) ?? 'Claude'} editando…`
      item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.orange'))
    } else if (info) {
      item.description = `+${info.adds} −${info.dels} · ${timeOf(info.at)}${info.who && info.who !== 'Claude' ? ` · ${info.who}` : ''}`
    }
    if (users > 0) item.description = `${item.description ?? ''} · usado por ${users}`
    // Tooltip com o resumo da edição: caminho, quem, quando e o tamanho.
    item.tooltip = info
      ? `${p}\n+${info.adds} −${info.dels} em ${info.edits} edição${info.edits === 1 ? '' : 'ões'} · ${info.who} às ${timeOf(info.at)}`
      : p
    item.command = { command: 'claudeLive.openDiff', title: 'Ver o que o Claude mudou', arguments: [p] }
    return item
  }
}

// ---------- utilidades ----------

// Os eventos de um arquivo da ponte, ou undefined se ele não existe ou veio
// pela metade (a gravação ainda não terminou): aí lê de novo na volta seguinte.
function readBridge(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed.events) ? parsed.events : []
  } catch {
    return undefined
  }
}

function bridgeFiles(session) {
  if (session) return [path.join(BRIDGES, `${session}.json`)]
  try {
    return fs.readdirSync(BRIDGES).filter(name => name.endsWith('.json')).map(name => path.join(BRIDGES, name))
  } catch {
    return []
  }
}

const mtimeOf = file => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

const beforeUri = p => vscode.Uri.from({ scheme: BEFORE_SCHEME, path: p })

// O texto de antes da edição, desfazendo os trechos alterados no texto de
// agora (do último trecho pro primeiro, pra os números de linha não mudarem).
function undoHunks(text, hunks) {
  const lines = text.split('\n')
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const before = h.lines.filter(l => !l.startsWith('+') && !l.startsWith('\\')).map(l => l.slice(1))
    lines.splice(Math.max(0, h.newStart - 1), h.newLines, ...before)
  }
  return lines.join('\n')
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  void applyDefaults(context).then(() => installBundled(context))

  const decorations = new Decorations()
  const tree = new EditedTree()
  let editedView
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations),
    (editedView = vscode.window.createTreeView('claudeLive.edited', { treeDataProvider: tree })),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
      provideTextDocumentContent: uri => baselines.get(uri.path) ?? '',
    }),
  )

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000)
  status.command = 'workbench.view.explorer'
  context.subscriptions.push(status)
  let statusTimer

  // Fundo leve (o diff já pinta as linhas novas de verde; somado, escondia o
  // código) e o destaque forte na faixa à esquerda, que não cobre o texto.
  const fadeTypes = Array.from({ length: FADE_STEPS }, (_, i) => {
    const left = 1 - i / FADE_STEPS
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: `rgba(${GREEN}, ${(0.16 * left).toFixed(3)})`,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: `rgba(${GREEN}, ${Math.max(0.2, left).toFixed(3)})`,
      overviewRulerColor: `rgba(${GREEN}, 0.8)`,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
  })
  // O texto do rótulo ("◀ Nilumi") vai em cada uso, pelo renderOptions.
  const label = vscode.window.createTextEditorDecorationType({
    after: { color: `rgb(${GREEN})`, fontWeight: 'bold', margin: '0 0 0 1em' },
  })
  const readLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: `rgba(${BLUE}, 0.07)`,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: `rgba(${BLUE}, 0.85)`,
    overviewRulerColor: `rgba(${BLUE}, 0.8)`,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })
  const readLabel = vscode.window.createTextEditorDecorationType({
    after: { color: `rgb(${BLUE})`, fontWeight: 'bold', margin: '0 0 0 1em' },
  })
  context.subscriptions.push(...fadeTypes, label, readLines, readLabel)
  const labelAt = (line, text) => ({
    range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
    renderOptions: { after: { contentText: `  ${text}` } },
  })

  const config = () => vscode.workspace.getConfiguration('claudeLive')
  // De qual sessão é esta janela: lido uma vez, ao carregar, e guardado. Outra
  // sessão abrindo a mesma pasta depois não toma esta janela.
  const binding = readBinding()
  const sessionOf = () => config().get('session', '') || binding.session || ''

  // O que já foi mexido nesta sessão sobrevive a um cmd+r: guardado por sessão
  // no estado desta pasta. (O "antes" dos diffs não: fica só na memória.)
  const touchedKey = () => `claudeLive.touched:${sessionOf()}`
  for (const [file, info] of context.workspaceState.get(touchedKey(), [])) touched.set(file, info)
  const saveTouched = () => void context.workspaceState.update(touchedKey(), [...touched].slice(-300))

  // A aba "Editando": número no ícone (arquivos mexidos), a linha do topo
  // enquanto há edição, e a árvore abrindo até o arquivo em edição.
  const showEditing = () => {
    if (!editedView) return
    editedView.badge = touched.size > 0 ? { value: touched.size, tooltip: `${touched.size} arquivo${touched.size === 1 ? '' : 's'} mexido${touched.size === 1 ? '' : 's'} nesta sessão` } : undefined
    const editing = [...active.keys()]
    const who = new Set(editing.map(file => activeAgent.get(file) ?? 'Claude'))
    editedView.message =
      editing.length === 0
        ? undefined
        : `✎ ${who.size > 1 ? `${who.size} agentes` : [...who][0]} editando ${editing.length > 2 ? `${editing.length} arquivos` : editing.map(file => path.basename(file)).join(', ')}`
  }
  // Com a aba "Claude" › Editando aberta, a árvore dela abre até o arquivo em
  // edição. Com claudeLive.followInSidebar, a barra lateral vai pra ela
  // sozinha; o padrão é o Explorer seguir o arquivo (escolha do Oscar).
  const revealEditing = file => {
    if (!editedView) return
    const isFollowing = config().get('followInSidebar', false)
    if (!editedView.visible && !isFollowing) return
    const wasVisible = editedView.visible
    if (!wasVisible) void vscode.commands.executeCommand('workbench.view.extension.claudeLive').then(undefined, () => undefined)
    // Depois do refresh da árvore (e da aba abrir), pra o item já existir.
    setTimeout(() => {
      void editedView.reveal({ p: file, kind: 'file' }, { select: true, focus: false, expand: true }).then(undefined, () => undefined)
    }, wasVisible ? 60 : 250)
  }
  // Histórico restaurado de antes do cmd+r: já aparece na árvore e no número.
  tree.refresh()
  showEditing()

  // ---------- mapa de impacto ----------
  // Quem importa os arquivos editados ganha ⇠ no Explorer e aparece em
  // "usado por" na árvore Editando. O índice é por projeto e só nasce quando
  // um arquivo dele é editado.
  const recomputeImpact = () => {
    const before = [...impactedBy.keys()]
    impactedBy.clear()
    if (config().get('impactMap', true)) {
      for (const file of touched.keys()) {
        for (const dep of impact.dependents(file)) if (!touched.has(dep)) impactedBy.set(dep, file)
      }
    }
    decorations.refresh([...new Set([...before, ...impactedBy.keys()])])
    tree.refresh()
  }
  impact = new ImpactIndex(recomputeImpact)
  const indexFile = file => {
    if (config().get('impactMap', true)) void impact.ensure(file).then(recomputeImpact)
  }
  for (const file of touched.keys()) indexFile(file)
  // Os mesmos tipos que o índice lê (impact.js), .vue e .svelte inclusos.
  const codeWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}')
  context.subscriptions.push(
    codeWatcher,
    codeWatcher.onDidChange(uri => impact.update(uri.fsPath)),
    codeWatcher.onDidCreate(uri => impact.update(uri.fsPath)),
    codeWatcher.onDidDelete(uri => impact.remove(uri.fsPath)),
  )

  // Seção "Agentes": os agentes do Elo, o que mexeram e os pedidos entre eles.
  createAgentsView(context, { session: sessionOf, touched: () => [...touched.keys()] })

  // Diff antes × depois de tudo que o Claude mudou no arquivo nesta janela.
  // O título diz quem editou e quanto: "relatorio.ts · Nilumi (+12 −3)".
  const openDiff = async p => {
    const info = touched.get(p)
    const title = `${path.basename(p)} · ${info?.who ?? 'Claude'}${info ? ` (+${info.adds} −${info.dels})` : ''}`
    if (!baselines.has(p)) baselines.set(p, readText(p) ?? '')
    await vscode.commands.executeCommand('vscode.diff', beforeUri(p), vscode.Uri.file(p), title, {
      preview: false,
      preserveFocus: true,
    })
  }
  context.subscriptions.push(vscode.commands.registerCommand('claudeLive.openDiff', openDiff))

  // ---------- trocar de pasta ----------
  // Botão "📁 pasta" na barra de status (e Ctrl+⌥+O): busca nas pastas de
  // pastas da raiz (a pasta da sessão, ou claudeLive.projectsRoot) e nos
  // repositórios um nível abaixo, as recentes primeiro.
  // Trocar mantém o workspace desta sessão (e o filtro dela).
  const RECENTS_KEY = 'claudeLive.recentFolders'
  const folderButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001)
  folderButton.command = 'claudeLive.switchFolder'
  folderButton.tooltip = 'Trocar de pasta (Ctrl+⌥+O)'
  context.subscriptions.push(folderButton)

  const showFolder = () => {
    const folders = vscode.workspace.workspaceFolders || []
    const names = folders.map(f => f.name)
    folderButton.text = `$(folder-opened) ${names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(' + ') || 'sem pasta'}`
    folderButton.show()
  }
  showFolder()
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(showFolder))

  // ---------- seletor de tema 🎨 ----------
  // Lista os temas escuros e claros; andar pela lista já mostra o tema, Enter
  // fica com ele, Esc volta pro de antes. O primeiro item liga ou desliga o
  // fundo preto por cima do tema.
  const themeButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  themeButton.text = '$(paintcan)'
  themeButton.tooltip = 'Trocar o tema'
  themeButton.command = 'claudeLive.pickTheme'
  themeButton.show()
  context.subscriptions.push(themeButton)

  const pickTheme = () => {
    const settings = vscode.workspace.getConfiguration()
    const claude = vscode.workspace.getConfiguration('claudeLive')
    const original = settings.get('workbench.colorTheme')
    const isBlack = claude.get('blackBackground', claude.get('forceDark', true))
    const preview = id => void settings.update('workbench.colorTheme', id, vscode.ConfigurationTarget.Global).then(undefined, () => undefined)
    const themes = themeList()
    const item = ([id]) => ({ label: id, description: id === original ? 'atual' : undefined, themeId: id })
    const pick = vscode.window.createQuickPick()
    pick.title = 'Tema do VS Code'
    pick.placeholder = 'Setas mostram o tema na hora; Enter fica; clicar fora volta pro de antes'
    pick.items = [
      { label: `$(circle-large-filled) Fundo preto: ${isBlack ? 'ligado' : 'desligado'}`, description: 'por cima do tema', toggleBlack: true },
      { label: 'escuros', kind: vscode.QuickPickItemKind.Separator },
      ...themes.filter(([, kind]) => kind === 'dark').map(item),
      { label: 'claros', kind: vscode.QuickPickItemKind.Separator },
      ...themes.filter(([, kind]) => kind === 'light').map(item),
    ]
    const current = pick.items.find(i => i.themeId === original)
    if (current) pick.activeItems = [current]
    let accepted = false
    pick.onDidChangeActive(([active]) => {
      if (active?.themeId) preview(active.themeId)
    })
    pick.onDidAccept(() => {
      const [chosen] = pick.selectedItems
      accepted = true
      pick.hide()
      if (chosen?.toggleBlack) {
        void claude.update('blackBackground', !isBlack, vscode.ConfigurationTarget.Global).then(() => applyBlack(!isBlack))
        preview(original)
      } else if (chosen?.themeId) {
        preview(chosen.themeId)
      }
    })
    pick.onDidHide(() => {
      if (!accepted) preview(original)
      pick.dispose()
    })
    pick.show()
  }
  context.subscriptions.push(vscode.commands.registerCommand('claudeLive.pickTheme', pickTheme))

  // Onde a sessão do Claude começou: o /vscode grava no workspace. Sem isso
  // (janela aberta à mão), a primeira pasta aberta, ou o HOME.
  const sessionFolder = () =>
    config().get('sessionFolder', '') || binding.sessionFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir()
  // Raiz da aba Pastas e da busca rápida: claudeLive.projectsRoot, se a pessoa
  // fixou uma; senão a pasta da sessão.
  const projectsRoot = () => config().get('projectsRoot', '') || sessionFolder()
  const isRepo = dir => fs.existsSync(path.join(dir, '.git'))
  const subdirs = dir => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => path.join(dir, d.name))
    } catch {
      return []
    }
  }
  const listProjects = () => {
    const root = projectsRoot()
    const out = []
    for (const dir of subdirs(root)) {
      if (isRepo(dir)) {
        out.push(dir)
        continue
      }
      // Pasta que só agrupa repositórios (ex.: uma pasta da empresa) vira grupo, não
      // projeto; pasta sem repositório dentro é um projeto por si.
      const repos = subdirs(dir).filter(isRepo)
      out.push(...(repos.length > 0 ? repos : [dir]))
    }
    return { root, dirs: out }
  }

  const remember = dir => {
    const recents = context.globalState.get(RECENTS_KEY, []).filter(d => d !== dir)
    void context.globalState.update(RECENTS_KEY, [dir, ...recents].slice(0, 8))
  }

  const switchTo = async (dir, beside) => {
    const uri = vscode.Uri.file(dir)
    const folders = vscode.workspace.workspaceFolders || []
    remember(dir)
    // Janela aberta pelo /vscode é um workspace: troca a pasta dentro dele e
    // o id da sessão fica. Aberta só com uma pasta, abre a outra no lugar.
    if (vscode.workspace.workspaceFile?.scheme === 'file') {
      if (beside) vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri })
      else vscode.workspace.updateWorkspaceFolders(0, folders.length, { uri })
      return
    }
    // A janela recarrega na pasta nova: o vínculo vai junto, pra ela continuar
    // sendo desta sessão.
    const session = sessionOf()
    if (session) writeBinding(dir, { session, sessionFolder: sessionFolder(), at: Date.now() })
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true })
  }

  const besideButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Abrir ao lado, sem fechar a atual' }

  const pickFolder = async () => {
    const { root, dirs } = listProjects()
    const open = new Set((vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath))
    const recents = context.globalState.get(RECENTS_KEY, []).filter(d => fs.existsSync(d))
    const itemFor = dir => ({
      label: `${isRepo(dir) ? '$(repo)' : '$(folder)'} ${path.relative(root, dir) || path.basename(dir)}`,
      description: open.has(dir) ? 'aberta' : undefined,
      dir,
      buttons: [besideButton],
    })
    const items = [
      ...(recents.length > 0 ? [{ label: 'recentes', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...recents.map(itemFor),
      { label: path.basename(root), kind: vscode.QuickPickItemKind.Separator },
      ...dirs.filter(d => !recents.includes(d)).map(itemFor),
    ]
    const pick = vscode.window.createQuickPick()
    pick.items = items
    pick.placeholder = 'Trocar de pasta: digite parte do nome (o botão ⊟ abre ao lado; clicar fora fecha)'
    pick.matchOnDescription = true
    pick.onDidTriggerItemButton(({ item }) => {
      pick.hide()
      void switchTo(item.dir, true)
    })
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems
      pick.hide()
      if (item?.dir) void switchTo(item.dir, false)
    })
    pick.onDidHide(() => pick.dispose())
    pick.show()
  }
  context.subscriptions.push(vscode.commands.registerCommand('claudeLive.switchFolder', pickFolder))

  // A aba "Pastas" (navegador de pastas); o botão da barra de status abre ela.
  projectsView = createProjectsView(context, {
    projectsRoot,
    sessionFolder,
    recents: () => context.globalState.get(RECENTS_KEY, []),
    switchTo,
    activity: () => ({ editing: [...active.keys()], touched: [...touched.keys()] }),
  })
  folderButton.command = 'claudeLive.projects.focus'
  folderButton.tooltip = 'Pastas (Ctrl+⌥+O: busca rápida)'

  const openFile = async p => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p))
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true })
  }

  // Revelar no Explorer só quando a aba "Claude" não segue a edição: senão
  // as duas brigariam pela barra lateral.
  const reveal = p => {
    if (config().get('followInSidebar', false) || !config().get('revealInExplorer', true) || readText(p) === undefined) return
    void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p)).then(undefined, () => undefined)
  }

  const showStatus = () => {
    clearTimeout(statusTimer)
    if (active.size === 0) return
    const agents = new Set([...active.keys()].map(p => activeAgent.get(p) ?? 'Claude'))
    const [who] = agents
    const names = [...active.keys()].map(p => path.basename(p))
    status.text =
      agents.size > 1
        ? `$(sync~spin) ${agents.size} agentes editando ${names.length} arquivos`
        : names.length > 2
          ? `$(sync~spin) ${who} editando ${names.length} arquivos`
          : `$(sync~spin) ${who} editando ${names.join(', ')}`
    // Passando o mouse: cada arquivo em edição e quem está nele.
    status.tooltip = [...active.keys()].map(p => `${path.basename(p)} — ${activeAgent.get(p) ?? 'Claude'}`).join('\n')
    // Fundo de destaque enquanto há edição; volta ao normal quando termina.
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    status.show()
  }

  const startTicker = () => {
    if (ticker) return
    ticker = setInterval(() => {
      frame++
      if (active.size === 0) {
        clearInterval(ticker)
        ticker = undefined
        return
      }
      decorations.refresh([...active.keys()])
    }, FRAME_MS)
  }

  // Digitação ao vivo: o texto novo começa invisível e aparece da esquerda
  // pra direita, linha a linha, com um cursor verde na frente. A indentação
  // aparece de uma vez (digitar espaço não ensina nada). Uma edição nova no
  // meio (typingRun muda) termina esta na hora.
  const hidden = vscode.window.createTextEditorDecorationType({ opacity: '0' })
  const cursor = vscode.window.createTextEditorDecorationType({
    before: { contentText: '▍', color: `rgb(${GREEN})`, fontWeight: 'bold' },
  })
  context.subscriptions.push(hidden, cursor)
  let typingRun = 0

  const typewrite = async (editor, lines, run, maxMs = MAX_TYPING_MS) => {
    const doc = editor.document
    const rows = []
    for (const r of lines) {
      for (let l = r.start.line; l <= r.end.line; l++) {
        const text = doc.lineAt(l).text
        rows.push({ line: l, from: text.length - text.trimStart().length, to: text.length })
      }
    }
    const total = rows.reduce((sum, row) => sum + (row.to - row.from), 0)
    if (total === 0) return
    const speed = config().get('typingSpeed', 18)
    const duration = Math.min(maxMs, Math.max(Math.min(MIN_TYPING_MS, maxMs), total * speed))
    const perFrame = Math.max(1, Math.ceil(total / Math.max(1, Math.round(duration / TYPE_FRAME_MS))))
    let typed = 0
    let frames = 0
    try {
      while (typed < total && run === typingRun) {
        typed = Math.min(total, typed + perFrame)
        let left = typed
        let at
        const rest = []
        for (const row of rows) {
          const len = row.to - row.from
          if (at === undefined && left >= len) {
            left -= len
            continue
          }
          if (at === undefined) {
            at = new vscode.Position(row.line, row.from + left)
            rest.push(new vscode.Range(at, new vscode.Position(row.line, row.to)))
          } else if (len > 0) {
            rest.push(new vscode.Range(row.line, row.from, row.line, row.to))
          }
        }
        editor.setDecorations(hidden, rest)
        editor.setDecorations(cursor, at ? [new vscode.Range(at, at)] : [])
        // A câmera acompanha o cursor quando ele sai da tela, só na vertical:
        // ancorada no começo da linha, pra não arrastar a visão pro lado.
        if (at && frames++ % 6 === 0) {
          editor.revealRange(new vscode.Range(at.line, 0, at.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        }
        await sleep(TYPE_FRAME_MS)
      }
    } finally {
      editor.setDecorations(hidden, [])
      editor.setDecorations(cursor, [])
    }
  }

  // Brilho nas linhas mudadas, no editor do arquivo (o lado "depois" do diff),
  // depois da digitação.
  // `hurry`: há edições esperando na fila: digita mais rápido e não segura o
  // brilho; o apagar segue sozinho enquanto a próxima já começa.
  const glow = async (p, ranges, run, who, hurry) => {
    if (ranges.length === 0) return
    let editor
    for (let i = 0; i < 10 && !editor; i++) {
      editor = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file' && e.document.uri.fsPath === p)
      if (!editor) await sleep(100)
    }
    if (!editor) return
    const last = editor.document.lineCount - 1
    const lines = ranges
      .map(r => new vscode.Range(Math.min(r.start - 1, last), 0, Math.min(r.end - 1, last), 0))
      .filter(r => r.start.line >= 0)
    if (lines.length === 0) return
    editor.revealRange(lines[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    editor.setDecorations(fadeTypes[0], lines)
    if (config().get('typewriter', true)) await typewrite(editor, lines, run, hurry ? 900 : MAX_TYPING_MS)
    editor.setDecorations(label, lines.map(r => labelAt(r.start.line, `◀ ${who}`)))
    // Um brilho por vez: o de uma edição nova (run muda) apaga este na hora,
    // em vez de os dois alternarem a intensidade nas mesmas linhas.
    const fade = async () => {
      for (let i = 0; i < fadeTypes.length && run === typingRun; i++) {
        if (i > 0) editor.setDecorations(fadeTypes[i - 1], [])
        editor.setDecorations(fadeTypes[i], lines)
        if (i === Math.floor(fadeTypes.length / 2)) editor.setDecorations(label, [])
        await sleep(i === 0 ? GLOW_HOLD_MS : FADE_MS)
      }
      for (const type of fadeTypes) editor.setDecorations(type, [])
      editor.setDecorations(label, [])
    }
    void fade()
    await sleep(hurry ? 300 : GLOW_HOLD_MS)
  }

  // A tela mostra as edições em ordem, uma de cada vez, numa fila: nenhuma
  // é descartada. Com edições esperando, cada uma passa mais rápido.
  // Leitura só entra com a fila vazia e longe de uma edição recente.
  const queue = []
  let isRunning = false
  let editBusyUntil = 0
  const QUEUE_MAX = 12

  // Leitura: abre o trecho lido (aba de prévia, sem tirar o foco), pinta de
  // azul e põe "👁 <nome> lendo" na primeira linha por READ_HOLD_MS.
  let readRun = 0
  let readEditor
  const showRead = async ({ p, start, end, who }) => {
    if (!config().get('showReads', true) || readText(p) === undefined) return
    const run = ++readRun
    readEditor?.setDecorations(readLines, [])
    readEditor?.setDecorations(readLabel, [])
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p))
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
      readEditor = editor
      const last = doc.lineCount - 1
      const range = new vscode.Range(Math.min(start - 1, last), 0, Math.min(end - 1, last), 0)
      editor.revealRange(new vscode.Range(range.start, range.start), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
      editor.setDecorations(readLines, [range])
      editor.setDecorations(readLabel, [labelAt(range.start.line, `👁 ${who} lendo`)])
      await sleep(READ_HOLD_MS)
      if (run !== readRun) return
      editor.setDecorations(readLines, [])
      editor.setDecorations(readLabel, [])
    } catch {
      // Arquivo binário ou que sumiu: não mostra.
    }
  }

  const runFollow = async request => {
    if (request.read) {
      await showRead({ p: request.p, ...request.read })
      return
    }
    const { p, ranges, who } = request
    reveal(p)
    editBusyUntil = Date.now() + EDIT_BUSY_MS
    const run = ++typingRun
    try {
      if (config().get('openAs', 'diff') === 'diff') await openDiff(p)
      else if (config().get('openTabs', true)) await openFile(p)
    } catch {
      return
    }
    await glow(p, ranges, run, who, queue.some(next => !next.read))
  }
  const pump = async () => {
    if (isRunning) return
    isRunning = true
    while (queue.length > 0) await runFollow(queue.shift()).catch(() => undefined)
    isRunning = false
  }
  const follow = request => {
    if (request.read) {
      if (isRunning || queue.length > 0 || Date.now() < editBusyUntil) return
    } else if (queue.length >= QUEUE_MAX) {
      // Fila longa demais (muitos agentes): as mais antigas saem.
      queue.splice(0, queue.length - QUEUE_MAX + 1)
    }
    queue.push(request)
    void pump()
  }

  const onStart = ev => {
    active.set(ev.path, Date.now())
    activeAgent.set(ev.path, whoOf(ev))
    decorations.refresh([ev.path])
    tree.refresh()
    showStatus()
    showEditing()
    revealEditing(ev.path)
    startTicker()
    projectsView?.activity()
    reveal(ev.path)
  }

  const onEnd = ev => {
    // O "antes" do diff: arquivo novo é vazio; senão, desfaz os trechos no
    // texto atual. Só enquanto a janela não tem um "antes" do arquivo (as
    // edições seguintes somam no mesmo diff).
    if (ev.ok && !baselines.has(ev.path)) {
      const now = readText(ev.path)
      if (ev.created) baselines.set(ev.path, '')
      else if (Array.isArray(ev.hunks) && now !== undefined) baselines.set(ev.path, undoHunks(now, ev.hunks))
    }
    const since = active.get(ev.path) ?? Date.now()
    const linger = Math.max(400, MIN_ACTIVE_MS - (Date.now() - since))
    if (ev.ok) {
      const before = touched.get(ev.path)
      const added = typeof ev.adds === 'number' ? ev.adds : (ev.ranges || []).reduce((sum, r) => sum + (r.end - r.start + 1), 0)
      touched.set(ev.path, {
        edits: (before?.edits ?? 0) + 1,
        adds: (before?.adds ?? 0) + added,
        dels: (before?.dels ?? 0) + (typeof ev.dels === 'number' ? ev.dels : 0),
        at: Date.now(),
        isNew: before?.isNew ?? (baselines.get(ev.path) ?? '') === '',
        who: whoOf(ev),
      })
      saveTouched()
    }
    setTimeout(() => {
      // Outra edição do mesmo arquivo pode ter começado nesse meio-tempo.
      if ((active.get(ev.path) ?? 0) > since) return
      active.delete(ev.path)
      activeAgent.delete(ev.path)
      decorations.refresh([ev.path])
      tree.refresh()
      showEditing()
      projectsView?.activity()
      if (active.size > 0) {
        showStatus()
        return
      }
      // Barra de status com o tamanho da edição que acabou de acontecer.
      const size = typeof ev.adds === 'number' ? ` (+${ev.adds} −${ev.dels ?? 0})` : ''
      status.text = ev.ok ? `$(check) ${whoOf(ev)} editou ${path.basename(ev.path)}${size}` : '$(circle-slash) Edição cancelada'
      status.backgroundColor = undefined
      status.show()
      statusTimer = setTimeout(() => status.hide(), 5000)
    }, linger)
    if (!ev.ok) return
    indexFile(ev.path)
    // O VS Code recarrega o arquivo do disco logo depois da escrita.
    setTimeout(() => follow({ p: ev.path, ranges: ev.ranges || [], who: whoOf(ev) }), 120)
  }

  // Aviso curto na barra de status, quando nada está sendo editado.
  const flash = (text, ms) => {
    if (active.size > 0) return
    clearTimeout(statusTimer)
    status.text = text
    status.backgroundColor = undefined
    status.show()
    statusTimer = setTimeout(() => status.hide(), ms)
  }

  // Marca temporária no Explorer: some sozinha quando o prazo passa.
  const markFor = (map, file, value, ms) => {
    map.set(file, { ...value, until: Date.now() + ms })
    decorations.refresh([file])
    setTimeout(() => {
      if ((map.get(file)?.until ?? 0) > Date.now()) return
      map.delete(file)
      decorations.refresh([file])
    }, ms + 50)
  }

  const onHits = ev => {
    for (const hit of ev.files.slice(0, 30)) {
      if (typeof hit.file === 'string' && inWorkspace(hit.file)) markFor(foundNow, hit.file, { pattern: ev.pattern }, FOUND_HOLD_MS)
    }
    flash(`$(search) ${whoOf(ev)} achou “${ev.pattern.length > 30 ? `${ev.pattern.slice(0, 30)}…` : ev.pattern}” em ${ev.files.length} arquivo${ev.files.length === 1 ? '' : 's'}`, 4000)
  }

  const onRead = ev => {
    markFor(readingNow, ev.path, { who: whoOf(ev) }, READ_HOLD_MS)
    flash(`$(eye) ${whoOf(ev)} lendo ${path.basename(ev.path)}`, READ_HOLD_MS)
    follow({ p: ev.path, read: { start: ev.start, end: ev.end, who: whoOf(ev) } })
  }

  // ---------- problemas do typecheck, lint e testes que ele rodou ----------
  // Cada ferramenta (tsc, eslint, testes) tem a sua lista; uma rodada nova da
  // mesma ferramenta troca a lista inteira (vazia: tudo limpo). Viram
  // marcações no editor e no painel Problems, e a mensagem vai escrita na
  // própria linha (como o Error Lens, que fica desligado em modo restrito).
  const problems = vscode.languages.createDiagnosticCollection('claude')
  const lineError = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(241, 76, 76, 0.07)',
    after: { color: '#f14c4c', margin: '0 0 0 2em', fontStyle: 'italic' },
  })
  const lineWarning = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(226, 192, 141, 0.06)',
    after: { color: '#e2c08d', margin: '0 0 0 2em', fontStyle: 'italic' },
  })
  context.subscriptions.push(problems, lineError, lineWarning)
  /** ferramenta -> (arquivo -> problemas) */
  const bySource = new Map()

  const paintProblems = editor => {
    const file = editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined
    const list = file ? problems.get(vscode.Uri.file(file)) ?? [] : []
    const byLine = new Map()
    // Uma mensagem por linha: a primeira (erro antes de aviso).
    for (const d of [...list].sort((a, b) => a.severity - b.severity)) {
      if (!byLine.has(d.range.start.line)) byLine.set(d.range.start.line, d)
    }
    const at = (d, mark) => labelAt(d.range.start.line, `${mark} ${d.message}${d.source ? `  (${d.source})` : ''}`)
    const shown = [...byLine.values()]
    editor.setDecorations(lineError, shown.filter(d => d.severity === vscode.DiagnosticSeverity.Error).map(d => at(d, '✗')))
    editor.setDecorations(lineWarning, shown.filter(d => d.severity !== vscode.DiagnosticSeverity.Error).map(d => at(d, '⚠')))
  }
  const paintAll = () => vscode.window.visibleTextEditors.forEach(paintProblems)
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(paintAll),
    vscode.languages.onDidChangeDiagnostics(paintAll),
  )

  const onDiagnostics = ev => {
    const files = new Map()
    for (const item of ev.items) {
      if (typeof item.file !== 'string' || !inWorkspace(item.file)) continue
      const line = Math.max(0, (item.line ?? 1) - 1)
      const col = Math.max(0, (item.col ?? 1) - 1)
      const d = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col + 9999),
        String(item.message ?? ''),
        item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
      )
      d.source = ev.source
      if (item.code) d.code = item.code
      if (!files.has(item.file)) files.set(item.file, [])
      files.get(item.file).push(d)
    }
    bySource.set(ev.source, files)
    // Junta as ferramentas: um arquivo pode ter erro de tsc e de eslint.
    const all = new Map()
    for (const perFile of bySource.values()) {
      for (const [file, list] of perFile) all.set(file, [...(all.get(file) ?? []), ...list])
    }
    problems.clear()
    for (const [file, list] of all) problems.set(vscode.Uri.file(file), list)
    paintAll()
    const count = [...files.values()].reduce((sum, list) => sum + list.length, 0)
    flash(
      count === 0
        ? `$(check) ${ev.source}: sem problemas`
        : `$(error) ${ev.source}: ${count} problema${count === 1 ? '' : 's'} em ${files.size} arquivo${files.size === 1 ? '' : 's'}`,
      6000,
    )
  }

  const onSearch = ev => {
    const pattern = ev.pattern.length > 40 ? `${ev.pattern.slice(0, 40)}…` : ev.pattern
    flash(`$(search) ${whoOf(ev)} buscando “${pattern}”`, 3000)
  }

  // ---------- "Perguntar ao Claude" ----------
  // O trecho selecionado (caminho, linhas e código), com a pergunta, vai pra
  // caixa de entrada desta sessão; o mod põe na caixa de digitação do Claude
  // Code e a pessoa aperta Enter lá. Nada é enviado sozinho.
  let lastName = 'Claude'
  const sendToClaude = text => {
    const session = sessionOf()
    if (!session) {
      void vscode.window.showWarningMessage('Esta janela não é de uma sessão: abra pelo /vscode do Claude Code.')
      return false
    }
    const file = path.join(INBOX, `${session}.json`)
    let requests = []
    try {
      requests = JSON.parse(fs.readFileSync(file, 'utf8')).requests || []
    } catch {
      // Sem arquivo ainda.
    }
    requests = [...requests, { seq: Date.now() * 1000 + Math.floor(Math.random() * 1000), text }].slice(-20)
    fs.mkdirSync(INBOX, { recursive: true })
    // Grava inteiro e troca de nome: o mod nunca lê pela metade.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ requests }))
    fs.renameSync(`${file}.tmp`, file)
    return true
  }
  const MAX_SNIPPET = 8000
  const snippetOf = editor => {
    const doc = editor.document
    const range = editor.selection.isEmpty ? doc.lineAt(editor.selection.active.line).range : editor.selection
    const code = doc.getText(range)
    const cut = code.length > MAX_SNIPPET ? `${code.slice(0, MAX_SNIPPET)}\n… (cortado)` : code
    return `${doc.uri.fsPath}:${range.start.line + 1}-${range.end.line + 1}\n\`\`\`${doc.languageId}\n${cut}\n\`\`\``
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeLive.ask', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const question = await vscode.window.showInputBox({
        title: `Perguntar ao ${lastName}`,
        prompt: 'Sobre o trecho selecionado. Vai pra caixa de digitação do Claude Code: confira e aperte Enter lá.',
        placeHolder: 'ex.: por que isso existe? / simplifica isso',
        // Fecha ao clicar fora: o Esc não chega até a página (o Claude Code
        // fica com ele pra devolver o foco à conversa).
        ignoreFocusOut: false,
      })
      if (question === undefined) return
      const ref = snippetOf(editor)
      const asked = question.trim()
      if (sendToClaude(asked ? `${asked}\n\n${ref}` : ref)) {
        flash(`$(comment) Na caixa do ${lastName}: aperte Enter lá`, 4000)
      }
    }),
    vscode.commands.registerCommand('claudeLive.sendSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (editor && sendToClaude(snippetOf(editor))) flash(`$(comment) Trecho na caixa do ${lastName}`, 3000)
    }),
  )

  // Cada janela só reage ao que cai dentro das pastas que ela abriu: o VS Code
  // do elo-cli não anima as edições de uma sessão em outro projeto.
  const inWorkspace = p =>
    (vscode.workspace.workspaceFolders || []).some(folder => {
      const root = folder.uri.fsPath
      return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    })

  // Janela aberta pelo /vscode: o workspace traz o id da sessão, e só as
  // edições dela (e dos subagentes dela) contam. Sem id, vale qualquer sessão.
  const isMine = ev => {
    const mine = sessionOf()
    return mine === '' || ev.session === mine
  }

  // Lê os arquivos da ponte que mudaram desde a última volta. Cada arquivo
  // guarda o maior seq já lido: um arquivo de outra sessão não esconde os
  // eventos deste. Um arquivo que não deu pra ler fica pra próxima volta.
  const poll = (isFirst = false) => {
    for (const file of bridgeFiles(sessionOf())) {
      const mtimeMs = mtimeOf(file)
      const known = seen.get(file)
      if (mtimeMs === undefined || mtimeMs === known?.mtimeMs) continue
      const events = readBridge(file)
      if (events === undefined) continue
      let lastSeq = known?.lastSeq ?? 0
      for (const ev of events) {
        if (typeof ev.seq !== 'number' || ev.seq <= lastSeq) continue
        lastSeq = ev.seq
        // Na primeira volta só marca até onde já foi: não repete o que
        // aconteceu antes de a janela abrir.
        if (isFirst || !isMine(ev)) continue
        if (typeof ev.name === 'string') lastName = ev.name
        // Busca não tem arquivo: vale pra janela da sessão toda.
        if (ev.type === 'search' && typeof ev.pattern === 'string') onSearch(ev)
        else if (ev.type === 'diagnostics' && Array.isArray(ev.items)) onDiagnostics(ev)
        else if (ev.type === 'hits' && Array.isArray(ev.files) && typeof ev.pattern === 'string') onHits(ev)
        else if (typeof ev.path !== 'string' || !inWorkspace(ev.path)) continue
        else if (ev.type === 'start') onStart(ev)
        else if (ev.type === 'end') onEnd(ev)
        else if (ev.type === 'read' && typeof ev.start === 'number') onRead(ev)
      }
      seen.set(file, { mtimeMs, lastSeq })
    }
  }

  // A primeira volta só marca até onde a ponte já foi (nada de reprisar o que
  // aconteceu antes da janela abrir); depois, uma volta a cada POLL_MS.
  fs.mkdirSync(BRIDGES, { recursive: true })
  poll(true)
  poller = setInterval(() => poll(), POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(poller) })
}

function deactivate() {
  if (ticker) clearInterval(ticker)
}

module.exports = { activate, deactivate }
