// Rede e erros da página do painel, pro card do plugin navegador. Roda dentro
// da própria página (bin/tb-net), então só enxerga a aba do painel: o log do
// agent-browser junta as abas de todos os navegadores do mesmo processo do
// terminal-browser, e com duas sessões abertas o card mostrava a rede da outra.
//
// Na primeira chamada instala um observador de Resource Timing e a captura de
// erros; as seguintes só leem. Com `tb-net clear`, zera tudo.
(() => {
  const KEEP = 40
  const w = window
  if (!w.__tbNet) {
    const net = { req: [], errors: [] }
    w.__tbNet = net
    const TYPE = {
      fetch: 'Fetch', xmlhttprequest: 'XHR', beacon: 'Fetch', script: 'Script', img: 'Image', image: 'Image',
      css: 'Stylesheet', link: 'Stylesheet', font: 'Font', video: 'Media', audio: 'Media', iframe: 'Document',
      navigation: 'Document', other: 'Other',
    }
    const add = (entry, type) => {
      if (/^(data|blob|chrome|devtools|about):/.test(entry.name)) return
      const status = typeof entry.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null
      net.req.push({ m: '', u: entry.name, s: status, t: type ?? TYPE[entry.initiatorType] ?? 'Other' })
      if (net.req.length > KEEP) net.req.splice(0, net.req.length - KEEP)
    }
    for (const nav of performance.getEntriesByType('navigation')) add(nav, 'Document')
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) add(entry) })
        .observe({ type: 'resource', buffered: true })
    } catch {
      for (const entry of performance.getEntriesByType('resource')) add(entry)
    }
    const push = text => {
      net.errors.push({ type: 'error', text: String(text).replace(/\s+/g, ' ').slice(0, 200) })
      if (net.errors.length > KEEP) net.errors.shift()
    }
    const original = console.error.bind(console)
    console.error = (...args) => {
      try { push(args.map(a => (a && a.message) || a).join(' ')) } catch {}
      original(...args)
    }
    addEventListener('error', e => push(e.message || `falha ao carregar ${(e.target && (e.target.src || e.target.href)) || 'recurso'}`), true)
    addEventListener('unhandledrejection', e => push(`promise: ${(e.reason && e.reason.message) || e.reason}`))
  }
  const net = w.__tbNet
  if ($CLEAR) {
    net.req = []
    net.errors = []
  }
  return { requests: net.req.slice(-KEEP), console: net.errors.slice(-KEEP) }
})()
