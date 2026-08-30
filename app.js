import {
  FaceDetector,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm";

const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const refCanvas = $("refCanvas"), rctx = refCanvas.getContext("2d");
const compareCanvas = $("compareCanvas"), cctx = compareCanvas.getContext("2d");

let detector = null;
let stream = null;
let facingMode = "user";
let refImageURL = null;
let captureURL = null;
let refFace = null;
let rafId = null;
let lastDetectAt = 0;
let readyFrames = 0;

const thresholds = {
  center: 0.055,
  size: 0.08,
  rotationDeg: 5.0
};

function setGuide(msg){ $("guide").textContent = msg; }
function cls(el, kind){
  el.classList.remove("good","warn","bad");
  if(kind) el.classList.add(kind);
}

async function initDetector(){
  if(detector) return detector;
  setGuide("顔検出モデルを読み込み中…");
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm"
  );
  detector = await FaceDetector.createFromOptions(vision,{
    baseOptions:{
      modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
    },
    runningMode:"VIDEO",
    minDetectionConfidence:0.55
  });
  return detector;
}

function normalizeFace(det, w, h){
  const b = det.boundingBox;
  const cx = (b.originX + b.width/2)/w;
  const cy = (b.originY + b.height/2)/h;
  const size = Math.sqrt((b.width/w)*(b.height/h));
  const kp = det.keypoints || [];
  let rot = 0;
  if(kp.length >= 2){
    const a=kp[0], b2=kp[1];
    rot = Math.atan2(b2.y-a.y,b2.x-a.x)*180/Math.PI;
  }
  return {cx,cy,size,rot, box:b};
}

function bestDetection(result){
  if(!result?.detections?.length) return null;
  return result.detections.slice().sort((a,b)=>{
    const aa=a.boundingBox.width*a.boundingBox.height;
    const bb=b.boundingBox.width*b.boundingBox.height;
    return bb-aa;
  })[0];
}

function drawBox(face, w, h, good=false){
  if(!face) return;
  const b=face.box;
  octx.save();
  octx.strokeStyle=good ? "#34d399" : "#fbbf24";
  octx.lineWidth=3;
  octx.strokeRect(b.originX,b.originY,b.width,b.height);
  octx.beginPath();
  octx.moveTo(face.cx*w-12,face.cy*h);
  octx.lineTo(face.cx*w+12,face.cy*h);
  octx.moveTo(face.cx*w,face.cy*h-12);
  octx.lineTo(face.cx*w,face.cy*h+12);
  octx.stroke();
  octx.restore();
}

function guideFrom(face){
  if(!refFace || !face) return {ready:false,msg:"顔を検出できません"};
  const dx=face.cx-refFace.cx;
  const dy=face.cy-refFace.cy;
  const sizeRatio=face.size/refFace.size;
  let dr=face.rot-refFace.rot;
  while(dr>180) dr-=360; while(dr<-180) dr+=360;

  const posOK=Math.hypot(dx,dy)<thresholds.center;
  const sizeOK=Math.abs(sizeRatio-1)<thresholds.size;
  const rotOK=Math.abs(dr)<thresholds.rotationDeg;

  $("posStatus").textContent=posOK?"OK":`${dx>0?"←":"→"} ${Math.abs(dx*100).toFixed(1)}% / ${dy>0?"↑":"↓"} ${Math.abs(dy*100).toFixed(1)}%`;
  $("scaleStatus").textContent=sizeOK?"OK":sizeRatio>1?"少し離れる":"少し近づく";
  $("rotStatus").textContent=rotOK?"OK":`${dr>0?"↶":"↷"} ${Math.abs(dr).toFixed(1)}°`;
  cls($("posStatus"),posOK?"good":"warn");
  cls($("scaleStatus"),sizeOK?"good":"warn");
  cls($("rotStatus"),rotOK?"good":"warn");

  const ready=posOK&&sizeOK&&rotOK;
  if(ready) return {ready:true,msg:"位置OK — そのまま撮影できます"};

  if(!sizeOK) return {ready:false,msg:sizeRatio>1?"少しカメラから離れて":"少しカメラに近づいて"};
  if(!posOK){
    const horiz=Math.abs(dx)>Math.abs(dy);
    if(horiz) return {ready:false,msg:dx>0?"顔を少し左へ":"顔を少し右へ"};
    return {ready:false,msg:dy>0?"顔を少し上へ":"顔を少し下へ"};
  }
  return {ready:false,msg:dr>0?"顔の傾きを少し左へ":"顔の傾きを少し右へ"};
}

async function handleReference(file){
  if(!file) return;
  await initDetector();

  if(refImageURL) URL.revokeObjectURL(refImageURL);
  refImageURL=URL.createObjectURL(file);
  $("ghost").src=refImageURL;
  $("refPreview").src=refImageURL;

  const img=new Image();
  img.onload=async()=>{
    const maxW=1000;
    const scale=Math.min(1,maxW/img.naturalWidth);
    refCanvas.width=Math.round(img.naturalWidth*scale);
    refCanvas.height=Math.round(img.naturalHeight*scale);
    rctx.drawImage(img,0,0,refCanvas.width,refCanvas.height);

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm"
    );
    const imageDetector = await FaceDetector.createFromOptions(vision,{
      baseOptions:{
        modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
      },
      runningMode:"IMAGE",
      minDetectionConfidence:0.55
    });
    const res=imageDetector.detect(refCanvas);
    imageDetector.close();

    const d=bestDetection(res);
    if(!d){
      refFace=null;
      setGuide("基準写真から顔を検出できませんでした");
      return;
    }
    refFace=normalizeFace(d,refCanvas.width,refCanvas.height);
    setGuide("基準写真OK。カメラを開始してください");
  };
  img.src=refImageURL;
}

$("refInput").addEventListener("change",e=>handleReference(e.target.files?.[0]));

async function startCamera(){
  await initDetector();
  if(stream) stream.getTracks().forEach(t=>t.stop());
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:{ideal:facingMode},
        width:{ideal:1280},
        height:{ideal:1920}
      }, audio:false
    });
    video.srcObject=stream;
    await video.play();
    $("captureBtn").disabled=false;
    if(rafId) cancelAnimationFrame(rafId);
    loop();
  }catch(e){
    console.error(e);
    setGuide("カメラ権限を許可してください（HTTPSが必要です）");
  }
}
$("startBtn").onclick=startCamera;
$("switchBtn").onclick=async()=>{
  facingMode=facingMode==="user"?"environment":"user";
  await startCamera();
};

function resizeOverlay(){
  const r=$("stage").getBoundingClientRect();
  const dpr=Math.min(devicePixelRatio||1,2);
  overlay.width=Math.floor(r.width*dpr);
  overlay.height=Math.floor(r.height*dpr);
  overlay.style.width=r.width+"px";
  overlay.style.height=r.height+"px";
  octx.setTransform(dpr,0,0,dpr,0,0);
  return {w:r.width,h:r.height};
}

function mapFaceToStage(face){
  const {w,h}=resizeOverlay();
  if(!face || !video.videoWidth) return {face:null,w,h};
  const srcW=video.videoWidth, srcH=video.videoHeight;
  const scale=Math.max(w/srcW,h/srcH);
  const drawW=srcW*scale, drawH=srcH*scale;
  const ox=(w-drawW)/2, oy=(h-drawH)/2;
  const b=face.box;
  const mapped={
    ...face,
    cx: (ox+face.cx*srcW*scale)/w,
    cy: (oy+face.cy*srcH*scale)/h,
    box:{
      originX:ox+b.originX*scale,
      originY:oy+b.originY*scale,
      width:b.width*scale,
      height:b.height*scale
    }
  };
  return {face:mapped,w,h};
}

async function loop(ts=performance.now()){
  rafId=requestAnimationFrame(loop);
  if(!detector || video.readyState<2 || !refFace) return;
  if(ts-lastDetectAt<90) return;
  lastDetectAt=ts;

  const result=detector.detectForVideo(video,ts);
  const d=bestDetection(result);
  const {w,h}=resizeOverlay();
  octx.clearRect(0,0,w,h);

  if(!d){
    $("metrics").textContent="Face: not found";
    setGuide("顔をフレーム内に入れてください");
    readyFrames=0;
    return;
  }
  const raw=normalizeFace(d,video.videoWidth,video.videoHeight);
  const mapped=mapFaceToStage(raw).face;

  const verdict=guideFrom(raw);
  drawBox(mapped,w,h,verdict.ready);

  $("metrics").textContent=
    `x ${(raw.cx*100).toFixed(1)}  y ${(raw.cy*100).toFixed(1)}  size ${(raw.size*100).toFixed(1)}  rot ${raw.rot.toFixed(1)}°`;

  setGuide(verdict.msg);

  if(verdict.ready){
    readyFrames++;
    if(readyFrames>8) $("captureBtn").classList.add("pulse");
  }else{
    readyFrames=0;
    $("captureBtn").classList.remove("pulse");
  }
}

function capture(){
  if(!video.videoWidth) return;
  const c=document.createElement("canvas");
  c.width=video.videoWidth;c.height=video.videoHeight;
  const x=c.getContext("2d");
  if(facingMode==="user"){
    x.translate(c.width,0);x.scale(-1,1);
  }
  x.drawImage(video,0,0);
  c.toBlob(blob=>{
    if(captureURL) URL.revokeObjectURL(captureURL);
    captureURL=URL.createObjectURL(blob);
    $("capturePreview").src=captureURL;
    $("compareBtn").disabled=false;
    setGuide("撮影しました");
  },"image/jpeg",0.95);
}
$("captureBtn").onclick=capture;

$("compareBtn").onclick=()=>{
  if(!refImageURL || !captureURL) return;
  $("compareCanvas").hidden=false;
  const holder=$("compareCanvas").parentElement;
  const w=Math.min(holder.clientWidth,720), h=Math.round(w*4/3);
  compareCanvas.width=w;compareCanvas.height=h;
  const a=new Image(),b=new Image();
  let n=0;
  const done=()=>{
    if(++n<2)return;
    cctx.fillStyle="#111";cctx.fillRect(0,0,w,h);
    const drawCover=(img,alpha)=>{
      const s=Math.max(w/img.naturalWidth,h/img.naturalHeight);
      const dw=img.naturalWidth*s,dh=img.naturalHeight*s;
      cctx.globalAlpha=alpha;
      cctx.drawImage(img,(w-dw)/2,(h-dh)/2,dw,dh);
    };
    drawCover(a,1);drawCover(b,.5);cctx.globalAlpha=1;
  };
  a.onload=done;b.onload=done;a.src=refImageURL;b.src=captureURL;
};

$("ghostOpacity").addEventListener("input",e=>{
  const v=+e.target.value;
  $("ghost").style.opacity=v/100;
  $("ghostOpacityOut").textContent=v+"%";
});

if("serviceWorker" in navigator){
  navigator.serviceWorker.register("./sw.js").catch(console.warn);
}

window.addEventListener("beforeunload",()=>{
  if(stream) stream.getTracks().forEach(t=>t.stop());
});