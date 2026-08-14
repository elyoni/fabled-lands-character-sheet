import * as THREE from "three";
import * as CANNON from "cannon-es";

// ---------------------------------------------------------------------------
// Shape data. Every shape (d4, d6, d8, d10, d12, d20) is a convex polyhedron
// centered at the origin, described by raw unit-scale vertices + CCW-wound
// (outward-facing, right-hand-rule) faces — verified offline (planarity,
// correct winding, valid 1..N numbering with no gaps/dupes) rather than
// hand-derived here; see the dev notes in this repo's history for the
// derivation (dual-of-antiprism for the d10's kite faces, convex-hull
// face-grouping for the d12's pentagons, antiparallel-normal matching for
// opposite-face numbering on d6/d8/d10/d12/d20).
//
// d4 is mechanically different from the rest: a tetrahedron has no face
// directly "up" when resting (every face touches something — the ground or
// nothing), so its result is read from the single vertex that ISN'T part of
// the resting (bottom) face — the apex pointing away from the table. It gets
// `numbering: "apex"` and `values` indexed by vertex instead of by face.
const SHAPES = {
  4: {
    numbering: "apex",
    vertices: [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]],
    faces: [[0,1,2],[0,3,1],[0,2,3],[1,3,2]],
    values: [1,2,3,4], // per-vertex
  },
  6: {
    numbering: "face",
    vertices: [[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1]],
    faces: [[2,3,1,0],[5,7,6,4],[1,5,4,0],[6,7,3,2],[4,6,2,0],[3,7,5,1]],
    values: [1,6,2,5,3,4],
  },
  8: {
    numbering: "face",
    vertices: [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],
    faces: [[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]],
    values: [1,2,3,4,6,5,8,7],
  },
  10: {
    // Y coordinates are the raw dual-of-antiprism derivation scaled by 0.75
    // on the polar axis only — the un-squashed shape had a pole-to-pole
    // height about 1.5x its equatorial width (visibly too tall/thin next to
    // the other dice); squashing one axis of a convex polyhedron is a linear
    // map, which always preserves each face's planarity, so this stays a
    // valid kite-faced solid (re-verified: all 10 faces still exactly
    // planar, opposite-face numbering unaffected). New height:width ≈ 1.13.
    numbering: "face",
    vertices: [[0,1.25,0],[0,-1.25,0],[0.89442719,0.13196601,0.64983939],[1.10557281,-0.13196601,0],[-0.34164079,0.13196601,1.05146222],[0.34164079,-0.13196601,1.05146222],[-1.10557281,0.13196601,0],[-0.89442719,-0.13196601,0.64983939],[-0.34164079,0.13196601,-1.05146222],[-0.89442719,-0.13196601,-0.64983939],[0.89442719,0.13196601,-0.64983939],[0.34164079,-0.13196601,-1.05146222]],
    faces: [[0,2,3,10],[4,5,2,0],[6,7,4,0],[8,9,6,0],[10,11,8,0],[1,3,2,5],[1,5,4,7],[1,7,6,9],[1,9,8,11],[11,10,3,1]],
    values: [1,2,3,4,5,7,6,10,9,8],
  },
  12: {
    numbering: "face",
    vertices: [[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1],[0,0.61803399,1.61803399],[0,0.61803399,-1.61803399],[0,-0.61803399,1.61803399],[0,-0.61803399,-1.61803399],[0.61803399,1.61803399,0],[0.61803399,-1.61803399,0],[-0.61803399,1.61803399,0],[-0.61803399,-1.61803399,0],[1.61803399,0,0.61803399],[1.61803399,0,-0.61803399],[-1.61803399,0,0.61803399],[-1.61803399,0,-0.61803399]],
    faces: [[1,12,0,16,17],[2,16,0,8,10],[4,8,0,12,14],[11,9,1,17,3],[14,12,1,9,5],[17,16,2,13,3],[15,13,2,10,6],[7,11,3,13,15],[19,18,4,14,5],[10,8,4,18,6],[7,19,5,9,11],[7,15,6,18,19]],
    values: [1,2,3,4,5,6,8,10,7,9,11,12],
  },
  20: {
    numbering: "face",
    vertices: [[-1,1.61803399,0],[1,1.61803399,0],[-1,-1.61803399,0],[1,-1.61803399,0],[0,-1,1.61803399],[0,1,1.61803399],[0,-1,-1.61803399],[0,1,-1.61803399],[1.61803399,0,-1],[1.61803399,0,1],[-1.61803399,0,-1],[-1.61803399,0,1]],
    faces: [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]],
    values: [1,2,3,4,5,6,7,8,9,10,17,18,19,20,16,12,11,15,14,13],
  },
};

// The raw vertex coordinates above have very different inherent scales (the
// d8's unit-axis vertices have circumradius 1, the d20's have ~1.9) — a
// single BASE_SIZE multiplier alone would make dice wildly different visual
// sizes on the table (this was a real bug: the d8 rendered at roughly half
// the d4's size with the old hand-picked constants). Computing SIZE_SCALE
// from each shape's actual circumradius instead guarantees every die has
// the exact same true circumradius, removing the guesswork entirely.
const TARGET_CIRCUMRADIUS = 1.05;
const SIZE_SCALE = Object.fromEntries(
  Object.entries(SHAPES).map(([sides, shape]) => {
    const maxMag = Math.max(...shape.vertices.map((v) => Math.hypot(v[0], v[1], v[2])));
    return [sides, TARGET_CIRCUMRADIUS / maxMag];
  })
);
const BASE_SIZE = 1.15; // world-units circumradius at scale=1

function vec3(v) { return new THREE.Vector3(v[0], v[1], v[2]); }

function faceCentroidAndNormal(vertsArr, faceIdx) {
  const pts = faceIdx.map((i) => vertsArr[i]);
  const centroid = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const normal = new THREE.Vector3().crossVectors(
    pts[1].clone().sub(pts[0]),
    pts[2].clone().sub(pts[0])
  ).normalize();
  if (normal.dot(centroid) < 0) normal.multiplyScalar(-1);
  return { centroid, normal };
}

// ---------------------------------------------------------------------------
// Mesh + collider construction. One dedicated canvas-texture material per
// face (via geometry groups), not a shared atlas — a shared atlas produced
// UV-bleed artifacts (garbled/overlapping numbers) when this was first
// tried. n-gon faces (the d10's kites, the d12's pentagons) are fan-
// triangulated from their first vertex for rendering, but every resulting
// triangle keeps the SAME material index, so the whole face still shows one
// continuous texture.
const textureCache = new Map(); // key: `${sides}:${value}:${dieColor}:${textColor}:${fontSize}:${fontFamily}` -> THREE.CanvasTexture
function invalidateTextureCache() { textureCache.clear(); }

function getFaceTexture(config, sides, value) {
  const fontPx = (config.fontSizeBySides && config.fontSizeBySides[sides]) || config.fontSize;
  const key = `${config.dieColor}|${config.textColor}|${fontPx}|${config.fontFamily}|${value}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = config.dieColor;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = config.textColor;
  ctx.font = `bold ${fontPx}px ${config.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(value), 64, 64 + fontPx * 0.067);
  const tex = new THREE.CanvasTexture(canvas);
  textureCache.set(key, tex);
  return tex;
}

// The d4 (apex numbering) has no single "up face" — the result is read off
// whichever VERTEX ends up pointing highest, not a face. A previous version
// of this drew 3 small corner numbers per face to mimic a real d4's print
// layout, but that custom draw path was unverified (no WebGL in this sandbox)
// and turned out to render blank live. This instead reuses getFaceTexture
// — the exact same single-centered-digit path already proven to work on the
// other 5 shapes — labeling each face with the value of the one vertex it
// does NOT touch (so all 4 faces get a distinct 1..4 label).
function faceValueForApex(shape, faceIdx) {
  const missing = shape.vertices.findIndex((_, vi) => !faceIdx.includes(vi));
  return shape.values[missing];
}

const WORLD_UP_LOCAL = new THREE.Vector3(0, 1, 0);
const REF_FALLBACK = new THREE.Vector3(0, 0, 1);

function buildDieMesh(sides, config) {
  const shape = SHAPES[sides];
  const scale = BASE_SIZE * SIZE_SCALE[sides];
  const verts = shape.vertices.map((v) => vec3(v).multiplyScalar(scale));

  const positions = [];
  const uv = [];
  const materials = [];
  const userFaces = []; // one entry per ORIGINAL face (not per triangle)

  shape.faces.forEach((faceIdx, f) => {
    const { centroid, normal } = faceCentroidAndNormal(verts, faceIdx);
    const ref = Math.abs(normal.dot(WORLD_UP_LOCAL)) > 0.95 ? REF_FALLBACK : WORLD_UP_LOCAL;
    const vAxis = ref.clone().sub(normal.clone().multiplyScalar(normal.dot(ref))).normalize();
    const uAxis = new THREE.Vector3().crossVectors(vAxis, normal).normalize();

    let maxR = 0;
    const locals = faceIdx.map((i) => {
      const rel = verts[i].clone().sub(centroid);
      const lu = rel.dot(uAxis), lv = rel.dot(vAxis);
      maxR = Math.max(maxR, Math.hypot(lu, lv));
      return [lu, lv];
    });
    const uvScale = 0.46 / maxR;

    const groupStart = positions.length / 3;
    // Fan-triangulate the (possibly n-gon) face from its first vertex.
    for (let k = 1; k < faceIdx.length - 1; k++) {
      for (const vi of [0, k, k + 1]) {
        const p = verts[faceIdx[vi]];
        positions.push(p.x, p.y, p.z);
        const [lu, lv] = locals[vi];
        uv.push(0.5 + lu * uvScale, 0.5 + lv * uvScale);
      }
    }
    const triCount = faceIdx.length - 2;
    const geoGroupIndex = f;

    const value = shape.numbering === "apex" ? faceValueForApex(shape, faceIdx) : shape.values[f];
    materials.push(new THREE.MeshStandardMaterial({ map: getFaceTexture(config, sides, value), roughness: 0.5 }));
    userFaces.push({ normal: normal.clone(), centroid: centroid.clone(), materialIndex: geoGroupIndex, vertexIdx: faceIdx.slice(), triStart: groupStart, triCount });
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  let cursor = 0;
  userFaces.forEach((f, i) => {
    geo.addGroup(cursor, f.triCount * 3, i);
    cursor += f.triCount * 3;
  });

  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = true;

  if (shape.numbering === "apex") {
    // Which face is a given vertex NOT part of? (the face opposite it —
    // when that face rests down, this vertex is the "up" apex.)
    mesh.userData.apexValues = shape.values; // per local-vertex index
    mesh.userData.localVertices = verts.map((v) => v.clone());
    mesh.userData.faces = shape.faces.map((faceIdx) => new Set(faceIdx));
  } else {
    mesh.userData.faces = userFaces;
  }
  mesh.userData.sides = sides;
  mesh.userData.numbering = shape.numbering;
  return mesh;
}

function buildDieShape(sides) {
  const shape = SHAPES[sides];
  const scale = BASE_SIZE * SIZE_SCALE[sides];
  const verts = shape.vertices.map((v) => new CANNON.Vec3(v[0] * scale, v[1] * scale, v[2] * scale));
  return new CANNON.ConvexPolyhedron({ vertices: verts, faces: shape.faces.map((f) => f.slice()) });
}

// Physical resting height (center-to-table distance when a face is flush
// down) — the face's plane distance from the origin, since every shape here
// is centered at the origin. Regular solids have one value for all faces;
// the (mirror-symmetric) d10 also does, so any face works as the sample.
function computeRestHeight(sides) {
  const shape = SHAPES[sides];
  const scale = BASE_SIZE * SIZE_SCALE[sides];
  const verts = shape.vertices.map((v) => vec3(v).multiplyScalar(scale));
  const { centroid, normal } = faceCentroidAndNormal(verts, shape.faces[0]);
  return Math.abs(normal.dot(centroid));
}

// Read the currently-showing result off a settled die.
function readValue(mesh) {
  if (mesh.userData.numbering === "apex") {
    const q = mesh.quaternion;
    let bestVi = -1, bestY = -Infinity;
    mesh.userData.localVertices.forEach((v, i) => {
      const world = v.clone().applyQuaternion(q);
      if (world.y > bestY) { bestY = world.y; bestVi = i; }
    });
    return mesh.userData.apexValues[bestVi];
  }
  const q = mesh.quaternion;
  let best = null, bestDot = -Infinity;
  for (const f of mesh.userData.faces) {
    const worldN = f.normal.clone().applyQuaternion(q);
    if (worldN.y > bestDot) { bestDot = worldN.y; best = f; }
  }
  return { face: best, dot: bestDot };
}

function getTopFace(mesh) {
  // Face-based shapes only; used for flatness checks / orientation correction.
  const q = mesh.quaternion;
  let best = null, bestDot = -Infinity;
  for (const f of mesh.userData.faces) {
    const worldN = f.normal.clone().applyQuaternion(q);
    if (worldN.y > bestDot) { bestDot = worldN.y; best = f; }
  }
  return { face: best, worldNormal: best ? best.normal.clone().applyQuaternion(q) : null };
}

// ---------------------------------------------------------------------------
// Scene / physics world / roll loop. Ported from prototypes/dice-physics-d6.html
// with every fix found there already applied: per-die anti-edge-balance
// nudging, an "on table, not stacked on another die" settle requirement (a
// die can go to genuine physics sleep resting flat on TOP of another die —
// that's a stable equilibrium, not a bug the sleep state can detect on its
// own), a wake-and-reposition hard timeout as the absolute last resort (the
// ONLY thing allowed to bypass the onTable requirement, and it fixes
// position, not just orientation, when it fires), and a per-frame bounds
// clamp so a die moving fast enough to tunnel through the thin collision
// walls in one step (or bounce over them) can never actually leave the
// visible table.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_CONFIG = {
  textColor: "#1c150f",
  dieColor: "#c9a227",
  fontSize: 56,
  fontSizeBySides: { 20: 44, 12: 44, 8: 44, 6: 44, 10: 40 }, // tuned per shape via the debug panel
  fontFamily: "'Cinzel', serif",
  rollSpeed: 2.5,
  rollSpin: 1.7,
  rollBounce: 0.90,
  rollDamping: 0.65,
  maxRollTime: 0.6,
  gravity: 40,
  labelOffsetX: 10,
  labelOffsetY: -6,
  labelFontSize: 29,
  labelFontFamily: "'Cinzel', serif",
  labelColor: "#e8dcc0",
  camHeight: 30,
  camDistance: 0,
};

function initDicePhysics(canvasEl, labelsEl, userConfig) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, config.camHeight, config.camDistance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(4, 14, 6);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.camera.left = -15;
  dirLight.shadow.camera.right = 15;
  dirLight.shadow.camera.top = 15;
  dirLight.shadow.camera.bottom = -15;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 40;
  dirLight.shadow.bias = -0.001;
  scene.add(dirLight);

  // A ShadowMaterial renders nothing except the shadows falling on it — the
  // dice cast real contact shadows to stay visually grounded, but there's
  // no opaque backdrop covering the page content underneath the overlay.
  const tableMat = new THREE.ShadowMaterial({ opacity: 0.35 });
  const table = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), tableMat);
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -config.gravity, 0) });
  world.allowSleep = true;
  const dieMaterial = new CANNON.Material({ friction: 0.4, restitution: config.rollBounce });
  const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: dieMaterial });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  let tableBounds = { minX: -8, maxX: 8, minZ: -8, maxZ: 8 };
  const wallBodies = [];
  // All shapes now share the same true circumradius (see SIZE_SCALE above),
  // so this is the same for every die type — computed rather than assumed,
  // so it can't silently drift out of sync with TARGET_CIRCUMRADIUS again.
  const maxExtent = BASE_SIZE * TARGET_CIRCUMRADIUS * 2;

  function computeTableBounds() {
    camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitXs = [], hitZs = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(plane, hit)) { hitXs.push(hit.x); hitZs.push(hit.z); }
    }
    const FALLBACK = 6;
    let visible = hitXs.length >= 2
      ? { minX: Math.min(...hitXs), maxX: Math.max(...hitXs), minZ: Math.min(...hitZs), maxZ: Math.max(...hitZs) }
      : { minX: -FALLBACK, maxX: FALLBACK, minZ: -FALLBACK, maxZ: FALLBACK };

    const MIN_SPAN = maxExtent * 6;
    if (visible.maxX - visible.minX < MIN_SPAN) {
      const cx = (visible.minX + visible.maxX) / 2;
      visible = { ...visible, minX: cx - MIN_SPAN / 2, maxX: cx + MIN_SPAN / 2 };
    }
    if (visible.maxZ - visible.minZ < MIN_SPAN) {
      const cz = (visible.minZ + visible.maxZ) / 2;
      visible = { ...visible, minZ: cz - MIN_SPAN / 2, maxZ: cz + MIN_SPAN / 2 };
    }
    const spanX = visible.maxX - visible.minX;
    const spanZ = visible.maxZ - visible.minZ;
    // A percentage-of-span margin looks fine on a roughly-square view, but on
    // a narrow/portrait aspect ratio the two spans can differ by 2x or more
    // (e.g. a tall phone screen at a steep overhead camera angle) — taking
    // 40% off BOTH independently collapsed the narrower axis down to almost
    // nothing, so dice were confined to a thin vertical strip ("rolling in a
    // tube"). A small, mostly-fixed margin (just enough to keep dice off the
    // walls) fixes that; the spanX*0.25/spanZ*0.25 cap only matters for a
    // genuinely tiny visible area, not the normal case.
    const marginX = Math.min(maxExtent * 1.5, spanX * 0.25);
    const marginZ = Math.min(maxExtent * 1.5, spanZ * 0.25);
    tableBounds = {
      minX: visible.minX + marginX, maxX: visible.maxX - marginX,
      minZ: visible.minZ + marginZ, maxZ: visible.maxZ - marginZ,
    };

    wallBodies.forEach((b) => world.removeBody(b));
    wallBodies.length = 0;
    const wallHeight = 20, thickness = 2;
    const specs = [
      { pos: [tableBounds.minX - thickness / 2, wallHeight / 2, 0], size: [thickness / 2, wallHeight / 2, (tableBounds.maxZ - tableBounds.minZ) / 2 + thickness] },
      { pos: [tableBounds.maxX + thickness / 2, wallHeight / 2, 0], size: [thickness / 2, wallHeight / 2, (tableBounds.maxZ - tableBounds.minZ) / 2 + thickness] },
      { pos: [0, wallHeight / 2, tableBounds.minZ - thickness / 2], size: [(tableBounds.maxX - tableBounds.minX) / 2 + thickness, wallHeight / 2, thickness / 2] },
      { pos: [0, wallHeight / 2, tableBounds.maxZ + thickness / 2], size: [(tableBounds.maxX - tableBounds.minX) / 2 + thickness, wallHeight / 2, thickness / 2] },
    ];
    for (const s of specs) {
      const body = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Box(new CANNON.Vec3(...s.size)) });
      body.position.set(...s.pos);
      world.addBody(body);
      wallBodies.push(body);
    }
  }

  function resize() {
    const w = canvasEl.clientWidth || window.innerWidth;
    const h = canvasEl.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    computeTableBounds();
  }
  resize();
  window.addEventListener("resize", resize);

  let activeDice = [];
  const clock = new THREE.Clock();
  let rafHandle = null;
  let pendingResolve = null;

  function clearDice() {
    for (const d of activeDice) {
      scene.remove(d.mesh);
      world.removeBody(d.body);
      if (d.labelEl) d.labelEl.remove();
    }
    activeDice.length = 0;
    clearResultBanners();
  }

  // Small, modest per-die readout of the actual face rolled — useful to
  // visually confirm what each physical die landed on (especially with
  // multiple damage dice), but deliberately NOT the prominent element on
  // screen: showing the raw face this big/bold was confusing (it isn't the
  // number that matters — the calculated total, after bonuses, is). The
  // caller shows that total via showResultBanner() once every die tagged
  // for a given roll has settled.
  function showLabel(die) {
    die.finalValue = die.numbering === "apex" ? readValue(die.mesh) : faceValue(die.mesh);
    const el = document.createElement("div");
    el.className = "dice-3d-label";
    el.textContent = String(die.finalValue);
    el.style.fontSize = `${Math.round(config.labelFontSize * 0.6)}px`;
    el.style.fontFamily = config.labelFontFamily;
    el.style.color = config.labelColor;
    labelsEl.appendChild(el);
    die.labelEl = el;
    positionLabel(die);
    requestAnimationFrame(() => el.classList.add("visible"));
  }

  function faceValue(mesh) {
    const { face } = readValue(mesh);
    if (!face) return null;
    const idx = mesh.userData.faces.indexOf(face);
    return SHAPES[mesh.userData.sides].values[idx];
  }

  function positionLabel(die) {
    if (!die.labelEl) return;
    let worldPos;
    if (die.numbering === "apex") {
      const q = die.mesh.quaternion;
      let bestVi = -1, bestY = -Infinity;
      die.mesh.userData.localVertices.forEach((v, i) => {
        const world = v.clone().applyQuaternion(q);
        if (world.y > bestY) { bestY = world.y; bestVi = i; }
      });
      worldPos = die.mesh.localToWorld(die.mesh.userData.localVertices[bestVi].clone());
    } else {
      const { face, worldNormal } = getTopFace(die.mesh);
      if (!face) return;
      worldPos = die.mesh.localToWorld(face.centroid.clone());
      worldPos.addScaledVector(worldNormal, die.extent * 0.35);
    }
    const ndc = worldPos.clone().project(camera);
    const w = canvasEl.clientWidth || window.innerWidth;
    const h = canvasEl.clientHeight || window.innerHeight;
    const x = (ndc.x * 0.5 + 0.5) * w + config.labelOffsetX;
    const y = (-ndc.y * 0.5 + 0.5) * h + config.labelOffsetY;
    die.labelEl.style.left = `${x}px`;
    die.labelEl.style.top = `${y}px`;
  }

  function throwDice(specs) {
    clearDice();
    const spanX = (tableBounds.maxX - tableBounds.minX) * 0.15;
    const spanZ = (tableBounds.maxZ - tableBounds.minZ) * 0.15;

    specs.forEach((spec, i) => {
      const mesh = buildDieMesh(spec.sides, config);
      const body = new CANNON.Body({
        mass: 1,
        shape: buildDieShape(spec.sides),
        material: dieMaterial,
        angularDamping: config.rollDamping,
        linearDamping: config.rollDamping / 2,
        allowSleep: true,
        sleepSpeedLimit: 0.15,
        sleepTimeLimit: 0.3,
      });

      const startX = tableBounds.minX + (tableBounds.maxX - tableBounds.minX) * 0.15 + (Math.random() - 0.5) * spanX;
      const startZ = tableBounds.minZ + (tableBounds.maxZ - tableBounds.minZ) * 0.15 + (Math.random() - 0.5) * spanZ;
      body.position.set(startX + i * maxExtent * 0.8, 6 + Math.random() * 1.5, startZ + i * maxExtent * 0.8);
      body.quaternion.setFromEuler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      const targetX = (Math.random() - 0.5) * (tableBounds.maxX - tableBounds.minX) * 0.5;
      const targetZ = (Math.random() - 0.5) * (tableBounds.maxZ - tableBounds.minZ) * 0.5;
      let vx = (targetX - startX) * 0.9 * config.rollSpeed, vz = (targetZ - startZ) * 0.9 * config.rollSpeed;
      // The speed cap must apply AFTER the rollSpeed multiplier, not before —
      // capping first and then multiplying let a high rollSpeed (e.g. 2.5x)
      // push the actual launch speed to 2.5x the intended cap, which made
      // dice fly much harder/longer than the config implied and take far
      // longer to bleed off enough energy to settle.
      const speed = Math.hypot(vx, vz);
      const maxSpeed = 16;
      if (speed > maxSpeed) { vx = (vx / speed) * maxSpeed; vz = (vz / speed) * maxSpeed; }
      body.velocity.set(vx, -2 * config.rollSpeed, vz);
      body.angularVelocity.set(
        (Math.random() - 0.5) * 20 * config.rollSpin,
        (Math.random() - 0.5) * 20 * config.rollSpin,
        (Math.random() - 0.5) * 20 * config.rollSpin
      );

      scene.add(mesh);
      world.addBody(body);
      const extent = BASE_SIZE * SIZE_SCALE[spec.sides] * 2;
      const groundY = computeRestHeight(spec.sides) * 1.3;
      activeDice.push({
        mesh, body, labelEl: null, rollingElapsed: 0, settled: false, extent, groundY,
        slowFrames: 0, nudgeCount: 0, sides: spec.sides, tag: spec.tag,
        numbering: SHAPES[spec.sides].numbering, finalValue: null,
      });
    });
  }

  function tick() {
    const dt = Math.min(clock.getDelta(), 1 / 30);
    world.step(1 / 60, dt, 3);

    let allSettled = activeDice.length > 0;
    for (const die of activeDice) {
      if (die.settled) continue;
      allSettled = false;

      const CEILING = 20;
      const marginX = die.extent, marginZ = die.extent;
      const minX = tableBounds.minX - marginX, maxX = tableBounds.maxX + marginX;
      const minZ = tableBounds.minZ - marginZ, maxZ = tableBounds.maxZ + marginZ;
      if (die.body.position.x < minX) { die.body.position.x = minX; die.body.velocity.x = Math.abs(die.body.velocity.x); }
      else if (die.body.position.x > maxX) { die.body.position.x = maxX; die.body.velocity.x = -Math.abs(die.body.velocity.x); }
      if (die.body.position.z < minZ) { die.body.position.z = minZ; die.body.velocity.z = Math.abs(die.body.velocity.z); }
      else if (die.body.position.z > maxZ) { die.body.position.z = maxZ; die.body.velocity.z = -Math.abs(die.body.velocity.z); }
      if (die.body.position.y > CEILING) { die.body.position.y = CEILING; die.body.velocity.y = -Math.abs(die.body.velocity.y); }

      die.mesh.position.copy(die.body.position);
      die.mesh.quaternion.copy(die.body.quaternion);
      die.rollingElapsed += dt;

      const genuinelySlow =
        die.body.velocity.length() < 0.3 &&
        die.body.angularVelocity.length() < 0.3 &&
        die.body.position.y < die.groundY;
      if (die.rollingElapsed > config.maxRollTime && genuinelySlow) die.slowFrames++;
      else die.slowFrames = 0;
      const stuck = die.slowFrames > 6;
      const onTable = die.body.position.y < die.groundY + die.extent * 0.25;

      if (die.rollingElapsed > config.maxRollTime + 1.2) {
        if (die.numbering === "face") {
          const { worldNormal } = getTopFace(die.mesh);
          if (worldNormal) {
            const correction = new THREE.Quaternion().setFromUnitVectors(worldNormal, WORLD_UP);
            die.mesh.quaternion.premultiply(correction);
            die.body.quaternion.set(die.mesh.quaternion.x, die.mesh.quaternion.y, die.mesh.quaternion.z, die.mesh.quaternion.w);
          }
        }
        if (!onTable) {
          let closestOther = null, closestDist = Infinity;
          for (const other of activeDice) {
            if (other === die) continue;
            const dist = die.body.position.distanceTo(other.body.position);
            if (dist < closestDist) { closestDist = dist; closestOther = other; }
          }
          const trueRestY = die.groundY / 1.3;
          if (closestOther) {
            let dx = die.body.position.x - closestOther.body.position.x;
            let dz = die.body.position.z - closestOther.body.position.z;
            let len = Math.hypot(dx, dz);
            if (len < 1e-4) { dx = 1; dz = 0; len = 1; }
            const sep = (die.extent + closestOther.extent) * 0.9;
            die.body.position.x = closestOther.body.position.x + (dx / len) * sep;
            die.body.position.z = closestOther.body.position.z + (dz / len) * sep;
          }
          die.body.position.y = trueRestY;
        }
        die.settled = true;
        die.body.velocity.setZero();
        die.body.angularVelocity.setZero();
        showLabel(die);
      } else if (die.body.sleepState === CANNON.Body.SLEEPING || stuck) {
        const flatEnough = die.numbering === "apex" ? true : getTopFace(die.mesh).worldNormal.dot(WORLD_UP) > 0.9986;
        if ((flatEnough && onTable) || (die.nudgeCount >= 15 && onTable)) {
          die.settled = true;
          die.body.velocity.setZero();
          die.body.angularVelocity.setZero();
          showLabel(die);
        } else {
          die.body.wakeUp();
          die.body.angularVelocity.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
          die.body.velocity.y = Math.max(die.body.velocity.y, 1.5);
          if (!onTable) {
            const dx = die.body.position.x || (Math.random() - 0.5);
            const dz = die.body.position.z || (Math.random() - 0.5);
            const len = Math.hypot(dx, dz) || 1;
            die.body.velocity.x += (dx / len) * 2.5;
            die.body.velocity.z += (dz / len) * 2.5;
          }
          die.slowFrames = 0;
          die.nudgeCount++;
        }
      }
    }

    for (const die of activeDice) if (die.labelEl) positionLabel(die);

    renderer.render(scene, camera);
    rafHandle = requestAnimationFrame(tick);

    if (allSettled && pendingResolve) {
      const results = activeDice.map((d) => ({ sides: d.sides, tag: d.tag, value: d.finalValue }));
      const resolve = pendingResolve;
      pendingResolve = null;
      setTimeout(() => resolve(results), 350); // brief pause so the result is visible before the caller reacts
    }
  }
  rafHandle = requestAnimationFrame(tick);

  function roll(specs) {
    // specs: [{sides, count, tag}] -> one die per (sides,tag) occurrence
    const flat = [];
    for (const s of specs) {
      for (let k = 0; k < (s.count || 1); k++) flat.push({ sides: s.sides, tag: s.tag });
    }
    return new Promise((resolve) => {
      pendingResolve = resolve;
      throwDice(flat);
    });
  }

  // The prominent readout: one banner per named result (e.g. "HIT" / "DAMAGE"),
  // pinned to a FIXED screen position (not tied to wherever the physics dice
  // happened to land — the dice can bounce anywhere, but the reader always
  // knows where to look for "the hit number" vs "the damage number"). Shows
  // the actual calculated total (bonuses included), not a raw die face.
  // items: [{ key, title, value, y }] — y is a 0..1 fraction of the viewport
  // height (e.g. 0.28 = near the top, 0.72 = near the bottom).
  const bannerEls = new Map();
  function clearResultBanners() {
    for (const el of bannerEls.values()) el.remove();
    bannerEls.clear();
  }
  function showResultBanner(items) {
    clearResultBanners();
    const w = canvasEl.clientWidth || window.innerWidth;
    const h = canvasEl.clientHeight || window.innerHeight;
    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "dice-3d-banner";
      el.innerHTML = `<div class="dice-3d-banner-title">${item.title}</div><div class="dice-3d-banner-value">${item.value}</div>`;
      el.style.left = `${w / 2}px`;
      el.style.top = `${item.y * h}px`;
      el.style.transform = "translate(-50%, -50%) scale(1.5)";
      labelsEl.appendChild(el);
      bannerEls.set(item.key, el);
      requestAnimationFrame(() => {
        el.classList.add("visible");
        setTimeout(() => { el.style.transform = "translate(-50%, -50%) scale(1)"; }, 550);
      });
    });
  }

  function dispose() {
    cancelAnimationFrame(rafHandle);
    window.removeEventListener("resize", resize);
    clearDice();
    clearResultBanners();
    renderer.dispose();
  }

  // Debug/tuning hook: merge a partial config (e.g. a per-shape font size
  // override) into the live config and drop cached face textures so the
  // NEXT roll picks up the change — see the dice debug panel.
  function updateConfig(partial) {
    Object.assign(config, partial);
    invalidateTextureCache();
  }
  function getConfig() {
    return config;
  }

  return { roll, resize, dispose, showResultBanner, clearResultBanners, updateConfig, getConfig };
}

function getFaceIndex(mesh, face) { return mesh.userData.faces.indexOf(face); }

export { SHAPES, buildDieMesh, buildDieShape, computeRestHeight, readValue, getTopFace, invalidateTextureCache, getFaceTexture, initDicePhysics };
