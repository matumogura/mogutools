/* APNG を書き出すワーカー（画面を固めないため別スレッドで動かす） */
self.window = self;
importScripts('lib/pako.min.js', 'lib/UPNG.js');

self.onmessage = (e) => {
  const { id, bufs, w, h, cnum, dels } = e.data;
  try {
    const out = UPNG.encode(bufs, w, h, cnum, dels);
    self.postMessage({ id, ok: true, data: out }, [out]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
