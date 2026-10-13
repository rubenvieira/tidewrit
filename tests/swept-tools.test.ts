import { describe, expect, test } from 'vitest'
import { DIG, POUR, SAND, SYMMETRIES, type Deposit } from '../src/config'
import { HeldPath } from '../src/input/held-path'
import { SandPourer } from '../src/input/pour'
import { Earthworks } from '../src/input/earthworks'

const volume = (drops: Deposit[]) => drops.reduce((sum, drop) => sum + drop.sand * Math.PI * drop.radius ** 2 / 4, 0)
// Independent numerical oracle for the time-weighted source profile. Runtime
// shaders use analytic integrals; they never perform this sample loop.
const profile = (drop: Deposit, x: number) => {
  let sum = 0
  const from = drop.from ?? drop
  for (let sample = 0; sample < 1024; sample++) {
    const fraction = (sample + 0.5) / 1024
    const dx = x - (from.x + (drop.x - from.x) * fraction)
    const dy = from.y + (drop.y - from.y) * fraction
    const radial = (dx * dx + dy * dy) / (drop.radius ** 2 * 0.25)
    if (radial < 12) sum += Math.exp(-radial)
  }
  return drop.sand * sum / 1024
}

describe('Time-weighted swept tools', () => {
  test('a straight pour has the same volume and spatial profile at 30, 60 and 120 Hz', () => {
    const profiles = [30, 60, 120].map((frames) => {
      const pourer = new SandPourer()
      pourer.begin({ x: -0.1, y: 0 }, 0, 1, 'pour')
      const drops: Deposit[] = []
      for (let frame = 1; frame <= frames; frame++) {
        const time = frame / frames * 1000
        pourer.move({ x: -0.1 + 0.2 * frame / frames, y: 0 }, 1, time)
        drops.push(...pourer.take(time, 48))
      }
      expect(volume(drops)).toBeCloseTo(POUR.rate, 12)
      return [-0.095, -0.057, 0, 0.033, 0.098].map((x) => drops.reduce((height, drop) =>
        height + profile(drop, x), 0))
    })
    for (const profile of profiles.slice(1)) profile.forEach((height, index) => expect(height).toBeCloseTo(profiles[0][index], 8))
  })

  test('coalesced turns retain their geometry and measured residence time through release', () => {
    const pourer = new SandPourer()
    pourer.begin({ x: -0.05, y: -0.05 }, 1000, 1, 'pour')
    pourer.move({ x: 0.05, y: -0.05 }, 1, 1020)
    pourer.move({ x: 0.05, y: 0.05 }, 1, 1080)
    pourer.end(1, 1080)
    const drops = pourer.take(1100, 48)
    expect(drops).toHaveLength(2)
    expect(drops[0]).toMatchObject({ from: { x: -0.05, y: -0.05 }, x: 0.05, y: -0.05 })
    expect(drops[1]).toMatchObject({ from: { x: 0.05, y: -0.05 }, x: 0.05, y: 0.05 })
    expect(volume([drops[1]]) / volume([drops[0]])).toBeCloseTo(3, 10)
    expect(volume(drops)).toBeCloseTo(POUR.rate * 0.08, 12)
    expect(pourer.take(1200, 48)).toEqual([])
  })

  test('a coalesced straight drag uses one operation independent of event count', () => {
    const shovel = new Earthworks()
    shovel.beginDig({ x: -0.1, y: 0 }, 0, 1)
    for (let sample = 1; sample <= 1000; sample++) shovel.moveDig({ x: -0.1 + sample * 0.0002, y: 0 }, 1, sample * 0.08)
    const { digs } = shovel.take(80)
    expect(digs).toHaveLength(1)
    expect(digs[0]).toMatchObject({ from: { x: -0.1, y: 0 }, x: 0.1, y: 0 })
    expect(digs[0].volume).toBeCloseTo(DIG.rate * 0.08, 12)
    expect(digs[0].spoil.y).toBeCloseTo(-SAND.radius * DIG.throw)
    expect(digs[0].spoilFrom?.y).toBeCloseTo(digs[0].spoil.y)
  })

  test('curved released digs preserve complete symmetry groups under the unchanged cap', () => {
    const shovel = new Earthworks()
    shovel.symmetry = SYMMETRIES[4]
    shovel.beginDig({ x: 0.02, y: 0.02 }, 1000, 1)
    shovel.moveDig({ x: 0.05, y: 0.02 }, 1, 1020)
    shovel.moveDig({ x: 0.05, y: 0.05 }, 1, 1060)
    shovel.endDig(1, 1060)
    shovel.symmetry = SYMMETRIES[0]
    const first = shovel.take(1100).digs, second = shovel.take(1200).digs
    expect(first).toHaveLength(DIG.maxPerFrame)
    expect(second).toHaveLength(DIG.maxPerFrame)
    expect(first[0].volume).toBeCloseTo(DIG.rate * 0.02, 12)
    expect(second[0].volume).toBeCloseTo(DIG.rate * 0.04, 12)
    expect(shovel.take(1300).digs).toEqual([])
    expect(shovel.takeThuds()).toEqual([0.35])
  })

  test('canceling released swept work retains another pointer and its captured size', () => {
    const pourer = new SandPourer()
    pourer.size = SAND.radius * 2
    for (const id of [1, 2]) {
      pourer.begin({ x: 0, y: id * 0.02 }, 1000, id, 'pour')
      pourer.move({ x: 0.1, y: id * 0.02 }, id, 1050)
      pourer.end(id, 1050)
    }
    pourer.size = SAND.radius
    pourer.cancel(1)
    const [drop] = pourer.take(1100, 48)
    expect(drop).toMatchObject({ from: { x: 0, y: 0.04 }, x: 0.1, y: 0.04, radius: SAND.radius * 2 * POUR.streamRadius })
    expect(volume([drop])).toBeCloseTo(POUR.rate * 4 * 0.05, 12)
  })

  test('stalls trim old time and path together and pathological sample counts stay bounded', () => {
    const path = new HeldPath({ x: 0, y: 0 }, 0)
    path.move({ x: 1, y: 0 }, 1000)
    const recent = path.take()!
    expect(recent.from.x).toBeCloseTo(0.9)
    expect(recent.seconds).toBeCloseTo(0.1)
    for (let index = 1; index <= 10000; index++) path.move({ x: index % 2, y: 0 }, 1000 + index * 0.001)
    let count = 0
    while (path.ready) { path.take(); count++ }
    expect(count).toBe(64)
  })

  test('slowing and stopping deposits proportionally more sand where the pointer lingers', () => {
    const pourer = new SandPourer()
    pourer.begin({ x: 0, y: 0 }, 1000, 1, 'pour')
    pourer.move({ x: 0.1, y: 0 }, 1, 1020)
    const drops = pourer.take(1080, 48)
    expect(drops).toHaveLength(2)
    expect(drops[1].from).toEqual({ x: 0.1, y: 0 })
    expect(volume([drops[1]])).toBeCloseTo(POUR.rate * 0.06, 12)
    expect(volume(drops)).toBeCloseTo(POUR.rate * 0.08, 12)
  })
})
