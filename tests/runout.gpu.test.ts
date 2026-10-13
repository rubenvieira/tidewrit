import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, idleStroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
const resolution = 64
const spacing = SAND.extent / resolution

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Runout tests require WebGPU access')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function read(buffer: GPUBuffer) {
  const staging = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap()
  staging.destroy()
  return result
}

function advance(solver: SandSolver, count = 1) {
  for (let index = 0; index < count; index++) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, [[idleStroke()]])
    device.queue.submit([encoder.finish()])
  }
}

function flatPatch(speed: number) {
  const state = new Float32Array(resolution * resolution * 4)
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const index = (y * resolution + x) * 4
      state[index] = SAND.depth
      if (x >= 24 && x < 40 && y >= 24 && y < 40) {
        state[index + 1] = 0.2
        state[index + 2] = speed
      }
    }
  }
  return state
}

function sumHeight(state: Float32Array, fromColumn = 0) {
  let total = 0
  for (let cell = 0; cell < state.length / 4; cell++) {
    if (cell % resolution >= fromColumn) total += state[cell * 4]
  }
  return total
}

function firstMoment(state: Float32Array) {
  let moment = 0
  for (let cell = 0; cell < state.length / 4; cell++) {
    moment += state[cell * 4] * ((cell % resolution + 0.5) * spacing - SAND.extent / 2)
  }
  return moment
}

async function totalMass(solver: SandSolver, state: Float32Array) {
  const grains = await read(solver.particles)
  let total = sumHeight(state)
  for (let index = 3; index < grains.length; index += 8) total += grains[index]
  return total
}

test('a released dry surface layer runs forward while an identical resting bed stays fixed', async () => {
  const moving = new SandSolver(device, resolution)
  const resting = new SandSolver(device, resolution)
  await Promise.all([moving.initialize(), resting.initialize()])
  try {
    const initial = flatPatch(0.3)
    device.queue.writeBuffer(moving.state, 0, initial)
    device.queue.writeBuffer(resting.state, 0, flatPatch(0))
    advance(moving)
    advance(resting)
    const moved = await read(moving.state)
    const still = await read(resting.state)
    expect(firstMoment(moved) - firstMoment(initial)).toBeGreaterThan(0.0001)
    for (let index = 0; index < initial.length; index += 4) {
      expect(still[index]).toBe(initial[index])
      expect(moved[index]).toBeGreaterThanOrEqual(SAND.floor)
    }
    expect(Math.abs(await totalMass(moving, moved) - sumHeight(initial))).toBeLessThan(0.00001)
    expect(errors).toEqual([])
  } finally { moving.dispose(); resting.dispose() }
})

test('unforced runout loses speed monotonically, stops, and leaves the settled bed unchanged', async () => {
  const solver = new SandSolver(device, resolution)
  await solver.initialize()
  try {
    const initial = flatPatch(0.3)
    device.queue.writeBuffer(solver.state, 0, initial)
    let maximumSpeed = 0.3
    let previousEnergy = 16 * 16 * 0.3 ** 2
    for (let step = 0; step < 16; step++) {
      advance(solver)
      const state = await read(solver.state)
      let speed = 0
      let energy = 0
      for (let index = 0; index < state.length; index += 4) {
        expect(Number.isFinite(state[index])).toBe(true)
        speed = Math.max(speed, Math.hypot(state[index + 2], state[index + 3]))
        energy += state[index + 2] ** 2 + state[index + 3] ** 2
      }
      expect(speed).toBeLessThanOrEqual(maximumSpeed + 1e-7)
      expect(energy).toBeLessThanOrEqual(previousEnergy + 1e-6)
      maximumSpeed = speed
      previousEnergy = energy
    }
    expect(maximumSpeed).toBe(0)
    advance(solver, 120)
    const settled = await read(solver.state)
    advance(solver, 120)
    const later = await read(solver.state)
    for (let index = 0; index < later.length; index += 4) expect(later[index]).toBe(settled[index])
    expect(Math.abs(await totalMass(solver, later) - sumHeight(initial))).toBeLessThan(0.00002)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('fast runout at tray corners shares the available-height limiter and conserves the thin bed', async () => {
  const solver = new SandSolver(device, resolution)
  await solver.initialize()
  try {
    const initial = new Float32Array(resolution * resolution * 4)
    for (let cell = 0; cell < resolution * resolution; cell++) initial[cell * 4] = SAND.floor
    for (const cell of [0, resolution - 1, (resolution - 1) * resolution, resolution * resolution - 1]) {
      initial[cell * 4] += 0.0002
      initial[cell * 4 + 1] = 0.2
      initial[cell * 4 + 2] = cell % resolution === 0 ? 4 : -4
      initial[cell * 4 + 3] = cell < resolution ? 4 : -4
    }
    device.queue.writeBuffer(solver.state, 0, initial)
    advance(solver, 24)
    const state = await read(solver.state)
    for (let index = 0; index < state.length; index += 4) expect(state[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-9)
    expect(Math.abs(await totalMass(solver, state) - sumHeight(initial))).toBeLessThan(0.000001)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a bank taller than the moving layer kinetic head blocks uphill runout', async () => {
  const flat = new SandSolver(device, resolution)
  const bank = new SandSolver(device, resolution)
  await Promise.all([flat.initialize(), bank.initialize()])
  try {
    const initial = flatPatch(0)
    for (let row = 0; row < resolution; row++) {
      const index = (row * resolution + 31) * 4
      initial[index + 1] = 0.2
      initial[index + 2] = 0.2
    }
    const bankInitial = initial.slice()
    for (let cell = 0; cell < resolution * resolution; cell++) {
      if (cell % resolution >= 32) bankInitial[cell * 4] += 0.003
    }
    device.queue.writeBuffer(flat.state, 0, initial)
    device.queue.writeBuffer(bank.state, 0, bankInitial)
    advance(flat)
    advance(bank)
    const openState = await read(flat.state)
    const bankState = await read(bank.state)
    expect(sumHeight(openState, 32) - sumHeight(initial, 32)).toBeGreaterThan(0.001)
    expect(sumHeight(bankState, 32)).toBe(sumHeight(bankInitial, 32))
    expect(Math.abs(await totalMass(bank, bankState) - sumHeight(bankInitial))).toBeLessThan(0.00001)
    expect(errors).toEqual([])
  } finally { flat.dispose(); bank.dispose() }
})

test.each(['damp', 'kinetic'] as const)('%s material does not acquire loose dry runout', async (material) => {
  const solver = new SandSolver(device, resolution)
  await solver.initialize()
  try {
    const initial = flatPatch(0.3)
    device.queue.writeBuffer(solver.state, 0, initial)
    if (material === 'kinetic') solver.setKinetic(true)
    else {
      const moisture = new Float32Array(resolution * resolution).fill(0.6)
      for (const buffer of solver.water.moisture) device.queue.writeBuffer(buffer, 0, moisture)
    }
    advance(solver, 24)
    const state = await read(solver.state)
    for (let index = 0; index < state.length; index += 4) expect(state[index]).toBe(initial[index])
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})
