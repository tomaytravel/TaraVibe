import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

// -------------------------------------------------------------
// 기본 설정 및 변수
const canvas  = document.getElementById("c");
const fileInp = document.getElementById("file");
const btnReset   = document.getElementById("reset");
const btnPause   = document.getElementById("pause");
const btnRestart = document.getElementById("restart");
const ui = {
  aura:  document.getElementById("aura"),
  swim:  document.getElementById("swim"),
  breath:document.getElementById("breath"),
  conv:  document.getElementById("conv"),
  core:  document.getElementById("core")
};

let paused = false;
let start  = performance.now();

// 렌더러, 카메라, 씬
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const camera = new THREE.OrthographicCamera(-1,1,1,-1,0,10);
camera.position.z = 1;
const quad = new THREE.PlaneGeometry(2,2);

// 기본값
const DEFAULTS = {
  aura: 0.75, swim: 0.60, breath: 0.45, conv: 0.70, core: 1.12,
  growSeconds: 8.0, lockStart: 60.0, lockEnd: 62.0,
  convOscCount: 3.0, auraMaxPx: 280.0,
  auraType: 0 // 0 기본/실루엣확장 1 불꽃 2 페이드 3 물방울
};

// 유니폼 설정
const uniforms = {
  uTex:    { value: null },
  uHasTex: { value: 0.0 },
  uTime:   { value: 0.0 },
  uRes:    { value: new THREE.Vector2(1,1) },
  uImgAspect: { value: 1.0 },

  uAura:  { value: DEFAULTS.aura },
  uSwim:  { value: DEFAULTS.swim },
  uBreath:{ value: DEFAULTS.breath },
  uConv:  { value: DEFAULTS.conv },
  uCore:  { value: DEFAULTS.core },

  uGrowDur:     { value: DEFAULTS.growSeconds },
  uLockStart:   { value: DEFAULTS.lockStart },
  uLockEnd:     { value: DEFAULTS.lockEnd },
  uConvOscCount:{ value: DEFAULTS.convOscCount },

  uAuraMaxPx: { value: DEFAULTS.auraMaxPx },
  uAuraType: { value: DEFAULTS.auraType },
  // 불꽃 타입 전용 파라미터
  uFlameHeight: { value: 1.0 },
  uFlameTemp:   { value: 1.0 },
  // 물방울 타입 전용 파라미터
  uDropSpeed: { value: 1.0 },
  uDropSize:  { value: 1.0 },
  uDropDir:   { value: 0 } // 0 radial,1 up,2 left,3 right
};

// 버텍스/프래그먼트 셰이더
const vert = /*glsl*/`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position,1.0);
}`;
const frag = /*glsl*/`
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform float uHasTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uImgAspect;
uniform float uAura, uSwim, uBreath, uConv, uCore;
uniform float uGrowDur, uLockStart, uLockEnd, uConvOscCount;
uniform float uAuraMaxPx;
uniform float uAuraType;
uniform float uFlameHeight, uFlameTemp;
uniform float uDropSpeed, uDropSize, uDropDir;

// --- 다양한 도움 함수 (해시/노이즈/fbm, HSV 변환 등) ---
float hash(vec2 p){
  p = fract(p*vec2(123.34,345.45));
  p += dot(p,p+34.345);
  return fract(p.x*p.y);
}
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  f = f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1.0,0.0));
  float c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<5;i++){
    v += a * noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}
vec2 containUV(vec2 uv, float imgAspect, float viewAspect){
  vec2 u = uv*2.0 - 1.0;
  if(viewAspect>imgAspect) u.x *= viewAspect/imgAspect;
  else u.y *= imgAspect/viewAspect;
  return u*0.5 + 0.5;
}
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0., -1./3., 2./3., -1.);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1e-10;
  return vec3(abs(q.z + (q.w-q.y)/(6.*d+e)), d/(q.x+e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.,2./3.,1./3.,3.);
  vec3 p = abs(fract(c.xxx + K.xyz)*6. - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0., 1.), c.y);
}
float ring(float x, float center, float w){
  float a=smoothstep(center-w, center, x);
  float b=smoothstep(center, center+w, x);
  return a - b;
}

void main(){
  float viewAspect = uRes.x/uRes.y;
  vec2 uv = containUV(vUv, uImgAspect, viewAspect);

  // 배경 노이즈
  float baseNoise = fbm(vUv*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
  vec3 bg = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07) * (baseNoise*0.25);

  if(uHasTex < 0.5){
    gl_FragColor = vec4(bg,1.0);
    return;
  }

  float t  = uTime;
  float grow = clamp(t / max(0.001, uGrowDur), 0.0, 1.0);
  float lockPhase = smoothstep(uLockStart, uLockEnd, t);

  // 감쇠 진동 (3회)
  float p = grow;
  float osc = sin(6.2831853 * uConvOscCount * p);
  float damp = (1.0 - p);
  float oscEnv = osc * damp;
  float convMod = clamp(grow * (0.85 + 0.30*oscEnv), 0.0, 1.0);

  // 샘플 이미지
  vec4 tex0 = texture2D(uTex, uv);
  float a0  = tex0.a;
  float coreMask = smoothstep(0.05, 0.75, a0);

  // 중심 좌표 및 각도/거리
  vec2 c = vUv - vec2(0.5);
  float r = length(c);
  float ang= atan(c.y,c.x);

  // 호흡 및 미세움직임
  float breathBase = 0.6 + 0.4*sin(t*0.6);
  float breathAmt  = uBreath * (0.15 + 0.35*breathBase);
  float breathLock= mix(1.0, 0.0, lockPhase);
  float micro = fbm(vUv*vec2(viewAspect,1.0)*6.0 + vec2(t*0.03, -t*0.02));
  vec2 microDisp = (vec2(micro, fbm(vUv*7.0 + t*0.04)) - 0.5) * 0.0015;
  vec2 uv2 = uv + microDisp * (1.0 - coreMask*0.85) * uSwim * (0.4 + breathAmt) * breathLock;

  vec4 tex = texture2D(uTex, uv2);
  float a  = tex.a;

  // 아우라 최대 픽셀 두께
  float minRes = min(uRes.x, uRes.y);
  float auraMaxPx = min(uAuraMaxPx, minRes*0.60);
  float radius = mix(0.0, auraMaxPx, grow);
  vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y);

  // 가장자리 그라디언트 (단면)
  vec2 eps = vec2(1.5/uRes.x, 1.5/uRes.y);
  float aL = texture2D(uTex, uv2 - vec2(eps.x,0.0)).a;
  float aR = texture2D(uTex, uv2 + vec2(eps.x,0.0)).a;
  float aD = texture2D(uTex, uv2 - vec2(0.0,eps.y)).a;
  float aU = texture2D(uTex, uv2 + vec2(0.0,eps.y)).a;
  float grad = (abs(aR-aL) + (abs(aU-aD)));
  float edge = smoothstep(0.01, 0.06, grad);

  // 경계 지터 및 확장
  float edgeJitA = fbm(vec2(ang*2.0, t*0.25)) - 0.5;
  float edgeShift = edgeJitA * 0.16 * (1.0 - lockPhase);

  // 실루엣 바깥 dilate
  float dil = 0.0;
  const int DIRS = 24;
  const int STEPS= 10;
  for(int i=0;i<DIRS;i++){
    float a2 = float(i)*6.2831853/float(DIRS);
    vec2 dir=vec2(cos(a2), sin(a2));
    float rJ = (fbm(vec2(a2*1.7, t*0.22)) - 0.5);
    float radiusJ = radius * (1.0 + rJ * 0.12 * (1.0 - lockPhase));
    for(int s=1;s<=STEPS;s++){
      float k  = float(s)/float(STEPS);
      float rr = radiusJ * k;
      float w  = 1.0 - k;
      float aa = texture2D(uTex, uv2 + dir*rr*px).a;
      dil = max(dil, aa * (0.35 + 0.65*w));
    }
  }

  // 아우라 영역과 실루엣 거리
  float auraZone = smoothstep(0.02, 0.75, dil) * (1.0 - smoothstep(0.05, 0.98, a));
  float auraZone2 = clamp(auraZone + edge*0.55, 0.0,1.0);
  float silDist   = 1.0 - dil;

  // 전체 아우라 모션
  float swimBreath = 0.6 + 0.4*sin(t*0.45 + fbm(vUv*2.2 + vec2(t*0.03, -t*0.05))*6.2831853);
  float oscAura    = mix(1.0, (0.75 + 0.35*(0.5 + 0.5*oscEnv)), grow);
  float motion     = mix((0.35 + 0.65*swimBreath), 1.0, lockPhase);
  float auraMaskBase= auraZone2 * motion * uAura * oscAura;

  // 라디얼 펄스
  float speed=0.35;
  float freq =12.0;
  float wave =sin((r - t*speed)*freq);
  float wave2=sin((r - t*speed*0.62)*(freq*0.55) + ang*1.2);
  float waveAmp=(0.28 + 0.20*oscEnv) * (1.0 - lockPhase);
  float radialPulse = 1.0 + waveAmp * (0.6*wave + 0.4*wave2);

  // 아우라/림 마스크 초기값
  float auraMask = auraMaskBase;
  float auraRim  = 0.0;

  // ---- 타입별 처리 ----
  if(uAuraType < 0.5){
    // 0: 기본(실루엣 확장형)
    float rimCenter = 0.55;
    float rimOuter = smoothstep(rimCenter-0.06+edgeShift, rimCenter-0.01+edgeShift, silDist)
                   - smoothstep(rimCenter+0.01+edgeShift, rimCenter+0.09+edgeShift, silDist);
    rimOuter = clamp(rimOuter,0.0,1.0);
    float rimW   = 0.75 + 0.25*sin(t*1.1 + ang*3.0 + edgeJitA*6.2831853);
    float rimMot = mix(rimW, 1.0, lockPhase);
    auraRim      = rimOuter * rimMot * uAura;
    auraMask    *= radialPulse;
  }
  else if(uAuraType < 1.5){
    // 1: 불꽃 – 테두리 플룸/찢김으로 변형
    float rimBase = ring(silDist, 0.55 + edgeShift, 0.06);
    float plumeNoise = fbm(vec2(vUv.x*4.0, t*2.5));
    float plume = pow(max(0.0, vUv.y - 0.4), 1.8) * uFlameHeight;
    plume *= (0.5 + plumeNoise);
    float tear = sin(t*6.0 + ang*8.0) * 0.08;
    float flameShape = rimBase * (1.0 + plume + tear);

    auraMask  = auraZone2 * motion * uAura * oscAura;
    auraMask *= (0.6 + plume + tear);

    float temp = clamp(uFlameTemp * (0.6 + plumeNoise), 0.0, 2.0);
    auraRim = flameShape * (0.9 + 0.4*temp);
  }
  else if(uAuraType < 2.5){
    // 2: 페이드 어웨이 – 주기적으로 사라졌다 돌아옴
    float fadeT = max(0.0, t - uGrowDur);
    float cycle = 10.0;
    float ph = fract(fadeT / cycle);
    float fade=1.0;
    fade *= (1.0 - smoothstep(0.25, 0.55, ph));
    fade += smoothstep(0.70, 0.95, ph);
    fade  = mix(clamp(fade, 0.0, 1.0), 1.0, lockPhase);

    float rimOuter = ring(silDist, 0.55 + edgeShift, 0.07);
    float rimW = 0.75 + 0.25*sin(t*1.0 + ang*2.0);
    float rimMot = mix(rimW, 1.0, lockPhase);
    auraRim = clamp(rimOuter * rimMot * uAura, 0.0, 1.0);

    auraMask*=fade;
    auraRim *=fade;
  }
  else {
    // 3: 물방울 – 테두리에서 방출
    auraMask = 0.0;
    float droplets=0.0;
    float rimMask = ring(silDist, 0.55 + edgeShift, 0.04);
    const int N = 12;
    for(int i=0;i<N;i++){
      float fi=float(i);
      float seed=fi*17.123;
      float ang0=fract(sin(seed)*43758.5453)*6.2831853;
      float life=fract((t*0.5*uDropSpeed + fi*0.21));
      float age=life;
      vec2 baseDir;
      if(uDropDir<0.5)      baseDir=vec2(cos(ang0),sin(ang0));
      else if(uDropDir<1.5) baseDir=vec2(0.0,1.0);
      else if(uDropDir<2.5) baseDir=vec2(-1.0,0.0);
      else                  baseDir=vec2(1.0,0.0);
      float dist=0.26 + age*0.45;
      vec2 dc=baseDir*dist;
      float size=mix(0.06,0.01,age)*uDropSize;
      float w   =mix(0.02,0.005,age)*uDropSize;
      float d   =length((vUv-0.5)-dc);
      float ringM = ring(d,size,w);
      float alpha =(1.0 - smoothstep(0.7,1.0,age));
      droplets += ringM * alpha;
    }
    droplets *= rimMask * uAura;
    auraRim = droplets;
  }

  // 굴절(밀도 간섭)
  vec2 dirR = (r>0.0001) ? (c/r) : vec2(0.0);
  float warpAmt=0.026 * auraMask * (1.0 - lockPhase) * radialPulse;
  vec2 warp = dirR * warpAmt;
  float nbg = fbm((vUv+warp)*vec2(viewAspect,1.0)*2.0 + t*0.02);
  vec3 bg2 = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07)*(nbg*0.25);

  // 녹색 수렴
  vec3 hsv = rgb2hsv(tex.rgb);
  float greenHue=0.33;
  float dh = hsv.x-greenHue;
  dh = (dh>0.5)?dh-1.0 : (dh<-0.5)?dh+1.0 : dh;
  float pull=(0.15 + 0.55*(uConv * convMod));
  hsv.x = fract(hsv.x - dh * pull);
  hsv.y = clamp(hsv.y + 0.10*(uConv * convMod), 0.0,1.0);
  hsv.z = clamp(hsv.z + 0.06*(uConv * convMod), 0.0,1.0);
  vec3 coreCol = hsv2rgb(hsv);
  coreCol *= uCore * (1.0 + 0.22*lockPhase);

  // 아우라 색상
  float dens = fbm(vUv*vec2(viewAspect,1.0)*4.0 + t*0.12);
  float mixHue = fract(greenHue + (dens-0.5)*0.06 + (hsv.x-greenHue)*0.12);
  vec3 auraHSV = vec3(mixHue, 0.55 + 0.25*uConv, 0.30 + 0.35*uAura);
  vec3 auraCol = hsv2rgb(auraHSV);
  if(uAuraType>0.5 && uAuraType<1.5){
    // 불꽃 컬러: 온도에 따라 차가운 녹색~뜨거운 붉은색
    float heat=clamp(uFlameTemp,0.5,2.0);
    vec3 hot = vec3(1.0,0.6,0.1);
    vec3 cool= vec3(0.1,1.0,0.4);
    auraCol = mix(cool, hot, heat*0.5);
  }

  // 합성: 배경 → 아우라 필드 → 림 → 본체 → 아우라 가장자리
  float coreA = smoothstep(0.02, 0.35, a);
  vec3 col = bg2;
  col = mix(col, col + auraCol*0.22, auraMask);
  col += auraCol * auraMask * 0.40;
  col += auraCol * auraRim * 0.95;
  col = mix(col, coreCol, coreA);
  col += auraCol * auraMask * (1.0 - a*0.80) * 0.40;
  float vign = smoothstep(1.1, 0.35, length(vUv-0.5));
  col *= 0.88 + 0.12*vign;

  gl_FragColor = vec4(col,1.0);
}
`;

const material = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag });
const mesh = new THREE.Mesh(quad, material);
scene.add(mesh);

// 크기 조정
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
window.addEventListener("resize", resize);

// 텍스처 로딩
function setTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  const img = tex.image;
  uniforms.uTex.value = tex;
  uniforms.uHasTex.value = 1.0;
  uniforms.uImgAspect.value = (img?.width && img?.height) ? (img.width/img.height) : 1.0;
}
function loadTextureFromURL(url, onDone) {
  new THREE.TextureLoader().load(
    url,
    (tex) => { setTexture(tex); onDone?.(true); },
    undefined,
    () => onDone?.(false)
  );
}
function loadDefaultTexture() {
  const url1 = "tara.png";
  const url2 = new URL("tara.png", window.location.href).toString();
  loadTextureFromURL(url1, ok => { if(!ok) loadTextureFromURL(url2,()=>{}); });
}
fileInp?.addEventListener("change", e=>{
  const f = e.target.files?.[0];
  if(!f) return;
  const url = URL.createObjectURL(f);
  loadTextureFromURL(url, ok=>{
    try { URL.revokeObjectURL(url); } catch {}
    if(!ok) console.error("텍스처 로딩 실패");
  });
});

// 드래그앤드롭
const stage = document.getElementById("stage") || document.body;
stage.addEventListener("dragover", e=>e.preventDefault());
stage.addEventListener("drop", e=>{
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if(!f) return;
  const url = URL.createObjectURL(f);
  loadTextureFromURL(url, ok=>{
    try { URL.revokeObjectURL(url); } catch {}
    if(!ok) console.error("드롭 텍스처 실패");
  });
});

// UI 동기화
function applyDefaultsToUI(){
  if(ui.aura) ui.aura.value  = String(DEFAULTS.aura);
  if(ui.swim) ui.swim.value  = String(DEFAULTS.swim);
  if(ui.breath) ui.breath.value=String(DEFAULTS.breath);
  if(ui.conv) ui.conv.value  = String(DEFAULTS.conv);
  if(ui.core) ui.core.value  = String(DEFAULTS.core);
}
function syncUniformsFromUI(){
  if(ui.aura)   uniforms.uAura.value   = Number(ui.aura.value);
  if(ui.swim)   uniforms.uSwim.value   = Number(ui.swim.value);
  if(ui.breath) uniforms.uBreath.value = Number(ui.breath.value);
  if(ui.conv)   uniforms.uConv.value   = Number(ui.conv.value);
  if(ui.core)   uniforms.uCore.value   = Number(ui.core.value);
}
ui.aura?.addEventListener("input", syncUniformsFromUI);
ui.swim?.addEventListener("input", syncUniformsFromUI);
ui.breath?.addEventListener("input", syncUniformsFromUI);
ui.conv?.addEventListener("input", syncUniformsFromUI);
ui.core?.addEventListener("input", syncUniformsFromUI);

// 아우라 타입 버튼
function ensureAuraTypeUI() {
  let box = document.getElementById("auraTypeBox");
  if(!box) {
    box = document.createElement("div");
    box.id = "auraTypeBox";
    box.style.position = "fixed";
    box.style.left = "12px";
    box.style.top  = "12px";
    box.style.zIndex= "9999";
    box.style.display="flex";
    box.style.gap="6px";
    box.style.padding="6px";
    box.style.borderRadius="10px";
    box.style.background="rgba(0,0,0,0.35)";
    document.body.appendChild(box);
  }
  const items = [
    {id:"auraType0", label:"기본형"},
    {id:"auraType1", label:"불꽃형"},
    {id:"auraType2", label:"페이드"},
    {id:"auraType3", label:"물방울"}
  ];
  function mkBtn(item, idx) {
    let b = document.getElementById(item.id);
    if(!b) {
      b = document.createElement("button");
      b.id = item.id;
      b.type = "button";
      b.textContent = item.label;
      b.style.padding="6px 8px";
      b.style.borderRadius="8px";
      b.style.border="1px solid rgba(255,255,255,0.2)";
      b.style.background="rgba(255,255,255,0.08)";
      b.style.color="white";
      b.onclick = ()=>{
        uniforms.uAuraType.value = idx;
        setActive(idx);
      };
      box.appendChild(b);
    }
    return b;
  }
  const btns = items.map((it, idx)=>mkBtn(it, idx));
  function setActive(activeIdx) {
    btns.forEach((b,i)=>{
      const on = i===activeIdx;
      b.style.outline = on ? "2px solid rgba(120,255,180,0.8)" : "none";
      b.style.background= on? "rgba(120,255,180,0.2)" : "rgba(255,255,255,0.08)";
    });
  }
  setActive(Math.round(uniforms.uAuraType.value));
}

// 타입별 슬라이더
function ensureTypeSliders() {
  const box = document.createElement("div");
  box.style.position="fixed";
  box.style.left="12px";
  box.style.bottom="12px";
  box.style.zIndex="9999";
  box.style.background="rgba(0,0,0,0.35)";
  box.style.borderRadius="10px";
  box.style.padding="6px";
  box.style.display="flex";
  box.style.flexDirection="column";
  box.style.gap="4px";
  document.body.appendChild(box);

  function slider(label,min,max,step,key) {
    const w = document.createElement("div");
    w.style.display="flex";
    w.style.alignItems="center";
    w.style.gap="4px";
    const l = document.createElement("div");
    l.textContent = label;
    l.style.fontSize="12px";
    const s = document.createElement("input");
    s.type = "range";
    s.min = min; s.max = max; s.step = step;
    s.value = uniforms[key].value;
    s.oninput = ()=> uniforms[key].value = Number(s.value);
    w.appendChild(l);
    w.appendChild(s);
    box.appendChild(w);
  }
  slider("불꽃 높이",0.5,2.0,0.01,"uFlameHeight");
  slider("불꽃 온도",0.5,2.0,0.01,"uFlameTemp");
  slider("물방울 속도",0.5,3.0,0.01,"uDropSpeed");
  slider("물방울 크기",0.5,2.0,0.01,"uDropSize");
  const sel = document.createElement("select");
  ["방사형","위","좌","우"].forEach((t,i)=>{
    const o=document.createElement("option");
    o.value=i; o.textContent=t;
    sel.appendChild(o);
  });
  sel.onchange = ()=> uniforms.uDropDir.value = Number(sel.value);
  box.appendChild(sel);
}

// 컨트롤 동작
function restartTimeline(){
  start = performance.now();
  uniforms.uTime.value = 0.0;
  paused = false;
  btnPause.textContent = "일시정지";
}
btnRestart?.addEventListener("click", restartTimeline);
btnReset?.addEventListener("click", e=>{
  uniforms.uAura.value   = DEFAULTS.aura;
  uniforms.uSwim.value   = DEFAULTS.swim;
  uniforms.uBreath.value = DEFAULTS.breath;
  uniforms.uConv.value   = DEFAULTS.conv;
  uniforms.uCore.value   = DEFAULTS.core;
  applyDefaultsToUI();
  if(e.shiftKey) restartTimeline();
});
btnPause?.addEventListener("click", ()=>{
  paused = !paused;
  btnPause.textContent = paused ? "재생" : "일시정지";
});

// 렌더링 루프
function animate(now){
  requestAnimationFrame(animate);
  if(!paused){
    uniforms.uTime.value = (now - start) / 1000.0;
  }
  renderer.render(scene, camera);
}

// 초기화
resize();
applyDefaultsToUI();
syncUniformsFromUI();
ensureAuraTypeUI();
ensureTypeSliders();
loadDefaultTexture();
requestAnimationFrame(animate);
