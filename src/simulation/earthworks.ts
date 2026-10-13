import { DIG, KINETIC, MOLD, SAND, WATER, type Point } from '../config'
import { checkedShader } from '../platform/shader'
import { toolFootprints } from './footprints'

export type DigOp = { x: number; y: number; radius: number; volume: number; spoil: Point; spoilRadius: number; wetness: number }
export type MoldOp = { x: number; y: number; radius: number; angle: number; shape: number; wetness: number }

// Sand below this height above the floor is never dug, so a scoop that reaches
// the bottom just stops removing sand there.
const floorMargin = 0.002
const spacing = SAND.extent / SAND.resolution
const headerVectors = 5
const uniformVectors = headerVectors + DIG.maxPerFrame * 3 + MOLD.maxPerFrame * 2

// Digging is two passes. `excavate` removes a bowl-shaped scoop
// (1 - r²/R²)², limited by the sand actually present, and sums what each dig
// removed in fixed point. `spoil` spreads exactly that total over a truncated
// Gaussian heap, whose discrete normalization the CPU computes over the same
// cells, so digging conserves sand to rounding regardless of where a scoop
// bottoms out. Molds raise packed damp sand to the ground level under their
// center plus their shape.
const earthworksShader = `
${toolFootprints}
struct Earthworks {
  grid: vec4f,
  digRegion: vec4f,
  spoilRegion: vec4f,
  moldRegion: vec4f,
  counts: vec4f,
  digs: array<vec4f, ${DIG.maxPerFrame * 3}>,
  molds: array<vec4f, ${MOLD.maxPerFrame * 2}>,
}
@group(0) @binding(0) var<uniform> params: Earthworks;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> moisture: array<f32>;
@group(0) @binding(3) var<storage, read_write> dug: array<atomic<i32>, ${DIG.maxPerFrame}>;
@group(0) @binding(4) var<storage, read_write> moldGround: array<f32, ${MOLD.maxPerFrame}>;
@group(0) @binding(5) var<storage, read_write> packing: array<f32>;

fn cellIn(region: vec4f, invocation: vec3u) -> vec3i {
  if (f32(invocation.x) >= region.z || f32(invocation.y) >= region.w) { return vec3i(-1); }
  let cell = vec2u(region.xy) + invocation.xy;
  let resolution = u32(params.grid.x);
  if (any(cell >= vec2u(resolution))) { return vec3i(-1); }
  return vec3i(vec2i(cell), i32(cell.y * resolution + cell.x));
}
fn positionOf(cell: vec2i) -> vec2f {
  return (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
}

@compute @workgroup_size(8, 8)
fn excavate(@builtin(global_invocation_id) invocation: vec3u) {
  let cell = cellIn(params.digRegion, invocation);
  if (cell.z < 0) { return; }
  let position = positionOf(cell.xy);
  var height = state[cell.z].x;
  for (var dig = 0u; dig < u32(params.counts.x); dig++) {
    let scoop = params.digs[dig * 3u];
    let offset = position - scoop.xy;
    let fraction = dot(offset, offset) / max(scoop.z * scoop.z, 1e-12);
    if (fraction >= 1.0) { continue; }
    let request = scoop.w * (1.0 - fraction) * (1.0 - fraction);
    let units = i32(floor(min(request, max(0.0, height - params.grid.w)) * 1e9));
    height -= f32(units) * 1e-9;
    atomicAdd(&dug[dig], units);
  }
  state[cell.z].x = height;
}

@compute @workgroup_size(8, 8)
fn spoil(@builtin(global_invocation_id) invocation: vec3u) {
  let cell = cellIn(params.spoilRegion, invocation);
  if (cell.z < 0) { return; }
  let position = positionOf(cell.xy);
  var height = state[cell.z].x;
  var wetness = moisture[cell.z];
  var packed = packing[cell.z];
  for (var dig = 0u; dig < u32(params.counts.x); dig++) {
    let heap = params.digs[dig * 3u + 1u];
    let offset = position - heap.xy;
    let spread = dot(offset, offset) / max(heap.z * heap.z, 1e-12);
    if (spread >= 9.0) { continue; }
    let added = f32(atomicLoad(&dug[dig])) * 1e-9 * exp(-spread) * heap.w;
    height += added;
    // Loose spoil mixes into the surface layer by volume.
    wetness = (wetness * ${WATER.surfaceLayer} + params.digs[dig * 3u + 2u].x * added) / (${WATER.surfaceLayer} + added);
    packed = (packed * ${WATER.surfaceLayer} + ${KINETIC.loosePacking} * added) / (${WATER.surfaceLayer} + added);
  }
  state[cell.z].x = height;
  moisture[cell.z] = wetness;
  packing[cell.z] = packed;
}

// Each mold stands on the ground under its center: it raises sand up to that
// level plus its shape and never stacks onto sand already higher, so a bucket
// beside a tower merges with it instead of doubling the shared wall.
@compute @workgroup_size(${MOLD.maxPerFrame})
fn moldBase(@builtin(local_invocation_index) index: u32) {
  if (index >= u32(params.counts.y)) { return; }
  let center = params.molds[index * 2u].xy;
  let resolution = i32(params.grid.x);
  let cell = clamp(vec2i(floor((center + params.grid.z * 0.5) / params.grid.y)), vec2i(0), vec2i(resolution - 1));
  moldGround[index] = state[cell.y * resolution + cell.x].x;
}

@compute @workgroup_size(8, 8)
fn mold(@builtin(global_invocation_id) invocation: vec3u) {
  let cell = cellIn(params.moldRegion, invocation);
  if (cell.z < 0) { return; }
  let position = positionOf(cell.xy);
  var height = state[cell.z].x;
  var wetness = moisture[cell.z];
  var packed = packing[cell.z];
  for (var index = 0u; index < u32(params.counts.y); index++) {
    let placement = params.molds[index * 2u];
    let detail = params.molds[index * 2u + 1u];
    let local = headingFrame(position - placement.xy, placement.w) / max(placement.z, 1e-7);
    if (dot(local, local) > 2.0) { continue; }
    let shape = moldShape(u32(detail.x + 0.5), local);
    let molded = moldGround[index] + shape.y * placement.z;
    if (shape.y <= 0.0 || molded <= height) { continue; }
    height = molded;
    wetness = max(wetness, detail.y);
    packed = ${KINETIC.moldPacking};
  }
  state[cell.z].x = height;
  moisture[cell.z] = wetness;
  packing[cell.z] = packed;
}
`

type Region = [number, number, number, number]

/** Exact cell bounds of a disk, clamped to the grid. */
function region(boxes: { x: number; y: number; reach: number }[], resolution: number): Region {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const toCell = (value: number) => (value + SAND.extent / 2) / spacing - 0.5
  for (const box of boxes) {
    x0 = Math.min(x0, Math.floor(toCell(box.x - box.reach)) - 1); x1 = Math.max(x1, Math.ceil(toCell(box.x + box.reach)) + 2)
    y0 = Math.min(y0, Math.floor(toCell(box.y - box.reach)) - 1); y1 = Math.max(y1, Math.ceil(toCell(box.y + box.reach)) + 2)
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(resolution, x1); y1 = Math.min(resolution, y1)
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
}

/** Inverse of the truncated Gaussian's sum over the cells the spoil pass visits. */
export function spoilNormalization(center: Point, sigma: number, area: Region) {
  let sum = 0
  for (let row = area[1]; row < area[1] + area[3]; row++) {
    const dy = (row + 0.5) * spacing - SAND.extent / 2 - center.y
    for (let column = area[0]; column < area[0] + area[2]; column++) {
      const dx = (column + 0.5) * spacing - SAND.extent / 2 - center.x
      const spread = (dx * dx + dy * dy) / (sigma * sigma)
      if (spread < 9) sum += Math.exp(-spread)
    }
  }
  return sum > 0 ? 1 / sum : 0
}

export class SandEarthworks {
  private readonly uniform: GPUBuffer
  private readonly dug: GPUBuffer
  private readonly moldGround: GPUBuffer
  private readonly data = new Float32Array(uniformVectors * 4)
  private pipelines!: Record<'excavate' | 'spoil' | 'moldBase' | 'mold', GPUComputePipeline>
  private groups!: Record<'excavate' | 'spoil' | 'moldBase' | 'mold', GPUBindGroup[]>

  private readonly device: GPUDevice
  private readonly resolution: number
  private readonly moisture: GPUBuffer[]
  private readonly packing: GPUBuffer[]
  constructor(device: GPUDevice, resolution: number, moisture: GPUBuffer[], packing: GPUBuffer[]) {
    this.device = device
    this.resolution = resolution
    this.moisture = moisture
    this.packing = packing
    this.uniform = device.createBuffer({ label: 'Earthworks', size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.dug = device.createBuffer({ label: 'Dug volume', size: DIG.maxPerFrame * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.moldGround = device.createBuffer({ label: 'Mold ground levels', size: MOLD.maxPerFrame * 4, usage: GPUBufferUsage.STORAGE })
  }

  async initialize(states: GPUBuffer[]) {
    const module = await checkedShader(this.device, 'Earthworks WGSL', earthworksShader)
    const layout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4, 5].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
    ] })
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const [excavate, spoil, moldBase, mold] = await Promise.all(['excavate', 'spoil', 'moldBase', 'mold'].map((entryPoint) =>
      this.device.createComputePipelineAsync({ label: `Earthworks ${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } })))
    this.pipelines = { excavate, spoil, moldBase, mold }
    const groups = states.map((state, index) => this.device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: state } },
      { binding: 2, resource: { buffer: this.moisture[index] } },
      { binding: 3, resource: { buffer: this.dug } },
      { binding: 4, resource: { buffer: this.moldGround } },
      { binding: 5, resource: { buffer: this.packing[index] } },
    ] }))
    this.groups = { excavate: groups, spoil: groups, moldBase: groups, mold: groups }
  }

  /** Digs and molds against the current state. Returns whether anything changed. */
  encode(encoder: GPUCommandEncoder, digs: readonly DigOp[], molds: readonly MoldOp[], current: number) {
    const digBatch = digs.filter((dig) => dig.volume > 0).slice(0, DIG.maxPerFrame)
    const moldBatch = molds.slice(0, MOLD.maxPerFrame)
    if (!digBatch.length && !moldBatch.length) return false
    const digRegion = region(digBatch.map((dig) => ({ x: dig.x, y: dig.y, reach: dig.radius })), this.resolution)
    const spoilRegion = region(digBatch.map((dig) => ({ x: dig.spoil.x, y: dig.spoil.y, reach: dig.spoilRadius * 3 })), this.resolution)
    const moldRegion = region(moldBatch.map((mold) => ({ x: mold.x, y: mold.y, reach: mold.radius * 1.42 })), this.resolution)
    this.data.fill(0)
    this.data.set([this.resolution, spacing, SAND.extent, SAND.floor + floorMargin, ...digRegion, ...spoilRegion, ...moldRegion, digBatch.length, moldBatch.length, 0, 0])
    digBatch.forEach((dig, index) => {
      // The bowl (1 - r²/R²)² holds π·R²/3 of volume per unit peak depth.
      const peak = dig.volume / (Math.PI * dig.radius * dig.radius / 3)
      const offset = (headerVectors + index * 3) * 4
      this.data.set([dig.x, dig.y, dig.radius, peak, dig.spoil.x, dig.spoil.y, dig.spoilRadius, spoilNormalization(dig.spoil, dig.spoilRadius, spoilRegion), dig.wetness, 0, 0, 0], offset)
    })
    moldBatch.forEach((mold, index) => {
      this.data.set([mold.x, mold.y, mold.radius, mold.angle, mold.shape, mold.wetness, 0, 0], (headerVectors + DIG.maxPerFrame * 3 + index * 2) * 4)
    })
    this.device.queue.writeBuffer(this.uniform, 0, this.data)
    const dispatch = (pass: GPUComputePassEncoder, name: 'excavate' | 'spoil' | 'mold', area: Region) => {
      if (!area[2] || !area[3]) return
      pass.setPipeline(this.pipelines[name])
      pass.setBindGroup(0, this.groups[name][current])
      pass.dispatchWorkgroups(Math.ceil(area[2] / 8), Math.ceil(area[3] / 8))
    }
    if (digBatch.length) {
      encoder.clearBuffer(this.dug)
      // Separate passes order the excavation before the spoil reads its totals.
      let pass = encoder.beginComputePass({ label: 'Excavate' })
      dispatch(pass, 'excavate', digRegion)
      pass.end()
      pass = encoder.beginComputePass({ label: 'Spoil' })
      dispatch(pass, 'spoil', spoilRegion)
      pass.end()
    }
    if (moldBatch.length) {
      // Ground levels are read in their own pass, before any mold raises sand.
      let pass = encoder.beginComputePass({ label: 'Mold ground' })
      pass.setPipeline(this.pipelines.moldBase)
      pass.setBindGroup(0, this.groups.moldBase[current])
      pass.dispatchWorkgroups(1)
      pass.end()
      pass = encoder.beginComputePass({ label: 'Molds' })
      dispatch(pass, 'mold', moldRegion)
      pass.end()
    }
    return true
  }

  dispose() { this.uniform.destroy(); this.dug.destroy(); this.moldGround.destroy() }
}
