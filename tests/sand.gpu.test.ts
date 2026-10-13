import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { DIG, FOOT_PRESS_STEPS, KINETIC, MOLD, MOLDS, POUR, SAND, WATER, SHELL_PRESS_STEPS, TOOL_KIND, TOOL_SHAPE, WIND_WAVELENGTH, idleStroke, type Deposit, type Stroke } from '../src/config'
import { SandPourer } from '../src/input/pour'
import { Earthworks } from '../src/input/earthworks'
import { SandSolver } from '../src/simulation/solver'
import { SandHistory } from '../src/simulation/history'
import { AirborneShadow } from '../src/render/airborne-shadow'
import { SandRenderer } from '../src/render/renderer'
import { BedLighting } from '../src/render/lighting'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('GPU tests require hardware WebGPU access; run outside the filesystem sandbox.')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function readState(solver: SandSolver) {
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.state, 0, staging, 0, solver.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
function volume(state: Float32Array) {
  let sum = 0
  for (let index = 0; index < state.length; index += 4) sum += state[index]
  return sum
}
async function readParticles(solver: SandSolver) {
  const size = solver.particleCount * 32
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.particles, 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
async function particleMass(solver: SandSolver) {
  const values = await readParticles(solver)
  let total = 0
  for (let index = 3; index < values.length; index += 8) total += values[index]
  return total
}
function step(solver: SandSolver, stroke: Stroke, count: number) {
  for (let index = 0; index < count; index++) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, [[stroke]])
    device.queue.submit([encoder.finish()])
  }
}

test('actual WGSL preserves mass, excavates a groove, deposits banks, and settles without erasing it', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const stroke: Stroke = { from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.45, y: 0 }, radius: 0.014, pressure: 0.8, active: true, kind: 0, angle: 0 }
    step(solver, stroke, 80)
    const pressed = await readState(solver)
    const airborne = await particleMass(solver)
    expect(airborne).toBeGreaterThan(0)
    expect(Math.abs((volume(pressed) + airborne) / volume(initial) - 1)).toBeLessThan(0.000002)
    let deepest = 0
    let highest = 0
    for (let index = 0; index < pressed.length; index += 4) {
      expect(Number.isFinite(pressed[index])).toBe(true)
      expect(pressed[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-6)
      deepest = Math.max(deepest, initial[index] - pressed[index])
      highest = Math.max(highest, pressed[index] - initial[index])
    }
    expect(deepest).toBeGreaterThan(0.004)
    expect(highest).toBeGreaterThan(0.001)
    step(solver, idleStroke(), 360)
    const settled = await readState(solver)
    expect(Math.abs((volume(settled) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000004)
    const center = ((SAND.resolution / 2) * SAND.resolution + SAND.resolution / 2) * 4
    expect(settled[center]).toBeLessThan(SAND.depth - 0.002)
    step(solver, idleStroke(), 120)
    const later = await readState(solver)
    let drift = 0
    for (let index = 0; index < later.length; index += 4) drift = Math.max(drift, Math.abs(later[index] - settled[index]))
    expect(drift).toBeLessThan(0.00015)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each([0, 16, 31])('eight-neighbor transport conserves a pile at grid coordinate %s', async (coordinate) => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  try {
    const initial = new Float32Array(32 * 32 * 4)
    for (let index = 0; index < initial.length; index += 4) initial[index] = SAND.floor
    initial[(coordinate * 32 + coordinate) * 4] = 0.08
    device.queue.writeBuffer(solver.state, 0, initial)
    step(solver, idleStroke(), 1)
    const transported = await readState(solver)
    const direction = coordinate === 31 ? -1 : 1
    const diagonal = ((coordinate + direction) * 32 + coordinate + direction) * 4
    expect(transported[diagonal]).toBeGreaterThan(SAND.floor + 0.001)
    if (coordinate === 16) {
      for (const [horizontal, vertical] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        expect(transported[((coordinate + vertical) * 32 + coordinate + horizontal) * 4]).toBeCloseTo(transported[diagonal], 7)
      }
    }
    step(solver, idleStroke(), 120)
    const settled = await readState(solver)
    for (let index = 0; index < settled.length; index += 4) {
      expect(Number.isFinite(settled[index])).toBe(true)
      expect(settled[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-7)
    }
    expect(Math.abs((volume(settled) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each([-0.1, 0, 0.1])('grain impacts respect slope %s and return their mass to the bed', async (slope) => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  try {
    const initial = new Float32Array(32 * 32 * 4)
    for (let row = 0; row < 32; row++) {
      for (let column = 0; column < 32; column++) {
        initial[(row * 32 + column) * 4] = 0.08 + slope * ((column + 0.5) * SAND.extent / 32 - SAND.extent / 2)
      }
    }
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([0, 0.0802, 0, 0.000004, 0, -0.2, 0, 0]))
    step(solver, idleStroke(), 1)
    const grains = await readParticles(solver)
    expect(grains[3]).toBeCloseTo(0.000004, 9)
    expect(grains[5]).toBeGreaterThan(0)
    expect(grains[4]).toBeCloseTo(-slope * grains[5], 6)
    expect(Math.hypot(grains[4], grains[5], grains[6])).toBeLessThan(0.2 + 9.81 * SAND.step)
    expect(grains[1]).toBeCloseTo(0.08018, 6)
    step(solver, idleStroke(), 120)
    expect(await particleMass(solver)).toBe(0)
    expect(Math.abs(volume(await readState(solver)) - volume(initial) - 0.000004)).toBeLessThan(1e-7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a fast settled-bed impact immediately cuts deeper and ejects from the advancing frontier', async () => {
  const slow = new SandSolver(device, 128)
  const fast = new SandSolver(device, 128)
  await Promise.all([slow.initialize(), fast.initialize()])
  try {
    const slowInitial = await readState(slow)
    const fastInitial = await readState(fast)
    const base = { from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, radius: 0.014, pressure: 0.82, active: true, kind: 0, angle: 0 }
    step(slow, { ...base, velocity: { x: 0.08, y: 0 } }, 1)
    step(fast, { ...base, velocity: { x: 1.1, y: 0 } }, 1)
    const slowState = await readState(slow)
    const fastState = await readState(fast)
    const fastGrains = await readParticles(fast)
    let slowDepth = 0
    let fastDepth = 0
    for (let index = 0; index < slowState.length; index += 4) {
      slowDepth = Math.max(slowDepth, slowInitial[index] - slowState[index])
      fastDepth = Math.max(fastDepth, fastInitial[index] - fastState[index])
      expect(fastState[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-6)
    }
    let airborne = 0
    let forwardParticles = 0
    let forwardMomentum = 0
    let totalParticles = 0
    for (let index = 0; index < fastGrains.length; index += 8) {
      if (fastGrains[index + 3] <= 0) continue
      airborne += fastGrains[index + 3]
      totalParticles++
      if (fastGrains[index] > base.to.x - base.radius * 0.35) forwardParticles++
      forwardMomentum += fastGrains[index + 4]
    }
    expect(fastDepth).toBeGreaterThan(slowDepth * 1.45)
    expect(airborne).toBeGreaterThan(0)
    expect(totalParticles).toBeGreaterThan(0)
    expect(forwardParticles / totalParticles).toBeGreaterThan(0.65)
    expect(forwardMomentum).toBeGreaterThan(0)
    expect(Math.abs((volume(fastState) + airborne) / volume(fastInitial) - 1)).toBeLessThan(0.000004)
    expect(errors).toEqual([])
  } finally { slow.dispose(); fast.dispose() }
})

test('fast impact builds a sustained centimeter-scale ballistic spray before redepositing', async () => {
  const solver = new SandSolver(device, 128)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const stroke: Stroke = {
      from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, velocity: { x: 1.1, y: 0 },
      radius: 0.014, pressure: 0.82, active: true, kind: 0, angle: 0,
    }
    step(solver, stroke, 6)
    const state = await readState(solver)
    const grains = await readParticles(solver)
    let count = 0
    let elevated = 0
    let airborne = 0
    let maximumHeight = -Infinity
    let forwardMomentum = 0
    for (let index = 0; index < grains.length; index += 8) {
      const mass = grains[index + 3]
      if (mass <= 0) continue
      count++
      airborne += mass
      maximumHeight = Math.max(maximumHeight, grains[index + 1])
      if (grains[index + 1] > SAND.depth + 0.004) elevated++
      forwardMomentum += grains[index + 4]
    }
    expect(count).toBeGreaterThan(100)
    expect(elevated).toBeGreaterThan(count * 0.08)
    expect(maximumHeight).toBeGreaterThan(SAND.depth + 0.008)
    expect(forwardMomentum).toBeGreaterThan(0)
    expect(Math.abs((volume(state) + airborne) / volume(initial) - 1)).toBeLessThan(0.000004)
    step(solver, idleStroke(), 180)
    expect(await particleMass(solver)).toBeLessThan(airborne * 0.02)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('gesture speed changes bed momentum and airborne mass while conserving sand', async () => {
  const slow = new SandSolver(device, 128)
  const fast = new SandSolver(device, 128)
  await Promise.all([slow.initialize(), fast.initialize()])
  try {
    const slowInitial = await readState(slow)
    const fastInitial = await readState(fast)
    const base = { from: { x: -0.055, y: 0 }, to: { x: 0.055, y: 0 }, radius: 0.014, pressure: 0.82, active: true, kind: 0, angle: 0 }
    step(slow, { ...base, velocity: { x: 0.08, y: 0 } }, 18)
    step(fast, { ...base, velocity: { x: 1.1, y: 0 } }, 18)
    const slowState = await readState(slow)
    const fastState = await readState(fast)
    const slowAirborne = await particleMass(slow)
    const fastAirborne = await particleMass(fast)
    let slowMomentum = 0
    let fastMomentum = 0
    for (let index = 0; index < slowState.length; index += 4) {
      slowMomentum += Math.hypot(slowState[index + 2], slowState[index + 3])
      fastMomentum += Math.hypot(fastState[index + 2], fastState[index + 3])
    }
    expect(fastMomentum).toBeGreaterThan(slowMomentum * 1.15)
    expect(fastAirborne).toBeGreaterThan(slowAirborne)
    expect(Math.abs((volume(slowState) + slowAirborne) / volume(slowInitial) - 1)).toBeLessThan(0.000004)
    expect(Math.abs((volume(fastState) + fastAirborne) / volume(fastInitial) - 1)).toBeLessThan(0.000004)
    expect(errors).toEqual([])
  } finally { slow.dispose(); fast.dispose() }
})

test('inactive cursor position cannot influence the bed', async () => {
  const left = new SandSolver(device, 64)
  const right = new SandSolver(device, 64)
  await Promise.all([left.initialize(), right.initialize()])
  try {
    const inactive = (x: number): Stroke => ({
      from: { x, y: 0 }, to: { x, y: 0 }, velocity: { x: 0, y: 0 },
      radius: 0.018, pressure: 1, active: false, kind: 0, angle: 0,
    })
    step(left, inactive(-0.12), 30)
    step(right, inactive(0.12), 30)
    const leftState = await readState(left)
    const rightState = await readState(right)
    let difference = 0
    for (let index = 0; index < leftState.length; index++) difference = Math.max(difference, Math.abs(leftState[index] - rightState[index]))
    expect(difference).toBeLessThan(1e-7)
    expect(errors).toEqual([])
  } finally { left.dispose(); right.dispose() }
})

const cellOf = (x: number, y: number) => {
  const spacing = SAND.extent / SAND.resolution
  const column = Math.round((x + SAND.extent / 2) / spacing - 0.5)
  const row = Math.round((y + SAND.extent / 2) / spacing - 0.5)
  return (row * SAND.resolution + column) * 4
}

test('rake carves seven separate parallel grooves and conserves sand', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const size = 0.012
    step(solver, {
      ...idleStroke(), from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.3, y: 0 },
      radius: size * TOOL_SHAPE.rake.reach, pressure: 0.75 * TOOL_SHAPE.rake.pressureScale!, active: true, kind: TOOL_KIND.rake,
    }, 80)
    const raked = await readState(solver)
    expect(Math.abs((volume(raked) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    // Walk across the stroke at its midpoint and count distinct carved runs.
    let grooves = 0
    let inGroove = false
    for (let y = -0.075; y <= 0.075; y += SAND.extent / SAND.resolution) {
      const index = cellOf(0, y)
      const carved = initial[index] - raked[index] > 0.002
      if (carved && !inGroove) grooves++
      inGroove = carved
    }
    expect(grooves).toBe(7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('shell press leaves a ribbed imprint with a raised rim and conserves sand', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const reach = 0.012 * TOOL_SHAPE.shell.reach
    const press: Stroke = {
      ...idleStroke(), from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, radius: reach,
      pressure: TOOL_SHAPE.shell.pressure!, active: true, kind: TOOL_KIND.shell, angle: 0,
    }
    step(solver, press, SHELL_PRESS_STEPS)
    step(solver, idleStroke(), 40)
    const pressed = await readState(solver)
    expect(Math.abs((volume(pressed) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    const center = cellOf(0, 0)
    expect(initial[center] - pressed[center]).toBeGreaterThan(0.003)
    let rim = 0
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const index = cellOf(Math.cos(angle) * reach * 1.15, 0.08 * reach + Math.sin(angle) * reach * 1.15)
      rim = Math.max(rim, pressed[index] - initial[index])
    }
    expect(rim).toBeGreaterThan(0.0005)
    // Sample an arc around the hinge: the fan ribs show as alternating depth.
    const profile: number[] = []
    for (let spread = -0.8; spread <= 0.8; spread += 0.025) {
      const index = cellOf(Math.sin(spread) * reach, (Math.cos(spread) - 0.6) * reach)
      profile.push(pressed[index] - initial[index])
    }
    let ribs = 0
    for (let index = 2; index < profile.length - 2; index++) {
      const window = profile.slice(index - 2, index + 3)
      if (profile[index] === Math.min(...window) && Math.max(...window) - profile[index] > 0.0003) ribs++
    }
    expect(ribs).toBeGreaterThanOrEqual(3)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('smoothing blade levels a rippled bed and conserves sand', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const rippled = await readState(solver)
    for (let row = 0; row < SAND.resolution; row++) {
      for (let column = 0; column < SAND.resolution; column++) {
        const x = (column + 0.5) * SAND.extent / SAND.resolution - SAND.extent / 2
        rippled[(row * SAND.resolution + column) * 4] = SAND.depth + 0.004 * Math.sin(x * 200)
      }
    }
    device.queue.writeBuffer(solver.state, 0, rippled)
    const roughness = (state: Float32Array) => {
      const heights: number[] = []
      for (let x = -0.05; x <= 0.05; x += 0.002) for (let y = -0.02; y <= 0.02; y += 0.004) heights.push(state[cellOf(x, y)])
      const mean = heights.reduce((sum, value) => sum + value, 0) / heights.length
      return Math.sqrt(heights.reduce((sum, value) => sum + (value - mean) ** 2, 0) / heights.length)
    }
    // 12 cm/s: the speed at which neighbor transport can keep up with the blade.
    const reach = 0.012 * TOOL_SHAPE.smooth.reach
    for (let x = -0.12; x < 0.12; x += 0.001) {
      step(solver, {
        ...idleStroke(), from: { x, y: 0 }, to: { x: x + 0.001, y: 0 }, velocity: { x: 0.12, y: 0 },
        radius: reach, pressure: TOOL_SHAPE.smooth.pressure!, active: true, kind: TOOL_KIND.smooth,
      }, 1)
    }
    const smoothed = await readState(solver)
    expect(Math.abs((volume(smoothed) + await particleMass(solver)) / volume(rippled) - 1)).toBeLessThan(0.000002)
    expect(roughness(smoothed)).toBeLessThan(roughness(rippled) * 0.2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

async function readMoisture(solver: SandSolver) {
  const size = solver.resolution ** 2 * 4
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.water.moisture[solver.stateIndex], 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}

test('landed water wets the bed and its impact pits move sand without losing any', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const encoder = device.createCommandEncoder()
    solver.encodeDeposits(encoder, [
      { x: 0, y: 0, radius: 0.03, amount: 1.4, pit: 0.001, pitRadius: 0.012, sand: 0 },
      { x: 0.06, y: 0.01, radius: 0.004, amount: 1, pit: 0.0004, pitRadius: 0.003, sand: 0 },
    ])
    device.queue.submit([encoder.finish()])
    const wetted = await readState(solver)
    const moisture = await readMoisture(solver)
    expect(Math.abs(volume(wetted) / volume(initial) - 1)).toBeLessThan(0.000002)
    const center = cellOf(0, 0)
    expect(moisture[center / 4]).toBeCloseTo(1.4, 5)
    expect(moisture[cellOf(0.06, 0.01) / 4]).toBeGreaterThan(0.9)
    expect(moisture[cellOf(-0.1, -0.1) / 4]).toBe(0)
    expect(initial[center] - wetted[center]).toBeGreaterThan(0.0008)
    const rim = cellOf(0.012 * 1.6, 0)
    expect(wetted[rim] - initial[rim]).toBeGreaterThan(0)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('damp sand holds a steeper pile than dry sand', async () => {
  const peak = async (moisture: number) => {
    const solver = new SandSolver(device, 64)
    await solver.initialize()
    try {
      const pile = new Float32Array(64 * 64 * 4)
      for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column++) {
        const inside = Math.abs(row - 32) < 3 && Math.abs(column - 32) < 3
        pile[(row * 64 + column) * 4] = SAND.depth + (inside ? 0.04 : 0)
      }
      device.queue.writeBuffer(solver.state, 0, pile)
      device.queue.writeBuffer(solver.water.moisture[solver.stateIndex], 0, new Float32Array(64 * 64).fill(moisture))
      step(solver, idleStroke(), 60)
      const settled = await readState(solver)
      expect(Math.abs((volume(settled) + await particleMass(solver)) / volume(pile) - 1)).toBeLessThan(0.000002)
      return settled[(32 * 64 + 32) * 4]
    } finally { solver.dispose() }
  }
  expect(await peak(0.5) - await peak(0)).toBeGreaterThan(0.001)
  expect(errors).toEqual([])
})

test('standing water on saturated sand runs downhill and pools in a groove', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    const bed = new Float32Array(64 * 64 * 4)
    const field = new Float32Array(64 * 64)
    for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column++) {
      bed[(row * 64 + column) * 4] = SAND.depth - (column >= 40 && column <= 42 ? 0.003 : 0)
      // Already saturated sand, so arriving water stays on the surface.
      field[row * 64 + column] = column >= 30 && column < 40 ? 1.4 : 1
    }
    device.queue.writeBuffer(solver.state, 0, bed)
    device.queue.writeBuffer(solver.water.moisture[solver.stateIndex], 0, field)
    step(solver, idleStroke(), 30)
    const moisture = await readMoisture(solver)
    // Surface water above saturation in the groove versus the same width of flat sand beside the puddle.
    const film = (from: number, to: number) => { let total = 0; for (let column = from; column <= to; column++) total += Math.max(0, moisture[32 * 64 + column] - 1); return total }
    expect(film(40, 42)).toBeGreaterThan(film(27, 29) * 2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('damp sand dries slowly while a standing film soaks in within seconds', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    const field = new Float32Array(64 * 64)
    for (let index = 0; index < field.length; index++) field[index] = index % 64 < 32 ? 0.5 : 1.5
    device.queue.writeBuffer(solver.water.moisture[solver.stateIndex], 0, field)
    step(solver, idleStroke(), 240)
    const moisture = await readMoisture(solver)
    const damp = moisture[32 * 64 + 8]
    const film = moisture[32 * 64 + 56]
    expect(damp).toBeLessThan(0.5)
    expect(damp).toBeGreaterThan(0.47)
    expect(film).toBeLessThan(1.35)
    expect(film).toBeGreaterThan(1)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('undo restores the bed and moisture exactly and redo returns to the edit', async () => {
  const solver = new SandSolver(device)
  const history = new SandHistory(device, solver)
  await solver.initialize()
  await history.initialize()
  try {
    const before = await readState(solver)
    let encoder = device.createCommandEncoder()
    history.capture(encoder)
    solver.encodeDeposits(encoder, [{ x: 0.02, y: 0, radius: 0.02, amount: 1, pit: 0.0005, pitRadius: 0.01, sand: 0 }])
    device.queue.submit([encoder.finish()])
    step(solver, { ...idleStroke(), from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.3, y: 0 }, radius: 0.014, pressure: 0.8, active: true }, 40)
    step(solver, idleStroke(), 40)
    const edited = await readState(solver)
    const editedMoisture = await readMoisture(solver)
    expect(history.canUndo).toBe(true)
    encoder = device.createCommandEncoder()
    expect(history.undo(encoder)).toBe(true)
    device.queue.submit([encoder.finish()])
    const undone = await readState(solver)
    const undoneMoisture = await readMoisture(solver)
    for (let index = 0; index < before.length; index += 4) expect(undone[index]).toBe(before[index])
    expect(undoneMoisture.every((value) => value === 0)).toBe(true)
    expect(history.canRedo).toBe(true)
    encoder = device.createCommandEncoder()
    expect(history.redo(encoder)).toBe(true)
    device.queue.submit([encoder.finish()])
    const redone = await readState(solver)
    const redoneMoisture = await readMoisture(solver)
    for (let index = 0; index < edited.length; index += 4) expect(redone[index]).toBe(edited[index])
    expect(redoneMoisture).toEqual(editedMoisture)
    expect(history.canRedo).toBe(false)
    expect(errors).toEqual([])
  } finally { history.dispose(); solver.dispose() }
})

test('wind brushing grows ripples at the ripple wavelength and conserves sand', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const reach = 0.012 * TOOL_SHAPE.wind.reach
    for (let pass = 0; pass < 3; pass++) {
      for (let x = -0.07; x < 0.07; x += 0.002) {
        step(solver, {
          ...idleStroke(), from: { x, y: 0 }, to: { x: x + 0.002, y: 0 }, velocity: { x: 0.12, y: 0 },
          radius: reach, pressure: TOOL_SHAPE.wind.pressure!, active: true, kind: TOOL_KIND.wind, angle: Math.atan2(-1, 0),
        }, 1)
      }
    }
    step(solver, idleStroke(), 60)
    const rippled = await readState(solver)
    expect(Math.abs((volume(rippled) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    const spacing = SAND.extent / SAND.resolution
    const profile: number[] = []
    for (let x = -0.035; x <= 0.035; x += spacing) profile.push(rippled[cellOf(x, 0)] - initial[cellOf(x, 0)])
    const crests: number[] = []
    for (let index = 3; index < profile.length - 3; index++) {
      const window = profile.slice(index - 3, index + 4)
      if (profile[index] === Math.max(...window) && profile[index] - Math.min(...window) > 0.0003) crests.push(index)
    }
    expect(crests.length).toBeGreaterThanOrEqual(3)
    const meanSpacing = (crests[crests.length - 1] - crests[0]) / (crests.length - 1) * spacing
    expect(meanSpacing / (reach * WIND_WAVELENGTH)).toBeGreaterThan(0.8)
    expect(meanSpacing / (reach * WIND_WAVELENGTH)).toBeLessThan(1.25)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a footprint presses the heel deepest and leaves the inner arch untouched', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const reach = 0.012 * TOOL_SHAPE.feet.reach
    step(solver, {
      ...idleStroke(), radius: reach, pressure: TOOL_SHAPE.feet.pressure!, active: true, kind: TOOL_KIND.feet, angle: 0, variant: 1,
    }, FOOT_PRESS_STEPS)
    step(solver, idleStroke(), 30)
    const pressed = await readState(solver)
    expect(Math.abs((volume(pressed) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    const depth = (x: number, y: number) => initial[cellOf(x * reach, y * reach)] - pressed[cellOf(x * reach, y * reach)]
    const heel = depth(0, -0.62)
    expect(heel).toBeGreaterThan(0.003)
    expect(depth(0.03, 0.28)).toBeGreaterThan(0.002)
    expect(depth(0.2, 0.74)).toBeGreaterThan(0.001)
    expect(depth(0.32, -0.15)).toBeLessThan(heel * 0.3)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('pouring adds exactly the poured volume and avalanches into a cone', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const pourer = new SandPourer()
    pourer.begin({ x: 0, y: 0 }, 0, 1, 'pour')
    for (let frame = 1; frame <= 60; frame++) {
      const encoder = device.createCommandEncoder()
      solver.encodeDeposits(encoder, pourer.take(frame * 1000 / 60, 48))
      solver.encode(encoder, [[], []])
      device.queue.submit([encoder.finish()])
    }
    step(solver, idleStroke(), 240)
    const piled = await readState(solver)
    const cellArea = (SAND.extent / SAND.resolution) ** 2
    const added = (volume(piled) + await particleMass(solver) - volume(initial)) * cellArea
    expect(added / POUR.rate).toBeCloseTo(1, 2)
    const peak = piled[cellOf(0, 0)] - initial[cellOf(0, 0)]
    expect(peak).toBeGreaterThan(0.006)
    let steepest = 0
    const spacing = SAND.extent / SAND.resolution
    for (let x = -0.04; x < 0.04; x += spacing) steepest = Math.max(steepest, Math.abs(piled[cellOf(x + spacing, 0)] - piled[cellOf(x, 0)]) / spacing)
    expect(steepest).toBeLessThan(SAND.repose * 1.6)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('wet drips stack taller than the same sand dropped dry', async () => {
  const peak = async (wetness: number) => {
    const solver = new SandSolver(device)
    await solver.initialize()
    try {
      const initial = await readState(solver)
      const radius = 0.012 * POUR.dripRadius
      const drip: Deposit = { x: 0, y: 0, radius, amount: wetness, pit: 0, pitRadius: 0, sand: POUR.dripVolume / (Math.PI * radius * radius / 4) }
      for (let index = 0; index < 10; index++) {
        const encoder = device.createCommandEncoder()
        solver.encodeDeposits(encoder, [drip])
        device.queue.submit([encoder.finish()])
        step(solver, idleStroke(), 17)
      }
      step(solver, idleStroke(), 120)
      const settled = await readState(solver)
      return settled[cellOf(0, 0)] - initial[cellOf(0, 0)]
    } finally { solver.dispose() }
  }
  const dry = await peak(0)
  const wet = await peak(POUR.dripWetness)
  expect(wet - dry).toBeGreaterThan(0.002)
  expect(errors).toEqual([])
})

test('a pour emitter releases a falling grain stream that lands', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    solver.setPour([{ x: 0.01, y: -0.02 }], 0.01)
    step(solver, idleStroke(), 12)
    const particles = await readParticles(solver)
    let airborne = 0
    for (let index = 0; index < particles.length; index += 8) {
      if (particles[index + 3] <= 0) continue
      airborne++
      expect(Math.hypot(particles[index] - 0.01, particles[index + 2] + 0.02)).toBeLessThan(0.02)
    }
    expect(airborne).toBeGreaterThan(100)
    solver.setPour([], 0)
    step(solver, idleStroke(), 120)
    expect(await particleMass(solver)).toBeLessThan(1e-7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('digging throws exactly the sand it removes onto a heap beside a real hole', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const shovel = new Earthworks()
    shovel.beginDig({ x: 0, y: 0 }, 0, 1)
    for (let frame = 1; frame <= 90; frame++) {
      const encoder = device.createCommandEncoder()
      const { digs, molds } = shovel.take(frame * 1000 / 60)
      solver.encodeEarthworks(encoder, digs, molds)
      solver.encode(encoder, [[], []])
      device.queue.submit([encoder.finish()])
    }
    shovel.endDig(1)
    step(solver, idleStroke(), 60)
    const dug = await readState(solver)
    expect(Math.abs((volume(dug) + await particleMass(solver)) / volume(initial) - 1)).toBeLessThan(0.000002)
    expect(initial[cellOf(0, 0)] - dug[cellOf(0, 0)]).toBeGreaterThan(0.012)
    const throwDistance = SAND.radius * DIG.throw
    const heap = cellOf(0.94 * throwDistance, -0.34 * throwDistance)
    expect(dug[heap] - initial[heap]).toBeGreaterThan(0.005)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a hole below the water table fills with a pool while the beach stays dry', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    const bed = new Float32Array(64 * 64 * 4)
    for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column++) {
      const distance = Math.hypot(row - 32, column - 32)
      bed[(row * 64 + column) * 4] = SAND.depth - Math.max(0, 0.055 * (1 - distance / 6))
    }
    device.queue.writeBuffer(solver.state, 0, bed)
    step(solver, idleStroke(), 20)
    const moisture = await readMoisture(solver)
    const state = await readState(solver)
    expect(state[(32 * 64 + 32) * 4]).toBeLessThan(WATER.waterTable)
    expect(moisture[32 * 64 + 32]).toBeGreaterThan(1.2)
    expect(moisture[32 * 64 + 2]).toBe(0)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a packed damp bucket tower holds its height where the same sand dry slumps', async () => {
  const height = async (wetness: number) => {
    const solver = new SandSolver(device)
    await solver.initialize()
    try {
      const initial = await readState(solver)
      const radius = SAND.radius * MOLD.radius
      const encoder = device.createCommandEncoder()
      solver.encodeEarthworks(encoder, [], [{ x: 0, y: 0, radius, angle: 0, shape: 0, wetness }])
      device.queue.submit([encoder.finish()])
      const molded = await readState(solver)
      expect(molded[cellOf(0, 0)] - initial[cellOf(0, 0)]).toBeCloseTo(radius * 0.9, 4)
      step(solver, idleStroke(), 120)
      const settled = await readState(solver)
      // Slumping eats in from the walls, so compare the ring just inside them.
      let ring = 0
      let samples = 0
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        for (const r of [0.72, 0.76, 0.8]) {
          const index = cellOf(Math.cos(angle) * r * radius, Math.sin(angle) * r * radius)
          ring += settled[index] - initial[index]
          samples++
        }
      }
      return ring / samples / radius
    } finally { solver.dispose() }
  }
  const damp = await height(MOLD.wetness)
  const dry = await height(0)
  expect(damp).toBeGreaterThan(0.75)
  expect(damp - dry).toBeGreaterThan(0.15)
  expect(errors).toEqual([])
})

test('a damp tower keeps its crenellations, yet a finger still cuts straight through it', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const radius = SAND.radius * MOLD.radius
    const encoder = device.createCommandEncoder()
    solver.encodeEarthworks(encoder, [], [{ x: 0, y: 0, radius, angle: 0, shape: 0, wetness: MOLD.wetness }])
    device.queue.submit([encoder.finish()])
    const parapet = (state: Float32Array) => {
      const heights: number[] = []
      for (let angle = 0; angle < Math.PI * 2; angle += 0.02) {
        const index = cellOf(Math.cos(angle) * 0.72 * radius, Math.sin(angle) * 0.72 * radius)
        heights.push(state[index] - initial[index])
      }
      return Math.max(...heights) - Math.min(...heights)
    }
    const fresh = parapet(await readState(solver))
    step(solver, idleStroke(), 240)
    const standing = await readState(solver)
    expect(parapet(standing) / fresh).toBeGreaterThan(0.8)
    expect((standing[cellOf(0, 0)] - initial[cellOf(0, 0)]) / radius).toBeGreaterThan(0.85)
    step(solver, { ...idleStroke(), from: { x: -radius * 1.3, y: 0 }, to: { x: radius * 1.3, y: 0 }, velocity: { x: 0.3, y: 0 }, radius: 0.012, pressure: 0.8, active: true }, 80)
    step(solver, idleStroke(), 60)
    const cut = await readState(solver)
    expect((cut[cellOf(0, 0)] - initial[cellOf(0, 0)]) / radius).toBeLessThan(0.5)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each(MOLDS.map((mold, index) => [mold.id, index] as const))('the %s mold turns out a raised shape', async (_id, shape) => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const initial = await readState(solver)
    const encoder = device.createCommandEncoder()
    solver.encodeEarthworks(encoder, [], [{ x: 0.02, y: -0.01, radius: SAND.radius * MOLD.radius, angle: 0.3, shape, wetness: MOLD.wetness }])
    device.queue.submit([encoder.finish()])
    const molded = await readState(solver)
    const cellArea = (SAND.extent / SAND.resolution) ** 2
    const added = (volume(molded) - volume(initial)) * cellArea
    expect(added).toBeGreaterThan(1e-6)
    expect(added).toBeLessThan(Math.PI * (SAND.radius * MOLD.radius) ** 3 * 2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

async function readPacking(solver: SandSolver) {
  const size = solver.resolution ** 2 * 4
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.water.packing[solver.stateIndex], 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
const towerRing = (state: Float32Array, initial: Float32Array, radius: number) => {
  const heights: number[] = []
  for (let angle = 0; angle < Math.PI * 2; angle += 0.02) {
    const index = cellOf(Math.cos(angle) * 0.72 * radius, Math.sin(angle) * 0.72 * radius)
    heights.push(state[index] - initial[index])
  }
  return Math.max(...heights) - Math.min(...heights)
}

test('kinetic sand packs where a finger presses, and poured sand lands loose', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  solver.setKinetic(true)
  try {
    step(solver, { ...idleStroke(), from: { x: -0.06, y: 0 }, to: { x: 0.06, y: 0 }, velocity: { x: 0.2, y: 0 }, radius: 0.012, pressure: 0.8, active: true }, 60)
    step(solver, idleStroke(), 30)
    const radius = 0.012 * POUR.streamRadius
    const encoder = device.createCommandEncoder()
    solver.encodeDeposits(encoder, [{ x: 0.1, y: 0.05, radius, amount: 0, pit: 0, pitRadius: 0, sand: 0.02 }])
    device.queue.submit([encoder.finish()])
    step(solver, idleStroke(), 2)
    const packing = await readPacking(solver)
    expect(packing[cellOf(0, 0) / 4]).toBeGreaterThan(KINETIC.initialPacking + 0.15)
    expect(packing[cellOf(0.1, 0.05) / 4]).toBeLessThan(KINETIC.initialPacking * 0.5)
    expect(packing[cellOf(0.2, 0.2) / 4]).toBeCloseTo(KINETIC.initialPacking, 5)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a kinetic tower keeps its edges at first, then creeps slowly without collapsing', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  solver.setKinetic(true)
  try {
    const initial = await readState(solver)
    const radius = SAND.radius * MOLD.radius
    const encoder = device.createCommandEncoder()
    solver.encodeEarthworks(encoder, [], [{ x: 0, y: 0, radius, angle: 0, shape: 0, wetness: MOLD.wetness }])
    device.queue.submit([encoder.finish()])
    const fresh = await readState(solver)
    step(solver, idleStroke(), 240)
    const early = await readState(solver)
    expect(towerRing(early, initial, radius) / towerRing(fresh, initial, radius)).toBeGreaterThan(0.8)
    step(solver, idleStroke(), 1200)
    const late = await readState(solver)
    const footprint = (state: Float32Array) => { let raised = 0; for (let x = -radius * 1.6; x <= radius * 1.6; x += SAND.extent / SAND.resolution) if (state[cellOf(x, 0)] - initial[cellOf(x, 0)] > 0.002) raised++; return raised }
    // Creep spreads the base outward while the tower still stands.
    expect(footprint(late)).toBeGreaterThan(footprint(early) * 1.08)
    expect((late[cellOf(0, 0)] - initial[cellOf(0, 0)]) / radius).toBeGreaterThan(0.6)
    expect(Math.abs((volume(late) + await particleMass(solver)) / volume(fresh) - 1)).toBeLessThan(0.000002)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('fast strokes in kinetic sand shed fewer, heavier crumbs than beach spray', async () => {
  const shed = async (kinetic: boolean) => {
    const solver = new SandSolver(device)
    await solver.initialize()
    solver.setKinetic(kinetic)
    try {
      step(solver, { ...idleStroke(), from: { x: -0.05, y: 0 }, to: { x: 0.05, y: 0 }, velocity: { x: 1.6, y: 0 }, radius: 0.014, pressure: 0.85, active: true }, 6)
      const particles = await readParticles(solver)
      let count = 0; let mass = 0
      for (let index = 0; index < particles.length; index += 8) if (particles[index + 3] > 0) { count++; mass += particles[index + 3] }
      return { count, mean: mass / Math.max(1, count) }
    } finally { solver.dispose() }
  }
  const beach = await shed(false)
  const kinetic = await shed(true)
  expect(beach.count).toBeGreaterThan(0)
  expect(kinetic.count).toBeLessThan(beach.count)
  expect(kinetic.mean).toBeGreaterThan(beach.mean * 2)
  expect(errors).toEqual([])
})

test('the knife slices a clean slit through a tower and leaves both halves standing', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  solver.setKinetic(true)
  try {
    const initial = await readState(solver)
    const radius = SAND.radius * MOLD.radius
    const encoder = device.createCommandEncoder()
    solver.encodeEarthworks(encoder, [], [{ x: 0, y: 0, radius, angle: 0, shape: 0, wetness: MOLD.wetness }])
    device.queue.submit([encoder.finish()])
    for (let x = -radius * 1.3; x < radius * 1.3; x += 0.001) {
      step(solver, {
        ...idleStroke(), from: { x, y: 0 }, to: { x: x + 0.001, y: 0 }, velocity: { x: 0.12, y: 0 },
        radius: SAND.radius * TOOL_SHAPE.knife.reach, pressure: TOOL_SHAPE.knife.pressure!, active: true, kind: TOOL_KIND.knife,
      }, 1)
    }
    step(solver, idleStroke(), 60)
    const sliced = await readState(solver)
    // A heightfield must put the slit's sand in lips beside it, and some of
    // that crumbles back in, so one pass cuts a clear slit about 40% deep;
    // further passes cut deeper.
    expect((sliced[cellOf(0, 0)] - initial[cellOf(0, 0)]) / radius).toBeLessThan(0.62)
    expect((sliced[cellOf(0, radius * 0.4)] - initial[cellOf(0, radius * 0.4)]) / radius).toBeGreaterThan(0.75)
    expect((sliced[cellOf(0, -radius * 0.4)] - initial[cellOf(0, -radius * 0.4)]) / radius).toBeGreaterThan(0.75)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('horizon lighting leaves planes open, occludes trenches, and refreshes after reset and paired steps', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  const uniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const lighting = new BedLighting(device, solver, uniform)
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const view = new Float32Array(28)
  view.set([1, 0.65, 0, 0, 64, SAND.extent, 256, 192], 16)
  device.queue.writeBuffer(uniform, 0, view)
  async function readLighting(angle: number) {
    const encoder = device.createCommandEncoder()
    lighting.encode(encoder, angle)
    encoder.copyBufferToBuffer(lighting.buffer, 0, staging, 0, solver.byteLength)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(staging.getMappedRange()).slice()
    staging.unmap()
    for (const value of result) expect(Number.isFinite(value)).toBe(true)
    return result
  }
  try {
    await lighting.initialize()
    const state = new Float32Array(64 * 64 * 4)
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) state[(row * 64 + column) * 4] = 0.08 + column * 0.001
    }
    device.queue.writeBuffer(solver.state, 0, state)
    const center = (32 * 64 + 32) * 4
    const plane = await readLighting(0)
    expect(plane[center]).toBeCloseTo(1, 5)
    expect(plane[center + 1]).toBeCloseTo(1, 5)
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) state[(row * 64 + column) * 4] = Math.abs(column - 32) <= 1 ? 0.03 : 0.08
    }
    device.queue.writeBuffer(solver.state, 0, state)
    const trench = await readLighting(1)
    expect(trench[center]).toBeLessThan(0.2)
    expect(trench[center + 1]).toBeLessThan(0.8)
    const revision = solver.revision
    const stateIndex = solver.stateIndex
    step(solver, idleStroke(), 2)
    expect(solver.stateIndex).toBe(stateIndex)
    expect(solver.revision).toBe(revision + 2)
    const changed = await readLighting(1)
    expect(changed[center + 1]).not.toBe(trench[center + 1])
    solver.reset()
    const reset = await readLighting(1)
    expect(reset[center]).toBeGreaterThan(0.99)
    expect(reset[center + 1]).toBeGreaterThan(0.99)
    expect(errors).toEqual([])
  } finally { lighting.dispose(); uniform.destroy(); staging.destroy(); solver.dispose() }
})

test('airborne grains build a nonzero collective optical-depth shadow', async () => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  const shadow = new AirborneShadow(device, solver)
  const resolution = SAND.airborneShadowResolution
  const bytesPerRow = resolution * 4
  const staging = device.createBuffer({ size: bytesPerRow * resolution, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await shadow.initialize()
    const particles = new Float32Array(64 * 8)
    for (let index = 0; index < 64; index++) {
      const offset = index * 8
      particles[offset] = (index % 8 - 3.5) * 0.001
      particles[offset + 1] = SAND.depth + 0.028
      particles[offset + 2] = (Math.floor(index / 8) - 3.5) * 0.001
      particles[offset + 3] = SAND.airborneReferenceMass
    }
    device.queue.writeBuffer(solver.particles, 0, particles)
    const encoder = device.createCommandEncoder()
    shadow.encode(encoder, [1, 0.65, 0])
    encoder.copyTextureToBuffer({ texture: shadow.texture }, { buffer: staging, bytesPerRow }, [resolution, resolution])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(staging.getMappedRange())
    let maximum = 0
    for (let index = 0; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index])
    staging.unmap()
    expect(maximum).toBeGreaterThan(10)
    expect(errors).toEqual([])
  } finally { shadow.dispose(); solver.dispose(); staging.destroy() }
})

test('surface pipeline compiles and renders nonuniform opaque pixels offscreen', async () => {
  const solver = new SandSolver(device, 128)
  await solver.initialize()
  const renderer = new SandRenderer(device, solver, 'rgba8unorm')
  const texture = device.createTexture({ size: [256, 192], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const staging = device.createBuffer({ size: 256 * 192 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  try {
    await renderer.initialize()
    renderer.resize(256, 192)
    step(solver, { from: { x: -0.07, y: 0 }, to: { x: 0.07, y: 0 }, velocity: { x: 0.5, y: 0 }, radius: 0.022, pressure: 1, active: true, kind: 0, angle: 0 }, 100)
    device.pushErrorScope('validation')
    const encoder = device.createCommandEncoder()
    renderer.encode(encoder, texture.createView(), idleStroke(), 0)
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: 1024 }, [256, 192])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(staging.getMappedRange())
    let minimum = 255; let maximum = 0
    for (let index = 0; index < pixels.length; index += 4) {
      minimum = Math.min(minimum, pixels[index]); maximum = Math.max(maximum, pixels[index])
      expect(pixels[index + 3]).toBe(255)
    }
    expect(maximum - minimum).toBeGreaterThan(5)
    expect(minimum).toBeGreaterThan(20)
    staging.unmap()
    expect(await device.popErrorScope()).toBeNull()
    expect(errors).toEqual([])
  } finally { renderer.dispose(); solver.dispose(); texture.destroy(); staging.destroy() }
})
