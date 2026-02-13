import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

/**
 * GREEN TARA – WEB VISUAL TEST (FULL SPEC BUILD)
 *
 * 목표:
 * - GitHub Pages에 올리면 즉시 실행되는 정적 웹
 * - 타라 본체는 알파 PNG (기본 tara.png 자동 로드 + 업로드/드롭 교체)
 * - 아우라: 실루엣(알파) 기반 생성 → 성장(0~8s) → 3회 감쇠 진동 수렴 → 60~62s 정렬(움직임 정지) → 유지
 * - 아우라 두께: 기존 대비 7배(최대 280px, 화면 크기 대비 clamp 완화)
 * - 외곽 테두리: 각도 기반 경계 “일렁거림”이 확실히 보이도록 (radial boundary jitter)
 * - 내부: 구름/연기 flow 느낌 제거 → 중심에서 퍼져나가는 힘(방사 파동 + 방사 굴절)
 * - 밀도 간섭(굴절): 아우라 영역에서 배경 공간이 간섭됨(정렬 후 정지)
 * - 퍼지 색 수렴: HSV 기반 녹색으로 수렴(성장 구간에 강해짐)
 * - UI: reset/pause/restart, 슬라이더(있으면)
 * - 안정성: 기본 이미지 로드 폴백(상대→절대), 로드 실패 로그, 널 가드
 */

// ---------------------- DOM ----------------------
const canvas = document.getElementById("c");
const fileInput = document.getElementById("file");

const btnReset = document.getElementById("reset");     // 파라미터 리셋 (+Shift = 타임라인 리스타트)
const btnPause = document.getElementById("pause");     // 일시정지/재생
const btnRestart = document.getElementById("restart"); // (선택) 타임라인 재시작

// optional sliders (있으면 연결)
const ui = {
  aura: document.getElementById("aura"),
  swim: document.getElementById("swim"),
  breath: document.getElementById("breath"),
  conv: document.getElementById("conv"),
  core: document.getElementById("core"),
};

// stage for drag & drop (optional)
const stage = document.getElementById("stage") || document.body;

// ---------------------- Runtime State ----------------------
let paused = false;
let start = performance.now();

// ---------------------- Renderer/Scene ----------------------
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.debug.checkShaderErrors = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
camera.position.z = 1;

const quad = new THREE.PlaneGeometry(2, 2);

// ---------------------- Defaults (SPEC) ----------------------
const DEFAULTS = {
  // visuals
  aura: 0.75,     // 아우라 강도
  swim: 0.60,     // 유영/거동 강도 (방사 파동과 함께 쓰되 과한 “연기” 방지)
  breath: 0.45,   // 호흡 강도
  conv: 0.70,     // 녹색 수렴 강도
  core: 1.12,     // 타라 본체 밝기 기본

  // timeline
  growSeconds: 8.0,
  lockStart: 60.0,
  lockEnd: 62.0,

  // exact “3 oscillations” during convergence
  convOscCount: 3.0,

  // aura thickness: 7x baseline (40px → 280px)
  auraMaxPx: 280.0,

  // quality knobs
  dirs: 24,
  steps: 10, // 8~14; 높을수록 “필드” 채워짐(성능 비용 증가)
};

// ---------------------- Uniforms ----------------------
const uniforms = {
  uTex: { value: null },
  uHasTex: { value: 0.0 },
  uTime: { value: 0.0 },
  uRes: { value: new THREE.Vector2(1, 1) },
  uImgAspect: { value: 1.0 },

  // tuning
  uAura: { value: DEFAULTS.aura },
  uSwim: { value: DEFAULTS.swim },
  uBreath: { value: DEFAULTS.breath },
  uConv: { value: DEFAULTS.conv },
  uCore: { value: DEFAULTS.core },

  // timeline
  uGrowDur: { value: DEFAULTS.growSeconds },
  uLockStart: { value: DEFAULTS.lockStart },
  uLockEnd: { value: DEFAULTS.lockEnd },
  uConvOscCount: { value: DEFAULTS.convOscCount },

  // aura thickness max px
  uAuraMaxPx: { value: DEFAULTS.auraMaxPx },
};

const vert = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position,1.0);
}
`;

const frag = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uTex;
uniform float uHasTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uImgAspect;

uniform float uAura;
uniform float uSwim;
uniform float uBreath;
uniform float uConv;
uniform float uCore;

uniform float uGrowDur;
uniform float uLockStart;
uniform float uLockEnd;
uniform float uConvOscCount;

uniform float uAuraMaxPx;

// -------- noise --------
float hash(vec2 p){
  p = fract(p*vec2(123.34,345.45));
  p += dot(p,p+34.345);
  return fract(p.x*p.y);
}
float noise(vec2 p){
  vec2 i=floor(p);
  vec2 f=fract(p);
  float a=hash(i);
  float b=hash(i+vec2(1.0,0.0));
  float c=hash(i+vec2(0.0,1.0));
  float d=hash(i+vec2(1.0,1.0));
  vec2 u=f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v=0.0;
  float a=0.5;
  for(int i=0;i<5;i++){
    v += a*noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

// -------- aspect-correct UV (contain) --------
vec2 containUV(vec2 uv, float imgAspect, float viewAspect){
  vec2 u = uv*2.0 - 1.0;
  if(viewAspect > imgAspect){
    u.x *= viewAspect/imgAspect;
  }else{
    u.y *= imgAspect/viewAspect;
  }
  return u*0.5 + 0.5;
}

// -------- RGB <-> HSV --------
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0., -1./3., 2./3., -1.);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1e-10;
  return vec3(abs(q.z + (q.w - q.y)/(6.*d + e)), d/(q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1., 2./3., 1./3., 3.);
  vec3 p = abs(fract(c.xxx + K.xyz)*6. - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0., 1.), c.y);
}

void main(){

  float viewAspect = uRes.x/uRes.y;
  vec2 uv = containUV(vUv, uImgAspect, viewAspect);

  // background (avoid pure black)
  float n0 = fbm(vUv*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
  vec3 bg = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07)*(n0*0.25);

  if(uHasTex < 0.5){
    gl_FragColor = vec4(bg,1.0);
    return;
  }

  float t = uTime;

  // timeline envelopes
  float grow = clamp(t / max(0.001, uGrowDur), 0.0, 1.0);
  float lockPhase = smoothstep(uLockStart, uLockEnd, t);

  // 3-oscillation damped convergence during grow window
  float p = grow;
  float osc = sin(6.2831853 * uConvOscCount * p);
  float damp = (1.0 - p);
  float oscEnv = osc * damp;          // [-.. ..]
  float osc01 = 0.5 + 0.5*oscEnv;     // [~0..1]
  float convMod = clamp(grow * (0.85 + 0.30*oscEnv), 0.0, 1.0);

  // sample base (for alpha)
  vec4 tex0 = texture2D(uTex, uv);
  float a0 = tex0.a;

  // core stability mask: keep inside steadier (reduce motion)
  float coreMask = smoothstep(0.05, 0.75, a0);

  // radial coordinates (screen-space center)
  vec2 c = vUv - vec2(0.5);
  float r = length(c);
  float ang = atan(c.y, c.x);

  // breathing (global), damp after lock
  float breathBase = 0.6 + 0.4*sin(t*0.6);
  float breatheAmt = uBreath * (0.15 + 0.35*breathBase);
  float breathLock = mix(1.0, 0.0, lockPhase); // used to stop some motion

  // texture UV wobble: keep minimal, avoid smoke feel
  // (we keep slight micro variation but clamp heavily)
  float micro = fbm(vUv*vec2(viewAspect,1.0)*6.0 + vec2(t*0.03, -t*0.02));
  vec2 microDisp = (vec2(micro, fbm(vUv*7.0 + t*0.04)) - 0.5) * 0.0015;
  vec2 uv2 = uv + microDisp * (1.0 - coreMask*0.85) * uSwim * (0.4 + breatheAmt) * breathLock;

  vec4 tex = texture2D(uTex, uv2);
  float a = tex.a;

  // -------- Aura thickness (7x) --------
  float minRes = min(uRes.x, uRes.y);
  float auraMaxPx = min(uAuraMaxPx, minRes * 0.60); // clamp relaxed
  float radius = mix(0.0, auraMaxPx, grow);
  vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y);

  // -------- Edge gradient (helps boundary intelligence) --------
  vec2 eps = vec2(1.5/uRes.x, 1.5/uRes.y);
  float aL = texture2D(uTex, uv2 - vec2(eps.x,0.0)).a;
  float aR = texture2D(uTex, uv2 + vec2(eps.x,0.0)).a;
  float aD = texture2D(uTex, uv2 - vec2(0.0,eps.y)).a;
  float aU = texture2D(uTex, uv2 + vec2(0.0,eps.y)).a;
  float grad = (abs(aR-aL) + abs(aU-aD));
  float edge = smoothstep(0.01, 0.06, grad);

  // -------- Thick dilation (disk approximation) --------
  // Key fix: not a single ring; we fill 0..radius with multiple steps → thick aura field
  float dil = 0.0;
  const int DIRS = 24;
  const int STEPS = 10;

  // boundary jitter: angular-based outward/inward movement of the boundary (visible)
  float edgeJit = fbm(vec2(ang*2.0, t*0.25)) - 0.5;   // -0.5..0.5
  float edgeShift = edgeJit * 0.16 * (1.0 - lockPhase); // boundary shift amount

  for(int i=0;i<DIRS;i++){
    float a2 = float(i) * 6.2831853 / float(DIRS);
    vec2 dir = vec2(cos(a2), sin(a2));

    // radius jitter per direction (adds “living” boundary)
    float rJ = (fbm(vec2(a2*1.7, t*0.22)) - 0.5);
    float radiusJ = radius * (1.0 + rJ * 0.12 * (1.0 - lockPhase));

    for(int s=1;s<=STEPS;s++){
      float k = float(s)/float(STEPS);
      float rr = radiusJ * k;
      float w = 1.0 - k; // inside weight
      float aa = texture2D(uTex, uv2 + dir * rr * px).a;
      dil = max(dil, aa * (0.35 + 0.65*w));
    }
  }

  // Aura zone outside silhouette (and not inside core)
  float auraZone = smoothstep(0.02, 0.75, dil) * (1.0 - smoothstep(0.05, 0.98, a));
  float auraZone2 = clamp(auraZone + edge*0.55, 0.0, 1.0);

  // silhouette distance-ish scalar (outer boundary extraction)
  float silDist = 1.0 - dil;

  // -------- Outer rim (explicit boundary band + angular jitter) --------
  // Use silDist + edgeShift so the edge actually “moves”
  float rimCenter = 0.55; // where outer boundary band lives in silDist space
  float rimOuter =
      smoothstep(rimCenter - 0.06 + edgeShift, rimCenter - 0.01 + edgeShift, silDist)
    - smoothstep(rimCenter + 0.01 + edgeShift, rimCenter + 0.09 + edgeShift, silDist);
  rimOuter = clamp(rimOuter, 0.0, 1.0);

  // temporal shimmer on rim (stops on lock)
  float rimW = 0.75 + 0.25*sin(t*1.1 + ang*3.0 + edgeJit*6.2831853);
  float rimMotion = mix(rimW, 1.0, lockPhase);
  float auraRim = rimOuter * rimMotion * uAura;

  // -------- “힘” 표현: radial expansion pulse (from center outward) --------
  // This replaces smoke-like flow with radial waves / pressure
  float speed = 0.35;
  float freq  = 12.0; // lower -> fewer stripes, more “pressure” look
  float wave  = sin((r - t*speed) * freq);
  float wave2 = sin((r - t*speed*0.62) * (freq*0.55) + ang*1.2);

  // damp after lock, also incorporate 3-osc envelope
  float waveAmp = (0.28 + 0.20*oscEnv) * (1.0 - lockPhase);
  float radialPulse = 1.0 + waveAmp * (0.6*wave + 0.4*wave2);

  // motion for aura density: breathe + subtle oscillation, becomes static on lock
  float swimBreath = 0.6 + 0.4*sin(t*0.45 + fbm(vUv*2.2 + vec2(t*0.03, -t*0.05))*6.2831853);
  float oscAura = mix(1.0, (0.75 + 0.35*osc01), grow);
  float motion = mix((0.35 + 0.65*swimBreath), 1.0, lockPhase);

  float auraMask = auraZone2 * motion * uAura * oscAura;

  // -------- Density interference (refractive warp) --------
  // Use radial direction (push outward) instead of sideways flow
  vec2 dirR = (r > 0.0001) ? (c / r) : vec2(0.0);
  float warpAmt = 0.026 * auraMask * (1.0 - lockPhase) * radialPulse;
  vec2 warp = dirR * warpAmt;

  float nbg = fbm((vUv + warp) * vec2(viewAspect,1.0) * 2.0 + t*0.02);
  vec3 bg2 = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07)*(nbg*0.25);

  // -------- Fuzzy convergence to green (HSV) --------
  vec3 hsv = rgb2hsv(tex.rgb);
  float greenHue = 0.33;

  float dh = hsv.x - greenHue;
  dh = (dh > 0.5) ? dh - 1.0 : (dh < -0.5) ? dh + 1.0 : dh;

  float pull = (0.15 + 0.55 * (uConv * convMod));
  hsv.x = fract(hsv.x - dh * pull);
  hsv.y = clamp(hsv.y + 0.10 * (uConv * convMod), 0.0, 1.0);
  hsv.z = clamp(hsv.z + 0.06 * (uConv * convMod), 0.0, 1.0);

  vec3 coreCol = hsv2rgb(hsv);

  // key rule: “타라만 밝아짐” (space not)
  coreCol *= uCore * (1.0 + 0.22*lockPhase);

  // -------- Aura color interference (boundary hue varies) --------
  float dens = fbm(vUv*vec2(viewAspect,1.0)*4.0 + t*0.12);
  float mixHue = fract(greenHue + (dens-0.5)*0.06 + (hsv.x-greenHue)*0.12);
  vec3 auraHSV = vec3(mixHue, 0.55 + 0.25*uConv, 0.30 + 0.35*uAura);
  vec3 auraCol = hsv2rgb(auraHSV);

  // -------- Compose (aura must not be hidden by core) --------
  float coreA = smoothstep(0.02, 0.35, a);

  vec3 col = bg2;

  // density layer
  col = mix(col, col + auraCol*0.22, auraMask);

  // thick field + radialPulse (power outward)
  col += auraCol * auraMask * 0.40 * radialPulse;

  // crisp outer boundary shimmer
  col += auraCol * auraRim * 0.95;

  // core overlay
  col = mix(col, coreCol, coreA);

  // keep aura visible around edges even on top of core (avoid painting deep inside)
  col += auraCol * auraMask * (1.0 - a*0.80) * 0.40;

  // vignette
  float vign = smoothstep(1.1, 0.35, length(vUv - 0.5));
  col *= 0.88 + 0.12*vign;

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------- Material/Mesh ----------------------
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: vert,
  fragmentShader: frag,
});
scene.add(new THREE.Mesh(quad, material));

// ---------------------- Resize ----------------------
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
window.addEventListener("resize", resize);

// ---------------------- Texture Loading ----------------------
function setTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;

  const img = tex.image;
  uniforms.uTex.value = tex;
  uniforms.uHasTex.value = 1.0;
  uniforms.uImgAspect.value = (img?.width && img?.height) ? (img.width / img.height) : 1.0;
}

function loadTextureFromURL(url, onDone) {
  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (tex) => {
      setTexture(tex);
      onDone?.(true);
    },
    undefined,
    (err) => {
      console.warn("Texture load failed:", url, err);
      onDone?.(false);
    }
  );
}

// Robust default load: relative → absolute
function loadDefaultTexture() {
  const url1 = "tara.png";
  const url2 = new URL("tara.png", window.location.href).toString();
  loadTextureFromURL(url1, (ok) => {
    if (!ok) loadTextureFromURL(url2);
  });
}

// Upload
fileInput?.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadTextureFromURL(url, (ok) => {
    try { URL.revokeObjectURL(url); } catch {}
    if (!ok) console.error("Upload texture failed");
  });
});

// Drag & drop
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadTextureFromURL(url, (ok) => {
    try { URL.revokeObjectURL(url); } catch {}
    if (!ok) console.error("Drop texture failed");
  });
});

// ---------------------- UI Wiring ----------------------
function applyDefaultsToUI() {
  if (ui.aura) ui.aura.value = String(DEFAULTS.aura);
  if (ui.swim) ui.swim.value = String(DEFAULTS.swim);
  if (ui.breath) ui.breath.value = String(DEFAULTS.breath);
  if (ui.conv) ui.conv.value = String(DEFAULTS.conv);
  if (ui.core) ui.core.value = String(DEFAULTS.core);
}

function syncUniformsFromUI() {
  if (ui.aura) uniforms.uAura.value = Number(ui.aura.value);
  if (ui.swim) uniforms.uSwim.value = Number(ui.swim.value);
  if (ui.breath) uniforms.uBreath.value = Number(ui.breath.value);
  if (ui.conv) uniforms.uConv.value = Number(ui.conv.value);
  if (ui.core) uniforms.uCore.value = Number(ui.core.value);
}

ui.aura?.addEventListener("input", syncUniformsFromUI);
ui.swim?.addEventListener("input", syncUniformsFromUI);
ui.breath?.addEventListener("input", syncUniformsFromUI);
ui.conv?.addEventListener("input", syncUniformsFromUI);
ui.core?.addEventListener("input", syncUniformsFromUI);

// ---------------------- Controls: Reset / Restart / Pause ----------------------
function restartTimeline() {
  start = performance.now();
  uniforms.uTime.value = 0.0;
  paused = false;
  if (btnPause) btnPause.textContent = "일시정지";
}

btnRestart?.addEventListener("click", restartTimeline);

// Reset: parameters; SHIFT+Reset = timeline restart
btnReset?.addEventListener("click", (e) => {
  uniforms.uAura.value = DEFAULTS.aura;
  uniforms.uSwim.value = DEFAULTS.swim;
  uniforms.uBreath.value = DEFAULTS.breath;
  uniforms.uConv.value = DEFAULTS.conv;
  uniforms.uCore.value = DEFAULTS.core;

  applyDefaultsToUI();

  if (e.shiftKey) restartTimeline();
});

btnPause?.addEventListener("click", () => {
  paused = !paused;
  if (btnPause) btnPause.textContent = paused ? "재생" : "일시정지";
});

// ---------------------- Render Loop ----------------------
function animate(now) {
  requestAnimationFrame(animate);

  if (!paused) {
    uniforms.uTime.value = (now - start) / 1000.0;
  }

  renderer.render(scene, camera);
}

// ---------------------- Init ----------------------
resize();
applyDefaultsToUI();
syncUniformsFromUI();
loadDefaultTexture();
requestAnimationFrame(animate);
