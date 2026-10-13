import type { Point, Symmetry } from '../config'

// One element of the dihedral group: an optional reflection across the bed's
// vertical axis followed by a rotation about the bed center.
export type SymmetryImage = { cos: number; sin: number; flip: boolean; rotation: number }

const cache = new Map<Symmetry, SymmetryImage[]>()

export function symmetryImages(symmetry: Symmetry): SymmetryImage[] {
  const cached = cache.get(symmetry)
  if (cached) return cached
  const images: SymmetryImage[] = []
  for (const flip of symmetry.mirror ? [false, true] : [false]) {
    for (let index = 0; index < symmetry.rotations; index++) {
      const rotation = index * Math.PI * 2 / symmetry.rotations
      images.push({ cos: Math.cos(rotation), sin: Math.sin(rotation), flip, rotation })
    }
  }
  cache.set(symmetry, images)
  return images
}

/** Transforms a position or a direction vector (the group fixes the bed center). */
export function transformVector(image: SymmetryImage, vector: Point): Point {
  const x = image.flip ? -vector.x : vector.x
  return { x: image.cos * x - image.sin * vector.y, y: image.sin * x + image.cos * vector.y }
}

/** Transforms the orientation of a shape that is symmetric about its own axis. */
export function transformAngle(image: SymmetryImage, angle: number) {
  return (image.flip ? -angle : angle) + image.rotation
}
