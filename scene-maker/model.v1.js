/*!
 * mogutools 版: shiki365/scene-maker (MIT, Copyright (c) 2026 shiki365) をもとにしています。LICENSE.txt を参照。
 * model.v1.js - シーンメーカー: the state, its defaults, repair of old data, and state -> CCFOLIA scenes (no UI)
 *
 * state = { images, scenes, commonFg, commonMarkers, defaults, exportOpts, orderBase }
 *   images:   the image shelf: [{ id, name, type, size, hash, w, h, moving }]
 *             Only what an image is lives in state; its bytes are a Blob in IndexedDB.
 *   scenes:   [{ id, ccfId, name, text, bg, fg, width, height, sizeAuto, displayGrid, gridSize, fit, markers, useCommonMarkers }]
 *             bg: an image id or null.  fg: "common" (state.commonFg) | "none" | an image id.
 *             markers: this scene's marker panels; useCommonMarkers: also put state.commonMarkers on it.
 *             ccfId: the id the scene gets in CCFOLIA when exporting in "overwrite" mode.
 *             sizeAuto: the field size follows the background's shape until typed by hand.
 *   defaults: what a new scene starts with, and what the "全シーンに" buttons copy.
 *   marker:   { id, imageId, text, x, y, width, height, angle, locked, freezed, click, clickValue }
 *             x, y, width, height in cells; x, y is the top left, from the middle of the field (CCFOLIA's
 *             origin: the field's top left is at -floor(fieldWidth / 2), -floor(fieldHeight / 2)).
 *             click: "none" | "link" (clickValue = URL) | "message" (clickValue = the text said).
 *
 * Templates are not in state: they belong to the browser (or a templates file), not to one set of scenes.
 *   template = { id, label, scene, images }: scene is a scene without ids, its images named by content
 *   hash ("h:<sha-256>"), and images = { hash: { name, type, size, w, h, moving } } (bytes kept by the app).
 *
 * The shape of a scene is read from CCFOLIA 1.37.4 (main.09686af1.js, 2026-10-02), and is the
 * same in 1.37.6 (main.0f872b7d.js, checked 2026-10-30):
 *   fieldWidth / fieldHeight are in cells, one cell is 24 px; the screen takes 0-1000.
 *   gridSize is how many cells between grid lines (1-1000). fieldObjectFit is "fill" or "cover"
 *   ("cover" is the board settings' 画像を自動トリミングする).
 *   The list is ordered by `order`; a scene without it does not show.
 *   The media / sound fields are left as a new scene has them: audio cannot travel in the zip.
 *   All scenes of a zip are written in one Firestore batch, which used to take at most 500 writes,
 *   so one zip carries at most MAX_SCENES.
 *   Marker panels (scene.markers, module 79068 in 1.37.6): { <key>: { x, y, z, width, height, locked, freezed,
 *   text, imageUrl, angle, clickAction } }; clickAction is null, { type: "link", url } or { type: "message", text }.
 *   CCFOLIA draws the image stretched to the marker, shows text as a tooltip, and applying a scene replaces
 *   the board's markers with the scene's. imageUrl takes a file in the zip like the other image fields.
 */
(function (root) {
  "use strict";

  const CELL = 24;       // px per cell on CCFOLIA's board
  const MAX_CELLS = 1000;
  const FITS = ["fill", "cover"];
  const MAX_IMAGE = 5 * 1024 * 1024; // CCFOLIA's upload limit for images
  const MAX_SCENES = 500;            // writes in one Firestore batch (importRoomScenes uses one)
  const MAX_POS = 1000;              // marker position range (cells, either side of the origin)
  const CLICKS = ["none", "link", "message"];

  const uid = p => p + Math.random().toString(36).slice(2, 10);
  const clampInt = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

  const defaultDefaults = () => ({ longSide: 48, displayGrid: false, gridSize: 1, fit: "fill" });
  // bake: a scene with a foreground goes out with "background + foreground" as one foreground image, because
  // CCFOLIA's scene list draws foregroundUrl || backgroundUrl (a lone frame would be all it shows).
  const defaultExportOpts = () => ({ mode: "add", shrink: true, bake: true });
  const defaultState = () => ({ images: [], scenes: [], commonFg: null, commonMarkers: [], defaults: defaultDefaults(), exportOpts: defaultExportOpts(), orderBase: 0 });

  // Field size in cells for an image of w x h px: keep its shape, long side = longSide cells.
  function suggestSize(w, h, longSide) {
    const L = clampInt(longSide, 1, MAX_CELLS, 48);
    if (!(w > 0 && h > 0)) return { width: 40, height: 30 }; // CCFOLIA's own default
    return w >= h ? { width: L, height: Math.max(1, Math.round(L * h / w)) } : { width: Math.max(1, Math.round(L * w / h)), height: L };
  }

  function newScene(state, image, ccfId) {
    const d = state.defaults;
    const size = image ? suggestSize(image.w, image.h, d.longSide) : { width: 40, height: 30 };
    return {
      id: uid("s"), ccfId, name: image ? image.name : "", text: "", bg: image ? image.id : null, fg: "common",
      width: size.width, height: size.height, sizeAuto: true, displayGrid: d.displayGrid, gridSize: d.gridSize, fit: d.fit,
      markers: [], useCommonMarkers: true,
    };
  }

  // A marker in the middle of the field: 4 cells wide, as tall as the image's shape asks.
  function newMarker(image) {
    const width = 4, height = image && image.w && image.h ? Math.max(1, Math.round(4 * image.h / image.w)) : 4;
    return { id: uid("k"), imageId: image ? image.id : null, text: "", x: -Math.floor(width / 2), y: -Math.floor(height / 2),
      width, height, angle: 0, locked: false, freezed: false, click: "none", clickValue: "" };
  }

  // keep(id) -> true when the image id still exists (else the marker has no image).
  function cleanMarker(m, keep) {
    m = m && typeof m === "object" ? m : {};
    return {
      id: String(m.id || uid("k")), imageId: m.imageId && keep(m.imageId) ? String(m.imageId) : null, text: String(m.text || ""),
      x: clampInt(m.x, -MAX_POS, MAX_POS, 0), y: clampInt(m.y, -MAX_POS, MAX_POS, 0),
      width: clampInt(m.width, 1, MAX_CELLS, 2), height: clampInt(m.height, 1, MAX_CELLS, 2), angle: clampInt(m.angle, -360, 360, 0),
      locked: !!m.locked, freezed: !!m.freezed, click: CLICKS.includes(m.click) ? m.click : "none", clickValue: String(m.clickValue || ""),
    };
  }
  const cleanMarkers = (list, keep) => Array.isArray(list) ? list.filter(m => m && typeof m === "object").map(m => cleanMarker(m, keep)) : [];

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== "object") return d;
    const images = Array.isArray(s.images) ? s.images.filter(im => im && im.id).map(im => ({
      id: String(im.id), name: String(im.name || ""), type: String(im.type || ""), size: Number(im.size) || 0, hash: String(im.hash || ""),
      w: Number(im.w) || 0, h: Number(im.h) || 0, moving: !!im.moving,
    })) : [];
    const has = id => images.some(im => im.id === id);
    const dd = Object.assign(defaultDefaults(), s.defaults && typeof s.defaults === "object" ? s.defaults : {});
    const defaults = {
      longSide: clampInt(dd.longSide, 1, MAX_CELLS, 48), displayGrid: !!dd.displayGrid,
      gridSize: clampInt(dd.gridSize, 1, MAX_CELLS, 1), fit: FITS.includes(dd.fit) ? dd.fit : "fill",
    };
    const scenes = Array.isArray(s.scenes) ? s.scenes.filter(x => x && typeof x === "object").map(x => ({
      id: String(x.id || uid("s")), ccfId: String(x.ccfId || ""), name: String(x.name || ""), text: String(x.text || ""),
      bg: has(x.bg) ? String(x.bg) : null,
      fg: x.fg === "none" || has(x.fg) ? String(x.fg) : "common",
      width: clampInt(x.width, 1, MAX_CELLS, 40), height: clampInt(x.height, 1, MAX_CELLS, 30), sizeAuto: !!x.sizeAuto,
      displayGrid: !!x.displayGrid, gridSize: clampInt(x.gridSize, 1, MAX_CELLS, 1), fit: FITS.includes(x.fit) ? x.fit : "fill",
      markers: cleanMarkers(x.markers, has), useCommonMarkers: x.useCommonMarkers !== false,
    })) : [];
    const eo = Object.assign(defaultExportOpts(), s.exportOpts && typeof s.exportOpts === "object" ? s.exportOpts : {});
    return {
      images, scenes, commonFg: has(s.commonFg) ? String(s.commonFg) : null, commonMarkers: cleanMarkers(s.commonMarkers, has), defaults,
      exportOpts: { mode: eo.mode === "overwrite" ? "overwrite" : "add", shrink: !!eo.shrink, bake: eo.bake !== false },
      orderBase: Number(s.orderBase) || 0,
    };
  }

  // The image id a scene shows in front, or null.
  const fgIdOf = (state, scene) => scene.fg === "common" ? state.commonFg : scene.fg === "none" ? null : scene.fg;

  // The markers a scene goes out with: the shared ones first (under the scene's own), then its own.
  const markersOf = (state, scene) => (scene.useCommonMarkers ? state.commonMarkers : []).concat(scene.markers);

  // One marker as CCFOLIA stores it. image: a URL, a file to pack, or null. z: its place in the stack.
  function markerEntity(m, image, z) {
    const clickAction = m.click === "link" ? { type: "link", url: m.clickValue } : m.click === "message" ? { type: "message", text: m.clickValue } : null;
    return { x: m.x, y: m.y, z, width: m.width, height: m.height, locked: m.locked, freezed: m.freezed,
      text: m.text, imageUrl: image || null, angle: m.angle, clickAction };
  }

  // One scene as CCFOLIA stores it. background / foreground: a URL, a file to pack, or null.
  // markers: { key: entity } from markerEntity.
  function toEntity(scene, background, foreground, order, markers) {
    return {
      name: scene.name, text: scene.text, backgroundUrl: background || null, foregroundUrl: foreground || null,
      fieldObjectFit: scene.fit, fieldWidth: scene.width, fieldHeight: scene.height,
      displayGrid: scene.displayGrid, gridSize: scene.gridSize, markers: markers || {},
      mediaName: "", mediaUrl: null, mediaRef: null, mediaType: "", mediaRepeat: true, mediaVolume: 0.5,
      soundName: "", soundUrl: null, soundRef: null, soundRepeat: false, soundVolume: 0.5,
      locked: false, order,
    };
  }

  // ---- templates

  // A scene as a template: images named by hash, so the template outlives the shelf it was made on.
  function sceneToTemplate(state, scene, label) {
    const images = {};
    const ref = id => {
      const im = id && state.images.find(x => x.id === id);
      if (!im || !im.hash) return null;
      images[im.hash] = { name: im.name, type: im.type, size: im.size, w: im.w, h: im.h, moving: im.moving };
      return "h:" + im.hash;
    };
    const fg = scene.fg === "common" ? "common" : scene.fg === "none" ? "none" : ref(scene.fg) || "none";
    return {
      id: uid("t"), label: String(label || scene.name || ""), images,
      scene: {
        name: scene.name, text: scene.text, bg: ref(scene.bg), fg, width: scene.width, height: scene.height, sizeAuto: scene.sizeAuto,
        displayGrid: scene.displayGrid, gridSize: scene.gridSize, fit: scene.fit, useCommonMarkers: scene.useCommonMarkers,
        markers: scene.markers.map(m => Object.assign({}, m, { imageId: ref(m.imageId) })),
      },
    };
  }

  function normalizeTemplates(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(t => t && typeof t === "object" && t.scene && typeof t.scene === "object").map(t => {
      const images = {};
      for (const [hash, im] of Object.entries(t.images && typeof t.images === "object" ? t.images : {})) {
        if (/^[0-9a-f]{64}$/.test(hash) && im) {
          images[hash] = { name: String(im.name || ""), type: String(im.type || ""), size: Number(im.size) || 0, w: Number(im.w) || 0, h: Number(im.h) || 0, moving: !!im.moving };
        }
      }
      const isRef = v => typeof v === "string" && v.startsWith("h:") && !!images[v.slice(2)];
      const x = t.scene;
      return {
        id: String(t.id || uid("t")), label: String(t.label || ""), images,
        scene: {
          name: String(x.name || ""), text: String(x.text || ""), bg: isRef(x.bg) ? x.bg : null,
          fg: x.fg === "none" || isRef(x.fg) ? String(x.fg) : "common",
          width: clampInt(x.width, 1, MAX_CELLS, 40), height: clampInt(x.height, 1, MAX_CELLS, 30), sizeAuto: !!x.sizeAuto,
          displayGrid: !!x.displayGrid, gridSize: clampInt(x.gridSize, 1, MAX_CELLS, 1), fit: FITS.includes(x.fit) ? x.fit : "fill",
          useCommonMarkers: x.useCommonMarkers !== false, markers: cleanMarkers(x.markers, isRef),
        },
      };
    });
  }

  // A new scene from a template. idOf(hash) -> the shelf's image id for that content (put on the shelf first).
  function sceneFromTemplate(tpl, idOf, ccfId) {
    const x = tpl.scene, id = v => (typeof v === "string" && v.startsWith("h:") ? idOf(v.slice(2)) : null);
    return {
      id: uid("s"), ccfId, name: x.name, text: x.text, bg: id(x.bg), fg: x.fg === "common" || x.fg === "none" ? x.fg : id(x.fg) || "none",
      width: x.width, height: x.height, sizeAuto: x.sizeAuto, displayGrid: x.displayGrid, gridSize: x.gridSize, fit: x.fit,
      useCommonMarkers: x.useCommonMarkers, markers: x.markers.map(m => Object.assign({}, m, { id: uid("k"), imageId: id(m.imageId) })),
    };
  }

  root.SceneModel = { CELL, MAX_CELLS, MAX_POS, FITS, CLICKS, MAX_IMAGE, MAX_SCENES, uid, clampInt, defaultState, normalize, suggestSize, newScene,
    newMarker, cleanMarker, markersOf, markerEntity, fgIdOf, toEntity, sceneToTemplate, normalizeTemplates, sceneFromTemplate };
})(typeof window !== "undefined" ? window : globalThis);
