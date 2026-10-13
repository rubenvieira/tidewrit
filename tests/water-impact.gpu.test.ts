import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, type Deposit } from '../src/config'
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
  if (!adapter) throw new Error('Water impact tests require WebGPU access')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

function flatState(size: number, height: number) {
  const state = new Float32Array(size * size * 4)
  for (let index = 0; index < state.length; index += 4) state[index] = height
  return state
}
async function fixture(height = SAND.depth as number, size = resolution) {
  const solver = new SandSolver(device, size)
  await solver.initialize()
  const initial = flatState(size, height)
  device.queue.writeBuffer(solver.state, 0, initial)
  return { solver, initial }
}
async function read(solver: SandSolver) {
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.state, 0, staging, 0, solver.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const state = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap()
  staging.destroy()
  return state
}
function deposit(solver: SandSolver, drops: Deposit[]) {
  const encoder = device.createCommandEncoder()
  solver.encodeDeposits(encoder, drops)
  device.queue.submit([encoder.finish()])
}
function measuredDeposit(solver: SandSolver, drops: Deposit[]) {
  const encoder = device.createCommandEncoder()
  const dimensions: number[][] = []
  const measured = new Proxy(encoder, {
    get(target, property) {
      if (property === 'beginComputePass') return (descriptor?: GPUComputePassDescriptor) => {
        const pass = target.beginComputePass(descriptor)
        return new Proxy(pass, {
          get(targetPass, member) {
            if (member === 'dispatchWorkgroups') return (x: number, y = 1, z = 1) => {
              dimensions.push([x, y, z])
              targetPass.dispatchWorkgroups(x, y, z)
            }
            const value = Reflect.get(targetPass, member, targetPass)
            return typeof value === 'function' ? value.bind(targetPass) : value
          },
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  solver.encodeDeposits(measured, drops)
  device.queue.submit([encoder.finish()])
  return dimensions
}
function impact(x = spacing / 2, y = spacing / 2, pitRadius = 0.03, pit = 0.001): Deposit {
  return { x, y, radius: 0.03, amount: 0.5, pitRadius, pit, sand: 0 }
}
function heightDifference(state: Float32Array, initial: Float32Array) {
  let sum = 0
  for (let index = 0; index < state.length; index += 4) sum += state[index] - initial[index]
  return sum
}
function expectConservative(state: Float32Array, initial: Float32Array) {
  expect(Math.abs(heightDifference(state, initial))).toBeLessThan(3e-7)
  for (let index = 0; index < state.length; index += 4) {
    expect(Number.isFinite(state[index])).toBe(true)
    expect(state[index]).toBeGreaterThanOrEqual(SAND.floor - 1e-9)
  }
  expect(errors).toEqual([])
}

test.each([SAND.floor, SAND.floor + 0.0002])('overlapping water impacts conserve a bed at height %s without a floor clamp', async (height) => {
  const { solver, initial } = await fixture(height)
  try {
    deposit(solver, [impact(0.00625, 0.00625, 0.04, 0.04), impact(0.009, 0.003, 0.035, 0.08)])
    const state = await read(solver)
    expectConservative(state, initial)
    if (height === SAND.floor) expect(state).toEqual(initial)
    else expect(state[32 * resolution * 4 + 32 * 4]).toBeLessThan(initial[32 * resolution * 4 + 32 * 4])
  } finally { solver.dispose() }
})

test.each([[0.396, 0.05], [-0.396, 0.05], [0.03, -0.396], [0.03, 0.396], [0.396, 0.396]])(
  'clipped water impact at (%s, %s) keeps every displaced grain inside the tray', async (x, y) => {
    const { solver, initial } = await fixture()
    try {
      deposit(solver, [impact(x, y, 0.035, 0.007)])
      const state = await read(solver)
      expectConservative(state, initial)
      let displacement = 0
      for (let index = 0; index < state.length; index += 4) displacement += Math.abs(state[index] - initial[index])
      expect(displacement).toBeGreaterThan(0.001)
    } finally { solver.dispose() }
  },
)

test('subcell droplets remain finite and conservative both on and between grid samples', async () => {
  const { solver, initial } = await fixture()
  try {
    deposit(solver, [impact(spacing / 2, spacing / 2, spacing * 0.1, 0.008), impact(0.12, 0.09, spacing * 0.08, 0.012)])
    const state = await read(solver)
    expectConservative(state, initial)
    expect(state[(32 * resolution + 32) * 4]).toBeLessThan(initial[(32 * resolution + 32) * 4])
  } finally { solver.dispose() }
})

test('normal resolved impacts retain the established pit depth and raised rim', async () => {
  const size = 128
  const dx = SAND.extent / size
  const { solver, initial } = await fixture(SAND.depth, size)
  const drop = impact(dx / 2, dx / 2, 0.035, 0.001)
  try {
    deposit(solver, [drop])
    const state = await read(solver)
    expectConservative(state, initial)
    let maximumError = 0
    let highestRim = 0
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const radial = (((column + 0.5) * dx - SAND.extent / 2 - drop.x) ** 2
          + ((row + 0.5) * dx - SAND.extent / 2 - drop.y) ** 2) / drop.pitRadius ** 2
        const offset = (row * size + column) * 4
        const delta = state[offset] - initial[offset]
        if (radial < 8) maximumError = Math.max(maximumError, Math.abs(delta + drop.pit * (1 - radial) * Math.exp(-radial)))
        highestRim = Math.max(highestRim, delta)
      }
    }
    expect(maximumError).toBeLessThan(drop.pit * 0.06)
    expect(highestRim).toBeGreaterThan(drop.pit * 0.1)
    expect(initial[(64 * size + 64) * 4] - state[(64 * size + 64) * 4]).toBeGreaterThan(drop.pit * 0.95)
  } finally { solver.dispose() }
})

test('overlapping impact fields are order independent and ignore scratch outside their dispatch', async () => {
  const { solver, initial } = await fixture()
  try {
    const drops = [impact(-0.013, 0.01, 0.022, 0.004), impact(0.01, 0.005, 0.03, 0.002)]
    deposit(solver, drops)
    const clean = await read(solver)
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.flux, 0, new Float32Array(resolution * resolution * 8).fill(0.25))
    deposit(solver, [...drops].reverse())
    const dirty = await read(solver)
    expectConservative(dirty, initial)
    for (let index = 0; index < clean.length; index += 4) expect(Math.abs(dirty[index] - clean[index])).toBeLessThan(1e-8)
  } finally { solver.dispose() }
})

test('a plain sand deposit ignores old impact scratch and adds the same sand', async () => {
  const { solver, initial } = await fixture()
  try {
    const sand = { ...impact(), pit: 0, amount: 0, sand: 0.001, radius: 0.03 }
    deposit(solver, [sand])
    const clean = await read(solver)
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.flux, 0, new Float32Array(resolution * resolution * 8).fill(0.25))
    deposit(solver, [sand])
    const dirty = await read(solver)
    expect(dirty).toEqual(clean)
    const added = heightDifference(clean, initial) * spacing ** 2
    expect(added / (sand.sand * Math.PI * sand.radius ** 2 / 4)).toBeCloseTo(1, 2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a long simultaneous pour leaves the impact dispatch small and ignores scratch across the remaining bed', async () => {
  const size = SAND.resolution
  const { solver, initial } = await fixture(SAND.depth, size)
  const splash = impact(0, 0, 0.012, 0.001)
  const pour: Deposit = { x: 0.35, y: 0.35, from: { x: -0.35, y: -0.35 }, radius: 0.012, amount: 0, pit: 0, pitRadius: 0, sand: 0.001 }
  try {
    const isolatedDispatch = measuredDeposit(solver, [splash])
    deposit(solver, [pour])
    const isolated = await read(solver)
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.flux, 0, new Float32Array(size * size * 8).fill(0.25))
    const mixedDispatch = measuredDeposit(solver, [splash, pour])
    const mixed = await read(solver)
    expect(isolatedDispatch).toHaveLength(2)
    expect(mixedDispatch).toHaveLength(2)
    expect(mixedDispatch[0]).toEqual(isolatedDispatch[0])
    const impactGroups = mixedDispatch[0][0] * mixedDispatch[0][1]
    const depositGroups = mixedDispatch[1][0] * mixedDispatch[1][1]
    expect(impactGroups).toBeLessThanOrEqual(8 * 8)
    expect(depositGroups).toBeGreaterThan(impactGroups * 25)
    for (let index = 0; index < mixed.length; index += 4) expect(Math.abs(mixed[index] - isolated[index])).toBeLessThan(1e-8)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})
