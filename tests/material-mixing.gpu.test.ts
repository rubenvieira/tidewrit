import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND, WATER } from '../src/config'
import { SandWater } from '../src/simulation/water'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
const size = 16
const count = size * size
const spacing = SAND.extent / size
const center = size / 2 * size + size / 2

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Material mixing tests require WebGPU access')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function fixture(wetness: number, height = 0.08, seconds = 0) {
  const states = [0, 1].map(() => device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }))
  const flux = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const contact = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE })
  const water = new SandWater(device, size)
  await water.initialize(states, flux, [uniform], contact)
  const bed = new Float32Array(count * 4)
  for (let index = 0; index < count; index++) bed[index * 4] = height
  const moisture = new Float32Array(count).fill(wetness)
  const flows = new Float32Array(count * 8)
  const params = new Float32Array(16)
  params.set([size, spacing, SAND.extent, seconds])
  device.queue.writeBuffer(uniform, 0, params)
  return {
    water, bed, moisture, flows,
    upload() {
      device.queue.writeBuffer(states[0], 0, bed)
      device.queue.writeBuffer(water.moisture[0], 0, moisture)
      device.queue.writeBuffer(flux, 0, flows)
    },
    dispose() { water.dispose(); for (const buffer of [...states, flux, uniform, contact]) buffer.destroy() },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function arriving(fixture: Fixture, direction: 'left' | 'up', amount: number, wetness: number) {
  const neighbor = center - (direction === 'left' ? 1 : size)
  fixture.moisture[neighbor] = wetness
  // Isolate the advected composition from capillary exchange across this
  // test link. Heights remain above groundwater and the damp subsurface.
  fixture.bed[neighbor * 4] = fixture.bed[center * 4] + 0.04
  fixture.flows[neighbor * 8 + (direction === 'left' ? 1 : 3)] = amount
}

async function read(buffer: GPUBuffer) {
  const staging = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, count * 4)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(staging.getMappedRange()).slice()
  staging.unmap()
  staging.destroy()
  expect(errors).toEqual([])
  return result
}

async function hydrate(fixture: Fixture) {
  fixture.upload()
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  fixture.water.encodeHydrate(pass, 0, 0)
  pass.end()
  device.queue.submit([encoder.finish()])
  return read(fixture.water.moisture[1])
}

test.each([0.08, 0.14])('moving dry sand onto a wet surface at height %s matches depositing the same volume', async (height) => {
  const transported = await fixture(0.55, height)
  const deposited = await fixture(0.55, height)
  const added = WATER.surfaceLayer
  try {
    arriving(transported, 'left', added, 0)
    const moved = await hydrate(transported)
    deposited.upload()
    const encoder = device.createCommandEncoder()
    deposited.water.encodeDeposits(encoder, [{ x: spacing * 0.5, y: spacing * 0.5, radius: 0.01, amount: 0, pit: 0, pitRadius: 0, sand: added }], 0)
    device.queue.submit([encoder.finish()])
    const poured = await read(deposited.water.moisture[0])
    expect(moved[center]).toBeCloseTo(0.55 * WATER.surfaceLayer / (WATER.surfaceLayer + added), 6)
    expect(moved[center]).toBeCloseTo(poured[center], 6)
  } finally { transported.dispose(); deposited.dispose() }
})

test('wet sand arriving on a dry surface mixes by its actual incoming volume', async () => {
  const field = await fixture(0)
  try {
    arriving(field, 'left', WATER.surfaceLayer, 0.8)
    const result = await hydrate(field)
    expect(result[center]).toBeCloseTo(0.4, 6)
    expect(result[0]).toBe(0)
  } finally { field.dispose() }
})

test('several incoming streams blend without overshooting their surface compositions', async () => {
  const field = await fixture(0.1)
  try {
    arriving(field, 'left', 0.007, 0.9)
    arriving(field, 'up', 0.003, 0.2)
    const result = await hydrate(field)
    const expected = (0.1 * WATER.surfaceLayer + 0.007 * 0.9 + 0.003 * 0.2) / (WATER.surfaceLayer + 0.01)
    expect(result[center]).toBeCloseTo(expected, 6)
    expect(result.every((value) => Number.isFinite(value) && value >= 0 && value <= WATER.maxMoisture)).toBe(true)
  } finally { field.dispose() }
})

test.each([0, 0.55, 1.4])('a stationary uniform surface at moisture %s retains the established drying response', async (wetness) => {
  const seconds = SAND.step
  const field = await fixture(wetness, 0.08, seconds)
  try {
    const result = await hydrate(field)
    const expected = Math.min(wetness, 1) * Math.exp(-seconds / WATER.dampEvaporation)
      + Math.max(0, wetness - 1) * Math.exp(-seconds / WATER.filmInfiltration)
    for (const value of result) expect(value).toBeCloseTo(expected, 6)
  } finally { field.dispose() }
})

test('outgoing-only sand keeps the local composition of the newly exposed surface', async () => {
  const field = await fixture(0, 0.12)
  try {
    field.moisture[center] = 0.8
    field.bed[center * 4] = 0.08
    field.flows[center * 8 + 1] = WATER.surfaceLayer * 4
    const result = await hydrate(field)
    expect(result[center]).toBeCloseTo(0.8, 6)
    expect(result[center + 1]).toBeCloseTo(0.8 * 0.02 / (WATER.surfaceLayer + 0.02), 6)
    expect(result.every((value) => Number.isFinite(value) && value >= 0 && value <= WATER.maxMoisture)).toBe(true)
  } finally { field.dispose() }
})
