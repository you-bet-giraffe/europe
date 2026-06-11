import {
  Scene,
  SceneLoader,
  AnimationGroup,
  TransformNode,
  type AbstractMesh,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export type Locomotion = "idle" | "walk" | "run";

// Map a locomotion state to candidate clip-name fragments (case-insensitive,
// substring match) so different rigs with different naming still resolve.
const CLIP_ALIASES: Record<Locomotion, string[]> = {
  idle: ["idle", "survey", "stand"],
  walk: ["walk"],
  run:  ["run", "sprint"],
};

// A loaded, animated character. Parent and position `holder`; drive animation
// with setLocomotion(). Loading is format-agnostic glTF/GLB: skeleton, skinning,
// and animation clips all come from the file.
export class Character {
  readonly holder: TransformNode;       // origin at the feet; move/rotate this
  readonly meshes: AbstractMesh[];
  private clips = new Map<string, AnimationGroup>();
  private current: AnimationGroup | null = null;

  private constructor(holder: TransformNode, meshes: AbstractMesh[], groups: AnimationGroup[]) {
    this.holder = holder;
    this.meshes = meshes;
    for (const g of groups) {
      g.stop();
      this.clips.set(g.name.toLowerCase(), g);
    }
  }

  // Load a GLB and normalise it to `targetHeight` metres with its feet at the
  // holder origin. The glTF loader's own root transform is left intact (unlike
  // the terrain tiles, which bake their own coordinate space).
  static async load(scene: Scene, url: string, targetHeight = 1.8): Promise<Character> {
    const result = await SceneLoader.ImportMeshAsync("", "", url, scene);
    const loaderRoot = result.meshes.find((m) => !m.parent) ?? result.meshes[0];
    loaderRoot.computeWorldMatrix(true);

    const { min, max } = loaderRoot.getHierarchyBoundingVectors(true);
    const nativeHeight = Math.max(max.y - min.y, 1e-3);

    const holder = new TransformNode("playerCharacter", scene);
    loaderRoot.parent = holder;
    loaderRoot.position.y -= min.y;        // drop the lowest point to the origin
    holder.scaling.setAll(targetHeight / nativeHeight);

    return new Character(holder, result.meshes, result.animationGroups);
  }

  // Switch locomotion clip. Transitions are smoothed by the scene's
  // animationPropertiesOverride (blending). No-op if already current.
  setLocomotion(state: Locomotion): void {
    const clip = this.pick(state);
    if (!clip || clip === this.current) return;
    this.current?.stop();
    clip.start(true);
    this.current = clip;
  }

  private pick(state: Locomotion): AnimationGroup | null {
    for (const fragment of CLIP_ALIASES[state]) {
      for (const [name, clip] of this.clips) if (name.includes(fragment)) return clip;
    }
    return this.clips.values().next().value ?? null; // fallback: any clip
  }
}
