// Mapa de impacto: quem importa cada arquivo (TS/JS). O índice é montado por
// projeto (a pasta com package.json ou tsconfig.json mais próxima), só quando
// um arquivo dele é editado, em segundo plano, e acompanha as mudanças dos
// arquivos. Lê import/export…from/require/import(); entende caminhos
// relativos, os aliases do tsconfig (paths/baseUrl) e o `.js` que aponta pra
// `.ts`. Nada passa por modelo.
const fs = require('fs')
const path = require('path')

// .vue e .svelte entram também: os imports ficam no <script> e a mesma
// leitura por regex acha eles no arquivo inteiro.
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.git', '.next', '.nuxt', '.turbo', '.cache', '.svelte-kit'])
// Teto de arquivos lidos por projeto: monorepo gigante fica com índice parcial.
const MAX_FILES = 15000
// A cada tantos arquivos lidos, devolve a vez pro VS Code: o índice monta em
// segundo plano sem travar o editor.
const YIELD_EVERY = 300
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const isCode = file => EXTS.includes(path.extname(file))
const pause = () => new Promise(resolve => setImmediate(resolve))

function projectRoot(file) {
  let dir = path.dirname(file)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'tsconfig.json'))) return dir
    dir = path.dirname(dir)
  }
  return undefined
}

// tsconfig com comentários e vírgula sobrando: limpa o bastante pro JSON.
function readAliases(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')
    const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
    const options = JSON.parse(clean).compilerOptions || {}
    const base = path.resolve(root, options.baseUrl || '.')
    return Object.entries(options.paths || {}).map(([pattern, targets]) => ({
      prefix: pattern.replace(/\*$/, ''),
      isWild: pattern.endsWith('*'),
      targets: targets.map(t => path.resolve(base, t.replace(/\*$/, ''))),
    }))
  } catch {
    return []
  }
}

function resolveFile(base) {
  const candidates = [base, ...EXTS.map(e => base + e), ...EXTS.map(e => path.join(base, `index${e}`))]
  // `./x.js` escrito num projeto TS aponta pro `x.ts`.
  if (/\.[mc]?js$/.test(base)) candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map(e => base.replace(/\.[mc]?js$/, e)))
  return candidates.find(c => isCode(c) && fs.existsSync(c) && fs.statSync(c).isFile())
}

function resolveSpecifier(spec, from, aliases) {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(from), spec))
  for (const alias of aliases) {
    if (alias.isWild ? spec.startsWith(alias.prefix) : spec === alias.prefix) {
      for (const target of alias.targets) {
        const found = resolveFile(alias.isWild ? path.join(target, spec.slice(alias.prefix.length)) : target)
        if (found) return found
      }
    }
  }
  return undefined
}

async function listCode(root) {
  const out = []
  const queue = [root]
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift()
    let entries = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) queue.push(path.join(dir, entry.name))
      } else if (isCode(entry.name)) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  return out
}

class ImpactIndex {
  /** @param {() => void} onChange avisado quando um projeto fica pronto ou muda */
  constructor(onChange) {
    this.onChange = onChange
    /** raiz -> { aliases, imports: Map<arquivo, Set>, dependents: Map<arquivo, Set>, ready } */
    this.projects = new Map()
  }

  projectOf(file) {
    return [...this.projects.entries()]
      .filter(([root]) => file.startsWith(root + path.sep))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1]
  }

  parse(project, file) {
    for (const target of project.imports.get(file) ?? []) project.dependents.get(target)?.delete(file)
    const targets = new Set()
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      project.imports.delete(file)
      return
    }
    for (const pattern of SPECIFIERS) {
      for (const m of text.matchAll(pattern)) {
        const target = resolveSpecifier(m[1], file, project.aliases)
        if (target && target !== file) targets.add(target)
      }
    }
    project.imports.set(file, targets)
    for (const target of targets) {
      if (!project.dependents.has(target)) project.dependents.set(target, new Set())
      project.dependents.get(target).add(file)
    }
  }

  // Monta o índice do projeto do arquivo, se ainda não existe.
  async ensure(file) {
    if (!isCode(file)) return
    const root = projectRoot(file)
    if (!root || this.projects.has(root)) return
    const project = { aliases: readAliases(root), imports: new Map(), dependents: new Map(), ready: false }
    this.projects.set(root, project)
    const files = await listCode(root)
    for (const [i, each] of files.entries()) {
      this.parse(project, each)
      if (i % YIELD_EVERY === 0) await pause()
    }
    project.ready = true
    this.onChange()
  }

  // Um arquivo mudou no disco: relê os imports dele.
  update(file) {
    const project = this.projectOf(file)
    if (!project?.ready || !isCode(file)) return
    this.parse(project, file)
    this.onChange()
  }

  remove(file) {
    const project = this.projectOf(file)
    if (!project) return
    for (const target of project.imports.get(file) ?? []) project.dependents.get(target)?.delete(file)
    project.imports.delete(file)
    this.onChange()
  }

  /** Quem importa o arquivo diretamente. */
  dependents(file) {
    return [...(this.projectOf(file)?.dependents.get(file) ?? [])].sort()
  }
}

module.exports = { ImpactIndex }
