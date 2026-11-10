// Gravador do tb-record, injetado na página. Escuta cliques, preenchimentos,
// seleções e Enter, descreve o alvo como localizador do Playwright (papel e
// nome acessível antes de CSS) e manda cada ação pro tb-record pela binding
// window.__tbRec. Mostra um selo "gravando" com o botão de parar, num shadow
// root fechado (não vira ação nem texto da página).
(() => {
  if (window.__tbRecOn) return
  window.__tbRecOn = true
  const send = ev => { try { window.__tbRec(ev) } catch {} }

  // --- selo de gravação ---
  const host = document.createElement('div')
  host.id = '__ag_rec'
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', top: '14px', right: '14px', zIndex: 2147483647 })
  const ui = host.attachShadow({ mode: 'closed' })
  ui.innerHTML = `<style>
    .b{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border-radius:12px;background:rgba(12,10,20,.9);
       border:1px solid rgba(239,68,68,.5);color:#f4f4f5;font:600 13px ui-sans-serif,-apple-system,system-ui;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .d{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1.2s infinite}
    @keyframes p{50%{opacity:.35}}
    button{font:inherit;font-size:12px;color:#fff;background:#ef4444;border:0;border-radius:8px;padding:4px 10px;cursor:pointer}
  </style><div class="b"><span class="d"></span><span class="t">gravando · <span class="n">${Number(window.__tbRecCount) || 0}</span></span><button>parar</button></div>`
  ui.querySelector('button').addEventListener('click', e => { e.stopPropagation(); send({ type: 'stop' }) })
  const mount = () => (document.body || document.documentElement).appendChild(host)
  document.body ? mount() : document.addEventListener('DOMContentLoaded', mount)
  window.__tbRecCounted = n => { window.__tbRecCount = n; const el = ui.querySelector('.n'); if (el) el.textContent = String(n) }

  // --- nome acessível e papel (aproximação boa o bastante pra gerar localizador) ---
  const txt = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return txt(el.getAttribute('aria-label'))
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' ')
      if (txt(t)) return txt(t)
    }
    if (el.labels && el.labels[0]) return txt(el.labels[0].innerText)
    return ''
  }
  const roleOf = el => {
    const r = el.getAttribute('role')
    if (r) return r
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type))) return 'button'
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'search') return 'searchbox'
      if (['', 'text', 'email', 'tel', 'url', 'password', 'number'].includes(type)) return type === 'number' ? 'spinbutton' : 'textbox'
    }
    if (tag === 'summary') return 'button'
    return null
  }
  const nameOf = el => {
    const l = labelOf(el)
    if (l) return l
    const role = roleOf(el)
    if (['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio'].includes(role)) {
      const t = txt(el.innerText || el.value || el.getAttribute('title') || el.querySelector?.('img')?.alt)
      if (t) return t
    }
    return txt(el.getAttribute('title') || el.getAttribute('alt') || '')
  }
  const cssPath = el => {
    if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(el.id)) return `#${CSS.escape(el.id)}`
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let p = n.tagName.toLowerCase()
      const cls = [...n.classList].filter(c => !/^(css-|sc-|_)|\d{3,}/.test(c)).slice(0, 2)
      if (cls.length) p += '.' + cls.map(c => CSS.escape(c)).join('.')
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : []
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`
      parts.unshift(p)
      if (n.id) break
    }
    return parts.join(' > ')
  }
  // Descrição do alvo, na ordem de preferência do Playwright.
  const describe = el => {
    const testid = el.closest('[data-testid]')?.getAttribute('data-testid')
    const role = roleOf(el)
    const name = nameOf(el)
    const isField = ['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox'].includes(role)
    if (isField && labelOf(el)) return { by: 'label', value: labelOf(el) }
    if (isField && el.placeholder) return { by: 'placeholder', value: txt(el.placeholder) }
    if (role && name) return { by: 'role', role, name }
    if (testid) return { by: 'testid', value: testid }
    const t = txt(el.innerText)
    if (t && t.length <= 60) return { by: 'text', value: t }
    return { by: 'css', value: cssPath(el) }
  }
  // O controle de verdade sob o clique (o texto dentro do botão vira o botão).
  const CONTROL = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[onclick],[tabindex]'
  const mine = e => e.composedPath().includes(host)

  document.addEventListener('click', e => {
    if (!e.isTrusted || mine(e)) return
    let el = e.target.closest(CONTROL) || e.target
    // Clique no label vira clique no campo dele; campo de texto não grava clique (o fill grava).
    if (el.tagName === 'LABEL' && el.control) el = el.control
    const role = roleOf(el)
    if (['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox'].includes(role)) return
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return
    send({ type: 'click', target: describe(el), url: location.href })
  }, true)

  document.addEventListener('change', e => {
    if (!e.isTrusted || mine(e)) return
    const el = e.target
    if (el.tagName === 'SELECT') {
      send({ type: 'select', target: describe(el), value: el.multiple ? [...el.selectedOptions].map(o => o.value) : el.value, label: el.selectedOptions[0]?.label })
    } else if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color'].includes(el.type))) {
      send({ type: 'fill', target: describe(el), value: el.value, secret: el.type === 'password' })
    }
  }, true)

  document.addEventListener('keydown', e => {
    if (!e.isTrusted || mine(e) || e.key !== 'Enter') return
    const el = e.target
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // O valor ainda não passou pelo change: manda antes do Enter.
      send({ type: 'fill', target: describe(el), value: el.value, secret: el.type === 'password' })
      send({ type: 'press', key: 'Enter' })
    }
  }, true)
})()
