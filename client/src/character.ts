import {
  Scene,
  SceneLoader,
  AssetContainer,
  AnimationGroup,
  TransformNode,
  Skeleton,
  type AbstractMesh,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export type Locomotion = "idle" | "walk" | "run";

// Map a locomotion state to candidate clip-name fragments (case-insensitive,
// substring match) so different rigs — and instantiate's "Clone of …" prefixes —
// still resolve.
const CLIP_ALIASES: Record<Locomotion, string[]> = {
  idle: ["idle", "survey", "stand"],
  walk: ["walk"],
  run:  ["run", "sprint"],
};

// Loads a character GLB once into an asset container, then stamps out
// independent animated instances via instantiateModelsToScene. Each instance
// gets its own skeleton and animation clips, so the local player and every
// remote player animate independently while sharing one downloaded/decoded mesh.
export class CharacterFactory {
  private nativeHeight: number;
  private feetOffset: number;

  private constructor(
    private container: AssetContainer,
    private scene: Scene,
    private targetHeight: number,
  ) {
    // Measure native bounds from the (unrendered) template meshes so every
    // instance can be scaled to targetHeight with its feet at the holder origin.
    let minY = Infinity, maxY = -Infinity;
    for (const m of container.meshes) {
      if ((m.getTotalVertices?.() ?? 0) === 0) continue;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      minY = Math.min(minY, bb.minimumWorld.y);
      maxY = Math.max(maxY, bb.maximumWorld.y);
    }
    this.feetOffset = Number.isFinite(minY) ? minY : 0;
    this.nativeHeight = Math.max(maxY - minY, 1e-3);
  }

  static async load(scene: Scene, url: string, targetHeight = 1.8): Promise<CharacterFactory> {
    const container = await SceneLoader.LoadAssetContainerAsync("", url, scene);
    return new CharacterFactory(container, scene, targetHeight);
  }

  // Create an independent animated instance whose root node is `name`.
  create(name: string): Character {
    const entries = this.container.instantiateModelsToScene(undefined, false);
    const holder = new TransformNode(name, this.scene);
    const root = entries.rootNodes[0] as TransformNode;
    root.parent = holder;
    root.position.y -= this.feetOffset;
    holder.scaling.setAll(this.targetHeight / this.nativeHeight);
    return new Character(holder, root.getChildMeshes(false), entries.animationGroups, entries.skeletons);
  }
}

// One animated character instance. Parent and position `holder` (origin at the
// feet); drive animation with setLocomotion().
export class Character {
  readonly holder: TransformNode;
  readonly meshes: AbstractMesh[];
  private clips = new Map<string, AnimationGroup>();
  private skeletons: Skeleton[];
  private current: AnimationGroup | null = null;

  constructor(holder: TransformNode, meshes: AbstractMesh[], groups: AnimationGroup[], skeletons: Skeleton[]) {
    this.holder = holder;
    this.meshes = meshes;
    this.skeletons = skeletons;
    for (const g of groups) {
      g.stop();
      this.clips.set(g.name.toLowerCase(), g);
    }
  }

  // Switch locomotion clip; transitions are smoothed by the scene's
  // animationPropertiesOverride. No-op if already current.
  setLocomotion(state: Locomotion): void {
    const clip = this.pick(state);
    if (!clip || clip === this.current) return;
    this.current?.stop();
    clip.start(true);
    this.current = clip;
  }

  dispose(): void {
    for (const g of this.clips.values()) g.dispose();
    for (const s of this.skeletons) s.dispose();
    this.holder.dispose();
  }

  private pick(state: Locomotion): AnimationGroup | null {
    for (const fragment of CLIP_ALIASES[state]) {
      for (const [name, clip] of this.clips) if (name.includes(fragment)) return clip;
    }
    return this.clips.values().next().value ?? null; // fallback: any clip
  }
}
