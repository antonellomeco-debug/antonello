// Ufficio 3D: nucleo centrale (il regista) e un'isola sospesa per ogni stanza, con scrivanie e agenti.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const RING_RADIUS = 15;
const DESK_SPACING = 3;

export class Office3D {
  constructor(container, { onAgentClick, onRoomClick, assistantName }) {
    this.container = container;
    this.onAgentClick = onAgentClick;
    this.onRoomClick = onRoomClick;
    this.agentObjs = new Map(); // id -> { group, body, head, ring, monitor, label }
    this.clickables = [];
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.scene.fog = new THREE.Fog(0x05060f, 45, 90);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
    this.camera.position.set(0, 24, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.append(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels-layer";
    container.append(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 70;
    this.controls.target.set(0, 0, 0);
    this.renderer.domElement.addEventListener("pointerdown", () => (this.controls.autoRotate = false));

    this.addLights();
    this.addStars();
    this.addHub(assistantName);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.renderer.domElement.addEventListener("click", (e) => this.handleClick(e));
    this.renderer.domElement.addEventListener("pointermove", (e) => this.handleHover(e));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  addLights() {
    this.scene.add(new THREE.AmbientLight(0x8890ff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(15, 30, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
    this.scene.add(key);
    const rim = new THREE.PointLight(0x6a7bff, 60, 40);
    rim.position.set(0, 6, 0);
    this.scene.add(rim);
  }

  addStars() {
    const n = 1500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 60 + Math.random() * 80;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.6, r * Math.sin(p) * Math.sin(t)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab4ff, size: 0.35, sizeAttenuation: true, fog: false }));
    this.scene.add(this.stars);
  }

  addHub(name) {
    const hub = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(3.6, 4, 0.8, 48),
      new THREE.MeshStandardMaterial({ color: 0x1b1f3a, metalness: 0.4, roughness: 0.5 }),
    );
    base.receiveShadow = true;
    hub.add(base);
    const ringTop = new THREE.Mesh(
      new THREE.TorusGeometry(3.6, 0.08, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0x6f7dff }),
    );
    ringTop.rotation.x = Math.PI / 2;
    ringTop.position.y = 0.42;
    hub.add(ringTop);

    // Sfera "cervello": wireframe luminoso + nucleo.
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.4, 2),
      new THREE.MeshBasicMaterial({ color: 0x8fa2ff, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    this.core.position.y = 3.6;
    hub.add(this.core);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xc9d2ff, transparent: true, opacity: 0.85 }),
    );
    glow.position.y = 3.6;
    hub.add(glow);
    this.coreGlow = glow;

    const el = document.createElement("div");
    el.className = "hub-label";
    el.textContent = name;
    const label = new CSS2DObject(el);
    label.position.set(0, 6.6, 0);
    hub.add(label);
    this.scene.add(hub);
  }

  /** Ricostruisce isole e agenti. rooms: [{id,name,color}], agents: [{id,name,avatar,room,...}] */
  setOffice(rooms, agents) {
    this.islands?.forEach((g) => {
      g.traverse((o) => o.isCSS2DObject && o.element.remove());
      this.scene.remove(g);
    });
    this.links?.forEach((l) => this.scene.remove(l));
    this.islands = [];
    this.links = [];
    this.agentObjs.clear();
    this.clickables = [];

    rooms.forEach((room, i) => {
      // La prima stanza sta davanti alla camera: nessuna isola resta nascosta dietro al nucleo.
      const angle = (i / rooms.length) * Math.PI * 2 + Math.PI / 2;
      const center = new THREE.Vector3(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS);
      const roomAgents = agents.filter((a) => a.room === room.id);
      const island = this.buildIsland(room, roomAgents);
      island.position.copy(center);
      island.position.y = -0.5 + (i % 2) * 0.6;
      island.lookAt(0, island.position.y, 0); // le scrivanie guardano verso il nucleo
      island.userData.baseY = island.position.y;
      island.userData.phase = i;
      this.scene.add(island);
      this.islands.push(island);

      // Collegamento luminoso nucleo → isola.
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(center.x / 2, 3.5, center.z / 2),
        new THREE.Vector3(center.x * 0.78, island.position.y + 0.6, center.z * 0.78),
      );
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
        new THREE.LineBasicMaterial({ color: new THREE.Color(room.color), transparent: true, opacity: 0.35 }),
      );
      this.scene.add(line);
      this.links.push(line);
    });
  }

  buildIsland(room, agents) {
    const color = new THREE.Color(room.color);
    const g = new THREE.Group();
    const cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(agents.length, 1))));
    const rows = Math.max(1, Math.ceil(agents.length / cols));
    const w = Math.max(7, cols * DESK_SPACING + 2.4);
    const d = Math.max(5.5, rows * DESK_SPACING + 2.6);

    const top = new THREE.Mesh(
      roundedSlab(w, d, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 }),
    );
    top.castShadow = top.receiveShadow = true;
    top.userData.roomId = room.id;
    g.add(top);
    this.clickables.push(top);

    const under = new THREE.Mesh(
      roundedSlab(w * 0.86, d * 0.86, 0.9, 0.6),
      new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.45), roughness: 0.8 }),
    );
    under.position.y = -0.8;
    g.add(under);

    // Griglia del pavimento.
    const grid = new THREE.GridHelper(Math.min(w, d) - 1, 6, 0xffffff, 0xffffff);
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    grid.position.y = 0.46;
    g.add(grid);

    const title = document.createElement("div");
    title.className = "room-label";
    title.style.setProperty("--c", room.color);
    title.textContent = room.name.toUpperCase();
    title.addEventListener("click", () => this.onRoomClick?.(room.id));
    const tl = new CSS2DObject(title);
    tl.position.set(0, -1.9, 0); // sotto l'isola, così non copre gli agenti
    g.add(tl);

    agents.forEach((agent, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = (c - (cols - 1) / 2) * DESK_SPACING;
      const z = (r - (rows - 1) / 2) * DESK_SPACING + 0.3;
      const desk = this.buildDesk(agent, color, i);
      desk.position.set(x, 0.45, z);
      g.add(desk);
    });
    return g;
  }

  buildDesk(agent, roomColor, index = 0) {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xeef0f7, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23263a, roughness: 0.5 });

    const table = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.9), white);
    table.position.y = 0.75;
    table.castShadow = true;
    g.add(table);
    for (const sx of [-0.8, 0.8]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.8), white);
      leg.position.set(sx, 0.37, 0);
      g.add(leg);
    }
    const monitor = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.55, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x111322, emissive: roomColor, emissiveIntensity: 0.15 }),
    );
    monitor.position.set(0, 1.18, -0.3);
    g.add(monitor);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), dark);
    stand.position.set(0, 0.9, -0.3);
    g.add(stand);

    // L'agente: corpo a capsula + testa, seduto davanti al monitor.
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf5f6fb, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.45, 6, 12), bodyMat);
    body.position.set(0, 0.95, 0.55);
    body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 14), bodyMat);
    head.position.set(0, 1.55, 0.55);
    head.castShadow = true;
    g.add(head);
    const chair = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.6), dark);
    chair.position.set(0, 0.55, 0.6);
    g.add(chair);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.05, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xffc94d, transparent: true, opacity: 0 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.05, 0.4);
    g.add(ring);

    const el = document.createElement("div");
    el.className = "agent-label";
    el.innerHTML = `<span class="av"></span><span class="nm"></span><span class="st"></span>`;
    el.querySelector(".av").textContent = agent.avatar;
    el.querySelector(".nm").textContent = agent.name;
    el.addEventListener("click", () => this.onAgentClick?.(agent.id));
    const label = new CSS2DObject(el);
    label.position.set(0, 2.25 + (index % 2) * 0.75, 0.4); // etichette sfalsate
    g.add(label);

    for (const m of [table, monitor, body, head, chair]) {
      m.userData.agentId = agent.id;
      this.clickables.push(m);
    }
    this.agentObjs.set(agent.id, { group: g, body, head, ring, monitor, el, status: "idle", enabled: agent.enabled });
    if (!agent.enabled) el.classList.add("off");
    return g;
  }

  setStatus(agentId, status, detail = "") {
    const o = this.agentObjs.get(agentId);
    if (!o) return;
    o.status = status;
    o.el.dataset.status = status;
    o.el.querySelector(".st").textContent = status === "working" ? detail || "al lavoro" : status === "error" ? "errore" : "";
    o.ring.material.color.set(status === "error" ? 0xff5c5c : 0xffc94d);
    o.ring.material.opacity = status === "idle" ? 0 : 0.9;
    o.monitor.material.emissiveIntensity = status === "working" ? 0.9 : 0.15;
  }

  speak(agentId, text) {
    const o = this.agentObjs.get(agentId);
    if (!o) return;
    o.el.querySelector(".bubble")?.remove();
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    o.el.append(b);
    setTimeout(() => b.remove(), 7000);
  }

  focusRoom(roomId) {
    const island = this.islands.find((g) => g.children[0]?.userData.roomId === roomId);
    if (!island) return;
    this.controls.autoRotate = false;
    const p = island.position;
    this.focus = {
      target: new THREE.Vector3(p.x, p.y, p.z),
      camera: new THREE.Vector3(p.x * 1.9, p.y + 12, p.z * 1.9),
    };
  }

  homePosition() {
    // Su schermi stretti (telefono) la camera si allontana per far stare tutto l'ufficio.
    const k = this.camera.aspect < 1 ? 1.9 : 1;
    return new THREE.Vector3(0, 26 * k, 36 * k);
  }

  resetView() {
    this.focus = { target: new THREE.Vector3(0, 0, 0), camera: this.homePosition() };
    this.controls.autoRotate = true;
  }

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.clickables, false)[0]?.object;
  }

  handleClick(e) {
    const hit = this.pick(e);
    if (hit?.userData.agentId) this.onAgentClick?.(hit.userData.agentId);
    else if (hit?.userData.roomId) this.focusRoom(hit.userData.roomId);
  }

  handleHover(e) {
    const hit = this.pick(e);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const first = !this.sized;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (first) {
      this.sized = true;
      this.camera.position.copy(this.homePosition());
    }
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  tick() {
    const t = this.clock.getElapsedTime();
    this.core.rotation.y = t * 0.25;
    this.core.rotation.x = Math.sin(t * 0.3) * 0.2;
    this.coreGlow.scale.setScalar(1 + Math.sin(t * 2) * 0.06);
    this.stars.rotation.y = t * 0.005;
    for (const g of this.islands ?? []) g.position.y = g.userData.baseY + Math.sin(t * 0.6 + g.userData.phase) * 0.18;
    for (const o of this.agentObjs.values()) {
      if (o.status === "working") {
        o.head.position.y = 1.55 + Math.abs(Math.sin(t * 6)) * 0.08;
        o.ring.rotation.z = t * 2;
      } else o.head.position.y = 1.55;
    }
    if (this.focus) {
      this.controls.target.lerp(this.focus.target, 0.06);
      this.camera.position.lerp(this.focus.camera, 0.06);
      if (this.camera.position.distanceTo(this.focus.camera) < 0.1) this.focus = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

// Lastra con angoli arrotondati (pianta dell'isola).
function roundedSlab(w, d, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 3 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2, 0);
  return geo;
}
