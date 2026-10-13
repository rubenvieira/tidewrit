import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, idleStroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'
import { PARTICLE_CONTACT } from '../src/simulation/particle-contact'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
const resolution = 32
const limit = SAND.extent / 2 - SAND.extent / resolution

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Particle boundary tests require WebGPU access')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function fixture() {
  const solver = new SandSolver(device, resolution)
  await solver.initialize()
  const initial = new Float32Array(resolution ** 2 * 4)
  for (let index = 0; index < initial.length; index += 4) initial[index] = SAND.depth
  device.queue.writeBuffer(solver.state, 0, initial)
  return { solver, initial }
}

async function read(buffer: GPUBuffer, bytes = buffer.size) {
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}

function advance(solver: SandSolver, steps = 1) {
  for (let count = 0; count < steps; count += SAND.maxSteps) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, Array.from({ length: Math.min(SAND.maxSteps, steps - count) }, () => [idleStroke()]))
    device.queue.submit([encoder.finish()])
  }
}

test.each([[1, 0], [-1, 0], [0, 1], [0, -1]])('tray edge (%s, %s) removes outward speed while preserving vertical and tangential motion', async (x, z) => {
  const { solver } = await fixture()
  try {
    const startX = x ? x * (limit - 0.001) : 0.02
    const startZ = z ? z * (limit - 0.001) : 0.02
    const vx = x ? x * 0.4 : 0.05
    const vz = z ? z * 0.4 : 0.05
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([startX, 0.12, startZ, 0.000004, vx, 0.3, vz, 0.1]))
    advance(solver)
    const grain = await read(solver.particles, 32)
    expect(grain[0]).toBeCloseTo(x ? x * limit : startX + vx * SAND.step, 7)
    expect(grain[2]).toBeCloseTo(z ? z * limit : startZ + vz * SAND.step, 7)
    expect(grain[4]).toBeCloseTo(x ? 0 : vx, 7)
    expect(grain[6]).toBeCloseTo(z ? 0 : vz, 7)
    expect(grain[5]).toBeCloseTo(0.3 - 9.81 * SAND.step, 7)
    expect(grain[3]).toBeCloseTo(0.000004, 9)
    expect(grain[4] ** 2 + grain[6] ** 2).toBeLessThan(vx ** 2 + vz ** 2)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test.each([[1, 1], [-1, 1], [1, -1], [-1, -1]])('tray corner (%s, %s) arrests both outward components and eventually returns all sand', async (x, z) => {
  const { solver, initial } = await fixture()
  try {
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([x * (limit - 0.001), 0.12, z * (limit - 0.001), 0.000004, x * 0.4, 0.3, z * 0.4, 0.1]))
    advance(solver)
    const grain = await read(solver.particles, 32)
    expect(grain[0]).toBeCloseTo(x * limit, 7)
    expect(grain[2]).toBeCloseTo(z * limit, 7)
    expect(grain[4]).toBe(0)
    expect(grain[6]).toBe(0)
    advance(solver, 120)
    const particles = await read(solver.particles)
    const bed = await read(solver.state)
    let returned = 0
    for (let index = 0; index < bed.length; index += 4) returned += bed[index] - initial[index]
    for (let index = 3; index < particles.length; index += 8) expect(particles[index]).toBe(0)
    expect(returned).toBeCloseTo(0.000004, 7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a grain already at the boundary can travel freely back into the tray', async () => {
  const { solver } = await fixture()
  try {
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([limit, 0.12, -limit, 0.000004, -0.4, 0.3, 0.2, 0.1]))
    advance(solver)
    const grain = await read(solver.particles, 32)
    expect(grain[0]).toBeCloseTo(limit - 0.4 * SAND.step, 7)
    expect(grain[2]).toBeCloseTo(-limit + 0.2 * SAND.step, 7)
    expect(grain[4]).toBeCloseTo(-0.4, 7)
    expect(grain[6]).toBeCloseTo(0.2, 7)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a sloping bed can rebound a grain inward from the boundary', async () => {
  const { solver, initial } = await fixture()
  try {
    for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
      const x = (column + 0.5) * SAND.extent / resolution - SAND.extent / 2
      initial[(row * resolution + column) * 4] = 0.08 + Math.max(0, x - (limit - 0.05)) * 0.4
    }
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([
      limit, 0.1 + PARTICLE_CONTACT.clearance * 0.5, 0, 0.000004, 0.4, -0.5, 0, 0.1,
    ]))
    advance(solver)
    const rebound = await read(solver.particles, 32)
    expect(rebound[0]).toBeCloseTo(limit, 7)
    expect(rebound[4]).toBeLessThan(0)
    expect(rebound[5]).toBeGreaterThan(0)
    expect(rebound[3]).toBeCloseTo(0.000004, 9)
    advance(solver)
    const departed = await read(solver.particles, 32)
    expect(departed[0]).toBeLessThan(limit)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})
