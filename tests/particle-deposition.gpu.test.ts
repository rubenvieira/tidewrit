import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { POUR, SAND } from '../src/config'
import { checkedShader } from '../src/platform/shader'
import { particleShader } from '../src/simulation/shaders'

let device: GPUDevice
let gpu: GPU
let pipeline: GPUComputePipeline
let probePipeline: GPUComputePipeline
let group: GPUBindGroup
let probeGroup: GPUBindGroup
let particles: GPUBuffer
let ledger: GPUBuffer
const resources: GPUBuffer[] = []
const errors: string[] = []
const resolution = 8
const extent = 1
const spacing = extent / resolution
const world = (coordinate: number) => (coordinate + 0.5) * spacing - extent / 2
const cell = (x: number, y: number) => y * resolution + x

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Particle deposition tests require WebGPU access')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const buffer = (size: number, uniform = false) => {
    const result = device.createBuffer({ size, usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
    resources.push(result)
    return result
  }
  const parameters = new Float32Array((4 + POUR.maxEmitters + SAND.maxContacts * 3) * 4)
  parameters.set([resolution, spacing, extent, SAND.step, SAND.depth, SAND.floor, SAND.repose, SAND.dynamicRepose])
  const uniform = buffer(parameters.byteLength, true)
  device.queue.writeBuffer(uniform, 0, parameters)
  const bed = buffer(resolution ** 2 * 16)
  const flat = new Float32Array(resolution ** 2 * 4)
  for (let index = 0; index < flat.length; index += 4) flat[index] = SAND.depth
  device.queue.writeBuffer(bed, 0, flat)
  const flux = buffer(resolution ** 2 * 32)
  particles = buffer(32)
  ledger = buffer(resolution ** 2 * 8)
  const contact = buffer(resolution ** 2 * 16)
  const pressure = buffer(resolution ** 2 * 4)
  const moisture = buffer(resolution ** 2 * 4)
  // The production animate entry point covers real settling. A second entry
  // exercises that same shipped deposition function at clamped mesh edges,
  // independently of the trajectory solver's intentionally inset tray walls.
  const module = await checkedShader(device, 'Particle deposition regressions', `${particleShader}
    @compute @workgroup_size(1) fn depositionProbe() {
      depositGrain(grains[0].position.xz, grains[0].position.w);
    }
  `)
  ;[pipeline, probePipeline] = await Promise.all([
    device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'animate' } }),
    device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'depositionProbe' } }),
  ])
  group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: bed } },
    { binding: 2, resource: { buffer: flux } }, { binding: 3, resource: { buffer: particles } },
    { binding: 4, resource: { buffer: ledger } }, { binding: 5, resource: { buffer: contact } },
    { binding: 6, resource: { buffer: pressure } }, { binding: 8, resource: { buffer: moisture } },
  ] })
  probeGroup = device.createBindGroup({ layout: probePipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uniform } }, { binding: 3, resource: { buffer: particles } },
    { binding: 4, resource: { buffer: ledger } },
  ] })
})
afterAll(() => { resources.forEach((buffer) => buffer.destroy()); device?.destroy() })

async function read(buffer: GPUBuffer) {
  const staging = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size)
  device.queue.submit([encoder.finish()])
  await staging.mapAsync(GPUMapMode.READ)
  const data = staging.getMappedRange().slice(0)
  staging.unmap()
  staging.destroy()
  return data
}
async function land(x: number, y: number, units = 8000, probe = false) {
  device.queue.writeBuffer(particles, 0, new Float32Array([x, SAND.depth + 0.00015, y, units * 1e-9, 0, -0.05, 0, 0.3]))
  const encoder = device.createCommandEncoder()
  encoder.clearBuffer(ledger)
  const pass = encoder.beginComputePass()
  pass.setPipeline(probe ? probePipeline : pipeline)
  pass.setBindGroup(0, probe ? probeGroup : group)
  pass.dispatchWorkgroups(1)
  pass.end()
  device.queue.submit([encoder.finish()])
  const result = new Int32Array(await read(ledger))
  expect([...result].reduce((sum, amount) => sum + amount, 0)).toBe(units)
  expect([...result].every((amount) => amount >= 0)).toBe(true)
  expect([...result.slice(resolution ** 2)].every((amount) => amount === 0)).toBe(true)
  if (!probe) expect(new Float32Array(await read(particles))[3]).toBe(0)
  expect(errors).toEqual([])
  return result.slice(0, resolution ** 2)
}
function centerOfMass(amounts: Int32Array) {
  let x = 0, y = 0, total = 0
  amounts.forEach((amount, index) => {
    x += amount * world(index % resolution)
    y += amount * world(Math.floor(index / resolution))
    total += amount
  })
  return { x: x / total, y: y / total }
}

test.each([
  [3.25, 3.125, [[3, 3, 5000], [4, 3, 2000], [3, 4, 1000]]],
  [3.75, 3.875, [[4, 4, 5000], [3, 4, 2000], [4, 3, 1000]]],
] as const)('settling at grid point (%s, %s) returns mass to its three contact vertices', async (x, y, expected) => {
  const amounts = await land(world(x), world(y))
  const reference = new Int32Array(resolution ** 2)
  for (const [column, row, amount] of expected) reference[cell(column, row)] = amount
  expect(amounts).toEqual(reference)
  expect(centerOfMass(amounts)).toEqual({ x: world(x), y: world(y) })
})

test.each([1, 2, 3, 7, 10001])('a parcel of %s fixed-point units returns its exact total with bounded centroid error', async (units) => {
  const x = world(3.25), y = world(3.125)
  const amounts = await land(x, y, units)
  expect(amounts[cell(3, 3)]).toBe(Math.floor(units * 0.625))
  expect(amounts[cell(4, 3)]).toBe(Math.floor(units * 0.25))
  expect(amounts[cell(3, 4)]).toBe(units - Math.floor(units * 0.625) - Math.floor(units * 0.25))
  const centroid = centerOfMass(amounts)
  expect(Math.abs(centroid.x - x)).toBeLessThanOrEqual(2 * spacing / units)
  expect(Math.abs(centroid.y - y)).toBeLessThanOrEqual(2 * spacing / units)
})

test.each([
  [-0.5, -0.5, [[0, 0, 8000]]],
  [0.5, 0.5, [[7, 7, 8000]]],
  [-0.5, world(2.75), [[0, 2, 2000], [0, 3, 6000]]],
  [0.5, world(2.25), [[7, 2, 6000], [7, 3, 2000]]],
  [world(2.25), -0.5, [[2, 0, 6000], [3, 0, 2000]]],
  [world(2.75), 0.5, [[2, 7, 2000], [3, 7, 6000]]],
] as const)('mesh boundary deposition at (%s, %s) stays on valid edge vertices', async (x, y, expected) => {
  const amounts = await land(x, y, 8000, true)
  const reference = new Int32Array(resolution ** 2)
  for (const [column, row, amount] of expected) reference[cell(column, row)] = amount
  expect(amounts).toEqual(reference)
})

test.each([
  { label: 'triangle diagonal', x: 3.5, y: 3.5 },
  { label: 'cell border', x: 4, y: 3.25 },
])('landing distribution stays continuous across the $label', async ({ x, y }) => {
  const epsilon = 1 / 4096
  const units = 16384
  const before = await land(world(x - epsilon), world(y), units)
  const after = await land(world(x + epsilon), world(y), units)
  let difference = 0
  before.forEach((amount, index) => { difference += Math.abs(amount - after[index]) })
  expect(difference).toBeLessThanOrEqual(4 * epsilon * units + 4)
  const first = centerOfMass(before), second = centerOfMass(after)
  expect(first.x).toBeLessThan(second.x)
  expect(Math.abs(first.x - world(x - epsilon))).toBeLessThanOrEqual(2 * spacing / units)
  expect(Math.abs(second.x - world(x + epsilon))).toBeLessThanOrEqual(2 * spacing / units)
})
