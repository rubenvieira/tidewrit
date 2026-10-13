import { KINETIC, SAND, WATER, type Deposit } from '../config'
import { checkedShader } from '../platform/shader'
import { fluxLayout } from './flux'
import { sweptKernels } from './swept-kernels'

const dropParamVectors = 4 + WATER.maxDropsPerFrame * 3
const dropParamBytes = dropParamVectors * 16

// Impact pits use conservative local flux. Other deposits still need only the
// wet pass, over their bounding region; the ordinary solver overwrites this
// borrowed flux scratch before its next granular step.
const dropShader = `
${sweptKernels}
${fluxLayout}
struct DropParams {
  grid: vec4f,
  region: vec4f,
  impactRegion: vec4f,
  limits: vec4f,
  drops: array<vec4f, ${WATER.maxDropsPerFrame * 3}>,
}
@group(0) @binding(0) var<uniform> params: DropParams;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> moisture: array<f32>;
@group(0) @binding(3) var<storage, read_write> glow: array<f32>;
@group(0) @binding(4) var<storage, read_write> packing: array<f32>;
@group(0) @binding(5) var<storage, read_write> impactFlux: array<Flux>;

fn dropAddress(cell: vec2i) -> u32 {
  return u32(cell.y) * u32(params.grid.x) + u32(cell.x);
}
fn inImpactRegion(cell: vec2i) -> bool {
  return all(cell >= vec2i(params.impactRegion.xy)) && all(cell < vec2i(params.impactRegion.xy + params.impactRegion.zw));
}
struct ImpactPotentials { center: f32, adjacent: vec4f }
fn impactPotentials(position: vec2f) -> ImpactPotentials {
  var center = 0.0;
  var adjacent = vec4f(0.0);
  for (var drop = 0u; drop < u32(params.grid.w); drop++) {
    let shape = params.drops[drop * 3u];
    let impact = params.drops[drop * 3u + 1u];
    if (impact.x <= 0.0) { continue; }
    let prepared = params.drops[drop * 3u + 2u];
    let offset = position - shape.xy;
    let squared = dot(offset, offset);
    // The broad batch can contain distant drops. Only their one-cell halo
    // warrants Gaussian work; all radius/scale preparation happened on CPU.
    if (squared > prepared.w) { continue; }
    let radial = squared * prepared.z;
    if (radial < 9.0) {
      // The discrete Laplacian tends to -(1-r²) exp(-r²) as cells resolve the
      // drop. Sum overlapping pressure fields before choosing flow direction.
      center += impact.w * exp(-radial);
    }
    let axial = max(vec4f(0.0), (vec4f(squared + params.grid.y * params.grid.y)
      + vec4f(-offset.x, offset.x, -offset.y, offset.y) * (2.0 * params.grid.y)) * prepared.z);
    adjacent += impact.w * select(vec4f(0.0), exp(-axial), axial < vec4f(9.0));
  }
  return ImpactPotentials(center, adjacent);
}
@compute @workgroup_size(8, 8)
fn impact(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(vec2f(invocation.xy) >= params.impactRegion.zw)) { return; }
  let cell = vec2i(params.impactRegion.xy) + vec2i(invocation.xy);
  let position = (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
  let pressure = impactPotentials(position);
  var outgoing = max(vec4f(0.0), vec4f(pressure.center) - pressure.adjacent);
  for (var axis = 0u; axis < 4u; axis++) {
    if (!inImpactRegion(cell + neighbors[axis])) { outgoing[axis] = 0.0; }
  }
  let available = max(0.0, state[dropAddress(cell)].x - params.limits.y);
  let limiter = min(1.0, available / max(dot(outgoing, vec4f(1.0)), 1e-12));
  impactFlux[dropAddress(cell)].axial = outgoing * limiter;
}

@compute @workgroup_size(8, 8)
fn wet(@builtin(global_invocation_id) invocation: vec3u) {
  if (f32(invocation.x) >= params.region.z || f32(invocation.y) >= params.region.w) { return; }
  let cell = vec2u(params.region.xy) + invocation.xy;
  let resolution = u32(params.grid.x);
  if (any(cell >= vec2u(resolution))) { return; }
  let index = cell.y * resolution + cell.x;
  let position = (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
  var wetness = moisture[index];
  var height = state[index].x;
  var light = glow[index];
  var packed = packing[index];
  if (params.limits.z > 0.5 && inImpactRegion(vec2i(cell))) {
    var incoming = 0.0;
    for (var axis = 0u; axis < 4u; axis++) {
      let neighbor = vec2i(cell) + neighbors[axis];
      // Scratch outside this dispatch can contain an earlier simulation or
      // another drop; it must never enter this deposit's local exchange.
      if (inImpactRegion(neighbor)) { incoming += impactFlux[dropAddress(neighbor)].axial[axis ^ 1u]; }
    }
    height += incoming - dot(impactFlux[index].axial, vec4f(1.0));
  }
  for (var drop = 0u; drop < u32(params.grid.w); drop++) {
    let shape = params.drops[drop * 3u];
    let impact = params.drops[drop * 3u + 1u];
    let start = params.drops[drop * 3u + 2u].xy;
    let offset = position - shape.xy;
    let distanceSquared = dot(offset, offset);
    if (impact.z > 0.0) {
      // New dry sand mixes into the surface layer by volume before any water
      // the deposit carries is added.
      let added = impact.z * sweptGaussian(position, start, shape.xy, max(shape.z * 0.5, 1e-6), 12.0);
      height += added;
      wetness *= ${WATER.surfaceLayer} / (${WATER.surfaceLayer} + added);
      // Poured and dripped sand lands loose.
      packed = (packed * ${WATER.surfaceLayer} + ${KINETIC.loosePacking} * added) / (${WATER.surfaceLayer} + added);
    }
    let splash = shape.w * (1.0 - smoothstep(0.55, 1.0, sqrt(distanceSquared) / max(shape.z, 1e-7)));
    wetness += splash;
    // Landing water stirs the plankton it carries.
    light += splash * 0.8;
  }
  glow[index] = min(light, 1.5);
  packing[index] = packed;
  moisture[index] = min(wetness, params.limits.x);
  state[index].x = height;
}
`

// Runs after integration each substep. Incoming sand mixes into the same local
// surface layer used by deposits and packing; moisture is a surface composition,
// not a water inventory for the whole bed column. Capillary diffusion and film
// runoff then spread that field before drying and groundwater replenishment.
const hydrateShader = `
${fluxLayout}
struct Params { grid: vec4f, physics: vec4f, tool: vec4f, material: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> flux: array<Flux>;
@group(0) @binding(2) var<storage, read> source: array<vec4f>;
@group(0) @binding(3) var<storage, read> moistureSource: array<f32>;
@group(0) @binding(4) var<storage, read_write> moistureDestination: array<f32>;
@group(0) @binding(5) var<storage, read> contactField: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> glow: array<f32>;
@group(0) @binding(7) var<storage, read> packingSource: array<f32>;
@group(0) @binding(8) var<storage, read_write> packingDestination: array<f32>;

fn address(cell: vec2i) -> u32 {
  return u32(cell.y) * u32(params.grid.x) + u32(cell.x);
}
fn inside(cell: vec2i) -> bool {
  return all(cell >= vec2i(0)) && all(cell < vec2i(i32(params.grid.x)));
}
fn surfaceWater(index: u32) -> f32 {
  return max(0.0, moistureSource[index] - 1.0);
}

@compute @workgroup_size(8, 8)
fn hydrate(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let wetness = moistureSource[index];
  let height = source[index].x;
  var water = wetness * ${WATER.surfaceLayer};
  // Packing describes the surface layer. Sand a tool shoves into a cell is
  // compressed and keeps its packing; sand that arrives by flowing on its own
  // (slumping, creeping) tumbles loose. What stays keeps its packing.
  let shoved = params.tool.x > 0.0 && contactField[index].y > 0.05;
  let arrival = select(0.5, 1.0, shoved);
  var packed = packingSource[index] * ${WATER.surfaceLayer};
  var layer = ${WATER.surfaceLayer};
  var exchange = 0.0;
  let film = surfaceWater(index);
  for (var axis = 0u; axis < 8u; axis++) {
    let neighbor = cell + neighbors[axis];
    if (!inside(neighbor)) { continue; }
    let other = address(neighbor);
    let otherWetness = moistureSource[other];
    let amount = component(flux[other], axis ^ 1u);
    water += amount * otherWetness;
    packed += amount * packingSource[other] * arrival;
    layer += amount;
    if (axis >= 4u) { continue; }
    // Symmetric per-link exchanges before saturation clipping and drying.
    // Capillary wicking needs grain contact: cells at very different heights
    // (a castle wall and the beach beside it) touch only at the wall's foot.
    let contact = exp(-abs(height - source[other].x) / 0.002);
    exchange += 0.004 * contact * (otherWetness - wetness);
    let otherFilm = surfaceWater(other);
    let head = (height + film * ${WATER.filmThickness}) - (source[other].x + otherFilm * ${WATER.filmThickness});
    exchange -= clamp(head / ${WATER.filmThickness} * 0.25, -otherFilm * 0.24, film * 0.24);
  }
  let advected = water / layer;
  let mixed = max(0.0, advected + exchange);
  let damp = min(mixed, 1.0) * exp(-params.grid.w / ${WATER.dampEvaporation.toFixed(1)});
  let standing = max(0.0, mixed - 1.0) * exp(-params.grid.w / ${WATER.filmInfiltration.toFixed(1)});
  var result = min(damp + standing, ${WATER.maxMoisture});
  // Groundwater seeps into anything dug below the water table as a standing
  // pool, and keeps the capillary fringe just above it damp.
  let table = ${WATER.waterTable.toFixed(6)};
  if (height < table) {
    result = max(result, min(${WATER.maxMoisture}, 1.0 + (table - height) / ${WATER.filmThickness}));
  } else if (height < table + ${WATER.capillaryFringe}) {
    result = max(result, 0.75 * (1.0 - (height - table) / ${WATER.capillaryFringe}));
  }
  // Below the sun-dried top layer the beach is damp, so a hole dug deeper than
  // that exposes cohesive walls (finger strokes never reach this deep).
  let buried = ${SAND.depth.toFixed(6)} - height;
  result = max(result, ${WATER.subsurfaceWetness} * smoothstep(${WATER.dryLayer}, ${WATER.dryLayer + 0.015}, buried));
  moistureDestination[index] = result;

  // Bioluminescence: plankton in wet sand flash when the grains around them
  // are disturbed and fade within a couple of seconds. Moving tools stir more
  // than a still press; the disturbed shell around a contact glows faintly.
  var light = glow[index] * exp(-params.grid.w / ${WATER.glowFade.toFixed(3)});
  if (params.tool.x > 0.0) {
    let contact = contactField[index];
    let stir = contact.x * (0.35 + min(1.0, length(contact.zw) / 0.2)) + contact.y * 0.12;
    light += stir * smoothstep(${WATER.glowWetness}, ${(WATER.glowWetness + 0.5).toFixed(3)}, result) * params.grid.w * 14.0;
  }
  glow[index] = min(light, 1.5);

  // A tool's core presses the sand under it firm.
  var firmness = packed / layer;
  if (params.tool.x > 0.0) { firmness += contactField[index].x * (1.0 - firmness) * 0.06; }
  packingDestination[index] = clamp(firmness, 0.0, 1.0);
}
`

export class SandWater {
  readonly moisture: GPUBuffer[]
  /** Bioluminescent glow per cell (updated in place: each cell reads only itself). */
  readonly glow: GPUBuffer
  /** How packed the surface sand is, 0 loose to 1 molded (ping-pong with the state). */
  readonly packing: GPUBuffer[]
  private readonly initialPacking: Float32Array
  private readonly dropUniform: GPUBuffer
  private readonly dropData = new Float32Array(dropParamVectors * 4)
  private dropPipeline!: GPUComputePipeline
  private dropGroups: GPUBindGroup[] = []
  private impactPipeline!: GPUComputePipeline
  private impactGroups: GPUBindGroup[] = []
  private hydratePipeline!: GPUComputePipeline
  private hydrateGroups: GPUBindGroup[][] = []

  private readonly device: GPUDevice
  private readonly resolution: number
  constructor(device: GPUDevice, resolution: number) {
    this.device = device
    this.resolution = resolution
    this.moisture = [0, 1].map((index) => device.createBuffer({ label: `Moisture ${index}`, size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }))
    this.packing = [0, 1].map((index) => device.createBuffer({ label: `Packing ${index}`, size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }))
    this.initialPacking = new Float32Array(resolution * resolution).fill(KINETIC.initialPacking)
    this.glow = device.createBuffer({ label: 'Bioluminescence', size: resolution * resolution * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    this.dropUniform = device.createBuffer({ label: 'Water drops', size: dropParamBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  async initialize(states: GPUBuffer[], flux: GPUBuffer, uniforms: GPUBuffer[], contact: GPUBuffer) {
    const [drops, hydrate] = await Promise.all([
      checkedShader(this.device, 'Water drops WGSL', dropShader),
      checkedShader(this.device, 'Moisture transport WGSL', hydrateShader),
    ])
    ;[this.dropPipeline, this.impactPipeline, this.hydratePipeline] = await Promise.all([
      this.device.createComputePipelineAsync({ label: 'Water drops', layout: 'auto', compute: { module: drops, entryPoint: 'wet' } }),
      this.device.createComputePipelineAsync({ label: 'Conservative water impact', layout: 'auto', compute: { module: drops, entryPoint: 'impact' } }),
      this.device.createComputePipelineAsync({ label: 'Moisture transport', layout: 'auto', compute: { module: hydrate, entryPoint: 'hydrate' } }),
    ])
    this.dropGroups = states.map((state, index) => this.device.createBindGroup({ layout: this.dropPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.dropUniform } },
      { binding: 1, resource: { buffer: state } },
      { binding: 2, resource: { buffer: this.moisture[index] } },
      { binding: 3, resource: { buffer: this.glow } },
      { binding: 4, resource: { buffer: this.packing[index] } },
      { binding: 5, resource: { buffer: flux } },
    ] }))
    this.impactGroups = states.map((state) => this.device.createBindGroup({ layout: this.impactPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.dropUniform } },
      { binding: 1, resource: { buffer: state } },
      { binding: 5, resource: { buffer: flux } },
    ] }))
    this.hydrateGroups = uniforms.map((uniform) => states.map((state, index) => this.device.createBindGroup({ layout: this.hydratePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: flux } },
      { binding: 2, resource: { buffer: state } },
      { binding: 3, resource: { buffer: this.moisture[index] } },
      { binding: 4, resource: { buffer: this.moisture[1 - index] } },
      { binding: 5, resource: { buffer: contact } },
      { binding: 6, resource: { buffer: this.glow } },
      { binding: 7, resource: { buffer: this.packing[index] } },
      { binding: 8, resource: { buffer: this.packing[1 - index] } },
    ] })))
  }

  /** Lands deposits on the current state and moisture. Returns whether any work was encoded. */
  encodeDeposits(encoder: GPUCommandEncoder, drops: readonly Deposit[], current: number) {
    const batch = drops.slice(0, WATER.maxDropsPerFrame)
    if (!batch.length) return false
    const hasImpact = batch.some((drop) => drop.pit > 0)
    const spacing = SAND.extent / this.resolution
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let impactMinX = Infinity, impactMinY = Infinity, impactMaxX = -Infinity, impactMaxY = -Infinity
    this.dropData.fill(0)
    batch.forEach((drop, index) => {
      const reach = Math.max(drop.radius * (drop.sand > 0 ? 1.75 : 1), drop.pit > 0 ? drop.pitRadius * 3 : 0)
      const from = drop.from ?? drop
      minX = Math.min(minX, drop.x - reach, from.x - reach); maxX = Math.max(maxX, drop.x + reach, from.x + reach)
      minY = Math.min(minY, drop.y - reach, from.y - reach); maxY = Math.max(maxY, drop.y + reach, from.y + reach)
      const radiusSquared = Math.max(drop.pitRadius ** 2, 1e-12)
      const potentialScale = drop.pit * radiusSquared / (4 * spacing ** 2)
      const potentialReach = 3 * Math.sqrt(radiusSquared) + spacing
      if (drop.pit > 0) {
        // Impacts are endpoint events. A simultaneous long swept pour must
        // not stretch this prepass across its unrelated path.
        const impactReach = 3 * Math.sqrt(radiusSquared)
        impactMinX = Math.min(impactMinX, drop.x - impactReach); impactMaxX = Math.max(impactMaxX, drop.x + impactReach)
        impactMinY = Math.min(impactMinY, drop.y - impactReach); impactMaxY = Math.max(impactMaxY, drop.y + impactReach)
      }
      this.dropData.set([drop.x, drop.y, drop.radius, drop.amount, drop.pit, drop.pitRadius, drop.sand, potentialScale,
        from.x, from.y, 1 / radiusSquared, potentialReach ** 2], 16 + index * 12)
    })
    const toCell = (value: number) => (value + SAND.extent / 2) / spacing - 0.5
    // The existing one-cell halo includes receivers just outside the pressure
    // support, so even its truncated tail is exchanged conservatively.
    const x0 = Math.max(0, Math.floor(toCell(minX)) - 1)
    const y0 = Math.max(0, Math.floor(toCell(minY)) - 1)
    const x1 = Math.min(this.resolution, Math.ceil(toCell(maxX)) + 2)
    const y1 = Math.min(this.resolution, Math.ceil(toCell(maxY)) + 2)
    if (x1 <= x0 || y1 <= y0) return false
    const impactX0 = hasImpact ? Math.max(0, Math.floor(toCell(impactMinX)) - 1) : 0
    const impactY0 = hasImpact ? Math.max(0, Math.floor(toCell(impactMinY)) - 1) : 0
    const impactX1 = hasImpact ? Math.min(this.resolution, Math.ceil(toCell(impactMaxX)) + 2) : 0
    const impactY1 = hasImpact ? Math.min(this.resolution, Math.ceil(toCell(impactMaxY)) + 2) : 0
    const impactWidth = Math.max(0, impactX1 - impactX0)
    const impactHeight = Math.max(0, impactY1 - impactY0)
    const activeImpact = impactWidth > 0 && impactHeight > 0
    this.dropData.set([this.resolution, spacing, SAND.extent, batch.length, x0, y0, x1 - x0, y1 - y0,
      impactX0, impactY0, impactWidth, impactHeight, WATER.maxMoisture, SAND.floor, activeImpact ? 1 : 0, 0])
    this.device.queue.writeBuffer(this.dropUniform, 0, this.dropData)
    const pass = encoder.beginComputePass({ label: 'Water drops' })
    if (activeImpact) {
      pass.setPipeline(this.impactPipeline)
      pass.setBindGroup(0, this.impactGroups[current])
      pass.dispatchWorkgroups(Math.ceil(impactWidth / 8), Math.ceil(impactHeight / 8))
    }
    pass.setPipeline(this.dropPipeline)
    pass.setBindGroup(0, this.dropGroups[current])
    pass.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8))
    pass.end()
    return true
  }

  /** Moisture transport for one substep, reading [current] and writing [1 - current]. */
  encodeHydrate(pass: GPUComputePassEncoder, slot: number, current: number) {
    pass.setPipeline(this.hydratePipeline)
    pass.setBindGroup(0, this.hydrateGroups[slot][current])
    pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8))
  }

  /** Dry, dark, freshly settled sand: no moisture or glow, and the tray's starting packing. */
  clear(encoder: GPUCommandEncoder) {
    for (const buffer of [...this.moisture, this.glow]) encoder.clearBuffer(buffer)
    for (const buffer of this.packing) this.device.queue.writeBuffer(buffer, 0, this.initialPacking)
  }

  dispose() { [...this.moisture, ...this.packing, this.glow, this.dropUniform].forEach((buffer) => buffer.destroy()) }
}
