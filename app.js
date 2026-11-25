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
  results: null, busy: false, loop: false, stream: null,
  focus: null,     // focus: the kind of object picked in the comparison table (only those are shown)
  gen: 0 };        // gen: counts opened files, so a late answer for an older file is thrown away
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

// In the browser the models (about 40 MB) must be downloaded once. Start as soon as "Try it" comes into
// view, so they are usually ready before the visitor picks a photo, and show a progress bar meanwhile.
function preload() {
  if (!IN_BROWSER || preload.started) return;
  preload.started = true;
  const bar = $("#progress"), fill = bar.querySelector("i"), text = bar.querySelector("span");
  const mb = v => Math.round(v / 1e6);
  RSInfer.onProgress((got, total) => {
    if (!total || bar.classList.contains("done")) return;
    bar.hidden = false;
    fill.style.width = (100 * Math.min(got / total, 1)).toFixed(1) + "%";
    text.textContent = got >= total ? "Starting the AI models…"
      : `Downloading the AI models: ${mb(got)} of ${mb(total)} MB (only the first time)`;
  });
  Promise.all(["model1", "model2"].map(RSInfer.load)).then(() => {
    bar.classList.add("done");
    fill.style.width = "100%";
    text.textContent = "AI models ready.";
    setTimeout(() => bar.hidden = true, 2500);
  }).catch(() => {
    preload.started = false;
    text.textContent = "Could not download the AI models. Check the internet connection and reload the page.";
  });
}
if (IN_BROWSER) {
  // start soon after the page has loaded (getting the graphics card ready takes a few seconds),
  // or at once if the visitor scrolls to "Try it" before that
  window.addEventListener("load", () => setTimeout(preload, 1500));
  new IntersectionObserver((seen, obs) => {
    if (seen.some(e => e.isIntersecting)) { preload(); obs.disconnect(); }
  }, { rootMargin: "300px" }).observe($("#try"));
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
drop.addEventListener("drop", e => {
  const example = e.dataTransfer.getData("text/x-example");   // an example tile dragged onto the drop area
  if (example) openExample(example);
  else if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});

// example photos and videos under the drop area: click one, or drag it onto the drop area.
// Dragging must carry the example's real file, not the small preview picture on the tile.
// Example videos come with every frame already checked (examples/video_*.json, tools/precompute_examples.py),
// so they play smoothly at full speed straight away.
async function openExample(src) {
  const blob = await (await fetch(src)).blob();
  let track = null;
  if (/\.mp4$/.test(src)) track = await fetch(src.replace(/\.mp4$/, ".json")).then(r => r.ok ? r.json() : null).catch(() => null);
  openFile(new File([blob], src.split("/").pop(), { type: blob.type }), track && trackFromJson(track));
}
$$("#examples button").forEach(b => {
  b.draggable = true;
  b.querySelector("img").draggable = false;
  b.addEventListener("dragstart", e => { e.dataTransfer.setData("text/x-example", b.dataset.src); e.dataTransfer.effectAllowed = "copy"; });
  b.addEventListener("click", () => openExample(b.dataset.src));
});

// a dropped file's type is often empty (phone videos, some Windows files), so also look at the name
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ogv|mpe?g|wmv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i;

function openFile(file, track = null) {
  stopLoop();
  clearStage();                // drop the previous picture's results right away
  const gen = state.gen;       // results that arrive later for an older file are ignored
  const isVideo = file.type.startsWith("video") || (!file.type.startsWith("image") && VIDEO_EXT.test(file.name));
  if (!isVideo && !file.type.startsWith("image") && !IMAGE_EXT.test(file.name)) {
    setNote("That file is not a photo or a video. Please choose a road photo (JPG, PNG) or video (MP4).");
    return;
  }
  state.source = isVideo ? "video" : "image";
  $$("#source button").forEach(b => b.classList.toggle("on", b.dataset.v === state.source));
  $("#file").accept = isVideo ? "video/*" : "image/*";
  drop.hidden = false;
  drop.classList.add("small");
  $("#drop span").innerHTML = `<u>Choose another ${isVideo ? "video" : "photo"}</u>`;
  const url = URL.createObjectURL(file);
  if (isVideo) {
    setNote("Opening the video…");
    video.srcObject = null; video.muted = true; video.loop = true; video.src = url;
    new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = fail; }).then(async () => {
      video.onloadeddata = video.onerror = null;
      if (gen !== state.gen) return;
      const t = track || await analyzeVideo(gen);
      if (t && gen === state.gen) startPlayback(t);
    }).catch(() => {
      if (gen === state.gen) setNote("This browser cannot play that video. Please try an MP4 (H.264) video.");
    });
  } else {
    const img = new Image();
    img.onload = () => {
      if (gen !== state.gen) return;
      state.frame = snapshot(img, img.naturalWidth, img.naturalHeight, 1600); detect();
    };
    img.onerror = () => gen === state.gen && setNote("Could not open that photo. Please try a JPG or PNG.");
    img.src = url;
  }
}

function snapshot(src, w, h, maxW) {
  const s = Math.min(1, maxW / w), c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const chosenKeys = () => state.model === "both" ? ["model1", "model2"] : [state.model];

// run the chosen models on one picture: in this browser (shared website) or on the local server
async function runModels(frame, keys) {
  if (IN_BROWSER) {
    preload();
    await Promise.all(keys.map(RSInfer.load));
    return (await RSInfer.detect(frame, keys, state.conf)).results;
  }
  const blob = await new Promise(r => frame.toBlob(r, "image/jpeg", 0.9));
  const fd = new FormData();
  fd.append("file", blob, "frame.jpg");
  fd.append("model", keys.length === 2 ? "both" : keys[0]);
  fd.append("conf", state.conf);
  const res = await fetch("/api/detect", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).results;
}

async function detect() {
  if (!state.frame || state.busy) return;
  state.busy = true;
  const gen = state.gen, frame = state.frame;
  $$(".stage").forEach(s => s.classList.add("busy"));
  if (!state.results) setNote("Looking at the picture…");
  try {
    if (IN_BROWSER && !$("#progress").classList.contains("done"))
      setNote("Your picture will be checked as soon as the AI models are ready.");
    const results = await runModels(frame, chosenKeys());
    if (gen !== state.gen) return;           // another file was opened meanwhile
    state.results = results;
    state.shown = frame;
    if (state.source === "image") note();
    else setNote(state.loop ? "Click the picture to pause." : "Paused. Click the picture to continue.");
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

// ---------------------------------------------------------------- smooth video
// A laptop browser cannot run two detection models 25 times a second, so a video is checked first
// (a few frames per second, both models) and then played at full speed with the boxes of the nearest
// checked frame. Example videos arrive already checked for every frame.
const play = { track: null, raf: 0, idx: -1, diffAt: 0, analyzing: false };
const PLAYING = "Playing with the boxes in sync. Click the picture to pause.";

function trackFromJson(j) {
  const n = j.model1.length, toBoxes = list => list.map(([c, p, x1, y1, x2, y2]) =>
    ({ cls: c, name: j.names[c], conf: p / 100, box: [x1, y1, x2, y2] }));
  const results = [];
  for (let i = 0; i < n; i++)
    results.push(["model1", "model2"].map(m => ({ model: m, ms: null, boxes: toBoxes(j[m][i]) })));
  return { dt: 1 / j.fps, n, w: j.w, h: j.h, results };
}

function seekTo(t) {
  return new Promise(r => {
    const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); r(); };
    const timer = setTimeout(done, 2000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

function showWork(frac, text) {
  const bar = $("#progress");
  bar.hidden = false; bar.classList.remove("done");
  bar.querySelector("i").style.width = (100 * frac).toFixed(1) + "%";
  bar.querySelector("span").textContent = text;
}

async function analyzeVideo(gen) {
  const keys = ["model1", "model2"];            // check with both, so the model buttons work afterwards
  if (IN_BROWSER) {
    setNote("Getting the AI models ready…");
    preload();
    try { await Promise.all(keys.map(RSInfer.load)); } catch { return null; }
  }
  if (gen !== state.gen) return null;
  const fast = !IN_BROWSER || (await RSInfer.backend) === "webgpu";
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  let dt = fast ? 0.2 : 1;                      // seconds between checked frames
  if (dur / dt > 300) dt = dur / 300;           // long videos: at most about 300 checked frames
  const n = Math.max(1, Math.floor((dur - 0.05) / dt) + 1);
  video.pause();
  play.analyzing = true;
  setNote("Checking the video first, so it can then play smoothly with the boxes.");
  const results = [], t0 = performance.now();
  let w = 0, h = 0;
  try {
    for (let k = 0; k < n; k++) {
      await seekTo(Math.min(k * dt, Math.max(0, dur - 0.05)));
      if (gen !== state.gen) return null;
      const frame = snapshot(video, video.videoWidth, video.videoHeight, 960);
      w = frame.width; h = frame.height;
      const r = await runModels(frame, keys);
      if (gen !== state.gen) return null;
      results.push(r);
      state.shown = frame;                      // show each checked frame while working
      state.results = r.filter(x => chosenKeys().includes(x.model));
      render();
      const left = Math.round((performance.now() - t0) / (k + 1) * (n - k - 1) / 1000);
      showWork((k + 1) / n, `Checking the video: frame ${k + 1} of ${n}` + (k + 1 < n ? ` (about ${left} s left)` : ""));
    }
  } catch (e) {
    console.error(e);
    if (gen === state.gen) setNote("Something went wrong while checking the video. Reload the page and try again.");
    return null;
  } finally {
    play.analyzing = false;
    if (gen === state.gen) { $("#progress").classList.add("done"); setTimeout(() => { if (!play.analyzing) $("#progress").hidden = true; }, 1500); }
  }
  return { dt, n, w, h, results };
}

function startPlayback(track) {
  stopPlayback();
  play.track = track; play.idx = -1;
  const c = document.createElement("canvas"), g = c.getContext("2d");
  c.width = track.w; c.height = track.h;
  video.loop = true; video.currentTime = 0;
  video.play().catch(() => {});
  setNote(PLAYING);
  const tick = () => {
    if (play.track !== track) return;
    play.raf = requestAnimationFrame(tick);
    if (video.readyState < 2) return;
    const i = Math.min(track.n - 1, Math.max(0, Math.floor(video.currentTime / track.dt + 1e-3)));
    g.drawImage(video, 0, 0, c.width, c.height);
    state.shown = c;
    state.results = track.results[i].filter(x => chosenKeys().includes(x.model));
    const now = performance.now(), table = i !== play.idx && now - play.diffAt > 400;  // table: at most 2.5x a second
    if (table) play.diffAt = now;
    play.idx = i;
    render(!table);
  };
  tick();
}
function stopPlayback() { play.track = null; cancelAnimationFrame(play.raf); }

function clearStage() {
  state.gen++;                 // any check still running belongs to the old picture: ignore its answer
  stopPlayback();
  if (play.analyzing) $("#progress").hidden = true;   // the video check bar belongs to the old video
  state.frame = state.shown = null;
  state.results = null;
  state.focus = null;
  $("#diff").hidden = true;
  $("#stages").innerHTML = "";
  $("#stages").dataset.sig = "";
  drop.classList.remove("small");
}

// one picture per model; in compare mode the two sit side by side (stacked on phones)
const stageHTML = m => `<div class="stage${m === "model2" ? " best" : ""}" data-m="${m}">
  <div class="pic"><canvas></canvas><span class="tag">${NAMES[m]}</span></div>
  <div class="meta"><b></b><span></span></div><div class="counts"></div></div>`;

function render(skipTable = false) {
  const box = $("#stages"), r = state.results, two = r.length === 2;
  const sig = r.map(x => x.model).join();
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = r.map(x => stageHTML(x.model)).join("");
    box.classList.toggle("two", two);
  }
  if (!two || !r.some(x => x.boxes.some(b => b.name === state.focus))) state.focus = null;
  markNew(r);
  if (!skipTable) renderDiff(r);
  for (const x of r) {
    const el = box.querySelector(`[data-m="${x.model}"]`);
    el.querySelector("b").textContent = NAMES[x.model];
    const n = x.boxes.length;
    el.querySelector(".meta span").textContent = x.ms == null || play.track
      ? `${n} object${n === 1 ? "" : "s"} in this frame`
      : `found ${n} object${n === 1 ? "" : "s"} in ${(x.ms / 1000).toFixed(2)} s`;
    const c = {};
    x.boxes.forEach(b => c[b.name] = (c[b.name] || 0) + 1);
    el.querySelector(".counts").textContent =
      Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")
      || "Nothing found in this picture.";
    draw(el.querySelector("canvas"), state.shown, x.boxes);
  }
}

function draw(canvas, frame, boxes) {
  if (canvas.width !== frame.width) canvas.width = frame.width;      // resizing clears the canvas: only when needed
  if (canvas.height !== frame.height) canvas.height = frame.height;
  const g = canvas.getContext("2d");
  g.drawImage(frame, 0, 0);
  const lw = Math.max(2, frame.width / 350), fs = Math.max(14, Math.round(frame.width / 45));
  g.font = `500 ${fs}px "IBM Plex Sans", Arial, sans-serif`;
  g.textBaseline = "top";
  // a row picked in the comparison table: darken the picture except the boxes of that kind of object
  if (state.focus) {
    boxes = boxes.filter(b => b.name === state.focus);
    g.fillStyle = "rgba(0,0,0,0.65)"; g.fillRect(0, 0, frame.width, frame.height);
    for (const b of boxes) {
      const [x1, y1, x2, y2] = b.box.map(Math.round), w = x2 - x1, h = y2 - y1;
      if (w > 0 && h > 0) g.drawImage(frame, x1, y1, w, h, x1, y1, w, h);
    }
  }
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
  if (!m1 || !m2) { el.hidden = true; state.focus = null; return; }
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
      return `<tr data-name="${k}" tabindex="0" aria-pressed="${state.focus === k}"${state.focus === k ? ' class="sel"' : ""}>
        <td>${k}</td><td>${a}</td><td>${b}</td><td class="${b > a ? "up" : ""}">${sign(b - a)}</td></tr>`; }).join("")}
    </table>
    <div class="pick">${state.focus
      ? `Showing only <b>${state.focus}</b> on the picture. <button type="button" class="show-all">Show all objects</button>`
      : "Click a row to show only that kind of object on the picture."}</div>
    <div class="key"><span><i class="solid"></i>found by both</span><span><i class="dash"></i>missed by the first version</span></div>`;
  el.hidden = false;
}

// click (or Enter on) a row of the comparison table: show only that kind of object; again: show all
function pickRow(e) {
  const tr = e.target.closest("tr[data-name]");
  if (e.target.closest(".show-all")) state.focus = null;
  else if (tr) state.focus = state.focus === tr.dataset.name ? null : tr.dataset.name;
  else return;
  render();
  $(`#diff tr[data-name="${state.focus}"]`)?.focus();
}
$("#diff").addEventListener("click", pickRow);
$("#diff").addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.closest("tr[data-name]")) { e.preventDefault(); pickRow(e); }
});

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
  const me = runLoop.id = (runLoop.id || 0) + 1;   // only the newest loop keeps running
  state.loop = true;
  while (state.loop && me === runLoop.id) {
    if (video.readyState >= 2 && !state.busy) {
      state.frame = snapshot(video, video.videoWidth, video.videoHeight, 960);
      await detect();
    } else await new Promise(r => setTimeout(r, 50));
  }
}
function stopLoop() {
  state.loop = false;
  stopPlayback();
  video.pause();
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
}
// click the picture to pause / resume a video
$("#stages").addEventListener("click", () => {
  if (state.source === "image" || play.analyzing) return;
  if (play.track) {            // smooth playback: pause / resume the video, the boxes follow it
    if (video.paused) { video.play(); setNote(PLAYING); }
    else { video.pause(); setNote("Paused. Click the picture to continue."); }
    return;
  }
  if (state.loop) { state.loop = false; video.pause(); setNote("Paused. Click the picture to continue."); }
  else if (video.src || video.srcObject) {
    video.play(); runLoop();
    setNote("The video is checked one frame at a time. Click the picture to pause.");
  }
});

// ---------------------------------------------------------------- results
Chart.defaults.font.family = '"IBM Plex Sans", Arial, sans-serif';
Chart.defaults.font.size = 13;
// chart colours follow the theme: read from the CSS tokens, re-applied when the theme switches.
// The datasets use functions (Chart.js "scriptable options"), so an update() picks up the new colours.
const PAL = {};
function readPalette() {
  const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
  const light = document.documentElement.dataset.theme === "light";
  Object.assign(PAL, { ink: v("--ink"), grey: v("--grey"), line: v("--line"),
    m1: light ? "#b5b5b5" : "#555", m1line: light ? "#9a9a9a" : "#666" });
  Chart.defaults.color = PAL.grey;
  Chart.defaults.borderColor = PAL.line;
}
readPalette();
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.align = "start";
const charts = {};

// light / dark switch at the top right; the choice is remembered in this browser
const themeBtn = $("#theme-toggle");
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function paintThemeButton() {
  const light = document.documentElement.dataset.theme === "light";
  themeBtn.innerHTML = light ? MOON + "Dark" : SUN + "Light";       // the button names the theme it switches to
  themeBtn.setAttribute("aria-label", light ? "Switch to the dark theme" : "Switch to the light theme");
}
themeBtn.addEventListener("click", () => {
  const root = document.documentElement, light = root.dataset.theme !== "light";
  root.classList.add("switching");
  if (light) root.dataset.theme = "light"; else delete root.dataset.theme;
  try { localStorage.setItem("theme", light ? "light" : "dark"); } catch (e) {}
  readPalette();
  for (const c of Object.values(charts)) {        // existing charts: new text and grid colours, then redraw
    for (const s of Object.values(c.options.scales || {})) {
      if (s.ticks) s.ticks.color = PAL.grey;
      if (s.grid) s.grid.color = PAL.line;
      if (s.border) s.border.color = PAL.line;
      if (s.title) s.title.color = PAL.grey;
    }
    if (c.options.plugins?.legend?.labels) c.options.plugins.legend.labels.color = PAL.grey;
    c.update("none");
  }
  paintThemeButton();
  setTimeout(() => root.classList.remove("switching"), 300);
});
paintThemeButton();

function chart(id, cfg) {
  charts[id]?.destroy();
  charts[id] = new Chart($("#" + id), { ...cfg, options: { responsive: true, maintainAspectRatio: false, animation: false, ...cfg.options } });
}
// chart colours on the black page: first version dim grey, improved version white
const GREY = () => PAL.m1, BLACK = () => PAL.ink;   // first version: soft grey; improved: the text colour

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
  const mil = v => v ? (v / 1e6).toFixed(1) + " M" : "–";

  // 01 · the two models, as spec cards; rows that changed are marked in the improved card
  const spec = [
    ["Architecture", "YOLOv8s", "YOLO11s", "C3k2 blocks + C2PSA attention"],
    ["Input size", "640 × 640", "800 × 800", "small lights and signs stay visible"],
    ["Class balance", "none", "Repeat-Factor Sampling", "rare-object photos shown up to 4× more"],
    ["Optimizer", "default (auto)", "AdamW + cosine LR", "with warm-up"],
    ["Augmentation", "default mosaic", "+ MixUp, scale 0.6", "close_mosaic 10"],
    ["Parameters", mil(m1.params), mil(m2.params), ""],
    ["Training", `${m1.epochs_done ?? "?"} epochs · ${m1.train_hours ?? "?"} h`, `${m2.epochs_done ?? "?"} epochs · ${m2.train_hours ?? "?"} h`, ""],
  ];
  const card = (i, title, sub, m) => `<article class="model${i === 2 ? " best" : ""}">
    <div class="mh"><span>Model ${i}</span><b>${title}</b><em>${sub}</em></div>
    <dl>${spec.map(r => `<div class="${i === 2 && r[1] !== r[2] && r[3] ? "chg" : ""}"><dt>${r[0]}</dt><dd>${r[i]}${i === 2 && r[3] ? `<small>${r[3]}</small>` : ""}</dd></div>`).join("")}</dl>
    <div class="score"><span>mAP@50</span><b>${pct(m.test.map50)}%</b></div></article>`;
  $("#models").innerHTML = card(1, "Baseline", "the first version", m1) +
    `<div class="arrow" aria-hidden="true">→</div>` + card(2, "Improved", "our changes", m2);

  // 02 · analysis: one chart at a time, each with its one-line finding
  const gains = cls.map(c => [c, ap(m2, c) - ap(m1, c)]).sort((a, b) => b[1] - a[1]);
  const before = cls.map(c => m1.class_stats?.[c]?.boxes ?? 0);
  const rfs = m2.class_stats_rfs;
  const most = Math.max(...before), least = Math.min(...before.filter(v => v > 0));
  const mostName = cls[before.indexOf(most)], leastName = cls[before.indexOf(least)];
  const hist = m => (m.history["metrics/mAP50(B)"] || []).map(v => +(v * 100).toFixed(1));
  const line = (label, d, color) => ({ label, data: d, borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 1.5, tension: .2 });
  const views = {
    class: {
      tall: true,
      finding: `Model 2 is better on ${gains.filter(g => g[1] > 0).length} of ${cls.length} classes. Biggest gains: ` +
        gains.slice(0, 3).map(([c, d]) => `${c} +${d.toFixed(1)}`).join(", ") + " points (AP@50).",
      cfg: { type: "bar",
        data: { labels: cls, datasets: [
          { label: NAMES.model1, data: cls.map(c => ap(m1, c)), backgroundColor: GREY, barPercentage: .8, categoryPercentage: .7 },
          { label: NAMES.model2, data: cls.map(c => ap(m2, c)), backgroundColor: BLACK, barPercentage: .8, categoryPercentage: .7 }] },
        options: { indexAxis: "y", scales: { x: { max: 100, ticks: { callback: v => v + "%" } }, y: { grid: { display: false } } },
          plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw}%` } } } } },
    },
    rfs: {
      finding: `The training set is very unbalanced: ${mostName} has ${most.toLocaleString()} boxes, ${leastName} only ${least.toLocaleString()} ` +
        `(${Math.round(most / least)}× fewer). Repeat-Factor Sampling shows photos with rare classes more often. Log scale.`,
      cfg: { type: "bar",
        data: { labels: cls, datasets: [
          { label: "Seen by Model 1", data: before, backgroundColor: GREY, categoryPercentage: .7 },
          ...(rfs ? [{ label: "Seen by Model 2 (with RFS)", data: cls.map(c => rfs[c] ?? 0), backgroundColor: BLACK, categoryPercentage: .7 }] : [])] },
        options: { scales: { y: { type: "logarithmic", title: { display: true, text: "objects per epoch" } }, x: { grid: { display: false } } } } },
    },
    epoch: {
      finding: `Validation mAP@50 per epoch. Model 1 levels off at ${Math.max(...hist(m1)).toFixed(1)}%; ` +
        `Model 2 keeps climbing to ${Math.max(...hist(m2)).toFixed(1)}%.`,
      cfg: { type: "line",
        data: { labels: Array.from({ length: Math.max(hist(m1).length, hist(m2).length) }, (_, i) => i + 1),
          datasets: [line(NAMES.model1, hist(m1), () => PAL.m1line), line(NAMES.model2, hist(m2), BLACK)] },
        options: { interaction: { mode: "index", intersect: false },
          scales: { y: { ticks: { callback: v => v + "%" } },
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12 }, title: { display: true, text: "epoch" } } } } },
    },
  };
  const show = key => {
    $("#finding").textContent = views[key].finding;
    $("#an-chart").classList.toggle("tall", !!views[key].tall);
    chart("c-an", views[key].cfg);
  };
  segment("an-seg", show);
  show("class");

  // technical details
  const sign = d => (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(1);
  const rows = [["mAP@50", "map50"], ["mAP@50-95", "map50_95"], ["Precision", "precision"], ["Recall", "recall"], ["F1", "f1"]]
    .map(([k, key]) => [k, pct(m1.test[key]) + "%", pct(m2.test[key]) + "%", sign((m2.test[key] - m1.test[key]) * 100)]);
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
