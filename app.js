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
  schemaVersion: "0.8",
  regions: {}
};

const $ = id => document.getElementById(id);
const wizard = $("wizard");
const summaryTabs = $("summaryTabs");
const roiCanvas = $("roiCanvas");
const rctx = roiCanvas.getContext("2d");
const maskCanvas = $("maskCanvas");
const mctx = maskCanvas.getContext("2d");

let frontURL = null;
let rakingURL = null;
let roi = null;
let roiConfirmed = false;
let editorImage = null;
let roiImageRect = null;
let roiDragging = null;

const analysisBaseCanvas = document.createElement("canvas");
const baseCtx = analysisBaseCanvas.getContext("2d", {willReadFrequently:true});
const overlayCanvas = document.createElement("canvas");
const overlayCtx = overlayCanvas.getContext("2d", {willReadFrequently:true});
let maskLabels = null;
let maskW = 0;
let maskH = 0;
let textureRoughness = null;
let analysisImageKind = null;
let maskConfirmed = false;
let maskDirty = false;
let maskTool = "brush";
let maskType = "I";
let brushSize = 18;
let maskOpacity = .45;
let maskUndo = [];
let overlayNeedsBuild = false;
let overlayBuildScheduled = false;

const labelCode = {I:1,B:2,R:3,U:4};
const codeLabel = ["","I","B","R","U"];
const labelRGB = {
  1:[239,68,68],
  2:[16,185,129],
  3:[59,130,246],
  4:[245,158,11]
};

let viewScale = 1;
let minViewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
const activePointers = new Map();
let drawingPointerId = null;
let lastDrawPoint = null;
let panningPointerId = null;
let lastPanPoint = null;
let pinchState = null;

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

async function switchRegion(i){
  state.current = i;
  resetTransientRegion();
  const saved = state.regions[currentRegion().key];
  if(saved){
    frontURL = saved.topDataUrl || saved.frontDataUrl || null;
    rakingURL = saved.rakingDataUrl || null;
    roi = saved.roi ? cloneROI(saved.roi) : cloneROI(currentRegion().roi);
    roiConfirmed = !!saved.roiConfirmed;
  } else {
    roi = cloneROI(currentRegion().roi);
  }
  await updateUI();
  if(saved?.baseCropDataUrl && saved?.maskRLE){
    await restoreSavedMask(saved);
  }
}

function resetTransientRegion(){
  frontURL = null;
  rakingURL = null;
  roiConfirmed = false;
  editorImage = null;
  roiImageRect = null;
  roiDragging = null;
  resetMaskState();
}

function resetMaskState(){
  maskLabels = null;
  maskW = 0;
  maskH = 0;
  textureRoughness = null;
  analysisImageKind = null;
  maskConfirmed = false;
  maskDirty = false;
  maskUndo = [];
  overlayNeedsBuild = false;
  activePointers.clear();
  drawingPointerId = null;
  panningPointerId = null;
  pinchState = null;
  $("maskPanel").hidden = true;
  fillMetrics(null);
  updateMaskStatus();
}

async function updateUI(){
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

  setROIStatus();
  await prepareEditor();
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
  } else {
    rakingURL = url;
    $("rakingPreview").src = url;
    $("rakingSourceStatus").textContent = label;
    if(!frontURL){
      roi = cloneROI(currentRegion().roi);
      roiConfirmed = false;
    }
  }
  resetMaskState();
  setROIStatus();
  await prepareEditor();
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
  if(!src){ editorImage = null; return; }
  editorImage = await loadImage(src);
  drawROIEditor();
}

function resizeROIEditor(){
  const w = Math.max(280,roiCanvas.clientWidth || 320);
  const h = Math.min(560,Math.max(360,Math.round(w*1.15)));
  const dpr = Math.min(devicePixelRatio || 1,2);
  roiCanvas.width = Math.round(w*dpr);
  roiCanvas.height = Math.round(h*dpr);
  roiCanvas.style.height = h+"px";
  rctx.setTransform(dpr,0,0,dpr,0,0);
  return {w,h};
}

function drawROIEditor(){
  if(!editorImage || !roi) return;
  const {w,h} = resizeROIEditor();
  rctx.clearRect(0,0,w,h);
  rctx.fillStyle = "#0b1020";
  rctx.fillRect(0,0,w,h);
  const s = Math.min(w/editorImage.naturalWidth,h/editorImage.naturalHeight);
  const dw = editorImage.naturalWidth*s, dh = editorImage.naturalHeight*s;
  const x=(w-dw)/2, y=(h-dh)/2;
  roiImageRect={x,y,w:dw,h:dh};
  rctx.drawImage(editorImage,x,y,dw,dh);

  const L=x+roi.l*dw,R=x+roi.r*dw,T=y+roi.t*dh,B=y+roi.b*dh;
  rctx.save();
  rctx.fillStyle="rgba(0,0,0,.48)";
  rctx.beginPath();
  rctx.rect(x,y,dw,dh);
  rctx.rect(L,T,R-L,B-T);
  rctx.fill("evenodd");
  rctx.strokeStyle=roiConfirmed?"#10b981":"#f59e0b";
  rctx.lineWidth=3;
  rctx.strokeRect(L,T,R-L,B-T);
  [
    {k:"top",x:(L+R)/2,y:T,label:"上端"},
    {k:"bottom",x:(L+R)/2,y:B,label:"下端"},
    {k:"left",x:L,y:(T+B)/2,label:"左端"},
    {k:"right",x:R,y:(T+B)/2,label:"右端"}
  ].forEach(p=>{
    rctx.fillStyle="#fff";
    rctx.beginPath();rctx.arc(p.x,p.y,12,0,Math.PI*2);rctx.fill();
    rctx.strokeStyle=roiConfirmed?"#10b981":"#f59e0b";rctx.lineWidth=4;rctx.stroke();
    rctx.font="bold 12px system-ui";rctx.textAlign="center";rctx.fillStyle="#fff";
    const yy=p.k==="top"?p.y-18:p.k==="bottom"?p.y+28:p.y-18;
    rctx.fillText(p.label,p.x,yy);
  });
  rctx.restore();
}

function roiPointerPos(e){
  const rect=roiCanvas.getBoundingClientRect();
  return{x:e.clientX-rect.left,y:e.clientY-rect.top};
}

function nearestROIEdge(p){
  if(!roiImageRect) return null;
  const L=roiImageRect.x+roi.l*roiImageRect.w,R=roiImageRect.x+roi.r*roiImageRect.w,T=roiImageRect.y+roi.t*roiImageRect.h,B=roiImageRect.y+roi.b*roiImageRect.h;
  const d=[["top",Math.abs(p.y-T),p.x>=L-30&&p.x<=R+30],["bottom",Math.abs(p.y-B),p.x>=L-30&&p.x<=R+30],["left",Math.abs(p.x-L),p.y>=T-30&&p.y<=B+30],["right",Math.abs(p.x-R),p.y>=T-30&&p.y<=B+30]].filter(v=>v[2]).sort((a,b)=>a[1]-b[1]);
  return d[0]&&d[0][1]<32?d[0][0]:null;
}

roiCanvas.addEventListener("pointerdown",e=>{
  roiDragging=nearestROIEdge(roiPointerPos(e));
  if(roiDragging){
    roiCanvas.setPointerCapture(e.pointerId);
    roiConfirmed=false;
    resetMaskState();
    setROIStatus();
  }
});
roiCanvas.addEventListener("pointermove",e=>{
  if(!roiDragging||!roiImageRect) return;
  const p=roiPointerPos(e),nx=Math.min(1,Math.max(0,(p.x-roiImageRect.x)/roiImageRect.w)),ny=Math.min(1,Math.max(0,(p.y-roiImageRect.y)/roiImageRect.h)),gap=.08;
  if(roiDragging==="left")roi.l=Math.min(nx,roi.r-gap);
  if(roiDragging==="right")roi.r=Math.max(nx,roi.l+gap);
  if(roiDragging==="top")roi.t=Math.min(ny,roi.b-gap);
  if(roiDragging==="bottom")roi.b=Math.max(ny,roi.t+gap);
  drawROIEditor();
});
["pointerup","pointercancel"].forEach(ev=>roiCanvas.addEventListener(ev,()=>roiDragging=null));

$("resetRoiBtn").onclick=()=>{roi=cloneROI(currentRegion().roi);roiConfirmed=false;resetMaskState();setROIStatus();drawROIEditor();};
$("confirmRoiBtn").onclick=()=>{
  if(!(frontURL||rakingURL)){alert("先に画像を選んでください。");return;}
  roiConfirmed=true;setROIStatus();drawROIEditor();
};

function setROIStatus(){
  const el=$("roiStatus");
  if(!(frontURL||rakingURL)){el.textContent="画像を入れるとROI調整ができます";el.className="note";return;}
  if(roiConfirmed){el.innerHTML="<b>ROI確定済み</b> — この範囲をマスク解析します。";el.className="note goodNote";}
  else{el.innerHTML="<b>ROI未確定</b> — 4本の境界線を指で動かしてください。";el.className="warnBox";}
}

function boxBlur(g,w,h,r){
  const tmp=new Float32Array(w*h),out=new Float32Array(w*h),size=2*r+1;
  for(let y=0;y<h;y++){
    let sum=0;
    for(let x=-r;x<=r;x++)sum+=g[y*w+Math.min(w-1,Math.max(0,x))];
    for(let x=0;x<w;x++){
      tmp[y*w+x]=sum/size;
      const rm=x-r,ad=x+r+1;
      if(rm>=0)sum-=g[y*w+rm];
      if(ad<w)sum+=g[y*w+ad];else sum+=g[y*w+w-1];
    }
  }
  for(let x=0;x<w;x++){
    let sum=0;
    for(let y=-r;y<=r;y++)sum+=tmp[Math.min(h-1,Math.max(0,y))*w+x];
    for(let y=0;y<h;y++){
      out[y*w+x]=sum/size;
      const rm=y-r,ad=y+r+1;
      if(rm>=0)sum-=tmp[rm*w+x];
      if(ad<h)sum+=tmp[ad*w+x];else sum+=tmp[(h-1)*w+x];
    }
  }
  return out;
}

function connectedComponents(map,w,h){
  const seen=new Uint8Array(w*h),out=[],dirs=[[1,0],[-1,0],[0,1],[0,-1]];
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const s=y*w+x;if(!map[s]||seen[s])continue;
    const q=[s],pixels=[];seen[s]=1;let minX=x,maxX=x,minY=y,maxY=y;
    while(q.length){
      const cur=q.pop(),cx=cur%w,cy=(cur/w)|0;pixels.push(cur);
      minX=Math.min(minX,cx);maxX=Math.max(maxX,cx);minY=Math.min(minY,cy);maxY=Math.max(maxY,cy);
      for(const[dx,dy]of dirs){const nx=cx+dx,ny=cy+dy,ni=ny*w+nx;if(nx>0&&ny>0&&nx<w-1&&ny<h-1&&map[ni]&&!seen[ni]){seen[ni]=1;q.push(ni);}}
    }
    const area=pixels.length,bw=maxX-minX+1,bh=maxY-minY+1,aspect=Math.max(bw,bh)/Math.max(1,Math.min(bw,bh));
    if(area>=10&&area<=Math.max(900,Math.round(w*h*.025))&&aspect<=5) out.push({pixels,area,bw,bh,aspect});
  }
  return out;
}

function componentType(c){
  if(c.area<38&&c.aspect<1.8)return 1;
  if(c.area>=38&&c.aspect<1.55)return 2;
  return 3;
}

async function analyzeCurrentRegion(){
  const src=rakingURL||frontURL;
  if(!src){alert("上方光または斜光画像を入れてください。");return;}
  if(!roiConfirmed){alert("先にROIを確定してください。");return;}

  if(rakingURL&&frontURL)$("analysisSource").innerHTML="<b>基準:</b> 上方光 / <b>初期マスク生成:</b> 斜光 × 確定ROI";
  else if(rakingURL)$("analysisSource").innerHTML="<b>初期マスク生成:</b> 斜光 × 確定ROI <span class='tiny'>（標準では上方光も推奨）</span>";
  else $("analysisSource").innerHTML="<b>初期マスク生成:</b> 上方光 × 確定ROI";

  const img=await loadImage(src);
  const sx=Math.round(roi.l*img.naturalWidth),sy=Math.round(roi.t*img.naturalHeight),sw=Math.max(10,Math.round((roi.r-roi.l)*img.naturalWidth)),sh=Math.max(10,Math.round((roi.b-roi.t)*img.naturalHeight));
  const scale=Math.min(1,620/sw);
  maskW=Math.max(120,Math.round(sw*scale));
  maskH=Math.max(120,Math.round(sh*scale));
  analysisBaseCanvas.width=maskW;analysisBaseCanvas.height=maskH;
  overlayCanvas.width=maskW;overlayCanvas.height=maskH;
  baseCtx.clearRect(0,0,maskW,maskH);
  baseCtx.drawImage(img,sx,sy,sw,sh,0,0,maskW,maskH);

  const image=baseCtx.getImageData(0,0,maskW,maskH),d=image.data,gray=new Float32Array(maskW*maskH);
  for(let i=0,p=0;i<d.length;i+=4,p++)gray[p]=.299*d[i]+.587*d[i+1]+.114*d[i+2];
  const blur=boxBlur(gray,maskW,maskH,9),map=new Uint8Array(maskW*maskH);
  let tex=0,n=0;
  for(let y=1;y<maskH-1;y++)for(let x=1;x<maskW-1;x++){
    const i=y*maskW+x,local=blur[i]-gray[i],gx=gray[i+1]-gray[i-1],gy=gray[i+maskW]-gray[i-maskW],grad=Math.hypot(gx,gy);
    tex+=Math.abs(local);n++;
    if(local>12&&grad>10)map[i]=1;
  }
  textureRoughness=n?tex/n:0;
  maskLabels=new Uint8Array(maskW*maskH);
  const comps=connectedComponents(map,maskW,maskH);
  comps.forEach(c=>{const code=componentType(c);c.pixels.forEach(p=>maskLabels[p]=code);});
  analysisImageKind=rakingURL?"raking":"top";
  maskConfirmed=false;maskDirty=true;maskUndo=[];
  rebuildOverlay();
  $("maskPanel").hidden=false;
  resizeMaskCanvas();
  fitMaskView();
  updateMaskMetrics();
  updateMaskStatus();
  setTimeout(()=>$("maskPanel").scrollIntoView({behavior:"smooth",block:"start"}),50);
}
$("analyzeBtn").onclick=analyzeCurrentRegion;

function rebuildOverlay(){
  if(!maskLabels||!maskW||!maskH)return;
  const img=overlayCtx.createImageData(maskW,maskH),p=img.data;
  for(let i=0;i<maskLabels.length;i++){
    const code=maskLabels[i];if(!code)continue;
    const [r,g,b]=labelRGB[code],j=i*4;p[j]=r;p[j+1]=g;p[j+2]=b;p[j+3]=255;
  }
  overlayCtx.putImageData(img,0,0);
  overlayNeedsBuild=false;
}

function scheduleOverlayBuild(){
  overlayNeedsBuild=true;
  if(overlayBuildScheduled)return;
  overlayBuildScheduled=true;
  requestAnimationFrame(()=>{
    overlayBuildScheduled=false;
    if(overlayNeedsBuild)rebuildOverlay();
    renderMaskViewer();
  });
}

function resizeMaskCanvas(){
  const rect=maskCanvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  if(!rect.width||!rect.height)return;
  maskCanvas.width=Math.round(rect.width*dpr);maskCanvas.height=Math.round(rect.height*dpr);
  mctx.setTransform(dpr,0,0,dpr,0,0);
  renderMaskViewer();
}

function fitMaskView(){
  if(!maskLabels)return;
  const w=maskCanvas.clientWidth,h=maskCanvas.clientHeight;
  const s=Math.min(w/maskW,h/maskH);
  minViewScale=s;viewScale=s;viewOffsetX=(w-maskW*s)/2;viewOffsetY=(h-maskH*s)/2;
  syncZoomUI();renderMaskViewer();
}

function renderMaskViewer(){
  const w=maskCanvas.clientWidth,h=maskCanvas.clientHeight;if(!w||!h)return;
  mctx.clearRect(0,0,w,h);mctx.fillStyle="#111827";mctx.fillRect(0,0,w,h);
  if(!maskLabels)return;
  mctx.save();mctx.translate(viewOffsetX,viewOffsetY);mctx.scale(viewScale,viewScale);
  mctx.drawImage(analysisBaseCanvas,0,0);
  mctx.globalAlpha=maskOpacity;mctx.drawImage(overlayCanvas,0,0);mctx.globalAlpha=1;
  mctx.restore();
}

function syncZoomUI(){
  const pct=Math.round(viewScale*100);
  $("zoomSlider").value=Math.max(25,Math.min(800,pct));$("zoomOutLabel").textContent=pct;$("hudZoom").textContent=pct+"%";
}

function zoomTo(newScale,cx,cy){
  if(!maskLabels)return;
  newScale=Math.max(minViewScale*.25,Math.min(8,newScale));
  const ix=(cx-viewOffsetX)/viewScale,iy=(cy-viewOffsetY)/viewScale;
  viewScale=newScale;viewOffsetX=cx-ix*newScale;viewOffsetY=cy-iy*newScale;
  syncZoomUI();renderMaskViewer();
}

function maskScreenPoint(e){const r=maskCanvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
function screenToMask(p){return{x:(p.x-viewOffsetX)/viewScale,y:(p.y-viewOffsetY)/viewScale};}

function pushMaskUndo(){
  if(!maskLabels)return;
  maskUndo.push(maskLabels.slice());
  if(maskUndo.length>8)maskUndo.shift();
}

function markMaskChanged(){maskConfirmed=false;maskDirty=true;updateMaskStatus();scheduleOverlayBuild();}

function stampCircle(cx,cy,code){
  const r=Math.max(1,brushSize/2),minX=Math.max(0,Math.floor(cx-r)),maxX=Math.min(maskW-1,Math.ceil(cx+r)),minY=Math.max(0,Math.floor(cy-r)),maxY=Math.min(maskH-1,Math.ceil(cy+r)),rr=r*r;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const dx=x-cx,dy=y-cy;if(dx*dx+dy*dy<=rr)maskLabels[y*maskW+x]=code;}
}

function paintSegment(a,b,code){
  const dist=Math.hypot(b.x-a.x,b.y-a.y),step=Math.max(1,brushSize*.22),n=Math.max(1,Math.ceil(dist/step));
  for(let i=0;i<=n;i++){const t=i/n;stampCircle(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,code);}
}

function beginPinch(){
  if(activePointers.size<2)return;
  const pts=[...activePointers.values()].slice(0,2),dx=pts[1].x-pts[0].x,dy=pts[1].y-pts[0].y,mid={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
  pinchState={startDist:Math.max(10,Math.hypot(dx,dy)),startScale:viewScale,imageX:(mid.x-viewOffsetX)/viewScale,imageY:(mid.y-viewOffsetY)/viewScale};
  drawingPointerId=null;panningPointerId=null;lastDrawPoint=null;lastPanPoint=null;
}

maskCanvas.addEventListener("pointerdown",e=>{
  if(!maskLabels)return;
  const p=maskScreenPoint(e);activePointers.set(e.pointerId,p);maskCanvas.setPointerCapture(e.pointerId);
  if(activePointers.size===2){beginPinch();return;}
  if(activePointers.size>1)return;
  if(maskTool==="pan"){panningPointerId=e.pointerId;lastPanPoint=p;return;}
  pushMaskUndo();drawingPointerId=e.pointerId;lastDrawPoint=screenToMask(p);
  const code=maskTool==="erase"?0:labelCode[maskType];stampCircle(lastDrawPoint.x,lastDrawPoint.y,code);markMaskChanged();
});

maskCanvas.addEventListener("pointermove",e=>{
  if(!maskLabels||!activePointers.has(e.pointerId))return;
  const p=maskScreenPoint(e);activePointers.set(e.pointerId,p);
  if(activePointers.size>=2){
    if(!pinchState)beginPinch();
    const pts=[...activePointers.values()].slice(0,2),dx=pts[1].x-pts[0].x,dy=pts[1].y-pts[0].y,dist=Math.max(10,Math.hypot(dx,dy)),mid={x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
    viewScale=Math.max(minViewScale*.25,Math.min(8,pinchState.startScale*(dist/pinchState.startDist)));
    viewOffsetX=mid.x-pinchState.imageX*viewScale;viewOffsetY=mid.y-pinchState.imageY*viewScale;syncZoomUI();renderMaskViewer();return;
  }
  if(e.pointerId===panningPointerId&&lastPanPoint){viewOffsetX+=p.x-lastPanPoint.x;viewOffsetY+=p.y-lastPanPoint.y;lastPanPoint=p;renderMaskViewer();return;}
  if(e.pointerId===drawingPointerId&&lastDrawPoint){const q=screenToMask(p),code=maskTool==="erase"?0:labelCode[maskType];paintSegment(lastDrawPoint,q,code);lastDrawPoint=q;markMaskChanged();}
});

function endMaskPointer(e){
  activePointers.delete(e.pointerId);
  if(e.pointerId===drawingPointerId){drawingPointerId=null;lastDrawPoint=null;updateMaskMetrics();}
  if(e.pointerId===panningPointerId){panningPointerId=null;lastPanPoint=null;}
  if(activePointers.size<2)pinchState=null;
}
["pointerup","pointercancel"].forEach(ev=>maskCanvas.addEventListener(ev,endMaskPointer));
maskCanvas.addEventListener("wheel",e=>{if(!maskLabels)return;e.preventDefault();const p=maskScreenPoint(e),factor=e.deltaY<0?1.12:.89;zoomTo(viewScale*factor,p.x,p.y);},{passive:false});

function setMaskTool(tool){
  maskTool=tool;$("toolBrush").classList.toggle("active",tool==="brush");$("toolErase").classList.toggle("active",tool==="erase");$("toolPan").classList.toggle("active",tool==="pan");$("hudTool").textContent=tool==="brush"?"Brush":tool==="erase"?"Eraser":"Pan";
}
$("toolBrush").onclick=()=>setMaskTool("brush");$("toolErase").onclick=()=>setMaskTool("erase");$("toolPan").onclick=()=>setMaskTool("pan");
document.querySelectorAll(".typeBtn").forEach(b=>b.onclick=()=>{maskType=b.dataset.type;document.querySelectorAll(".typeBtn").forEach(x=>x.classList.toggle("active",x===b));$("hudType").textContent=maskType;});
$("brushSize").oninput=e=>{brushSize=+e.target.value;$("brushSizeOut").textContent=brushSize;};
$("maskOpacity").oninput=e=>{maskOpacity=+e.target.value/100;$("maskOpacityOut").textContent=e.target.value;renderMaskViewer();};
$("zoomInBtn").onclick=()=>zoomTo(viewScale*1.25,maskCanvas.clientWidth/2,maskCanvas.clientHeight/2);
$("zoomOutBtn").onclick=()=>zoomTo(viewScale/1.25,maskCanvas.clientWidth/2,maskCanvas.clientHeight/2);
$("fitMaskBtn").onclick=fitMaskView;
$("zoomSlider").oninput=e=>zoomTo(+e.target.value/100,maskCanvas.clientWidth/2,maskCanvas.clientHeight/2);
$("undoMaskBtn").onclick=()=>{if(!maskUndo.length)return;maskLabels=maskUndo.pop();markMaskChanged();updateMaskMetrics();};
$("clearMaskBtn").onclick=()=>{if(!maskLabels||!confirm("scar maskを全消去しますか？"))return;pushMaskUndo();maskLabels.fill(0);markMaskChanged();updateMaskMetrics();};

function countMask(){
  const c={I:0,B:0,R:0,U:0,total:0};
  if(!maskLabels)return c;
  for(const v of maskLabels){if(!v)continue;c.total++;c[codeLabel[v]]++;}
  return c;
}
function fillMetrics(m){
  $("mAreaRatio").textContent=m?m.areaRatio.toFixed(2)+"%":"—";$("mTexture").textContent=m?m.texture.toFixed(2):"—";$("mI").textContent=m?m.I:"—";$("mB").textContent=m?m.B:"—";$("mR").textContent=m?m.R:"—";$("mU").textContent=m?m.U:"—";
}
function updateMaskMetrics(){
  if(!maskLabels){fillMetrics(null);return;}
  const c=countMask();fillMetrics({areaRatio:100*c.total/(maskW*maskH),texture:textureRoughness||0,...c});
}
function updateMaskStatus(){
  const el=$("maskStatus"),badge=$("maskDirtyBadge");
  if(!maskLabels){el.textContent="自動マスクを生成すると編集できます。";badge.textContent="未解析";return;}
  if(maskConfirmed){el.innerHTML="<b>マスク確定済み</b> — このpixel-level maskを保存します。";el.className="note goodNote";badge.textContent="確定済み";}
  else{el.innerHTML="<b>マスク未確定</b> — 拡大して塗り/消しを確認してください。";el.className="warnBox";badge.textContent="未確定";}
}
$("confirmMaskBtn").onclick=()=>{if(!maskLabels){alert("先にマスク解析してください。");return;}maskConfirmed=true;maskDirty=false;updateMaskStatus();};

function encodeRLE(arr){
  if(!arr?.length)return[];
  const out=[];let prev=arr[0],count=1;
  for(let i=1;i<arr.length;i++){if(arr[i]===prev)count++;else{out.push(prev,count);prev=arr[i];count=1;}}
  out.push(prev,count);return out;
}
function decodeRLE(rle,length){
  const out=new Uint8Array(length);let p=0;
  for(let i=0;i<rle.length;i+=2){const v=rle[i],n=rle[i+1];out.fill(v,p,Math.min(length,p+n));p+=n;if(p>=length)break;}
  return out;
}

async function restoreSavedMask(saved){
  const im=await loadImage(saved.baseCropDataUrl);
  maskW=saved.maskWidth;maskH=saved.maskHeight;
  analysisBaseCanvas.width=maskW;analysisBaseCanvas.height=maskH;overlayCanvas.width=maskW;overlayCanvas.height=maskH;
  baseCtx.clearRect(0,0,maskW,maskH);baseCtx.drawImage(im,0,0,maskW,maskH);
  maskLabels=decodeRLE(saved.maskRLE,maskW*maskH);textureRoughness=saved.textureRoughness||0;analysisImageKind=saved.analysisImage||"top";maskConfirmed=!!saved.maskConfirmed;maskDirty=false;maskUndo=[];
  rebuildOverlay();$("maskPanel").hidden=false;resizeMaskCanvas();fitMaskView();updateMaskMetrics();updateMaskStatus();
}

$("saveRegionBtn").onclick=()=>{
  if(!(frontURL||rakingURL)){alert("画像を入れてください。");return;}
  if(!roiConfirmed){alert("ROIを確定してください。");return;}
  if(!maskLabels){alert("先にマスク解析してください。");return;}
  if(!maskConfirmed){alert("マスクを確認して『このマスクを確定』を押してください。");return;}
  const r=currentRegion(),counts=countMask();
  state.sessionName=$("sessionName").value;state.lightingPreset=$("lightingPreset").value;
  state.regions[r.key]={
    name:r.name,topDataUrl:frontURL,frontDataUrl:frontURL,rakingDataUrl:rakingURL,roi:cloneROI(roi),roiConfirmed:true,
    analysisImage:analysisImageKind,baseCropDataUrl:analysisBaseCanvas.toDataURL("image/jpeg",.9),maskWidth:maskW,maskHeight:maskH,maskRLE:encodeRLE(maskLabels),maskConfirmed:true,textureRoughness,maskCounts:counts,
    maskAreaRatio:100*counts.total/(maskW*maskH)
  };
  buildWizard();renderSummary();alert(`${r.name} のmaskを保存しました。`);
};

function renderSummary(){
  summaryTabs.innerHTML="";const keys=Object.keys(state.regions);
  if(!keys.length){$("summaryPane").textContent="まだ部位は保存されていません。";return;}
  keys.forEach((k,i)=>{const b=document.createElement("button");b.textContent=state.regions[k].name;if(i===0)b.classList.add("active");b.onclick=()=>{[...summaryTabs.children].forEach(x=>x.classList.remove("active"));b.classList.add("active");showSummary(k);};summaryTabs.appendChild(b);});showSummary(keys[0]);
}
function showSummary(k){
  const s=state.regions[k],c=s.maskCounts||{};$("summaryPane").innerHTML=`<b>${s.name}</b><br>上方光: ${s.topDataUrl?"あり":"なし"} / 斜光: ${s.rakingDataUrl?"あり":"なし"}<br>mask面積率: ${s.maskAreaRatio?.toFixed?.(2)??"—"}%<br>I: ${c.I??0} px / B: ${c.B??0} px / R: ${c.R??0} px / ?: ${c.U??0} px`;
}

$("prevStep").onclick=()=>switchRegion((state.current-1+regions.length)%regions.length);
$("nextStep").onclick=()=>switchRegion((state.current+1)%regions.length);
$("exportBtn").onclick=()=>{
  state.sessionName=$("sessionName").value;state.lightingPreset=$("lightingPreset").value;
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="acne_scar_session_v0_8.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
$("resetBtn").onclick=()=>{
  if(!confirm("セッション全体をリセットしますか？"))return;
  state.current=0;state.sessionName="";state.lightingPreset="none";state.regions={};$("sessionName").value="";$("lightingPreset").value="none";switchRegion(0);
};

window.addEventListener("resize",()=>{drawROIEditor();resizeMaskCanvas();});
if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(console.warn);

roi=cloneROI(currentRegion().roi);
setMaskTool("brush");
$("hudType").textContent=maskType;
buildWizard();
updateUI();
