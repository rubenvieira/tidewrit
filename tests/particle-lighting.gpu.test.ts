import { expect, test } from 'vitest'
import { create, globals } from 'webgpu'
import { checkedShader } from '../src/platform/shader'
import { DAYLIGHTS } from '../src/render/daylight'
import { surfaceShader } from '../src/render/shaders'

test('airborne solar glints follow authored light energy, palm visibility, and kinetic material', async () => {
  Object.assign(globalThis, globals)
  const gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Particle lighting regression requires a WebGPU adapter.')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const uniform = device.createBuffer({ size: 60 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const shadow = device.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  const color = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const glint = device.createTexture({ size: [1, 1], format: 'r32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
  const staging = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  try {
    // Run the shipped fragment with a directly facing grain. Holding direction
    // fixed isolates incident light energy from the separate facet geometry.
    const module = await checkedShader(device, 'Airborne solar glint regression', `${surfaceShader}
      @vertex fn lightingFixture(@builtin(vertex_index) vertex: u32) -> GrainOutput {
        let corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        var output: GrainOutput;
        output.clip = vec4f(corners[vertex], 0.0, 1.0);
        output.local = vec2f(0.0);
        output.tint = 0.5;
        output.center = vec3f(0.0);
        output.radius = 0.00018;
        output.physicalRadius = 0.00018;
        output.trailRatio = 0.0;
        output.axis = vec2f(1.0, 0.0);
        return output;
      }
    `)
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module, entryPoint: 'lightingFixture' },
      fragment: { module, entryPoint: 'grainFragment', targets: [{ format: 'rgba32float' }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
    })
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 4, resource: device.createSampler() },
      { binding: 5, resource: shadow.createView() },
    ] })
    device.queue.writeTexture({ texture: shadow }, new Uint8Array([255]), { bytesPerRow: 1 }, [1, 1])
    const values = new Float32Array(60)
    values.set([0, 0, 0.1, 1, 0, 0, -1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    values.set([32, 0.8, 1, 1], 20)
    values.set([0, 0, 1, 1], 28)
    values.set([1, 1, 1, 0], 48)
    values.set([0.72, 0.57, 0.35, 0], 56)
    const afternoon = DAYLIGHTS[0].sun
    const night = DAYLIGHTS.find((preset) => preset.id === 'night')!.sun
    const cases = [
      { name: 'afternoon', light: afternoon, opacity: 0, kinetic: 0 },
      { name: 'half light', light: afternoon.map((value) => value * 0.5), opacity: 0, kinetic: 0 },
      { name: 'night', light: night, opacity: 0, kinetic: 0 },
      { name: 'no direct light', light: [0, 0, 0], opacity: 0, kinetic: 0 },
      { name: 'half sparkle visibility', light: afternoon, opacity: 0.17, kinetic: 0 },
      { name: 'palm shade', light: afternoon, opacity: 0.82, kinetic: 0 },
      { name: 'fully blocked', light: afternoon, opacity: 1, kinetic: 0 },
      { name: 'kinetic', light: afternoon, opacity: 0, kinetic: 1 },
    ]
    const results = new Map<string, { glint: number; color: number[] }>()
    for (const sample of cases) {
      values[32] = sample.opacity
      values.set(sample.light, 44)
      values[52] = sample.kinetic
      device.queue.writeBuffer(uniform, 0, values)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({ colorAttachments: [color, glint].map((texture) => ({
        view: texture.createView(), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] as GPUColor,
      })), depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 } })
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.draw(3); pass.end()
      encoder.copyTextureToBuffer({ texture: glint }, { buffer: staging, bytesPerRow: 256 }, [1, 1])
      encoder.copyTextureToBuffer({ texture: color }, { buffer: staging, offset: 256, bytesPerRow: 256 }, [1, 1])
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const output = new Float32Array(staging.getMappedRange())
      results.set(sample.name, { glint: output[0], color: Array.from(output.slice(64, 68)) })
      staging.unmap()
    }
    const baseline = results.get('afternoon')!.glint
    // Existing directly facing afternoon lobe: Fresnel .04 × alpha .94 × .18.
    expect(baseline).toBeCloseTo(0.04 * 0.94 * 0.18, 7)
    expect(results.get('half light')!.glint / baseline).toBeCloseTo(0.5, 6)
    const luminance = (light: readonly number[]) => light[0] * 0.2126 + light[1] * 0.7152 + light[2] * 0.0722
    expect(results.get('night')!.glint / baseline).toBeCloseTo(luminance(night) / luminance(afternoon), 6)
    expect(results.get('no direct light')!.glint).toBe(0)
    expect(results.get('no direct light')!.color[0]).toBeGreaterThan(0)
    expect(results.get('half sparkle visibility')!.glint / baseline).toBeCloseTo(0.5, 5)
    expect(results.get('palm shade')!.glint).toBe(0)
    expect(results.get('fully blocked')!.glint).toBe(0)
    expect(results.get('kinetic')!.glint / baseline).toBeCloseTo(0.08, 6)
    for (const result of results.values()) expect(result.color[3]).toBeCloseTo(0.94, 6)
    expect(errors).toEqual([])
  } finally { uniform.destroy(); shadow.destroy(); color.destroy(); glint.destroy(); depth.destroy(); staging.destroy(); device.destroy() }
})
