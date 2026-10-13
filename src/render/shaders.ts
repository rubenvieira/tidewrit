import { SAND } from '../config'
import { toolFootprints } from '../simulation/footprints'
import { bedReliefWgsl } from '../simulation/bed-relief'

export const surfaceShader = `
struct View {
  eye: vec4f,
  forward: vec4f,
  right: vec4f,
  up: vec4f,
  light: vec4f,
  grid: vec4f,
  pointer: vec4f,
  shadowBounds: vec4f,
  shadowControl: vec4f,
  tool: vec4f,
  symmetry: vec4f,
  // Direct light color × intensity, night amount; sky tint.
  sun: vec4f,
  sky: vec4f,
  // Kinetic flag, -, -, -; kinetic sand color.
  material: vec4f,
  tint: vec4f,
}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> bed: array<vec4f>;
struct Grain { position: vec4f, velocity: vec4f }
@group(0) @binding(2) var<storage, read> grains: array<Grain>;
@group(0) @binding(3) var<storage, read> lighting: array<vec4f>;
@group(0) @binding(4) var shadowSampler: sampler;
@group(0) @binding(5) var shadowTexture: texture_2d<f32>;
@group(0) @binding(6) var airborneShadowSampler: sampler;
@group(0) @binding(7) var airborneShadowTexture: texture_2d<f32>;
@group(0) @binding(8) var<storage, read> moistureField: array<f32>;
@group(0) @binding(9) var<storage, read> glowField: array<f32>;
@group(0) @binding(10) var<storage, read> packingField: array<f32>;
${toolFootprints}
${bedReliefWgsl}
fn moistureCell(cell: vec2i) -> f32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(view.grid.x) - 1));
  return moistureField[u32(bounded.y) * u32(view.grid.x) + u32(bounded.x)];
}
fn glowCell(cell: vec2i) -> f32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(view.grid.x) - 1));
  return glowField[u32(bounded.y) * u32(view.grid.x) + u32(bounded.x)];
}
fn glowAt(position: vec2f) -> f32 {
  let coordinate = (position / view.grid.y + 0.5) * view.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  return mix(mix(glowCell(cell), glowCell(cell + vec2i(1, 0)), blend.x),
    mix(glowCell(cell + vec2i(0, 1)), glowCell(cell + vec2i(1, 1)), blend.x), blend.y);
}
fn packingCell(cell: vec2i) -> f32 {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(view.grid.x) - 1));
  return packingField[u32(bounded.y) * u32(view.grid.x) + u32(bounded.x)];
}
fn packingAt(position: vec2f) -> f32 {
  let coordinate = (position / view.grid.y + 0.5) * view.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  return mix(mix(packingCell(cell), packingCell(cell + vec2i(1, 0)), blend.x),
    mix(packingCell(cell + vec2i(0, 1)), packingCell(cell + vec2i(1, 1)), blend.x), blend.y);
}
// Grain spacing: beach sand, or the finer, uniform grains of kinetic sand.
fn grainSize() -> f32 {
  return mix(0.00043, 0.00024, view.material.x);
}
fn moistureAt(position: vec2f) -> f32 {
  let coordinate = (position / view.grid.y + 0.5) * view.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  return mix(mix(moistureCell(cell), moistureCell(cell + vec2i(1, 0)), blend.x),
    mix(moistureCell(cell + vec2i(0, 1)), moistureCell(cell + vec2i(1, 1)), blend.x), blend.y);
}
// Outline of the active tool's real contact footprint at every symmetry image.
// view.pointer = (x, y, reach, visible), view.tool = (kind, angle, direction),
// view.symmetry = (rotations, mirrored, footprint variant).
fn toolOutline(position: vec2f) -> f32 {
  var outline = 0.0;
  if (view.pointer.w < 0.5) { return outline; }
  let rotations = max(1u, u32(view.symmetry.x + 0.5));
  let images = rotations * select(1u, 2u, view.symmetry.y > 0.5);
  for (var image = 0u; image < images; image++) {
    let flip = select(1.0, -1.0, image >= rotations);
    let rotation = f32(image % rotations) * 6.28318531 / f32(rotations);
    let c = cos(rotation);
    let s = sin(rotation);
    let pointer = vec2f(flip * view.pointer.x, view.pointer.y);
    let heading = vec2f(flip * view.tool.z, view.tool.w);
    let center = vec2f(c * pointer.x - s * pointer.y, s * pointer.x + c * pointer.y);
    let direction = vec2f(c * heading.x - s * heading.y, s * heading.x + c * heading.y);
    let footprint = toolFootprint(u32(view.tool.x + 0.5), position - center, position, direction, flip * view.tool.y + rotation, flip * view.symmetry.z, view.pointer.z);
    let width = max(fwidth(footprint.x) * 1.4, 1e-5);
    outline = max(outline, 1.0 - smoothstep(0.0, width, abs(footprint.x - 1.0)));
  }
  return outline;
}
fn lightAt(cell: vec2i) -> vec2f {
  let bounded = vec2u(clamp(cell, vec2i(0), vec2i(i32(view.grid.x) - 1)));
  return lighting[bounded.y * u32(view.grid.x) + bounded.x].xy;
}
fn illuminationAt(position: vec2f) -> vec2f {
  let coordinate = (position / view.grid.y + 0.5) * view.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  return mix(mix(lightAt(cell), lightAt(cell + vec2i(1, 0)), blend.x),
    mix(lightAt(cell + vec2i(0, 1)), lightAt(cell + vec2i(1, 1)), blend.x), blend.y);
}
fn cellAt(cell: vec2i) -> vec4f {
  let bounded = clamp(cell, vec2i(0), vec2i(i32(view.grid.x) - 1));
  return bed[u32(bounded.y) * u32(view.grid.x) + u32(bounded.x)];
}
fn stateAt(position: vec2f) -> vec4f {
  let coordinate = (position / view.grid.y + 0.5) * view.grid.x - 0.5;
  let cell = vec2i(floor(coordinate));
  let blend = fract(coordinate);
  return mix(mix(cellAt(cell), cellAt(cell + vec2i(1, 0)), blend.x),
    mix(cellAt(cell + vec2i(0, 1)), cellAt(cell + vec2i(1, 1)), blend.x), blend.y);
}
fn project(position: vec3f) -> vec4f {
  let relative = position - view.eye.xyz;
  let depth = dot(relative, view.forward.xyz);
  return vec4f(dot(relative, view.right.xyz) / (view.eye.w * view.forward.w),
    dot(relative, view.up.xyz) / view.eye.w, depth * 1.001001 - 0.01001001, depth);
}
struct VertexOutput { @builtin(position) clip: vec4f, @location(0) world: vec3f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  let cell = vec2u(index % u32(view.grid.x), index / u32(view.grid.x));
  let position = (vec2f(cell) + 0.5) / view.grid.x * view.grid.y - view.grid.y * 0.5;
  var output: VertexOutput;
  output.world = vec3f(position.x, bed[index].x, position.y);
  output.clip = project(output.world);
  return output;
}
fn hash2(position: vec2f) -> vec2f {
  var hashed = fract(vec3f(position.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  hashed += dot(hashed, hashed.yzx + 33.33);
  return fract((hashed.xx + hashed.yz) * hashed.zy);
}
fn grainAxis(random: vec2f) -> vec2f {
  let horizontal = random.x * 2.0 - 1.0;
  let verticalMagnitude = max(0.08, 1.0 - abs(horizontal));
  let vertical = select(-verticalMagnitude, verticalMagnitude, random.y >= 0.5);
  return normalize(vec2f(horizontal, vertical));
}
fn warpGrainCoordinate(coordinate: vec2f) -> vec2f {
  let waveA = sin(dot(coordinate, vec2f(0.071, 0.109)) + 1.37);
  let waveB = sin(dot(coordinate, vec2f(-0.097, 0.063)) - 0.82);
  return coordinate + vec2f(waveA, waveB) * 0.14;
}
struct GrainAppearance {
  offset: vec2f,
  shapedOffset: vec2f,
  axis: vec2f,
  color: vec2f,
  materialSeed: vec2f,
  grainCell: vec2f,
  edge: f32,
  roundness: f32,
}
fn grainAppearance(coordinate: vec2f) -> GrainAppearance {
  let warpedCoordinate = warpGrainCoordinate(coordinate);
  let baseCell = floor(warpedCoordinate);
  var nearest = 100.0;
  var second = 100.0;
  var grainOffset = vec2f(0.0);
  var shapedOffset = vec2f(0.0);
  var selectedAxis = vec2f(1.0, 0.0);
  var grainColor = vec2f(0.5);
  var selectedCell = vec2f(0.0);
  for (var row = -1; row <= 1; row++) {
    for (var column = -1; column <= 1; column++) {
      let cell = baseCell + vec2f(f32(column), f32(row));
      let random = hash2(cell);
      let center = cell + (0.16 + 0.68 * random);
      let offset = warpedCoordinate - center;
      let axis = grainAxis(random);
      let perpendicular = vec2f(-axis.y, axis.x);
      let aspectSeed = fract(random.x * 5.37 + random.y * 7.91);
      let aspect = mix(0.78, 1.27, aspectSeed);
      let local = vec2f(dot(offset, axis) / aspect, dot(offset, perpendicular) * aspect);
      let distance = dot(local, local);
      if (distance < nearest) {
        second = nearest;
        nearest = distance;
        grainOffset = offset;
        shapedOffset = local;
        selectedAxis = axis;
        grainColor = random;
        selectedCell = cell;
      } else {
        second = min(second, distance);
      }
    }
  }
  let boundary = sqrt(second) - sqrt(nearest);
  let materialSeed = hash2(selectedCell + vec2f(87.17, 31.73));
  let rawRoundness = sqrt(max(0.0, 1.0 - min(nearest / 0.44, 1.0)));
  let angularity = mix(rawRoundness, smoothstep(0.04, 0.96, rawRoundness), materialSeed.y * 0.46);
  return GrainAppearance(grainOffset, shapedOffset, selectedAxis, grainColor, materialSeed, selectedCell,
    smoothstep(0.014, 0.145, boundary), angularity);
}
struct SandMaterial {
  albedo: vec3f,
  roughness: f32,
  translucency: f32,
  fresnelBase: f32,
  sparkleAffinity: f32,
}
fn materialForGrain(seed: vec2f, composition: f32) -> SandMaterial {
  let family = fract(seed.x + (composition - 0.5) * 0.085);
  var albedo = vec3f(0.67, 0.51, 0.30);
  var roughness = 0.50;
  var translucency = 0.09;
  var fresnelBase = 0.040;
  var sparkleAffinity = 0.50;
  if (family < 0.36) {
    albedo = vec3f(0.72, 0.57, 0.35);
    roughness = 0.38;
    translucency = 0.17;
    sparkleAffinity = 0.72;
  } else if (family < 0.66) {
    albedo = vec3f(0.65, 0.48, 0.27);
    roughness = 0.48;
    translucency = 0.10;
    sparkleAffinity = 0.48;
  } else if (family < 0.82) {
    albedo = vec3f(0.75, 0.60, 0.38);
    roughness = 0.31;
    translucency = 0.21;
    sparkleAffinity = 0.64;
  } else if (family < 0.92) {
    albedo = vec3f(0.54, 0.34, 0.18);
    roughness = 0.58;
    translucency = 0.035;
    sparkleAffinity = 0.20;
  } else if (family < 0.972) {
    albedo = vec3f(0.43, 0.27, 0.15);
    roughness = 0.63;
    translucency = 0.02;
    sparkleAffinity = 0.12;
  } else {
    albedo = vec3f(0.22, 0.17, 0.12);
    roughness = 0.69;
    translucency = 0.0;
    fresnelBase = 0.048;
    sparkleAffinity = 0.04;
  }
  let tint = (seed.y - 0.5) * 0.10;
  albedo *= vec3f(1.0 + tint, 1.0 + tint * 0.52, 1.0 - tint * 0.45);
  roughness = clamp(roughness + (seed.y - 0.5) * 0.10, 0.24, 0.76);
  return SandMaterial(albedo, roughness, translucency, fresnelBase, sparkleAffinity);
}
fn environment(direction: vec3f) -> vec3f {
  let upward = max(direction.y, 0.0);
  let sky = mix(vec3f(0.72, 0.67, 0.57), vec3f(0.42, 0.56, 0.78), pow(upward, 0.45));
  let ground = mix(vec3f(0.25, 0.19, 0.13), vec3f(0.52, 0.42, 0.29), smoothstep(-1.0, 0.0, direction.y));
  return select(ground, sky, direction.y >= 0.0) * view.sky.rgb;
}
fn treeShadow(position: vec2f) -> f32 {
  let center = view.shadowBounds.xy;
  let halfSize = view.shadowBounds.zw;
  let shadowOpacity = view.shadowControl.x;
  let uv = (position - (center - halfSize)) / (halfSize * 2.0);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let mask = textureSampleLevel(shadowTexture, shadowSampler, uv, 0.0).x;
  return 1.0 - mask * shadowOpacity;
}
fn airborneShadow(position: vec2f) -> f32 {
  let uv = vec2f(position.x / view.grid.y + 0.5, 0.5 - position.y / view.grid.y);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let opticalDepth = textureSampleLevel(airborneShadowTexture, airborneShadowSampler, uv, 0.0).x;
  return exp(-opticalDepth * ${SAND.airborneShadowStrength});
}
fn microfacetDistribution(alphaSquared: f32, normalHalf: f32) -> f32 {
  let denominator = normalHalf * normalHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(3.141593 * denominator * denominator, 0.0001);
}
fn geometryAttenuation(cosine: f32, viewCosine: f32) -> f32 {
  return cosine * viewCosine / max((cosine * 0.7 + 0.3) * (viewCosine * 0.7 + 0.3), 0.001);
}
fn reflectiveGlintAt(position: vec2f, normal: vec3f, towardEye: vec3f, light: vec3f, visibility: f32, pixelWidth: f32, affinity: f32) -> f32 {
  let cellSize = 0.0048;
  let cell = floor(position / cellSize);
  let selector = hash2(cell + vec2f(13.7, 41.3));
  if (selector.x <= 0.995) { return 0.0; }

  let centerSeed = hash2(cell + vec2f(73.1, 19.6));
  let center = (cell + 0.12 + centerSeed * 0.76) * cellSize;
  let physicalRadius = mix(0.00006, 0.00014, selector.y);
  let opticalRadius = max(physicalRadius, pixelWidth * 1.45);
  let centerDistance = length(position - center);
  if (centerDistance > opticalRadius) { return 0.0; }

  let halfway = normalize(light + towardEye);
  let normalHalf = max(dot(normal, halfway), 0.02);
  let tangentHalf = length(cross(normal, halfway));
  let requiredSlope = tangentHalf / normalHalf;
  let slopeSigma = 0.46;
  let facetProbability = exp(-0.5 * requiredSlope * requiredSlope / (slopeSigma * slopeSigma));
  let activationProbability = clamp((0.55 + facetProbability * 0.36) * mix(0.72, 1.08, affinity), 0.0, 0.94);
  let orientationSeed = hash2(cell + vec2f(151.7, 223.9));
  if (orientationSeed.x > activationProbability) { return 0.0; }

  let footprint = 1.0 - smoothstep(0.22, 1.0, centerDistance / opticalRadius);
  let shadowed = smoothstep(0.06, 0.52, visibility);
  let intensity = mix(1.6, 2.6, orientationSeed.y) * mix(0.72, 1.10, affinity);
  return footprint * shadowed * intensity;
}
struct FragmentOutput { @location(0) color: vec4f, @location(1) glint: f32, @builtin(frag_depth) depth: f32 }
// Sun visibility traced from this exact pixel with the bed-lighting pass's
// samples and penumbra. Used only where the per-cell result is a partial
// shadow, so tall shapes cast smooth shadow edges instead of grid steps.
fn tracedSunVisibility(world: vec3f, light: vec3f) -> f32 {
  let spacing = view.grid.y / view.grid.x;
  let limit = view.grid.y * 0.5 - spacing;
  var visibility = 1.0;
  for (var sampleIndex = 1; sampleIndex <= 14; sampleIndex++) {
    let step = f32(sampleIndex);
    let distance = spacing * (0.8 * step + 0.38 * step * step);
    let probe = world.xz + light.xz * distance;
    if (any(abs(probe) > vec2f(limit))) { break; }
    let blocker = stateAt(probe).x - world.y - light.y * distance;
    visibility = min(visibility, 1.0 - smoothstep(-0.0002 - distance * 0.035, 0.0004 + distance * 0.045, blocker));
  }
  return visibility;
}
// Smooth pseudo-noise gradient from incommensurate plane waves: millimetre
// relief that roughens steep faces into crumbly, hand-cut sand.
fn crumbleGradient(world: vec3f) -> vec3f {
  let directions = array<vec3f, 6>(
    vec3f(0.62, 0.55, -0.56), vec3f(-0.41, 0.71, 0.57), vec3f(0.18, -0.64, 0.75),
    vec3f(0.83, 0.12, 0.54), vec3f(-0.72, -0.35, 0.6), vec3f(0.33, 0.9, -0.28));
  let frequencies = array<f32, 6>(2600.0, 3300.0, 4100.0, 1150.0, 1450.0, 5200.0);
  let phases = array<f32, 6>(0.3, 1.7, 4.1, 2.6, 5.3, 0.9);
  var gradient = vec3f(0.0);
  for (var wave = 0u; wave < 6u; wave++) {
    let k = directions[wave] * frequencies[wave];
    gradient += k * cos(dot(k, world) + phases[wave]) / frequencies[wave];
  }
  return gradient / 6.0;
}
fn shadeSurface(input: VertexOutput, top: GrainProjection, sideX: GrainProjection, sideZ: GrainProjection, mobile: bool) -> FragmentOutput {
  let position = input.world.xz;
  // Damp sand darkens as water fills the pores; past saturation a film floods
  // the grain relief and turns the surface into a smooth mirror.
  let moisture = moistureAt(position);
  let damp = smoothstep(0.02, 0.45, moisture);
  let film = smoothstep(1.0, 1.25, moisture);
  // Kinetic sand: packed faces are smooth, worked material opens up porous.
  let kinetic = view.material.x;
  let packedness = packingAt(position);
  let spacing = view.grid.y / view.grid.x;
  let heightLeft = stateAt(position - vec2f(spacing, 0.0)).x;
  let heightRight = stateAt(position + vec2f(spacing, 0.0)).x;
  let heightBack = stateAt(position - vec2f(0.0, spacing)).x;
  let heightFront = stateAt(position + vec2f(0.0, spacing)).x;
  let macroNormal = normalize(vec3f(heightLeft - heightRight, 2.0 * spacing, heightBack - heightFront));
  // Triplanar grain: a projection from above stretches grains into streaks on
  // walls, so steep faces take theirs from a side plane. In between, each
  // pixel picks one plane by a stable dither on steepness, which avoids both
  // doubling the grain cost and ghosting two grain patterns over each other.
  let steepness = smoothstep(0.42, 0.72, 1.0 - macroNormal.y);
  let onSide = hash2(floor(input.clip.xy) + vec2f(7.0, 113.0)).x < steepness;
  let facingX = abs(macroNormal.x) > abs(macroNormal.z);
  var projection = top;
  if (onSide && facingX) { projection = sideX; } else if (onSide) { projection = sideZ; }
  let footprint = max(length(projection.dx), length(projection.dy));
  let reflectivePixelWidth = footprint * grainSize();
  var appearanceDetail = 1.0 - smoothstep(0.55, 2.1, footprint);
  var depthDetail = appearanceDetail;
  var filteredCoordinate = projection.coordinate;
  if (mobile) {
    // Phones need one stable stochastic sample inside the real pixel footprint
    // once grain spacing approaches the framebuffer sampling rate. Keep visible
    // material detail intact; only grain depth relief fades when it is unresolved.
    let stochasticAmount = smoothstep(0.32, 0.58, footprint);
    let jitter = hash2(floor(input.clip.xy) + vec2f(19.0, 71.0)) - 0.5;
    filteredCoordinate += stochasticAmount * (projection.dx * jitter.x + projection.dy * jitter.y);
    appearanceDetail = 1.0;
    depthDetail = 1.0 - smoothstep(0.48, 0.90, footprint);
  }
  let grain = grainAppearance(filteredCoordinate);
  let grainEdge = grain.edge;
  let roundness = grain.roundness;
  let heightSeed = fract(grain.materialSeed.x * 3.71 + grain.color.y * 5.17);
  let grainHeight = depthDetail * grainEdge * roundness * mix(0.000038, 0.000126, heightSeed);
  let perpendicular = vec2f(-grain.axis.y, grain.axis.x);
  let radial = grain.axis * grain.shapedOffset.x + perpendicular * grain.shapedOffset.y;
  let facetJitter = (grain.materialSeed - 0.5) * 0.34;
  let facet = radial * (0.34 + roundness * 0.46) + facetJitter;
  var facetDirection = vec3f(facet.x, 0.0, facet.y);
  if (onSide) { facetDirection = select(vec3f(facet.x, facet.y, 0.0), vec3f(0.0, facet.y, facet.x), facingX); }
  // Steep faces are slightly rough-hewn; packed kinetic faces and wet film stay smooth.
  let crumble = crumbleGradient(input.world);
  let crumbleRelief = (crumble - macroNormal * dot(crumble, macroNormal)) * 0.32 * smoothstep(0.25, 0.8, 1.0 - macroNormal.y)
    * (1.0 - 0.7 * packedness * kinetic) * (1.0 - film);
  let grainRelief = facetDirection * appearanceDetail * (1.0 - film * 0.85) * (1.0 - 0.55 * packedness * kinetic);
  let normal = normalize(macroNormal + crumbleRelief + grainRelief);
  // The crumble relief stands for unresolved roughness at every scale: it
  // scatters reflections rather than forming a coherent mirror facet, so
  // specular, sky reflection and glints use the grain-level normal without it.
  let glossNormal = normalize(macroNormal + grainRelief);
  let displacedWorld = input.world + macroNormal * grainHeight;
  let light = normalize(view.light.xyz);
  let towardEye = normalize(view.eye.xyz - displacedWorld);
  let halfway = normalize(light + towardEye);
  let cosine = max(0.0, dot(normal, light));
  let viewCosine = max(0.02, dot(normal, towardEye));
  let illumination = illuminationAt(position);
  var sunVisibility = illumination.x;
  if (sunVisibility > 0.02 && sunVisibility < 0.98) { sunVisibility = tracedSunVisibility(input.world, light); }
  let shade = treeShadow(position);
  let sprayShade = airborneShadow(position);
  let visibility = sunVisibility * shade * sprayShade;
  let occlusion = illumination.y;
  let composition = hash2(floor(grain.grainCell / 42.0) + vec2f(41.0, 67.0)).x;
  let material = materialForGrain(grain.materialSeed, composition);
  let microOcclusion = mix(1.0, mix(0.61, 1.0, grainEdge), appearanceDetail) * mix(1.0, 0.8, (1.0 - packedness) * kinetic);
  let grainAlbedo = material.albedo * mix(0.64, 1.0, grainEdge);
  // Real beaches are never one even tone: broad, faint brightness swells, and
  // patches where dark heavy minerals have collected.
  let tone = 1.0 + 0.09 * reliefNoise(position / 0.11) + 0.05 * reliefNoise(position / 0.037 + 3.1);
  let minerals = smoothstep(0.12, 0.42, reliefNoise(position / 0.06 + 11.7) + 0.35 * reliefNoise(position / 0.013 - 2.9));
  let naturalTone = tone * mix(vec3f(1.0), vec3f(0.78, 0.76, 0.79), minerals * 0.55);
  let beachAlbedo = mix(vec3f(0.59, 0.435, 0.25), grainAlbedo, appearanceDetail) * naturalTone * mix(vec3f(1.0), vec3f(0.52, 0.49, 0.45), damp);
  // Kinetic color is a target albedo; each grain keeps its own brightness.
  let albedo = mix(beachAlbedo, view.tint.rgb * dot(beachAlbedo, vec3f(0.2126, 0.7152, 0.0722)) / 0.45, kinetic);
  let roughness = mix(mix(mix(0.80, material.roughness, appearanceDetail), 0.5, damp * 0.5), 0.07, film);
  let alphaSquared = pow(roughness, 4.0);
  let glossCosine = max(0.0, dot(glossNormal, light));
  let glossViewCosine = max(0.02, dot(glossNormal, towardEye));
  let normalHalf = max(0.0, dot(glossNormal, halfway));
  let distribution = microfacetDistribution(alphaSquared, normalHalf);
  let fresnelBase = mix(material.fresnelBase, 0.02, film);
  let fresnel = fresnelBase + (1.0 - fresnelBase) * pow(1.0 - max(0.0, dot(halfway, towardEye)), 5.0);
  let geometry = geometryAttenuation(glossCosine, glossViewCosine);
  let specular = distribution * fresnel * geometry / max(4.0 * glossCosine * glossViewCosine, 0.001);
  let diffuse = cosine * (0.84 + 0.16 * (1.0 - viewCosine));
  let ambient = environment(normal) * (0.24 + 0.16 * macroNormal.y) * occlusion * microOcclusion * mix(0.70, 1.0, shade);
  let direct = view.sun.rgb * visibility * microOcclusion;
  let reflected = reflect(-towardEye, glossNormal);
  // A standing film's mirror ray points back up past the viewer, so a pool the
  // camera can see also sees open sky even at the bottom of a hole: hemisphere
  // occlusion would wrongly black it out.
  let reflectionVisibility = mix(occlusion, 1.0, film * 0.85);
  let environmentSpecular = environment(reflected) * fresnel * pow(1.0 - roughness, 2.0) * 0.32 * reflectionVisibility * mix(0.42, 1.0, shade);
  let bodyTransmission = albedo * direct * material.translucency * (0.018 + 0.050 * (1.0 - viewCosine)) * roundness * appearanceDetail;
  let reflectiveGlint = reflectiveGlintAt(position, glossNormal, towardEye, light, visibility, reflectivePixelWidth, material.sparkleAffinity) * (1.0 - 0.8 * damp)
    // Glints are sun reflections, so they dim with the light (2.29 is the afternoon sun's luminance).
    * dot(view.sun.rgb, vec3f(0.2126, 0.7152, 0.0722)) / 2.29
    // Polymer-coated kinetic grains are matte.
    * mix(1.0, 0.08, kinetic);
  // Sunlit sand around a steep face lights it from below: a face sees half the
  // ground at vertical, and that ground reflects about half the sun it gets.
  // Flat sand and shallow grooves are unaffected; mounds, castles and walls no
  // longer fall to black on their shadow side.
  let groundBounce = view.sun.rgb * 0.5 * (1.0 - macroNormal.y) * 0.5 * 0.55 * occlusion;
  var radiance = albedo * (ambient + direct * diffuse + groundBounce) + direct * specular * glossCosine + environmentSpecular + bodyTransmission;
  // Bioluminescence lights individual grains, so it reads as sparkling points
  // rather than a wash; daylight drowns it out, as it does on a real beach.
  let plankton = pow(fract(grain.materialSeed.x * 7.31 + grain.materialSeed.y * 3.17), 3.0);
  radiance += vec3f(0.1, 0.62, 1.0) * glowAt(position) * view.sun.w * (0.25 + 2.6 * plankton) * 1.6;
  radiance *= 1.0 - 0.22 * toolOutline(position);
  let projected = project(displacedWorld);
  var output: FragmentOutput;
  output.color = vec4f(radiance, 1.0);
  output.glint = reflectiveGlint;
  output.depth = projected.z / projected.w;
  return output;
}
// Grain coordinates in one projection plane, with their screen derivatives
// (taken here, in uniform control flow, for whichever plane a pixel picks).
struct GrainProjection { coordinate: vec2f, dx: vec2f, dy: vec2f }
fn grainProjection(plane: vec2f) -> GrainProjection {
  let coordinate = plane / grainSize();
  return GrainProjection(coordinate, dpdx(coordinate), dpdy(coordinate));
}
@fragment fn fragment(input: VertexOutput) -> FragmentOutput {
  return shadeSurface(input, grainProjection(input.world.xz), grainProjection(input.world.zy), grainProjection(input.world.xy), false);
}
@fragment fn fragmentMobile(input: VertexOutput) -> FragmentOutput {
  return shadeSurface(input, grainProjection(input.world.xz), grainProjection(input.world.zy), grainProjection(input.world.xy), true);
}
struct GrainOutput {
  @builtin(position) clip: vec4f,
  @location(0) local: vec2f,
  @location(1) tint: f32,
  @location(2) center: vec3f,
  @location(3) radius: f32,
  @location(4) physicalRadius: f32,
  @location(5) trailRatio: f32,
  @location(6) axis: vec2f,
}
@vertex fn grainVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GrainOutput {
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let grain = grains[instance];
  let corner = corners[vertex];
  let enabled = grain.position.w > 0.0;
  let physicalRadius = select(0.0, ${SAND.airborneGrainRadius} * pow(max(grain.position.w, 1e-9) / ${SAND.airborneReferenceMass}, 1.0 / 3.0), enabled);
  let relative = grain.position.xyz - view.eye.xyz;
  let cameraDepth = max(dot(relative, view.forward.xyz), 0.01);
  let worldPerPixel = 2.0 * view.eye.w * cameraDepth / max(view.grid.w, 1.0);
  let renderRadius = max(physicalRadius, worldPerPixel * 0.72);
  let cameraVelocity = vec2f(dot(grain.velocity.xyz, view.right.xyz), dot(grain.velocity.xyz, view.up.xyz));
  let projectedSpeed = length(cameraVelocity);
  let axis = select(vec2f(1.0, 0.0), cameraVelocity / max(projectedSpeed, 1e-8), projectedSpeed > 1e-5);
  let side = vec2f(-axis.y, axis.x);
  let shutter = 0.0035;
  let halfTrail = min(projectedSpeed * shutter * 0.5, worldPerPixel * 3.0);
  let blurCenter = grain.position.xyz - (view.right.xyz * cameraVelocity.x + view.up.xyz * cameraVelocity.y) * shutter * 0.5;
  let extent = renderRadius + halfTrail;
  let cameraOffset = axis * (corner.x * extent) + side * (corner.y * renderRadius);
  let position = blurCenter + view.right.xyz * cameraOffset.x + view.up.xyz * cameraOffset.y;
  var output: GrainOutput;
  output.clip = select(vec4f(2.0, 2.0, 2.0, 1.0), project(position), enabled);
  output.local = vec2f(corner.x * extent / max(renderRadius, 1e-9), corner.y);
  output.tint = hash2(vec2f(f32(instance), 17.0)).x;
  output.center = blurCenter;
  output.radius = renderRadius;
  output.physicalRadius = physicalRadius;
  output.trailRatio = halfTrail / max(renderRadius, 1e-9);
  output.axis = axis;
  return output;
}
struct GrainFragmentOutput { @location(0) color: vec4f, @location(1) glint: f32, @builtin(frag_depth) depth: f32 }
@fragment fn grainFragment(input: GrainOutput) -> GrainFragmentOutput {
  let excess = max(abs(input.local.x) - input.trailRatio, 0.0);
  let local = vec2f(sign(input.local.x) * excess, input.local.y);
  let squared = dot(local, local);
  if (squared > 1.0) { discard; }
  let sphereDepth = sqrt(max(0.0, 1.0 - squared));
  let axisWorld = view.right.xyz * input.axis.x + view.up.xyz * input.axis.y;
  let sideWorld = view.right.xyz * -input.axis.y + view.up.xyz * input.axis.x;
  let nearest = input.center + axisWorld * (clamp(input.local.x, -input.trailRatio, input.trailRatio) * input.radius);
  let normal = normalize(axisWorld * local.x + sideWorld * local.y - view.forward.xyz * sphereDepth);
  let surface = nearest + normal * input.radius;
  let light = normalize(view.light.xyz);
  let towardEye = normalize(view.eye.xyz - surface);
  let halfway = normalize(light + towardEye);
  let diffuse = max(0.0, dot(normal, light));
  let fresnel = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(halfway, towardEye)), 5.0);
  let sparkle = pow(max(0.0, dot(normal, halfway)), 36.0) * fresnel;
  let sandAlbedo = mix(vec3f(0.46, 0.315, 0.17), vec3f(0.72, 0.56, 0.33), input.tint);
  let albedo = mix(sandAlbedo, view.tint.rgb * dot(sandAlbedo, vec3f(0.2126, 0.7152, 0.0722)) / 0.45, view.material.x);
  let shade = treeShadow(surface.xz);
  let ambient = environment(normal) * 0.34;
  let direct = view.sun.rgb * diffuse * shade;
  let radiance = albedo * (ambient + direct) + environment(reflect(-towardEye, normal)) * sparkle * 0.55 * smoothstep(0.72, 0.94, shade);
  let physicalArea = 3.141593 * input.physicalRadius * input.physicalRadius;
  let capsuleArea = 3.141593 * input.radius * input.radius + 4.0 * input.radius * (input.trailRatio * input.radius);
  let areaCoverage = clamp(physicalArea / max(capsuleArea, 1e-12), 0.0, 1.0);
  let profile = 1.0 - smoothstep(0.34, 1.0, squared);
  let alpha = min(0.94, areaCoverage * profile * 2.15);
  let projected = project(surface);
  var output: GrainFragmentOutput;
  output.color = vec4f(radiance * alpha, alpha);
  output.glint = sparkle * alpha * 0.18;
  output.depth = projected.z / projected.w;
  return output;
}
`;
