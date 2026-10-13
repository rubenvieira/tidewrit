import { describe, expect, test } from 'vitest'
import { DIG, MOLD, POUR, SAND, SYMMETRIES, type Deposit } from '../src/config'
import { Earthworks } from '../src/input/earthworks'
import { SandPourer } from '../src/input/pour'

const volume = (deposits: Deposit[]) => deposits.reduce((sum, deposit) => sum + deposit.sand * Math.PI * deposit.radius ** 2 / 4, 0)

describe('Released sand deposits', () => {
  test('a drip pressed and released between frames lands exactly once', () => {
    const pourer = new SandPourer(() => 0)
    pourer.begin({ x: 0.1, y: 0.02 }, 1000, 1, 'drip')
    pourer.end(1, 1005)
    expect(pourer.takeDrips()).toEqual([])
    const landed = pourer.take(1016, 48)
    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({ x: 0.1, y: 0.02, amount: POUR.dripWetness })
    expect(volume(landed)).toBeCloseTo(POUR.dripVolume, 12)
    expect(pourer.takeDrips()).toEqual([{ time: 1016 }])
    expect(pourer.take(1032, 48)).toEqual([])
    expect(pourer.takeDrips()).toEqual([])
  })

  test('repeated taps reusing a pointer retain their separate landing points', () => {
    const pourer = new SandPourer(() => 0)
    for (const x of [0.01, 0.02, 0.03]) {
      pourer.begin({ x, y: 0 }, 1000, 1, 'drip')
      pourer.end(1)
    }
    expect(pourer.take(1016, 48).map((deposit) => deposit.x)).toEqual([0.01, 0.02, 0.03])
    expect(pourer.takeDrips()).toHaveLength(3)
  })

  test('short pour releases retain their measured duration and stop their emitters immediately', () => {
    const pourer = new SandPourer()
    pourer.begin({ x: 0, y: 0 }, 1000, 1, 'pour')
    pourer.end(1, 1005)
    expect(pourer.pouring).toBe(false)
    expect(pourer.emitters()).toEqual([])
    expect(volume(pourer.take(5000, 48))).toBeCloseTo(POUR.rate * 0.005, 12)
    expect(pourer.take(5016, 48)).toEqual([])
  })

  test('a release includes only the interval since the preceding frame', () => {
    const pourer = new SandPourer()
    pourer.begin({ x: 0, y: 0 }, 1000, 1, 'pour')
    const first = pourer.take(1010, 48)
    pourer.end(1, 1015)
    const last = pourer.take(2000, 48)
    expect(volume(first)).toBeCloseTo(POUR.rate * 0.01, 12)
    expect(volume(last)).toBeCloseTo(POUR.rate * 0.005, 12)
    expect(pourer.take(2016, 48)).toEqual([])
  })

  test('canceling one pointer removes only its undelivered deposits', () => {
    const pourer = new SandPourer(() => 0)
    for (const pointerId of [1, 2]) {
      pourer.begin({ x: pointerId * 0.01, y: 0 }, 1000, pointerId, 'drip')
      pourer.end(pointerId)
    }
    pourer.cancel(1)
    expect(pourer.take(1016, 48).map((deposit) => deposit.x)).toEqual([0.02])
    pourer.begin({ x: 0, y: 0 }, 1016, 3, 'drip')
    pourer.cancel()
    expect(pourer.take(1032, 48)).toEqual([])
    expect(pourer.takeDrips()).toEqual([])
  })

  test('whole symmetry groups wait for enough frame budget and retain release settings', () => {
    const pourer = new SandPourer(() => 0)
    pourer.symmetry = SYMMETRIES[4]
    pourer.size = SAND.radius * 2
    for (const pointerId of [1, 2]) {
      pourer.begin({ x: 0.03, y: 0.02 }, 1000, pointerId, 'drip')
      pourer.end(pointerId)
    }
    pourer.symmetry = SYMMETRIES[0]
    pourer.size = SAND.radius
    expect(pourer.take(1016, 7)).toEqual([])
    expect(pourer.takeDrips()).toEqual([])
    const first = pourer.take(1032, 15)
    expect(first).toHaveLength(8)
    expect(first.every((deposit) => deposit.radius === SAND.radius * 2 * POUR.dripRadius)).toBe(true)
    expect(pourer.takeDrips()).toHaveLength(1)
    expect(pourer.take(1048, 8)).toHaveLength(8)
    expect(pourer.take(1064, 48)).toEqual([])
  })

  test('held pointers rotate through a limited frame budget', () => {
    const pourer = new SandPourer()
    for (const pointerId of [1, 2, 3]) pourer.begin({ x: pointerId * 0.01, y: 0 }, 1000, pointerId, 'pour')
    expect([1016, 1032, 1048].map((time) => pourer.take(time, 1)[0].x)).toEqual([0.01, 0.02, 0.03])
  })

  test('blocked frames cannot build an unbounded held pour or drip burst', () => {
    const pourer = new SandPourer(() => 0)
    pourer.begin({ x: 0, y: 0 }, 0, 1, 'pour')
    pourer.begin({ x: 0, y: 0 }, 0, 2, 'drip')
    for (let time = 100; time <= 10000; time += 100) expect(pourer.take(time, 0)).toEqual([])
    pourer.end(1, 10000)
    pourer.end(2, 10000)
    const landed = pourer.take(10016, 48)
    expect(volume(landed.filter((deposit) => deposit.amount === 0))).toBeCloseTo(POUR.rate * 0.1, 12)
    expect(landed.filter((deposit) => deposit.amount > 0)).toHaveLength(2)
    expect(pourer.take(10032, 48)).toEqual([])
  })

  test('extreme tap bursts retain bounded recent input', () => {
    const pourer = new SandPourer(() => 0)
    for (let index = 0; index < 1000; index++) {
      pourer.begin({ x: index / 10000, y: 0 }, 0, 1, 'drip')
      pourer.end(1)
    }
    const landed = [...pourer.take(16, 48), ...pourer.take(32, 48)]
    expect(landed).toHaveLength(64)
    expect(landed[0].x).toBeCloseTo(0.0936)
    expect(landed.at(-1)?.x).toBeCloseTo(0.0999)
    expect(pourer.take(48, 48)).toEqual([])
  })
})

describe('Released digging and queued molds', () => {
  test('a short shovel release conserves its measured scoop and produces one thud on submission', () => {
    const earthworks = new Earthworks()
    earthworks.beginDig({ x: 0, y: 0 }, 1000, 1)
    earthworks.endDig(1, 1005)
    expect(earthworks.digging).toBe(false)
    expect(earthworks.spoilEmitters()).toEqual([])
    expect(earthworks.takeThuds()).toEqual([])
    const { digs } = earthworks.take(5000)
    expect(digs).toHaveLength(1)
    expect(digs[0].volume).toBeCloseTo(DIG.rate * 0.005, 12)
    expect(earthworks.takeThuds()).toEqual([0.35])
    expect(earthworks.take(5016).digs).toEqual([])
    expect(earthworks.takeThuds()).toEqual([])
  })

  test('a shovel release includes only time that has not yet been submitted', () => {
    const earthworks = new Earthworks()
    earthworks.beginDig({ x: 0, y: 0 }, 1000, 1)
    expect(earthworks.take(1010).digs[0].volume).toBeCloseTo(DIG.rate * 0.01, 12)
    earthworks.endDig(1, 1015)
    expect(earthworks.take(2000).digs[0].volume).toBeCloseTo(DIG.rate * 0.005, 12)
    expect(earthworks.take(2016).digs).toEqual([])
  })

  test('zero-duration digging is silent and releases never backdate future work', () => {
    const earthworks = new Earthworks()
    earthworks.beginDig({ x: 0, y: 0 }, 1000, 1)
    expect(earthworks.take(1000).digs).toEqual([])
    expect(earthworks.takeThuds()).toEqual([])
    earthworks.endDig(1, 990)
    expect(earthworks.take(2000).digs).toEqual([])
    expect(earthworks.takeThuds()).toEqual([])
  })

  test('queued multi-pointer digs preserve whole symmetry groups within the per-frame cap', () => {
    const earthworks = new Earthworks()
    earthworks.symmetry = SYMMETRIES[4]
    for (const pointerId of [1, 2, 3]) {
      earthworks.beginDig({ x: pointerId * 0.01, y: 0 }, 1000, pointerId)
      earthworks.endDig(pointerId, 1005)
    }
    earthworks.symmetry = SYMMETRIES[0]
    earthworks.cancel(2)
    expect(earthworks.take(1016).digs).toHaveLength(DIG.maxPerFrame)
    expect(earthworks.take(1032).digs).toHaveLength(DIG.maxPerFrame)
    expect(earthworks.take(1048).digs).toEqual([])
    expect(earthworks.takeThuds()).toEqual([0.35, 0.35])
  })

  test('held digs share the frame budget fairly and cap retained elapsed work', () => {
    const earthworks = new Earthworks()
    earthworks.symmetry = SYMMETRIES[4]
    for (const pointerId of [1, 2]) earthworks.beginDig({ x: pointerId * 0.01, y: 0 }, 0, pointerId)
    const first = earthworks.take(10000).digs
    const second = earthworks.take(20000).digs
    expect(first).toHaveLength(DIG.maxPerFrame)
    expect(second).toHaveLength(DIG.maxPerFrame)
    expect(first[0].x).toBe(0.01)
    expect(second[0].x).toBe(0.02)
    expect(second[0].volume).toBeCloseTo(DIG.rate * 0.1, 12)
  })

  test('mold thuds follow frame-limited simulation submission and reset cancels all queued work', () => {
    const earthworks = new Earthworks()
    earthworks.symmetry = SYMMETRIES[4]
    earthworks.placeMold({ x: 0.01, y: 0 })
    earthworks.placeMold({ x: 0.02, y: 0 })
    expect(earthworks.takeThuds()).toEqual([])
    expect(earthworks.take(1000).molds).toHaveLength(MOLD.maxPerFrame)
    expect(earthworks.takeThuds()).toEqual([1])
    earthworks.beginDig({ x: 0, y: 0 }, 1000, 1)
    earthworks.endDig(1, 1005)
    earthworks.cancel()
    expect(earthworks.take(1016)).toEqual({ digs: [], molds: [] })
    expect(earthworks.takeThuds()).toEqual([])
  })

  test('extreme shovel and mold bursts cannot leave an unbounded backlog', () => {
    const earthworks = new Earthworks()
    for (let index = 0; index < 1000; index++) {
      earthworks.beginDig({ x: index / 10000, y: 0 }, 0, 1)
      earthworks.endDig(1, 5)
      earthworks.placeMold({ x: index / 10000, y: 0 })
    }
    let digs = 0
    let molds = 0
    for (let frame = 0; frame < 8; frame++) {
      const batch = earthworks.take(16 * (frame + 1))
      digs += batch.digs.length
      molds += batch.molds.length
    }
    expect(digs).toBe(64)
    expect(molds).toBe(64)
    expect(earthworks.take(200)).toEqual({ digs: [], molds: [] })
  })
})
