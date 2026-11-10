// tb-look: um pedaço enxuto da página do painel pra explorar antes de
// escrever o roteiro do tb-run. Em vez do snapshot inteiro, devolve a árvore
// de acessibilidade de um trecho (o formulário, o modal), filtrada pro que
// dá pra clicar/digitar mais títulos e regiões, já no formato que vira
// localizador do Playwright (getByRole('button', { name: '…' })).
//
// Uso: tb-look [escopo] [--secao "Título"] [--tudo] [--linhas N] [--browser <chave>]
//   escopo: seletor do Playwright (padrão body): 'form', '#checkout',
//           'role=dialog', 'text=Pagamento >> xpath=..'
//   --secao: a seção de um título (section/form/dialog… mais próximo dele)
//   --tudo: sem filtro (inclui textos e /url)

import { ariaLines, clip, compactAria, connect, sectionOf, shortError } from './lib.mjs'

function parseArgs(argv) {
  const opts = { scope: 'body', section: null, all: false, max: 80, browser: process.env.TB_KEY || null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tudo' || a === '--all') opts.all = true
    else if (a === '--linhas' || a === '--lines') opts.max = Number(argv[++i])
    else if (a === '--browser') opts.browser = argv[++i]
    else if (a === '--secao' || a === '--section') opts.section = argv[++i]
    else if (a === '-h' || a === '--help') opts.help = true
    else opts.scope = a
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log("uso: tb-look [escopo] [--secao \"Título\"] [--tudo] [--linhas N] [--browser <chave>]\n  escopo: seletor do Playwright, padrão body (ex.: form, 'role=dialog', '#checkout')\n  --secao: a seção de um título, ex.: --secao \"Teste rápido\"")
    process.exit(0)
  }
  const { page } = await connect(opts.browser)
  const out = [`${clip(await page.title().catch(() => ''), 80)} · ${page.url()}`]
  let scope = opts.scope
  if (opts.section) {
    scope = await sectionOf(page, opts.section)
    if (!scope) {
      out.push(`✗ nenhum título “${opts.section}” nesta página`)
      console.log(out.join('\n'))
      process.exit(1)
    }
  }
  const label = opts.section ? `seção “${opts.section}”` : `escopo ${opts.scope}`
  const { count, lines } = await ariaLines(page, scope)
  if (count === 0) {
    out.push(`✗ escopo “${opts.scope}” não bate em nada nesta página`)
    console.log(out.join('\n'))
    process.exit(1)
  }
  const shown = opts.all ? lines : compactAria(lines.filter(l => !/^\s*- \/url:/.test(l)))
  const rows = shown.slice(0, opts.max)
  out.push(`${label}${count > 1 ? ` (bate em ${count}; mostrando o 1º)` : ''} · ${rows.length} de ${shown.length} linhas${opts.all ? '' : ` (filtradas de ${lines.length}; --tudo mostra textos)`}`)
  for (const r of rows) out.push(clip(r, 160))
  if (shown.length > rows.length) out.push(`… +${shown.length - rows.length} linhas: use um escopo menor ou --linhas`)
  console.log(out.join('\n'))
  process.exit(0)
}

main().catch(err => {
  console.log(`✗ tb-look: ${shortError(err)}`)
  process.exit(2)
})
