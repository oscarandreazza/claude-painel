export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^\d+\.\d+\.\d+\.\d+/.test(text)) return `http://${text}`
  return `https://${text}`
}

// Página de trabalho (um editor aberto no painel, não um teste): sem card de
// status, sem legenda na página, e o navegador ocupa o painel inteiro.
// Reconhecida pelo título E por estar na própria máquina (o vscode-live abre o
// editor em 127.0.0.1): só pelo título, qualquer site com "… Visual Studio
// Code" no título esconderia o card e a barra de endereço.
const WORKSPACE_TITLE = /(Visual Studio Code|code-server)$/
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function isWorkspacePage(url: string | null, title: string): boolean {
  if (!url || !WORKSPACE_TITLE.test(title.trim())) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}
