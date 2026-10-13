import { afterAll, beforeAll, expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { grainReliefWgsl } from '../src/render/grain-relief'
import { surfaceShader } from '../src/render/shaders'
import { checkedShader } from '../src/platform/shader'

let device: GPUDevice
let gpu: GPU
const errors: string[] = []

beforeAll(async () => {
  Object.assign(globalThis, globals)
  gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Rendering regressions require a WebGPU adapter.')
  device = await adapter.requestDevice()
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
})
afterAll(() => { device?.destroy() })

test('grain relief follows the ellipse gradient and stays tangent on steep and wet faces', async () => {
  const cases = [0, 0.47, 1.83].flatMap((angle) => [0.78, 1, 1.27].flatMap((aspect) => [0, 0.5, 1].map((film) => ({ angle, aspect, film }))))
  const values = new Float32Array(cases.length * 16)
  for (const [index, sample] of cases.entries()) {
    const slope = index % 3 === 0 ? 0 : index % 3 === 1 ? 2 : -8
    const normalLength = Math.hypot(slope, 1, 0.4)
    values.set([
      Math.cos(sample.angle), Math.sin(sample.angle), sample.aspect, 0,
      0.21, -0.32, sample.film, (index % 3) / 2,
      slope / normalLength, 1 / normalLength, 0.4 / normalLength, index % 2,
      0.4, -0.7, 0.3, 0,
    ], index * 16)
  }
  const source = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const destination = device.createBuffer({ size: cases.length * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const staging = device.createBuffer({ size: destination.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  try {
    const module = await checkedShader(device, 'Numerical grain relief regression', `
      ${grainReliefWgsl}
      @group(0) @binding(0) var<storage, read> source: array<vec4f>;
      @group(0) @binding(1) var<storage, read_write> destination: array<vec4f>;
      @compute @workgroup_size(32)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x * 4u >= arrayLength(&source)) { return; }
        let shape = source[id.x * 4u];
        let state = source[id.x * 4u + 1u];
        let surface = source[id.x * 4u + 2u];
        let facet = source[id.x * 4u + 3u].xyz;
        let perpendicular = vec2f(-shape.y, shape.x);
        let local = vec2f(dot(state.xy, shape.xy) / shape.z, dot(state.xy, perpendicular) * shape.z);
        let gradient = grainMetricGradient(shape.xy, local, shape.z);
        let scale = grainReliefScale(state.z, state.w, surface.w);
        let tangent = tangentRelief(surface.xyz, facet) * scale;
        let normal = normalize(surface.xyz + tangent);
        destination[id.x * 3u] = vec4f(gradient, scale, dot(tangent, surface.xyz));
        destination[id.x * 3u + 1u] = vec4f(normal, dot(normal, surface.xyz));
        destination[id.x * 3u + 2u] = vec4f(tangent, 0.000126 * scale);
      }
    `)
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
    ] })
    device.queue.writeBuffer(source, 0, values)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(1); pass.end()
    encoder.copyBufferToBuffer(destination, 0, staging, 0, destination.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const output = new Float32Array(staging.getMappedRange())
    for (const [index, sample] of cases.entries()) {
      // Independent finite differences of the elliptical crown metric, across
      // rotated round and elongated grains, catch a missing chain-rule factor.
      const metric = (x: number, y: number) => ((x * Math.cos(sample.angle) + y * Math.sin(sample.angle)) ** 2 / sample.aspect ** 2
        + (-x * Math.sin(sample.angle) + y * Math.cos(sample.angle)) ** 2 * sample.aspect ** 2) / 2
      const epsilon = 1e-5
      const base = index * 12
      expect(output[base]).toBeCloseTo((metric(0.21 + epsilon, -0.32) - metric(0.21 - epsilon, -0.32)) / (2 * epsilon), 5)
      expect(output[base + 1]).toBeCloseTo((metric(0.21, -0.32 + epsilon) - metric(0.21, -0.32 - epsilon)) / (2 * epsilon), 5)
      expect(output[base + 3]).toBeCloseTo(0, 6)
      expect(Math.hypot(...output.slice(base + 4, base + 7))).toBeCloseTo(1, 6)
      expect(output[base + 7]).toBeGreaterThan(0)
      const scale = (1 - sample.film * 0.85) * (1 - 0.55 * values[index * 16 + 7] * values[index * 16 + 11])
      expect(output[base + 2]).toBeCloseTo(scale, 6)
      expect(output[base + 11]).toBeCloseTo(0.000126 * scale, 9)
      // Projection removes only the component parallel to the macro normal;
      // preserving the cross product also catches accidentally erased relief.
      const normal = values.slice(index * 16 + 8, index * 16 + 11)
      const facet = values.slice(index * 16 + 12, index * 16 + 15)
      const tangent = output.slice(base + 8, base + 11)
      for (let component = 0; component < 3; component++) {
        const next = (component + 1) % 3
        const last = (component + 2) % 3
        expect(tangent[next] * normal[last] - tangent[last] * normal[next])
          .toBeCloseTo((facet[next] * normal[last] - facet[last] * normal[next]) * scale, 6)
      }
    }
    staging.unmap()
    expect(errors).toEqual([])
  } finally { source.destroy(); destination.destroy(); staging.destroy() }
})

test('airborne fragment depth stays physical when the optical footprint grows', async () => {
  const uniform = device.createBuffer({ size: 16 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const shadow = device.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
  const color = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
  const glint = device.createTexture({ size: [1, 1], format: 'r16float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
  const depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const staging = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  try {
    // The shipped particle fragment runs unchanged; a fullscreen fixture puts
    // its center under the one framebuffer sample so depth can be read exactly.
    const module = await checkedShader(device, 'Physical grain depth regression', `${surfaceShader}
      @vertex fn fixture(@builtin(vertex_index) vertex: u32) -> GrainOutput {
        let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        var output: GrainOutput;
        output.clip = vec4f(corners[vertex], 0.0, 1.0);
        output.local = vec2f(0.0);
        output.tint = 0.5;
        output.center = vec3f(0.0);
        output.radius = view.pointer.x;
        output.physicalRadius = view.pointer.y;
        output.trailRatio = 0.0;
        output.axis = vec2f(1.0, 0.0);
        return output;
      }
    `)
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module, entryPoint: 'fixture' },
      fragment: { module, entryPoint: 'grainFragment', targets: [{ format: 'rgba16float' }, { format: 'r16float' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 4, resource: device.createSampler() },
      { binding: 5, resource: shadow.createView() },
    ] })
    const values = new Float32Array(64)
    values.set([0, 0, 0.1, 1, 0, 0, -1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])
    values.set([0, 0, 1, 1], 28)
    values.set([1, 1, 1, 0, 1, 1, 1, 0], 44)
    const physicalRadius = 0.00018
    const depths: number[] = []
    for (const opticalRadius of [physicalRadius, 0.001, 0.01]) {
      values.set([opticalRadius, physicalRadius, 0, 0], 24)
      device.queue.writeBuffer(uniform, 0, values)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({ colorAttachments: [color, glint].map((texture) => ({
        view: texture.createView(), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] as GPUColor,
      })), depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } })
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.draw(3); pass.end()
      encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer: staging, bytesPerRow: 256 }, [1, 1])
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      depths.push(new Float32Array(staging.getMappedRange())[0])
      staging.unmap()
    }
    const distance = 0.1 - physicalRadius
    for (const value of depths) expect(value).toBeCloseTo((distance * 1.001001 - 0.01001001) / distance, 6)
    expect(depths[1]).toBe(depths[0])
    expect(depths[2]).toBe(depths[0])
    expect(errors).toEqual([])
  } finally { uniform.destroy(); shadow.destroy(); color.destroy(); glint.destroy(); depth.destroy(); staging.destroy() }
})
