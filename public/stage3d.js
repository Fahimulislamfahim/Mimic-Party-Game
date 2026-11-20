import * as THREE from '/vendor/three.module.js';

export class MimicStage {
  constructor(canvasContainer) {
    this.container = canvasContainer;
    this.width = canvasContainer.clientWidth || window.innerWidth;
    this.height = canvasContainer.clientHeight || window.innerHeight;

    // Three.js Core
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x190b12);
    this.scene.fog = new THREE.FogExp2(0x190b12, 0.04);

    this.camera = new THREE.PerspectiveCamera(40, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 3.0, 9.2);

    this.targetCamera = {
      pos: new THREE.Vector3(0, 3.0, 9.2),
      lookAt: new THREE.Vector3(0, 1.1, 0)
    };
    this.currentLookAt = new THREE.Vector3(0, 1.1, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);

    // Audio reactivity state
    this.bassLevel = 0;
    this.targetBassLevel = 0;

    // Characters map: playerId -> Character
    this.characters = new Map();
    this.activePerformerId = null;

    // Confetti pool
    this.confettiParticles = [];
    this.confettiActive = false;

    // Build Stage
    this.setupLights();
    this.buildStageEnvironment();
    this.setupConfetti();

    // Resize handler
    this.onWindowResize = this.onWindowResize.bind(this);
    window.addEventListener('resize', this.onWindowResize);

    // Start render loop
    this.clock = new THREE.Clock();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  setupLights() {
    // Warm stage ambiance
    const ambient = new THREE.AmbientLight(0xffdfc4, 0.85);
    this.scene.add(ambient);

    // Directional main keylight
    const keyLight = new THREE.DirectionalLight(0xfff1dc, 1.3);
    keyLight.position.set(3, 8, 7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.bias = -0.001;
    this.scene.add(keyLight);

    // Top ceiling spotlights (warm hanging lamps)
    const lamp1 = new THREE.PointLight(0xffbe44, 2.2, 12, 1.2);
    lamp1.position.set(-3.2, 4.2, 1.0);
    this.scene.add(lamp1);

    const lamp2 = new THREE.PointLight(0xffbe44, 2.2, 12, 1.2);
    lamp2.position.set(3.2, 4.2, 1.0);
    this.scene.add(lamp2);

    // Center stage spotlight over microphone
    const micSpot = new THREE.SpotLight(0xfff4e0, 2.8, 14, Math.PI / 4, 0.4, 1.0);
    micSpot.position.set(0, 6.5, 2.2);
    micSpot.target.position.set(0, 0, 0.8);
    this.scene.add(micSpot);
    this.scene.add(micSpot.target);

    // Soft rim backlight
    const rimLight = new THREE.DirectionalLight(0xdd5588, 0.9);
    rimLight.position.set(0, 4, -4);
    this.scene.add(rimLight);
  }

  buildStageEnvironment() {
    this.stageGroup = new THREE.Group();
    this.scene.add(this.stageGroup);

    // 1. Curved Stage Back Wall
    const wallGeo = new THREE.CylinderGeometry(14, 14, 10, 48, 1, true, -Math.PI * 0.45, Math.PI * 0.9);
    const wallCanvas = document.createElement('canvas');
    wallCanvas.width = 512;
    wallCanvas.height = 512;
    const wCtx = wallCanvas.getContext('2d');
    const wGrad = wCtx.createLinearGradient(0, 0, 0, 512);
    wGrad.addColorStop(0, '#1c0a11');
    wGrad.addColorStop(0.5, '#2e121d');
    wGrad.addColorStop(1, '#44192a');
    wCtx.fillStyle = wGrad;
    wCtx.fillRect(0, 0, 512, 512);
    // Subtle vertical panels
    wCtx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < 512; x += 64) {
      wCtx.fillRect(x, 0, 3, 512);
    }
    const wallTex = new THREE.CanvasTexture(wallCanvas);
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex,
      roughness: 0.85,
      metalness: 0.1,
      side: THREE.BackSide
    });
    const backWall = new THREE.Mesh(wallGeo, wallMat);
    backWall.position.set(0, 4.5, -3.5);
    backWall.rotation.y = Math.PI;
    this.stageGroup.add(backWall);

    // 2. Stage Wood Plank Floor
    const floorCanvas = document.createElement('canvas');
    floorCanvas.width = 1024;
    floorCanvas.height = 1024;
    const fCtx = floorCanvas.getContext('2d');
    fCtx.fillStyle = '#6b361a';
    fCtx.fillRect(0, 0, 1024, 1024);

    const plankCount = 14;
    const plankHeight = 1024 / plankCount;
    for (let i = 0; i < plankCount; i++) {
      const y = i * plankHeight;
      const shade = (i % 2 === 0) ? '#844520' : '#773c1c';
      fCtx.fillStyle = shade;
      fCtx.fillRect(0, y + 2, 1024, plankHeight - 4);
      // Plank seam shadow
      fCtx.fillStyle = '#3c1809';
      fCtx.fillRect(0, y, 1024, 3);
      fCtx.fillStyle = 'rgba(255,255,255,0.06)';
      fCtx.fillRect(0, y + 3, 1024, 2);
    }
    const floorTex = new THREE.CanvasTexture(floorCanvas);
    floorTex.wrapS = THREE.RepeatWrapping;
    floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(1.5, 1.5);

    const floorGeo = new THREE.CylinderGeometry(8.5, 8.5, 0.4, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.38,
      metalness: 0.15
    });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.position.set(0, -0.2, 0);
    this.floor.receiveShadow = true;
    this.stageGroup.add(this.floor);

    // 3. Hanging Ceiling Lamps
    this.createHangingLamp(-3.2, 4.2, 1.0);
    this.createHangingLamp(3.2, 4.2, 1.0);

    // 4. MIMIC PARTY Logo on Back Wall
    this.createStageLogo();

    // 5. Giant DJ Stage Speakers
    this.speakerWoofers = [];
    this.createSpeaker(-5.2, 1.25, -0.4, 0.38);
    this.createSpeaker(5.2, 1.25, -0.4, -0.38);

    // 6. Central Standing Microphone
    this.createMicrophone(0, 0, 0.85);
  }

  createHangingLamp(x, y, z) {
    const lampGroup = new THREE.Group();
    lampGroup.position.set(x, y, z);

    // Cord
    const cordGeo = new THREE.CylinderGeometry(0.015, 0.015, 3.5, 8);
    const cordMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.y = 1.75;
    lampGroup.add(cord);

    // Shade cap
    const capGeo = new THREE.ConeGeometry(0.3, 0.22, 16);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.12;
    lampGroup.add(cap);

    // Glowing bulb sphere
    const bulbGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffea88,
      emissive: 0xffcc33,
      emissiveIntensity: 1.8,
      roughness: 0.2
    });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    lampGroup.add(bulb);

    this.stageGroup.add(lampGroup);
  }

  createStageLogo() {
    const logoCanvas = document.createElement('canvas');
    logoCanvas.width = 1024;
    logoCanvas.height = 512;
    const ctx = logoCanvas.getContext('2d');

    ctx.clearRect(0, 0, 1024, 512);

    // Glowing aura
    const glow = ctx.createRadialGradient(512, 230, 80, 512, 230, 420);
    glow.addColorStop(0, 'rgba(255, 30, 130, 0.35)');
    glow.addColorStop(0.6, 'rgba(255, 180, 0, 0.18)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 1024, 512);

    // Chunky 3D Cartoon Typography "MIMIC"
    ctx.font = '900 135px system-ui, -apple-system, Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 3D Extrusion bevels
    const text = 'MIMIC';
    for (let depth = 14; depth >= 1; depth--) {
      ctx.fillStyle = '#65103a';
      ctx.fillText(text, 512, 190 + depth);
    }
    // Dark outline
    ctx.lineWidth = 20;
    ctx.strokeStyle = '#1d050f';
    ctx.strokeText(text, 512, 190);

    // Inner bright yellow gradient face
    const grad = ctx.createLinearGradient(0, 120, 0, 240);
    grad.addColorStop(0, '#fff45c');
    grad.addColorStop(1, '#ff9e00');
    ctx.fillStyle = grad;
    ctx.fillText(text, 512, 190);

    // "PARTY" in bright glowing neon pink/magenta
    ctx.font = '900 76px system-ui, -apple-system, Impact, sans-serif';
    ctx.shadowColor = '#ff0077';
    ctx.shadowBlur = 24;
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#220015';
    ctx.strokeText('PARTY', 512, 310);
    ctx.fillStyle = '#ff1d8e';
    ctx.fillText('PARTY', 512, 310);
    ctx.shadowBlur = 0;

    const logoTex = new THREE.CanvasTexture(logoCanvas);
    const logoMat = new THREE.MeshBasicMaterial({
      map: logoTex,
      transparent: true,
      depthWrite: false
    });
    const logoPlane = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.2), logoMat);
    logoPlane.position.set(0, 3.8, -2.6);
    this.stageGroup.add(logoPlane);
  }

  createSpeaker(x, y, z, rotY) {
    const speakerGroup = new THREE.Group();
    speakerGroup.position.set(x, y, z);
    speakerGroup.rotation.y = rotY;

    // Enclosure
    const boxGeo = new THREE.BoxGeometry(1.4, 2.5, 1.2);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x334d70,
      roughness: 0.45,
      metalness: 0.25
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.castShadow = true;
    speakerGroup.add(box);

    // Speaker Grille / Face inset
    const faceGeo = new THREE.PlaneGeometry(1.2, 2.3);
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x18202c, roughness: 0.8 });
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.set(0, 0, 0.61);
    speakerGroup.add(face);

    // Two Woofers (Top and Bottom)
    const wooferPositions = [0.55, -0.55];
    wooferPositions.forEach((wy) => {
      const wooferGroup = new THREE.Group();
      wooferGroup.position.set(0, wy, 0.62);

      // Woofer ring
      const ringGeo = new THREE.RingGeometry(0.22, 0.48, 24);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.4 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      wooferGroup.add(ring);

      // Center cone (animates with bass!)
      const coneGeo = new THREE.ConeGeometry(0.24, 0.15, 24);
      const coneMat = new THREE.MeshStandardMaterial({
        color: 0x222a36,
        roughness: 0.3,
        metalness: 0.3
      });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.rotation.x = -Math.PI / 2;
      wooferGroup.add(cone);

      // Silver dust cap
      const capGeo = new THREE.SphereGeometry(0.09, 16, 16);
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xccd6e0,
        metalness: 0.8,
        roughness: 0.2
      });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.z = 0.08;
      wooferGroup.add(cap);

      speakerGroup.add(wooferGroup);
      this.speakerWoofers.push(wooferGroup);
    });

    this.stageGroup.add(speakerGroup);
  }

  createMicrophone(x, y, z) {
    const micGroup = new THREE.Group();
    micGroup.position.set(x, y, z);

    // Heavy round base plate
    const baseGeo = new THREE.CylinderGeometry(0.3, 0.32, 0.05, 24);
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.4, metalness: 0.8 });
    const base = new THREE.Mesh(baseGeo, darkMetal);
    base.position.y = 0.025;
    base.receiveShadow = true;
    micGroup.add(base);

    // Chrome vertical rod
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.15 });
    const rodGeo = new THREE.CylinderGeometry(0.022, 0.022, 1.45, 16);
    const rod = new THREE.Mesh(rodGeo, chromeMat);
    rod.position.y = 0.75;
    rod.castShadow = true;
    micGroup.add(rod);

    // Microphone head / capsule
    const headGeo = new THREE.CapsuleGeometry(0.055, 0.12, 12, 16);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.85, roughness: 0.25 });
    const micHead = new THREE.Mesh(headGeo, headMat);
    micHead.position.set(0, 1.48, 0.06);
    micHead.rotation.x = 0.45; // Angled toward performer
    micGroup.add(micHead);

    this.micStand = micGroup;
    this.stageGroup.add(micGroup);
  }

  setupConfetti() {
    this.confettiGroup = new THREE.Group();
    this.scene.add(this.confettiGroup);

    const colors = [0xff2a6d, 0x05d9e8, 0xffeb3b, 0x00ff88, 0xff7700, 0x7928ca, 0xffffff];
    const count = 180;
    const planeGeo = new THREE.PlaneGeometry(0.12, 0.08);

    for (let i = 0; i < count; i++) {
      const color = colors[i % colors.length];
      const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.visible = false;
      this.confettiGroup.add(mesh);

      this.confettiParticles.push({
        mesh,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rotVel: new THREE.Vector3(),
        alive: false
      });
    }
  }

  burstConfetti() {
    this.confettiActive = true;
    this.confettiParticles.forEach((p) => {
      p.alive = true;
      p.mesh.visible = true;
      // Start near stage top/center
      p.pos.set(
        (Math.random() - 0.5) * 6,
        4.5 + Math.random() * 2.0,
        (Math.random() - 0.5) * 4
      );
      p.vel.set(
        (Math.random() - 0.5) * 2.5,
        -0.8 - Math.random() * 1.5,
        (Math.random() - 0.5) * 2.0
      );
      p.rotVel.set(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8
      );
      p.mesh.position.copy(p.pos);
    });
  }

  updateConfetti(delta) {
    if (!this.confettiActive) return;
    let anyAlive = false;
    this.confettiParticles.forEach((p) => {
      if (!p.alive) return;
      anyAlive = true;
      p.vel.y -= 0.6 * delta; // Gravity
      p.pos.addScaledVector(p.vel, delta);
      p.mesh.position.copy(p.pos);

      p.mesh.rotation.x += p.rotVel.x * delta;
      p.mesh.rotation.y += p.rotVel.y * delta;
      p.mesh.rotation.z += p.rotVel.z * delta;

      // Rest on floor
      if (p.pos.y <= 0.02) {
        p.pos.y = 0.02;
        p.vel.set(0, 0, 0);
        p.rotVel.set(0, 0, 0);
        p.mesh.rotation.x = Math.PI / 2;
      }
    });
    if (!anyAlive) this.confettiActive = false;
  }

  setBassLevel(level) {
    this.targetBassLevel = Math.max(0, Math.min(1.5, level));
  }

  updateSpeakers(delta) {
    this.bassLevel += (this.targetBassLevel - this.bassLevel) * Math.min(1, delta * 25);
    const pulseScale = 1.0 + this.bassLevel * 0.35;
    this.speakerWoofers.forEach((w) => {
      w.scale.set(pulseScale, pulseScale, 1.0 + this.bassLevel * 0.7);
    });
    // Decay target
    this.targetBassLevel *= Math.pow(0.1, delta);
  }

  // ------------------------------------------------------------- 3D Characters
  updatePlayers(playersList, meId) {
    const currentIds = new Set(playersList.map((p) => p.id));

    // Remove left players
    for (const [id, char] of this.characters.entries()) {
      if (!currentIds.has(id)) {
        this.stageGroup.remove(char.group);
        this.characters.delete(id);
      }
    }

    // Position players in an arc/lineup behind the mic
    const n = playersList.length;
    playersList.forEach((p, idx) => {
      let char = this.characters.get(p.id);
      if (!char) {
        // Create new 3D character
        char = this.createCharacter(p, idx, p.id === meId);
        this.characters.set(p.id, char);
        this.stageGroup.add(char.group);
      }

      // Compute lineup target position
      const span = Math.min(5.6, (n - 1) * 1.6);
      const startX = -span / 2;
      const stepX = n > 1 ? span / (n - 1) : 0;
      const targetX = startX + idx * stepX;
      const targetZ = -0.7 - Math.abs(targetX) * 0.12;

      char.lineupPosition.set(targetX, 0, targetZ);
      if (!char.isWalking && this.activePerformerId !== p.id) {
        char.group.position.set(targetX, 0, targetZ);
        char.group.rotation.y = 0;
      }
      char.name = p.name;
    });
  }

  createCharacter(player, index, isMe) {
    const charGroup = new THREE.Group();

    // Color themes matching the video
    const shirtColors = [
      0xdd2c2c, // Red (like Ankmay / Rogue-V in video)
      0x2862d6, // Blue (like Illusion in video)
      0x27ae60, // Green
      0xff8f00, // Orange
      0x8e44ad, // Purple
      0x00a8ff  // Cyan
    ];
    const shirtColor = shirtColors[index % shirtColors.length];

    // Determine hair style
    // If name is Illusion -> stylish brown hair; if Rogue-V/Ankmay -> bald; if Kikiglimpse -> yellow patch
    let hairStyle = index % 3; // 0 = bald, 1 = brown parted, 2 = blonde tuft
    const lowerName = player.name.toLowerCase();
    if (lowerName.includes('illusion')) hairStyle = 1;
    else if (lowerName.includes('rogue') || lowerName.includes('ankmay')) hairStyle = 0;
    else if (lowerName.includes('kiki')) hairStyle = 2;

    const skinColor = 0xf5c396;
    const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.55 });
    const shirtMat = new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.45 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x22487a, roughness: 0.6 }); // Blue jeans
    const shoeMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    // 1. Torso
    const torsoGeo = new THREE.CylinderGeometry(0.24, 0.22, 0.58, 16);
    const torso = new THREE.Mesh(torsoGeo, shirtMat);
    torso.position.y = 0.88;
    torso.castShadow = true;
    charGroup.add(torso);

    // 2. Head Group
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.45, 0);

    // Chibi rounded head
    const headGeo = new THREE.SphereGeometry(0.38, 24, 24);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.castShadow = true;
    headGroup.add(head);

    // Cartoon Eyes
    [-0.14, 0.14].forEach((ex) => {
      // White eye sphere
      const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 14), whiteMat);
      eyeWhite.position.set(ex, 0.05, 0.32);
      eyeWhite.scale.set(1, 1.15, 0.5);
      headGroup.add(eyeWhite);

      // Pupil
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 12), eyeMat);
      pupil.position.set(ex, 0.04, 0.36);
      pupil.scale.set(1, 1.1, 0.5);
      headGroup.add(pupil);

      // White gleam highlight
      const gleam = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), whiteMat);
      gleam.position.set(ex + 0.02, 0.07, 0.38);
      headGroup.add(gleam);

      // Eyebrow
      const browGeo = new THREE.BoxGeometry(0.11, 0.025, 0.04);
      const browMat = new THREE.MeshBasicMaterial({ color: hairStyle === 1 ? 0x4a2e18 : 0x222222 });
      const brow = new THREE.Mesh(browGeo, browMat);
      brow.position.set(ex, 0.18, 0.33);
      brow.rotation.z = ex > 0 ? -0.1 : 0.1;
      headGroup.add(brow);
    });

    // Animated Mouth (scales when singing/talking)
    const mouthGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.04, 16, 1, false, 0, Math.PI);
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0x440812 });
    const mouth = new THREE.Mesh(mouthGeo, mouthMat);
    mouth.position.set(0, -0.13, 0.34);
    mouth.rotation.x = Math.PI / 2;
    headGroup.add(mouth);

    // Hair
    if (hairStyle === 1) {
      // Brown stylish swoop hair
      const hairMat = new THREE.MeshStandardMaterial({ color: 0x3d2110, roughness: 0.5 });
      const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.41, 20, 20, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
      hairCap.position.y = 0.05;
      headGroup.add(hairCap);

      const bangGeo = new THREE.SphereGeometry(0.18, 14, 14);
      const bang = new THREE.Mesh(bangGeo, hairMat);
      bang.position.set(0.12, 0.32, 0.26);
      bang.scale.set(1.4, 0.7, 0.9);
      headGroup.add(bang);
    } else if (hairStyle === 2) {
      // Blonde/yellow cartoon tuft
      const tuftMat = new THREE.MeshStandardMaterial({ color: 0xe6b800, roughness: 0.4 });
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.28, 12), tuftMat);
      tuft.position.set(0, 0.42, 0.05);
      tuft.rotation.x = -0.3;
      headGroup.add(tuft);
    }

    charGroup.add(headGroup);

    // 3. Arms & White Gloves
    const arms = [];
    [-1, 1].forEach((side) => {
      const armGroup = new THREE.Group();
      armGroup.position.set(side * 0.32, 1.1, 0);

      const armMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 12), shirtMat);
      armMesh.position.y = -0.18;
      armGroup.add(armMesh);

      // White cartoon glove / hand
      const handGeo = new THREE.SphereGeometry(0.1, 12, 12);
      const hand = new THREE.Mesh(handGeo, whiteMat);
      hand.position.y = -0.42;
      hand.scale.set(1.1, 1.2, 0.9);
      armGroup.add(hand);

      charGroup.add(armGroup);
      arms.push(armGroup);
    });

    // 4. Legs & White Sneakers
    const legs = [];
    [-0.13, 0.13].forEach((lx) => {
      const legGroup = new THREE.Group();
      legGroup.position.set(lx, 0.58, 0);

      const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.46, 12), pantsMat);
      legMesh.position.y = -0.2;
      legMesh.castShadow = true;
      legGroup.add(legMesh);

      // White Sneaker
      const shoeGeo = new THREE.BoxGeometry(0.16, 0.12, 0.28);
      const shoe = new THREE.Mesh(shoeGeo, shoeMat);
      shoe.position.set(0, -0.48, 0.05);
      legGroup.add(shoe);

      charGroup.add(legGroup);
      legs.push(legGroup);
    });

    return {
      id: player.id,
      name: player.name,
      isMe,
      group: charGroup,
      headGroup,
      mouth,
      arms, // [left, right]
      legs, // [left, right]
      lineupPosition: new THREE.Vector3(),
      state: 'idle', // idle, walking, singing, celebrating, disappointed
      animTime: Math.random() * 10,
      isWalking: false,
      mouthOpen: 0
    };
  }

  // ------------------------------------------------------------- Director & Actions
  walkPlayerToMic(playerId, onArrived) {
    const char = this.characters.get(playerId);
    if (!char) return onArrived && onArrived();

    this.activePerformerId = playerId;
    // Walk to microphone at (0, 0, 0.4) facing forward
    this.walkCharacter(char, new THREE.Vector3(0, 0, 0.42), 0, onArrived);

    // Zoom camera in to center stage!
    this.setCameraMode('performer');
  }

  returnPlayerToLine(playerId, onDone) {
    const char = this.characters.get(playerId);
    if (!char) return onDone && onDone();

    if (this.activePerformerId === playerId) {
      this.activePerformerId = null;
    }
    this.walkCharacter(char, char.lineupPosition, 0, () => {
      char.state = 'idle';
      if (onDone) onDone();
    });

    this.setCameraMode('overview');
  }

  walkCharacter(char, targetPos, targetRotY, onComplete) {
    char.isWalking = true;
    char.state = 'walking';
    const startPos = char.group.position.clone();
    const duration = 1.1; // seconds
    let elapsed = 0;

    const onTick = (delta) => {
      elapsed += delta;
      const t = Math.min(1, elapsed / duration);
      // Smooth easeInOutQuad
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      char.group.position.lerpVectors(startPos, targetPos, ease);

      // Face walk direction while moving
      const dx = targetPos.x - startPos.x;
      const dz = targetPos.z - startPos.z;
      if (Math.hypot(dx, dz) > 0.01 && t < 0.95) {
        char.group.rotation.y = Math.atan2(dx, dz);
      } else {
        char.group.rotation.y = targetRotY;
      }

      if (t >= 1) {
        char.isWalking = false;
        char.group.position.copy(targetPos);
        char.group.rotation.y = targetRotY;
        if (onComplete) onComplete();
      }
    };
    char.walkTicker = onTick;
  }

  setPerformerState(playerId, state) {
    const char = this.characters.get(playerId);
    if (char) {
      char.state = state;
    }
  }

  setMouthAperture(playerId, val) {
    const char = this.characters.get(playerId);
    if (char) {
      char.mouthOpen = Math.max(0, Math.min(1.5, val));
    }
  }

  setCameraMode(mode) {
    if (mode === 'performer') {
      // Dramatic medium close-up of singer at the mic
      this.targetCamera.pos.set(0, 2.0, 5.0);
      this.targetCamera.lookAt.set(0, 1.35, 0.42);
    } else if (mode === 'score') {
      // Angle for big score drop
      this.targetCamera.pos.set(0, 2.2, 5.8);
      this.targetCamera.lookAt.set(0, 1.45, 0.42);
    } else {
      // Overview
      this.targetCamera.pos.set(0, 3.0, 9.2);
      this.targetCamera.lookAt.set(0, 1.1, 0);
    }
  }

  // ------------------------------------------------------------- Loop & Animation
  animate() {
    requestAnimationFrame(this.animate);
    const delta = Math.min(0.1, this.clock.getDelta());
    const time = this.clock.getElapsedTime();

    // 1. Smooth Camera Lerp
    this.camera.position.lerp(this.targetCamera.pos, Math.min(1, delta * 4.5));
    this.currentLookAt.lerp(this.targetCamera.lookAt, Math.min(1, delta * 4.5));
    this.camera.lookAt(this.currentLookAt);

    // 2. Speaker bass pulse
    this.updateSpeakers(delta);

    // 3. Confetti physics
    this.updateConfetti(delta);

    // 4. Character Animations
    this.characters.forEach((char) => {
      char.animTime += delta;
      const at = char.animTime;

      if (char.walkTicker) {
        char.walkTicker(delta);
        if (!char.isWalking) char.walkTicker = null;
      }

      // State animations
      if (char.state === 'walking') {
        const walkCycle = at * 11;
        char.legs[0].rotation.x = Math.sin(walkCycle) * 0.65;
        char.legs[1].rotation.x = -Math.sin(walkCycle) * 0.65;
        char.arms[0].rotation.x = -Math.sin(walkCycle) * 0.55;
        char.arms[1].rotation.x = Math.sin(walkCycle) * 0.55;
        char.group.position.y = Math.abs(Math.sin(walkCycle)) * 0.08;
      } else if (char.state === 'singing') {
        // Leaning into microphone, mouth animated, head bobs
        char.headGroup.rotation.x = Math.sin(at * 8) * 0.12 + 0.08;
        char.headGroup.rotation.y = Math.sin(at * 4) * 0.1;
        char.arms[0].rotation.x = -0.8 + Math.sin(at * 6) * 0.15;
        char.arms[1].rotation.x = -0.8 - Math.sin(at * 6) * 0.15;
        char.arms[0].rotation.z = 0.3;
        char.arms[1].rotation.z = -0.3;

        // Mouth moves with speech / audio
        const mScale = 1.0 + (char.mouthOpen || Math.abs(Math.sin(at * 12))) * 1.8;
        char.mouth.scale.set(1.0, mScale, mScale);
        char.mouth.visible = true;

        char.legs[0].rotation.x = 0;
        char.legs[1].rotation.x = 0;
        char.group.position.y = 0;
      } else if (char.state === 'celebrating') {
        // High score: jumping up and down, arms pumped high!
        const jump = Math.abs(Math.sin(at * 8));
        char.group.position.y = jump * 0.35;
        char.arms[0].rotation.x = -2.6 + Math.sin(at * 8) * 0.3;
        char.arms[1].rotation.x = -2.6 - Math.sin(at * 8) * 0.3;
        char.arms[0].rotation.z = -0.4;
        char.arms[1].rotation.z = 0.4;
        char.headGroup.rotation.x = -0.25;
        char.mouth.scale.set(1.4, 2.2, 2.2);
        char.legs[0].rotation.x = 0.2;
        char.legs[1].rotation.x = 0.2;
      } else if (char.state === 'disappointed') {
        // Low score: slumped shoulders, drooping head
        char.group.position.y = 0;
        char.headGroup.rotation.x = 0.35;
        char.headGroup.rotation.y = Math.sin(at * 3) * 0.15; // head shake
        char.arms[0].rotation.x = 0.1;
        char.arms[1].rotation.x = 0.1;
        char.arms[0].rotation.z = 0.05;
        char.arms[1].rotation.z = -0.05;
        char.mouth.scale.set(0.8, 0.4, 0.4);
      } else {
        // IDLE: subtle breathing bobbing
        const breath = Math.sin(at * 2.8);
        char.group.position.y = breath * 0.02;
        char.headGroup.rotation.x = breath * 0.03;
        char.headGroup.rotation.y = Math.sin(at * 1.4) * 0.04;
        char.arms[0].rotation.x = Math.sin(at * 2.8) * 0.06;
        char.arms[1].rotation.x = -Math.sin(at * 2.8) * 0.06;
        char.arms[0].rotation.z = 0.08;
        char.arms[1].rotation.z = -0.08;
        char.legs[0].rotation.x = 0;
        char.legs[1].rotation.x = 0;
        char.mouth.scale.set(1.0, 1.0, 1.0);
      }
    });

    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
  }
}
