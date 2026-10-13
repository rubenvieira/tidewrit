import { describe, expect, test } from 'vitest'
import { SAND, SYMMETRIES } from '../src/config'
import { WaterThrower } from '../src/input/water'

describe('Water gesture ownership and landing', () => {
  test('canceling a pointer removes its airborne tap, trickles and release splash', () => {
    const water = new WaterThrower(() => 0.5)
    water.begin({ x: -0.1, y: 0 }, 1000, 1)
    water.move({ x: -0.05, y: 0 }, 1050, 1)
    water.end(1)
    expect(water.busy).toBe(true)
    water.cancel(1)
    expect(water.takeLanded(5000, 256)).toEqual([])
    expect(water.takeSplashes(5000)).toEqual([])
    expect(water.busy).toBe(false)
  })

  test('canceling one pointer preserves another pointer’s complete tap and sound', () => {
    const water = new WaterThrower(() => 0.5)
    water.begin({ x: -0.2, y: 0 }, 1000, 1)
    water.begin({ x: 0.2, y: 0 }, 1000, 2)
    water.end(2)
    water.cancel(1)
    const landed = water.takeLanded(1200, 48)
    expect(landed).toHaveLength(13)
    expect(landed.every((drop) => drop.x > 0.1)).toBe(true)
    expect(water.takeSplashes(1200)).toEqual([{ time: 1200, intensity: 0.55 }])
    expect(water.busy).toBe(false)
  })

  test('unrelated cancellation cannot clear a sound already submitted with its pool', () => {
    const water = new WaterThrower(() => 0.5)
    water.begin({ x: -0.1, y: 0 }, 1000, 1)
    water.begin({ x: 0.1, y: 0 }, 1000, 2)
    expect(water.takeLanded(1040, 1)).toHaveLength(1)
    water.cancel(2)
    expect(water.takeSplashes(1040)).toEqual([{ time: 1040, intensity: 0.55 }])
    expect(water.takeSplashes(1200)).toEqual([])
  })

  test('a blocked pool stays silent until its whole symmetry group is submitted', () => {
    const water = new WaterThrower(() => 0.5)
    water.symmetry = SYMMETRIES[4]
    water.begin({ x: 0.03, y: 0.02 }, 1000, 1)
    water.end(1)
    expect(water.takeLanded(1200, 0)).toEqual([])
    expect(water.takeLanded(1216, 7)).toEqual([])
    expect(water.takeSplashes(1216)).toEqual([])
    expect(water.takeLanded(1232, 8)).toHaveLength(8)
    expect(water.takeSplashes(1232)).toEqual([{ time: 1232, intensity: 0.55 }])
    let remaining = 0
    for (let frame = 0; frame < 3; frame++) {
      const drops = water.takeLanded(1300, 48)
      expect(drops.length).toBeLessThanOrEqual(48)
      expect(drops.length % 8).toBe(0)
      remaining += drops.length
    }
    expect(remaining).toBe(12 * 8)
    expect(water.takeSplashes(1300)).toEqual([])
    expect(water.busy).toBe(false)
  })

  test('drops retain size and symmetry chosen at emission throughout their flight', () => {
    const water = new WaterThrower(() => 0.5)
    water.symmetry = SYMMETRIES[1]
    water.size = SAND.radius * 2
    water.begin({ x: 0.03, y: 0.02 }, 1000, 1)
    water.end(1)
    water.symmetry = SYMMETRIES[0]
    water.size = SAND.radius
    water.begin({ x: 0.15, y: 0 }, 1000, 2)
    water.end(2)
    const pools = water.takeLanded(1040, 48)
    expect(pools).toHaveLength(3)
    expect(pools.map((drop) => drop.x)).toEqual([0.03, -0.03, 0.15])
    expect(pools.map((drop) => drop.radius)).toEqual([SAND.radius * 4.4, SAND.radius * 4.4, SAND.radius * 2.2])
    expect(water.takeSplashes(1040)).toHaveLength(2)
  })

  test('tap pools and droplets keep their flight delays and never replay', () => {
    const water = new WaterThrower(() => 0)
    water.begin({ x: 0, y: 0 }, 1000)
    water.end()
    expect(water.takeLanded(1039, 48)).toEqual([])
    expect(water.takeSplashes(1039)).toEqual([])
    expect(water.takeLanded(1040, 48)).toHaveLength(1)
    expect(water.takeSplashes(1040)).toEqual([{ time: 1040, intensity: 0.55 }])
    expect(water.takeLanded(1050, 48)).toHaveLength(12)
    expect(water.takeLanded(1200, 48)).toEqual([])
    expect(water.takeSplashes(1200)).toEqual([])
  })

  test('a trickle sound accompanies its body, with the satellite landing later', () => {
    const water = new WaterThrower(() => 0)
    water.begin({ x: 0, y: 0 }, 1000)
    water.takeLanded(1100, 48)
    water.takeSplashes(1100)
    water.move({ x: SAND.radius * 0.9, y: 0 }, 1200)
    expect(water.takeLanded(1229, 48)).toEqual([])
    expect(water.takeSplashes(1230)).toEqual([])
    const body = water.takeLanded(1230, 1)
    expect(body).toHaveLength(1)
    expect(body[0].amount).toBe(0.55)
    expect(water.takeSplashes(1230)).toEqual([{ time: 1230, intensity: 0.12 }])
    expect(water.takeLanded(1244, 48)).toEqual([])
    expect(water.takeLanded(1245, 48)).toHaveLength(1)
    expect(water.takeSplashes(1245)).toEqual([])
  })

  test('a thrown sheet sounds only when its central body reaches the frame budget', () => {
    const water = new WaterThrower(() => 0.5)
    water.begin({ x: 0, y: 0 }, 1000)
    water.takeLanded(1200, 48)
    water.takeSplashes(1200)
    water.move({ x: 0.05, y: 0 }, 1050)
    water.takeLanded(1200, 48)
    water.takeSplashes(1200)
    water.end()
    expect(water.takeLanded(1300, 48)).toEqual([])
    expect(water.takeSplashes(2000)).toEqual([])
    const leadingBody = water.takeLanded(2000, 2)
    expect(leadingBody).toHaveLength(2)
    expect(leadingBody.every((drop) => drop.amount === 1.2)).toBe(true)
    expect(water.takeSplashes(2000)).toEqual([])
    expect(water.takeLanded(2016, 1)[0].amount).toBe(1.2)
    expect(water.takeSplashes(2016)).toEqual([{ time: 2016, intensity: 0.75 }])
    expect(water.takeLanded(2032, 48)).toHaveLength(26)
    expect(water.takeSplashes(2032)).toEqual([])
  })

  test('clearing the tool removes airborne drops and undrained sounds', () => {
    const water = new WaterThrower(() => 0.5)
    water.begin({ x: 0, y: 0 }, 1000)
    water.takeLanded(1040, 1)
    water.cancel()
    expect(water.takeLanded(2000, 48)).toEqual([])
    expect(water.takeSplashes(2000)).toEqual([])
    expect(water.busy).toBe(false)
  })
})

describe('Bounded water input work', () => {
  test('thousands of taps retain only a bounded recent set of source drops', () => {
    const water = new WaterThrower(() => 0)
    for (let index = 0; index < 1000; index++) {
      water.begin({ x: index / 10000, y: 0 }, 1000, 1)
      water.end(1)
    }
    const retained = water.takeLanded(2000, 10000)
    expect(retained).toHaveLength(256)
    expect(retained.every((drop) => drop.x >= 0.098)).toBe(true)
    const pools = retained.filter((drop) => drop.amount === 1.4)
    expect(pools.at(-1)?.x).toBeCloseTo(0.0999)
    expect(water.takeSplashes(2000)).toHaveLength(pools.length)
    expect(water.takeLanded(2016, 48)).toEqual([])
    expect(water.busy).toBe(false)
  })

  test('an enormous captured move only resamples its newest bounded portion', () => {
    let calls = 0
    const water = new WaterThrower(() => { calls++; return 0.5 })
    water.size = 0.00001
    water.begin({ x: -0.3, y: 0 }, 1000)
    water.takeLanded(2000, 48)
    water.takeSplashes(2000)
    calls = 0
    water.move({ x: 1e100, y: 0 }, 1100)
    expect(calls).toBeLessThanOrEqual(64 * 2)
    const trickles = water.takeLanded(2000, 256)
    expect(trickles).toHaveLength(64)
    expect(trickles.every((drop) => drop.x > 0.38 && drop.x <= SAND.extent / 2 - 0.01)).toBe(true)
    water.move({ x: 1e100, y: 0 }, 1116)
    expect(water.takeLanded(2016, 256)).toEqual([])
  })

  test('undrained splash sounds have a fixed bound and are consumed once', () => {
    const water = new WaterThrower(() => 0.5)
    for (let index = 0; index < 1000; index++) {
      water.begin({ x: 0, y: 0 }, index * 100, 1)
      water.end(1)
      water.takeLanded(index * 100 + 99, 48)
    }
    expect(water.takeSplashes(100000)).toHaveLength(64)
    expect(water.takeSplashes(100000)).toEqual([])
  })
})
