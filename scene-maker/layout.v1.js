/*!
 * layout.v1.js - シーンメーカー（mogutools 版）の画面の配置: 引き出し（シーン編集・素材と設定・書き出し）の開け閉め。
 * app.v1.js の外側だけを触る。盤面の大きさが変わったら resize を投げて、app.v1.js に描き直してもらう。
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const drawers = ["dwEdit", "dwTools", "dwExport"];
  const KEY = "mogu-scene-maker.drawer";

  function open(id) {
    for (const d of drawers) $("#" + d).hidden = d !== id;
    for (const b of document.querySelectorAll("[data-dw]")) b.setAttribute("aria-pressed", String(b.dataset.dw === id));
    try { localStorage.setItem(KEY, id || ""); } catch (err) { /* not kept */ }
    window.dispatchEvent(new Event("resize"));
  }
  const current = () => drawers.find(d => !$("#" + d).hidden) || null;

  for (const b of document.querySelectorAll("[data-dw]")) b.addEventListener("click", () => open(current() === b.dataset.dw ? null : b.dataset.dw));
  for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => open(null));
  document.addEventListener("scene-edit", () => open("dwEdit"));
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && current() && !ev.target.closest("input, textarea, select")) open(null); });
  $("#barAdd").addEventListener("click", () => $("#sceneFiles").click());

  let first = null;
  try { first = localStorage.getItem(KEY); } catch (err) { /* none */ }
  if (first && drawers.includes(first)) open(first);
})();
