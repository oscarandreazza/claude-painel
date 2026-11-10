// Barra de endereço do terminal-browser: com ela nas páginas comuns, sem ela
// quando o painel é lugar de trabalho (VS Code). Puro, pra ser testado direto.
//
// O terminal-browser só tira a barra pelo env TERMINAL_BROWSER_NO_CHROME=1, lido
// quando o navegador nasce: trocar de modo é reabrir o navegador (o plugin sobe
// outra ponte com ou sem o env). O modo vem do título da página, que muda
// enquanto ela carrega; por isso a troca espera o modo ficar parado um tempo,
// e o título vazio (página carregando) não conta.

export const STABLE_MS = 1500
export const COOLDOWN_MS = 5000

export type ChromeWatch = {
  /** Último modo visto (true = página de trabalho), ou null antes do primeiro. */
  mode: boolean | null
  /** Desde quando o modo está assim. */
  since: number
  /** Quando foi a última troca. */
  switchedAt: number
  /** Site onde a barra saiu: só volta quando o endereço sai dele. */
  bareOrigin: string | null
}

export const chromeWatch = (): ChromeWatch => ({ mode: null, since: 0, switchedAt: -Infinity, bareOrigin: null })

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * A troca a fazer agora: true = reabrir sem barra, false = reabrir com barra,
 * null = nada. Marca a troca em `w` quando responde.
 */
export function chromeSwitch(w: ChromeWatch, workspace: boolean, title: string, url: string, chromeless: boolean, now: number): boolean | null {
  if (!title.trim()) return null
  // Sem barra, o título provisório do VS Code recarregando não devolve a
  // barra: só sair do site onde ela saiu.
  if (chromeless && !workspace && w.bareOrigin !== null && originOf(url) === w.bareOrigin) return null
  if (w.mode !== workspace) {
    w.mode = workspace
    w.since = now
    return null
  }
  if (workspace === chromeless) return null
  if (now - w.since < STABLE_MS || now - w.switchedAt < COOLDOWN_MS) return null
  w.switchedAt = now
  w.bareOrigin = workspace ? originOf(url) : null
  return workspace
}
