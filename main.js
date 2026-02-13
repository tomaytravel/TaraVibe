import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("c");
const fileInput = document.getElementById("file");
const btnReset = document.getElementById("reset");
const btnPause = document.getElementById("pause");

let paused = false;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.debug.checkShaderErrors = true; // 셰이더 에러 콘솔에 확실히

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

  // 자동 성장 + 정렬
  uGrow: { value: 0.0 },

  // 강도(리셋/튜닝용)
  uAura: { value: 0.65 },
  uCore: { value: 1.12 },
};

const vert = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position,1.0);
}
`;

const frag = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform float uHasTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uImgAspect;

uniform float uGrow;
uniform float uAura;
uniform float uCore;

float hash(vec2 p){
  p = fract(p*vec2(123.34,345.45));
  p += dot(p,p+34.345);
  return fract(p.x*p.y);
}
float noise(vec2 p){
  vec2 i=floor(p);
  vec2 f=fract(p);
  float a=hash(i);
  float b=hash(i+vec2(1,0));
  float c=hash(i+vec2(0,1));
  float d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.0-2.0*f);
  return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v=0.0;
  float a=0.5;
  for(int i=0;i<5;i++){
    v+=a*noise(p);
    p*=2.02;
    a*=0.5;
  }
  return v;
}

vec2 containUV(vec2 uv,float imgAspect,float viewAspect){
  vec2 u=uv*2.0-1.0;
  if(viewAspect>imgAspect){
    u.x*=viewAspect/imgAspect;
  }else{
    u.y*=imgAspect/viewAspect;
  }
  return u*0.5+0.5;
}

// RGB <-> HSV
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

  float viewAspect=uRes.x/uRes.y;
  vec2 uv=containUV(vUv,uImgAspect,viewAspect);

  // 배경(너무 검게만 보이지 않게 약간 올림)
  float n0 = fbm(vUv*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
  vec3 bg = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07)*(n0*0.25);

  if(uHasTex<0.5){
    gl_FragColor=vec4(bg,1.);
    return;
  }

  vec4 tex = texture2D(uTex, uv);
  float a = tex.a;

  // ===== 타임라인 =====
  // 성장: 0~8초
  float grow = clamp(uGrow, 0.0, 1.0);

  // 아우라 유영 유지: 8~60초 동안 계속
  // 정렬(움직임 정지) 진입: 60~62초
  float lockPhase = smoothstep(60.0, 62.0, uTime); // 0..1
  // lockPhase=1이면 "정지" 상태

  vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y);

  // ===== 1) 아우라 영역: 알파 윤곽 기반 dilate(성장) =====
  float radius = mix(0.0, 14.0, grow);

  float dil = 0.0;
  // 16방향 샘플 (윤곽 확장)
  for(int i=0;i<16;i++){
    float ang = float(i)*6.2831853/16.0;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 off = dir * radius * px;
    dil = max(dil, texture2D(uTex, uv + off).a);
  }

  // 윤곽 밖에만 아우라가 생기도록 (a가 높으면 제외)
  float auraZone = smoothstep(0.001, 0.25, dil) * (1.0 - smoothstep(0.02, 0.95, a));

  // ===== 2) 유영 + 호흡 (정렬되면 움직임만 정지) =====
  float swim = fbm(vUv*3.0 + uTime*0.15);
  float breath = 0.6 + 0.4*sin(uTime*0.6);

  // 움직임 인자: lockPhase가 1로 갈수록 1.0(정지)로 수렴
  float motion = mix((0.4+0.6*swim)*breath, 1.0, lockPhase);

  float auraMask = auraZone * motion * uAura;

  // ===== 3) 밀도 간섭(굴절): 정렬되면 굴절도 정지 =====
  vec2 warp = (vec2(swim, breath) - 0.5) * 0.012 * auraMask * (1.0 - lockPhase);
  float n1 = fbm((vUv + warp)*vec2(viewAspect,1.0)*2.0 + uTime*0.02);
  vec3 bg2 = vec3(0.03,0.04,0.06) + vec3(0.02,0.04,0.07)*(n1*0.25);

  // ===== 4) 퍼지 색 수렴: grow에 따라 녹색으로 점진 수렴 =====
  vec3 hsv = rgb2hsv(tex.rgb);
  float greenHue = 0.33;
  float dh = hsv.x - greenHue;
  if(dh > 0.5) dh -= 1.0;
  if(dh < -0.5) dh += 1.0;

  hsv.x = fract(hsv.x - dh*(0.15 + 0.6*grow));
  hsv.y = clamp(hsv.y + 0.20*grow, 0.0, 1.0);
  hsv.z = clamp(hsv.z + 0.10*grow, 0.0, 1.0);

  vec3 core = hsv2rgb(hsv);

  // ===== 5) 정렬 순간: 타라 본체만 밝아짐 (공간 아님) =====
  core *= uCore * (1.0 + 0.22*lockPhase);

  // ===== 6) 아우라 색: 간섭 + 미세 섭동 =====
  vec3 baseGreen = vec3(0.22, 0.95, 0.55);
  // 경계에서 주변 에너지(노이즈)에 따라 약간 흔들리게
  float hueJit = (swim - 0.5) * 0.08;
  vec3 auraHSV = vec3(fract(greenHue + hueJit), 0.65, 0.45);
  vec3 auraCol = hsv2rgb(auraHSV);
  auraCol = mix(auraCol, baseGreen, 0.6);

  // ===== 합성: 코어에 아우라가 "가려지지 않게" 순서 수정 =====
  vec3 col = bg2;

  // 먼저 코어를 깔고
  col = mix(col, core, smoothstep(0.01, 0.35, a));

  // 그 다음 아우라를 더한다 (코어 위에서도 가장자리에서 보이도록 약간 억제만)
  float auraOnTop = (1.0 - a*0.75); // 코어 내부 깊숙한 곳은 약하게
  col += auraCol * auraMask * auraOnTop;

  // 약한 비네트
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

// 업로드
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  new THREE.TextureLoader().load(
    url,
    (tex) => {
      const img = tex.image;
      setTexture(tex, img.width || 1024, img.height || 1024);
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => console.error("texture load error", err)
  );
});

// 기본 tara.png 자동 로드
async function loadDefaultIfExists() {
  try {
    const res = await fetch("./tara.png", { cache: "no-store" });
    if (!res.ok) {
      console.warn("tara.png not found (status)", res.status);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    new THREE.TextureLoader().load(
      url,
      (tex) => {
        const img = tex.image;
        setTexture(tex, img.width || 1024, img.height || 1024);
        URL.revokeObjectURL(url);
      },
      undefined,
      (err) => console.error("default texture load error", err)
    );
  } catch (e) {
    console.error("default load failed", e);
  }
}

// 리셋/일시정지
btnReset?.addEventListener("click", () => {
  uniforms.uAura.value = 0.65;
  uniforms.uCore.value = 1.12;
  // 타임라인도 재시작
  start = performance.now();
  paused = false;
  if (btnPause) btnPause.textContent = "일시정지";
});

btnPause?.addEventListener("click", () => {
  paused = !paused;
  btnPause.textContent = paused ? "재생" : "일시정지";
});

let start = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  if (!paused) {
    uniforms.uTime.value = (now - start) / 1000.0;
  }

  // 0~8초 자동 성장
  uniforms.uGrow.value = Math.min(1.0, uniforms.uTime.value / 8.0);

  renderer.render(scene, camera);
}

resize();
loadDefaultIfExists();
requestAnimationFrame(animate);
