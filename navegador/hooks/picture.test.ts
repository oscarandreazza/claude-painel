import { expect, test } from 'claude-code/testing'
import { claimBlit, forgetPicture, pictureToDraw, releaseBlit, type PictureSlots } from './picture.ts'

type F = { shm: string }
const slots = (): PictureSlots<F> => ({ frame: null, drawn: null, sentShm: null })

test('primeiro quadro vai no desenho; redesenhar não reenvia', () => {
  const p = slots()
  const f1 = { shm: '/tb-1' }
  p.frame = f1
  expect(pictureToDraw(p)).toBe(f1)
  // O card redesenha várias vezes: sempre o mesmo quadro, nada novo enviado.
  expect(pictureToDraw(p)).toBe(f1)
  expect(pictureToDraw(p)).toBe(f1)
  expect(claimBlit(p, f1)).toBe(false)
})

test('quadro mandado por blit não volta no desenho (o pisca)', () => {
  const p = slots()
  const f1 = { shm: '/tb-1' }
  p.frame = f1
  pictureToDraw(p)
  for (const n of [2, 3, 4]) {
    const f = { shm: `/tb-${n}` }
    p.frame = f
    expect(claimBlit(p, f)).toBe(true)
    // Redesenho depois do blit: repete o quadro do desenho anterior.
    expect(pictureToDraw(p)).toBe(f1)
  }
})

test('desenho no meio do blit não manda o mesmo shm', () => {
  const p = slots()
  p.frame = { shm: '/tb-1' }
  pictureToDraw(p)
  const f2 = { shm: '/tb-2' }
  p.frame = f2
  expect(claimBlit(p, f2)).toBe(true)
  // O blit ainda não respondeu; o card redesenha.
  expect(pictureToDraw(p)?.shm).toBe('/tb-1')
})

test('desenho que já levou o quadro dispensa o blit dele', () => {
  const p = slots()
  const f1 = { shm: '/tb-1' }
  p.frame = f1
  pictureToDraw(p)
  expect(claimBlit(p, f1)).toBe(false)
})

test('blit recusado devolve o quadro pro próximo desenho', () => {
  const p = slots()
  p.frame = { shm: '/tb-1' }
  pictureToDraw(p)
  const f2 = { shm: '/tb-2' }
  p.frame = f2
  expect(claimBlit(p, f2)).toBe(true)
  releaseBlit(p, f2)
  expect(pictureToDraw(p)).toBe(f2)
})

test('quadro velho não é mandado por blit', () => {
  const p = slots()
  const f1 = { shm: '/tb-1' }
  p.frame = { shm: '/tb-2' }
  expect(claimBlit(p, f1)).toBe(false)
})

test('esquecer zera tudo: o próximo quadro vai no desenho', () => {
  const p = slots()
  p.frame = { shm: '/tb-1' }
  pictureToDraw(p)
  forgetPicture(p)
  expect(pictureToDraw(p)).toBe(null)
  const f2 = { shm: '/tb-2' }
  p.frame = f2
  expect(pictureToDraw(p)).toBe(f2)
})
