// Aba "Pastas": árvore nativa de pastas, como o Explorer. A raiz é a pasta
// onde a sessão do Claude começou (ou claudeLive.projectsRoot) e aparece como
// primeiro item, aberta. As pastas usam os ícones do tema, abrem e fecham pela
// setinha, mostram a branch quando são repositório, e os botões ao passar o
// mouse abrem a pasta no VS Code ou ao lado. No topo: voltar pra pasta da
// sessão (e abrir ela) e subir um nível. Pasta com edição do Claude em
// andamento pisca (a decoração vem do mesmo provedor das abas).
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', '__pycache__', '.venv'])
const ROOT_KEY = 'claudeLive.foldersRoot'

function branchOf(dir) {
  try {
    let gitDir = path.join(dir, '.git')
    if (!fs.statSync(gitDir).isDirectory()) {
      // Worktree: .git é um arquivo "gitdir: <caminho>".
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m)
      if (!pointer) return undefined
      gitDir = path.resolve(dir, pointer[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7)
  } catch {
    return undefined
  }
}

function foldersIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map(d => path.join(dir, d.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' }))
  } catch {
    return []
  }
}

class FolderTree {
  constructor(root) {
    this.root = root
    this.emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.emitter.event
  }

  refresh() {
    this.emitter.fire(undefined)
  }

  getChildren(dir) {
    return dir === undefined ? [this.root] : foldersIn(dir)
  }

  getParent(dir) {
    return dir === this.root ? undefined : path.dirname(dir)
  }

  getTreeItem(dir) {
    const isRoot = dir === this.root
    const hasFolders = foldersIn(dir).length > 0
    const item = new vscode.TreeItem(
      vscode.Uri.file(dir),
      isRoot
        ? vscode.TreeItemCollapsibleState.Expanded
        : hasFolders
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
    )
    const branch = branchOf(dir)
    const open = (vscode.workspace.workspaceFolders || []).some(f => f.uri.fsPath === dir)
    item.description = [branch, open ? 'aberta' : undefined].filter(Boolean).join(' · ') || undefined
    item.tooltip = branch ? `${dir}\nbranch ${branch}` : dir
    item.id = dir
    item.contextValue = 'claudeLive.folder'
    // Pasta sem subpastas: clicar já abre no VS Code.
    if (!isRoot && !hasFolders) item.command = { command: 'claudeLive.openFolder', title: 'Abrir', arguments: [dir] }
    return item
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ projectsRoot: () => string, sessionFolder: () => string,
 *   switchTo: (dir: string, beside: boolean) => Promise<void> }} deps
 */
function createProjectsView(context, deps) {
  const saved = context.workspaceState.get(ROOT_KEY)
  const tree = new FolderTree(saved && fs.existsSync(saved) ? saved : deps.projectsRoot())
  const setRoot = dir => {
    tree.root = dir
    void context.workspaceState.update(ROOT_KEY, dir)
    tree.refresh()
  }
  const dirOf = arg => (typeof arg === 'string' ? arg : arg?.fsPath ?? arg?.resourceUri?.fsPath)
  context.subscriptions.push(
    vscode.window.createTreeView('claudeLive.projects', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.commands.registerCommand('claudeLive.openFolder', arg => {
      const dir = dirOf(arg)
      if (dir) void deps.switchTo(dir, false)
    }),
    vscode.commands.registerCommand('claudeLive.openFolderBeside', arg => {
      const dir = dirOf(arg)
      if (dir) void deps.switchTo(dir, true)
    }),
    vscode.commands.registerCommand('claudeLive.foldersHome', () => {
      const home = deps.sessionFolder()
      setRoot(home)
      void deps.switchTo(home, false)
    }),
    vscode.commands.registerCommand('claudeLive.foldersUp', () => {
      const parent = path.dirname(tree.root)
      if (parent !== tree.root) setRoot(parent)
    }),
    vscode.commands.registerCommand('claudeLive.refreshFolders', () => tree.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
  )
  return { refresh: () => tree.refresh(), activity: () => undefined }
}

module.exports = { createProjectsView }
