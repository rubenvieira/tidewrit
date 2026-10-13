// Selected-grain geometry only: these helpers add no neighbor searches or
// texture reads and are shared with numerical WGSL regression tests.
export const grainReliefWgsl = `
fn grainMetricGradient(axis: vec2f, local: vec2f, aspect: f32) -> vec2f {
  let perpendicular = vec2f(-axis.y, axis.x);
  // local already contains one aspect transform. The gradient needs its
  // transpose too, otherwise elongated crowns reflect like round grains.
  return axis * (local.x / aspect) + perpendicular * (local.y * aspect);
}
fn tangentRelief(normal: vec3f, relief: vec3f) -> vec3f {
  return relief - normal * dot(relief, normal);
}
fn grainReliefScale(film: f32, packedness: f32, kinetic: f32) -> f32 {
  // Height and normal must describe the same softened crown under a film
  // or on packed kinetic sand, including when loose grains land on it.
  return (1.0 - film * 0.85) * (1.0 - 0.55 * packedness * kinetic);
}
`
