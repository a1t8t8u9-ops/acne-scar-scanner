const regions = [
  {key:"forehead", name:"額", instruction:"眉の上から生え際までをROIにします。髪・眉・メガネをできるだけ外してください。", roi:{l:.18,t:.18,r:.82,b:.56}},
  {key:"rightCheek", name:"右頬", instruction:"目の下〜口角上、鼻横〜耳側の頬だけをROIにします。", roi:{l:.18,t:.18,r:.86,b:.80}},
  {key:"leftCheek", name:"左頬", instruction:"目の下〜口角上、鼻横〜耳側の頬だけをROIにします。", roi:{l:.18,t:.18,r:.86,b:.80}},
  {key:"nose", name:"鼻", instruction:"鼻筋〜小鼻をROIにします。目・口・頬をできるだけ外してください。", roi:{l:.28,t:.12,r:.72,b:.86}}
];

const state = {
  current: 0,
  sessionName: "",
  lightingPreset: "none",
  schemaVersion: "0.7",
  regions: {}
};

const $ = id => document.getElementById(id);
const wizard = $("wizard");
const summaryTabs = $("summaryTabs");
const roiCanvas = $("roiCanvas");
const rctx = roiCanvas.getContext("2d");
const analysisCanvas = $("analysisCanvas");
const actx = analysisCanvas.getContext("2d", {willReadFrequently:true});

let frontURL = null;
let rakingURL = null;
let lastMetrics = null;
let roi = null;
let roiConfirmed = false;
let editorImage = null;
let imageRect = null;
let dragging = null;

const analysisBaseCanvas = document.createElement("canvas");
const bctx = analysisBaseCanvas.getContext("2d");
let analysisReady = false;
let annotations = [];
let rejectedAnnotations = [];
let selectedAnnotationId = null;
let annotationMode = "select";
let annotationConfirmed = false;
let nextAnnotationId = 1;
let addStart = null;
let addDraft = null;

const currentRegion = () => regions[state.current];
const cloneROI = x => ({l:x.l,t:x.t,r:x.r,b:x.b});

function buildWizard(){
  wizard.innerHTML = "";
  regions.forEach((r,i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "step";
    if(i === state.current) b.classList.add("active");
    if(state.regions[r.key]) b.classList.add("done");
    b.textContent = `${i+1}. ${r.name}`;
    b.onclick = () => switchRegion(i);
    wizard.appendChild(b);
  });
}

function switchRegion(i){
  state.current = i;
  frontURL = null;
  rakingURL = null;
  lastMetrics = null;
  editorImage = null;
  imageRect = null;
  dragging = null;

  const saved = state.regions[currentRegion().key];
  if(saved){
    frontURL = saved.topDataUrl || saved.frontDataUrl || null;
    rakingURL = saved.rakingDataUrl || null;
    roi = saved.roi ? cloneROI(saved.roi) : cloneROI(currentRegion().roi);
    roiConfirmed = !!saved.roiConfirmed;
    lastMetrics = saved.metrics || null;
  } else {
    roi = cloneROI(currentRegion().roi);
    roiConfirmed = false;
  }

  resetAnnotationState();
  updateUI();
}

function updateUI(){
  const r = currentRegion();
  $("regionHeading").textContent = `3. ${r.name} の画像`;
  $("progressText").textContent = `${state.current+1} / ${regions.length}`;
  $("regionInstruction").innerHTML = `<b>${r.name}</b>: ${r.instruction}`;

  ["frontInput","rakingInput","frontCameraInput","rakingCameraInput"].forEach(id => $(id).value = "");
  $("frontPreview").removeAttribute("src");
  $("rakingPreview").removeAttribute("src");
  $("frontSourceStatus").textContent = "未選択";
  $("rakingSourceStatus").textContent = "未選択";

  if(frontURL){
    $("frontPreview").src = frontURL;
    $("frontSourceStatus").textContent = "保存済み";
  }
  if(rakingURL){
    $("rakingPreview").src = rakingURL;
    $("rakingSourceStatus").textContent = "保存済み";
  }

  fillMetrics(lastMetrics);
  setROIStatus();
  prepareEditor();
  clearAnalysis();
  $("annotationPanel").hidden = true;

  const saved = state.regions[r.key];
  if(saved?.overlayDataUrl) renderSavedOverlay(saved.overlayDataUrl);

  buildWizard();
  renderSummary();
}

function dataUrlFromFile(file){
  return new Promise((resolve,reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function setImage(kind,file,label){
  if(!file) return;
  const url = await dataUrlFromFile(file);

  if(kind === "front"){
    frontURL = url;
    $("frontPreview").src = url;
    $("frontSourceStatus").textContent = label;
    roi = cloneROI(currentRegion().roi);
    roiConfirmed = false;
    await prepareEditor();
  } else {
    rakingURL = url;
    $("rakingPreview").src = url;
    $("rakingSourceStatus").textContent = label;
    if(!frontURL){
      roi = cloneROI(currentRegion().roi);
      roiConfirmed = false;
      await prepareEditor();
    }
  }

  lastMetrics = null;
  fillMetrics(null);
  clearAnalysis();
  resetAnnotationState();
  setROIStatus();
}

$("frontFileBtn").onclick = () => $("frontInput").click();
$("rakingFileBtn").onclick = () => $("rakingInput").click();
$("frontCameraBtn").onclick = () => $("frontCameraInput").click();
$("rakingCameraBtn").onclick = () => $("rakingCameraInput").click();

$("frontInput").onchange = e => setImage("front",e.target.files?.[0],`ファイル: ${e.target.files?.[0]?.name||""}`);
$("rakingInput").onchange = e => setImage("raking",e.target.files?.[0],`ファイル: ${e.target.files?.[0]?.name||""}`);
$("frontCameraInput").onchange = e => setImage("front",e.target.files?.[0],"カメラで撮影済み");
$("rakingCameraInput").onchange = e => setImage("raking",e.target.files?.[0],"カメラで撮影済み");

async function loadImage(src){
  if(!src) return null;
  const im = new Image();
  im.src = src;
  await im.decode();
  return im;
}

async function prepareEditor(){
  const src = frontURL || rakingURL;
  $("roiEditorEmpty").hidden = !!src;
  roiCanvas.hidden = !src;
  if(!src){
    editorImage = null;
    return;
  }
  editorImage = await loadImage(src);
  drawEditor();
}

function resizeEditor(){
  const w = Math.max(280, roiCanvas.clientWidth || 320);
  const h = Math.min(560, Math.max(360, Math.round(w*1.15)));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  roiCanvas.width = Math.round(w*dpr);
  roiCanvas.height = Math.round(h*dpr);
  roiCanvas.style.height = h+"px";
  rctx.setTransform(dpr,0,0,dpr,0,0);
  return {w,h};
}

function drawEditor(){
  if(!editorImage) return;
  const {w,h} = resizeEditor();
  rctx.clearRect(0,0,w,h);
  rctx.fillStyle = "#0b1020";
  rctx.fillRect(0,0,w,h);

  const s = Math.min(w/editorImage.naturalWidth,h/editorImage.naturalHeight);
  const dw = editorImage.naturalWidth*s;
  const dh = editorImage.naturalHeight*s;
  const x = (w-dw)/2;
  const y = (h-dh)/2;
  imageRect = {x,y,w:dw,h:dh};
  rctx.drawImage(editorImage,x,y,dw,dh);

  const L=x+roi.l*dw, R=x+roi.r*dw, T=y+roi.t*dh, B=y+roi.b*dh;

  rctx.save();
  rctx.fillStyle = "rgba(0,0,0,.48)";
  rctx.beginPath();
  rctx.rect(x,y,dw,dh);
  rctx.rect(L,T,R-L,B-T);
  rctx.fill("evenodd");

  rctx.strokeStyle = roiConfirmed ? "#10b981" : "#f59e0b";
  rctx.lineWidth = 3;
  rctx.strokeRect(L,T,R-L,B-T);

  rctx.setLineDash([6,5]);
  rctx.lineWidth = 1.5;
  rctx.beginPath();
  rctx.moveTo(L,(T+B)/2);
  rctx.lineTo(R,(T+B)/2);
  rctx.moveTo((L+R)/2,T);
  rctx.lineTo((L+R)/2,B);
  rctx.stroke();
  rctx.setLineDash([]);

  [
    {k:"top",x:(L+R)/2,y:T,label:"上端"},
    {k:"bottom",x:(L+R)/2,y:B,label:"下端"},
    {k:"left",x:L,y:(T+B)/2,label:"左端"},
    {k:"right",x:R,y:(T+B)/2,label:"右端"}
  ].forEach(p => {
    rctx.fillStyle = "#fff";
    rctx.beginPath();
    rctx.arc(p.x,p.y,12,0,Math.PI*2);
    rctx.fill();
    rctx.strokeStyle = roiConfirmed ? "#10b981" : "#f59e0b";
    rctx.lineWidth = 4;
    rctx.stroke();
    rctx.font = "bold 12px system-ui";
    rctx.textAlign = "center";
    rctx.fillStyle = "#fff";
    const yy = p.k==="top" ? p.y-18 : p.k==="bottom" ? p.y+28 : p.y-18;
    rctx.fillText(p.label,p.x,yy);
  });
  rctx.restore();
}

function pointerPosOnROI(e){
  const rect = roiCanvas.getBoundingClientRect();
  return {x:e.clientX-rect.left,y:e.clientY-rect.top};
}

function nearestEdge(p){
  if(!imageRect) return null;
  const L=imageRect.x+roi.l*imageRect.w;
  const R=imageRect.x+roi.r*imageRect.w;
  const T=imageRect.y+roi.t*imageRect.h;
  const B=imageRect.y+roi.b*imageRect.h;

  const d = [
    ["top",Math.abs(p.y-T),p.x>=L-30&&p.x<=R+30],
    ["bottom",Math.abs(p.y-B),p.x>=L-30&&p.x<=R+30],
    ["left",Math.abs(p.x-L),p.y>=T-30&&p.y<=B+30],
    ["right",Math.abs(p.x-R),p.y>=T-30&&p.y<=B+30]
  ].filter(x=>x[2]).sort((a,b)=>a[1]-b[1]);

  return d[0] && d[0][1] < 32 ? d[0][0] : null;
}

roiCanvas.addEventListener("pointerdown",e=>{
  dragging = nearestEdge(pointerPosOnROI(e));
  if(dragging){
    roiCanvas.setPointerCapture(e.pointerId);
    roiConfirmed = false;
    invalidateAnalysis();
    setROIStatus();
  }
});

roiCanvas.addEventListener("pointermove",e=>{
  if(!dragging || !imageRect) return;
  const p = pointerPosOnROI(e);
  const nx = Math.min(1,Math.max(0,(p.x-imageRect.x)/imageRect.w));
  const ny = Math.min(1,Math.max(0,(p.y-imageRect.y)/imageRect.h));
  const gap = .08;

  if(dragging==="left") roi.l=Math.min(nx,roi.r-gap);
  if(dragging==="right") roi.r=Math.max(nx,roi.l+gap);
  if(dragging==="top") roi.t=Math.min(ny,roi.b-gap);
  if(dragging==="bottom") roi.b=Math.max(ny,roi.t+gap);
  drawEditor();
});

["pointerup","pointercancel"].forEach(ev=>roiCanvas.addEventListener(ev,()=>dragging=null));

$("resetRoiBtn").onclick = () => {
  roi = cloneROI(currentRegion().roi);
  roiConfirmed = false;
  invalidateAnalysis();
  setROIStatus();
  drawEditor();
};

$("confirmRoiBtn").onclick = () => {
  if(!(frontURL||rakingURL)){
    alert("先に画像を選んでください。");
    return;
  }
  roiConfirmed = true;
  setROIStatus();
  drawEditor();
};

function setROIStatus(){
  const el = $("roiStatus");
  if(!(frontURL||rakingURL)){
    el.textContent = "画像を入れるとROI調整ができます";
    el.className = "note";
    return;
  }
  if(roiConfirmed){
    el.innerHTML = "<b>ROI確定済み</b> — この範囲だけを解析します。";
    el.className = "note goodNote";
  } else {
    el.innerHTML = "<b>ROI未確定</b> — 4本の境界線を指で動かして、解析する皮膚だけを囲ってください。";
    el.className = "warnBox";
  }
}

function clearAnalysis(){
  const w = Math.max(320,analysisCanvas.clientWidth||320);
  const h = Math.round(w*1.1);
  analysisCanvas.width = w;
  analysisCanvas.height = h;
  actx.fillStyle = "#111827";
  actx.fillRect(0,0,w,h);
}

function renderSavedOverlay(src){
  const im = new Image();
  im.onload = () => {
    analysisCanvas.width = im.naturalWidth;
    analysisCanvas.height = im.naturalHeight;
    actx.drawImage(im,0,0);
  };
  im.src = src;
}

function invalidateAnalysis(){
  lastMetrics = null;
  fillMetrics(null);
  clearAnalysis();
  resetAnnotationState();
}

async function analyzeCurrentRegion(){
  const src = rakingURL || frontURL;

  if(!src){
    alert("上方光または斜光画像を入れてください。");
    return;
  }
  if(!roiConfirmed){
    alert("先にROIを確定してください。");
    return;
  }

  if(rakingURL&&frontURL){
    $("analysisSource").innerHTML = "<b>基準画像:</b> 上方光 / <b>凹凸候補検出:</b> 斜光 × 確定ROI";
  } else if(rakingURL){
    $("analysisSource").innerHTML = "<b>解析に使用:</b> 斜光画像 × 確定ROI<br><span class='tiny'>※標準プロトコルでは上方光画像も登録します。</span>";
  } else {
    $("analysisSource").innerHTML = "<b>解析に使用:</b> 上方光画像 × 確定ROI";
  }

  const img = await loadImage(src);
  const sx = Math.round(roi.l*img.naturalWidth);
  const sy = Math.round(roi.t*img.naturalHeight);
  const sw = Math.max(10,Math.round((roi.r-roi.l)*img.naturalWidth));
  const sh = Math.max(10,Math.round((roi.b-roi.t)*img.naturalHeight));
  const scale = Math.min(1,620/sw);
  const w = Math.max(120,Math.round(sw*scale));
  const h = Math.max(120,Math.round(sh*scale));

  analysisBaseCanvas.width = w;
  analysisBaseCanvas.height = h;
  bctx.clearRect(0,0,w,h);
  bctx.drawImage(img,sx,sy,sw,sh,0,0,w,h);

  const image = bctx.getImageData(0,0,w,h);
  const d = image.data;
  const gray = new Float32Array(w*h);

  for(let i=0,p=0;i<d.length;i+=4,p++){
    gray[p]=.299*d[i]+.587*d[i+1]+.114*d[i+2];
  }

  const blur = boxBlur(gray,w,h,9);
  const map = new Uint8Array(w*h);
  let tex = 0;
  let n = 0;

  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x;
      const local=blur[i]-gray[i];
      const gx=gray[i+1]-gray[i-1];
      const gy=gray[i+w]-gray[i-w];
      const grad=Math.hypot(gx,gy);
      tex+=Math.abs(local);
      n++;
      if(local>11 && grad>9) map[i]=1;
    }
  }

  const comps = components(map,w,h);

  annotations = comps.map(c => {
    const t = classify(c);
    return {
      id: nextAnnotationId++,
      x:c.x, y:c.y, w:c.w, h:c.h,
      pixelArea:c.area,
      type:t.label,
      source:"auto"
    };
  });

  rejectedAnnotations = [];
  selectedAnnotationId = null;
  annotationMode = "select";
  annotationConfirmed = false;
  analysisReady = true;
  addStart = null;
  addDraft = null;

  lastMetrics = {
    candidates:annotations.length,
    areaRatio:100*comps.reduce((s,c)=>s+c.area,0)/(w*h),
    texture:n?tex/n:0,
    avgSize:comps.length?comps.reduce((s,c)=>s+c.area,0)/comps.length:0,
    components:comps.map(classify),
    roi:cloneROI(roi),
    analysisImage:rakingURL?"raking":"top",
    rejectedCount:0,
    annotationReviewed:false
  };

  analysisCanvas.width = w;
  analysisCanvas.height = h;
  $("annotationPanel").hidden = false;

  renderAnnotations();
  fillMetrics(lastMetrics);
  updateAnnotationUI();
  $("annotationPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
}

function components(map,w,h){
  const seen=new Uint8Array(w*h);
  const out=[];
  const dirs=[[1,0],[-1,0],[0,1],[0,-1]];

  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const s=y*w+x;
      if(!map[s]||seen[s]) continue;

      const q=[s];
      seen[s]=1;
      let area=0,minX=x,maxX=x,minY=y,maxY=y;

      while(q.length){
        const cur=q.pop();
        const cx=cur%w;
        const cy=(cur/w)|0;
        area++;
        minX=Math.min(minX,cx);
        maxX=Math.max(maxX,cx);
        minY=Math.min(minY,cy);
        maxY=Math.max(maxY,cy);

        for(const[dx,dy]of dirs){
          const nx=cx+dx, ny=cy+dy;
          if(nx<=0||ny<=0||nx>=w-1||ny>=h-1) continue;
          const ni=ny*w+nx;
          if(map[ni]&&!seen[ni]){
            seen[ni]=1;
            q.push(ni);
          }
        }
      }

      const bw=maxX-minX+1;
      const bh=maxY-minY+1;
      if(area>=8 && area<=Math.max(800,Math.round(w*h*.03))){
        out.push({
          x:minX,y:minY,w:bw,h:bh,area,
          aspect:Math.max(bw,bh)/Math.max(1,Math.min(bw,bh))
        });
      }
    }
  }
  return out;
}

function classify(c){
  if(c.area<35 && c.aspect<1.7) return {...c,label:"I"};
  if(c.aspect<1.45 && c.area>=35) return {...c,label:"B"};
  return {...c,label:"R"};
}

function boxBlur(g,w,h,r){
  const tmp=new Float32Array(w*h);
  const out=new Float32Array(w*h);
  const size=2*r+1;

  for(let y=0;y<h;y++){
    let sum=0;
    for(let x=-r;x<=r;x++) sum+=g[y*w+Math.min(w-1,Math.max(0,x))];
    for(let x=0;x<w;x++){
      tmp[y*w+x]=sum/size;
      const rm=x-r,ad=x+r+1;
      if(rm>=0) sum-=g[y*w+rm];
      if(ad<w) sum+=g[y*w+ad];
      else sum+=g[y*w+w-1];
    }
  }

  for(let x=0;x<w;x++){
    let sum=0;
    for(let y=-r;y<=r;y++) sum+=tmp[Math.min(h-1,Math.max(0,y))*w+x];
    for(let y=0;y<h;y++){
      out[y*w+x]=sum/size;
      const rm=y-r,ad=y+r+1;
      if(rm>=0) sum-=tmp[rm*w+x];
      if(ad<h) sum+=tmp[ad*w+x];
      else sum+=tmp[(h-1)*w+x];
    }
  }
  return out;
}

function annotationColor(type){
  if(type==="I") return "#ef4444";
  if(type==="B") return "#22c55e";
  if(type==="R") return "#3b82f6";
  return "#a855f7";
}

function renderAnnotations(){
  if(!analysisReady) return;

  actx.clearRect(0,0,analysisCanvas.width,analysisCanvas.height);
  actx.drawImage(analysisBaseCanvas,0,0);

  annotations.forEach(a => {
    const selected = a.id===selectedAnnotationId;
    actx.save();
    actx.strokeStyle = selected ? "#facc15" : annotationColor(a.type);
    actx.lineWidth = selected ? 3 : 1.7;
    if(a.source==="manual") actx.setLineDash([5,3]);
    actx.strokeRect(a.x,a.y,a.w,a.h);
    actx.setLineDash([]);

    const label = `${a.type==="U"?"?":a.type}${a.id}`;
    actx.font = "bold 11px system-ui";
    const tw = actx.measureText(label).width + 6;
    const ly = Math.max(0,a.y-15);
    actx.fillStyle = selected ? "#facc15" : annotationColor(a.type);
    actx.fillRect(a.x,ly,tw,14);
    actx.fillStyle = selected ? "#111827" : "#fff";
    actx.fillText(label,a.x+3,ly+11);
    actx.restore();
  });

  if(addDraft){
    actx.save();
    actx.strokeStyle="#facc15";
    actx.lineWidth=2;
    actx.setLineDash([5,3]);
    actx.strokeRect(addDraft.x,addDraft.y,addDraft.w,addDraft.h);
    actx.restore();
  }
}

function analysisPointerPos(e){
  const rect=analysisCanvas.getBoundingClientRect();
  return {
    x:(e.clientX-rect.left)*analysisCanvas.width/rect.width,
    y:(e.clientY-rect.top)*analysisCanvas.height/rect.height
  };
}

function hitAnnotation(p){
  const hits = annotations.filter(a =>
    p.x>=a.x-8 && p.x<=a.x+a.w+8 &&
    p.y>=a.y-8 && p.y<=a.y+a.h+8
  );
  hits.sort((a,b)=>(a.w*a.h)-(b.w*b.h));
  return hits[0] || null;
}

function markAnnotationsDirty(){
  annotationConfirmed=false;
  if(lastMetrics) lastMetrics.annotationReviewed=false;
  updateAnnotationUI();
}

analysisCanvas.addEventListener("pointerdown",e=>{
  if(!analysisReady) return;
  const p=analysisPointerPos(e);

  if(annotationMode==="add"){
    addStart=p;
    addDraft={x:p.x,y:p.y,w:0,h:0};
    analysisCanvas.setPointerCapture(e.pointerId);
    return;
  }

  const hit=hitAnnotation(p);

  if(annotationMode==="delete"){
    if(hit){
      rejectedAnnotations.push({...hit,rejectedAt:new Date().toISOString()});
      annotations=annotations.filter(a=>a.id!==hit.id);
      if(selectedAnnotationId===hit.id) selectedAnnotationId=null;
      markAnnotationsDirty();
      refreshAnnotationMetrics();
      renderAnnotations();
    }
    return;
  }

  selectedAnnotationId=hit?.id ?? null;
  updateAnnotationUI();
  renderAnnotations();
});

analysisCanvas.addEventListener("pointermove",e=>{
  if(annotationMode!=="add" || !addStart) return;
  const p=analysisPointerPos(e);
  const x=Math.min(addStart.x,p.x);
  const y=Math.min(addStart.y,p.y);
  addDraft={
    x,
    y,
    w:Math.abs(p.x-addStart.x),
    h:Math.abs(p.y-addStart.y)
  };
  renderAnnotations();
});

function finishAdd(e){
  if(annotationMode!=="add" || !addStart) return;

  const p=analysisPointerPos(e);
  let x=Math.min(addStart.x,p.x);
  let y=Math.min(addStart.y,p.y);
  let w=Math.abs(p.x-addStart.x);
  let h=Math.abs(p.y-addStart.y);

  if(w<8 || h<8){
    const size=Math.max(18,Math.round(Math.min(analysisCanvas.width,analysisCanvas.height)*.055));
    w=size;
    h=size;
    x=Math.max(0,p.x-size/2);
    y=Math.max(0,p.y-size/2);
  }

  x=Math.max(0,Math.min(x,analysisCanvas.width-2));
  y=Math.max(0,Math.min(y,analysisCanvas.height-2));
  w=Math.max(6,Math.min(w,analysisCanvas.width-x));
  h=Math.max(6,Math.min(h,analysisCanvas.height-y));

  const a={
    id:nextAnnotationId++,
    x,y,w,h,
    pixelArea:w*h,
    type:"U",
    source:"manual"
  };

  annotations.push(a);
  selectedAnnotationId=a.id;
  addStart=null;
  addDraft=null;
  annotationMode="select";
  markAnnotationsDirty();
  refreshAnnotationMetrics();
  updateAnnotationUI();
  renderAnnotations();
}

analysisCanvas.addEventListener("pointerup",finishAdd);
analysisCanvas.addEventListener("pointercancel",()=>{
  addStart=null;
  addDraft=null;
  renderAnnotations();
});

function setAnnotationMode(mode){
  annotationMode=mode;
  addStart=null;
  addDraft=null;
  ["toolSelect","toolAdd","toolDelete"].forEach(id=>$(id).classList.remove("active"));
  if(mode==="select") $("toolSelect").classList.add("active");
  if(mode==="add") $("toolAdd").classList.add("active");
  if(mode==="delete") $("toolDelete").classList.add("active");
  updateAnnotationUI();
  renderAnnotations();
}

$("toolSelect").onclick=()=>setAnnotationMode("select");
$("toolAdd").onclick=()=>setAnnotationMode("add");
$("toolDelete").onclick=()=>setAnnotationMode("delete");

document.querySelectorAll(".typeBtn").forEach(btn=>{
  btn.onclick=()=>{
    const a=annotations.find(x=>x.id===selectedAnnotationId);
    if(!a){
      alert("先にscar候補を選択してください。");
      return;
    }
    a.type=btn.dataset.type;
    markAnnotationsDirty();
    refreshAnnotationMetrics();
    updateAnnotationUI();
    renderAnnotations();
  };
});

$("confirmAnnotationsBtn").onclick=()=>{
  if(!analysisReady){
    alert("先に解析してください。");
    return;
  }
  annotationConfirmed=true;
  if(lastMetrics) lastMetrics.annotationReviewed=true;
  updateAnnotationUI();
};

function refreshAnnotationMetrics(){
  if(!lastMetrics || !analysisReady) return;

  const totalArea=annotations.reduce((s,a)=>s+(a.pixelArea ?? a.w*a.h),0);
  lastMetrics.candidates=annotations.length;
  lastMetrics.areaRatio=100*totalArea/(analysisCanvas.width*analysisCanvas.height);
  lastMetrics.avgSize=annotations.length?totalArea/annotations.length:0;
  lastMetrics.components=annotations.map(a=>({
    x:a.x,y:a.y,w:a.w,h:a.h,area:a.pixelArea ?? a.w*a.h,label:a.type,source:a.source
  }));
  lastMetrics.rejectedCount=rejectedAnnotations.length;
  fillMetrics(lastMetrics);
  updateAnnotationUI();
}

function updateAnnotationUI(){
  if(!analysisReady){
    $("annotationPanel").hidden=true;
    return;
  }

  $("annotationPanel").hidden=false;

  const selected=annotations.find(a=>a.id===selectedAnnotationId);
  document.querySelectorAll(".typeBtn").forEach(btn=>{
    btn.disabled=!selected;
    btn.classList.toggle("active",!!selected && btn.dataset.type===selected.type);
  });

  const autoCount=annotations.filter(a=>a.source==="auto").length;
  const manualCount=annotations.filter(a=>a.source==="manual").length;
  $("annotationCounts").innerHTML=`
    <div class="annotationCount"><span>残している候補</span><strong>${annotations.length}</strong></div>
    <div class="annotationCount"><span>自動由来</span><strong>${autoCount}</strong></div>
    <div class="annotationCount"><span>手動追加</span><strong>${manualCount}</strong></div>
    <div class="annotationCount"><span>削除した誤検出</span><strong>${rejectedAnnotations.length}</strong></div>
    <div class="annotationCount"><span>選択中</span><strong>${selected ? `#${selected.id} ${selected.type==="U"?"?":selected.type}` : "なし"}</strong></div>
    <div class="annotationCount"><span>操作</span><strong>${annotationMode==="select"?"選択":annotationMode==="add"?"追加":"削除"}</strong></div>
  `;

  const st=$("annotationStatus");
  if(annotationConfirmed){
    st.className="note goodNote";
    st.innerHTML="<b>修正確定済み</b> — 現在の候補・種類・削除履歴を保存できます。";
  }else{
    st.className="warnBox";
    st.innerHTML="<b>修正未確定</b> — 内容を確認して「この修正を確定」を押してください。";
  }
}

function resetAnnotationState(){
  analysisReady=false;
  annotations=[];
  rejectedAnnotations=[];
  selectedAnnotationId=null;
  annotationMode="select";
  annotationConfirmed=false;
  nextAnnotationId=1;
  addStart=null;
  addDraft=null;
  if($("annotationPanel")) $("annotationPanel").hidden=true;
}

function fillMetrics(m){
  $("mCandidates").textContent=m?m.candidates:"—";
  $("mAreaRatio").textContent=m?m.areaRatio.toFixed(2)+"%":"—";
  $("mTexture").textContent=m?m.texture.toFixed(2):"—";
  $("mAvgSize").textContent=m?m.avgSize.toFixed(1)+" px²":"—";
}

$("analyzeBtn").onclick=analyzeCurrentRegion;

function serializeAnnotation(a,status){
  const W=analysisCanvas.width || 1;
  const H=analysisCanvas.height || 1;
  return {
    id:a.id,
    type:a.type,
    source:a.source,
    status,
    bboxNormalized:{
      x:a.x/W,
      y:a.y/H,
      width:a.w/W,
      height:a.h/H
    },
    centerNormalized:{
      x:(a.x+a.w/2)/W,
      y:(a.y+a.h/2)/H
    }
  };
}

$("saveRegionBtn").onclick=()=>{
  if(!(frontURL||rakingURL)){
    alert("画像を入れてください。");
    return;
  }
  if(!roiConfirmed){
    alert("ROIを確定してください。");
    return;
  }
  if(analysisReady && !annotationConfirmed){
    alert("scar候補の修正を確認し、「この修正を確定」を押してください。");
    return;
  }

  const r=currentRegion();
  state.sessionName=$("sessionName").value;
  state.lightingPreset=$("lightingPreset").value;

  state.regions[r.key]={
    name:r.name,
    topDataUrl:frontURL,
    frontDataUrl:frontURL,
    rakingDataUrl:rakingURL,
    roi:cloneROI(roi),
    roiConfirmed:true,
    overlayDataUrl:analysisReady?analysisCanvas.toDataURL("image/png"):null,
    metrics:lastMetrics,
    annotationSchemaVersion:"0.7-boxes",
    annotationConfirmed:analysisReady?annotationConfirmed:false,
    annotations:analysisReady?annotations.map(a=>serializeAnnotation(a,"accepted")):[],
    rejectedCandidates:analysisReady?rejectedAnnotations.map(a=>serializeAnnotation(a,"rejected")):[]
  };

  buildWizard();
  renderSummary();
  alert(`${r.name} を保存しました。`);
};

function renderSummary(){
  summaryTabs.innerHTML="";
  const keys=Object.keys(state.regions);

  if(!keys.length){
    $("summaryPane").textContent="まだ部位は保存されていません。";
    return;
  }

  keys.forEach((k,i)=>{
    const b=document.createElement("button");
    b.textContent=state.regions[k].name;
    if(i===0)b.classList.add("active");
    b.onclick=()=>{
      [...summaryTabs.children].forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      showSummary(k);
    };
    summaryTabs.appendChild(b);
  });

  showSummary(keys[0]);
}

function showSummary(k){
  const s=state.regions[k];
  const m=s.metrics;
  const accepted=s.annotations?.length ?? 0;
  const rejected=s.rejectedCandidates?.length ?? 0;
  const manual=s.annotations?.filter(a=>a.source==="manual").length ?? 0;

  $("summaryPane").innerHTML=`
    <b>${s.name}</b><br>
    上方光: ${s.topDataUrl||s.frontDataUrl?"あり":"なし"} / 斜光: ${s.rakingDataUrl?"あり":"なし"}<br>
    ROI: ${s.roi?`${Math.round(s.roi.l*100)}–${Math.round(s.roi.r*100)}% × ${Math.round(s.roi.t*100)}–${Math.round(s.roi.b*100)}%`:"—"}<br>
    修正後scar候補: ${accepted}（手動追加 ${manual}） / 誤検出として削除: ${rejected}<br>
    教師データ候補: ${s.annotationConfirmed?"確定済み":"未確定"}<br>
    候補面積率: ${m?m.areaRatio.toFixed(2)+"%":"—"}
  `;
}

$("prevStep").onclick=()=>switchRegion((state.current-1+regions.length)%regions.length);
$("nextStep").onclick=()=>switchRegion((state.current+1)%regions.length);

$("exportBtn").onclick=()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="acne_scar_session_v0_7.json";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};

$("resetBtn").onclick=()=>{
  if(!confirm("セッション全体をリセットしますか？")) return;
  state.current=0;
  state.sessionName="";
  state.lightingPreset="none";
  state.regions={};
  $("sessionName").value="";
  $("lightingPreset").value="none";
  switchRegion(0);
};

window.addEventListener("resize",()=>drawEditor());

if("serviceWorker" in navigator){
  navigator.serviceWorker.register("./sw.js").catch(console.warn);
}

roi=cloneROI(currentRegion().roi);
buildWizard();
updateUI();
