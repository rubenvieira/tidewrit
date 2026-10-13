// Micro-topography of untouched sand, shared by the initial bed and the wave
// reset so both lay down the same surface. Smooth value noise at a few scales
// (centimetre swells with millimetre bumps on top) replaces independent per-cell
// random heights, which read as a regular woven grid under a low sun. Slopes
// stay far below the angle of repose, so the relief never flows on its own.
export const bedReliefWgsl = `
fn reliefHash(cell: vec2f) -> f32 {
  let folded = fract(cell * vec2f(0.1031, 0.1137));
  let mixed = folded + dot(folded, folded.yx + 31.32);
  return fract((mixed.x + mixed.y) * mixed.x);
}
fn reliefNoise(position: vec2f) -> f32 {
  let cell = floor(position);
  let blend = fract(position);
  let smoothBlend = blend * blend * (3.0 - 2.0 * blend);
  return mix(mix(reliefHash(cell), reliefHash(cell + vec2f(1.0, 0.0)), smoothBlend.x),
    mix(reliefHash(cell + vec2f(0.0, 1.0)), reliefHash(cell + vec2f(1.0, 1.0)), smoothBlend.x), smoothBlend.y) - 0.5;
}
fn bedRelief(position: vec2f) -> f32 {
  let swell = reliefNoise(position / 0.045) * 0.00045 + reliefNoise(position / 0.017 + 7.3) * 0.0002;
  let bumps = reliefNoise(position / 0.0055 + 19.1) * 0.00008 + reliefNoise(position / 0.0029 - 4.7) * 0.00004;
  // The original long, low undulation of the tray.
  let undulation = 0.0003 * sin(position.x * 31.0 + sin(position.y * 23.0)) * sin(position.y * 27.0);
  return swell + bumps + undulation;
}
`
