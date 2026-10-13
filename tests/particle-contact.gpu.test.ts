import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, idleStroke } from '../src/config'
import { SandSolver } from '../src/simulation/solver'
import { PARTICLE_CONTACT } from '../src/simulation/particle-contact'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU is required for particle contact tests')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => device?.destroy())

async function read(buffer: GPUBuffer, size: number) {
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const values = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap(); staging.destroy()
  return values
}
function advance(solver: SandSolver, steps = 1) {
  for (let index = 0; index < steps; index++) {
    const encoder = device.createCommandEncoder()
    solver.encode(encoder, [[idleStroke()]])
    device.queue.submit([encoder.finish()])
  }
}
function bed(resolution: number, height: (column: number, row: number) => number) {
  const values = new Float32Array(resolution ** 2 * 4)
  for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) values[(row * resolution + column) * 4] = height(column, row)
  return values
}
function heightSum(values: Float32Array) {
  let total = 0
  for (let index = 0; index < values.length; index += 4) total += values[index]
  return total
}

test.each([[1, 0.094], [-1, 0.094], [1, 0.1099]])('a grain travelling in direction %s at height %s hits a narrow ridge before reaching the lower far side', async (direction, height) => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    const ridgeColumn = 32
    const spacing = SAND.extent / 64
    const ridgeX = (ridgeColumn + 0.5) * spacing - SAND.extent / 2
    const initial = bed(64, (column) => column === ridgeColumn ? 0.11 : 0.08)
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([
      ridgeX - direction * 0.025, height, 0, 0.000004,
      direction * 6, 0, 0, 0,
    ]))
    advance(solver)
    const particle = await read(solver.particles, 32)
    expect(particle[3]).toBeCloseTo(0.000004, 9)
    expect(direction * (particle[0] - ridgeX)).toBeLessThan(0)
    expect(Math.abs(particle[0] - ridgeX)).toBeLessThan(spacing)
    expect(direction * particle[4]).toBeLessThan(0)
    expect(particle[5]).toBeGreaterThan(0)
    expect(Math.hypot(particle[4], particle[5], particle[6])).toBeLessThan(6)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a diagonal near-budget flight hits a late narrow peak even though both endpoints are clear', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    const spacing = SAND.extent / 64
    const position = (coordinate: number) => (coordinate + 0.5) * spacing - SAND.extent / 2
    const initial = bed(64, (column, row) => column === 32 && row === 30 ? 0.11 : 0.08)
    // Seven-plus x cells and six-plus z cells exercise fourteen distinct grid
    // crossings. The obstacle is encountered in the fourteenth visited cell.
    const velocity = { x: 7.8 * spacing / SAND.step, z: 6.2 * spacing / SAND.step }
    const start = { x: position(24.25), y: 0.095, z: position(24.45) }
    const finish = { x: position(32.05), y: start.y - 9.81 * SAND.step ** 2, z: position(30.65) }
    // The final point is in the descending triangle beside the peak; checking
    // only its height would allow the grain to pass straight through the peak.
    const finishHeight = 0.11 - 0.03 * (0.05 + 0.65)
    expect(start.y).toBeGreaterThan(0.08 + PARTICLE_CONTACT.clearance)
    expect(finish.y).toBeGreaterThan(finishHeight + PARTICLE_CONTACT.clearance)
    device.queue.writeBuffer(solver.state, 0, initial)
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([
      start.x, start.y, start.z, 0.000004, velocity.x, 0, velocity.z, 0,
    ]))
    advance(solver)
    const particle = await read(solver.particles, 32)
    expect(particle[3]).toBeCloseTo(0.000004, 9)
    expect(particle[0]).toBeGreaterThan(start.x + 0.9 * (finish.x - start.x))
    expect(particle[0]).toBeLessThan(position(32))
    expect(particle[2]).toBeGreaterThan(position(30))
    expect(particle[2]).toBeLessThan(finish.z)
    expect(particle[4]).toBeLessThan(0)
    expect(particle[5]).toBeGreaterThan(0)
    expect(Math.hypot(particle[4], particle[5], particle[6])).toBeLessThan(Math.hypot(velocity.x, velocity.z))
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('wet sand absorbs more rebound and sliding energy than the same dry bed', async () => {
  const collide = async (wetness: number) => {
    const solver = new SandSolver(device, 32)
    await solver.initialize()
    try {
      const initial = bed(32, () => 0.08)
      device.queue.writeBuffer(solver.state, 0, initial)
      device.queue.writeBuffer(solver.water.moisture[solver.stateIndex], 0, new Float32Array(32 ** 2).fill(wetness))
      device.queue.writeBuffer(solver.particles, 0, new Float32Array([0, 0.0803, 0, 0.000004, 0.45, -0.22, 0.2, 0]))
      advance(solver)
      const impact = await read(solver.particles, 32)
      advance(solver, 90)
      const particles = await read(solver.particles, solver.particleCount * 32)
      expect(particles.filter((_, index) => index % 8 === 3).every((mass) => mass === 0)).toBe(true)
      const final = await read(solver.state, solver.byteLength)
      expect(Math.abs(heightSum(final) - heightSum(initial) - 0.000004)).toBeLessThan(2e-7)
      expect(errors).toEqual([])
      return impact
    } finally { solver.dispose() }
  }
  const dry = await collide(0)
  const wet = await collide(0.6)
  expect(dry[5]).toBeGreaterThan(0)
  expect(wet[5]).toBeGreaterThan(0)
  expect(wet[5]).toBeLessThan(dry[5] * 0.2)
  expect(Math.hypot(wet[4], wet[6])).toBeLessThan(Math.hypot(dry[4], dry[6]) * 0.7)
})

test('a fast near-surface trajectory over a flat bed is not stopped by grid boundaries', async () => {
  const solver = new SandSolver(device, 64)
  await solver.initialize()
  try {
    device.queue.writeBuffer(solver.state, 0, bed(64, () => 0.08))
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([-0.04, 0.095, -0.03, 0.000004, 4.2, 0, 3.1, 0]))
    advance(solver)
    const particle = await read(solver.particles, 32)
    expect(particle[0]).toBeCloseTo(-0.04 + 4.2 * SAND.step, 6)
    expect(particle[2]).toBeCloseTo(-0.03 + 3.1 * SAND.step, 6)
    expect(particle[1]).toBeCloseTo(0.095 - 9.81 * SAND.step ** 2, 6)
    expect(particle[4]).toBeCloseTo(4.2, 6)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})

test('a grain on the contact skin moving away from the surface stays airborne', async () => {
  const solver = new SandSolver(device, 32)
  await solver.initialize()
  try {
    device.queue.writeBuffer(solver.state, 0, bed(32, () => 0.08))
    device.queue.writeBuffer(solver.particles, 0, new Float32Array([0, 0.08 + PARTICLE_CONTACT.clearance, 0, 0.000004, 0.2, 0.3, 0, 0]))
    advance(solver)
    const particle = await read(solver.particles, 32)
    expect(particle[3]).toBeCloseTo(0.000004, 9)
    expect(particle[1]).toBeGreaterThan(0.081)
    expect(particle[5]).toBeCloseTo(0.3 - 9.81 * SAND.step, 6)
    expect(errors).toEqual([])
  } finally { solver.dispose() }
})
