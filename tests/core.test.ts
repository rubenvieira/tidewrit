import { describe, expect, test } from 'vitest'
import { shouldUseMobileGrainFiltering, shouldUseSingleFrameResetPacing } from '../src/platform/mobile'
import { drawingBuffer } from '../src/platform/viewport'
import { FixedClock } from '../src/simulation/clock'
import { SandCamera } from '../src/render/camera'
import { maxQueuedSegmentsPerPointer, StrokeQueue } from '../src/input/strokes'
import { DIG, FOOT_PRESS_STEPS, GAIT, MATERIALS, MOLD, MOLDS, POUR, SAND, TOOLS, TOOL_KEYS, SHELL_PRESS_STEPS, SYMMETRIES, TOOL_KIND, TOOL_SHAPE, symmetryImages as imageCount } from '../src/config'
import { SandPourer } from '../src/input/pour'
import { Earthworks } from '../src/input/earthworks'
import { DAYLIGHTS, DaylightCycle } from '../src/render/daylight'
import { letteringPaths, normalizeMessage } from '../src/input/lettering'
import { WaterThrower } from '../src/input/water'
import { gardenPaths, gardenReach, ZenAutopilot } from '../src/input/autopilot'
import { WaveResetEffect, crestFront, dryWaterMaskDistance, eraseOriginFront, renderEntryFront, renderExitFrontAt, shorelineOffsetAt } from '../src/reset/effect'
import { waveResetViewport } from '../src/reset/viewport'

describe('Drawing buffer policy', () => {
  test.each([[3840, 2160, 2], [7680, 4320, 2], [1440, 900, 2], [390, 844, 3]])('caps %s × %s at four million pixels', (width, height, dpr) => {
    const result = drawingBuffer(width, height, dpr)!
    expect(result.width * result.height).toBeLessThanOrEqual(4_000_000)
    expect(result.dpr).toBeLessThanOrEqual(1.7)
  })
  test('allows sub-one DPR at 4K and ignores transient empty sizes', () => {
    expect(drawingBuffer(3840, 2160, 2)!.dpr).toBeLessThan(1)
    expect(drawingBuffer(0, 200, 2)).toBeNull()
    expect(drawingBuffer(200, 0, 2)).toBeNull()
    expect(drawingBuffer(200, 200, NaN)!.dpr).toBe(1)
  })
})

describe('Mobile grain filtering selection', () => {
  test('enables the alias-safe surface path on phones and tablets', () => {
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Mobile', width: 430, height: 932 })).toBe(true)
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', width: 1024, height: 1366 })).toBe(true)
  })
  test('keeps the desktop renderer on the original shader', () => {
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 0, coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', width: 1440, height: 900 })).toBe(false)
    expect(shouldUseMobileGrainFiltering({ maxTouchPoints: 10, coarsePointer: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', width: 1920, height: 1080 })).toBe(false)
  })
})

describe('Reset frame pacing selection', () => {
  test('uses one reset frame in flight on iPhone and iPad WebKit environments', () => {
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Mobile', width: 430, height: 932 })).toBe(true)
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari', width: 1024, height: 1366 })).toBe(true)
  })
  test('does not change desktop or Android reset pacing', () => {
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 0, coarsePointer: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', width: 1440, height: 900 })).toBe(false)
    expect(shouldUseSingleFrameResetPacing({ maxTouchPoints: 5, coarsePointer: true, userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel) Mobile', width: 412, height: 915 })).toBe(false)
  })
})

describe('Fixed simulation time', () => {
  test.each([30, 60, 120, 144])('executes 120 steps per second at %s Hz', (hz) => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    let steps = clock.advance(0)
    for (let frame = 1; frame <= hz; frame++) steps += clock.advance(frame * 1000 / hz)
    expect(steps).toBe(120)
  })
  test('bounds catchup and resets hidden-tab debt', () => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    clock.advance(0)
    expect(clock.advance(10000)).toBe(4)
    expect(clock.droppedSeconds).toBeGreaterThan(9)
    clock.reset()
    expect(clock.advance(20000)).toBe(0)
  })
  test('can restart from an explicit handoff timestamp', () => {
    const clock = new FixedClock(SAND.step, SAND.maxSteps)
    clock.reset(1000)
    expect(clock.advance(1000)).toBe(0)
    expect(clock.advance(1000 + 1000 / 30)).toBe(4)
  })
})

describe('Finger sampling', () => {
  test('preserves a stroke even when released before a simulation tick', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.5)
    queue.move({ x: 0.1, y: 0 }, 0.5)
    queue.end()
    let length = 0
    for (let index = 0; index < 30; index++) {
      const stroke = queue.next()
      if (stroke.active) length += Math.hypot(stroke.to.x - stroke.from.x, stroke.to.y - stroke.from.y)
    }
    expect(length).toBeCloseTo(0.1)
    expect(queue.next().active).toBe(false)
  })
  test('bounds pathological pointer backlog instead of replaying stale strokes indefinitely', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.3, y: 0 }, 0.75, 1000)
    for (let index = 1; index <= 80; index++) {
      const x = index % 2 === 0 ? -0.3 : 0.3
      queue.move({ x, y: 0 }, 0.75, 1000 + index * 8)
    }
    queue.end()
    let pending = 0
    for (;;) {
      const batch = queue.nextBatch()
      if (!batch.length) break
      pending += batch.length
    }
    expect(pending).toBeLessThanOrEqual(maxQueuedSegmentsPerPointer)
  })
  test('does not turn duplicate WebKit sample timestamps into extreme impact speed', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.75, 1000)
    queue.move({ x: 0.1, y: 0 }, 0.75, 1000)
    const stroke = queue.next()
    expect(stroke.active).toBe(true)
    expect(Math.hypot(stroke.velocity.x, stroke.velocity.y)).toBeLessThan(2)
  })
  test('preserves real gesture speed through spatial subdivision', () => {
    const velocityFor = (durationMs: number) => {
      const queue = new StrokeQueue()
      queue.begin({ x: 0, y: 0 }, 0.7, 1000)
      queue.move({ x: 0.1, y: 0 }, 0.7, 1000 + durationMs)
      queue.end()
      return queue.next().velocity.x
    }
    const fast = velocityFor(100)
    const slow = velocityFor(1000)
    expect(fast).toBeCloseTo(1, 5)
    expect(slow).toBeCloseTo(0.1, 5)
    expect(fast / slow).toBeCloseTo(10, 5)
  })
  test('hovering and a stationary press do not emit active contact', () => {
    const queue = new StrokeQueue()
    queue.move({ x: 0.04, y: -0.03 }, 0.7, 1000)
    expect(queue.next().active).toBe(false)
    queue.begin({ x: 0.04, y: -0.03 }, 0.7, 1010)
    expect(queue.next().active).toBe(false)
    queue.end()
    queue.move({ x: 0.05, y: -0.03 }, 0.7, 1020)
    expect(queue.next().active).toBe(false)
  })
  test('never bridges separate gestures', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.1, y: 0 }, 0.6); queue.move({ x: -0.095, y: 0 }, 0.6); queue.end()
    queue.begin({ x: 0.1, y: 0 }, 0.6); queue.move({ x: 0.105, y: 0 }, 0.6); queue.end()
    expect(queue.next().from.x).toBe(-0.1)
    expect(queue.next().from.x).toBe(0.1)
  })
  test('cancellation removes queued input', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.6)
    queue.cancel()
    expect(queue.next().active).toBe(false)
  })
  test('travelled distance is independent of input event density', () => {
    const travelled = (samples: number) => {
      const queue = new StrokeQueue()
      queue.begin({ x: -0.1, y: 0 }, 0.75, 1000)
      for (let index = 1; index <= samples; index++) {
        queue.move({ x: -0.1 + 0.2 * index / samples, y: 0 }, 0.75, 1000 + 400 * index / samples)
      }
      queue.end()
      let distance = 0
      for (;;) {
        const batch = queue.nextBatch()
        if (!batch.length) break
        for (const stroke of batch) distance += Math.hypot(stroke.to.x - stroke.from.x, stroke.to.y - stroke.from.y)
      }
      return distance
    }
    expect(travelled(4)).toBeCloseTo(0.2, 6)
    expect(travelled(240)).toBeCloseTo(0.2, 6)
  })
  test('batches independent simultaneous pointers without bridging them', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.12, y: -0.03 }, 0.75, 1000, 11)
    queue.begin({ x: 0.12, y: 0.03 }, 0.75, 1000, 22)
    queue.move({ x: -0.08, y: -0.03 }, 0.75, 1040, 11)
    queue.move({ x: 0.08, y: 0.03 }, 0.75, 1040, 22)
    const batch = queue.nextBatch()
    expect(batch.length).toBeGreaterThanOrEqual(2)
    expect(batch.some((stroke) => stroke.from.x < 0 && stroke.to.x < 0)).toBe(true)
    expect(batch.some((stroke) => stroke.from.x > 0 && stroke.to.x > 0)).toBe(true)
  })
})

describe('Tools', () => {
  test('strokes carry the tool chosen at pointer down, scaled by the size slider', () => {
    const queue = new StrokeQueue()
    queue.radius = 0.01
    queue.tool = 'rake'
    queue.begin({ x: 0, y: 0 }, 0.75, 1000)
    queue.tool = 'finger'
    queue.move({ x: 0.05, y: 0 }, 0.75, 1100)
    queue.end()
    const stroke = queue.next()
    expect(stroke.kind).toBe(TOOL_KIND.rake)
    expect(stroke.radius).toBeCloseTo(0.01 * TOOL_SHAPE.rake.reach, 9)
    expect(stroke.pressure).toBeCloseTo(0.75 * TOOL_SHAPE.rake.pressureScale!, 9)
  })
  test('a shell tap presses one stationary contact per batch for its hold, ignoring drags', () => {
    const queue = new StrokeQueue()
    queue.tool = 'shell'
    queue.begin({ x: 0.02, y: -0.01 }, 0.75, 1000)
    queue.move({ x: 0.08, y: -0.01 }, 0.75, 1100)
    queue.end()
    for (let index = 0; index < SHELL_PRESS_STEPS; index++) {
      const batch = queue.nextBatch()
      expect(batch).toHaveLength(1)
      expect(batch[0].kind).toBe(TOOL_KIND.shell)
      expect(batch[0].from).toEqual({ x: 0.02, y: -0.01 })
      expect(batch[0].to).toEqual(batch[0].from)
    }
    expect(queue.nextBatch()).toHaveLength(0)
  })
  test('shell presses leave contact slots for simultaneous strokes and clear on reset', () => {
    const queue = new StrokeQueue()
    queue.tool = 'shell'
    for (let index = 0; index < SAND.maxContacts; index++) { queue.begin({ x: index * 0.01, y: 0 }, 0.75, 1000, index); queue.end(index) }
    queue.tool = 'finger'
    queue.begin({ x: -0.1, y: 0.1 }, 0.75, 1000, 99)
    queue.move({ x: -0.05, y: 0.1 }, 0.75, 1100, 99)
    const batch = queue.nextBatch()
    expect(batch.filter((stroke) => stroke.kind === TOOL_KIND.shell).length).toBeLessThan(SAND.maxContacts)
    expect(batch.some((stroke) => stroke.kind === TOOL_KIND.finger)).toBe(true)
    queue.cancel()
    expect(queue.nextBatch()).toHaveLength(0)
  })
})

describe('Symmetry', () => {
  test('every contact is replicated into each dihedral image within one batch', () => {
    for (const symmetry of SYMMETRIES) {
      const queue = new StrokeQueue()
      queue.symmetry = symmetry
      queue.begin({ x: 0.05, y: 0.02 }, 0.75, 1000)
      queue.move({ x: 0.09, y: 0.02 }, 0.75, 1100)
      queue.end()
      const batch = queue.nextBatch()
      const images = imageCount(symmetry)
      expect(batch.length % images).toBe(0)
      expect(batch.length).toBeLessThanOrEqual(SAND.maxContacts)
      const first = batch.slice(0, images)
      // All images keep the same distance from the bed center and the same speed.
      for (const stroke of first) {
        expect(Math.hypot(stroke.from.x, stroke.from.y)).toBeCloseTo(Math.hypot(0.05, 0.02), 9)
        expect(Math.hypot(stroke.velocity.x, stroke.velocity.y)).toBeCloseTo(Math.hypot(first[0].velocity.x, first[0].velocity.y), 9)
      }
      if (symmetry.mirror) expect(first.some((stroke) => Math.abs(stroke.from.x + 0.05) < 1e-9 && Math.abs(stroke.from.y - 0.02) < 1e-9)).toBe(true)
    }
  })
  test('mirrored shell presses reflect their orientation', () => {
    const queue = new StrokeQueue()
    queue.symmetry = SYMMETRIES[1]
    queue.tool = 'shell'
    const angle = queue.nextShellAngle
    queue.begin({ x: 0.04, y: 0 }, 0.75, 1000)
    const [original, mirrored] = queue.nextBatch()
    expect(original.angle).toBeCloseTo(angle, 9)
    expect(mirrored.angle).toBeCloseTo(-angle, 9)
    expect(mirrored.from.x).toBeCloseTo(-0.04, 9)
  })
})

describe('Water', () => {
  let seed = 1
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  test('a tap splashes a pool and droplets that land over the following frames', () => {
    const water = new WaterThrower(random)
    water.begin({ x: 0, y: 0 }, 1000)
    water.end()
    expect(water.takeLanded(1000, 48)).toHaveLength(0)
    const landed = water.takeLanded(1200, 48)
    expect(landed.length).toBeGreaterThan(5)
    expect(landed[0].amount).toBeGreaterThan(1)
    expect(water.takeSplashes(1200)).toHaveLength(1)
    expect(water.busy).toBe(false)
  })
  test('a flick throws the splash ahead of the release point', () => {
    const water = new WaterThrower(random)
    water.begin({ x: -0.1, y: 0 }, 1000)
    water.takeLanded(2000, 48)
    water.move({ x: -0.05, y: 0 }, 1050)
    water.end()
    const thrown = water.takeLanded(5000, 200).filter((drop) => drop.amount >= 1)
    const meanX = thrown.reduce((sum, drop) => sum + drop.x, 0) / thrown.length
    expect(meanX).toBeGreaterThan(-0.05 + 0.05)
  })
  test('symmetry replicates drops and the per-frame cap is never exceeded', () => {
    const water = new WaterThrower(random)
    water.symmetry = SYMMETRIES[4]
    water.begin({ x: 0.05, y: 0.05 }, 1000)
    water.end()
    let total = 0
    for (let frame = 0; frame < 10; frame++) {
      const landed = water.takeLanded(2000, 48)
      expect(landed.length).toBeLessThanOrEqual(48)
      expect(landed.length % 8).toBe(0)
      total += landed.length
    }
    expect(total).toBe(13 * 8)
  })
})

describe('Walking and wind', () => {
  test('walking leaves alternating footprints a stride apart on either side of the path', () => {
    const queue = new StrokeQueue()
    queue.tool = 'feet'
    queue.radius = 0.01
    queue.begin({ x: -0.3, y: 0 }, 0.75, 1000)
    for (let index = 1; index <= 120; index++) queue.move({ x: -0.3 + index * 0.005, y: 0 }, 0.75, 1000 + index * 16)
    queue.end()
    const feet: { x: number; y: number; variant: number; angle: number }[] = []
    const seen = new Set<string>()
    for (let index = 0; index < FOOT_PRESS_STEPS * 4; index++) {
      for (const stroke of queue.nextBatch()) {
        const key = `${stroke.from.x.toFixed(5)},${stroke.from.y.toFixed(5)}`
        if (stroke.kind !== TOOL_KIND.feet || seen.has(key)) continue
        seen.add(key)
        feet.push({ x: stroke.from.x, y: stroke.from.y, variant: stroke.variant, angle: stroke.angle })
      }
    }
    expect(feet.length).toBeGreaterThanOrEqual(6)
    expect(feet.length).toBeLessThanOrEqual(8)
    for (let index = 1; index < feet.length; index++) {
      expect(feet[index].variant).toBe(-feet[index - 1].variant)
      expect(Math.sign(feet[index].y)).toBe(-Math.sign(feet[index - 1].y))
      expect(feet[index].x - feet[index - 1].x).toBeCloseTo(GAIT.stride * 0.01, 2)
    }
    // Walking toward +x: toes point along the heading (-sin a, cos a).
    expect(-Math.sin(feet[1].angle)).toBeCloseTo(1, 6)
    expect(Math.abs(feet[1].y)).toBeCloseTo(GAIT.offset * 0.01, 6)
  })
  test('a tap with the feet leaves one footprint', () => {
    const queue = new StrokeQueue()
    queue.tool = 'feet'
    queue.begin({ x: 0, y: 0 }, 0.75, 1000)
    queue.end()
    const batch = queue.nextBatch()
    expect(batch).toHaveLength(1)
    expect(batch[0].kind).toBe(TOOL_KIND.feet)
  })
  test('a wind gesture keeps the heading of its first segment through a curve', () => {
    const queue = new StrokeQueue()
    queue.tool = 'wind'
    queue.begin({ x: 0, y: 0 }, 0.75, 1000)
    queue.move({ x: 0.03, y: 0 }, 0.75, 1100)
    queue.move({ x: 0.03, y: 0.05 }, 0.75, 1200)
    queue.end()
    const angles = new Set<number>()
    for (;;) { const batch = queue.nextBatch(); if (!batch.length) break; for (const stroke of batch) angles.add(stroke.angle) }
    expect([...angles]).toEqual([Math.atan2(-1, 0)])
  })
})

describe('Pouring and dripping', () => {
  test('pouring lands sand at the configured rate wherever the stream is', () => {
    const pourer = new SandPourer()
    pourer.begin({ x: 0.02, y: 0.01 }, 1000, 1, 'pour')
    let volume = 0
    let last = 1000
    for (let time = 1016; time <= 2000; time += 16) {
      pourer.move({ x: 0.02 + (time - 1000) * 0.00002, y: 0.01 }, 1)
      for (const deposit of pourer.take(time, 48)) volume += deposit.sand * Math.PI * deposit.radius ** 2 / 4
      last = time
    }
    expect(volume).toBeCloseTo(POUR.rate * (last - 1000) / 1000, 12)
    expect(pourer.emitters()).toHaveLength(1)
    pourer.end(1)
    expect(pourer.take(2100, 48)).toHaveLength(0)
    expect(pourer.emitters()).toHaveLength(0)
  })
  test('dripping releases wet blobs at a steady cadence starting immediately', () => {
    const pourer = new SandPourer()
    pourer.symmetry = SYMMETRIES[1]
    pourer.begin({ x: 0.03, y: 0 }, 1000, 1, 'drip')
    let drips = 0
    let last = 1000
    for (let time = 1016; time <= 2000; time += 16) {
      for (const deposit of pourer.take(time, 48)) {
        drips++
        expect(deposit.amount).toBe(POUR.dripWetness)
      }
      last = time
    }
    expect(drips).toBe(2 * (1 + Math.floor((last - 1000) / 1000 * POUR.dripRate)))
    expect(pourer.emitters()).toHaveLength(0)
  })
})

describe('Shovel and bucket', () => {
  test('a held dig removes sand at the configured rate and throws it clear of the hole', () => {
    const shovel = new Earthworks()
    shovel.beginDig({ x: 0, y: 0 }, 1000, 1)
    let volume = 0
    let last = 1000
    for (let time = 1016; time <= 2000; time += 16) {
      for (const dig of shovel.take(time).digs) {
        volume += dig.volume
        expect(Math.hypot(dig.spoil.x - dig.x, dig.spoil.y - dig.y)).toBeCloseTo(SAND.radius * DIG.throw, 9)
        expect(Math.hypot(dig.spoil.x - dig.x, dig.spoil.y - dig.y)).toBeGreaterThan(dig.radius + dig.spoilRadius)
      }
      last = time
    }
    expect(volume).toBeCloseTo(DIG.rate * (last - 1000) / 1000, 12)
    expect(shovel.takeThuds().length).toBeGreaterThan(2)
    shovel.endDig(1)
    expect(shovel.take(2100).digs).toHaveLength(0)
  })
  test('dragging a trench throws the spoil to the far bank', () => {
    const shovel = new Earthworks()
    shovel.beginDig({ x: -0.05, y: 0 }, 1000, 1)
    for (let index = 1; index <= 30; index++) shovel.moveDig({ x: -0.05 + index * 0.004, y: 0 }, 1)
    const [dig] = shovel.take(1016).digs
    // Moving toward +x, the spoil lands on the -y side of the trench.
    expect(dig.spoil.y).toBeLessThan(dig.y - SAND.radius * DIG.throw * 0.9)
  })
  test('a bucket tap turns out the selected mold once, replicated by symmetry', () => {
    const bucket = new Earthworks()
    bucket.symmetry = SYMMETRIES[2]
    bucket.selectShape('castle')
    bucket.placeMold({ x: 0.06, y: 0.03 })
    const { molds } = bucket.take(1000)
    expect(molds).toHaveLength(4)
    for (const mold of molds) {
      expect(mold.shape).toBe(MOLDS.findIndex((entry) => entry.id === 'castle'))
      expect(mold.radius).toBeCloseTo(SAND.radius * MOLD.radius, 9)
      expect(Math.hypot(mold.x, mold.y)).toBeCloseTo(Math.hypot(0.06, 0.03), 9)
    }
    expect(bucket.take(1016).molds).toHaveLength(0)
  })
})

describe('Controls and light', () => {
  test('every tool has its own keyboard shortcut and every sand has a color', () => {
    const keys = TOOLS.map((tool) => TOOL_KEYS[tool])
    expect(new Set(keys).size).toBe(TOOLS.length)
    expect(keys.every((key) => key.length === 1)).toBe(true)
    expect(MATERIALS.filter((material) => material.kinetic).every((material) => material.color.every((channel) => channel > 0 && channel <= 1))).toBe(true)
  })
  test('the sun sweeps along its arc between presets and settles on each', () => {
    const cycle = new DaylightCycle()
    const start = cycle.sample(0)
    expect(Math.hypot(...start.direction)).toBeCloseTo(1, 9)
    // Afternoon is the original light (cos -0.8, 0.65, sin -0.8), normalized.
    const original = [Math.cos(-0.8), 0.65, Math.sin(-0.8)]
    const length = Math.hypot(...original)
    start.direction.forEach((component, axis) => expect(component).toBeCloseTo(original[axis] / length, 9))
    expect(cycle.next(1000).id).toBe(DAYLIGHTS[1].id)
    const midway = cycle.sample(2200)
    expect(Math.hypot(...midway.direction)).toBeCloseTo(1, 9)
    expect(midway.direction[1]).toBeLessThan(start.direction[1])
    expect(midway.direction[1]).toBeGreaterThan(Math.sin(DAYLIGHTS[1].elevation))
    expect(cycle.moving(2200)).toBe(true)
    expect(cycle.moving(5000)).toBe(false)
    expect(cycle.sample(5000).sun).toEqual(DAYLIGHTS[1].sun)
    for (let index = 2; index < DAYLIGHTS.length; index++) expect(cycle.next(10000 * index).id).toBe(DAYLIGHTS[index].id)
    expect(cycle.next(1e6).id).toBe(DAYLIGHTS[0].id)
  })
})

describe('Lettering', () => {
  const bounds = { minX: -0.2, maxX: 0.2, minY: -0.12, maxY: 0.12 }
  test('messages are uppercased, hearts are recognized and unknown characters dropped', () => {
    expect(normalizeMessage('  hi <3 you~  ')).toBe('HI ♥ YOU')
  })
  test('lettering fits inside the bounds, wrapping long messages onto more lines', () => {
    for (const text of ['Hi', 'Hello sand', 'The quick brown fox jumps over the lazy dog']) {
      const { paths, capHeight } = letteringPaths(text, bounds)
      expect(paths.length).toBeGreaterThan(0)
      expect(capHeight).toBeLessThanOrEqual(0.09)
      for (const path of paths) for (const point of path) {
        expect(point.x).toBeGreaterThanOrEqual(bounds.minX - capHeight * 0.1)
        expect(point.x).toBeLessThanOrEqual(bounds.maxX + capHeight * 0.1)
        expect(point.y).toBeGreaterThanOrEqual(bounds.minY - capHeight * 0.2)
        expect(point.y).toBeLessThanOrEqual(bounds.maxY + capHeight * 0.2)
      }
    }
    const long = letteringPaths('The quick brown fox jumps over the lazy dog', bounds)
    const rows = new Set(long.paths.map((path) => Math.round(Math.max(...path.map((point) => point.y)) / (long.capHeight * 1.5))))
    expect(rows.size).toBeGreaterThan(1)
    expect(letteringPaths('~~~', bounds).paths).toHaveLength(0)
  })
})

describe('Zen garden', () => {
  const bounds = { minX: -0.2, maxX: 0.2, minY: -0.12, maxY: 0.12 }
  const reach = gardenReach(bounds, 0.012 * TOOL_SHAPE.rake.reach)
  test.each(['garden', 'spiral', 'waves'] as const)('%s paths stay inside the bounds', (pattern) => {
    const paths = gardenPaths(pattern, bounds, reach, () => 0.5)
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) for (const point of path) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.minX - 1e-9)
      expect(point.x).toBeLessThanOrEqual(bounds.maxX + 1e-9)
      expect(point.y).toBeGreaterThanOrEqual(bounds.minY - 1e-9)
      expect(point.y).toBeLessThanOrEqual(bounds.maxY + 1e-9)
    }
  })
  test('garden lines leave the stone ring fields clear', () => {
    let calls = 0
    const paths = gardenPaths('garden', bounds, reach, () => [0.1, 0.5, 0.5, 0.2][calls++ % 4])
    const lines = paths.filter((path) => path.every((point) => point.y === path[0].y))
    const rings = paths.filter((path) => !lines.includes(path))
    expect(lines.length).toBeGreaterThan(0)
    expect(rings.length).toBeGreaterThan(0)
    for (const ring of rings) {
      const center = { x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length, y: ring.reduce((sum, point) => sum + point.y, 0) / ring.length }
      const radius = Math.max(...ring.map((point) => Math.hypot(point.x - center.x, point.y - center.y)))
      for (const line of lines) for (const point of line) expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeGreaterThan(radius + reach)
    }
  })
  test('the autopilot rakes each path as one stroke at a steady pace', () => {
    const queue = new StrokeQueue()
    const autopilot = new ZenAutopilot(queue)
    autopilot.start([[{ x: 0, y: 0 }, { x: 0.03, y: 0 }]], { tool: 'rake', radius: 0.006, speed: 0.3 }, 0)
    autopilot.update(50)
    const first = queue.nextBatch()
    expect(first.length).toBeGreaterThan(0)
    expect(first.every((stroke) => stroke.kind === TOOL_KIND.rake)).toBe(true)
    for (let time = 100; time <= 400; time += 50) autopilot.update(time)
    expect(autopilot.active).toBe(false)
    expect(queue.holds(-2)).toBe(false)
  })
})

test('camera projection and bed picking agree at center and preserve orientation', () => {
  const camera = new SandCamera()
  camera.aspect = 1.6
  const center = camera.screenToBed(800, 500, 1600, 1000)
  expect(center.x).toBeCloseTo(0)
  expect(center.y).toBeCloseTo(0)
  expect(camera.screenToBed(400, 500, 1600, 1000).x).toBeLessThan(0)
  expect(camera.screenToBed(800, 100, 1600, 1000).y).toBeLessThan(0)
})


describe('Wave reset timing', () => {
  test('clears the visible entry strip immediately', () => {
    const wave = new WaveResetEffect()
    wave.start(1000, 4)
    const state = wave.update(1000)
    expect(state.active).toBe(true)
    expect(state.erase).toBe(true)
    expect(state.erasePreviousBaseFront).toBe(eraseOriginFront)
    expect(state.eraseCurrentBaseFront).toBe(renderEntryFront)
  })

  test('finishes the entire incoming erase even when a frame skips across the crest', () => {
    const wave = new WaveResetEffect()
    wave.start(1000, 4)
    wave.update(1000)
    const state = wave.update(1000 + 2600)
    expect(state.incoming).toBe(false)
    expect(state.erase).toBe(true)
    expect(state.eraseCurrentBaseFront).toBe(crestFront)
  })

  test('keeps water visible until the audio endpoint and exits exactly at that endpoint', () => {
    const wave = new WaveResetEffect()
    const duration = 4
    const startedAt = 1000
    const halfExtent = SAND.extent * 0.5
    const maximumEdgeWaterDistance = (state: ReturnType<WaveResetEffect['update']>) => {
      let maximum = Number.NEGATIVE_INFINITY
      for (let index = 0; index <= 1024; index++) {
        const x = -halfExtent + SAND.extent * index / 1024
        maximum = Math.max(maximum, halfExtent - state.currentBaseFront - shorelineOffsetAt(x, state.time))
      }
      return maximum
    }

    wave.start(startedAt, duration)
    expect(wave.update(startedAt).currentBaseFront).toBe(renderEntryFront)

    const justBeforeEnd = wave.update(startedAt + duration * 1000 - 1)
    expect(justBeforeEnd.active).toBe(true)
    expect(maximumEdgeWaterDistance(justBeforeEnd)).toBeGreaterThan(dryWaterMaskDistance)

    const finished = wave.update(startedAt + duration * 1000)
    expect(finished.justFinished).toBe(true)
    expect(finished.currentBaseFront).toBeCloseTo(renderExitFrontAt(duration), 10)
    expect(maximumEdgeWaterDistance(finished)).toBeLessThanOrEqual(dryWaterMaskDistance + 1e-7)
  })
  test('times the visible retreat to the screen edge instead of the off-screen simulation edge', () => {
    const camera = new SandCamera()
    camera.aspect = 430 / 932
    const viewport = waveResetViewport(camera)
    const wave = new WaveResetEffect()
    const duration = 4
    const startedAt = 1000
    const maximumVisibleWaterDistance = (state: ReturnType<WaveResetEffect['update']>) => {
      let maximum = Number.NEGATIVE_INFINITY
      for (let index = 0; index <= 1024; index++) {
        const x = viewport.minX + (viewport.maxX - viewport.minX) * index / 1024
        maximum = Math.max(maximum, viewport.nearY - state.currentBaseFront - shorelineOffsetAt(x, state.time))
      }
      return maximum
    }

    wave.start(startedAt, duration, viewport)
    const beforeEnd = wave.update(startedAt + duration * 1000 - 100)
    expect(maximumVisibleWaterDistance(beforeEnd)).toBeGreaterThan(dryWaterMaskDistance)

    const finished = wave.update(startedAt + duration * 1000)
    expect(finished.justFinished).toBe(true)
    expect(maximumVisibleWaterDistance(finished)).toBeLessThanOrEqual(dryWaterMaskDistance + 1e-7)
    expect(renderExitFrontAt(duration, viewport)).toBeLessThan(renderExitFrontAt(duration) - 0.1)
  })

})
