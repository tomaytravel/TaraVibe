import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("c");
const fileInput = document.getElementById("file");
const btnReset = document.getElementById("reset");
const btnPause = document.getElementById("pause");

const ui = {
  aura: document.getElementById("aura"),
  swim: document.getElementById("swim"),
  breath: document.getElementById("breath"),
  conv: document.getElementById("conv"),
  core: document.getElementById("core"),
};

let paused = false;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
camera.position.z = 1;

const quad = new THREE.PlaneGeometry(2, 2);

const uniforms = {
  uTex: { value: null },
  uHasTex: { value: 0.0 },
  uTime: { value: 0.0 },
  uRes: { value: new THREE.Vector2(1, 1) },
  uImgAspect: { value: 1.0 },
  uAura: { value: parseFloat(ui.aura.value) },
  uSwim: { value: parseFloat(ui.swim.value) },
  uBreath: { value: parseFloat(ui.breath.value) },
  uConv: { value: parseFloat(ui.conv.value) },
  uCore: { value: parseFloat(ui.core.value) },
};

const vert = /* glsl */`
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// 셰이더 컨셉:
// - PNG 알파로 본체 마스크
// - 마스크 경계 근처에서 "간섭층(아우라)" 생성 (edge/gradient)
// - 경계는 호흡+유영(노이즈)로 살아있는 접면처럼 움직임
// - 색은 주변(배경)과 간섭하며 경계색이 미세 섭동 (고정색 X)
// - '밝아지는 것은 공간이 아니라 타라(피험자)' → 코어 밝기 uCore 적용
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

  // hash/noise
  float hash(vec2 p){
    p = fract(p*vec2(123.34, 345.45));
    p += dot(p, p+34.345);
    return fract(p.x*p.y);
  }
  float noise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i+vec2(1.0,0.0));
    float c = hash(i+vec2(0.0,1.0));
    float d = hash(i+vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }

  // cheap fbm
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

  // aspect-corrected UV so image fits (contain)
  vec2 containUV(vec2 uv, float imgAspect, float viewAspect){
    vec2 u = uv*2.0-1.0;
    if(viewAspect > imgAspect){
      // view wider
      u.x *= viewAspect/imgAspect;
    }else{
      // view taller
      u.y *= imgAspect/viewAspect;
    }
    return u*0.5+0.5;
  }

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

    // background: deep night with subtle blue/teal noise
    float n0 = fbm(vUv*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
    vec3 bg = vec3(0.02,0.03,0.04);
    bg += vec3(0.02,0.03,0.06) * (n0*0.35);

    // if no texture, show background + gentle center hint
    if(uHasTex < 0.5){
      float vign = smoothstep(1.0, 0.2, length(vUv-0.5));
      bg += vec3(0.01,0.03,0.02) * vign * 0.5;
      gl_FragColor = vec4(bg, 1.0);
      return;
    }

    // sample texture
    vec4 tex = texture2D(uTex, uv);

    // "bitmapped control": UV micro displacement (swim) but keep core stable
    float t = uTime;
    float breath = sin(t*0.7)*0.5+0.5; // 0..1
    float breatheAmt = uBreath * (0.15 + 0.35*breath);

    vec2 p = vUv*vec2(viewAspect,1.0);
    float flow = fbm(p*3.0 + vec2(0.0, t*0.08));
    float flow2 = fbm(p*5.0 + vec2(t*0.06, 0.0));
    vec2 disp = (vec2(flow, flow2)-0.5);

    // reduce displacement at the solid core using alpha as mask
    float a = tex.a;
    float coreMask = smoothstep(0.05, 0.75, a); // 0 outside, 1 inside core
    vec2 uv2 = uv + disp * 0.006 * uSwim * (1.0 - coreMask*0.65) * (0.4 + breatheAmt);

    vec4 tex2 = texture2D(uTex, uv2);
    float a2 = tex2.a;

    // edge estimation from alpha gradient (for aura band)
    // sample small neighborhood
    vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y);
    float aL = texture2D(uTex, uv2 - vec2(px.x,0.0)).a;
    float aR = texture2D(uTex, uv2 + vec2(px.x,0.0)).a;
    float aD = texture2D(uTex, uv2 - vec2(0.0,px.y)).a;
    float aU = texture2D(uTex, uv2 + vec2(0.0,px.y)).a;
    float grad = length(vec2(aR-aL, aU-aD));

    // aura band: stronger near boundary; motion is "breathing + swimming"
    float edge = smoothstep(0.02, 0.12, grad);
    float edgeSoft = smoothstep(0.0, 0.7, edge);

    // density interference: refractive-looking distortion of background near edges
    float dens = fbm(p*4.0 + t*0.12);
    float swimLayer = fbm(p*2.2 + vec2(t*0.03, -t*0.05));

    // boundary "swimming": not flicker; slow, organic
    float swimBreath = 0.6 + 0.4*sin(t*0.45 + swimLayer*6.2831);
    float auraMask = edgeSoft * (0.35 + 0.65*swimBreath) * uAura;

    // Base core color comes from texture RGB; apply convergence toward bright green (but keep identity)
    // Bright green target (not neon)
    vec3 targetGreen = vec3(0.22, 0.95, 0.55);

    // Convert to HSV and gently pull hue toward green zone
    vec3 hsv = rgb2hsv(tex2.rgb);
    float greenHue = 0.33; // ~120deg / 360
    float dh = hsv.x - greenHue;
    dh = (dh > 0.5) ? dh - 1.0 : (dh < -0.5) ? dh + 1.0 : dh;
    hsv.x = fract(hsv.x - dh * (0.15 + 0.55*uConv)); // pull toward green
    hsv.y = clamp(hsv.y + 0.10*uConv, 0.0, 1.0);
    hsv.z = clamp(hsv.z + 0.06*uConv, 0.0, 1.0);
    vec3 coreCol = hsv2rgb(hsv);

    // Key rule: "타라(=피험자)가 밝아진다" — raise brightness on core, not space
    coreCol *= uCore;

    // Aura color: interference with surrounding "energy"
    // Let edge hue vary subtly with local background noise and texture hue (non-fixed boundary color)
    float mixHue = fract(greenHue + (dens-0.5)*0.06 + (hsv.x-greenHue)*0.12);
    vec3 auraHSV = vec3(mixHue, 0.55 + 0.25*uConv, 0.30 + 0.35*uAura);
    vec3 auraCol = hsv2rgb(auraHSV);

    // Create refractive/density feel: sample bg with warped coords near edge
    vec2 warp = disp * 0.03 * auraMask;
    float nbg = fbm((vUv+warp)*vec2(viewAspect,1.0)*2.0 + t*0.02);
    vec3 bg2 = vec3(0.02,0.03,0.04) + vec3(0.02,0.03,0.06)*(nbg*0.35);

    // Compose:
    // - outside: bg2
    // - core: coreCol (alpha a2)
    // - aura: add subtle glow + density (not "expansion")
    float coreA = smoothstep(0.02, 0.35, a2);
    vec3 col = bg2;

    // density layer (no obvious glow)
    col = mix(col, col + auraCol*0.25, auraMask);

    // aura near boundary: add thin bright rim but keep tasteful
    float rim = smoothstep(0.15, 0.65, auraMask) * (0.35 + 0.35*uAura);
    col += auraCol * rim;

    // core overlay
    col = mix(col, coreCol, coreA);

    // soft vignette
    float vign = smoothstep(1.1, 0.35, length(vUv-0.5));
    col *= 0.85 + 0.15*vign;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: vert,
  fragmentShader: frag,
});

const mesh = new THREE.Mesh(quad, material);
scene.add(mesh);

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
window.addEventListener("resize", resize);

function setTexture(tex, imgW, imgH) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  uniforms.uTex.value = tex;
  uniforms.uHasTex.value = 1.0;
  uniforms.uImgAspect.value = imgW / imgH;
}

async function loadDefaultIfExists() {
  // tara.png가 repo에 있으면 자동 로드
  try {
    const res = await fetch("./tara.png", { cache: "no-store" });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    await loadFromURL(url);
    URL.revokeObjectURL(url);
  } catch (_) {}
}

function loadFromFile(file) {
  const url = URL.createObjectURL(file);
  return loadFromURL(url).finally(() => URL.revokeObjectURL(url));
}

function loadFromURL(url) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        // we need actual image size; TextureLoader stores it in tex.image
        const img = tex.image;
        setTexture(tex, img.width || 1024, img.height || 1024);
        resolve();
      },
      undefined,
      reject
    );
  });
}

function hookUI() {
  ui.aura.addEventListener("input", () => (uniforms.uAura.value = parseFloat(ui.aura.value)));
  ui.swim.addEventListener("input", () => (uniforms.uSwim.value = parseFloat(ui.swim.value)));
  ui.breath.addEventListener("input", () => (uniforms.uBreath.value = parseFloat(ui.breath.value)));
  ui.conv.addEventListener("input", () => (uniforms.uConv.value = parseFloat(ui.conv.value)));
  ui.core.addEventListener("input", () => (uniforms.uCore.value = parseFloat(ui.core.value)));

  btnReset.addEventListener("click", () => {
    ui.aura.value = "0.55";
    ui.swim.value = "0.55";
    ui.breath.value = "0.35";
    ui.conv.value = "0.65";
    ui.core.value = "1.12";
    uniforms.uAura.value = 0.55;
    uniforms.uSwim.value = 0.55;
    uniforms.uBreath.value = 0.35;
    uniforms.uConv.value = 0.65;
    uniforms.uCore.value = 1.12;
  });

  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "재생" : "일시정지";
  });

  fileInput.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (f) await loadFromFile(f);
  });

  // drag & drop
  const stage = document.getElementById("stage");
  stage.addEventListener("dragover", (e) => { e.preventDefault(); });
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) await loadFromFile(f);
  });
}

let start = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  if (!paused) {
    uniforms.uTime.value = (now - start) / 1000.0;
  }
  renderer.render(scene, camera);
}

resize();
hookUI();
loadDefaultIfExists();
requestAnimationFrame(animate);
