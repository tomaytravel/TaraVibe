import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

/**
 * GREEN TARA WEB VISUAL TEST (SPEC-COMPLETE)
 * - PNG(알파) 타라 본체
 * - 아우라: 알파 윤곽 기반 생성(확장) + 유영/호흡 + 밀도간섭(굴절) + 색 간섭
 * - 퍼지 수렴: HSV 기반 녹색 중심으로 수렴
 * - 진동 수 3회 수렴: 성장 구간(0~8s) 동안 감쇠 진동 3회로 수렴 강도/리듬 형성
 * - 정렬(60s): 아우라 “사라짐”이 아니라 “움직임 정지”, 타라만 밝아짐
 * - GitHub Pages: 정적 파일로 즉시 실행
 */

const canvas = document.getElementById("c");
const fileInput = document.getElementById("file");
const btnReset = document.getElementById("reset");   // 파라미터 리셋
const btnPause = document.getElementById("pause");   // 일시정지
const btnRestart = document.getElementById("restart"); // (선택) 타임라인 재시작 버튼

// UI sliders (있으면 연결, 없으면 기본값만 사용)
const ui = {
  aura: document.getElementById("aura"),
  swim: document.getElementById("swim"),
  breath: document.getElementById("breath"),
  conv: document.getElementById("conv"),
  core: document.getElementById("core"),
};

let paused = false;
let start = performance.now();

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

// Defaults (match earlier UI-oriented version)
const DEFAULTS = {
  aura: 0.55,
  swim: 0.55,
  breath: 0.35,
  conv: 0.65,
  core: 1.12,
  // timings
  growSeconds: 8.0,
  lockStart: 60.0,
  lockEnd: 62.0,
  // convergence oscillation count (exactly 3)
  convOscCount: 3.0,
};

const uniforms = {
  uTex: { value: null },
  uHasTex: { value: 0.0 },
  uTime: { value: 0.0 },
  uRes: { value: new THREE.Vector2(1, 1) },
  uImgAspect: { value: 1.0 },

  // user-tunable
  uAura: { value: DEFAULTS.aura },
  uSwim: { value: DEFAULTS.swim },
  uBreath: { value: DEFAULTS.breath },
  uConv: { value: DEFAULTS.conv },
  uCore: { value: DEFAULTS.core },

  // timeline controls
  uGrowDur: { value: DEFAULTS.growSeconds },
  uLockStart: { value: DEFAULTS.lockStart },
  uLockEnd: { value: DEFAULTS.lockEnd },

  // exact “3 oscillations” during convergence window
  uConvOscCount: { value: DEFAULTS.convOscCount },
};

const vert = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const frag = /* glsl */`
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

// ---------- noise ----------
float hash(vec2 p){
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float noise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f*f*(3.0 - 2.0*f);
  return mix(a, b, u.x) + (c - a)*u.y*(1.0 - u.x) + (d - b)*u.x*u.y;
}

float fbm(vec2 p){
  float v = 0.0;
  float a = 0.5;
  for(int i=0;i<5;i++){
    v += a * noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

// ---------- aspect-correct UV (contain) ----------
vec2 containUV(vec2 uv, float imgAspect, float viewAspect){
  vec2 u = uv*2.0 - 1.0;
  if(viewAspect > imgAspect){
    u.x *= viewAspect / imgAspect;
  }else{
    u.y *= imgAspect / viewAspect;
  }
  return u*0.5 + 0.5;
}

// ---------- RGB <-> HSV ----------
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y)/(6.0*d + e)), d/(q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz)*6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main(){
  float viewAspect = uRes.x / uRes.y;
  vec2 uv = containUV(vUv, uImgAspect, viewAspect);

  // ---- background (avoid pure black) ----
  float n0 = fbm(vUv*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
  vec3 bg = vec3(0.03, 0.04, 0.06) + vec3(0.02, 0.04, 0.07)*(n0*0.25);

  if(uHasTex < 0.5){
    gl_FragColor = vec4(bg, 1.0);
    return;
  }

  // ---- timeline ----
  float t = uTime;

  // grow 0..1 over uGrowDur
  float grow = clamp(t / max(0.001, uGrowDur), 0.0, 1.0);

  // lockPhase 0..1 over [uLockStart, uLockEnd]
  float lockPhase = smoothstep(uLockStart, uLockEnd, t);

  // ---- 3 oscillations convergence envelope (during grow window) ----
  // This creates “three damped waves” while converging.
  // phase: 0..1 in grow window
  float p = clamp(t / max(0.001, uGrowDur), 0.0, 1.0);
  // 3 oscillations -> sin(2π * 3 * p)
  float osc = sin(6.2831853 * uConvOscCount * p);
  // damped (strong early, vanishes near end)
  float damp = (1.0 - p);
  float oscEnv = osc * damp;
  // convert to 0..1-ish modulation
  float osc01 = 0.5 + 0.5 * oscEnv;

  // This modulates convergence + aura rhythm (subtle, not flicker):
  float convMod = clamp(grow * (0.85 + 0.30*(oscEnv)), 0.0, 1.0);

  // ---- sample texture ----
  vec4 tex0 = texture2D(uTex, uv);
  float a0 = tex0.a;

  // ---- core stability mask (keep inside steadier) ----
  float coreMask = smoothstep(0.05, 0.75, a0); // 0 outside -> 1 inside

  // ---- swim/breath fields (but lock stops motion) ----
  vec2 pUv = vUv * vec2(viewAspect, 1.0);
  float flow1 = fbm(pUv*3.0 + vec2(0.0, t*0.08));
  float flow2 = fbm(pUv*5.0 + vec2(t*0.06, 0.0));
  vec2 disp = (vec2(flow1, flow2) - 0.5);

  float breath = 0.6 + 0.4*sin(t*0.6);
  float breatheAmt = uBreath * (0.15 + 0.35*breath);

  // swim displacement reduced in core
  vec2 uv2 = uv + disp * 0.006 * uSwim * (1.0 - coreMask*0.70) * (0.4 + breatheAmt) * (1.0 - lockPhase);

  vec4 tex = texture2D(uTex, uv2);
  float a = tex.a;

  // ---- aura thickness 7x (40px -> 280px), but clamp to viewport size ----
  float minRes = min(uRes.x, uRes.y);
  float auraMaxPx = min(280.0, minRes * 0.28); // safety clamp
  float radius = mix(0.0, auraMaxPx, grow);

  vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y);

  // ---- dilate: silhouette expansion band ----
  float dil = 0.0;
  // 24 directions for smoother thick aura
  for(int i=0;i<24;i++){
    float ang = float(i) * 6.2831853 / 24.0;
    vec2 dir = vec2(cos(ang), sin(ang));
    dil = max(dil, texture2D(uTex, uv2 + dir * radius * px).a);
  }

  // ---- edge gradient for crisp boundary intelligence (restore “1:1” richness) ----
  vec2 eps = vec2(1.5/uRes.x, 1.5/uRes.y);
  float aL = texture2D(uTex, uv2 - vec2(eps.x,0.0)).a;
  float aR = texture2D(uTex, uv2 + vec2(eps.x,0.0)).a;
  float aD = texture2D(uTex, uv2 - vec2(0.0,eps.y)).a;
  float aU = texture2D(uTex, uv2 + vec2(0.0,eps.y)).a;
  float grad = (abs(aR - aL) + abs(aU - aD));
  float edge = smoothstep(0.01, 0.06, grad);

  // aura zone: outside band around silhouette (dilate) + edge intelligence
  float auraZone = smoothstep(0.0, 0.60, dil) * (1.0 - smoothstep(0.02, 0.95, a));
  float auraZone2 = clamp(auraZone + edge*0.65, 0.0, 1.0);

  // ---- aura motion: “breath + swim” but not directional push ----
  float swimLayer = fbm(pUv*2.2 + vec2(t*0.03, -t*0.05));
  float swimBreath = 0.6 + 0.4*sin(t*0.45 + swimLayer*6.2831853);

  // incorporate 3-osc convergence subtly into aura presence (during grow)
  float oscAura = mix(1.0, (0.75 + 0.35*osc01), grow); // only meaningful while growing

  // motion stops at lock (becomes 1.0)
  float motion = mix((0.35 + 0.65*swimBreath), 1.0, lockPhase);

  float auraMask = auraZone2 * motion * uAura * oscAura;

  // ---- density interference: refractive background warp near aura (restored) ----
  vec2 warp = disp * 0.030 * auraMask * (1.0 - lockPhase);
  float nbg = fbm((vUv + warp)*vec2(viewAspect,1.0)*2.0 + t*0.02);
  vec3 bg2 = vec3(0.03, 0.04, 0.06) + vec3(0.02, 0.04, 0.07)*(nbg*0.25);

  // ---- fuzzy convergence to green in HSV (restored) ----
  vec3 hsv = rgb2hsv(tex.rgb);
  float greenHue = 0.33;

  float dh = hsv.x - greenHue;
  dh = (dh > 0.5) ? dh - 1.0 : (dh < -0.5) ? dh + 1.0 : dh;

  float pull = (0.15 + 0.55 * (uConv * convMod));   // convergence strength
  hsv.x = fract(hsv.x - dh * pull);
  hsv.y = clamp(hsv.y + 0.10 * (uConv * convMod), 0.0, 1.0);
  hsv.z = clamp(hsv.z + 0.06 * (uConv * convMod), 0.0, 1.0);

  vec3 coreCol = hsv2rgb(hsv);

  // key rule: “타라(피험자)만 밝아짐” (space not)
  coreCol *= uCore * (1.0 + 0.22 * lockPhase);

  // ---- aura color: interference (boundary hue varies with surrounding energy) ----
  // boundary hue jitter depends on background & local field (non-fixed boundary color)
  float dens = fbm(pUv*4.0 + t*0.12);
  float mixHue = fract(greenHue + (dens-0.5)*0.06 + (hsv.x-greenHue)*0.12);
  vec3 auraHSV = vec3(mixHue, 0.55 + 0.25*uConv, 0.30 + 0.35*uAura);
  vec3 auraCol = hsv2rgb(auraHSV);

  // ---- compose (restored order so aura isn't hidden by core) ----
  float coreA = smoothstep(0.02, 0.35, a);
  vec3 col = bg2;

  // density layer (subtle)
  col = mix(col, col + auraCol*0.25, auraMask);

  // thin rim + thick field (kept tasteful even at 7x thickness)
  float rim = smoothstep(0.15, 0.75, auraMask) * (0.25 + 0.35*uAura);
  col += auraCol * rim;

  // core overlay
  col = mix(col, coreCol, coreA);

  // keep aura visible near edges even over core (but avoid painting inside core)
  col += auraCol * auraMask * (1.0 - a*0.80) * 0.35;

  // vignette
  float vign = smoothstep(1.1, 0.35, length(vUv - 0.5));
  col *= 0.88 + 0.12*vign;

  gl_FragColor = vec4(col, 1.0);
}
`;

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: vert,
  fragmentShader: frag,
});
scene.add(new THREE.Mesh(quad, material));

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
window.addEventListener("resize", resize);

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

// ---- robust default loading for GitHub Pages ----
function loadDefaultTexture() {
  // Try relative first
  const url1 = "tara.png";
  const url2 = new URL("tara.png", window.location.href).toString();

  const loader = new THREE.TextureLoader();
  loader.load(
    url1,
    (tex) => setTexture(tex),
    undefined,
    () => {
      // fallback absolute-resolved
      loader.load(
        url2,
        (tex) => setTexture(tex),
        undefined,
        (err) => console.warn("tara.png auto-load failed:", err)
      );
    }
  );
}

// ---- upload + drag&drop ----
fileInput?.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  new THREE.TextureLoader().load(
    url,
    (tex) => {
      setTexture(tex);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => console.error("texture load error", err)
  );
});

const stage = document.getElementById("stage") || document.body;
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  new THREE.TextureLoader().load(
    url,
    (tex) => {
      setTexture(tex);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => console.error("drop load error", err)
  );
});

// ---- UI wiring ----
function applyDefaultsToUI() {
  if (ui.aura) ui.aura.value = String(DEFAULTS.aura);
  if (ui.swim) ui.swim.value = String(DEFAULTS.swim);
  if (ui.breath) ui.breath.value = String(DEFAULTS.breath);
  if (ui.conv) ui.conv.value = String(DEFAULTS.conv);
  if (ui.core) ui.core.value = String(DEFAULTS.core);
}

function syncUniformsFromUI() {
  if (ui.aura) uniforms.uAura.value = parseFloat(ui.aura.value);
  if (ui.swim) uniforms.uSwim.value = parseFloat(ui.swim.value);
  if (ui.breath) uniforms.uBreath.value = parseFloat(ui.breath.value);
  if (ui.conv) uniforms.uConv.value = parseFloat(ui.conv.value);
  if (ui.core) uniforms.uCore.value = parseFloat(ui.core.value);
}

ui.aura?.addEventListener("input", syncUniformsFromUI);
ui.swim?.addEventListener("input", syncUniformsFromUI);
ui.breath?.addEventListener("input", syncUniformsFromUI);
ui.conv?.addEventListener("input", syncUniformsFromUI);
ui.core?.addEventListener("input", syncUniformsFromUI);

// ---- buttons ----
btnReset?.addEventListener("click", () => {
  // parameter reset (keeps time)
  uniforms.uAura.value = DEFAULTS.aura;
  uniforms.uSwim.value = DEFAULTS.swim;
  uniforms.uBreath.value = DEFAULTS.breath;
  uniforms.uConv.value = DEFAULTS.conv;
  uniforms.uCore.value = DEFAULTS.core;
  applyDefaultsToUI();
});

btnPause?.addEventListener("click", () => {
  paused = !paused;
  if (btnPause) btnPause.textContent = paused ? "재생" : "일시정지";
});

// Timeline restart (preferred for observing growth repeatedly)
function restartTimeline() {
  start = performance.now();
  uniforms.uTime.value = 0.0;
  paused = false;
  if (btnPause) btnPause.textContent = "일시정지";
}

btnRestart?.addEventListener("click", restartTimeline);

// If restart button doesn’t exist, make reset do timeline restart when SHIFT is held
btnReset?.addEventListener("click", (e) => {
  if (e.shiftKey) restartTimeline();
});

// ---- render loop ----
function animate(now) {
  requestAnimationFrame(animate);

  if (!paused) {
    uniforms.uTime.value = (now - start) / 1000.0;
  }

  renderer.render(scene, camera);
}

// init
resize();
applyDefaultsToUI();
syncUniformsFromUI();
loadDefaultTexture();
requestAnimationFrame(animate);
