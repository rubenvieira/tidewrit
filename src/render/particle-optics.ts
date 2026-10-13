import { DAYLIGHTS } from './daylight'

const luminanceWeights = [0.2126, 0.7152, 0.0722] as const
const afternoonGlintLuminance = DAYLIGHTS[0].sun.reduce((sum, value, axis) => sum + value * luminanceWeights[axis], 0)

// Bounded particle exposure and solar response. Trail size and placement share
// one footprint so a capped streak still ends at the simulated grain center.
export const particleOpticsWgsl = `
struct ParticleTrail { axis: vec2f, halfLength: f32, centerOffset: vec2f }
fn particleTrail(cameraVelocity: vec2f, worldPerPixel: f32) -> ParticleTrail {
  let speed = length(cameraVelocity);
  let axis = select(vec2f(1.0, 0.0), cameraVelocity / max(speed, 1e-8), speed > 1e-5);
  let halfLength = min(speed * 0.0035 * 0.5, worldPerPixel * 3.0);
  return ParticleTrail(axis, halfLength, -axis * halfLength);
}
fn particleGlintGain(directLight: vec3f, visibility: f32, kinetic: f32) -> f32 {
  // Keep the authored afternoon appearance while solar flashes follow the
  // actual light energy, the existing palm visibility, and matte polymer.
  let lightEnergy = max(0.0, dot(directLight, vec3f(${luminanceWeights.join(', ')}))) / ${afternoonGlintLuminance};
  return lightEnergy * visibility * mix(1.0, 0.08, kinetic);
}
`
