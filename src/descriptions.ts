// The view's descriptor vocabulary: navara's defaults plus this scene's own
// mesh descriptors, so `view.addMesh()` accepts the custom keys (`goalParent`,
// `goalBeacon`, `trail`, `trailMarker`, `crowdPart`) without casts.
//
// This only widens what the type accepts. `view.registerMesh()` still has to
// run before the first `addMesh()` of each key -- that is what wires the key
// to its class at runtime.

import type ThreeView from "@navaramap/three";
import type { DefaultDescriptions } from "@navaramap/three-default-plugin";
import type { CrowdPartConfig } from "./crowd-instanced";
import type { BeaconConfig, ParentConfig } from "./goal";
import type { MarkerConfig, TrailConfig } from "./trail";

export type SceneDescriptions = {
  mesh:
    | DefaultDescriptions["mesh"]
    | ParentConfig
    | BeaconConfig
    | TrailConfig
    | MarkerConfig
    | CrowdPartConfig;
  light: DefaultDescriptions["light"];
  effect: DefaultDescriptions["effect"];
};

export type SceneView = ThreeView<SceneDescriptions>;
