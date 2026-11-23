# シーンメーカー（mogutools 版）

背景の画像をまとめて入れると、ココフォリアの「シーン」を一括で作り、ルームデータ（ZIP）で書き出すツール。

元にしたツール: [shiki365/scene-maker](https://github.com/shiki365/scene-maker)（MIT License, Copyright (c) 2026 shiki365。`LICENSE.txt`）

## 元のツールから変えたところ

- 見た目を mogutools のトップページに合わせた（クリーム色の背景、紺の文字、Zen Maru Gothic、角の丸い部品）。明るいテーマだけ
- 日本語だけにした（`i18n.v1.js`・`lang.*.v1.js`・`theme.v1.js` を外した。`app.v1.js` の `t()` は `{n}` などを埋めるだけ）
- ヘッダー・フッターのリンクを mogutools 向けにした。OGP 画像は付けていない

機能（マーカーパネル・テンプレート・縮小・素材 ZIP・自動保存など）は元のまま。保存の名前（localStorage・IndexedDB の `ccf-scene-maker*`）も元のままなので、元のツールで保存したプロジェクトファイル・テンプレートファイルを読み込める。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `index.html` | 画面と CSS（後ろの「mogutools らしさ」の部分が見た目の上書き） |
| `roomdata.v1.js` / `model.v1.js` / `app.v1.js` | 元のツールのまま（`app.v1.js` の `t()` だけ変更） |
| `favicon.svg` | タブのアイコン |
