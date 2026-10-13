import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { DIG, POUR, SAND, type Deposit } from '../src/config'
import { SandPourer } from '../src/input/pour'
import { Earthworks } from '../src/input/earthworks'
import { SandSolver } from '../src/simulation/solver'
import type { DigOp } from '../src/simulation/earthworks'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
const resolution = 256
const cellArea = (SAND.extent / resolution) ** 2

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Swept-tool tests require a WebGPU adapter')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function fixture() {
  const solver = new SandSolver(device, resolution)
  await solver.initialize()
  const flat = new Float32Array(resolution * resolution * 4)
  for (let index = 0; index < flat.length; index += 4) flat[index] = SAND.depth
  device.queue.writeBuffer(solver.state, 0, flat)
  return { solver, flat }
}

async function read(solver: SandSolver) {
  const staging = device.createBuffer({ size: solver.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(solver.state, 0, staging, 0, solver.byteLength)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap()
  staging.destroy()
  return result
}

const at = (state: Float32Array, x: number, y: number) => state[(Math.floor((y + SAND.extent * 0.5) / SAND.extent * resolution) * resolution + Math.floor((x + SAND.extent * 0.5) / SAND.extent * resolution)) * 4]
const changedVolume = (state: Float32Array, initial: Float32Array, removed = false) => {
  let volume = 0
  for (let index = 0; index < state.length; index += 4) {
    const difference = state[index] - initial[index]
    volume += removed ? Math.max(0, -difference) : difference
  }
  return volume * cellArea
}
function deposit(solver: SandSolver, drops: Deposit[]) {
  const encoder = device.createCommandEncoder()
  solver.encodeDeposits(encoder, drops)
  device.queue.submit([encoder.finish()])
}
function dig(solver: SandSolver, digs: DigOp[]) {
  const encoder = device.createCommandEncoder()
  solver.encodeEarthworks(encoder, digs, [])
  device.queue.submit([encoder.finish()])
}

test('a fast swept pour lands its measured volume continuously across the entire path', async () => {
  const { solver, flat } = await fixture()
  try {
    const pourer = new SandPourer()
    pourer.begin({ x: -0.12, y: 0 }, 1000, 1, 'pour')
    pourer.move({ x: 0.12, y: 0 }, 1, 1040)
    pourer.end(1, 1040)
    const drops = pourer.take(1100, 48)
    expect(drops).toHaveLength(1)
    deposit(solver, drops)
    const state = await read(solver)
    expect(changedVolume(state, flat) / (POUR.rate * 0.04)).toBeCloseTo(1, 2)
    for (const x of [-0.11, -0.07, 0, 0.05, 0.11]) expect(at(state, x, 0) - at(flat, x, 0)).toBeGreaterThan(0.0001)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a fast swept shovel excavates a continuous trench and conserves all spoil', async () => {
  const { solver, flat } = await fixture()
  try {
    const shovel = new Earthworks()
    shovel.beginDig({ x: -0.12, y: 0 }, 1000, 1)
    shovel.moveDig({ x: 0.12, y: 0 }, 1, 1060)
    shovel.endDig(1, 1060)
    const { digs } = shovel.take(1100)
    expect(digs).toHaveLength(1)
    dig(solver, digs)
    const state = await read(solver)
    expect(Math.abs(changedVolume(state, flat))).toBeLessThan(2e-9)
    expect(changedVolume(state, flat, true) / (DIG.rate * 0.06)).toBeCloseTo(1, 2)
    for (const x of [-0.1, -0.06, 0, 0.06, 0.1]) {
      expect(at(flat, x, 0) - at(state, x, 0)).toBeGreaterThan(0.0002)
      expect(at(state, x, -SAND.radius * DIG.throw) - at(flat, x, -SAND.radius * DIG.throw)).toBeGreaterThan(0.0002)
    }
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('splitting a swept shovel across frames preserves its trench and spoil profile', async () => {
  const { solver, flat } = await fixture()
  try {
    const run = async (parts: number) => {
      device.queue.writeBuffer(solver.state, 0, flat)
      const shovel = new Earthworks()
      shovel.beginDig({ x: -0.1, y: -0.02 }, 1000, 1)
      for (let part = 1; part <= parts; part++) {
        const time = 1000 + 80 * part / parts
        shovel.moveDig({ x: -0.1 + 0.2 * part / parts, y: -0.02 }, 1, time)
        dig(solver, shovel.take(time).digs)
      }
      return read(solver)
    }
    const whole = await run(1), split = await run(8)
    let maximum = 0
    for (let index = 0; index < whole.length; index += 4) maximum = Math.max(maximum, Math.abs(whole[index] - split[index]))
    expect(maximum).toBeLessThan(2e-7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('swept spoil remains conservative when the path and heap reach the tray edge', async () => {
  const { solver, flat } = await fixture()
  try {
    dig(solver, [{ x: 0.395, y: 0.1, from: { x: 0.35, y: 0.04 }, radius: 0.03, volume: 3e-6,
      spoil: { x: 0.395, y: 0.04 }, spoilFrom: { x: 0.38, y: -0.03 }, spoilRadius: 0.015, wetness: 0.1 }])
    const state = await read(solver)
    expect(Math.abs(changedVolume(state, flat))).toBeLessThan(2e-9)
    expect(changedVolume(state, flat, true)).toBeGreaterThan(1e-6)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a maximum-size shovel after a stalled frame cannot overflow its conservation totals', async () => {
  const solver = new SandSolver(device)
  await solver.initialize()
  try {
    const flat = new Float32Array(solver.byteLength / 4)
    for (let index = 0; index < flat.length; index += 4) flat[index] = SAND.depth
    device.queue.writeBuffer(solver.state, 0, flat)
    const shovel = new Earthworks()
    shovel.size = 0.022
    shovel.beginDig({ x: -0.25, y: -0.25 }, 1000, 1)
    shovel.moveDig({ x: 0.25, y: 0.25 }, 1, 1100)
    shovel.endDig(1, 1100)
    const { digs } = shovel.take(1200)
    dig(solver, digs)
    const state = await read(solver)
    let total = 0, removed = 0, finite = true
    for (let index = 0; index < state.length; index += 4) {
      const delta = state[index] - flat[index]
      finite &&= Number.isFinite(delta)
      total += delta
      removed += Math.max(0, -delta)
    }
    const area = (SAND.extent / SAND.resolution) ** 2
    expect(finite).toBe(true)
    expect(Math.abs(total * area)).toBeLessThan(2e-9)
    expect(removed * area / digs[0].volume).toBeCloseTo(1, 2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})
