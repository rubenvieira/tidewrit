import { KINETIC, POUR, SAND, WATER } from '../config'
import { fluxLayout } from './flux'
import { toolFootprints } from './footprints'
import { bedReliefWgsl } from './bed-relief'
import { PARTICLE_CONTACT, particleContactWgsl } from './particle-contact'
import { particleDepositionWgsl } from './particle-deposition'
import { GRANULAR_MOTION, granularMotionWgsl } from './granular-motion'

// Cohesion is a height, not a steeper angle: a cohesive material stands as a
// vertical face up to a critical height set by its strength, as a damp
// sandcastle wall or a cut through kinetic sand does, and only taller faces
// fail. A slope multiplier could not hold a knife cut one cell wide. Damp
// sand's capillary bridges give it that strength; past saturation they flood
// and it slumps like a slurry. Wet grains stick together, so moisture also
// suppresses spray. Kinetic sand's strength comes from how packed it is.
const moistureResponse = `
fn wetHold(wetness: f32) -> f32 {
  return ${WATER.dampHold} * smoothstep(0.04, 0.4, wetness) * (1.0 - smoothstep(0.9, 1.3, wetness));
}
fn looseness(wetness: f32) -> f32 {
  return 1.0 - smoothstep(0.08, 0.6, wetness);
}
fn kineticHold(packed: f32) -> f32 {
  return mix(${KINETIC.looseHold}, ${KINETIC.packedHold}, clamp(packed, 0.0, 1.0));
}
`

const paramsLayout = `
struct ToolContact {
  start: vec4f,
  end: vec4f,
  motion: vec4f,
}
// tool = (contact count, indentation, rate, pour emitter count);
// material = (kinetic flag, creep fraction per substep, -, -);
// pour[i] = (x, y, stream radius, spawn chance per inactive grain).
struct Params {
  grid: vec4f,
  physics: vec4f,
  tool: vec4f,
  material: vec4f,
  pour: array<vec4f, ${POUR.maxEmitters}>,
  contacts: array<ToolContact, ${SAND.maxContacts}>,
}
`
const ledgerLayout = `
fn impactSlot(cell: u32) -> u32 {
  return cell + u32(params.grid.x * params.grid.x);
}
`

export const simulationShader = `
${fluxLayout}
${paramsLayout}
@group(0) @binding(0) var<uniform> params: Params;
${ledgerLayout}
@group(0) @binding(1) var<storage, read> source: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> destination: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> flux: array<Flux>;
// Fixed-point ledger: grain exchange in the first grid-sized half, the
// frontier impact ejection budget in the second.
@group(0) @binding(4) var<storage, read_write> ledger: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> contactField: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> contactPressure: array<f32>;
@group(0) @binding(7) var<storage, read> packing: array<f32>;
@group(0) @binding(8) var<storage, read> moisture: array<f32>;

fn hash(position: vec2f) -> f32 {
  return fract(sin(dot(position, vec2f(127.1, 311.7))) * 43758.5453);
}
fn address(cell: vec2i) -> u32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(params.grid.x) - 1));
  return u32(bounded.y) * u32(params.grid.x) + u32(bounded.x);
}
fn location(cell: vec2i) -> vec2f {
  return (vec2f(cell) + 0.5) * params.grid.y - params.grid.z * 0.5;
}
struct ContactSample {
  field: vec4f,
  pressure: f32,
}
fn strokeFrame(tool: ToolContact) -> vec2f {
  let segment = tool.end.xy - tool.start.xy;
  let segmentLength = length(segment);
  if (segmentLength > 1e-7) { return segment / segmentLength; }
  let speed = length(tool.motion.xy);
  return select(vec2f(1.0, 0.0), tool.motion.xy / max(speed, 1e-8), speed > 1e-6);
}
${toolFootprints}
${bedReliefWgsl}
fn sampleTool(position: vec2f) -> ContactSample {
  var strongest = 0.0;
  var coverage = 0.0;
  var shell = 0.0;
  var motion = vec2f(0.0);
  var pressure = 0.0;
  for (var index = 0u; index < ${SAND.maxContacts}u; index++) {
    if (f32(index) >= params.tool.x) { break; }
    let tool = params.contacts[index];
    let segment = tool.end.xy - tool.start.xy;
    let along = clamp(dot(position - tool.start.xy, segment) / max(dot(segment, segment), 1e-10), 0.0, 1.0);
    let offset = position - tool.start.xy - along * segment;
    // Cheap reject outside the swept reach before any shape work.
    if (dot(offset, offset) > tool.start.z * tool.start.z * 2.5) { continue; }
    let footprint = toolFootprint(u32(tool.end.z + 0.5), offset, position, strokeFrame(tool), tool.end.w, tool.motion.w, tool.start.z);
    let distance = footprint.x;
    let localCoverage = footprint.y;
    let strength = localCoverage * tool.start.w;
    shell = max(shell, 1.0 - smoothstep(0.9, 1.55, distance));
    if (strength > strongest) {
      strongest = strength;
      coverage = localCoverage;
      motion = tool.motion.xy;
      pressure = tool.start.w;
    }
  }
  return ContactSample(vec4f(coverage, shell, motion), pressure);
}
fn contactAt(cell: vec2i) -> vec4f {
  if (params.tool.x <= 0.0) { return vec4f(0.0); }
  return contactField[address(cell)];
}
fn pressureAt(cell: vec2i) -> f32 {
  if (params.tool.x <= 0.0) { return 0.0; }
  return contactPressure[address(cell)];
}
fn impactResponse(speed: f32) -> f32 {
  return smoothstep(${SAND.impactSpeedStart}, ${SAND.impactSpeedFull}, speed);
}
${moistureResponse}
${granularMotionWgsl}
fn impactCore(contact: vec4f, pressure: f32) -> f32 {
  return impactResponse(length(contact.zw)) * pressure * pow(contact.x, 1.75);
}
fn penetrationFor(contact: vec4f, pressure: f32) -> f32 {
  return contact.x * pressure * params.tool.y + impactCore(contact, pressure) * ${SAND.impactIndentation};
}
@compute @workgroup_size(8, 8)
fn initialize(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let position = location(cell);
  let height = params.physics.x + bedRelief(position);
  destination[address(cell)] = vec4f(height, 0.0, 0.0, 0.0);
}
@compute @workgroup_size(8, 8)
fn contact(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let sample = sampleTool(location(cell));
  contactField[address(cell)] = sample.field;
  contactPressure[address(cell)] = sample.pressure;
}
@compute @workgroup_size(8, 8)
fn transport(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let position = location(cell);
  let center = source[address(cell)];
  let toolContact = contactAt(cell);
  let toolPressure = pressureAt(cell);
  let penetration = penetrationFor(toolContact, toolPressure);
  let effectiveHeight = center.x + penetration;
  let toolSpeed = length(toolContact.zw);
  let motionDirection = toolContact.zw / max(toolSpeed, 1e-8);
  let speedResponse = toolSpeed / (toolSpeed + 0.35);
  let impact = impactCore(toolContact, toolPressure);
  let centerShell = toolContact.y;
  let centerMoisture = moisture[address(cell)];
  let centerPacking = packing[address(cell)];
  let kinetic = params.material.x > 0.5;
  let runoutVelocity = stoppedVelocity(center.zw);
  let mobileLayer = min(${GRANULAR_MOTION.layer}, center.y * params.grid.w)
    * dryMobility(centerMoisture, kinetic) * (1.0 - toolContact.x);
  let running = mobileLayer > 0.0 && dot(runoutVelocity, runoutVelocity) > 0.0;
  var outgoing = Flux(vec4f(0.0), vec4f(0.0));
  var escape = Flux(vec4f(0.0), vec4f(0.0));
  var coverageGradient = vec2f(0.0);
  for (var axis = 0u; axis < 8u; axis++) {
    let neighbor = cell + neighbors[axis];
    if (any(neighbor < vec2i(0)) || any(neighbor >= vec2i(i32(params.grid.x)))) { continue; }
    let other = source[address(neighbor)];
    let otherContact = contactAt(neighbor);
    if (axis == 0u) { coverageGradient += vec2f(-otherContact.x * 0.5, 0.0); }
    if (axis == 1u) { coverageGradient += vec2f(otherContact.x * 0.5, 0.0); }
    if (axis == 2u) { coverageGradient += vec2f(0.0, -otherContact.x * 0.5); }
    if (axis == 3u) { coverageGradient += vec2f(0.0, otherContact.x * 0.5); }
    let otherPenetration = penetrationFor(otherContact, pressureAt(neighbor));
    // Beach sand is held by water; kinetic sand by how packed it is.
    let hold = select(wetHold(0.5 * (centerMoisture + moisture[address(neighbor)])), kineticHold(0.5 * (centerPacking + packing[address(neighbor)])), kinetic);
    let friction = mix(params.physics.z, params.physics.w, clamp(max(center.y, other.y) * 35.0, 0.0, 1.0));
    let linkLength = select(1.0, 1.41421356, axis >= 4u);
    let weight = select(0.66666667, 0.16666667, axis >= 4u);
    let axisDirection = vec2f(neighbors[axis]) / linkLength;
    let forward = max(0.0, dot(axisDirection, motionDirection));
    let neighborShell = otherContact.y;
    let contactYield = max(toolContact.x, otherContact.x);
    let disturbedShell = max(centerShell, neighborShell);
    let thresholdScale = min(mix(1.0, 0.08, contactYield), mix(1.0, 0.45, disturbedShell));
    // A tool's core breaks the bonds it passes through: a bond fails only when
    // both of its cells are cut, so the faces a cut leaves keep their full
    // strength and displaced sand is pushed outward instead of pouring back.
    let severed = smoothstep(0.5, 0.9, min(toolContact.x, otherContact.x));
    // The holding height limits a whole face, not each cell step: looking one
    // cell further down the link, a drop that already exceeds it is a taller
    // face (or a staircase) and loses its cohesive support, so it slumps until
    // no face is taller than the material can stand.
    let beyond = source[address(neighbor + neighbors[axis])].x;
    let relief = center.x - min(other.x, beyond);
    let face = 1.0 - smoothstep(hold, hold * 2.0 + 1e-6, relief);
    let threshold = friction * params.grid.y * linkLength * thresholdScale + hold * face * (1.0 - severed);
    let excess = max(0.0, effectiveHeight - other.x - otherPenetration - threshold);
    let physicalThreshold = friction * params.grid.y * linkLength * mix(1.0, 0.45, disturbedShell);
    let physicalExcess = max(0.0, center.x - other.x - physicalThreshold);
    // Kinetic sand never avalanches; it creeps (below).
    let supercritical = select(smoothstep(params.grid.y * 1.5, params.grid.y * 5.0, physicalExcess), 0.0, kinetic);
    let avalancheBoost = 1.0 + supercritical * mix(0.35, 0.85, max(contactYield, disturbedShell));
    var amount = excess * params.grid.w * params.tool.z * weight * avalancheBoost;
    amount *= 1.0 + toolContact.x * speedResponse * forward * 0.55 + impact * forward * 0.95;
    // Released dry grains retain a little runout. This shares the conservative
    // eight-link limiter with slope flow and never mobilizes a resting bed.
    if (running) {
      amount += mobileLayer * runoutFraction(runoutVelocity, axisDirection, other.x - center.x, linkLength) * weight;
    }
    if (kinetic) {
      // Slow viscous creep of everything steeper than dry sand's repose.
      let creepExcess = max(0.0, center.x - other.x - params.physics.z * params.grid.y * linkLength);
      amount += creepExcess * params.material.y * weight;
    }
    let edge = max(0.0, penetration - otherPenetration) / max(penetration, 1e-7);
    let sideways = toolContact.x * (1.0 - abs(dot(axisDirection, motionDirection))) * 0.06;
    let escapeWeight = (edge + sideways) * (1.0 + speedResponse * forward * 0.8 + impact * forward * 1.35) * weight;
    if (axis < 4u) {
      outgoing.axial[axis] = amount;
      escape.axial[axis] = escapeWeight;
    } else {
      outgoing.diagonal[axis - 4u] = amount;
      escape.diagonal[axis - 4u] = escapeWeight;
    }
  }
  let frontier = clamp(max(0.0, -dot(coverageGradient, motionDirection)) / max(toolContact.x, 0.1), 0.0, 1.0);
  let targetHeight = params.physics.x - penetration;
  let overlap = max(0.0, center.x - targetHeight);
  let existing = totalFlux(outgoing);
  let escapeTotal = totalFlux(escape);
  let evacuationFraction = mix(mix(0.32, 0.46, speedResponse), ${SAND.impactEvacuation}, impact);
  let extra = max(0.0, overlap * evacuationFraction - existing);
  if (extra > 0.0 && escapeTotal > 1e-8) {
    outgoing.axial += escape.axial * (extra / escapeTotal);
    outgoing.diagonal += escape.diagonal * (extra / escapeTotal);
  }
  let total = totalFlux(outgoing);
  let available = max(0.0, center.x - params.physics.y);
  let limiter = min(1.0, available / max(total, 1e-10));
  let limited = Flux(outgoing.axial * limiter, outgoing.diagonal * limiter);
  flux[address(cell)] = limited;
  let remaining = max(0.0, center.x - params.physics.y - totalFlux(limited));
  // Kinetic sand sheds half as much, as heavier crumbs (see the grain shader).
  let shedding = select(looseness(centerMoisture), 0.5, kinetic);
  let desiredEjection = totalFlux(limited) * ${SAND.impactEjectionFraction} * impact * clamp(frontier * 1.4, 0.0, 1.0) * shedding;
  atomicStore(&ledger[impactSlot(address(cell))], i32(round(min(remaining, desiredEjection) * 1e9)));
}
@compute @workgroup_size(8, 8)
fn integrate(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= vec2u(u32(params.grid.x)))) { return; }
  let cell = vec2i(invocation.xy);
  let index = address(cell);
  let current = source[index];
  let outgoing = flux[index];
  var incoming = Flux(vec4f(0.0), vec4f(0.0));
  for (var axis = 0u; axis < 8u; axis++) {
    let neighbor = cell + neighbors[axis];
    if (any(neighbor < vec2i(0)) || any(neighbor >= vec2i(i32(params.grid.x)))) { continue; }
    let amount = component(flux[address(neighbor)], axis ^ 1u);
    if (axis < 4u) { incoming.axial[axis] = amount; }
    else { incoming.diagonal[axis - 4u] = amount; }
  }
  let transferred = f32(atomicExchange(&ledger[index], 0)) * 1e-9;
  let height = current.x + totalFlux(incoming) - totalFlux(outgoing) + transferred;
  let moved = totalFlux(incoming) + totalFlux(outgoing);
  let toolContact = contactAt(cell);
  let toolSpeed = length(toolContact.zw);
  let toolPressure = pressureAt(cell);
  let contactActivity = toolContact.x * toolPressure * toolSpeed * 0.004;
  let activity = max(max(current.y * exp(-params.grid.w * 10.0), moved / params.grid.w), contactActivity);
  let transportVelocity = (fluxVector(outgoing) - fluxVector(incoming)) * params.grid.y / max(height * params.grid.w, 1e-7);
  let slipCoupling = 0.38 / (1.0 + toolSpeed * 0.30);
  let toolVelocity = toolContact.zw * toolContact.x * toolPressure * slipCoupling;
  var velocity = mix(current.zw, transportVelocity + toolVelocity, 0.4);
  if (params.material.x < 0.5 && moisture[index] < 0.08 && toolContact.x * toolPressure < 0.001) {
    let retained = stoppedVelocity(current.zw);
    let arriving = stoppedVelocity(transportVelocity);
    // Do not add flux-derived speed back onto the retained momentum: the
    // same moving sand would then feed its own velocity indefinitely.
    velocity = select(arriving, retained, dot(retained, retained) > dot(arriving, arriving));
  }
  destination[index] = vec4f(height, activity, velocity);
}
`;

export const particleShader = `
${fluxLayout}
${paramsLayout}
struct Grain { position: vec4f, velocity: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
${ledgerLayout}
@group(0) @binding(1) var<storage, read> bed: array<vec4f>;
@group(0) @binding(2) var<storage, read> flux: array<Flux>;
@group(0) @binding(3) var<storage, read_write> grains: array<Grain>;
@group(0) @binding(4) var<storage, read_write> ledger: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read> contactField: array<vec4f>;
@group(0) @binding(6) var<storage, read> contactPressure: array<f32>;
@group(0) @binding(8) var<storage, read> moisture: array<f32>;
${moistureResponse}
fn random(seed: u32) -> f32 {
  var value = seed * 747796405u + 2891336453u;
  value = ((value >> ((value >> 28u) + 4u)) ^ value) * 277803737u;
  return f32((value >> 22u) ^ value) / 4294967295.0;
}
fn address(position: vec2f) -> u32 {
  let cell = vec2u(clamp((position / params.grid.z + 0.5) * params.grid.x, vec2f(0.0), vec2f(params.grid.x - 1.0)));
  return cell.y * u32(params.grid.x) + cell.x;
}

fn impactResponse(speed: f32) -> f32 {
  return smoothstep(${SAND.impactSpeedStart}, ${SAND.impactSpeedFull}, speed);
}
fn claimImpactMass(cell: u32, requestedMass: f32) -> f32 {
  let requestedUnits = max(1, i32(round(requestedMass * 1e9)));
  let previous = atomicSub(&ledger[impactSlot(cell)], requestedUnits);
  if (previous <= 0) {
    atomicAdd(&ledger[impactSlot(cell)], requestedUnits);
    return 0.0;
  }
  let claimed = min(previous, requestedUnits);
  if (claimed < requestedUnits) { atomicAdd(&ledger[impactSlot(cell)], requestedUnits - claimed); }
  return f32(claimed) * 1e-9;
}
fn cellCenter(cell: u32) -> vec2f {
  return (vec2f(f32(cell % u32(params.grid.x)), f32(cell / u32(params.grid.x))) + 0.5) * params.grid.y - params.grid.z * 0.5;
}
fn heightAt(cell: vec2i) -> f32 {
  let bounded = vec2u(clamp(cell, vec2i(0), vec2i(i32(params.grid.x) - 1)));
  return bed[bounded.y * u32(params.grid.x) + bounded.x].x;
}
fn contactAt(position: vec2f) -> vec3f {
  let coordinate = (position / params.grid.z + 0.5) * params.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  let lowerLeft = heightAt(cell);
  let lowerRight = heightAt(cell + vec2i(1, 0));
  let upperLeft = heightAt(cell + vec2i(0, 1));
  let upperRight = heightAt(cell + vec2i(1, 1));
  if (blend.x + blend.y <= 1.0) {
    let gradient = vec2f(lowerRight - lowerLeft, upperLeft - lowerLeft);
    return vec3f(lowerLeft + dot(gradient, blend), gradient / params.grid.y);
  }
  let gradient = vec2f(upperRight - upperLeft, upperRight - lowerRight);
  return vec3f(upperRight + dot(gradient, blend - 1.0), gradient / params.grid.y);
}
${particleContactWgsl}
${particleDepositionWgsl}
@compute @workgroup_size(64)
fn animate(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if (index >= arrayLength(&grains)) { return; }
  var grain = grains[index];
  if (grain.position.w > 0.0) {
    let impactGrain = grain.velocity.w < 0.0;
    var age = abs(grain.velocity.w);
    if (impactGrain) {
      let radiusScale = pow(max(grain.position.w, 1e-9) / ${SAND.airborneReferenceMass}, 1.0 / 3.0);
      let dragCoefficient = 2.35 / max(radiusScale, 0.55);
      let speed = length(grain.velocity.xyz);
      let drag = max(0.0, 1.0 - dragCoefficient * speed * params.grid.w);
      grain.velocity = vec4f(grain.velocity.xyz * drag, grain.velocity.w);
    }
    grain.velocity.y -= 9.81 * params.grid.w;
    // Limit only pathological horizontal flights to the exact triangle walk's
    // budget. No ray can skip untested cells, even after extreme input speeds.
    let travelCells = (abs(grain.velocity.x) + abs(grain.velocity.z)) * params.grid.w / params.grid.y;
    let travelScale = min(1.0, ${PARTICLE_CONTACT.maxCells - 3}.0 / max(travelCells, 1e-8));
    grain.velocity.x *= travelScale;
    grain.velocity.z *= travelScale;
    let previous = grain.position.xyz;
    grain.position = vec4f(previous + grain.velocity.xyz * params.grid.w, grain.position.w);
    age += params.grid.w;
    grain.velocity.w = select(age, -age, impactGrain);
    let limit = params.grid.z * 0.5 - params.grid.y;
    grain.position.x = clamp(grain.position.x, -limit, limit);
    grain.position.z = clamp(grain.position.z, -limit, limit);
    let collision = sweptBedImpact(previous, grain.position.xyz);
    if (collision.fraction <= 1.0) {
      grain.position = vec4f(mix(previous, grain.position.xyz, collision.fraction), grain.position.w);
      let cell = address(grain.position.xz);
      let surface = collision.surface;
      let normal = normalize(vec3f(-surface.y, 1.0, -surface.z));
      let normalSpeed = dot(grain.velocity.xyz, normal);
      let adhesion = smoothstep(0.08, 0.6, moisture[cell]);
      if (normalSpeed < -0.08 && age < 0.22) {
        grain.position.y = surface.x + ${PARTICLE_CONTACT.restingClearance};
        let tangent = grain.velocity.xyz - normal * normalSpeed;
        let friction = max(0.0, 1.0 - params.physics.w * mix(1.22, 2.4, adhesion) * abs(normalSpeed) / max(length(tangent), 1e-7));
        let restitution = mix(0.22, 0.035, adhesion);
        grain.velocity = vec4f(tangent * friction - normal * normalSpeed * restitution, grain.velocity.w);
      } else {
        depositGrain(grain.position.xz, grain.position.w);
        grain.position.w = 0.0;
        grain.velocity.w = 0.0;
      }
    }
    // The tray absorbs motion into its boundary while retaining the flight's
    // vertical and along-edge components. Clamping position alone left grains
    // pinned to an edge with outward kinetic energy on every following step.
    if (abs(grain.position.x) >= limit && grain.position.x * grain.velocity.x > 0.0) { grain.velocity.x = 0.0; }
    if (abs(grain.position.z) >= limit && grain.position.z * grain.velocity.z > 0.0) { grain.velocity.z = 0.0; }
  } else {
    grain.velocity.w += 1.0;
    let seed = index * 991u + u32(grain.velocity.w);
    var launched = false;
    // Pouring: a thin stream of grains released above each emitter. The bulk
    // of the poured volume lands through the deposit pass; these light grains
    // are the visible stream and add only their own small mass where they land.
    let pourCount = u32(params.tool.w);
    if (pourCount > 0u && random(seed + 97u) < params.pour[0].w) {
      let emitter = params.pour[index % pourCount];
      let spread = sqrt(random(seed + 101u)) * emitter.z * 0.35;
      let around = random(seed + 103u) * 6.28318531;
      let origin = emitter.xy + vec2f(cos(around), sin(around)) * spread;
      let surface = contactAt(origin);
      let mass = mix(0.0000006, 0.0000014, random(seed + 107u));
      grain.position = vec4f(origin.x, surface.x + 0.06 + random(seed + 109u) * 0.02, origin.y, mass);
      grain.velocity = vec4f((random(seed + 113u) - 0.5) * 0.05, -0.5 - random(seed + 127u) * 0.25, (random(seed + 131u) - 0.5) * 0.05, -1e-6);
      launched = true;
    }
    let contactCount = u32(params.tool.x);
    if (!launched && contactCount > 0u) {
      let contactIndex = index % contactCount;
      let tool = params.contacts[contactIndex];
      let toolSpeed = length(tool.motion.xy);
      let toolImpact = impactResponse(toolSpeed);
      if (toolImpact > 0.0) {
        let direction = tool.motion.xy / max(toolSpeed, 1e-8);
        let side = vec2f(-direction.y, direction.x);
        let candidate = index / contactCount;
        let sampleIndex = candidate % 256u;
        let sampleCycle = candidate / 256u;
        let column = sampleIndex % 16u;
        let row = sampleIndex / 16u;
        let forward = (mix(-0.08, 1.08, (f32(column) + random(seed + sampleCycle * 17u + 3u)) / 16.0)) * tool.start.z;
        let lateral = (mix(-1.05, 1.05, (f32(row) + random(seed + sampleCycle * 23u + 11u)) / 16.0)) * tool.start.z;
        let candidatePosition = tool.end.xy + direction * forward + side * lateral;
        let cell = address(candidatePosition);
        let localContact = contactField[cell];
        let localSpeed = length(localContact.zw);
        let localImpact = impactResponse(localSpeed) * contactPressure[cell] * pow(localContact.x, 1.75);
        let kinetic = params.material.x > 0.5;
        let requestedMass = mix(${SAND.impactParticleMassMin}, ${SAND.impactParticleMassMax}, random(seed + 13u)) * select(1.0, ${KINETIC.crumbMass.toFixed(1)}, kinetic);
        var mass = 0.0;
        if (localImpact > 0.0) { mass = claimImpactMass(cell, requestedMass); }
        if (mass > 0.0) {
          let surfacePosition = cellCenter(cell);
          let surface = contactAt(surfacePosition);
          let motionDirection = localContact.zw / max(localSpeed, 1e-8);
          let transport = fluxVector(flux[cell]);
          let transportDirection = transport / max(length(transport), 1e-9);
          let launchDirection = normalize(motionDirection + transportDirection * 0.28);
          let launchSide = vec2f(-launchDirection.y, launchDirection.x);
          let spread = (random(seed + 31u) - 0.5) * localSpeed * 0.26;
          let crumb = select(1.0, ${KINETIC.crumbSpeed.toFixed(3)}, kinetic);
          let horizontalSpeed = localSpeed * (0.42 + random(seed + 5u) * 0.38) * crumb;
          let horizontal = launchDirection * horizontalSpeed + launchSide * spread;
          let uphill = max(0.0, dot(surface.yz, motionDirection));
          let loft = pow(random(seed + 7u), 2.0);
          let rareBurst = pow(random(seed + 41u), 9.0);
          let lift = (0.12 + localSpeed * (0.16 + loft * 0.45 + rareBurst * 0.62 + min(uphill, 0.8) * 0.30)) * crumb;
          grain.position = vec4f(surfacePosition.x, surface.x + 0.0003, surfacePosition.y, mass);
          grain.velocity = vec4f(horizontal.x, lift, horizontal.y, -1e-6);
          atomicSub(&ledger[cell], i32(round(mass * 1e9)));
          launched = true;
        }
      }
    }
    if (!launched) {
      let stride = max(1u, u32(params.grid.x * params.grid.x) / arrayLength(&grains));
      let cell = min(index * stride + u32(grain.velocity.w) % stride, arrayLength(&bed) - 1u);
      let flow = flux[cell];
      let moved = totalFlux(flow);
      let reserve = bed[cell].x - moved - params.physics.y;
      let bedVelocity = bed[cell].zw;
      let speed = length(bedVelocity);
      let agitation = smoothstep(0.055, 0.24, speed);
      let sourceMoved = max(moved, bed[cell].y * params.grid.w * 0.35);
      let mass = mix(0.0000025, 0.0000055, random(seed + 13u));
      let launchMass = sourceMoved * f32(stride) * agitation * 0.004;
      let launchChance = min(1.0, launchMass / mass) * looseness(moisture[cell]);
      let contactSpeed = length(contactField[cell].zw);
      let activeImpactContact = params.tool.x > 0.0 && contactField[cell].x > 0.001 && impactResponse(contactSpeed) > 0.0;
      // Kinetic sand never lets loose grains skitter off on their own.
      if (params.material.x < 0.5 && !activeImpactContact && reserve > mass * 1.2 && random(seed) < launchChance) {
        let position = cellCenter(cell);
        let transport = fluxVector(flow);
        let direction = select(transport / max(length(transport), 1e-9), bedVelocity / max(speed, 1e-9), speed > 0.01);
        let side = vec2f(-direction.y, direction.x);
        let scatter = (random(seed + 31u) - 0.5) * (0.02 + speed * 0.12);
        let horizontal = bedVelocity * (0.68 + random(seed + 5u) * 0.22) + direction * (0.018 + speed * 0.12) + side * scatter;
        let lift = 0.018 + sqrt(max(speed, 0.0)) * (0.16 + random(seed + 7u) * 0.055);
        grain.position = vec4f(position.x, bed[cell].x + 0.0003, position.y, mass);
        grain.velocity = vec4f(horizontal.x, lift, horizontal.y, 0.0);
        atomicSub(&ledger[cell], i32(round(mass * 1e9)));
      }
    }
  }
  grains[index] = grain;
}
`;
