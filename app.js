const regions = [
  {key:"forehead", name:"額", instruction:"髪をできるだけ避けて、額の中央が入るように撮ります。"},
  {key:"rightCheek", name:"右頬", instruction:"鼻・口・耳・マスクの縁を入れすぎず、頬の中心に近づいて撮ります。"},
  {key:"leftCheek", name:"左頬", instruction:"鼻・口・耳・マスクの縁を入れすぎず、頬の中心に近づいて撮ります。"},
  {key:"nose", name:"鼻", instruction:"鼻筋と小鼻が見えるように。毛穴・赤みとの区別に使う部位です。"}
];

const state = {
  current: 0,
  sessionName: "",
  lightingPreset: "front",
  regions: {}
};

const $ = id => document.getElementById(id);
const wizard = $("wizard");
const summaryTabs = $("summaryTabs");
const analysisCanvas = $("analysisCanvas");
const actx = analysisCanvas.getContext("2d", {willReadFrequently:true});

let frontURL = null;
let rakingURL = null;
let lastMetrics = null;

function buildWizard(){
  wizard.innerHTML = "";
  regions.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "step";
    if (i === state.current) d.classList.add("active");
    if (state.regions[r.key]) d.classList.add("done");
    d.textContent = `${i+1}. ${r.name}`;
    wizard.appendChild(d);
  });
}

function currentRegion(){
  return regions[state.current];
}

function updateRegionUI(){
  const r = currentRegion();
  $("regionHeading").textContent = `3. ${r.name} の登録`;
  $("progressText").textContent = `${state.current + 1} / ${regions.length}`;
  $("regionInstruction").innerHTML = `<b>${r.name}</b>: ${r.instruction}`;
  $("frontInput").value = "";
  $("rakingInput").value = "";
  clearLocalPreviews();

  const saved = state.regions[r.key];
  if(saved){
    if(saved.frontDataUrl) $("frontPreview").src = saved.frontDataUrl;
    renderSavedOverlay(saved);
    fillMetrics(saved.metrics);
  } else {
    clearMetrics();
  }
  buildWizard();
  renderSummary();
}

function clearLocalPreviews(){
  $("frontPreview").removeAttribute("src");
  resizeCanvas(analysisCanvas);
  actx.fillStyle = "#111";
  actx.fillRect(0,0,analysisCanvas.width,analysisCanvas.height);
}

function resizeCanvas(c){
  const cssW = c.clientWidth || 320;
  const cssH = cssW * 4 / 3;
  c.width = Math.round(cssW);
  c.height = Math.round(cssH);
}

function dataUrlFromFile(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

$("frontInput").addEventListener("change", async e => {
  const f = e.target.files[0];
  if(!f) return;
  const url = await dataUrlFromFile(f);
  frontURL = url;
  $("frontPreview").src = url;
});

$("rakingInput").addEventListener("change", async e => {
  const f = e.target.files[0];
  if(!f) return;
  rakingURL = await dataUrlFromFile(f);
});

function clearMetrics(){
  ["mCandidates","mAreaRatio","mTexture","mAvgSize"].forEach(id => $(id).textContent = "—");
}

function fillMetrics(m){
  if(!m){ clearMetrics(); return; }
  $("mCandidates").textContent = m.candidates;
  $("mAreaRatio").textContent = m.areaRatio.toFixed(2) + "%";
  $("mTexture").textContent = m.texture.toFixed(2);
  $("mAvgSize").textContent = m.avgSize.toFixed(1) + " px²";
}

function regionMask(w, h, regionKey){
  const pts = [];
  if(regionKey === "forehead"){
    pts.push([0.18,0.20],[0.82,0.20],[0.76,0.58],[0.24,0.58]);
  } else if(regionKey === "rightCheek" || regionKey === "leftCheek"){
    pts.push([0.16,0.18],[0.84,0.18],[0.90,0.72],[0.64,0.92],[0.20,0.78]);
  } else {
    pts.push([0.28,0.12],[0.72,0.12],[0.82,0.80],[0.50,0.94],[0.18,0.80]);
  }
  return pts.map(([x,y]) => [x*w,y*h]);
}

function pointInPolygon(x, y, poly){
  let inside = false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
    const intersect = ((yi>y)!=(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi+1e-9) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

async function analyzeCurrentRegion(){
  const region = currentRegion();
  const src = rakingURL || frontURL;
  if(!src){
    alert("まずこの部位の画像を1枚以上入れてください。");
    return;
  }

  const img = new Image();
  img.src = src;
  await img.decode();

  resizeCanvas(analysisCanvas);
  const w = analysisCanvas.width;
  const h = analysisCanvas.height;
  actx.clearRect(0,0,w,h);
  actx.fillStyle = "#111";
  actx.fillRect(0,0,w,h);

  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;
  actx.drawImage(img, ox, oy, dw, dh);

  const srcData = actx.getImageData(0,0,w,h);
  const data = srcData.data;

  const gray = new Float32Array(w*h);
  for(let i=0, p=0; i<data.length; i+=4, p++){
    gray[p] = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
  }

  const blur = boxBlur(gray, w, h, 11);
  const maskPoly = regionMask(w, h, region.key);

  const candidateMap = new Uint8Array(w*h);
  let texSum = 0, texN = 0;
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const idx = y*w + x;
      if(!pointInPolygon(x,y,maskPoly)) continue;

      const local = blur[idx] - gray[idx];
      const gx = gray[idx+1] - gray[idx-1];
      const gy = gray[idx+w] - gray[idx-w];
      const grad = Math.sqrt(gx*gx + gy*gy);
      texSum += Math.abs(local);
      texN++;

      let threshLocal = 12;
      let threshGrad = 10;

      if(region.key === "nose"){ threshLocal = 10; threshGrad = 12; }
      if(region.key === "forehead"){ threshLocal = 13; threshGrad = 9; }

      if(local > threshLocal && grad > threshGrad){
        candidateMap[idx] = 1;
      }
    }
  }

  const visited = new Uint8Array(w*h);
  const comps = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const start = y*w+x;
      if(!candidateMap[start] || visited[start]) continue;
      const q = [start];
      visited[start] = 1;
      let pixels = [];
      let minX=x,maxX=x,minY=y,maxY=y;
      while(q.length){
        const cur = q.pop();
        const cx = cur % w, cy = (cur / w) | 0;
        pixels.push(cur);
        if(cx<minX) minX=cx; if(cx>maxX) maxX=cx;
        if(cy<minY) minY=cy; if(cy>maxY) maxY=cy;
        for(const [dx,dy] of dirs){
          const nx = cx+dx, ny = cy+dy;
          if(nx<1||ny<1||nx>=w-1||ny>=h-1) continue;
          const ni = ny*w + nx;
          if(candidateMap[ni] && !visited[ni]){
            visited[ni]=1;
            q.push(ni);
          }
        }
      }
      const area = pixels.length;
      const bw = maxX-minX+1;
      const bh = maxY-minY+1;
      if(area < 8 || area > 1500) continue;
      const aspect = Math.max(bw,bh) / Math.max(1, Math.min(bw,bh));
      comps.push({minX,minY,maxX,maxY,area,bw,bh,aspect});
    }
  }

  actx.clearRect(0,0,w,h);
  actx.fillStyle = "#111";
  actx.fillRect(0,0,w,h);
  actx.drawImage(img, ox, oy, dw, dh);

  actx.save();
  actx.strokeStyle = "rgba(245,158,11,0.9)";
  actx.lineWidth = 2;
  actx.beginPath();
  maskPoly.forEach((pt, i) => i ? actx.lineTo(pt[0], pt[1]) : actx.moveTo(pt[0], pt[1]));
  actx.closePath();
  actx.stroke();
  actx.restore();

  let totalArea = 0;
  comps.forEach((c, i) => {
    totalArea += c.area;
    const t = classifyShape(c);
    actx.strokeStyle = t.color;
    actx.lineWidth = 1.5;
    actx.strokeRect(c.minX, c.minY, c.bw, c.bh);
    actx.fillStyle = t.color;
    actx.font = "11px system-ui";
    actx.fillText(String(i+1), c.minX+1, Math.max(10, c.minY-2));
  });

  const polyArea = polygonArea(maskPoly);
  const metrics = {
    candidates: comps.length,
    areaRatio: polyArea ? (100 * totalArea / polyArea) : 0,
    texture: texN ? (texSum / texN) : 0,
    avgSize: comps.length ? totalArea / comps.length : 0,
    components: comps.map(classifyShape)
  };
  lastMetrics = metrics;
  fillMetrics(metrics);
}

function classifyShape(c){
  let label = "R";
  let color = "rgba(59,130,246,0.95)";
  if(c.area < 40 && c.aspect < 1.7){
    label = "I";
    color = "rgba(239,68,68,0.95)";
  } else if(c.aspect < 1.45 && c.area >= 40){
    label = "B";
    color = "rgba(34,197,94,0.95)";
  }
  return {...c, label, color};
}

function polygonArea(poly){
  let a = 0;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    a += poly[j][0]*poly[i][1] - poly[i][0]*poly[j][1];
  }
  return Math.abs(a)/2;
}

function boxBlur(gray, w, h, radius){
  const tmp = new Float32Array(w*h);
  const out = new Float32Array(w*h);
  const size = radius*2 + 1;

  for(let y=0;y<h;y++){
    let sum = 0;
    for(let x=-radius;x<=radius;x++){
      const xx = Math.min(w-1, Math.max(0,x));
      sum += gray[y*w + xx];
    }
    for(let x=0;x<w;x++){
      tmp[y*w + x] = sum / size;
      const rm = x - radius;
      const ad = x + radius + 1;
      if(rm >= 0) sum -= gray[y*w + rm];
      if(ad < w) sum += gray[y*w + ad];
      else sum += gray[y*w + (w-1)];
    }
  }

  for(let x=0;x<w;x++){
    let sum = 0;
    for(let y=-radius;y<=radius;y++){
      const yy = Math.min(h-1, Math.max(0,y));
      sum += tmp[yy*w + x];
    }
    for(let y=0;y<h;y++){
      out[y*w + x] = sum / size;
      const rm = y - radius;
      const ad = y + radius + 1;
      if(rm >= 0) sum -= tmp[rm*w + x];
      if(ad < h) sum += tmp[ad*w + x];
      else sum += tmp[(h-1)*w + x];
    }
  }
  return out;
}

function renderSavedOverlay(saved){
  resizeCanvas(analysisCanvas);
  if(!saved.overlayDataUrl){
    actx.fillStyle = "#111";
    actx.fillRect(0,0,analysisCanvas.width,analysisCanvas.height);
    return;
  }
  const img = new Image();
  img.onload = () => {
    actx.clearRect(0,0,analysisCanvas.width,analysisCanvas.height);
    actx.drawImage(img,0,0,analysisCanvas.width,analysisCanvas.height);
  };
  img.src = saved.overlayDataUrl;
}

$("analyzeBtn").addEventListener("click", analyzeCurrentRegion);

$("saveRegionBtn").addEventListener("click", () => {
  const r = currentRegion();
  if(!frontURL && !rakingURL){
    alert("画像を入れてください。");
    return;
  }
  state.sessionName = $("sessionName").value;
  state.lightingPreset = $("lightingPreset").value;
  state.regions[r.key] = {
    name: r.name,
    frontDataUrl: frontURL || null,
    rakingDataUrl: rakingURL || null,
    overlayDataUrl: analysisCanvas.toDataURL("image/png"),
    metrics: lastMetrics
  };
  buildWizard();
  renderSummary();
  alert(`${r.name} を保存しました。`);
});

function renderSummary(){
  summaryTabs.innerHTML = "";
  const savedRegions = Object.keys(state.regions);
  if(!savedRegions.length){
    $("summaryPane").textContent = "まだ部位は保存されていません。";
    return;
  }

  savedRegions.forEach((key, idx) => {
    const btn = document.createElement("button");
    btn.textContent = state.regions[key].name;
    if(idx === 0) btn.classList.add("active");
    btn.onclick = () => {
      [...summaryTabs.children].forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      showSummary(key);
    };
    summaryTabs.appendChild(btn);
  });
  showSummary(savedRegions[0]);
}

function showSummary(key){
  const s = state.regions[key];
  const m = s.metrics;
  let labels = "";
  if(m?.components?.length){
    const counts = {I:0,B:0,R:0};
    m.components.forEach(c => counts[c.label] = (counts[c.label]||0)+1);
    labels = `<li>I型候補: ${counts.I}</li><li>B型候補: ${counts.B}</li><li>R型候補: ${counts.R}</li>`;
  }

  $("summaryPane").innerHTML = `
    <div class="small">
      <b>${s.name}</b><br>
      セッション名: ${escapeHtml(state.sessionName || "未入力")}<br>
      照明プリセット: ${escapeHtml(state.lightingPreset)}<br><br>
      <ul class="list">
        <li>候補数: ${m ? m.candidates : "—"}</li>
        <li>候補面積率: ${m ? m.areaRatio.toFixed(2) + "%" : "—"}</li>
        <li>texture roughness: ${m ? m.texture.toFixed(2) : "—"}</li>
        <li>平均候補サイズ: ${m ? m.avgSize.toFixed(1) + " px²" : "—"}</li>
        ${labels}
      </ul>
    </div>
  `;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

$("prevStep").addEventListener("click", () => {
  state.current = (state.current - 1 + regions.length) % regions.length;
  frontURL = null; rakingURL = null; lastMetrics = null;
  updateRegionUI();
});
$("nextStep").addEventListener("click", () => {
  state.current = (state.current + 1) % regions.length;
  frontURL = null; rakingURL = null; lastMetrics = null;
  updateRegionUI();
});

$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "acne_scar_session_v0_5.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("resetBtn").addEventListener("click", () => {
  if(!confirm("セッション全体をリセットしますか？")) return;
  state.current = 0;
  state.sessionName = "";
  state.lightingPreset = "front";
  state.regions = {};
  $("sessionName").value = "";
  $("lightingPreset").value = "front";
  frontURL = null; rakingURL = null; lastMetrics = null;
  updateRegionUI();
});

window.addEventListener("resize", () => {
  const r = currentRegion();
  const saved = state.regions[r.key];
  if(saved) renderSavedOverlay(saved);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(console.warn);
}

buildWizard();
updateRegionUI();