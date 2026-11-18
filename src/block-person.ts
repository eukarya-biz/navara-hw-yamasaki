// Procedural low-poly person, shared by the parent (src/goal.ts) and used as
// the proportions reference for the instanced crowd (src/crowd-instanced.ts).

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";

export type BlockPerson = {
  group: Group;
  leftHip: Group;
  rightHip: Group;
  leftShoulder: Group;
  rightShoulder: Group;
  /** The one material every part shares, for tinting the whole figure. */
  material: MeshStandardMaterial;
};

/**
 * A handful of boxes standing in for Kenney/Kay Lousberg's rigged characters.
 * Adult-scale (~1.6-1.75 m) on purpose: the whole point of the project is a
 * child looking *up* at these from 1.0 m.
 */
export function buildBlockPerson(color: number, heightScale: number): BlockPerson {
  const mat = new MeshStandardMaterial({ color, roughness: 0.9 });
  const group = new Group();
  const s = heightScale;

  const hipY = 0.75 * s;
  const shoulderY = 1.35 * s;

  // Torso spans exactly hip..shoulder, so the head and arms below can be
  // attached to those lines with no gap. (An earlier version sized the torso
  // independently and left the head floating ~13 cm above it.)
  const torsoHeight = shoulderY - hipY;
  const torsoHalfWidth = 0.16 * s;
  const torso = new Mesh(
    new BoxGeometry(torsoHalfWidth * 2, torsoHeight, 0.18 * s),
    mat,
  );
  torso.position.y = (hipY + shoulderY) / 2;
  group.add(torso);

  // Head sits directly on the shoulder line.
  const headSize = 0.22 * s;
  const head = new Mesh(new BoxGeometry(0.2 * s, headSize, 0.2 * s), mat);
  head.position.y = shoulderY + headSize / 2;
  group.add(head);

  function limb(
    pivotY: number,
    sideX: number,
    length: number,
    thickness: number,
  ): Group {
    const pivot = new Group();
    pivot.position.set(sideX, pivotY, 0);
    const box = new Mesh(new BoxGeometry(thickness, length, thickness), mat);
    box.position.y = -length / 2;
    pivot.add(box);
    group.add(pivot);
    return pivot;
  }

  // Legs reach the floor (length == hipY), and sit under the torso.
  const legThickness = 0.13 * s;
  const leftHip = limb(hipY, -0.09 * s, hipY, legThickness);
  const rightHip = limb(hipY, 0.09 * s, hipY, legThickness);

  // Arms hug the torso sides: offset = torso half-width + half the arm's own
  // thickness, so the inner face touches the body instead of floating beside it.
  const armThickness = 0.09 * s;
  const armX = torsoHalfWidth + armThickness / 2;
  const leftShoulder = limb(shoulderY, -armX, 0.5 * s, armThickness);
  const rightShoulder = limb(shoulderY, armX, 0.5 * s, armThickness);

  return { group, leftHip, rightHip, leftShoulder, rightShoulder, material: mat };
}
