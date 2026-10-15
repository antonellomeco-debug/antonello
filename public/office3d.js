// Palazzo 3D: piani sovrapposti attorno a una colonna centrale (il regista sta in cima).
// Ogni piano ha le sue isole-stanza con scrivanie e agenti; i collegamenti tra piani sono archi luminosi
// percorsi da "messaggi" che si muovono nel verso in cui viaggiano le informazioni.
// Vista Universo (setUniverse): ogni palazzo è una torre di piani colorati, il regista sta al centro e i
// collegamenti tra piani di palazzi diversi sono archi tra le torri. Toccando una torre si entra nel palazzo.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const FLOOR_GAP = 15;
const TOWER_GAP = 3.4; // distanza tra i piani di una torre nella vista Universo
const TOWER_R = 4;
const DESK_SPACING = 3;
// Telefoni e schermi piccoli: grafica più leggera (meno batteria e meno calore).
const LOW_POWER = matchMedia("(pointer: coarse)").matches || Math.min(innerWidth, screen.width || innerWidth) <= 860;

export class Office3D {
  constructor(container, { onAgentClick, onFloorFocus, onPalaceClick, assistantName }) {
    this.container = container;
    this.onAgentClick = onAgentClick;
    this.onFloorFocus = onFloorFocus;
    this.onPalaceClick = onPalaceClick;
    this.mode = "palace"; // "palace" (un palazzo con i suoi piani) oppure "universe" (tutti i palazzi)
    this.assistantName = assistantName;
    this.agentObjs = new Map(); // id -> { head, ring, monitor, el, label, talk, status, floorId }
    this.clickables = [];
    this.floors = new Map(); // floorId -> { group, y, labels: { floor, rooms: [] }, islands: [] }
    this.hovered = null; // agente sotto il mouse (o toccato sul telefono): è l'unico con l'etichetta visibile
    this.flows = []; // sferette che viaggiano lungo i collegamenti
    this.focused = null; // id del piano in primo piano, null = tutto il palazzo
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.scene.fog = new THREE.Fog(0x05060f, 60, 160);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(0, 24, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: !LOW_POWER });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, LOW_POWER ? 1.5 : 2));
    this.renderer.shadowMap.enabled = !LOW_POWER;
    container.append(this.renderer.domElement);
    this.watchContext();

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels-layer";
    container.append(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 160;
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      this.controls.autoRotate = false;
      this.fly = null; // l'utente prende il controllo della camera
      this.downAt = [e.clientX, e.clientY];
      this.lastPointer = e.pointerType; // "mouse", "touch" o "pen": con il dito non c'è il "passare sopra"
    });

    this.addLights();
    this.addStars();
    this.world = new THREE.Group(); // tutto ciò che dipende dal palazzo (ricostruito a ogni modifica)
    this.scene.add(this.world);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.renderer.domElement.addEventListener("click", (e) => this.handleClick(e));
    this.renderer.domElement.addEventListener("pointermove", (e) => this.handleHover(e));
    // Con il dito "pointerleave" arriva alla fine di ogni tocco: nasconderebbe subito l'etichetta appena mostrata.
    container.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && this.hoverAgent(null));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setActive(true);
  }

  /** Accende o spegne il disegno continuo (spento quando l'ufficio non si vede: altra sezione, pagina nascosta). */
  setActive(on) {
    on = Boolean(on);
    if (on === this.active) return;
    this.active = on;
    this.renderer.setAnimationLoop(on && !this.contextLost ? () => this.tick() : null);
    if (on) this.resize(); // la finestra può essere cambiata mentre era spento
  }

  /** Il telefono può togliere la scheda video alla pagina (es. app in sottofondo): si aspetta che la restituisca. */
  watchContext() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // permette al browser di restituire il contesto
      this.contextLost = true;
      this.renderer.setAnimationLoop(null);
      this.armLostNotice();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      clearTimeout(this.lostTimer);
      this.lostNotice?.remove();
      this.lostNotice = null;
      if (this.active) this.renderer.setAnimationLoop(() => this.tick()); // three.js ricarica da solo forme e materiali
    });
    document.addEventListener("visibilitychange", () => this.contextLost && this.armLostNotice());
  }

  /** Se dopo qualche secondo (a pagina visibile) il contesto non torna, propone di ricaricare la pagina. */
  armLostNotice() {
    clearTimeout(this.lostTimer);
    if (document.hidden || this.lostNotice) return;
    this.lostTimer = setTimeout(() => {
      if (!this.contextLost || this.lostNotice) return;
      const box = document.createElement("div");
      box.className = "gl-lost";
      const p = document.createElement("p");
      p.textContent = "La vista 3D si è interrotta (succede quando il telefono mette l'app in pausa).";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn primary";
      btn.textContent = "↻ Ricarica la pagina";
      btn.addEventListener("click", () => location.reload());
      box.append(p, btn);
      this.container.append(box);
      this.lostNotice = box;
    }, 4000);
  }

  addLights() {
    this.scene.add(new THREE.AmbientLight(0x8890ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(25, 80, 20);
    key.castShadow = !LOW_POWER;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 200 });
    this.scene.add(key);
    this.keyLight = key;
  }

  addStars() {
    const n = LOW_POWER ? 600 : 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 90 + Math.random() * 120;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.7, r * Math.sin(p) * Math.sin(t)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab4ff, size: 0.4, sizeAttenuation: true, fog: false }));
    this.scene.add(this.stars);
  }

  // ---------- costruzione del palazzo ----------

  /** Toglie la scena precedente: etichette HTML e memoria della scheda video. */
  clearWorld() {
    if (this.hideTimer) this.hovered = null; // un'etichetta che stava per sparire non ricompare dopo la ricostruzione
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.world.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove();
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) m.dispose();
    });
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.floors.clear();
    this.agentObjs.clear();
    this.clickables = [];
    this.flows = [];
    this.towerTop = 0;
  }

  /**
   * building: { floors, rooms, links } di un palazzo, agents: [...].
   * key: quale palazzo è (cambiando palazzo, o tornando dall'universo, l'inquadratura riparte da capo).
   */
  setBuilding(building, agents, key = null) {
    const changed = this.mode !== "palace" || key !== this.sceneKey;
    if (changed) this.focused = null;
    this.mode = "palace";
    this.sceneKey = key;
    const before = { focused: this.focused, floors: this.floors.size, topY: this.topY };
    this.clearWorld();

    const floors = building.floors; // già ordinati dal piano più basso
    this.topY = Math.max(0, (floors.length - 1) * FLOOR_GAP);
    floors.forEach((floor, i) => {
      const rooms = building.rooms.filter((r) => r.floor === floor.id);
      const entry = this.buildFloor(floor, rooms, agents, i * FLOOR_GAP);
      this.floors.set(floor.id, entry);
      this.world.add(entry.group);
    });
    this.buildCore(floors.length);
    building.links.forEach((link, k) => this.buildLink(link, k));

    // Mantiene la vista corrente se il piano esiste ancora.
    if (this.focused && !this.floors.has(this.focused)) this.focused = null;
    if (changed && this.initialized) {
      this.focused = floors.length === 1 ? floors[0].id : null;
      this.flyTo(this.cameraFor(this.focused));
      this.fly.thenRotate = true;
      this.onFloorFocus?.(this.focused);
    } else if (!this.initialized) {
      this.initialized = true;
      this.focused = floors.length === 1 ? floors[0].id : null;
      const view = this.cameraFor(this.focused);
      this.fitLimits(view);
      this.camera.position.copy(view.camera);
      this.controls.target.copy(view.target);
    } else if (before.focused !== this.focused || (!this.focused && (before.floors !== this.floors.size || before.topY !== this.topY))) {
      // Il piano guardato è sparito, oppure il palazzo è cambiato in altezza: si rifà l'inquadratura.
      this.flyTo(this.cameraFor(this.focused));
      this.onFloorFocus?.(this.focused);
    }
    this.applyFocus();
  }

  /**
   * Vista Universo: universe = { palaces, floors, rooms, links }. Ogni palazzo è una torre (un disco colorato per
   * piano, un puntino per agente); al centro il regista; archi per i collegamenti tra piani di palazzi diversi.
   */
  setUniverse(universe, agents) {
    const changed = this.mode !== "universe";
    this.mode = "universe";
    this.sceneKey = null;
    this.focused = null;
    this.clearWorld();
    const palaces = universe.palaces;
    const n = palaces.length;
    const radius = n <= 1 ? 0 : Math.max(16, n * 6.5);
    const tops = [];
    const floorPos = new Map(); // id del piano -> posizione nel mondo (per gli archi tra palazzi)
    palaces.forEach((p, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2 + Math.PI / 2;
      const pos = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      const floors = universe.floors.filter((f) => f.palace === p.id); // dal più basso
      const tower = new THREE.Group();
      tower.position.copy(pos);
      const color = new THREE.Color(p.color ?? "#6f7dff");
      const height = Math.max(1, floors.length) * TOWER_GAP;
      tops.push({ pos, height });

      // Base e colonna del palazzo.
      const ring = new THREE.Mesh(new THREE.TorusGeometry(TOWER_R + 1.6, 0.08, 6, 64), new THREE.MeshBasicMaterial({ color }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -1;
      tower.add(ring);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(TOWER_R + 1.6, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = -1;
      tower.add(glow);
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, height + 2, 16, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
      );
      column.position.y = height / 2 - 1;
      tower.add(column);

      if (!floors.length) {
        // Palazzo ancora vuoto: un piano "fantasma" tratteggiato.
        const ghost = new THREE.Mesh(
          new THREE.CylinderGeometry(TOWER_R, TOWER_R, 0.5, 32, 1, true),
          new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }),
        );
        tower.add(ghost);
      }
      floors.forEach((f, j) => {
        const y = j * TOWER_GAP;
        const fc = new THREE.Color(f.color ?? p.color ?? "#6f7dff");
        const slab = new THREE.Mesh(
          new THREE.CylinderGeometry(TOWER_R, TOWER_R, 0.55, 40),
          new THREE.MeshStandardMaterial({ color: fc, emissive: fc, emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.85 }),
        );
        slab.position.y = y;
        tower.add(slab);
        const edge = new THREE.Mesh(new THREE.TorusGeometry(TOWER_R, 0.06, 6, 64), new THREE.MeshBasicMaterial({ color: fc }));
        edge.rotation.x = Math.PI / 2;
        edge.position.y = y + 0.3;
        tower.add(edge);
        // Un puntino per agente sul bordo del piano.
        const here = agents.filter((a) => universe.rooms.some((r) => r.id === a.room && r.floor === f.id));
        here.slice(0, 32).forEach((a, k) => {
          const ang = (k / Math.max(here.length, 1)) * Math.PI * 2;
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
          dot.position.set(Math.cos(ang) * (TOWER_R - 0.9), y + 0.5, Math.sin(ang) * (TOWER_R - 0.9));
          tower.add(dot);
        });
        floorPos.set(f.id, pos.clone().setY(y));
      });

      // Zona cliccabile (invisibile) grande quanto la torre.
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(TOWER_R + 1.6, TOWER_R + 1.6, height + 3, 16),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.y = height / 2 - 1;
      hit.userData.palaceId = p.id;
      tower.add(hit);
      this.clickables.push(hit);

      const el = document.createElement("div");
      el.className = "palace-label";
      el.style.setProperty("--c", p.color ?? "#6f7dff");
      el.innerHTML = "<b></b><small></small>";
      el.querySelector("b").textContent = p.name;
      const nAgents = agents.filter((a) => universe.rooms.some((r) => r.id === a.room && floors.some((f) => f.id === r.floor))).length;
      const count = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      el.querySelector("small").textContent = floors.length ? `${count(floors.length, "piano", "piani")} · ${count(nAgents, "agente", "agenti")}` : "vuoto: tocca per entrare";
      el.addEventListener("click", () => this.onPalaceClick?.(p.id));
      const label = new CSS2DObject(el);
      label.position.set(0, height + 1.2, 0);
      tower.add(label);
      this.world.add(tower);
    });

    // Il regista al centro, più in alto di tutte le torri, con un filo verso ciascuna.
    this.towerTop = Math.max(TOWER_GAP, ...tops.map((t) => t.height));
    this.topY = this.towerTop + 2;
    this.buildCore(0);
    for (const t of tops) {
      if (!radius) break;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, this.topY + 6, 0), t.pos.clone().setY(t.height)]),
        new THREE.LineBasicMaterial({ color: 0x8fa2ff, transparent: true, opacity: 0.18 }),
      );
      this.world.add(line);
    }

    // Collegamenti tra piani di palazzi diversi.
    universe.links.forEach((link) => {
      const a = floorPos.get(link.from);
      const b = floorPos.get(link.to);
      const pa = universe.floors.find((f) => f.id === link.from)?.palace;
      const pb = universe.floors.find((f) => f.id === link.to)?.palace;
      if (!a || !b || pa === pb) return;
      const mid = a.clone().add(b).multiplyScalar(0.5).setY(Math.max(a.y, b.y) + 6 + a.distanceTo(b) * 0.12);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const mat = link.active
        ? new THREE.LineBasicMaterial({ color: 0x7cffc4, transparent: true, opacity: 0.85 })
        : new THREE.LineDashedMaterial({ color: 0x6b7090, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.6 });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)), mat);
      if (!link.active) line.computeLineDistances();
      this.world.add(line);
      if (!link.active) return;
      for (const w of link.direction === "both" ? [1, -1] : [1]) {
        for (let i = 0; i < 2; i++) {
          const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
          this.world.add(m);
          this.flows.push({ mesh: m, curve, way: w, offset: i * 0.5 + (w < 0 ? 0.25 : 0) });
        }
      }
    });

    this.universeRadius = radius;
    const view = this.cameraFor(null);
    if (!this.initialized) {
      this.initialized = true;
      this.fitLimits(view);
      this.camera.position.copy(view.camera);
      this.controls.target.copy(view.target);
    } else if (changed) {
      this.flyTo(view);
      this.fly.thenRotate = true;
    }
    this.applyFocus();
  }

  buildFloor(floor, rooms, agents, y) {
    const group = new THREE.Group();
    group.position.y = y;
    group.userData.floorId = floor.id;
    const color = new THREE.Color(floor.color ?? "#6f7dff");
    const ringRadius = Math.max(12, rooms.length * 3.2 + 6);
    const entry = { group, y, ringRadius, labels: { floor: null, rooms: [] }, islands: [] };

    // Lastra del piano: disco trasparente con bordo luminoso.
    const plateR = ringRadius + 7;
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(plateR, 72),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -1.6;
    plate.userData.floorId = floor.id;
    group.add(plate);
    this.clickables.push(plate);
    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(plateR, 0.07, 6, 120),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    edge.rotation.x = Math.PI / 2;
    edge.position.y = -1.6;
    group.add(edge);

    // Base attorno alla colonna centrale.
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.8, 3.2, 0.6, 40),
      new THREE.MeshStandardMaterial({ color: 0x1b1f3a, metalness: 0.4, roughness: 0.5 }),
    );
    base.position.y = -0.4;
    group.add(base);
    const baseRing = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.06, 8, 48), new THREE.MeshBasicMaterial({ color }));
    baseRing.rotation.x = Math.PI / 2;
    baseRing.position.y = -0.08;
    group.add(baseRing);

    const fl = document.createElement("div");
    fl.className = "floor-label";
    fl.style.setProperty("--c", floor.color ?? "#6f7dff");
    fl.innerHTML = `<b></b><small></small>`;
    fl.querySelector("b").textContent = floor.name;
    fl.querySelector("small").textContent = floor.sector ?? "";
    fl.addEventListener("click", () => this.focusFloor(floor.id));
    const flObj = new CSS2DObject(fl);
    flObj.position.set(0, -1.6, plateR); // sul bordo davanti
    group.add(flObj);
    entry.labels.floor = flObj;

    rooms.forEach((room, i) => {
      const angle = (i / Math.max(rooms.length, 1)) * Math.PI * 2 + Math.PI / 2;
      const center = new THREE.Vector3(Math.cos(angle) * ringRadius, 0, Math.sin(angle) * ringRadius);
      const island = this.buildIsland(room, agents.filter((a) => a.room === room.id), entry, floor.id);
      island.position.copy(center);
      island.position.y = (i % 2) * 0.6 - 0.3;
      island.lookAt(0, island.position.y, 0);
      island.userData.baseY = island.position.y;
      island.userData.phase = i + y;
      group.add(island);
      entry.islands.push(island);

      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0.2, 0),
        new THREE.Vector3(center.x / 2, 3, center.z / 2),
        new THREE.Vector3(center.x * 0.78, island.position.y + 0.6, center.z * 0.78),
      );
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
        new THREE.LineBasicMaterial({ color: new THREE.Color(room.color), transparent: true, opacity: 0.35 }),
      );
      group.add(line);
    });
    return entry;
  }

  buildCore(floorCount) {
    const height = this.topY + 8;
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, height, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x6f7dff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    column.position.y = height / 2 - 2;
    this.world.add(column);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, height, 8),
      new THREE.MeshBasicMaterial({ color: 0xb7c0ff }),
    );
    beam.position.y = height / 2 - 2;
    this.world.add(beam);

    // Il regista in cima al palazzo.
    const top = this.topY + 6;
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 2),
      new THREE.MeshBasicMaterial({ color: 0x8fa2ff, wireframe: true, transparent: true, opacity: 0.6 }),
    );
    this.core.position.y = top;
    this.world.add(this.core);
    this.coreGlow = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xc9d2ff, transparent: true, opacity: 0.9 }),
    );
    this.coreGlow.position.y = top;
    this.world.add(this.coreGlow);
    const light = new THREE.PointLight(0x6a7bff, 50, 40);
    light.position.y = top;
    this.world.add(light);

    const el = document.createElement("div");
    el.className = "hub-label";
    el.textContent = this.assistantName;
    const label = new CSS2DObject(el);
    label.position.set(0, top + 3.2, 0);
    this.world.add(label);
    this.coreLabel = label;
    this.floorCount = floorCount;
  }

  /** Arco luminoso tra due piani, sul lato del palazzo. */
  buildLink(link, k) {
    const a = this.floors.get(link.from);
    const b = this.floors.get(link.to);
    if (!a || !b) return;
    const angle = -Math.PI / 5 + k * 0.42; // ogni collegamento su un lato diverso
    const r = Math.max(a.ringRadius, b.ringRadius) + 9;
    const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const p0 = dir.clone().multiplyScalar(r - 2).setY(a.y - 1.6);
    const p2 = dir.clone().multiplyScalar(r - 2).setY(b.y - 1.6);
    const p1 = dir.clone().multiplyScalar(r + 6 + Math.abs(b.y - a.y) * 0.25).setY((a.y + b.y) / 2 - 1.6);
    const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
    const points = curve.getPoints(60);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = link.active
      ? new THREE.LineBasicMaterial({ color: 0x7cffc4, transparent: true, opacity: 0.85 })
      : new THREE.LineDashedMaterial({ color: 0x6b7090, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.6 });
    const line = new THREE.Line(geo, mat);
    if (!link.active) line.computeLineDistances();
    this.world.add(line);

    // Estremità: anelli sui due piani.
    for (const p of [p0, p2]) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 12, 8),
        new THREE.MeshBasicMaterial({ color: link.active ? 0x7cffc4 : 0x6b7090 }),
      );
      dot.position.copy(p);
      this.world.add(dot);
    }
    if (!link.active) return;
    // "Messaggi" che viaggiano: da from a to; nei due sensi se il collegamento è bidirezionale.
    const ways = link.direction === "both" ? [1, -1] : [1];
    for (const w of ways) {
      for (let i = 0; i < 2; i++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        this.world.add(m);
        this.flows.push({ mesh: m, curve, way: w, offset: i * 0.5 + (w < 0 ? 0.25 : 0) });
      }
    }
  }

  buildIsland(room, agents, entry, floorId) {
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
    top.userData = { roomId: room.id, floorId };
    g.add(top);
    this.clickables.push(top);

    const under = new THREE.Mesh(
      roundedSlab(w * 0.86, d * 0.86, 0.9, 0.6),
      new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.45), roughness: 0.8 }),
    );
    under.position.y = -0.8;
    g.add(under);

    const grid = new THREE.GridHelper(Math.min(w, d) - 1, 6, 0xffffff, 0xffffff);
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    grid.position.y = 0.46;
    g.add(grid);

    const title = document.createElement("div");
    title.className = "room-label";
    title.style.setProperty("--c", room.color);
    title.textContent = room.name.toUpperCase();
    title.addEventListener("click", () => this.focusRoom(room.id));
    const tl = new CSS2DObject(title);
    tl.position.set(0, -1.9, 0); // sotto l'isola, così non copre gli agenti
    tl.userData.roomId = room.id;
    g.add(tl);
    entry.labels.rooms.push(tl);
    g.userData.roomId = room.id;

    agents.forEach((agent, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const desk = this.buildDesk(agent, color, floorId);
      desk.position.set((c - (cols - 1) / 2) * DESK_SPACING, 0.45, (r - (rows - 1) / 2) * DESK_SPACING + 0.3);
      g.add(desk);
    });
    return g;
  }

  buildDesk(agent, roomColor, floorId) {
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

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffc94d, transparent: true, opacity: 0 });
    ringMat.userData.noDim = true; // l'opacità la gestisce lo stato dell'agente
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.05, 8, 40), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.05, 0.4);
    g.add(ring);

    const el = document.createElement("div");
    el.className = "agent-label";
    el.innerHTML = `<span class="av"></span><span class="nm"></span><span class="st"></span>`;
    el.querySelector(".av").textContent = agent.avatar;
    el.querySelector(".nm").textContent = agent.name;
    el.addEventListener("click", () => this.onAgentClick?.(agent.id));
    // Restando sull'etichetta si può cliccarla; uscendo si nasconde (solo con il mouse: con il dito resta finché si tocca altrove).
    el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && this.hoverAgent(agent.id));
    el.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && this.hoverAgent(null));
    const label = new CSS2DObject(el);
    label.position.set(0, 2.3, 0.4);
    label.visible = false; // si vede solo con il mouse sopra l'agente (o dopo averlo toccato)
    g.add(label);
    // I fumetti hanno un punto d'appoggio tutto loro: compaiono anche quando l'etichetta è nascosta.
    const talk = new CSS2DObject(Object.assign(document.createElement("div"), { className: "agent-talk" }));
    talk.position.copy(label.position);
    g.add(talk);

    for (const m of [table, monitor, body, head, chair]) {
      m.userData = { agentId: agent.id, floorId };
      this.clickables.push(m);
    }
    this.agentObjs.set(agent.id, { head, ring, monitor, el, label, talk, status: "idle", floorId });
    if (!agent.enabled) el.classList.add("off");
    return g;
  }

  // ---------- stato degli agenti ----------

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
    o.talk.element.querySelector(".bubble")?.remove();
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    o.talk.element.append(b);
    setTimeout(() => b.remove(), 7000);
  }

  // ---------- vista: tutto il palazzo o un piano ----------

  /** Distanza a cui un oggetto largo `halfWidth` e alto `halfHeight` entra tutto nell'inquadratura. */
  fitDistance(halfWidth, halfHeight) {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return Math.max(halfWidth / Math.tan(hfov / 2), halfHeight / Math.tan(vfov / 2));
  }

  cameraFor(floorId) {
    if (floorId && this.floors.has(floorId)) {
      const f = this.floors.get(floorId);
      const dist = this.fitDistance(f.ringRadius + 9, (f.ringRadius + 9) * 0.55) + 6;
      // Camera bassa (sotto il piano superiore), così il piano sopra non copre la vista.
      const up = Math.min(dist * 0.35, FLOOR_GAP * 0.8);
      return { target: new THREE.Vector3(0, f.y - 1, 0), camera: new THREE.Vector3(0, f.y + up, Math.sqrt(dist * dist - up * up)) };
    }
    if (this.mode === "universe") {
      const r = (this.universeRadius ?? 0) + TOWER_R + 4;
      const h = this.towerTop ?? 0;
      const dist = this.fitDistance(r + 2, h / 2 + 8) + 6;
      return { target: new THREE.Vector3(0, h / 2, 0), camera: new THREE.Vector3(0, h / 2 + dist * 0.45, dist * 0.9) };
    }
    const h = this.topY ?? 0;
    const maxR = Math.max(12, ...[...this.floors.values()].map((f) => f.ringRadius));
    const dist = this.fitDistance(maxR + 10, h / 2 + 12) + 8;
    return { target: new THREE.Vector3(0, h / 2 + 2, 0), camera: new THREE.Vector3(0, h / 2 + dist * 0.3, dist * 0.95) };
  }

  /** Zoom massimo e nebbia proporzionati all'inquadratura (palazzi alti o finestre strette). */
  fitLimits(view) {
    const d = view.camera.distanceTo(view.target);
    this.controls.maxDistance = Math.max(160, d * 1.4);
    this.scene.fog.near = Math.max(60, d * 0.8);
    this.scene.fog.far = Math.max(160, d * 2.4);
  }

  focusFloor(floorId) {
    this.focused = floorId ?? null;
    this.flyTo(this.cameraFor(this.focused));
    this.applyFocus();
    this.onFloorFocus?.(this.focused);
  }

  focusRoom(roomId) {
    for (const [floorId, f] of this.floors) {
      const island = f.islands.find((g) => g.userData.roomId === roomId);
      if (!island) continue;
      if (this.focused !== floorId) {
        this.focused = floorId;
        this.applyFocus();
        this.onFloorFocus?.(floorId);
      }
      const p = island.getWorldPosition(new THREE.Vector3());
      this.flyTo({ target: p.clone(), camera: new THREE.Vector3(p.x * 1.9, p.y + 12, p.z * 1.9) });
      return;
    }
  }

  resetView() {
    this.focusFloor(this.focused);
    this.fly.thenRotate = true; // la rotazione automatica riparte quando la camera è arrivata
  }

  flyTo(view) {
    this.controls.autoRotate = false;
    this.fitLimits(view);
    this.fly = { ...view, frames: 0 };
  }

  /** Mette in risalto il piano scelto: gli altri diventano trasparenti e senza etichette. */
  applyFocus() {
    const overview = !this.focused;
    for (const [id, f] of this.floors) {
      const active = overview || id === this.focused;
      dim(f.group, !active);
      // Palco stretto (telefono): il nome del piano già in primo piano coprirebbe la stanza davanti (lo dice già l'ascensore).
      f.labels.floor.visible = !(this.narrow && id === this.focused);
      f.labels.floor.element.classList.toggle("active", id === this.focused);
      for (const l of f.labels.rooms) l.visible = active;
    }
    // I fumetti si vedono solo sul piano in primo piano (nella vista di tutto il palazzo sarebbero troppi).
    for (const o of this.agentObjs.values()) o.talk.visible = o.floorId === this.focused;
    this.showLabel(this.hovered);
  }

  /** L'etichetta di un agente (nome e stato) compare solo quando il mouse è sopra di lui (o quando lo si tocca). */
  hoverAgent(agentId) {
    if (agentId) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
      if (agentId !== this.hovered) this.showLabel(agentId);
    } else if (this.hovered && !this.hideTimer) {
      // Si nasconde dopo un attimo: così si fa in tempo a portare il mouse sull'etichetta per cliccarla.
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        this.showLabel(null);
      }, 300);
    }
  }

  showLabel(agentId) {
    this.hovered = agentId;
    for (const [id, o] of this.agentObjs) o.label.visible = id === agentId && (!this.focused || o.floorId === this.focused);
  }

  // ---------- interazione ----------

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickables, false);
    // Con un piano in primo piano, i piani trasparenti sopra di lui non devono "rubare" il clic.
    const onFocused = this.focused && hits.find((h) => h.object.userData.floorId === this.focused);
    return (onFocused ?? hits[0])?.object;
  }

  handleClick(e) {
    const touch = Boolean(this.lastPointer) && this.lastPointer !== "mouse";
    // Un trascinamento (per girare il palazzo) non è un clic. Con il dito si tollera un po' più di movimento.
    if (this.downAt && Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > (touch ? 10 : 6)) return;
    const hit = this.pick(e);
    if (!hit) {
      if (touch) this.showLabel(null); // tocco nel vuoto: il nome sparisce
      return;
    }
    const { floorId, agentId, roomId, palaceId } = hit.userData;
    if (palaceId) return this.onPalaceClick?.(palaceId); // vista Universo: si entra nel palazzo
    if (floorId && floorId !== this.focused) return this.focusFloor(floorId); // prima si entra nel piano
    if (agentId) {
      // Con il dito: il primo tocco mostra il nome; un secondo tocco (o il tocco sul nome) apre la scheda.
      if (touch && this.hovered !== agentId) return this.showLabel(agentId);
      return this.onAgentClick?.(agentId);
    }
    if (touch) this.showLabel(null);
    if (roomId) this.focusRoom(roomId);
  }

  handleHover(e) {
    if (e.pointerType !== "mouse") return; // con il dito non si "passa sopra" (e niente calcoli mentre si gira)
    const hit = this.pick(e);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    this.hoverAgent(hit?.userData.agentId ?? null);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    const narrow = w < 560;
    if (narrow !== this.narrow) {
      this.narrow = narrow;
      if (this.floors.size) this.applyFocus();
    }
  }

  tick() {
    const t = this.clock.getElapsedTime();
    if (this.core) {
      this.core.rotation.y = t * 0.25;
      this.core.rotation.x = Math.sin(t * 0.3) * 0.2;
      this.coreGlow.scale.setScalar(1 + Math.sin(t * 2) * 0.06);
    }
    this.stars.rotation.y = t * 0.004;
    for (const f of this.floors.values()) {
      for (const g of f.islands) g.position.y = g.userData.baseY + Math.sin(t * 0.6 + g.userData.phase) * 0.18;
    }
    for (const o of this.agentObjs.values()) {
      if (o.status === "working") {
        o.head.position.y = 1.55 + Math.abs(Math.sin(t * 6)) * 0.08;
        o.ring.rotation.z = t * 2;
      } else o.head.position.y = 1.55;
    }
    for (const fl of this.flows) {
      let u = (t * 0.22 + fl.offset) % 1;
      if (fl.way < 0) u = 1 - u;
      fl.mesh.position.copy(fl.curve.getPoint(u));
    }
    if (this.fly) {
      this.controls.target.lerp(this.fly.target, 0.07);
      this.camera.position.lerp(this.fly.camera, 0.07);
      // Arrivati (o dopo ~3 secondi al massimo): la camera torna libera.
      if (this.camera.position.distanceTo(this.fly.camera) < 0.1 || ++this.fly.frames > 180) {
        if (this.fly.thenRotate) this.controls.autoRotate = true;
        this.fly = null;
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

/** Rende un gruppo semi-trasparente (piani non in primo piano) o lo riporta normale. */
function dim(group, on) {
  group.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.userData.noDim) continue;
      if (m.userData.base == null) m.userData.base = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
      const base = m.userData.base;
      m.transparent = on ? true : base.transparent;
      m.opacity = on ? base.opacity * 0.1 : base.opacity;
      m.depthWrite = on ? false : base.depthWrite;
      m.needsUpdate = true; // necessario quando cambia "transparent"
    }
  });
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
