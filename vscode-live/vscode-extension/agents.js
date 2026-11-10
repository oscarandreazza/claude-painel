// Seção "Agentes" da aba Claude: os agentes do Elo conectados (estado, pasta),
// o que cada um mexeu por último (pela ponte da sessão dele, quando ela abriu
// o /vscode) e os pedidos em aberto entre eles. Avisa quando outro agente
// mexe num arquivo que esta sessão também mexeu. Sem o `elo` instalado, a
// seção nem aparece (contexto claudeLive.hasElo).
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

// Os agentes do Elo são consultados a cada 5 s, e só com a seção Agentes visível.
const POLL_MS = 5000
const RECENT_FILES = 5
const RECENT_MS = 30 * 60 * 1000
const OPEN_STATES = new Set(['pendente', 'aceito', 'em_andamento', 'bloqueado'])
const STATE_ICON = { pendente: 'circle-outline', aceito: 'pass', em_andamento: 'sync~spin', bloqueado: 'error' }
const BRIDGES = path.join(os.homedir(), '.claude', 'claude-live', 'bridge')

const short = dir => (dir && dir.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir || '')
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function eloStatus() {
  return new Promise(resolve => {
    execFile('elo', ['status', '--all', '--json'], { timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(undefined)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(undefined)
      }
    })
  })
}

// O que a sessão do agente mexeu por último, pela ponte dela (só existe se
// ela abriu o /vscode): os arquivos dos eventos de fim de edição.
function recentEdits(sessionId) {
  try {
    const events = JSON.parse(fs.readFileSync(path.join(BRIDGES, `${sessionId}.json`), 'utf8')).events || []
    const files = []
    for (const ev of [...events].reverse()) {
      if (ev.type !== 'end' || !ev.ok || typeof ev.path !== 'string') continue
      if (ev.at && Date.now() - ev.at > RECENT_MS) continue
      if (!files.some(f => f.path === ev.path)) files.push({ path: ev.path, at: ev.at })
      if (files.length >= RECENT_FILES) break
    }
    return files
  } catch {
    return []
  }
}

class AgentsTree {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
    this.status = undefined
    this.me = ''
  }

  refresh() {
    this.emitter.fire(undefined)
  }

  agents() {
    return (this.status?.agents ?? []).slice().sort((a, b) => (a.native_id === this.me ? -1 : b.native_id === this.me ? 1 : a.name.localeCompare(b.name)))
  }

  tasksOf(agent) {
    const name = agent.name.replace(/^@/, '')
    return (this.status?.tasks ?? []).filter(
      task =>
        OPEN_STATES.has(task.state) &&
        task.connected !== false &&
        [task.sender_name, task.recipient_name].some(n => (n || '').replace(/^@/, '') === name),
    )
  }

  getChildren(node) {
    if (!node) return this.agents().map(agent => ({ kind: 'agent', agent }))
    if (node.kind !== 'agent') return []
    const edits = recentEdits(node.agent.native_id).map(edit => ({ kind: 'file', edit }))
    const tasks = this.tasksOf(node.agent).map(task => ({ kind: 'task', task, agent: node.agent }))
    return [...edits, ...tasks]
  }

  getTreeItem(node) {
    if (node.kind === 'agent') {
      const { agent } = node
      const busy = agent.status === 'busy'
      const isMe = agent.native_id === this.me
      const hasChildren = recentEdits(agent.native_id).length > 0 || this.tasksOf(agent).length > 0
      const item = new vscode.TreeItem(`@${agent.name.replace(/^@/, '')}`, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
      item.id = `agent:${agent.sid}`
      item.description = [isMe ? 'esta sessão' : undefined, busy ? 'trabalhando' : agent.status, short(agent.cwd)].filter(Boolean).join(' · ')
      item.iconPath = new vscode.ThemeIcon(busy ? 'sync~spin' : 'account', new vscode.ThemeColor(busy ? 'charts.yellow' : 'charts.green'))
      item.tooltip = new vscode.MarkdownString(
        [`**@${agent.name.replace(/^@/, '')}** (${agent.provider})`, short(agent.cwd), agent.prompt ? `> ${clip(agent.prompt, 300)}` : ''].filter(Boolean).join('\n\n'),
      )
      return item
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(vscode.Uri.file(node.edit.path), vscode.TreeItemCollapsibleState.None)
      item.description = node.edit.at ? new Date(node.edit.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : undefined
      item.command = { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.file(node.edit.path)] }
      return item
    }
    const { task, agent } = node
    const name = agent.name.replace(/^@/, '')
    const sent = (task.sender_name || '').replace(/^@/, '') === name
    const other = (sent ? task.recipient_name : task.sender_name || '').replace(/^@/, '')
    const item = new vscode.TreeItem(`${sent ? '→' : '←'} @${other}: ${clip((task.text || '').replace(/\s+/g, ' '), 60)}`, vscode.TreeItemCollapsibleState.None)
    item.id = `task:${agent.sid}:${task.message_id}`
    item.description = task.state.replace('_', ' ')
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[task.state] || 'circle-outline')
    item.tooltip = new vscode.MarkdownString(
      [`**#${task.message_id}** · ${task.state.replace('_', ' ')}`, clip(task.text || '', 800), task.note ? `_Nota:_ ${clip(task.note, 400)}` : ''].filter(Boolean).join('\n\n'),
    )
    return item
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ session: () => string, touched: () => string[] }} deps
 */
function createAgentsView(context, deps) {
  const tree = new AgentsTree()
  const view = vscode.window.createTreeView('claudeLive.agents', { treeDataProvider: tree })
  const warned = new Set()
  let timer

  // Outro agente mexeu num arquivo que esta sessão também mexeu: avisa uma vez
  // por agente e arquivo.
  const checkConflicts = () => {
    const mine = new Set(deps.touched())
    if (mine.size === 0) return
    for (const agent of tree.agents()) {
      if (agent.native_id === tree.me) continue
      for (const edit of recentEdits(agent.native_id)) {
        const key = `${agent.native_id}:${edit.path}`
        if (!mine.has(edit.path) || warned.has(key)) continue
        warned.add(key)
        void vscode.window.showWarningMessage(`⚠ @${agent.name.replace(/^@/, '')} também mexeu em ${path.basename(edit.path)}, que esta sessão editou.`)
      }
    }
  }

  const poll = async () => {
    const status = await eloStatus()
    void vscode.commands.executeCommand('setContext', 'claudeLive.hasElo', status !== undefined)
    if (!status) return
    tree.status = status
    tree.me = deps.session()
    const connected = tree.agents().length
    view.description = connected > 0 ? `${connected} conectado${connected === 1 ? '' : 's'}` : undefined
    tree.refresh()
    checkConflicts()
  }

  const schedule = () => {
    clearInterval(timer)
    timer = view.visible ? setInterval(() => void poll(), POLL_MS) : undefined
  }

  context.subscriptions.push(
    view,
    view.onDidChangeVisibility(() => {
      if (view.visible) void poll()
      schedule()
    }),
    vscode.commands.registerCommand('claudeLive.refreshAgents', () => void poll()),
    { dispose: () => clearInterval(timer) },
  )
  void poll()
  schedule()
  return { refresh: () => void poll() }
}

module.exports = { createAgentsView }
