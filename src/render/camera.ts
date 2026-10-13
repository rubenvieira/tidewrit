import { SAND, type Point } from '../config'

export type Vector3 = [number, number, number]
export function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(...vector)
  return vector.map((component) => component / length) as Vector3
}
export class SandCamera {
  // The eye sits a fixed height above the bed surface, so bed depth never changes the view.
  readonly eye: Vector3 = [0, SAND.depth + 0.488, 0.26]
  readonly forward = normalize([0, SAND.depth - this.eye[1], -this.eye[2]])
  readonly right: Vector3 = [1, 0, 0]
  readonly up: Vector3 = [0, -this.forward[2], this.forward[1]]
  readonly distance = Math.hypot(this.eye[1] - SAND.depth, this.eye[2])
  aspect = 1
  get tanHalfFov() { return 0.22 / this.distance / Math.max(1, this.aspect) }
  screenToBed(clientX: number, clientY: number, width: number, height: number): Point {
    const horizontal = (2 * clientX / width - 1) * this.tanHalfFov * this.aspect
    const vertical = (1 - 2 * clientY / height) * this.tanHalfFov
    const direction = this.forward.map((component, axis) => component + horizontal * this.right[axis] + vertical * this.up[axis])
    const distance = (SAND.depth - this.eye[1]) / direction[1]
    return { x: this.eye[0] + direction[0] * distance, y: this.eye[2] + direction[2] * distance }
  }
}
