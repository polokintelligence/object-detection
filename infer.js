/* Object Detection in the browser: runs both trained models with onnxruntime-web, no server needed.
 * Used only by the shareable page (share/). Gives app.js the same answer the server's /api/detect gives.
 *
 * Steps for each model (the same as Ultralytics does in Python):
 *   1. letterbox: scale the picture to fit the model's square input, pad the rest with grey (114)
 *   2. run the network -> 15 numbers per candidate box: x, y, w, h + one score per class (11)
 *   3. keep boxes whose best class score >= conf, undo the letterbox, then non-maximum suppression per class
 */
(function () {
  const CLASSES = ["Vehicle", "Bus", "Bicycle", "Person", "Engine", "Truck", "Tricycle",
                   "Obstacle", "Pothole", "Traffic Light", "Traffic Sign"];
  // models/parts.json lists each model's file(s): one .onnx file on GitHub Pages, or a few base64 .txt
  // parts on claude.ai (which serves no raw binary files)
  const SPEC = {
    model1: { title: "Model 1 · YOLOv8s baseline", size: 640 },
    model2: { title: "Model 2 · YOLO11s + RFS + 800px", size: 800 },
  };
  let partsList = null;
  const getParts = () => partsList ??= fetch("models/parts.json").then(r => r.json());
  function fromBase64(text) {
    const s = atob(text.trim()), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  const IOU = 0.5, MAX_DET = 300;

  ort.env.wasm.wasmPaths = new URL("ort/", document.baseURI).href;
  ort.env.wasm.numThreads = 1;   // threads need special server headers; one thread works everywhere

  const sessions = {};
  function load(key) {
    if (!sessions[key]) {
      sessions[key] = (async () => {
        const parts = (await getParts())[key];
        const bufs = await Promise.all(parts.map(async p => {
          const r = await fetch(p);
          if (!r.ok) throw new Error(`could not download ${p} (${r.status})`);
          return p.endsWith(".txt") ? fromBase64(await r.text()) : new Uint8Array(await r.arrayBuffer());
        }));
        const all = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of bufs) { all.set(b, at); at += b.length; }
        return ort.InferenceSession.create(all, { executionProviders: ["wasm"] });
      })();
      sessions[key].catch(() => delete sessions[key]);  // allow a retry after a failed download
    }
    return sessions[key];
  }

  function letterbox(src, S) {
    const w = src.width, h = src.height, r = Math.min(S / w, S / h);
    const nw = Math.round(w * r), nh = Math.round(h * r);
    const px = Math.round((S - nw) / 2 - 0.1), py = Math.round((S - nh) / 2 - 0.1);
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "rgb(114,114,114)"; g.fillRect(0, 0, S, S);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, px, py, nw, nh);
    const d = g.getImageData(0, 0, S, S).data, n = S * S, x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {          // RGBA bytes -> 3 planes of R, G, B in 0..1
      x[i] = d[4 * i] / 255; x[n + i] = d[4 * i + 1] / 255; x[2 * n + i] = d[4 * i + 2] / 255;
    }
    return { tensor: new ort.Tensor("float32", x, [1, 3, S, S]), r, px, py };
  }

  function iou(a, b) {
    const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const i = w * h, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
    return u > 0 ? i / u : 0;
  }

  async function runOne(key, frame, conf) {
    const s = await load(key), S = SPEC[key].size;
    const t0 = performance.now();
    const lb = letterbox(frame, S);
    const out = (await s.run({ [s.inputNames[0]]: lb.tensor }))[s.outputNames[0]];
    const N = out.dims[2], o = out.data, W = frame.width, H = frame.height;
    const cand = [];
    for (let i = 0; i < N; i++) {
      let best = 0, cls = -1;
      for (let c = 0; c < CLASSES.length; c++) {
        const v = o[(4 + c) * N + i];
        if (v > best) { best = v; cls = c; }
      }
      if (best < conf) continue;
      const cx = o[i], cy = o[N + i], bw = o[2 * N + i], bh = o[3 * N + i];
      const clip = (v, m) => Math.min(Math.max(v, 0), m);
      cand.push({ cls, conf: best, box: [
        clip((cx - bw / 2 - lb.px) / lb.r, W), clip((cy - bh / 2 - lb.py) / lb.r, H),
        clip((cx + bw / 2 - lb.px) / lb.r, W), clip((cy + bh / 2 - lb.py) / lb.r, H)] });
    }
    cand.sort((a, b) => b.conf - a.conf);
    const keep = [];
    for (const c of cand) {                // NMS: drop a box that overlaps a stronger one of the same class
      if (keep.length >= MAX_DET) break;
      if (!keep.some(k => k.cls === c.cls && iou(k.box, c.box) > IOU)) keep.push(c);
    }
    const ms = performance.now() - t0;
    return { model: key, title: SPEC[key].title, trained: true, ms: Math.round(ms * 10) / 10,
             boxes: keep.map(k => ({ cls: k.cls, name: CLASSES[k.cls], conf: Math.round(k.conf * 1000) / 1000,
                                     box: k.box.map(v => Math.round(v * 10) / 10) })) };
  }

  window.RSInfer = {
    loaded: key => !!sessions[key],
    load,
    async detect(frame, keys, conf) {
      const results = [];
      for (const k of keys) results.push(await runOne(k, frame, conf));  // one at a time: less memory
      return { width: frame.width, height: frame.height, results };
    },
  };
})();
