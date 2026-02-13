import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("c");
const fileInput = document.getElementById("file");
const btnReset = document.getElementById("reset");
const btnPause = document.getElementById("pause");

let paused = false;
let start = performance.now();

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.debug.checkShaderErrors = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);

const camera = new THREE.OrthographicCamera(-1,1,1,-1,0,10);
camera.position.z = 1;

const quad = new THREE.PlaneGeometry(2,2);

const uniforms = {
  uTex: { value: null },
  uHasTex: { value: 0.0 },
  uTime: { value: 0.0 },
  uRes: { value: new THREE.Vector2(1,1) },
  uImgAspect: { value: 1.0 },
  uGrow: { value: 0.0 },
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

// RGB ↔ HSV
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

  float t = uTime;

  // 배경
  float n0 = fbm(vUv*2.0 + t*0.02);
  vec3 bg = vec3(0.05,0.07,0.1) + vec3(0.02,0.04,0.07)*n0*0.3;

  if(uHasTex<0.5){
    gl_FragColor = vec4(bg,1.);
    return;
  }

  vec4 tex = texture2D(uTex, uv);
  float a = tex.a;

  // ===== 1. 자동 성장 =====
  float grow = uGrow;
  float radius = mix(0.0, 40.0, grow);
  vec2 px = vec2(1.0/uRes.x,1.0/uRes.y);

  float dil = 0.0;
  for(int i=0;i<24;i++){
    float ang=float(i)*6.2831853/24.0;
    vec2 dir=vec2(cos(ang),sin(ang));
    dil=max(dil, texture2D(uTex, uv + dir*radius*px).a);
  }

  float auraZone = smoothstep(0.0,0.6,dil)*(1.0-smoothstep(0.0,1.0,a));

  // ===== 2. 유영 + 호흡 =====
  float swim = fbm(vUv*2.5 + t*0.12);
  float breath = 0.6 + 0.4*sin(t*0.4);

  // ===== 3. 60초 정렬 =====
  float lockPhase = smoothstep(60.0,62.0,t);
  float motion = mix((0.5+0.5*swim)*breath, 1.0, lockPhase);

  float auraMask = auraZone * motion;

  // ===== 4. 밀도 간섭(굴절) =====
  vec2 warp = (vec2(swim,breath)-0.5)*0.015*auraMask*(1.0-lockPhase);
  float n1 = fbm((vUv+warp)*2.0 + t*0.02);
  vec3 bg2 = vec3(0.05,0.07,0.1) + vec3(0.02,0.04,0.07)*n1*0.3;

  // ===== 5. 퍼지 색 수렴 =====
  vec3 hsv = rgb2hsv(tex.rgb);
  float greenHue = 0.33;
  float dh = hsv.x - greenHue;
  if(dh>0.5) dh-=1.0;
  if(dh<-0.5) dh+=1.0;

  hsv.x -= dh*(0.2+0.6*grow);
  hsv.y = clamp(hsv.y+0.25*grow,0.0,1.0);
  hsv.z = clamp(hsv.z+0.1*grow,0.0,1.0);

  vec3 core = hsv2rgb(hsv);

  // 정렬 시 본체만 밝아짐
  core *= 1.1 + 0.25*lockPhase;

  vec3 auraCol = vec3(0.22,0.95,0.55);

  vec3 col = bg2;
  col = mix(col, core, a);
  col += auraCol * auraMask * (1.0 - a*0.6);

  gl_FragColor = vec4(col,1.);
}
`;

const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: vert,
  fragmentShader: frag,
});

scene.add(new THREE.Mesh(quad,material));

function resize(){
  const w=canvas.clientWidth;
  const h=canvas.clientHeight;
  renderer.setSize(w,h,false);
  uniforms.uRes.value.set(w,h);
}
window.addEventListener("resize",resize);

function setTexture(tex,imgW,imgH){
  tex.colorSpace=THREE.SRGBColorSpace;
  uniforms.uTex.value=tex;
  uniforms.uHasTex.value=1.0;
  uniforms.uImgAspect.value=imgW/imgH;
}

// 자동 로드
new THREE.TextureLoader().load("tara.png",(tex)=>{
  setTexture(tex,tex.image.width,tex.image.height);
});

btnReset?.addEventListener("click",()=>{
  start=performance.now();
  uniforms.uGrow.value=0.0;
});

btnPause?.addEventListener("click",()=>{
  paused=!paused;
});

fileInput?.addEventListener("change",(e)=>{
  const file=e.target.files[0];
  if(!file) return;
  const url=URL.createObjectURL(file);
  new THREE.TextureLoader().load(url,(tex)=>{
    setTexture(tex,tex.image.width,tex.image.height);
    URL.revokeObjectURL(url);
  });
});

function animate(now){
  requestAnimationFrame(animate);
  if(!paused){
    uniforms.uTime.value=(now-start)/1000.0;
    uniforms.uGrow.value=Math.min(1.0,uniforms.uTime.value/8.0);
  }
  renderer.render(scene,camera);
}

resize();
requestAnimationFrame(animate);
