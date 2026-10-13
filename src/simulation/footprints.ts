import { MOLD_PREVIEW_KIND, TINES, TOOL_KIND, WIND_WAVELENGTH } from '../config'

const wgslFloat = (value: number) => value.toFixed(6)
const tined = (tines: { half: number; spacing: number; radius: number }) => {
  const reach = tines.half * tines.spacing + tines.radius
  return { spacing: wgslFloat(reach / tines.spacing), radius: wgslFloat(tines.radius / tines.spacing), half: wgslFloat(tines.half) }
}
const rake = tined(TINES.rake)
const broom = tined(TINES.broom)

// Tool footprints shared by the granular solver and the hover preview so the
// preview outline is exactly the contact the bed will receive. Each returns
// (normalized distance, coverage): distance 1 is the contact edge and drives
// the disturbed shell; coverage scales penetration depth.
export const toolFootprints = `
fn fingerFootprint(offset: vec2f, radius: f32) -> vec2f {
  let distance = length(offset) / max(radius, 1e-7);
  let envelope = max(0.0, 1.0 - distance * distance);
  return vec2f(distance, envelope * envelope);
}
fn tinedFootprint(offset: vec2f, side: vec2f, spacing: f32, radius: f32, half: f32) -> vec2f {
  // Capsule tines spread across the stroke, all sharing one swept path. Each
  // cell resolves to its nearest tine, so curves stay continuous.
  let tine = clamp(round(dot(offset, side) / spacing), -half, half);
  return fingerFootprint(offset - side * tine * spacing, radius);
}
fn rakeFootprint(offset: vec2f, side: vec2f, reach: f32) -> vec2f {
  let spacing = reach / ${rake.spacing};
  return tinedFootprint(offset, side, spacing, spacing * ${rake.radius}, ${rake.half});
}
fn broomFootprint(offset: vec2f, side: vec2f, reach: f32) -> vec2f {
  // Fine bristles of uneven stiffness: each bristle keeps its own depth so the
  // sweep leaves streaks rather than a uniform comb.
  let spacing = reach / ${broom.spacing};
  let tine = clamp(round(dot(offset, side) / spacing), -${broom.half}, ${broom.half});
  let bristle = tinedFootprint(offset, side, spacing, spacing * ${broom.radius}, ${broom.half});
  let stiffness = 0.5 + 0.5 * fract(sin((tine + 7.0) * 12.9898) * 43758.5453);
  return vec2f(bristle.x, bristle.y * stiffness);
}
fn smoothFootprint(offset: vec2f, direction: vec2f, side: vec2f, reach: f32) -> vec2f {
  // Tilted trowel: square-shouldered across the stroke, with depth ramping from
  // zero at the leading edge to full at the trailing edge. The ramp makes every
  // cell under the blade shed its excess forward, so material is carried as a
  // bow wave instead of diffusing sideways; the sharp trailing edge sets the
  // final level.
  let across = abs(dot(offset, side)) / max(reach, 1e-7);
  let along = dot(offset, direction) / max(reach * 0.5, 1e-7);
  let distance = sqrt(pow(across, 8.0) + along * along);
  let ramp = 1.0 - clamp(along * 0.5 + 0.5, 0.0, 1.0);
  return vec2f(distance, (1.0 - smoothstep(0.72, 1.0, distance)) * ramp);
}
fn shellFootprint(offset: vec2f, angle: f32, reach: f32) -> vec2f {
  // Scallop imprint: a ribbed fan opening from a hinge with two small ears.
  let local = headingFrame(offset, angle) / max(reach, 1e-7);
  let fan = local - vec2f(0.0, -0.6);
  let spread = atan2(fan.x, fan.y);
  let body = max(length(local - vec2f(0.0, 0.08)) / 0.92, abs(spread));
  let ears = max(abs(local.x) / 0.34, abs(local.y + 0.61) / 0.12);
  let distance = min(body, ears);
  let rib = 0.5 + 0.5 * cos(spread * 3.14159265 * 4.5);
  let ribbing = mix(1.0, 0.72 + 0.28 * rib, smoothstep(0.2, 0.55, length(fan)) * step(body, ears));
  let dome = sqrt(max(0.0, 1.0 - distance * distance));
  return vec2f(distance, dome * ribbing * (1.0 - smoothstep(0.86, 1.0, distance)));
}
fn headingFrame(offset: vec2f, angle: f32) -> vec2f {
  // Local frame whose +y is the heading (-sin a, cos a), shared with the shell.
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(c * offset.x + s * offset.y, -s * offset.x + c * offset.y);
}
fn windFootprint(offset: vec2f, origin: vec2f, angle: f32, reach: f32) -> vec2f {
  // Aeolian ripples. Phase is locked to world position along the gesture's
  // wind heading, so overlapping passes reinforce the same crests. Each
  // ripple rises gently over its upwind (stoss) side and drops steeply on the
  // lee; depth is set in the troughs, so transport heaps the crests.
  let distance = length(offset) / max(reach, 1e-7);
  let brush = 1.0 - smoothstep(0.55, 1.0, distance);
  let wind = vec2f(-sin(angle), cos(angle));
  let across = dot(origin, vec2f(-wind.y, wind.x));
  let wavelength = max(reach * ${WIND_WAVELENGTH.toFixed(6)}, 1e-7);
  // Crests meander gently along their length, as real ripples do.
  let meander = 0.22 * sin(across / wavelength * 0.9) + 0.12 * sin(across / wavelength * 2.3 + 1.7);
  let phase = fract(dot(origin, wind) / wavelength + meander);
  let crest = smoothstep(0.0, 1.0, select((1.0 - phase) / 0.25, phase / 0.75, phase < 0.75));
  return vec2f(distance, brush * (1.0 - crest));
}
fn ellipseDistance(local: vec2f, center: vec2f, radii: vec2f) -> f32 {
  return length((local - center) / radii);
}
fn footFootprint(offset: vec2f, angle: f32, variant: f32, reach: f32) -> vec2f {
  // Bare foot, toes along the heading, big toe on local +x. Variant -1 is the
  // mirror image; the walker places +1 feet on the local -x side of its path,
  // so big toes always face the centerline. Each pad is weighted by how hard
  // it presses: heel deepest, the raised inner arch not touching at all.
  var local = headingFrame(offset, angle) / max(reach, 1e-7);
  local.x *= select(-1.0, 1.0, variant >= 0.0);
  let pads = array<vec4f, 8>(
    vec4f(0.0, -0.62, 0.27, 0.3),
    vec4f(0.03, 0.28, 0.36, 0.3),
    vec4f(-0.13, -0.18, 0.2, 0.42),
    vec4f(0.22, 0.79, 0.15, 0.16),
    vec4f(0.0, 0.86, 0.1, 0.11),
    vec4f(-0.15, 0.81, 0.09, 0.1),
    vec4f(-0.28, 0.72, 0.085, 0.09),
    vec4f(-0.38, 0.6, 0.08, 0.085));
  let weights = array<f32, 8>(1.0, 0.85, 0.55, 0.75, 0.6, 0.55, 0.5, 0.45);
  var distance = 1e6;
  var coverage = 0.0;
  for (var pad = 0u; pad < 8u; pad++) {
    let d = ellipseDistance(local, pads[pad].xy, pads[pad].zw);
    distance = min(distance, d);
    coverage = max(coverage, weights[pad] * sqrt(max(0.0, 1.0 - d * d)) * (1.0 - smoothstep(0.8, 1.0, d)));
  }
  return vec2f(distance, coverage);
}
// Bucket molds. Each returns (normalized distance, height in mold radii) for
// local coordinates in mold radii with +y toward the mold's front.
fn crenels(angle: f32, count: f32) -> f32 {
  return smoothstep(-0.3, 0.3, cos(angle * count));
}
fn moldTower(local: vec2f) -> vec2f {
  // A flipped bucket: tapered walls, a crenellated parapet around a court.
  let r = length(local);
  let taper = clamp((1.0 - r) / 0.16, 0.0, 1.0);
  let parapet = smoothstep(0.56, 0.62, r);
  let top = mix(0.9, 1.0 + 0.18 * crenels(atan2(local.y, local.x), 8.0), parapet);
  return vec2f(r, taper * top);
}
fn moldCastle(local: vec2f) -> vec2f {
  // Square curtain wall with merlons, a round turret at each corner, and a
  // crenellated round keep in the court.
  let a = abs(local);
  let ring = max(a.x, a.y);
  let along = select(local.y, local.x, a.y > a.x);
  let wall = (1.0 - smoothstep(0.07, 0.1, abs(ring - 0.58))) * (0.38 + 0.1 * crenels(along * 3.14159265, 7.0));
  let turretOffset = a - vec2f(0.58);
  // Turrets and keep are as tall as damp sand's cohesion lets them stand.
  let turretDistance = length(turretOffset) / 0.27;
  let turret = clamp((1.0 - turretDistance) / 0.18, 0.0, 1.0) * (0.55 + 0.1 * crenels(atan2(turretOffset.y, turretOffset.x), 6.0));
  let keepDistance = length(local) / 0.32;
  let keep = clamp((1.0 - keepDistance) / 0.15, 0.0, 1.0) * (0.72 + 0.12 * crenels(atan2(local.y, local.x), 7.0));
  let outline = min(ring / 0.68, turretDistance);
  return vec2f(outline, max(wall, max(turret, keep)));
}
fn moldStarfish(local: vec2f) -> vec2f {
  // Five tapering arms, one along +y, covered in small knobs.
  let r = length(local);
  let angle = atan2(local.x, local.y);
  let arm = pow(abs(cos(angle * 2.5)), 1.6);
  let reach = 0.27 + 0.7 * arm;
  let distance = r / reach;
  let knobs = 0.5 + 0.5 * sin(local.x * 46.0) * sin(local.y * 46.0);
  return vec2f(distance, 0.3 * sqrt(max(0.0, 1.0 - distance * distance)) * (0.9 + 0.12 * knobs));
}
fn ellipsePad(local: vec2f, center: vec2f, radii: vec2f, angle: f32) -> f32 {
  let c = cos(angle);
  let s = sin(angle);
  let offset = local - center;
  return length(vec2f(c * offset.x + s * offset.y, -s * offset.x + c * offset.y) / radii);
}
fn moldTurtle(local: vec2f) -> vec2f {
  // Domed shell with grooved plates, head toward +y, four flippers and a tail.
  let shellDistance = length(local / vec2f(0.55, 0.66));
  let dome = sqrt(max(0.0, 1.0 - shellDistance * shellDistance));
  let plateAngle = atan2(local.y / 0.66, local.x / 0.55);
  let ringGroove = 1.0 - smoothstep(0.0, 0.05, abs(shellDistance - 0.58));
  let spokeGroove = (1.0 - smoothstep(0.0, 0.06, abs(fract(plateAngle / 1.0471976 + 0.5) - 0.5) * 1.0471976 * shellDistance)) * step(0.58, shellDistance);
  let crossGroove = (1.0 - smoothstep(0.0, 0.03, abs(abs(local.y) - 0.2))) * step(shellDistance, 0.58);
  let shell = dome * (0.42 - 0.06 * max(ringGroove, max(spokeGroove, crossGroove)));
  let head = ellipsePad(local, vec2f(0.0, 0.82), vec2f(0.16, 0.2), 0.0);
  let frontLeft = ellipsePad(local, vec2f(-0.56, 0.42), vec2f(0.3, 0.12), 0.6);
  let frontRight = ellipsePad(local, vec2f(0.56, 0.42), vec2f(0.3, 0.12), -0.6);
  let backLeft = ellipsePad(local, vec2f(-0.42, -0.58), vec2f(0.2, 0.1), -0.5);
  let backRight = ellipsePad(local, vec2f(0.42, -0.58), vec2f(0.2, 0.1), 0.5);
  let tail = ellipsePad(local, vec2f(0.0, -0.78), vec2f(0.07, 0.13), 0.0);
  let limbs = min(min(frontLeft, frontRight), min(backLeft, backRight));
  let dome2 = (sqrt(max(0.0, 1.0 - head * head)) * 0.2);
  let flipper = sqrt(max(0.0, 1.0 - limbs * limbs)) * 0.12;
  let tailHeight = sqrt(max(0.0, 1.0 - tail * tail)) * 0.08;
  return vec2f(min(shellDistance, min(head, min(limbs, tail))), max(shell, max(dome2, max(flipper, tailHeight))));
}
fn moldShape(shape: u32, local: vec2f) -> vec2f {
  switch shape {
    case 1u: { return moldCastle(local); }
    case 2u: { return moldStarfish(local); }
    case 3u: { return moldTurtle(local); }
    case 4u: {
      let scallop = shellFootprint(local, 0.0, 1.0);
      return vec2f(scallop.x, scallop.y * 0.38);
    }
    default: { return moldTower(local); }
  }
}
fn knifeFootprint(offset: vec2f, reach: f32) -> vec2f {
  // A blade swept along its own edge: full depth across nearly its whole width.
  let distance = length(offset) / max(reach, 1e-7);
  return vec2f(distance, 1.0 - smoothstep(0.6, 1.0, distance));
}
fn toolFootprint(kind: u32, offset: vec2f, origin: vec2f, direction: vec2f, angle: f32, variant: f32, reach: f32) -> vec2f {
  let side = vec2f(-direction.y, direction.x);
  switch kind {
    case ${TOOL_KIND.rake}u: { return rakeFootprint(offset, side, reach); }
    case ${TOOL_KIND.broom}u: { return broomFootprint(offset, side, reach); }
    case ${TOOL_KIND.smooth}u: { return smoothFootprint(offset, direction, side, reach); }
    case ${TOOL_KIND.shell}u: { return shellFootprint(offset, angle, reach); }
    case ${TOOL_KIND.wind}u: { return windFootprint(offset, origin, angle, reach); }
    case ${TOOL_KIND.feet}u: { return footFootprint(offset, angle, variant, reach); }
    case ${TOOL_KIND.knife}u: { return knifeFootprint(offset, reach); }
    case ${MOLD_PREVIEW_KIND}u: { return moldShape(u32(variant + 0.5), headingFrame(offset, angle) / max(reach, 1e-7)); }
    default: { return fingerFootprint(offset, reach); }
  }
}
`
