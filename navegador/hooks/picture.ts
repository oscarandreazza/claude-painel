// Qual quadro do navegador vai no <Image> do painel e qual vai por blit.
// Puro: sem `$`, pra ser testado direto.
//
// Duas regras do Claude Code mandam aqui (conferidas na 2.1.318):
// - o terminal apaga o shm ao ler: um nome só serve uma vez;
// - o <Image> compara a figura de um desenho com a do desenho anterior, não
//   com a do último blit. Desenhar o quadro mais novo (já mandado por blit)
//   faz ele mandar de novo um shm apagado: o terminal recusa e a figura some
//   até o próximo quadro. Era o "pisca" a cada redesenho do painel.

export type Picture = { shm: string }

export type PictureSlots<F extends Picture> = {
  /** Quadro mais novo que a ponte mandou. */
  frame: F | null
  /** Quadro que o último desenho pôs no <Image>. */
  drawn: F | null
  /** shm do quadro mais novo já entregue ao terminal (desenho ou blit). */
  sentShm: string | null
}

/**
 * O quadro que o desenho põe no <Image>. Ainda não entregue: vai no desenho
 * (montagem, mudança de tamanho, blit recusado). Já entregue: repete o do
 * desenho anterior, que não reenvia nada; o blit troca a figura por baixo.
 */
export function pictureToDraw<F extends Picture>(p: PictureSlots<F>): F | null {
  const latest = p.frame
  if (!latest) return null
  if (latest.shm !== p.sentShm) {
    p.drawn = latest
    p.sentShm = latest.shm
    return latest
  }
  return p.drawn ?? latest
}

/**
 * Antes do blit: false se o quadro já foi entregue (um desenho o levou) ou
 * ficou velho. True marca como entregue antes do await, pra um desenho no
 * meio do blit não mandar o mesmo shm.
 */
export function claimBlit<F extends Picture>(p: PictureSlots<F>, frame: F): boolean {
  if (p.frame !== frame || p.sentShm === frame.shm) return false
  p.sentShm = frame.shm
  return true
}

/** Blit recusado não foi lido: o shm segue válido pro próximo desenho. */
export function releaseBlit<F extends Picture>(p: PictureSlots<F>, frame: F): void {
  if (p.sentShm === frame.shm) p.sentShm = null
}

/** Painel fechado ou figura sumiu: nada entregue vale mais. */
export function forgetPicture<F extends Picture>(p: PictureSlots<F>): void {
  p.frame = null
  p.drawn = null
  p.sentShm = null
}
