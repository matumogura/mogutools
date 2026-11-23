/*!
 * mogutools 版: shiki365/scene-maker (MIT, Copyright (c) 2026 shiki365) をもとにしています。LICENSE.txt を参照。
 * app.v1.js - シーンメーカー (UI)
 *
 * The work is one plain object, `state` (see model.v1.js). Undo, autosave and project files are
 * all copies of it. Image bytes are not in it: they are Blobs in IndexedDB, keyed by image id.
 *
 *   change something  ->  touch()   redraw, save a little later
 *   finished changing ->  commit()  one step of undo (typing commits on `change`, not on every key)
 *
 * The ids scenes get in CCFOLIA (scene.ccfId) and state.orderBase are not part of undo: they must
 * stay what the last exported zip had, or "overwrite" would miss the scenes already imported.
 *
 * Marker panels: state.commonMarkers (on every scene that wants them) and scene.markers. The board sample
 * edits one of the two lists at a time (markerMode); the other is drawn faded. Dragging changes the marker
 * in place and redraws nothing until the pointer is released (a rebuilt element would lose the pointer).
 * Templates belong to the browser, not to the work: localStorage (TPL_KEY) for what they are, and their
 * image bytes in IndexedDB under "t:<sha-256>". Undo, autosave and project files do not touch them.
 *
 * What CCFOLIA does with the zip is in roomdata.v1.js and model.v1.js (CCFOLIA 1.37.4, 2026-10-02;
 * the same in 1.37.6, checked 2026-10-30).
 *
 * Every text shown goes through t() (i18n.v1.js; the Japanese text is the key). Numbers and names
 * are filled in as {n} / {name}, never glued on, since word order differs between languages.
 * Sentences that are joined end with a space in the English and Korean dictionaries.
 */
(function () {
  "use strict";

  const R = window.CcfRoomData, M = window.SceneModel;
  const $ = sel => document.querySelector(sel);
  // 日本語だけ: {name} を vars の値で埋める（元の i18n.v1.js の t と同じ）。
  const t = (text, vars) => vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
  const listOf = parts => parts.join(t("、"));

  const SAVE_KEY = "ccf-scene-maker.state";
  const APP_ID = "ccf-scene-maker";
  const MAX_IMAGE = M.MAX_IMAGE;
  const MAX_HISTORY = 150;

  let state = M.defaultState();
  let selected = null;     // scene id
  let pendingPick = null;  // called with the ids of the files chosen through #imageFile
  let markerMode = "scene"; // which markers the board sample edits: "scene" | "common"
  let selectedMarker = null; // marker id
  const random = n => crypto.getRandomValues(new Uint8Array(n));

  function status(message, isError) {
    const el = $("#status");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }
  function exportStatus(message, isError) {
    const el = $("#exportStatus");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }

  // ---------------------------------------------------------------- undo and autosave

  let history = [], future = [];
  function syncUndo() {
    $("#undo").disabled = history.length < 2;
    $("#redo").disabled = future.length === 0;
  }
  function commit() {
    const snap = JSON.stringify(state);
    if (history[history.length - 1] === snap) return;
    history.push(snap);
    if (history.length > MAX_HISTORY + 1) history.shift();
    future = [];
    syncUndo();
  }
  function restore(snap) {
    const ccf = new Map(state.scenes.map(s => [s.id, s.ccfId]));
    const orderBase = state.orderBase;
    state = M.normalize(JSON.parse(snap));
    for (const s of state.scenes) if (ccf.has(s.id)) s.ccfId = ccf.get(s.id);
    state.orderBase = orderBase;
    ensureCcfIds();
    keepBlobsStored();
    touch();
  }
  function undo() {
    if (history.length < 2) return;
    future.push(history.pop());
    restore(history[history.length - 1]);
    syncUndo();
    status(t("元に戻しました。"));
  }
  function redo() {
    if (!future.length) return;
    const snap = future.pop();
    history.push(snap);
    restore(snap);
    syncUndo();
    status(t("やり直しました。"));
  }

  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (err) {
      status(t("ブラウザに自動保存できませんでした。「プロジェクトを保存」でファイルに残してください。"), true);
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) state = M.normalize(JSON.parse(raw));
    } catch (err) { /* private mode or broken data: start fresh */ }
  }

  function ensureCcfIds() {
    const seen = new Set();
    for (const s of state.scenes) {
      if (!/^[A-Za-z0-9]{20}$/.test(s.ccfId) || seen.has(s.ccfId)) s.ccfId = R.newId(random);
      seen.add(s.ccfId);
    }
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  const safeName = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || t("画像");

  // ---------------------------------------------------------------- image bytes

  const DB_NAME = "ccf-scene-maker", DB_STORE = "images";
  const blobs = new Map();  // image id -> Blob (kept while the page is open, even after the image is removed, for undo)
  const srcs = new Map();   // image id -> object URL
  const stored = new Set(); // image ids whose Blob is in IndexedDB
  const shrunk = new Map(); // image id -> { blob, type, w, h } (the smaller copy made for export)
  let db = null;            // null when IndexedDB is unavailable: images then live only in memory

  function openDb() {
    return new Promise(resolve => {
      // file:// pages in some browsers never answer; give up rather than hang on "loading".
      const timer = setTimeout(() => resolve(null), 1500);
      const done = v => { clearTimeout(timer); resolve(v); };
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => done(req.result);
        req.onerror = req.onblocked = () => done(null);
      } catch (err) { done(null); }
    });
  }
  function dbRun(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error("no IndexedDB")); return; }
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB"));
    });
  }
  const warnNotStored = () => status(t("画像をブラウザに保存できませんでした。このページを閉じると消えるので、「プロジェクトを保存」でファイルに残してください。"), true);
  function storeBlob(id, blob) {
    if (!db) return Promise.resolve();
    return dbRun("readwrite", s => s.put(blob, id)).then(() => { stored.add(id); }).catch(warnNotStored);
  }
  function unstoreBlob(id) {
    stored.delete(id);
    if (db) dbRun("readwrite", s => s.delete(id)).catch(() => {});
  }
  function holdBlob(id, blob) {
    if (srcs.has(id)) URL.revokeObjectURL(srcs.get(id));
    blobs.set(id, blob);
    srcs.set(id, URL.createObjectURL(blob));
  }
  // After undo / redo / opening a project: IndexedDB should hold exactly the shelf's images.
  function keepBlobsStored() {
    const ids = new Set(state.images.map(im => im.id));
    for (const id of ids) if (!stored.has(id) && blobs.has(id)) storeBlob(id, blobs.get(id));
    for (const id of [...stored]) if (!ids.has(id)) unstoreBlob(id);
  }
  async function loadBlobs() {
    if (!db) return;
    const ids = new Set(state.images.map(im => im.id));
    let keys = [];
    try { keys = await dbRun("readonly", s => s.getAllKeys()); } catch (err) { return; }
    for (const key of keys) {
      if (String(key).startsWith("t:")) continue; // a template's image (see templates below)
      if (!ids.has(key)) { dbRun("readwrite", s => s.delete(key)).catch(() => {}); continue; } // left over from a removed image
      try {
        const blob = await dbRun("readonly", s => s.get(key));
        if (blob) { holdBlob(key, blob); stored.add(key); }
      } catch (err) { /* shown as missing on the shelf */ }
    }
  }

  const u32 = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
  const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  // Animated images lose their motion on a canvas, so they are never shrunk.
  function isMoving(type, b) {
    if (type === "image/gif") return true; // not worth telling a one-frame gif apart
    if (type === "image/png") {            // APNG: an acTL chunk before the first IDAT
      for (let p = 8; p + 8 <= b.length;) {
        const chunk = tag(b, p + 4);
        if (chunk === "acTL") return true;
        if (chunk === "IDAT") return false;
        p += 12 + u32(b, p);
      }
      return false;
    }
    if (type === "image/webp") return b.length > 21 && tag(b, 12) === "VP8X" && (b[20] & 0x02) !== 0;
    return false;
  }

  async function sizeOf(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const out = { w: bmp.width, h: bmp.height };
      bmp.close();
      return out;
    } catch (err) {
      return new Promise(resolve => {
        const img = new Image(), url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
        img.src = url;
      });
    }
  }

  // The file name without its extension becomes the image's name (state: kept as typed, never translated).
  const baseName = n => String(n || "").replace(/\.[^.]+$/, "") || t("画像");
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  function dataUrlBlob(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
    if (!m) throw new Error("bad data url");
    const raw = atob(m[2]), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  // Put files on the shelf. -> their ids, in order (a file already there gives the existing id).
  async function addFiles(files) {
    const ids = [];
    let bad = 0, big = 0, bigMoving = 0, same = 0;
    for (const file of Array.from(files || [])) {
      if (!R.EXT[file.type]) { bad++; continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = R.hex(await crypto.subtle.digest("SHA-256", bytes));
      const had = state.images.find(im => im.hash === hash && blobs.has(im.id));
      if (had) { ids.push(had.id); same++; continue; }
      const { w, h } = await sizeOf(file);
      if (!w || !h) { bad++; continue; }
      const im = { id: M.uid("i"), name: baseName(file.name), type: file.type, size: file.size, hash, w, h, moving: isMoving(file.type, bytes) };
      holdBlob(im.id, file);
      state.images.push(im);
      ids.push(im.id);
      if (file.size > MAX_IMAGE) { if (im.moving) bigMoving++; else big++; }
      await storeBlob(im.id, file);
    }
    const added = ids.length - same;
    const parts = [];
    if (added) parts.push(t("画像を {n} 枚、置き場に入れました。", { n: added }));
    if (added && !db) parts.push(t("ただし、このブラウザでは画像を保存できないので、閉じる前に「プロジェクトを保存」でファイルに残してください。"));
    if (same) parts.push(t("{n} 枚は置き場にある画像と同じなので、それを使います。", { n: same }));
    if (bad) parts.push(t("{n} 個は使えない形式でした（PNG・JPEG・GIF・WebP が使えます）。", { n: bad }));
    if (big) parts.push(t("{n} 枚は 5MB を超えています。書き出すときに縮小できます。", { n: big }));
    if (bigMoving) parts.push(t("動く画像 {n} 枚が 5MB を超えています。縮小できないので、作ったツールで軽くしてください。", { n: bigMoving }));
    if (parts.length) status(parts.join(""), !!(bad || bigMoving || (added && !db)));
    return ids;
  }

  const imageById = id => id ? state.images.find(im => im.id === id) || null : null;
  const sceneById = id => state.scenes.find(s => s.id === id) || null;
  const srcOf = id => srcs.get(id) || "";
  const sizeText = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const tooBig = im => !!(im && im.size > MAX_IMAGE);
  const missing = im => !!(im && !blobs.has(im.id));
  const fgOf = scene => imageById(M.fgIdOf(state, scene));
  const bgOf = scene => imageById(scene.bg);

  const allMarkers = () => state.commonMarkers.concat(...state.scenes.map(s => s.markers));
  function usesOf(id) {
    return {
      bg: state.scenes.filter(s => s.bg === id).length,
      fg: state.scenes.filter(s => s.fg === id).length,
      common: state.commonFg === id,
      markers: allMarkers().filter(m => m.imageId === id).length,
    };
  }
  const isUsed = id => state.scenes.some(s => s.bg === id || M.fgIdOf(state, s) === id || M.markersOf(state, s).some(m => m.imageId === id));

  // ---------------------------------------------------------------- shrinking for export

  const canvasBlob = (canvas, type, q) => new Promise(resolve => canvas.toBlob(resolve, type, q));

  // A copy of a still image under 5 MB, as close to the original as fits. -> { blob, type, w, h }
  async function shrink(im) {
    if (shrunk.has(im.id)) return shrunk.get(im.id);
    const bmp = await createImageBitmap(blobs.get(im.id));
    const limit = MAX_IMAGE * 0.98;
    const lossy = im.type === "image/jpeg" || im.type === "image/webp";
    const canvas = document.createElement("canvas");
    const encode = async (scale, q) => {
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      // A browser that cannot write the type gives PNG instead; its own type is then what counts.
      return canvasBlob(canvas, lossy ? im.type : "image/png", q);
    };
    try {
      const tries = lossy ? [[1, 0.9], [1, 0.8]] : [];
      // PNG size follows the pixel count roughly; start near the target and step down.
      for (let s = Math.min(0.92, Math.sqrt(limit / im.size)); tries.length < 16; s *= 0.86) tries.push([s, 0.85]);
      for (const [scale, q] of tries) {
        const blob = await encode(scale, q);
        if (blob && blob.size <= limit && R.EXT[blob.type]) {
          const out = { blob, type: blob.type, w: canvas.width, h: canvas.height };
          shrunk.set(im.id, out);
          return out;
        }
      }
      throw new Error(t("「{name}」を 5MB 以下に縮小できませんでした。", { name: im.name }));
    } finally { bmp.close(); }
  }

  // The background with the foreground drawn over it, at the field's shape, both fitted the way CCFOLIA fits
  // them (object-fit fill / cover, centered). Used as the foreground so the scene list shows the picture.
  // -> { blob, type, bytes } or null when it cannot be made (an animated image, a missing one).
  async function baked(sc, bg, fg, cache) {
    if (!bg || !fg || bg.moving || fg.moving || !blobs.has(bg.id) || !blobs.has(fg.id)) return null;
    const key = `bake:${bg.id}:${fg.id}:${sc.width}x${sc.height}:${sc.fit}`;
    if (cache.has(key)) return cache.get(key);
    const [b, f] = await Promise.all([createImageBitmap(blobs.get(bg.id)), createImageBitmap(blobs.get(fg.id))]);
    try {
      const aspect = sc.width / sc.height;
      // Enough pixels for the larger of the two images, within 2560 px on the long side.
      let w = Math.max(b.width, f.width, b.height * aspect, f.height * aspect), h = w / aspect;
      const k = Math.min(1, 2560 / Math.max(w, h));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const canvas = document.createElement("canvas");
      const draw = (scale) => {
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const bmp of [b, f]) {
          if (sc.fit === "cover") {
            const s2 = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
            const dw = bmp.width * s2, dh = bmp.height * s2;
            ctx.drawImage(bmp, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
          } else ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        }
        return ctx;
      };
      const ctx = draw(1);
      // Clear anywhere (a background with see-through parts) -> PNG; otherwise JPEG is far smaller.
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let clear = false;
      for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 255) { clear = true; break; }
      const type = clear ? "image/png" : "image/jpeg";
      const limit = MAX_IMAGE * 0.98;
      for (let scale = 1, n = 0; n < 12; n++, scale *= 0.86) {
        if (n) draw(scale);
        const blob = await canvasBlob(canvas, type, 0.9);
        if (blob && blob.size <= limit && R.EXT[blob.type]) {
          const out = { blob, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()), key };
          cache.set(key, out);
          return out;
        }
      }
      return null;
    } finally { b.close(); f.close(); }
  }

  // ---------------------------------------------------------------- small builders

  function button(label, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "small" + (extra && extra.danger ? " danger" : "");
    b.textContent = label;
    if (extra && extra.disabled) b.disabled = true;
    if (extra && extra.aria) b.setAttribute("aria-label", extra.aria);
    return b;
  }
  const hasFiles = ev => !!(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files"));
  // Dropping image files on el puts them on the shelf, then hands the ids to take.
  function dropTarget(el, take) {
    el.addEventListener("dragover", ev => { if (!hasFiles(ev)) return; ev.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", ev => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      el.classList.remove("over");
      addFiles(ev.dataTransfer.files).then(take);
    });
  }
  function pickFile(assign) {
    pendingPick = assign;
    $("#imageFile").click();
  }
  function fillImageSelect(sel, firsts, current) {
    sel.textContent = "";
    for (const [value, label] of firsts) sel.append(new Option(label, value));
    for (const im of state.images) sel.append(new Option(im.name || t("（名前なし）"), im.id));
    sel.value = current;
    if (sel.value !== current) sel.value = firsts[0][0];
  }

  // ---------------------------------------------------------------- scenes

  function addScenes(imageIds) {
    const made = [];
    for (const id of imageIds) {
      const sc = M.newScene(state, imageById(id), R.newId(random));
      state.scenes.push(sc);
      made.push(sc);
    }
    if (made.length) selected = made[0].id;
    return made.length;
  }
  function fitSize(scene) {
    const bg = bgOf(scene) || fgOf(scene);
    if (!bg) return false;
    const size = M.suggestSize(bg.w, bg.h, state.defaults.longSide);
    scene.width = size.width;
    scene.height = size.height;
    scene.sizeAuto = true;
    return true;
  }

  function removeImage(im) {
    const u = usesOf(im.id);
    const uses = [];
    if (u.bg) uses.push(t("背景に使っているシーン {n} 件", { n: u.bg }));
    if (u.fg) uses.push(t("前景に使っているシーン {n} 件", { n: u.fg }));
    if (u.common) uses.push(t("共通の前景"));
    if (u.markers) uses.push(t("マーカーパネル {n} 枚", { n: u.markers }));
    if (uses.length && !confirm(t("「{name}」は次の所で使っています。\n{uses}\n\n削除すると、これらは「画像なし」になります。削除しますか？", { name: im.name, uses: uses.join("\n") }))) return;
    for (const s of state.scenes) {
      if (s.bg === im.id) s.bg = null;
      if (s.fg === im.id) s.fg = "none";
    }
    if (state.commonFg === im.id) state.commonFg = null;
    for (const m of allMarkers()) if (m.imageId === im.id) m.imageId = null;
    state.images = state.images.filter(x => x !== im);
    unstoreBlob(im.id); // the Blob stays in memory, so undo can bring the image back
    touch();
    commit();
    status(uses.length ? t("削除しました。使っていた所は「画像なし」になりました。") : t("削除しました。"));
  }

  // ---------------------------------------------------------------- rendering

  function renderGallery() {
    const box = $("#gallery");
    box.textContent = "";
    $("#imageCount").textContent = state.images.length;
    if (!state.images.length) {
      const p = document.createElement("p");
      p.className = "desc";
      p.textContent = t("まだ画像がありません。");
      box.append(p);
      return;
    }
    for (const im of state.images) {
      const cell = document.createElement("div");
      cell.className = "imgcell";
      const src = srcOf(im.id);
      if (src) { const img = document.createElement("img"); img.src = src; img.alt = ""; img.loading = "lazy"; cell.append(img); }
      else { const d = document.createElement("div"); d.className = "noimg"; d.textContent = t("中身なし"); cell.append(d); }
      const name = document.createElement("input");
      name.type = "text";
      name.value = im.name;
      name.setAttribute("aria-label", t("画像の名前"));
      name.addEventListener("input", () => { im.name = name.value; touch({ keepGallery: true, keepEditorFields: true }); });
      name.addEventListener("change", commit);
      const info = document.createElement("span");
      const warn = missing(im) || tooBig(im);
      info.className = "info" + (warn ? " warn" : "");
      const facts = [`${im.w}×${im.h}`, sizeText(im.size)];
      if (im.moving) facts.push(t("動く"));
      info.textContent = missing(im) ? t("中身が見つかりません。入れ直してください")
        : facts.join(t("・")) + (tooBig(im) ? (im.moving ? t("（5MB 超・縮小不可）") : t("（5MB 超）")) : "");
      const btns = document.createElement("div");
      btns.className = "btns";
      const make = button(t("シーンに"), { aria: t("画像「{name}」を背景にしたシーンを足す", { name: im.name }) });
      make.addEventListener("click", () => { addScenes([im.id]); touch(); commit(); status(t("シーンを 1 件足しました。")); });
      const del = button(t("削除"), { danger: true, aria: t("画像「{name}」を削除", { name: im.name }) });
      del.addEventListener("click", () => removeImage(im));
      btns.append(make, del);
      cell.append(name, info, btns);
      box.append(cell);
    }
  }

  function renderCommon() {
    fillImageSelect($("#commonFg"), [["", t("なし")]], state.commonFg || "");
    $("#defLongSide").value = state.defaults.longSide;
    $("#defGrid").checked = state.defaults.displayGrid;
    $("#defGridSize").value = state.defaults.gridSize;
    $("#defFit").value = state.defaults.fit;
    const none = state.scenes.length === 0;
    for (const id of ["allFgCommon", "allSize", "allGrid", "allFit", "namesFromFiles"]) $("#" + id).disabled = none;
  }

  let dragId = null;
  function renderList() {
    const box = $("#sceneList");
    box.textContent = "";
    $("#count").textContent = state.scenes.length;
    if (!state.scenes.length) {
      const d = document.createElement("div");
      d.className = "empty-list";
      d.textContent = t("まだシーンがありません");
      box.append(d);
    }
    state.scenes.forEach((sc, i) => {
      const row = document.createElement("div");
      row.className = "scene";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(sc.id === selected));
      row.tabIndex = 0;
      row.draggable = true;
      const pic = document.createElement("div");
      pic.className = "pic";
      // CCFOLIA shows foregroundUrl || backgroundUrl; with a shared frame every scene would look
      // the same here, so the background is drawn under it.
      const layers = [fgOf(sc), bgOf(sc)].filter(im => im && srcOf(im.id)).map(im => `url("${srcOf(im.id)}")`);
      if (layers.length) pic.style.backgroundImage = layers.join(", ");
      const txt = document.createElement("div");
      txt.className = "txt";
      const ttl = document.createElement("span");
      ttl.className = "ttl";
      ttl.textContent = sc.name || t("新しいシーン"); // what CCFOLIA shows for a scene without a title
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = "-"; // the BGM name; always none here
      txt.append(ttl, cap);
      const mv = document.createElement("div");
      mv.className = "mv";
      const up = button("↑", { disabled: i === 0, aria: t("{n} 番目を上へ", { n: i + 1 }) });
      const down = button("↓", { disabled: i === state.scenes.length - 1, aria: t("{n} 番目を下へ", { n: i + 1 }) });
      up.className = down.className = "";
      up.addEventListener("click", ev => { ev.stopPropagation(); moveScene(i, i - 1); });
      down.addEventListener("click", ev => { ev.stopPropagation(); moveScene(i, i + 1); });
      mv.append(up, down);
      // Like CCFOLIA's row: edit, duplicate, delete (the layout opens the editor on "scene-edit").
      const act = (label, aria, fn, cls) => { const b = button(label, { aria }); b.className = cls || ""; b.title = aria;
        b.addEventListener("click", ev => { ev.stopPropagation(); selected = sc.id; touch({ keepGallery: true }); fn(); }); return b; };
      mv.append(
        act("✎", t("編集"), () => document.dispatchEvent(new CustomEvent("scene-edit"))),
        act("⧉", t("複製"), () => $("#edDup").click()),
        act("🗑", t("削除"), () => $("#edDelete").click(), "del"));
      row.append(pic, txt, mv);
      const pick = () => { selected = sc.id; touch({ keepGallery: true }); };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", ev => { if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pick(); } });
      row.addEventListener("dragstart", ev => { dragId = sc.id; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", sc.name); });
      row.addEventListener("dragend", () => { dragId = null; });
      row.addEventListener("dragover", ev => { if (!dragId || dragId === sc.id) return; ev.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", ev => {
        if (!dragId) return;
        ev.preventDefault();
        const from = state.scenes.findIndex(s => s.id === dragId);
        dragId = null;
        if (from >= 0) moveScene(from, i);
      });
      box.append(row);
    });
  }

  function moveScene(from, to) {
    if (to < 0 || to >= state.scenes.length || from === to) return;
    const [sc] = state.scenes.splice(from, 1);
    state.scenes.splice(to, 0, sc);
    touch({ keepGallery: true });
    commit();
  }

  // How the board sample is looked at: zoom (1 = the field just fits) and a shift from the middle, in px.
  // Only a way of looking, so it is not part of the work (no undo, not saved).
  const view = { zoom: 1, x: 0, y: 0, grid: false };
  const VIEW_GRID_KEY = "ccf-scene-maker.view-grid";
  try { view.grid = localStorage.getItem(VIEW_GRID_KEY) === "1"; } catch (err) { /* not kept */ }
  const VIEW_ITEMS_KEY = "mogu-scene-maker.view-items";
  view.items = true;
  try { view.items = localStorage.getItem(VIEW_ITEMS_KEY) !== "0"; } catch (err) { /* not kept */ }
  const VIEW_MIN = 0.1, VIEW_MAX = 8;
  const fitScale = (sc, stage) => Math.min(Math.max(40, stage.clientWidth - 24) / (sc.width * M.CELL), Math.max(40, stage.clientHeight - 24) / (sc.height * M.CELL));

  // Images already on the board, by src: reused so animated images keep running across redraws.
  const boardImgs = new Map();
  function boardImg(src) {
    let img = boardImgs.get(src);
    if (!img) { img = document.createElement("img"); img.src = src; img.alt = ""; img.draggable = false; boardImgs.set(src, img); }
    img.removeAttribute("style");
    return img;
  }
  // Images of more than one place on the board (two markers with one image) need their own node.
  const boardUsed = new Set();
  let lastShown = null;
  function boardImgOnce(src) {
    if (boardUsed.has(src)) { const img = document.createElement("img"); img.src = src; img.alt = ""; img.draggable = false; return img; }
    boardUsed.add(src);
    return boardImg(src);
  }

  function renderBoard() {
    const sc = sceneById(selected);
    const board = $("#board");
    board.textContent = "";
    boardUsed.clear();
    const blur = $("#stageBlur");
    const bgSrc = sc && bgOf(sc) ? srcOf(bgOf(sc).id) : "";
    // CCFOLIA spreads the background, blurred, behind the whole board.
    if (blur) blur.style.backgroundImage = bgSrc ? `url("${bgSrc}")` : "";
    if ($("#stageEmpty")) $("#stageEmpty").hidden = !!sc;
    if (!sc) return;
    // A newly chosen scene starts with everything in view (markers may sit outside the field, as in CCFOLIA).
    if (sc.id !== lastShown) { lastShown = sc.id; if (shownMarkers(sc).length || (view.items && state.items.length)) { $("#viewAll").click(); return; } Object.assign(view, { zoom: 1, x: 0, y: 0 }); }
    const stage = $("#stage");
    const scale = fitScale(sc, stage) * view.zoom;
    const w = sc.width * M.CELL * scale, h = sc.height * M.CELL * scale;
    board.style.width = w + "px";
    board.style.height = h + "px";
    board.style.left = (stage.clientWidth - w) / 2 + view.x + "px";
    board.style.top = (stage.clientHeight - h) / 2 + view.y + "px";
    placeAidGrid(M.CELL * scale);
    $("#viewZoom").textContent = Math.round(view.zoom * 100) + "%";
    const bg = bgOf(sc), fg = fgOf(sc);
    // CCFOLIA stacks two imgs of the field's size, both with object-fit = fieldObjectFit.
    for (const im of [bg, fg]) {
      if (!im || !srcOf(im.id)) continue;
      const img = boardImgOnce(srcOf(im.id));
      img.style.objectFit = sc.fit;
      board.append(img);
    }
    if (!bg && !fg) {
      const d = document.createElement("div");
      d.className = "blank";
      d.textContent = t("画像なし");
      board.append(d);
    }
    if (sc.displayGrid) {
      const g = document.createElement("div");
      g.className = "grid";
      const step = M.CELL * sc.gridSize * scale;
      g.style.backgroundImage = "linear-gradient(rgba(255,255,255,.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.25) 1px, transparent 1px)";
      g.style.backgroundSize = `${step}px ${step}px`;
      board.append(g);
    }
    drawMarkers(sc, board, M.CELL * scale);
    if (view.items) drawItems(sc, board, M.CELL * scale);
    const ratio = im => im && im.w && im.h ? Math.abs(im.w / im.h - sc.width / sc.height) / (sc.width / sc.height) : 0;
    const off = [];
    if (ratio(bg) > 0.05) off.push(t("背景"));
    if (ratio(fg) > 0.05) off.push(t("前景"));
    const parts = off.join(t("・"));
    $("#stageNote").textContent = t("盤面 {w} × {h} マス（{pw} × {ph}px）。", { w: sc.width, h: sc.height, pw: sc.width * M.CELL, ph: sc.height * M.CELL })
      + (!off.length ? "" : sc.fit === "cover" ? t("{parts}のはみ出しは切れます。", { parts })
        : t("{parts}は伸びて表示されます。", { parts }));
    document.dispatchEvent(new Event("board-drawn"));
  }

  // ---------------------------------------------------------------- marker panels

  const markerList = sc => (markerMode === "common" ? state.commonMarkers : sc ? sc.markers : []);
  const markerById = (sc, id) => markerList(sc).find(m => m.id === id) || null;
  const markerLabel = (m, i) => m.text || (imageById(m.imageId) || {}).name || t("マーカー {n}", { n: i + 1 });

  // The field's top left is at -floor(w / 2), -floor(h / 2) cells: markers are placed from the middle.
  function placeMarker(el, m, sc, cs) {
    el.style.left = (m.x + Math.floor(sc.width / 2)) * cs + "px";
    el.style.top = (m.y + Math.floor(sc.height / 2)) * cs + "px";
    el.style.width = m.width * cs + "px";
    el.style.height = m.height * cs + "px";
    el.style.transform = m.angle ? `rotate(${m.angle}deg)` : "";
  }

  const shownMarkers = sc => (sc.useCommonMarkers || markerMode === "common" ? state.commonMarkers : []).concat(sc.markers);

  function drawMarkers(sc, board, cs) {
    board.dataset.cs = cs;
    const edited = markerList(sc);
    const shown = shownMarkers(sc);
    shown.forEach((m, z) => {
      const editable = edited.includes(m);
      const el = document.createElement("div");
      el.className = "mk" + (editable ? " edit" : " other") + (m.id === selectedMarker && editable ? " sel" : "") + (m.imageId ? "" : " empty");
      el.dataset.id = m.id;
      el.style.zIndex = 10 + z;
      if (editable) { el.tabIndex = 0; el.setAttribute("aria-label", markerLabel(m, edited.indexOf(m))); }
      if (m.text) el.title = m.text;
      const src = srcOf(m.imageId);
      if (src) el.append(boardImgOnce(src));
      if (editable && m.id === selectedMarker) { const h = document.createElement("div"); h.className = "mk-h"; el.append(h); }
      placeMarker(el, m, sc, cs);
      board.append(el);
    });
  }

  // CCFOLIA's screen panels: over the markers on every scene. Only shown, not edited or exported.
  function drawItems(sc, board, cs) {
    state.items.forEach((it, z) => {
      const el = document.createElement("div");
      el.className = "mk it" + (it.imageId ? "" : " empty");
      el.style.zIndex = 1000 + z;
      if (it.text) el.title = it.text;
      const src = srcOf(it.imageId);
      if (src) el.append(boardImgOnce(src));
      placeMarker(el, it, sc, cs);
      board.append(el);
    });
  }

  function renderMarkers(keepFields) {
    const sc = sceneById(selected);
    if (!sc) return;
    for (const b of document.querySelectorAll("[data-mk-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mkMode === markerMode));
    $("#edUseCommon").checked = sc.useCommonMarkers;
    const list = markerList(sc);
    if (selectedMarker && !list.some(m => m.id === selectedMarker)) selectedMarker = null;
    const box = $("#mkList");
    box.textContent = "";
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "desc";
      p.textContent = markerMode === "common" ? t("全シーン共通のマーカーは、まだありません。") : t("このシーンのマーカーは、まだありません。");
      box.append(p);
    }
    list.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "mk-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(m.id === selectedMarker));
      row.tabIndex = 0;
      const pic = document.createElement("span");
      pic.className = "mk-pic";
      const src = srcOf(m.imageId);
      if (src) pic.style.backgroundImage = `url("${src}")`;
      const label = document.createElement("span");
      label.className = "mk-label";
      label.textContent = markerLabel(m, i);
      const where = document.createElement("span");
      where.className = "mk-where";
      where.textContent = `${m.x}, ${m.y} · ${m.width}×${m.height}`;
      row.append(pic, label, where);
      const pick = () => { selectedMarker = m.id; touch({ keepGallery: true }); };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
      box.append(row);
    });
    const m = markerById(sc, selectedMarker);
    $("#mkDetail").hidden = !m;
    if (!m) return;
    if (!keepFields) {
      $("#mkText").value = m.text;
      $("#mkClickValue").value = m.clickValue;
    }
    for (const [id, v] of [["mkX", m.x], ["mkY", m.y], ["mkW", m.width], ["mkH", m.height], ["mkAngle", m.angle]]) if (document.activeElement !== $("#" + id)) $("#" + id).value = v;
    fillImageSelect($("#mkImage"), [["", t("画像なし")]], m.imageId || "");
    $("#mkLocked").checked = m.locked;
    $("#mkFreezed").checked = m.freezed;
    $("#mkClick").value = m.click === "message" ? "message" : "none";
    $("#mkClickRow").hidden = m.click !== "message";
    const i = list.indexOf(m);
    $("#mkBack").disabled = i <= 0;
    $("#mkFront").disabled = i >= list.length - 1;
  }

  function renderEditor(keepFields) {
    const sc = sceneById(selected);
    $("#editor").hidden = !sc;
    $("#editorEmpty").hidden = !!sc;
    if (!sc) return;
    if (!keepFields) {
      $("#edName").value = sc.name;
      $("#edText").value = sc.text;
      $("#edWidth").value = sc.width;
      $("#edHeight").value = sc.height;
      $("#edGridSize").value = sc.gridSize;
    }
    $("#edFit").value = sc.fit;
    $("#edGrid").checked = sc.displayGrid;
    fillImageSelect($("#edBg"), [["", t("画像なし")]], sc.bg || "");
    const common = imageById(state.commonFg);
    fillImageSelect($("#edFg"), [["common", t("共通の前景（{name}）", { name: common ? common.name : t("なし") })], ["none", t("前景なし")]], sc.fg);
    const warns = [];
    for (const im of new Set([bgOf(sc), fgOf(sc)])) {
      if (!im) continue;
      const vars = { name: im.name, size: sizeText(im.size) };
      if (missing(im)) warns.push(t("「{name}」の中身が見つかりません。置き場で入れ直してください。", vars));
      else if (tooBig(im)) warns.push(im.moving
        ? t("「{name}」は動く画像で {size}。5MB を超えていて縮小できないので、ココフォリアに上がらないことがあります。", vars)
        : t("「{name}」は {size}。", vars) + (state.exportOpts.shrink ? t("書き出すときに 5MB 以下に縮小します。") : t("5MB を超えているので、ココフォリアに上がらないことがあります。")));
    }
    $("#edWarn").hidden = !warns.length;
    $("#edWarn").textContent = warns.join(" ");
    renderBoard();
    renderMarkers(keepFields);
  }

  function renderExport() {
    for (const el of document.querySelectorAll('input[name="exportMode"]')) el.checked = el.value === state.exportOpts.mode;
    $("#optShrink").checked = state.exportOpts.shrink;
    $("#optBake").checked = state.exportOpts.bake;
    $("#optReedit").checked = state.exportOpts.reedit;
    const used = state.images.filter(im => isUsed(im.id));
    const big = used.filter(im => tooBig(im) && !im.moving), bigMoving = used.filter(im => tooBig(im) && im.moving);
    const el = $("#exportSummary");
    el.textContent = "";
    const add = (text, cls) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; el.append(s); };
    const tooMany = state.scenes.length > M.MAX_SCENES;
    if (!state.scenes.length) add(t("書き出すシーンがまだありません。"));
    else if (tooMany) add(t("シーンが {n} 件あります。ココフォリアは 1 回の読み込みで {max} 件までしか書き込めないことがあるので、1 つの ZIP は {max} 件までにしてください（「プロジェクトを保存」で控えを取ってから、シーンを減らして分けて書き出せます）。", { n: state.scenes.length, max: M.MAX_SCENES }), "warn");
    else {
      add(t("シーン {n} 件・画像 {m} 枚を書き出します。", { n: state.scenes.length, m: used.length }));
      if (big.length) add(state.exportOpts.shrink ? t("5MB を超える静止画 {n} 枚は縮小します。", { n: big.length }) : t("5MB を超える静止画が {n} 枚あります（ココフォリアに上がらないことがあります）。", { n: big.length }), state.exportOpts.shrink ? "" : "warn");
      if (bigMoving.length) add(t("5MB を超える動く画像が {n} 枚あります（{names}）。縮小できないので、ココフォリアに上がらないことがあります。", { n: bigMoving.length, names: listOf(bigMoving.map(im => im.name)) }), "warn");
    }
    $("#exportZip").disabled = state.scenes.length === 0 || tooMany;
    $("#exportAssets").disabled = state.images.length === 0;
  }

  // keepGallery: the shelf did not change. keepEditorFields: the user is typing in the editor.
  function touch(o) {
    if (selected && !sceneById(selected)) selected = null;
    if (!selected && state.scenes.length) selected = state.scenes[0].id;
    if (!(o && o.keepGallery)) renderGallery();
    renderCommon();
    renderList();
    renderEditor(!!(o && o.keepEditorFields));
    renderExport();
    scheduleSave();
  }

  // ---------------------------------------------------------------- export

  // The bytes an image goes out with: the original, or the shrunk copy when asked and needed.
  async function prepared(im, cache) {
    if (cache.has(im.id)) return cache.get(im.id);
    const blob = blobs.get(im.id);
    if (!blob) throw new Error(t("画像「{name}」の中身が見つかりません。置き場で入れ直すか、使っているシーンの画像を変えてください。", { name: im.name }));
    let out = { type: im.type, blob, small: false };
    if (state.exportOpts.shrink && tooBig(im) && !im.moving) {
      const s = await shrink(im);
      out = { type: s.type, blob: s.blob, small: true, w: s.w, h: s.h };
    }
    out.bytes = new Uint8Array(await out.blob.arrayBuffer());
    cache.set(im.id, out);
    return out;
  }

  function canExport() {
    if (!window.JSZip) { exportStatus(t("ZIP を作る部品を読み込めませんでした。ネットにつながった状態で開き直してください。"), true); return false; }
    if (!(window.crypto && crypto.subtle)) { exportStatus(t("このブラウザでは ZIP を作れません（https のページか、新しい Chrome・Edge で開いてください）。"), true); return false; }
    return true;
  }

  async function exportZip() {
    if (!state.scenes.length || state.scenes.length > M.MAX_SCENES || !canExport()) return;
    const btn = $("#exportZip");
    btn.disabled = true;
    exportStatus(t("ZIP を作っています…"));
    try {
      const cache = new Map();
      const file = async im => { if (!im) return null; const p = await prepared(im, cache); return R.image(p.type, p.bytes, im.id); };
      const adding = state.exportOpts.mode !== "overwrite";
      if (adding) {
        // New ids, so this zip adds scenes. They are kept: a later "overwrite" zip replaces these.
        for (const sc of state.scenes) sc.ccfId = R.newId(random);
        state.orderBase = Math.floor(Date.now() / 1000); // seconds since 1970: after the scenes already in the room
      } else {
        ensureCcfIds();
        if (!state.orderBase) state.orderBase = Math.floor(Date.now() / 1000);
      }
      const scenes = {};
      const bakeCache = new Map();
      let bakedN = 0, notBaked = 0;
      for (let i = 0; i < state.scenes.length; i++) {
        const sc = state.scenes[i];
        const markers = {};
        const list = M.markersOf(state, sc);
        for (let k = 0; k < list.length; k++) markers[list[k].id] = M.markerEntity(list[k], await file(imageById(list[k].imageId)), k + 1);
        const bg = bgOf(sc), fg = fgOf(sc);
        let fgFile = null;
        if (state.exportOpts.bake && bg && fg) {
          const one = await baked(sc, bg, fg, bakeCache);
          if (one) { fgFile = R.image(one.type, one.bytes, one.key); bakedN++; } else notBaked++;
        }
        scenes[sc.ccfId] = M.toEntity(sc, await file(bg), fgFile || await file(fg), state.orderBase + i, markers);
      }
      const { zip, files } = await R.build({ scenes }, { JSZip: window.JSZip, subtle: crypto.subtle });
      if (state.exportOpts.reedit) await packReedit(zip, cache);
      // Images are already compressed; storing them keeps the export quick.
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      download(blob, `scenes-${stamp()}.zip`);
      saveNow();
      const all = [...cache.values()];
      const small = all.filter(p => p.small).length, over = all.filter(p => p.bytes.length > MAX_IMAGE).length;
      exportStatus(t("書き出しました（シーン {n} 件・画像 {m} 枚・{size}）。", { n: state.scenes.length, m: files.length, size: sizeText(blob.size) })
        
        + (small ? t("{n} 枚は 5MB 以下に縮小しました。", { n: small }) : "")
        + (bakedN ? t("{n} シーンは背景と前景を重ねました。", { n: bakedN }) : "")
        + (notBaked ? t("動く画像の {n} シーンは重ねていません。", { n: notBaked }) : "")
        + (over ? t("5MB 超えの画像が {n} 枚あります。", { n: over }) : ""), over > 0);
    } catch (err) {
      console.error(err);
      exportStatus(t("ZIP を作れませんでした: {error}", { error: err.message }), true);
    } finally {
      btn.disabled = state.scenes.length === 0 || state.scenes.length > M.MAX_SCENES;
    }
  }

  // ---------------------------------------------------------------- room data zip -> back to editing

  const REEDIT_DIR = "scenemaker/", REEDIT_FILE = REEDIT_DIR + "project.json";

  // The work as it was before baking, for openRoomZip. CCFOLIA reads only __data.json and the files listed in
  // its resources, so this folder rides along unread. Images reuse the zip's own files where the bytes match.
  async function packReedit(zip, cache) {
    const images = [];
    const used = state.images.filter(im => blobs.has(im.id) && (isUsed(im.id) || im.id === state.commonFg || state.commonMarkers.concat(state.items).some(m => m.imageId === im.id)));
    for (const im of used) {
      const p = await prepared(im, cache);
      const name = R.hex(await crypto.subtle.digest("SHA-256", p.bytes)) + "." + R.EXT[p.type];
      const path = zip.file(name) ? name : REEDIT_DIR + name;
      if (!zip.file(path)) zip.file(path, p.bytes);
      images.push(Object.assign({}, im, { type: p.type, size: p.bytes.length, w: p.w || im.w, h: p.h || im.h, file: path }));
    }
    const keep = Object.assign({}, state, { images });
    zip.file(REEDIT_FILE, JSON.stringify({ app: APP_ID, kind: "room-zip", version: 1, state: keep }));
  }

  async function readImage(zip, path) {
    const f = zip.file(path);
    if (!f) return null;
    const bytes = await f.async("uint8array");
    const ext = path.split(".").pop().toLowerCase();
    const type = Object.keys(R.EXT).find(k => R.EXT[k] === ext) || (ext === "jpg" ? "image/jpeg" : "");
    if (!type) return null;
    return { blob: new Blob([bytes], { type }), bytes, type };
  }

  // A room data zip (made here, or exported from CCFOLIA) -> the work. Replaces what is open now.
  async function openRoomZip(file) {
    if (!window.JSZip) { status(t("ZIP を読む部品を読み込めませんでした。ネットにつながった状態で開き直してください。"), true); return; }
    let zip;
    try { zip = await window.JSZip.loadAsync(file); } catch (err) { status(t("ZIP を読めませんでした。"), true); return; }
    if (state.scenes.length && !confirm(t("今の作業を、この ZIP の中身に置き換えます。よろしいですか？（「元に戻す」で戻せます）"))) return;
    status(t("ZIP を読み込んでいます…"));
    try {
      const own = zip.file(REEDIT_FILE);
      const next = own ? await fromReedit(zip, JSON.parse(await own.async("string"))) : await fromRoomData(zip);
      if (!next) return;
      state = next.state;
      ensureCcfIds();
      keepBlobsStored();
      selected = null;
      touch();
      commit();
      saveNow();
      status(t("ZIP を読み込みました（シーン {n} 件）。", { n: state.scenes.length })
        + (next.note || "") + t("書き出しは「上書き」になっています。"), !!next.warn);
    } catch (err) {
      console.error(err);
      status(t("ZIP を読み込めませんでした: {error}", { error: err.message }), true);
    }
  }

  async function fromReedit(zip, data) {
    if (!data || data.app !== APP_ID || !data.state) throw new Error(t("再編集用のデータが壊れています"));
    const raw = data.state;
    for (const im of Array.isArray(raw.images) ? raw.images : []) {
      const got = im && im.file ? await readImage(zip, im.file) : null;
      if (!got) continue;
      holdBlob(String(im.id), got.blob);
      stored.delete(String(im.id));
      im.hash = R.hex(await crypto.subtle.digest("SHA-256", got.bytes));
    }
    const next = M.normalize(raw);
    next.exportOpts.mode = "overwrite";
    return { state: next };
  }

  // No project.json: rebuild the scenes from __data.json. Each scene keeps its own foreground (a baked one stays baked).
  async function fromRoomData(zip) {
    const f = zip.file("__data.json");
    if (!f) { status(t("ココフォリアのルームデータ（ZIP）ではありません。"), true); return null; }
    const data = JSON.parse(await f.async("string"));
    const list = Object.entries((data.entities && data.entities.scenes) || {})
      .filter(([, sc]) => sc && typeof sc === "object")
      .sort((a, b) => (Number(a[1].order) || 0) - (Number(b[1].order) || 0));
    const r0 = data.entities && data.entities.room;
    if (!list.length && !(r0 && (r0.backgroundUrl || r0.foregroundUrl || (r0.markers && Object.keys(r0.markers).length)))) {
      status(t("この ZIP にはシーンも盤面も入っていません。"), true); return null;
    }
    const next = M.defaultState();
    const byKey = new Map();
    let lost = 0;
    const take = async (value, name) => {
      if (!value || typeof value !== "string") return null;
      if (byKey.has(value)) return byKey.get(value);
      let got = await readImage(zip, value);
      if (!got && /^https?:\/\//.test(value)) {
        try {
          const res = await fetch(value);
          const blob = res.ok ? await res.blob() : null;
          if (blob && R.EXT[blob.type]) got = { blob, bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
        } catch (err) { /* the host does not let a page read it */ }
      }
      if (!got) { lost++; byKey.set(value, null); return null; }
      const { w, h } = await sizeOf(got.blob);
      const im = { id: M.uid("i"), name, type: got.type, size: got.bytes.length, w, h, moving: isMoving(got.type, got.bytes),
        hash: R.hex(await crypto.subtle.digest("SHA-256", got.bytes)) };
      holdBlob(im.id, got.blob);
      next.images.push(im);
      byKey.set(value, im.id);
      return im.id;
    };
    let markerN = 0;
    // One scene (or the room's current board, which has the same fields) -> a scene of this tool.
    const build = async (sc, ccfId, name) => {
      const bg = await take(sc.backgroundUrl, name + t("（背景）"));
      const fg = await take(sc.foregroundUrl, name + t("（前景）"));
      const markers = [];
      const raw = sc.markers && typeof sc.markers === "object" ? sc.markers : {};
      const ms = (Array.isArray(raw) ? raw.map((m, k) => [String((m && m._id) || k), m]) : Object.entries(raw))
        .sort((a, b) => (Number(a[1] && a[1].z) || 0) - (Number(b[1] && b[1].z) || 0));
      for (const [key, m] of ms) {
        if (!m || typeof m !== "object") continue;
        const ca = m.clickAction || null;
        markers.push({ id: "k" + key, imageId: await take(m.imageUrl, (m.text || name) + t("（マーカー）")), text: m.text, x: m.x, y: m.y,
          width: m.width, height: m.height, angle: m.angle, locked: m.locked, freezed: m.freezed,
          click: ca && ca.type === "message" ? "message" : ca && ca.type === "link" ? "link" : "none",
          clickValue: ca ? (ca.type === "link" ? ca.url : ca.text) : "" });
      }
      markerN += markers.length;
      return { id: M.uid("s"), ccfId, name, text: String(sc.text || ""), bg, fg: fg || "none",
        width: sc.fieldWidth, height: sc.fieldHeight, sizeAuto: false, displayGrid: sc.displayGrid, gridSize: sc.gridSize,
        fit: sc.fieldObjectFit, markers, useCommonMarkers: false };
    };
    // What is on CCFOLIA's board now lives in the room, not in a scene (a scene only has what "盤面を保存" put in it).
    const room = data.entities && data.entities.room;
    const roomMarkers = room && room.markers && typeof room.markers === "object" ? Object.keys(room.markers).length : 0;
    let hasBoard = false;
    if (room && typeof room === "object" && (room.backgroundUrl || room.foregroundUrl || roomMarkers)) {
      next.scenes.push(await build(room, "", t("いまの盤面")));
      hasBoard = true;
    }
    for (const [ccfId, sc] of list) next.scenes.push(await build(sc, ccfId, String(sc.name || "")));
    // Screen panels (entities.items) belong to the room and stay over every scene. Ones put away (active: false) are left out.
    const items = Object.entries((data.entities && data.entities.items) || {})
      .filter(([, it]) => it && typeof it === "object" && it.active !== false)
      .sort((a, b) => (Number(a[1].z) || 0) - (Number(b[1].z) || 0));
    for (const [key, it] of items) {
      const src = it.closed && it.coverImageUrl ? it.coverImageUrl : it.imageUrl;
      next.items.push({ id: "p" + key, imageId: await take(src, (it.memo || t("スクリーンパネル")).slice(0, 30)), text: it.memo || "",
        x: it.x, y: it.y, width: it.width, height: it.height, angle: it.angle, locked: true, freezed: true, click: "none", clickValue: "" });
    }
    const out = M.normalize(next);
    // Keep each scene's place in CCFOLIA's list when writing back over it.
    out.orderBase = (list.length && Number(list[0][1].order)) || Math.floor(Date.now() / 1000);
    out.exportOpts.mode = "overwrite";
    out.exportOpts.bake = false; // the foregrounds may already be baked
    let note = t("再編集用のデータが無い ZIP なので、前景はシーンごとの画像として読み込みました（共通の前景はありません）。");
    note += t("マーカーは {n} 個、スクリーンパネルは {m} 枚読み込みました。", { n: markerN, m: next.items.length });
    if (hasBoard) note += t("一覧の先頭の「いまの盤面」は、ココフォリアで今の盤面に置いてあるものです（上書きしても、ルームの盤面は変わりません。新しいシーンとして入ります）。");
    if (lost) note += t("読み込めなかった画像が {n} 個あります（ZIP に入っていない画像は、ココフォリアの設定で取ってこられないことがあります）。", { n: lost });
    return { state: out, note, warn: lost > 0 };
  }

  // The images as plain files with readable names, to drop into CCFOLIA's own image picker.
  async function exportAssets() {
    if (!state.images.length || !canExport()) return;
    const btn = $("#exportAssets");
    btn.disabled = true;
    exportStatus(t("素材の ZIP を作っています…"));
    try {
      const cache = new Map();
      const zip = new window.JSZip();
      const taken = new Set();
      let count = 0;
      const put = async (dir, im) => {
        const p = await prepared(im, cache);
        const ext = R.EXT[p.type] === "jpeg" ? "jpg" : R.EXT[p.type];
        let name = `${dir}/${safeName(im.name)}.${ext}`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${dir}/${safeName(im.name)} (${n}).${ext}`;
        taken.add(name.toLowerCase());
        zip.file(name, p.bytes);
        count++;
      };
      let skipped = 0;
      for (const im of state.images) {
        if (missing(im)) { skipped++; continue; }
        const asBg = state.scenes.some(s => s.bg === im.id), asFg = state.scenes.some(s => M.fgIdOf(state, s) === im.id);
        const asMarker = state.scenes.some(s => M.markersOf(state, s).some(m => m.imageId === im.id));
        if (asMarker) await put(t("マーカー"), im);
        // Folder names in the language of the page, like the rest of what the user reads.
        if (asBg) await put(t("背景"), im);
        if (asFg) await put(t("前景"), im);
        if (!asBg && !asFg && !asMarker) await put(t("そのほか"), im);
      }
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      download(blob, `scenes-assets-${stamp()}.zip`);
      const small = [...cache.values()].filter(p => p.small).length;
      exportStatus(t("素材を書き出しました（{n} 枚・{size}）。展開して、ココフォリアの画像選択の画面にドロップすると、自分の素材に入ります。", { n: count, size: sizeText(blob.size) })
        + (small ? t("{n} 枚は縮小後の画像です。", { n: small }) : "") + (skipped ? t("中身の見つからない画像 {n} 枚は入っていません。", { n: skipped }) : ""), skipped > 0);
    } catch (err) {
      console.error(err);
      exportStatus(t("素材の ZIP を作れませんでした: {error}", { error: err.message }), true);
    } finally {
      btn.disabled = state.images.length === 0;
    }
  }

  // ---------------------------------------------------------------- project files

  async function projectData() {
    const assets = {};
    for (const im of state.images) {
      const blob = blobs.get(im.id);
      if (blob) assets[im.id] = await blobToDataUrl(blob);
    }
    return { app: APP_ID, version: 1, state, assets };
  }

  async function openProject(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { status(t("プロジェクトファイルを読めませんでした。"), true); return; }
    if (!data || data.app !== APP_ID) { status(t("このツールのプロジェクトファイルではありません。"), true); return; }
    const next = M.normalize(data.state);
    for (const im of next.images) {
      const url = data.assets && data.assets[im.id];
      if (!url) continue;
      try { holdBlob(im.id, dataUrlBlob(url)); stored.delete(im.id); } catch (err) { /* shown as missing */ }
    }
    state = next;
    ensureCcfIds();
    keepBlobsStored();
    selected = null;
    touch();
    commit();
    saveNow();
    status(t("プロジェクトを開きました（シーン {n} 件・画像 {m} 枚）。", { n: state.scenes.length, m: state.images.length }));
  }

  // ---------------------------------------------------------------- wiring

  const numberOf = (el, d) => M.clampInt(el.value, 1, M.MAX_CELLS, d);

  function wireShelf() {
    const zone = (dropSel, inputSel, take) => {
      const drop = $(dropSel), input = $(inputSel);
      drop.addEventListener("click", () => input.click());
      drop.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); input.click(); } });
      dropTarget(drop, take);
      input.addEventListener("change", () => { const files = Array.from(input.files); input.value = ""; addFiles(files).then(take); });
    };
    zone("#dropScenes", "#sceneFiles", ids => {
      if (!ids.length) return;
      const n = addScenes(ids);
      touch();
      commit();
      if (!$("#status").classList.contains("error")) status($("#status").textContent + t("シーンを {n} 件作りました。", { n }));
    });
    zone("#dropShelf", "#shelfFiles", ids => {
      if (!ids.length) return;
      // The first frame dropped becomes the shared foreground if there is none yet.
      if (!state.commonFg) { state.commonFg = ids[0]; status($("#status").textContent + t("共通の前景にしました。"), $("#status").classList.contains("error")); }
      touch();
      commit();
    });
    $("#imageFile").addEventListener("change", ev => {
      const files = Array.from(ev.target.files), take = pendingPick;
      ev.target.value = "";
      pendingPick = null;
      addFiles(files).then(ids => { if (take && ids.length) take(ids); touch(); commit(); });
    });
    // A file dropped outside a drop area would make the browser leave the page to show it.
    window.addEventListener("dragover", ev => { if (hasFiles(ev)) ev.preventDefault(); });
    window.addEventListener("drop", ev => { if (hasFiles(ev) && !ev.defaultPrevented) { ev.preventDefault(); status(t("画像は「1. 画像を入れる」の枠にドロップしてください。"), true); } });
  }

  function wireCommon() {
    const each = fn => { state.scenes.forEach(fn); touch({ keepGallery: true }); commit(); };
    $("#commonFg").addEventListener("change", ev => { state.commonFg = ev.target.value || null; touch({ keepGallery: true }); commit(); });
    $("#commonFgAdd").addEventListener("click", () => pickFile(ids => { state.commonFg = ids[0]; }));
    $("#allFgCommon").addEventListener("click", () => { each(s => { s.fg = "common"; }); status(t("全シーンの前景を「共通の前景」にしました。")); });
    $("#defLongSide").addEventListener("change", ev => { state.defaults.longSide = numberOf(ev.target, 48); touch({ keepGallery: true }); commit(); });
    $("#allSize").addEventListener("click", () => {
      let n = 0;
      each(s => { if (fitSize(s)) n++; });
      status(t("{n} 件のシーンを、背景の形に合わせました（長い辺 {side} マス）。", { n, side: state.defaults.longSide }));
    });
    $("#defGrid").addEventListener("change", ev => { state.defaults.displayGrid = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#defGridSize").addEventListener("change", ev => { state.defaults.gridSize = numberOf(ev.target, 1); touch({ keepGallery: true }); commit(); });
    $("#allGrid").addEventListener("click", () => {
      each(s => { s.displayGrid = state.defaults.displayGrid; s.gridSize = state.defaults.gridSize; });
      status(state.defaults.displayGrid ? t("全シーンのグリッドを表示にしました（間隔 {n} マス）。", { n: state.defaults.gridSize }) : t("全シーンのグリッドを消しました。"));
    });
    $("#defFit").addEventListener("change", ev => { state.defaults.fit = ev.target.value; touch({ keepGallery: true }); commit(); });
    $("#allFit").addEventListener("click", () => { each(s => { s.fit = state.defaults.fit; }); status(t("全シーンの画像のはめ方をそろえました。")); });
    $("#namesFromFiles").addEventListener("click", () => {
      each(s => { const bg = bgOf(s); if (bg) s.name = bg.name; });
      status(t("シーンタイトルを、背景の画像の名前にそろえました。"));
    });
    $("#addEmpty").addEventListener("click", () => {
      const sc = M.newScene(state, null, R.newId(random));
      state.scenes.push(sc);
      selected = sc.id;
      touch({ keepGallery: true });
      commit();
    });
  }

  function wireEditor() {
    const cur = () => sceneById(selected);
    const typing = (sel, set) => {
      $(sel).addEventListener("input", ev => { const s = cur(); if (!s) return; set(s, ev.target.value); touch({ keepGallery: true, keepEditorFields: true }); });
      $(sel).addEventListener("change", commit);
    };
    const chosen = (sel, set) => $(sel).addEventListener("change", ev => { const s = cur(); if (!s) return; set(s, ev.target); touch({ keepGallery: true }); commit(); });
    typing("#edName", (s, v) => { s.name = v; });
    typing("#edText", (s, v) => { s.text = v; });
    // Numbers only on change: "108" should not pass through "1" on the way.
    chosen("#edWidth", (s, el) => { s.width = numberOf(el, s.width); s.sizeAuto = false; });
    chosen("#edHeight", (s, el) => { s.height = numberOf(el, s.height); s.sizeAuto = false; });
    chosen("#edGridSize", (s, el) => { s.gridSize = numberOf(el, s.gridSize); });
    chosen("#edGrid", (s, el) => { s.displayGrid = el.checked; });
    chosen("#edFit", (s, el) => { s.fit = el.value; });
    const setBg = (s, id) => { s.bg = id; if (s.sizeAuto) fitSize(s); };
    chosen("#edBg", (s, el) => setBg(s, el.value || null));
    chosen("#edFg", (s, el) => { s.fg = el.value; });
    $("#edBgAdd").addEventListener("click", () => { const s = cur(); if (s) pickFile(ids => setBg(s, ids[0])); });
    $("#edFgAdd").addEventListener("click", () => { const s = cur(); if (s) pickFile(ids => { s.fg = ids[0]; }); });
    $("#edSizeAuto").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      if (!fitSize(s)) { status(t("背景の画像がないので、合わせられません。"), true); return; }
      touch({ keepGallery: true });
      commit();
    });
    $("#edDup").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      const copy = Object.assign({}, s, { id: M.uid("s"), ccfId: R.newId(random), name: s.name ? t("{name} のコピー", { name: s.name }) : "",
        markers: s.markers.map(m => Object.assign({}, m, { id: M.uid("k") })) });
      state.scenes.splice(state.scenes.indexOf(s) + 1, 0, copy);
      selected = copy.id;
      touch({ keepGallery: true });
      commit();
    });
    $("#edDelete").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      const i = state.scenes.indexOf(s);
      state.scenes.splice(i, 1);
      selected = (state.scenes[i] || state.scenes[i - 1] || {}).id || null;
      touch({ keepGallery: true });
      commit();
      status(t("シーンを削除しました（置き場の画像は残ります）。「元に戻す」で戻せます。"));
    });
    dropTarget($("#stage"), ids => {
      if (!ids.length) return;
      const s = cur();
      if (s) setBg(s, ids[0]); else addScenes(ids);
      touch(); commit();
    });
  }

  function wireMarkers() {
    const cur = () => sceneById(selected);
    const curMarker = () => markerById(cur(), selectedMarker);
    const edit = (fn, typing) => { const m = curMarker(); if (!m) return; fn(m); touch({ keepGallery: true, keepEditorFields: !!typing }); if (!typing) commit(); };
    for (const b of document.querySelectorAll("[data-mk-mode]")) {
      b.addEventListener("click", () => { markerMode = b.dataset.mkMode; selectedMarker = null; touch({ keepGallery: true }); });
    }
    $("#edUseCommon").addEventListener("change", ev => { const s = cur(); if (!s) return; s.useCommonMarkers = ev.target.checked; touch({ keepGallery: true }); commit(); });
    const add = imageId => {
      const s = cur();
      if (!s) return;
      const m = M.newMarker(imageById(imageId));
      markerList(s).push(m);
      selectedMarker = m.id;
      touch({ keepGallery: true });
      commit();
    };
    $("#mkAdd").addEventListener("click", () => add(null));
    $("#mkAddFile").addEventListener("click", () => pickFile(ids => add(ids[0])));
    $("#mkText").addEventListener("input", ev => edit(m => { m.text = ev.target.value; }, true));
    $("#mkText").addEventListener("change", commit);
    $("#mkClickValue").addEventListener("input", ev => edit(m => { m.clickValue = ev.target.value; }, true));
    $("#mkClickValue").addEventListener("change", commit);
    const num = (id, key, min, max) => $("#" + id).addEventListener("change", ev => edit(m => { m[key] = M.clampInt(ev.target.value, min, max, m[key]); }));
    num("mkX", "x", -M.MAX_POS, M.MAX_POS);
    num("mkY", "y", -M.MAX_POS, M.MAX_POS);
    num("mkW", "width", 1, M.MAX_CELLS);
    num("mkH", "height", 1, M.MAX_CELLS);
    num("mkAngle", "angle", -360, 360);
    $("#mkImage").addEventListener("change", ev => edit(m => { m.imageId = ev.target.value || null; }));
    $("#mkLocked").addEventListener("change", ev => edit(m => { m.locked = ev.target.checked; }));
    $("#mkFreezed").addEventListener("change", ev => edit(m => { m.freezed = ev.target.checked; }));
    $("#mkClick").addEventListener("change", ev => edit(m => { m.click = ev.target.value; }));
    const shift = d => { const s = cur(), list = markerList(s), i = list.findIndex(m => m.id === selectedMarker), j = i + d;
      if (i < 0 || j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; touch({ keepGallery: true }); commit(); };
    $("#mkBack").addEventListener("click", () => shift(-1));
    $("#mkFront").addEventListener("click", () => shift(1));
    $("#mkDup").addEventListener("click", () => {
      const s = cur(), m = curMarker();
      if (!m) return;
      const copy = Object.assign({}, m, { id: M.uid("k"), x: m.x + 1, y: m.y + 1 });
      markerList(s).push(copy);
      selectedMarker = copy.id;
      touch({ keepGallery: true });
      commit();
    });
    $("#mkDelete").addEventListener("click", () => {
      const s = cur(), list = markerList(s), i = list.findIndex(m => m.id === selectedMarker);
      if (i < 0) return;
      list.splice(i, 1);
      selectedMarker = null;
      touch({ keepGallery: true });
      commit();
      status(t("マーカーを削除しました。「元に戻す」で戻せます。"));
    });

    // Dragging on the board sample: the marker moves (or, by its corner, grows) a cell at a time.
    const board = $("#board");
    let drag = null;
    board.addEventListener("pointerdown", ev => {
      const el = ev.target.closest(".mk.edit");
      if (!el || ev.button !== 0) return;
      const s = cur(), m = markerById(s, el.dataset.id);
      if (!m) return;
      ev.preventDefault();
      const resize = ev.target.classList.contains("mk-h");
      if (selectedMarker !== m.id) { selectedMarker = m.id; touch({ keepGallery: true }); }
      const target = board.querySelector(`.mk[data-id="${m.id}"]`);
      target.setPointerCapture(ev.pointerId);
      target.focus({ preventScroll: true });
      drag = { m, s, el: target, resize, x0: ev.clientX, y0: ev.clientY, start: { x: m.x, y: m.y, w: m.width, h: m.height }, cs: Number(board.dataset.cs), moved: false };
    });
    board.addEventListener("pointermove", ev => {
      if (!drag) return;
      const dx = Math.round((ev.clientX - drag.x0) / drag.cs), dy = Math.round((ev.clientY - drag.y0) / drag.cs);
      const { m, start } = drag;
      if (drag.resize) { m.width = Math.max(1, start.w + dx); m.height = Math.max(1, start.h + dy); }
      else { m.x = M.clampInt(start.x + dx, -M.MAX_POS, M.MAX_POS, m.x); m.y = M.clampInt(start.y + dy, -M.MAX_POS, M.MAX_POS, m.y); }
      drag.moved = drag.moved || dx !== 0 || dy !== 0;
      placeMarker(drag.el, m, drag.s, drag.cs);
    });
    const end = () => { if (!drag) return; const moved = drag.moved; drag = null; if (moved) { touch({ keepGallery: true }); commit(); } };
    board.addEventListener("pointerup", end);
    board.addEventListener("pointercancel", end);
    board.addEventListener("keydown", ev => {
      const el = ev.target.closest(".mk.edit");
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (!el || !step) return;
      ev.preventDefault();
      selectedMarker = el.dataset.id;
      edit(m => { m.x = M.clampInt(m.x + step[0], -M.MAX_POS, M.MAX_POS, m.x); m.y = M.clampInt(m.y + step[1], -M.MAX_POS, M.MAX_POS, m.y); });
      const again = board.querySelector(`.mk[data-id="${selectedMarker}"]`);
      if (again) again.focus({ preventScroll: true });
    });
  }

  // Lines every cell over the whole sample, the field's outside too (to place markers there). Only for looking.
  function placeAidGrid(cs) {
    const g = $("#aidGrid"), board = $("#board");
    $("#viewGrid").setAttribute("aria-pressed", String(view.grid));
    g.hidden = !view.grid || !sceneById(selected);
    if (g.hidden) return;
    cs = cs || Number(board.dataset.cs);
    // Lines fall on the field's cells: its left / top edge is a line.
    const x = parseFloat(board.style.left) || 0, y = parseFloat(board.style.top) || 0;
    g.style.backgroundSize = `${cs}px ${cs}px`;
    g.style.backgroundPosition = `${x}px ${y}px`;
    g.classList.toggle("fine", cs < 6);
  }

  // Zooming and moving the board sample.
  function wireView() {
    const stage = $("#stage");
    // Zoom by f, keeping the point (px, py) of the stage where it is.
    const zoomAt = (f, px, py) => {
      const z = Math.min(VIEW_MAX, Math.max(VIEW_MIN, view.zoom * f));
      f = z / view.zoom;
      const cx = stage.clientWidth / 2 + view.x, cy = stage.clientHeight / 2 + view.y;
      view.x = px - (px - cx) * f - stage.clientWidth / 2;
      view.y = py - (py - cy) * f - stage.clientHeight / 2;
      view.zoom = z;
      renderBoard();
    };
    const middle = f => zoomAt(f, stage.clientWidth / 2, stage.clientHeight / 2);
    $("#viewIn").addEventListener("click", () => middle(1.25));
    $("#viewOut").addEventListener("click", () => middle(1 / 1.25));
    $("#viewGrid").addEventListener("click", () => {
      view.grid = !view.grid;
      try { localStorage.setItem(VIEW_GRID_KEY, view.grid ? "1" : "0"); } catch (err) { /* not kept */ }
      placeAidGrid();
    });
    const itemsBtn = $("#viewItems");
    const syncItems = () => { itemsBtn.setAttribute("aria-pressed", String(view.items)); itemsBtn.hidden = !state.items.length; };
    syncItems();
    itemsBtn.addEventListener("click", () => {
      view.items = !view.items;
      try { localStorage.setItem(VIEW_ITEMS_KEY, view.items ? "1" : "0"); } catch (err) { /* not kept */ }
      syncItems();
      renderBoard();
    });
    document.addEventListener("board-drawn", syncItems);
    $("#viewFit").addEventListener("click", () => { Object.assign(view, { zoom: 1, x: 0, y: 0 }); renderBoard(); });
    // The field and every marker shown on it, with a cell to spare.
    $("#viewAll").addEventListener("click", () => {
      const sc = sceneById(selected);
      if (!sc) return;
      const ox = Math.floor(sc.width / 2), oy = Math.floor(sc.height / 2);
      let x0 = 0, y0 = 0, x1 = sc.width, y1 = sc.height;
      for (const m of shownMarkers(sc).concat(view.items ? state.items : [])) {
        x0 = Math.min(x0, m.x + ox); y0 = Math.min(y0, m.y + oy);
        x1 = Math.max(x1, m.x + ox + m.width); y1 = Math.max(y1, m.y + oy + m.height);
      }
      x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
      const s = Math.min(Math.max(40, stage.clientWidth - 24) / ((x1 - x0) * M.CELL), Math.max(40, stage.clientHeight - 24) / ((y1 - y0) * M.CELL));
      view.zoom = Math.min(VIEW_MAX, Math.max(VIEW_MIN, s / fitScale(sc, stage)));
      const scale = fitScale(sc, stage) * view.zoom;
      view.x = -((x0 + x1) / 2 - sc.width / 2) * M.CELL * scale;
      view.y = -((y0 + y1) / 2 - sc.height / 2) * M.CELL * scale;
      renderBoard();
    });
    stage.addEventListener("wheel", ev => {
      if (!ev.ctrlKey || !sceneById(selected)) return;
      ev.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    // Dragging where there is no marker moves the view.
    let pan = null;
    stage.addEventListener("pointerdown", ev => {
      if ((ev.button !== 0 && ev.button !== 1) || ev.target.closest(".mk.edit, .view-ctl")) return;
      ev.preventDefault();
      stage.setPointerCapture(ev.pointerId);
      stage.classList.add("panning");
      pan = { x0: ev.clientX, y0: ev.clientY, vx: view.x, vy: view.y, left: parseFloat($("#board").style.left) || 0, top: parseFloat($("#board").style.top) || 0 };
    });
    stage.addEventListener("pointermove", ev => {
      if (!pan) return;
      const dx = ev.clientX - pan.x0, dy = ev.clientY - pan.y0;
      view.x = pan.vx + dx; view.y = pan.vy + dy;
      $("#board").style.left = pan.left + dx + "px";
      $("#board").style.top = pan.top + dy + "px";
      placeAidGrid();
    });
    const stop = () => { pan = null; stage.classList.remove("panning"); };
    stage.addEventListener("pointerup", stop);
    stage.addEventListener("pointercancel", stop);
  }

  // ---------------------------------------------------------------- templates

  const TPL_KEY = "ccf-scene-maker.templates", TPL_SEEDED = "ccf-scene-maker.templates-seeded", TPL_APP = "ccf-scene-maker-templates";
  let templates = [];
  const tplBlobs = new Map(); // sha-256 -> Blob, while the page is open

  function loadTemplates() {
    try { templates = M.normalizeTemplates(JSON.parse(localStorage.getItem(TPL_KEY) || "[]")); } catch (err) { templates = []; }
  }
  function saveTemplates() {
    try { localStorage.setItem(TPL_KEY, JSON.stringify(templates)); }
    catch (err) { status(t("テンプレートをブラウザに保存できませんでした。「テンプレートを書き出す」でファイルに残してください。"), true); }
  }
  async function keepTplBlob(hash, blob) {
    tplBlobs.set(hash, blob);
    if (db) await dbRun("readwrite", st => st.put(blob, "t:" + hash)).catch(() => {});
  }
  async function tplBlob(hash) {
    if (tplBlobs.has(hash)) return tplBlobs.get(hash);
    const onShelf = state.images.find(im => im.hash === hash && blobs.has(im.id));
    if (onShelf) return blobs.get(onShelf.id);
    if (!db) return null;
    try { const b = await dbRun("readonly", st => st.get("t:" + hash)); if (b) tplBlobs.set(hash, b); return b || null; } catch (err) { return null; }
  }
  // Images no template needs any more leave IndexedDB.
  function dropUnusedTplBlobs() {
    const used = new Set(templates.flatMap(tp => Object.keys(tp.images)));
    for (const hash of [...tplBlobs.keys()]) if (!used.has(hash)) tplBlobs.delete(hash);
    if (!db) return;
    dbRun("readonly", st => st.getAllKeys()).then(keys => {
      for (const k of keys) if (String(k).startsWith("t:") && !used.has(String(k).slice(2))) dbRun("readwrite", st => st.delete(k)).catch(() => {});
    }).catch(() => {});
  }

  const solidBlob = color => new Promise(res => {
    const c = document.createElement("canvas");
    c.width = 1920; c.height = 1080;
    const x = c.getContext("2d");
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    c.toBlob(res, "image/png");
  });

  // Two templates to start with, made once per browser: a divider ("|ーー") and a black-out.
  async function seedTemplates() {
    try { if (localStorage.getItem(TPL_SEEDED)) return; localStorage.setItem(TPL_SEEDED, "1"); } catch (err) { return; }
    if (templates.length) return;
    const blob = await solidBlob("#000000");
    const hash = R.hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    await keepTplBlob(hash, blob);
    const base = { text: "", fg: "none", width: 48, height: 27, sizeAuto: true, displayGrid: false, gridSize: 1, fit: "fill", useCommonMarkers: false, markers: [] };
    templates = M.normalizeTemplates([
      { label: t("区切り（|ーー）"), images: {}, scene: Object.assign({}, base, { name: "|ーー", bg: null, sizeAuto: false }) },
      { label: t("暗転（黒）"), images: { [hash]: { name: t("黒"), type: "image/png", size: blob.size, w: 1920, h: 1080, moving: false } },
        scene: Object.assign({}, base, { name: t("暗転"), bg: "h:" + hash }) },
    ]);
    saveTemplates();
  }

  function renderTemplates() {
    const box = $("#tplList");
    box.textContent = "";
    if (!templates.length) {
      const p = document.createElement("p");
      p.className = "desc";
      p.textContent = t("まだテンプレートがありません。");
      box.append(p);
    }
    for (const tp of templates) {
      const row = document.createElement("div");
      row.className = "tpl-row";
      const name = document.createElement("input");
      name.type = "text";
      name.value = tp.label;
      name.setAttribute("aria-label", t("テンプレートの名前"));
      name.addEventListener("change", () => { tp.label = name.value; saveTemplates(); });
      const use = button(t("足す"), { aria: t("テンプレート「{name}」のシーンを足す", { name: tp.label }) });
      use.addEventListener("click", () => insertTemplate(tp));
      const del = button(t("削除"), { danger: true, aria: t("テンプレート「{name}」を削除", { name: tp.label }) });
      del.addEventListener("click", () => {
        if (!confirm(t("テンプレート「{name}」を削除しますか？（作ったシーンはそのまま残ります）", { name: tp.label }))) return;
        templates = templates.filter(x => x !== tp);
        saveTemplates();
        dropUnusedTplBlobs();
        renderTemplates();
        status(t("テンプレートを削除しました。"));
      });
      row.append(name, use, del);
      box.append(row);
    }
  }

  async function saveAsTemplate() {
    const sc = sceneById(selected);
    if (!sc) { status(t("テンプレートにするシーンを、一覧で選んでください。"), true); return; }
    const label = prompt(t("テンプレートの名前"), sc.name || t("新しいテンプレート"));
    if (label == null) return;
    const tp = M.sceneToTemplate(state, sc, label.trim() || sc.name);
    for (const hash of Object.keys(tp.images)) {
      const im = state.images.find(x => x.hash === hash && blobs.has(x.id));
      if (im) await keepTplBlob(hash, blobs.get(im.id));
    }
    templates.push(tp);
    saveTemplates();
    renderTemplates();
    status(t("テンプレート「{name}」を登録しました。", { name: tp.label }) + (db ? "" : t("このブラウザでは画像を保存できないので、閉じる前に「テンプレートを書き出す」でファイルに残してください。")));
  }

  // The template's images go on the shelf (one already there with the same content is used), then the scene
  // is put right after the selected one.
  async function insertTemplate(tp) {
    const idOf = {};
    let lost = 0;
    for (const [hash, meta] of Object.entries(tp.images)) {
      const had = state.images.find(im => im.hash === hash && blobs.has(im.id));
      if (had) { idOf[hash] = had.id; continue; }
      const blob = await tplBlob(hash);
      if (!blob) { lost++; continue; }
      const im = { id: M.uid("i"), name: meta.name || t("画像"), type: meta.type || blob.type, size: blob.size, hash, w: meta.w, h: meta.h, moving: meta.moving };
      holdBlob(im.id, blob);
      state.images.push(im);
      await storeBlob(im.id, blob);
      idOf[hash] = im.id;
    }
    const sc = M.sceneFromTemplate(tp, hash => idOf[hash] || null, R.newId(random));
    const at = state.scenes.findIndex(x => x.id === selected);
    state.scenes.splice(at < 0 ? state.scenes.length : at + 1, 0, sc);
    selected = sc.id;
    selectedMarker = null;
    touch();
    commit();
    status(t("テンプレート「{name}」のシーンを足しました。", { name: tp.label }) + (lost ? t("画像 {n} 枚が見つかりませんでした。", { n: lost }) : ""), lost > 0);
    const name = $("#edName");
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
  }

  async function exportTemplates() {
    if (!templates.length) { status(t("書き出すテンプレートがありません。"), true); return; }
    const assets = {};
    for (const hash of new Set(templates.flatMap(tp => Object.keys(tp.images)))) {
      const blob = await tplBlob(hash);
      if (blob) assets[hash] = await blobToDataUrl(blob);
    }
    download(new Blob([JSON.stringify({ app: TPL_APP, version: 1, templates, assets })], { type: "application/json" }), `scene-templates-${stamp()}.json`);
    status(t("テンプレートを {n} 件書き出しました（画像も入っています）。", { n: templates.length }));
  }

  async function importTemplates(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { status(t("テンプレートのファイルを読めませんでした。"), true); return; }
    if (!data || data.app !== TPL_APP) { status(t("このツールのテンプレートのファイルではありません。"), true); return; }
    for (const [hash, url] of Object.entries(data.assets || {})) {
      try {
        const blob = dataUrlBlob(url);
        const real = R.hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
        if (real === hash) await keepTplBlob(hash, blob);
      } catch (err) { /* left out */ }
    }
    const incoming = M.normalizeTemplates(data.templates);
    const known = new Set(templates.map(tp => tp.id));
    let added = 0;
    for (const tp of incoming) {
      if (known.has(tp.id)) templates[templates.findIndex(x => x.id === tp.id)] = tp;
      else { templates.push(tp); added++; }
    }
    saveTemplates();
    renderTemplates();
    status(t("テンプレートを {n} 件読み込みました。", { n: incoming.length }) + (incoming.length - added ? t("同じテンプレート {n} 件は置き換えました。", { n: incoming.length - added }) : ""));
  }

  function wireTemplates() {
    $("#tplSave").addEventListener("click", saveAsTemplate);
    $("#edTemplate").addEventListener("click", saveAsTemplate);
    $("#tplExport").addEventListener("click", exportTemplates);
    $("#tplImport").addEventListener("click", () => $("#tplFile").click());
    $("#tplFile").addEventListener("change", ev => { const file = ev.target.files[0]; ev.target.value = ""; if (file) importTemplates(file); });
    $("#solidAdd").addEventListener("click", async () => {
      const color = $("#solidColor").value;
      const blob = await solidBlob(color);
      const ids = await addFiles([new File([blob], t("単色 {color}", { color }) + ".png", { type: "image/png" })]);
      if (ids.length) { touch(); commit(); }
    });
  }

  function wireRest() {
    for (const el of document.querySelectorAll('input[name="exportMode"]')) {
      el.addEventListener("change", () => { if (el.checked) { state.exportOpts.mode = el.value; touch({ keepGallery: true }); commit(); } });
    }
    $("#optShrink").addEventListener("change", ev => { state.exportOpts.shrink = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#optBake").addEventListener("change", ev => { state.exportOpts.bake = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#optReedit").addEventListener("change", ev => { state.exportOpts.reedit = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#exportZip").addEventListener("click", exportZip);
    $("#exportAssets").addEventListener("click", exportAssets);

    $("#undo").addEventListener("click", undo);
    $("#redo").addEventListener("click", redo);
    window.addEventListener("keydown", ev => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      // Text and number fields keep the browser's own undo.
      const target = ev.target;
      if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && /^(text|number|url|search)$/.test(target.type))) return;
      ev.preventDefault();
      if (k === "y" || ev.shiftKey) redo(); else undo();
    });

    $("#saveProject").addEventListener("click", async () => {
      try {
        download(new Blob([JSON.stringify(await projectData())], { type: "application/json" }), `scenes-${stamp()}.scene.json`);
        status(t("プロジェクトを保存しました（置き場の画像も入っています）。"));
      } catch (err) {
        status(t("プロジェクトを保存できませんでした: {error}", { error: err.message }), true);
      }
    });
    $("#loadProject").addEventListener("click", () => $("#projectFile").click());
    $("#loadZip").addEventListener("click", () => $("#roomZipFile").click());
    $("#roomZipFile").addEventListener("change", ev => {
      const file = ev.target.files[0];
      ev.target.value = "";
      if (file) openRoomZip(file);
    });
    $("#projectFile").addEventListener("change", ev => {
      const file = ev.target.files[0];
      ev.target.value = "";
      if (file) openProject(file);
    });
    $("#resetAll").addEventListener("click", () => {
      if (!confirm(t("いまの作業内容を消して、最初の状態に戻します。よろしいですか？"))) return;
      state = M.defaultState();
      selected = null;
      keepBlobsStored();
      touch();
      commit();
      status(t("最初の状態に戻しました。「元に戻す」で戻せます。"));
    });
    let resizeTimer = 0;
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderBoard, 100); });
  }

  async function init() {
    loadSaved();
    ensureCcfIds();
    wireShelf();
    wireCommon();
    wireEditor();
    wireMarkers();
    wireView();
    wireTemplates();
    wireRest();
    loadTemplates();
    renderTemplates();
    touch();
    db = await openDb();
    await loadBlobs();
    await seedTemplates();
    renderTemplates();
    if (!db) status(t("このブラウザでは画像を保存できません。画像を入れたら「プロジェクトを保存」でファイルに残してください。"), true);
    touch();
    commit();
  }

  init();
})();
