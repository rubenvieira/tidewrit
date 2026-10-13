import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { SAND } from '../src/config'
import { checkedShader } from '../src/platform/shader'
import { AirborneShadow } from '../src/render/airborne-shadow'
import { horizonOcclusionWgsl } from '../src/render/horizon-occlusion'
import { particleOpticsWgsl } from '../src/render/particle-optics'
import { SandSolver } from '../src/simulation/solver'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []
beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Optical regressions require a WebGPU adapter.')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

async function computeRows(helpers: string, body: string, input: Float32Array) {
  const source = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const destination = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const staging = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  try {
    const module = await checkedShader(device, 'Optical math regression', `
      ${helpers}
      @group(0) @binding(0) var<storage, read> source: array<vec4f>;
      @group(0) @binding(1) var<storage, read_write> destination: array<vec4f>;
      @compute @workgroup_size(32)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x >= arrayLength(&source)) { return; }
        let input = source[id.x];
        ${body}
      }
    `)
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
    ] })
    device.queue.writeBuffer(source, 0, input)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(input.length / 128)); pass.end()
    encoder.copyBufferToBuffer(destination, 0, staging, 0, input.byteLength)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const output = new Float32Array(staging.getMappedRange()).slice()
    staging.unmap()
    expect(errors).toEqual([])
    return output
  } finally { source.destroy(); destination.destroy(); staging.destroy() }
}

test('bounded particle trails end at the simulated grain across speeds and pixel footprints', async () => {
  const cases = [[0, 0], [0.02, 0.03], [-0.4, 0.3], [4, -3], [0, 8]]
    .flatMap(([x, y]) => [0.00008, 0.0004, 0.002].map((pixel) => [x, y, pixel, 0]))
  const output = await computeRows(particleOpticsWgsl, `
    let trail = particleTrail(input.xy, input.z);
    destination[id.x] = vec4f(trail.axis * trail.halfLength, trail.centerOffset);
  `, new Float32Array(cases.flat()))
  for (const [index, [x, y, pixel]] of cases.entries()) {
    const half = output.slice(index * 4, index * 4 + 2)
    const center = output.slice(index * 4 + 2, index * 4 + 4)
    const speed = Math.hypot(x, y)
    const halfLength = Math.hypot(...half)
    expect(halfLength).toBeCloseTo(Math.min(speed * 0.0035 / 2, pixel * 3), 8)
    // Leading endpoint must be the original particle center, even when the
    // authored shutter would otherwise produce a much longer capped trail.
    expect(center[0] + half[0]).toBeCloseTo(0, 9)
    expect(center[1] + half[1]).toBeCloseTo(0, 9)
    expect(Math.hypot(center[0] - half[0], center[1] - half[1])).toBeLessThanOrEqual(pixel * 6 + 1e-8)
    if (speed * 0.0035 / 2 <= pixel * 3) {
      expect(center[0]).toBeCloseTo(-x * 0.0035 / 2, 8)
      expect(center[1]).toBeCloseTo(-y * 0.0035 / 2, 8)
    }
  }
})

test('algebraic horizon occlusion matches the clamped angular reference including steep opposing slopes', async () => {
  const slopes = [-10000, -100, -10, -3, -1, -0.2, 0, 0.2, 1, 3, 10, 100, 10000]
  const cases = slopes.flatMap((tangent) => slopes.map((highest) => [tangent, highest, 0, 0]))
  const input = new Float32Array(cases.flat())
  const output = await computeRows(horizonOcclusionWgsl, `
    destination[id.x] = vec4f(horizonOcclusionSquared(input.x, input.y), 0.0, 0.0, 0.0);
  `, input)
  for (let index = 0; index < cases.length; index++) {
    const tangent = input[index * 4]
    const highest = input[index * 4 + 1]
    const angle = Math.max(0, Math.min(Math.PI / 2, Math.atan(highest) - Math.atan(tangent)))
    expect(output[index * 4]).toBeGreaterThanOrEqual(0)
    expect(output[index * 4]).toBeLessThanOrEqual(1)
    expect(Math.abs(output[index * 4] - Math.sin(angle) ** 2)).toBeLessThan(3e-6)
  }
})

test.each([1, 8])('airborne shadow conserves filtered energy with altitude for a %s× reference parcel', async (massScale) => {
  // The shadow needs only the particle buffers, so no simulation dispatch or
  // initialized bed is needed for this rendering fixture.
  const solver = new SandSolver(device, 8)
  const shadow = new AirborneShadow(device, solver)
  const resolution = SAND.airborneShadowResolution
  const staging = device.createBuffer({ size: resolution ** 2 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const centers: Array<{ x: number; y: number }> = []
  const particles = new Float32Array(solver.particleCount * 8)
  // Sixty-four isolated footprints sample an 8×8 subtexel phase grid. Their
  // full penumbrae stay inside the bed and never overlap or saturate together.
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
    const center = { x: 128 + column * 24 + 12 + (column + 0.5) / 8, y: 128 + row * 24 + 12 + (row + 0.5) / 8 }
    const index = row * 8 + column
    centers.push(center)
    particles[index * 8] = (center.x / resolution - 0.5) * SAND.extent
    particles[index * 8 + 2] = (0.5 - center.y / resolution) * SAND.extent
    particles[index * 8 + 3] = SAND.airborneReferenceMass * massScale
  }
  try {
    await shadow.initialize()
    const energies: number[] = []
    const widths: number[] = []
    for (const altitude of [0, 0.08, 0.4]) {
      for (let index = 0; index < centers.length; index++) particles[index * 8 + 1] = SAND.depth + altitude
      device.queue.writeBuffer(solver.particles, 0, particles)
      const encoder = device.createCommandEncoder()
      shadow.encode(encoder, [0, 1, 0])
      encoder.copyTextureToBuffer({ texture: shadow.texture }, { buffer: staging, bytesPerRow: resolution * 4 }, [resolution, resolution])
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const pixels = new Uint8Array(staging.getMappedRange())
      let energy = 0
      let secondMoment = 0
      for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
        const value = pixels[(y * resolution + x) * 4] / 255
        if (value === 0) continue
        const column = Math.floor((x - 128) / 24)
        const row = Math.floor((y - 128) / 24)
        expect(column).toBeGreaterThanOrEqual(0); expect(column).toBeLessThan(8)
        expect(row).toBeGreaterThanOrEqual(0); expect(row).toBeLessThan(8)
        const center = centers[row * 8 + column]
        energy += value
        secondMoment += value * ((x + 0.5 - center.x) ** 2 + (y + 0.5 - center.y) ** 2)
      }
      staging.unmap()
      expect(energy).toBeGreaterThan(0)
      energies.push(energy)
      widths.push(secondMoment / energy)
    }
    // RGBA8 quantization and finite phase sampling are expected; altitude
    // must not change the integrated light budget beyond that small tolerance.
    for (const energy of energies) expect(Math.abs(energy / energies[0] - 1)).toBeLessThan(0.08)
    expect(widths[2]).toBeGreaterThan(widths[0] * 1.6)
    expect(errors).toEqual([])
  } finally { shadow.dispose(); solver.dispose(); staging.destroy() }
})
