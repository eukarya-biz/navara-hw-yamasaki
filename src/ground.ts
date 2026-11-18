// The city above the underground: terrain, aerial photos and the PLATEAU
// buildings of Shinjuku, on the same globe and in the same coordinates as the
// underground model -- show the map and the streets are right overhead.
//
// Heights are ORTHOMETRIC throughout, to match the underground (its tiles, the
// walk grid and every height constant in this scene are CityGML
// heights above Tokyo Bay). navara reads every height as ellipsoidal, so the
// whole world sits 37 m below the true ellipsoid -- invisible at any scale
// where it matters, and inside Shinjuku everything lines up to the metre:
//   - terrain: GSI elevation tiles, which are orthometric already
//   - buildings: PLATEAU's distributed 3D Tiles are ellipsoidal, so they are
//     lowered by the geoid height (37.0 m across the whole ward)
//
// Shown by camera height: above the ground the globe is opaque and the city is
// there; going down through the surface it fades out within GROUND_FADE_M of
// it, which is the "through the ground into the underground" moment of the
// opening, and the way back up for free flight. The underground ceiling is
// ~6 m below the street at the start point, so the fade is done before it.
// Off (setEnabled(false)) keeps the underground on its own, as the closing
// shot wants it.

import ThreeView, { Color, JAPAN_GSI_ELEVATION_DECODER, type Layer } from "@navaramap/three";

/** GSI elevation tiles (PNG, 10 m mesh, z1-14, orthometric). */
const DEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png";
/** GSI seamless aerial photos (z2-18). */
const PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";
/**
 * Sentinel-2 cloudless 2016 (EOX, CC BY 4.0): the globe seen from orbit.
 * Taken from the Re:Earth Papers TileJSON
 * (https://papers.reearth.land/s2cloudless_2016/tilejson.json) and written in
 * directly: fetching the TileJSON first held the opening on a blank white
 * globe for ~2 s. Update by hand if that TileJSON's `tiles` ever changes.
 */
const WORLD_IMAGERY_URL =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg";
/** Below this height the coarse world imagery is dropped so the GSI detail shows. */
const WORLD_IMAGERY_HANDOFF_M = 300_000;
/** PLATEAU Shinjuku Ward buildings, LOD2, FY2025 (official distribution). */
const BUILDINGS_URL =
  "https://assets.cms.plateau.reearth.io/assets/2f/d4f9a7-13ad-43cb-b984-033803199eab/" +
  "13104_shinjuku-ku_pref_2025_citygml_1_op_bldg_3dtiles_13104_shinjuku-ku_lod2_no_texture/tileset.json";
/** Geoid height over Shinjuku (ellipsoidal minus orthometric). */
const GEOID_HEIGHT_M = 37.0;
/** The ground fades out this far either side of the terrain surface. */
const GROUND_FADE_M = 2;
/**
 * Ground level around Shinjuku Station, orthometric. Stands in for the terrain
 * height until its tile has loaded -- treating that as 0 m would put an
 * underground camera "26 m above the ground" and show the city over it.
 */
export const SHINJUKU_SURFACE_M = 38;

const GSI_CREDIT = {
  attribution: "国土地理院 (地理院タイル)",
  attributionUrl: "https://maps.gsi.go.jp/development/ichiran.html",
};

export class Ground {
  private enabled = false;
  /** Last opacity written, so the layers are only touched when it changes. */
  private shown = -1;
  private photo: Layer | null = null;
  private buildings: Layer | null = null;
  private worldImagery: Layer | null = null;

  constructor(private readonly view: ThreeView) {}

  /** Add the layers. Call once after `view.init()`. Starts disabled. */
  init(): void {
    const { view } = this;
    // Rasters before the terrain: a raster layer added after the terrain layer
    // is not draped on it (navara 0.2.1 and 0.3.1, checked headless) -- the globe stays
    // plain white.
    this.photo = view.addLayer({
      type: "raster",
      source: view.addSource({ type: "raster-tile", url: PHOTO_URL, maxZoom: 18 }),
      raster: { color: new Color().setHex(0xffffff), opacity: 0, show: false },
    });
    // From orbit the GSI world mosaic has a grey gap east of Japan.
    this.worldImagery = view.addLayer({
      type: "raster",
      source: view.addSource({ type: "raster-tile", url: WORLD_IMAGERY_URL, maxZoom: 9 }),
      raster: { color: new Color().setHex(0xffffff), opacity: 1 },
    });
    view.addLayer({
      type: "terrain",
      source: view.addSource({
        type: "raster-dem",
        url: DEM_URL,
        elevationDecoder: JAPAN_GSI_ELEVATION_DECODER(),
        tileSize: 256,
        maxZoom: 15,
      }),
    });

    this.buildings = view.addLayer({
      type: "3d-tiles",
      source: view.addSource({ type: "3d-tiles", url: BUILDINGS_URL }),
      model: {
        show: false,
        height: -GEOID_HEIGHT_M,
        color: new Color().setHex(0xe8e4dc),
        maxSse: 16,
      },
    });

    view.on("preRender", this.update);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.view.attribution?.add([GSI_CREDIT]);
    else this.view.attribution?.remove([GSI_CREDIT]);
    // Applied by update() on the next preRender, not here: right after
    // view.init() the camera has no position to read yet.
  }

  private update = (): void => {
    const { view } = this;
    const pos = view.camera.positionGeographic;

    if (this.worldImagery && pos.height < WORLD_IMAGERY_HANDOFF_M) {
      this.worldImagery.delete();
      this.worldImagery = null;
      console.info(`[ground] world imagery released at ${pos.height.toFixed(0)} m`);
    }

    const surface = view.sampleTerrainHeight({ lat: pos.lat, lng: pos.lng }) ?? SHINJUKU_SURFACE_M;
    const target = this.enabled ? Math.min(1, Math.max(0, (pos.height - surface + GROUND_FADE_M) / (2 * GROUND_FADE_M))) : 0;
    const opacity = Math.round(target * 50) / 50;
    if (opacity === this.shown) return;
    this.shown = opacity;

    view.globe.transparent = opacity < 1;
    view.globe.opacity = opacity;
    this.photo?.update({ raster: { opacity, show: opacity > 0 } });
    this.buildings?.update({ model: { opacity, transparent: opacity < 1, show: opacity > 0 } });
  };
}
