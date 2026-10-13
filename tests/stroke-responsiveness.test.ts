import { describe, expect, test } from 'vitest'
import { FOOT_PRESS_STEPS, SAND, SHELL_PRESS_STEPS, SYMMETRIES, TOOL_KIND, TOOL_SHAPE, symmetryImages, type Stroke } from '../src/config'
import { StrokeQueue } from '../src/input/strokes'

const drain = (queue: StrokeQueue) => {
  const strokes: Stroke[] = []
  for (;;) {
    const batch = queue.nextBatch()
    if (!batch.length) return strokes
    strokes.push(...batch)
  }
}

describe('Stamp and drawing responsiveness', () => {
  test.each(SYMMETRIES)('$label symmetry shares contact slots fairly while stamps complete their full holds', (symmetry) => {
    const queue = new StrokeQueue()
    queue.symmetry = symmetry
    const copies = symmetryImages(symmetry)
    queue.tool = 'shell'
    for (let index = 0; index < 8; index++) {
      queue.begin({ x: 0.04 + index * 0.02, y: 0 }, 0.75, 1000, index)
      queue.end(index)
    }
    queue.tool = 'finger'
    for (const [id, pressure, y] of [[100, 0.5, 0.22], [101, 0.9, -0.22]]) queue.begin({ x: -0.1, y }, pressure, 1000, id)
    const stampCounts = new Map<number, number>()
    const firstStamps = new Set<number>()
    const firstPointers = new Set<number>()
    let exhausted = false
    for (let frame = 1; frame <= SHELL_PRESS_STEPS * 8 + 4; frame++) {
      if (frame <= 20) {
        for (const [id, pressure, y] of [[100, 0.5, 0.22], [101, 0.9, -0.22]]) queue.move({ x: -0.1 + frame * 0.004, y }, pressure, 1000 + frame * 8, id)
        if (frame === 20) { queue.end(100); queue.end(101) }
      }
      const batch = queue.nextBatch()
      expect(batch.length).toBeLessThanOrEqual(SAND.maxContacts)
      expect(batch.length % copies).toBe(0)
      if (frame <= 20) expect(batch.some((stroke) => stroke.kind === TOOL_KIND.finger)).toBe(true)
      for (const stroke of batch) {
        if (stroke.kind === TOOL_KIND.shell) {
          const radius = Math.round(Math.hypot(stroke.from.x, stroke.from.y) * 1000)
          stampCounts.set(radius, (stampCounts.get(radius) ?? 0) + 1)
          if (frame <= 8) firstStamps.add(radius)
        } else if (frame <= 2) firstPointers.add(stroke.pressure)
      }
      if (!batch.length) { exhausted = true; break }
    }
    expect(exhausted).toBe(true)
    expect(firstStamps.size).toBe(8)
    expect(firstPointers).toEqual(new Set([0.5, 0.9]))
    expect(stampCounts.size).toBe(8)
    expect([...stampCounts.values()]).toEqual(Array(8).fill(SHELL_PRESS_STEPS * copies))
  })

  test('released finger tails get a group immediately between eightfold stamps', () => {
    const queue = new StrokeQueue()
    queue.symmetry = SYMMETRIES[4]
    queue.tool = 'shell'
    for (const id of [1, 2, 3]) { queue.begin({ x: id * 0.03, y: 0 }, 0.75, 1000, id); queue.end(id) }
    queue.tool = 'finger'
    queue.begin({ x: 0, y: 0.1 }, 0.8, 1000, 4)
    queue.move({ x: 0.003, y: 0.1 }, 0.8, 1010, 4)
    queue.end(4)
    const batch = queue.nextBatch()
    expect(batch.filter((stroke) => stroke.kind === TOOL_KIND.finger)).toHaveLength(8)
    expect(batch.filter((stroke) => stroke.kind === TOOL_KIND.shell)).toHaveLength(8)
  })

  test('feet keep their full submitted hold and reset clears rotated stamps', () => {
    const queue = new StrokeQueue()
    queue.symmetry = SYMMETRIES[4]
    queue.tool = 'feet'
    for (const id of [1, 2, 3]) { queue.begin({ x: id * 0.05, y: 0 }, 0.75, 1000, id); queue.end(id) }
    expect(drain(queue)).toHaveLength(3 * FOOT_PRESS_STEPS * 8)
    queue.tool = 'shell'
    for (const id of [1, 2, 3]) queue.begin({ x: id * 0.05, y: 0 }, 0.75, 2000, id)
    queue.nextBatch()
    queue.cancel()
    expect(queue.nextBatch()).toEqual([])
  })

  test('the single-contact consumer alternates stamps and continuous motion', () => {
    const queue = new StrokeQueue()
    queue.tool = 'shell'
    queue.begin({ x: 0.1, y: 0.1 }, 0.75, 1000, 1)
    queue.end(1)
    queue.tool = 'finger'
    queue.begin({ x: 0, y: 0 }, 0.75, 1000, 2)
    const kinds: number[] = []
    for (let sample = 1; sample <= 8; sample++) {
      queue.move({ x: sample * 0.003, y: 0 }, 0.75, 1000 + sample * 10, 2)
      kinds.push(queue.next().kind)
    }
    expect(kinds).toEqual(Array.from({ length: 8 }, (_, index) => index % 2 ? TOOL_KIND.finger : TOOL_KIND.shell))
  })
})

describe('Pressure belongs to traveled geometry', () => {
  test.each([false, true])('stationary lift preserves the tail pressure and speed after prior submission=%s', (submitted) => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.8, 1000)
    queue.move({ x: 0.003, y: 0 }, 0.8, 1010)
    const before = submitted ? queue.nextBatch() : []
    queue.move({ x: 0.003, y: 0 }, 0, 1100)
    queue.end()
    const strokes = [...before, ...drain(queue)]
    expect(strokes).toHaveLength(1)
    expect(strokes[0].pressure).toBeCloseTo(0.8)
    expect(strokes[0].velocity.x).toBeCloseTo(0.3)
  })

  test('a stationary pressure change affects future movement without rewriting the prior tail', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.8, 1000)
    queue.move({ x: 0.003, y: 0 }, 0.8, 1010)
    queue.move({ x: 0.003, y: 0 }, 0.2, 1100)
    queue.move({ x: 0.006, y: 0 }, 0.2, 1110)
    queue.end()
    const strokes = drain(queue)
    expect(strokes).toHaveLength(2)
    expect(strokes.map((stroke) => stroke.pressure)).toEqual([0.8, 0.2])
    for (const stroke of strokes) expect(stroke.velocity.x).toBeCloseTo(0.3)
  })

  test('stationary pressure updates alone never create drawing contacts', () => {
    const queue = new StrokeQueue()
    queue.begin({ x: 0, y: 0 }, 0.2, 1000)
    for (const pressure of [0.4, 0.8, 1, 0]) queue.move({ x: 0, y: 0 }, pressure)
    queue.end()
    expect(drain(queue)).toEqual([])
  })

  test.each([[1, 0], [240, 0], [240, 10]])('pressure ramps interpolate consistently with %s samples and frame stride %s', (samples, frameStride) => {
    const queue = new StrokeQueue()
    queue.begin({ x: -0.12, y: 0 }, 0.2, 1000)
    const strokes: Stroke[] = []
    for (let sample = 1; sample <= samples; sample++) {
      const fraction = sample / samples
      queue.move({ x: -0.12 + fraction * 0.24, y: 0 }, 0.2 + fraction * 0.8, 1000 + fraction * 800)
      if (frameStride && sample % frameStride === 0) strokes.push(...queue.nextBatch())
    }
    queue.end()
    strokes.push(...drain(queue))
    let load = 0
    for (const stroke of strokes) {
      const midpoint = (stroke.from.x + stroke.to.x) * 0.5
      expect(stroke.pressure).toBeCloseTo(0.2 + (midpoint + 0.12) / 0.24 * 0.8, 9)
      expect(stroke.velocity.x).toBeCloseTo(0.3, 9)
      load += stroke.pressure * (stroke.to.x - stroke.from.x)
    }
    expect(load).toBeCloseTo(0.24 * 0.6, 9)
  })

  test('tool pressure scaling and fixed-depth tools still apply after pressure interpolation', () => {
    for (const tool of ['rake', 'smooth'] as const) {
      const queue = new StrokeQueue()
      queue.tool = tool
      queue.begin({ x: 0, y: 0 }, 0.2, 1000)
      queue.move({ x: 0.001, y: 0 }, 0.8, 1010)
      queue.end()
      const [stroke] = drain(queue)
      expect(stroke.pressure).toBeCloseTo(tool === 'rake' ? 0.5 * TOOL_SHAPE.rake.pressureScale! : TOOL_SHAPE.smooth.pressure!)
    }
  })
})
