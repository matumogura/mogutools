/*!
 * mogutools 版: shiki365/scene-maker (MIT, Copyright (c) 2026 shiki365) をもとにしています。LICENSE.txt を参照。
 * roomdata.v1.js - entities -> CCFOLIA room data zip (no UI, shared by the zip tools)
 *
 * Format read from CCFOLIA 1.37.4 (main.09686af1.js, 2026-10-02); unchanged in 1.37.6
 * (main.0f872b7d.js, checked 2026-10-30):
 *   __data.json  {"meta":{"version":"1.1.0"},"entities":{...},"resources":{<file>:{"type":<mime>}}}
 *                entities = { room, items, decks, notes, characters, effects, scenes, savedatas, snapshots }
 *                each kind is { <id>: {...} }; room is one object ({} leaves the room as it is).
 *   <file>       an image at the zip root, named <sha-256 hex of its bytes>.<extension of its mime>
 *                (CCFOLIA ignores a file whose name does not match its content). On import it is
 *                uploaded to shared storage, and every backgroundUrl / foregroundUrl / coverImageUrl /
 *                imageUrl / iconUrl / thumbnail holding that file name, at any depth, becomes its URL.
 *   .token       "0." + sha-256 of __data.json. Ours never matches on purpose: CCFOLIA then asks
 *                "外部ツールで作成および編集されたデータです…" before importing, so the user knows
 *                the data came from an outside tool.
 * Import writes each entity by id (set, not merge): a new id adds one, a known id replaces it.
 * Audio cannot travel in the zip (mediaUrl / soundUrl are not in the list above).
 */
(function (root) {
  "use strict";

  // CCFOLIA names files with mime's getExtension, which returns the first extension listed.
  const EXT = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
  const IMAGE_FIELDS = ["backgroundUrl", "foregroundUrl", "coverImageUrl", "imageUrl", "iconUrl", "thumbnail"];
  const KINDS = ["room", "items", "decks", "notes", "characters", "effects", "scenes", "savedatas", "snapshots"];
  const TOKEN = "0.not-signed-made-by-an-outside-tool";

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

  function newId(random) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const r = random(20);
    let s = "";
    for (let i = 0; i < 20; i++) s += abc[r[i] % abc.length];
    return s;
  }

  // An image to pack. Put it where an image field goes; build() swaps it for its file name.
  // key, if given, marks images that are the same so they are hashed once.
  class ImageFile {
    constructor(type, bytes, key) { this.type = type; this.bytes = bytes; this.key = key; }
  }
  const image = (type, bytes, key) => new ImageFile(type, bytes, key);

  /**
   * entities: { scenes: { <id>: {...} }, notes: {...}, ... }  (kinds left out become {})
   *           An image field may hold a URL string, null, or image(type, bytes, key).
   * deps:     { JSZip, subtle }
   * -> { zip (JSZip), data (the object in __data.json), files }  (call zip.generateAsync yourself)
   */
  async function build(entities, deps) {
    const { JSZip, subtle } = deps;
    const zip = new JSZip();
    const resources = {};
    const nameOf = new Map(); // image key -> file name, so an image used many times is stored once

    async function fileName(img) {
      const k = img.key || img.bytes;
      if (nameOf.has(k)) return nameOf.get(k);
      const ext = EXT[img.type];
      if (!ext) throw new Error("unsupported image type: " + img.type);
      const name = hex(await subtle.digest("SHA-256", img.bytes)) + "." + ext;
      if (!resources[name]) { resources[name] = { type: img.type }; zip.file(name, img.bytes); }
      nameOf.set(k, name);
      return name;
    }

    async function pack(value) {
      if (Array.isArray(value)) return Promise.all(value.map(pack));
      if (!value || typeof value !== "object") return value;
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (v instanceof ImageFile) {
          if (!IMAGE_FIELDS.includes(k)) throw new Error("CCFOLIA does not take an image file in: " + k);
          out[k] = await fileName(v);
        } else out[k] = await pack(v);
      }
      return out;
    }

    const all = {};
    for (const k of KINDS) all[k] = await pack(entities[k] || {});
    const data = { meta: { version: "1.1.0" }, entities: all, resources };
    zip.file("__data.json", JSON.stringify(data));
    zip.file(".token", TOKEN);
    return { zip, data, files: Object.keys(resources) };
  }

  root.CcfRoomData = { build, image, newId, hex, EXT, IMAGE_FIELDS, KINDS, TOKEN };
})(typeof window !== "undefined" ? window : globalThis);
