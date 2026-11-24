/* Object Detection (AI Lab Project) frontend (single page)
 * Try it:  sends a photo / video frame / camera frame to POST /api/detect and draws the boxes.
 * Results: reads data/comparison.json (written by tools/compare.py) and draws the tables and charts.
 */

// Group members, shown in the footer. Edit these.
const TEAM = ["Polok", "Zahid", "Rony", "Parvez"];

const NAMES = { model1: "First version", model2: "Improved version" };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pct = v => (v * 100).toFixed(1);

$("#footer").textContent = "AI Lab Project · " + TEAM.join(" · ");

// sample video at the top: hidden until app/static/sample.mp4 exists (made by tools/make_sample.py)
const sampleVideo = $("#sample video");
sampleVideo.addEventListener("error", () => $("#sample").hidden = true);
if (sampleVideo.error) $("#sample").hidden = true;

function segment(id, onPick) {
  $$(`#${id} button`).forEach(b => b.addEventListener("click", () => {
    $$(`#${id} button`).forEach(x => x.classList.toggle("on", x === b));
    onPick(b.dataset.v);
  }));
}

// ---------------------------------------------------------------- try it
// conf: fixed minimum certainty (40%) - shows what the model is sure about, hides weak guesses
const state = { source: "image", model: "both", conf: 0.4, frame: null, shown: null,
  results: null, busy: false, loop: false, stream: null };
let STATUS = null;
const DROP_TEXT = { image: "Drag a road photo here, or <u>click to choose one</u>",
                    video: "Drag a road video here, or <u>click to choose one</u>" };

// The shareable page (share/) runs both models inside the browser (infer.js) instead of on the server.
const IN_BROWSER = !!window.RSInfer;
if (IN_BROWSER) {
  STATUS = { model1: { trained: true }, model2: { trained: true } };
  $('#source [data-v="camera"]').hidden = true;   // shared pages cannot open the camera
} else {
  fetch("/api/status").then(r => r.json()).then(s => { STATUS = s; note(); })
    .catch(() => setNote("The detection server is not running. Start it with run_app.bat."));
}

function setNote(t) { $("#note").textContent = t; }
function note() {
  if (!STATUS) return;
  const keys = state.model === "both" ? ["model1", "model2"] : [state.model];
  setNote(keys.some(k => !STATUS[k].trained)
    ? "Note: the trained model is not added yet, so a general-purpose model is used for now." : "");
}

segment("source", v => {
  stopLoop(); clearStage();
  state.source = v;
  $("#file").accept = v === "video" ? "video/*" : "image/*";
  $("#drop").hidden = v === "camera";
  if (v !== "camera") $("#drop span").innerHTML = DROP_TEXT[v];
  if (v === "camera") startCamera();
});
segment("model", v => { state.model = v; note(); if (state.source === "image") detect(); });


const drop = $("#drop");
$("#file").addEventListener("change", e => e.target.files[0] && openFile(e.target.files[0]));
["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => e.dataTransfer.files[0] && openFile(e.dataTransfer.files[0]));

// example photos under the drop area
$$("#examples button").forEach(b => b.addEventListener("click", async () => {
  const blob = await (await fetch(b.dataset.src)).blob();
  openFile(new File([blob], b.dataset.src.split("/").pop(), { type: blob.type }));
}));

function openFile(file) {
  stopLoop();
  const isVideo = file.type.startsWith("video");
  state.source = isVideo ? "video" : "image";
  $$("#source button").forEach(b => b.classList.toggle("on", b.dataset.v === state.source));
  drop.hidden = false;
  drop.classList.add("small");
  $("#drop span").innerHTML = `<u>Choose another ${isVideo ? "video" : "photo"}</u>`;
  if (isVideo) {
    video.srcObject = null; video.src = URL.createObjectURL(file); video.loop = true;
    video.play().then(runLoop);
  } else {
    const img = new Image();
    img.onload = () => { state.frame = snapshot(img, img.naturalWidth, img.naturalHeight, 1600); detect(); };
    img.src = URL.createObjectURL(file);
  }
}

function snapshot(src, w, h, maxW) {
  const s = Math.min(1, maxW / w), c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function detect() {
  if (!state.frame || state.busy) return;
  state.busy = true;
  $$(".stage").forEach(s => s.classList.add("busy"));
  if (!state.results) setNote("Looking at the picture…");
  try {
    if (IN_BROWSER) {
      const keys = state.model === "both" ? ["model1", "model2"] : [state.model];
      if (!keys.every(RSInfer.loaded)) setNote("Loading the AI models (about 40 MB, only the first time)…");
      await Promise.all(keys.map(RSInfer.load));
      setNote("Looking at the picture…");
      state.results = (await RSInfer.detect(state.frame, keys, state.conf)).results;
    } else {
      const blob = await new Promise(r => state.frame.toBlob(r, "image/jpeg", 0.9));
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("model", state.model);
      fd.append("conf", state.conf);
      const res = await fetch("/api/detect", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      state.results = (await res.json()).results;
    }
    state.shown = state.frame;
    note();
    render();
  } catch (e) {
    console.error(e);
    setNote(IN_BROWSER ? "Something went wrong while running the models. Reload the page and try again."
                       : "Something went wrong. Make sure the detection server is running.");
  } finally {
    state.busy = false;
    $$(".stage").forEach(s => s.classList.remove("busy"));
  }
}

function clearStage() {
  state.results = null;
  $("#diff").hidden = true;
  $("#stages").innerHTML = "";
  $("#stages").dataset.sig = "";
  drop.classList.remove("small");
}

function render() {
  const box = $("#stages"), r = state.results;
  const sig = r.map(x => x.model).join();
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.classList.toggle("two", r.length === 2);
    box.innerHTML = r.map(x => `<div class="stage" data-m="${x.model}"><canvas></canvas>
      <div class="meta"><b></b><span></span></div><div class="counts"></div></div>`).join("");
  }
  markNew(r);
  renderDiff(r);
  for (const x of r) {
    const el = box.querySelector(`[data-m="${x.model}"]`);
    el.querySelector("b").textContent = NAMES[x.model];
    const n = x.boxes.length;
    el.querySelector(".meta span").textContent =
      `found ${n} object${n === 1 ? "" : "s"} in ${(x.ms / 1000).toFixed(2)} s`;
    const c = {};
    x.boxes.forEach(b => c[b.name] = (c[b.name] || 0) + 1);
    el.querySelector(".counts").textContent =
      Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")
      || "Nothing found in this picture.";
    draw(el.querySelector("canvas"), state.shown, x.boxes);
  }
}

function draw(canvas, frame, boxes) {
  canvas.width = frame.width; canvas.height = frame.height;
  const g = canvas.getContext("2d");
  g.drawImage(frame, 0, 0);
  const lw = Math.max(2, frame.width / 350), fs = Math.max(14, Math.round(frame.width / 45));
  g.font = `500 ${fs}px "IBM Plex Sans", Arial, sans-serif`;
  g.textBaseline = "top";
  // boxes the first version missed are drawn last, so they sit on top
  for (const b of [...boxes].sort((a, c) => a.isNew - c.isNew)) {
    const [x1, y1, x2, y2] = b.box;
    if (b.isNew) {  // thicker dashed line: white dashes over a black outline, scaled down for small boxes
      const side = Math.min(x2 - x1, y2 - y1), t = Math.max(lw, Math.min(lw * 2, side / 8)), d = Math.max(3, Math.min(t * 3, side / 4));
      g.setLineDash([]); g.lineWidth = t + 2; g.strokeStyle = "#000"; g.strokeRect(x1, y1, x2 - x1, y2 - y1);
      g.setLineDash([d, d * 0.8]); g.lineWidth = t; g.strokeStyle = "#fff"; g.strokeRect(x1, y1, x2 - x1, y2 - y1);
      g.setLineDash([]);
    } else {
      g.lineWidth = lw + 2; g.strokeStyle = "#000"; g.strokeRect(x1, y1, x2 - x1, y2 - y1);
      g.lineWidth = lw; g.strokeStyle = "#fff"; g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    if (y2 - y1 < frame.height * 0.07) continue;  // far-away objects: box only, a label would cover the scene
    const t = `${b.name} ${Math.round(b.conf * 100)}%`;
    const w = g.measureText(t).width + 8, h = fs + 6, y = y1 - h < 0 ? y1 : y1 - h;
    g.fillStyle = b.isNew ? "#000" : "#fff"; g.fillRect(x1, y, w, h);
    g.fillStyle = b.isNew ? "#fff" : "#000"; g.fillText(t, x1 + 4, y + 3);
  }
}

// Compare mode: mark the improved version's boxes that the first version missed
// (no first-version box of the same kind overlapping it by at least 50%).
function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = w * h, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}
function markNew(r) {
  const m1 = r.find(x => x.model === "model1"), m2 = r.find(x => x.model === "model2");
  r.forEach(x => x.boxes.forEach(b => b.isNew = false));
  if (!m1 || !m2) return;
  m2.boxes.forEach(b => b.isNew = !m1.boxes.some(a => a.name === b.name && iou(a.box, b.box) >= 0.5));
}
function renderDiff(r) {
  const el = $("#diff");
  const m1 = r.find(x => x.model === "model1"), m2 = r.find(x => x.model === "model2");
  if (!m1 || !m2) { el.hidden = true; return; }
  const count = x => x.boxes.reduce((c, b) => (c[b.name] = (c[b.name] || 0) + 1, c), {});
  const c1 = count(m1), c2 = count(m2);
  const names = [...new Set([...Object.keys(c1), ...Object.keys(c2)])]
    .sort((a, b) => ((c2[b] || 0) - (c1[b] || 0)) - ((c2[a] || 0) - (c1[a] || 0)) || (c2[b] || 0) - (c2[a] || 0));
  const n1 = m1.boxes.length, n2 = m2.boxes.length, d = n2 - n1;
  const missed = m2.boxes.filter(b => b.isNew).length;
  const sign = v => v > 0 ? "+" + v : v < 0 ? "\u2212" + -v : "0";
  el.innerHTML = `<div class="big">${d > 0 ? `The improved version found ${d} more object${d === 1 ? "" : "s"}`
      : d < 0 ? `The first version found ${-d} more object${d === -1 ? "" : "s"}` : "Both versions found the same number of objects"}</div>
    <div class="sub">First version: ${n1} · Improved version: ${n2} · the ${missed} object${missed === 1 ? "" : "s"} the first version missed are marked with dashed boxes</div>
    <table><tr><th>Object</th><th>First version</th><th>Improved version</th><th>Difference</th></tr>
    ${names.map(k => { const a = c1[k] || 0, b = c2[k] || 0;
      return `<tr><td>${k}</td><td>${a}</td><td>${b}</td><td class="${b > a ? "up" : ""}">${sign(b - a)}</td></tr>`; }).join("")}
    </table>
    <div class="key"><span><i class="solid"></i>found by both</span><span><i class="dash"></i>missed by the first version</span></div>`;
  el.hidden = false;
}

// video + camera: grab a frame, detect, repeat
const video = $("#video");
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    video.src = ""; video.srcObject = state.stream;
    await video.play();
    setNote("Click the picture to pause.");
    runLoop();
  } catch (e) {
    setNote("Could not open the camera. Check that the browser is allowed to use it.");
  }
}
async function runLoop() {
  state.loop = true;
  while (state.loop) {
    if (video.readyState >= 2) {
      state.frame = snapshot(video, video.videoWidth, video.videoHeight, 960);
      await detect();
    } else await new Promise(r => setTimeout(r, 50));
  }
}
function stopLoop() {
  state.loop = false;
  video.pause();
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
}
// click the picture to pause / resume a video
$("#stages").addEventListener("click", () => {
  if (state.source === "image") return;
  if (state.loop) { state.loop = false; video.pause(); }
  else if (video.src || video.srcObject) { video.play(); runLoop(); }
});

// ---------------------------------------------------------------- results
Chart.defaults.font.family = '"IBM Plex Sans", Arial, sans-serif';
Chart.defaults.font.size = 13;
Chart.defaults.color = "#6b6b6b";
Chart.defaults.borderColor = "#e2e2e2";
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.align = "start";
const charts = {};
function chart(id, cfg) {
  charts[id]?.destroy();
  charts[id] = new Chart($("#" + id), { ...cfg, options: { responsive: true, maintainAspectRatio: false, animation: false, ...cfg.options } });
}
const GREY = "#c4c4c4", BLACK = "#000";

fetch("data/comparison.json", { cache: "no-store" })
  .then(r => r.ok ? r.json() : null).catch(() => null).then(results);

function results(data) {
  if (!data) { $("#no-results").hidden = false; $("#results-body").hidden = true; return; }
  $("#demo-flag").hidden = !data.demo;
  const m1 = data.models.model1, m2 = data.models.model2, cls = data.classes;

  const head = [
    ["Accuracy", "Finds the right object in the right place (mAP@50)", "map50"],
    ["Reliability", "When it marks something, how often it is right (precision)", "precision"],
    ["Coverage", "Of all real objects in the photos, how many it finds (recall)", "recall"],
  ];
  $("#headline").innerHTML = head.map(([k, x, key]) => {
    const d = (m2.test[key] - m1.test[key]) * 100;
    return `<div><div class="k">${k}</div><div class="x">${x}</div>
      <div class="v">${pct(m1.test[key])}% → ${pct(m2.test[key])}%</div>
      <div class="d">${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} points with the improved version</div></div>`;
  }).join("");

  const ap = (m, c) => +(((m.per_class[c] || {}).ap50 ?? 0) * 100).toFixed(1);
  chart("c-class", {
    type: "bar",
    data: { labels: cls, datasets: [
      { label: NAMES.model1, data: cls.map(c => ap(m1, c)), backgroundColor: GREY, barPercentage: .8, categoryPercentage: .7 },
      { label: NAMES.model2, data: cls.map(c => ap(m2, c)), backgroundColor: BLACK, barPercentage: .8, categoryPercentage: .7 }] },
    options: { indexAxis: "y", scales: { x: { max: 100, ticks: { callback: v => v + "%" } }, y: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw}%` } } } },
  });

  const changes = [
    ["Rare objects", "Treated like all the others", "Photos with rare objects are shown up to 4× more often", "Repeat-Factor Sampling"],
    ["Model design", "YOLOv8s", "YOLO11s, a newer design that pays more attention to important areas", "C3k2 + C2PSA attention"],
    ["Picture size", "640 pixels", "800 pixels, so small traffic lights and signs stay visible", "imgsz 640 → 800"],
    ["Learning method", "Standard settings", "Starts gently, then learns more and more carefully", "AdamW, cosine LR, warm-up"],
    ["Practice variety", "Standard", "Mixes and resizes photos so the model doesn't just memorise them", "MixUp, scale 0.6, close_mosaic 10"],
    ["Training time", `${m1.train_hours ?? "?"} hours`, `${m2.train_hours ?? "?"} hours`, `${m1.epochs_done ?? "?"} → ${m2.epochs_done ?? "?"} epochs`],
  ];
  $("#changes").innerHTML = `<tr><th></th><th>First version</th><th>Improved version</th><th>Technical name</th></tr>` +
    changes.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("");

  const before = cls.map(c => m1.class_stats?.[c]?.boxes ?? 0);
  const rfs = m2.class_stats_rfs;
  chart("c-rfs", {
    type: "bar",
    data: { labels: cls, datasets: [
      { label: "Seen by the first version", data: before, backgroundColor: GREY, categoryPercentage: .7 },
      ...(rfs ? [{ label: "Seen by the improved version", data: cls.map(c => rfs[c] ?? 0), backgroundColor: BLACK, categoryPercentage: .7 }] : [])] },
    options: { scales: { y: { type: "logarithmic", title: { display: true, text: "objects per round of training" } }, x: { grid: { display: false } } } },
  });

  const hist = m => (m.history["metrics/mAP50(B)"] || []).map(v => +(v * 100).toFixed(1));
  const len = Math.max(hist(m1).length, hist(m2).length);
  const line = (label, d, color) => ({ label, data: d, borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 1.5, tension: .2 });
  chart("c-epoch", {
    type: "line",
    data: { labels: Array.from({ length: len }, (_, i) => i + 1),
      datasets: [line(NAMES.model1, hist(m1), "#aaa"), line(NAMES.model2, hist(m2), BLACK)] },
    options: { interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: v => v + "%" } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12 }, title: { display: true, text: "round of training (epoch)" } } } },
  });

  // technical details
  const sign = d => (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(1);
  const rows = [["mAP@50", "map50"], ["mAP@50-95", "map50_95"], ["Precision", "precision"], ["Recall", "recall"], ["F1", "f1"]]
    .map(([k, key]) => [k, pct(m1.test[key]) + "%", pct(m2.test[key]) + "%", sign((m2.test[key] - m1.test[key]) * 100)]);
  const mil = v => v ? (v / 1e6).toFixed(1) + " M" : "–";
  const ms = m => m.test.speed_ms?.inference != null ? m.test.speed_ms.inference.toFixed(1) + " ms" : "–";
  rows.push(["Parameters", mil(m1.params), mil(m2.params), ""]);
  rows.push(["GPU inference / image", ms(m1), ms(m2), ""]);
  rows.push(["Training images / epoch", (m1.train_images ?? 0).toLocaleString(), (m2.train_images ?? 0).toLocaleString(), ""]);
  cls.forEach(c => rows.push([`AP@50 ${c}`, ap(m1, c) + "%", ap(m2, c) + "%", sign(ap(m2, c) - ap(m1, c))]));
  $("#metrics").innerHTML = `<tr><th>Metric</th><th>Model 1</th><th>Model 2</th><th>Change</th></tr>` +
    rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("");

  const plots = key => {
    const imgs = (data.models[key].images || []).filter(p => !/batch/.test(p));
    $("#plots").innerHTML = imgs.map(p => `<a href="${p}" target="_blank"><img src="${p}" loading="lazy" alt="">${p.split("/").pop()}</a>`).join("");
  };
  $("#plots-wrap").hidden = !(m1.images?.length || m2.images?.length);
  segment("plots-seg", plots);
  plots("model1");
  $("details").addEventListener("toggle", () => Object.values(charts).forEach(c => c.resize()));
}
