/**
 * AEROFLOCK // Interactive Hand-Tracking Video Booth
 * - Real-time MediaPipe 2-hand 21-landmark tracking (with webcam motion & virtual dual-hand fallback)
 * - 3D Craig Reynolds Boids simulation with sub-flock splitting & merging around each hand
 * - Dynamic flight-direction rotation, 3D banking/pitch squeeze, depth sorting, and glowing hand aura
 * - Built-in Boomerang, 5s Video, and Snapshot capture with 3-second countdown & download modal
 */

const ASSET_PATHS = [
  'assets/shape1-star.png',    // Green 4-point star
  'assets/shape2-tri.png',     // Cyan tri-lobe
  'assets/shape3-spinner.png', // Cobalt spinner
  'assets/shape4-arrow.png'    // Mint arrow (naturally points up-right ~ -45deg)
];

// Natural orientation offset so each shape points forward along its velocity vector
const SHAPE_ANGLE_OFFSET = [
  0,               // Star is symmetrical
  0,               // Tri-lobe
  0,               // Spinner
  Math.PI * 0.25   // Arrow image points top-right (-45 deg), rotate +45 deg to align with 0 rad (+X)
];

const state = {
  aspect: 'full',
  captureMode: 'boomerang', // 'boomerang' | 'video' | 'snapshot'
  isRecording: false,
  isCountingDown: false,
  kioskMode: false,

  // Settings
  boidCount: 180,
  networkNodeCount: 72,
  speedMult: 1.2,
  scaleMult: 1.0,
  pullStrength: 1.3,
  tiltIntensity: 1.0,
  showAura: true,
  auraIntensity: 1.0,
  showSparks: true,
  showNetworkLines: true,
  soundEnabled: true,
  enableGustScatter: true,
  showTrails: true,
  mirrorCam: true,
  cameraFacing: 'user',
  useCountdown: true,
  enabledShapes: [true, true, true, true],

  // Camera & Tracking
  camActive: false,
  mpReady: false,
  virtualHandsMode: false,
  pointerActive: false,
  pointerPressed: false,
  pointerX: 0.5,
  pointerY: 0.5,
  detectedHands: [],
  smoothedHands: [],
  gustFlashUntil: 0,

  // Canvas dimensions
  width: window.innerWidth,
  height: window.innerHeight,
  time: 0
};

// DOM Elements
const appEl = document.getElementById('app');
const stageEl = document.getElementById('booth-stage');
const videoEl = document.getElementById('webcam');
const canvas = document.getElementById('stage-canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('tracking-status');
const cameraPromptEl = document.getElementById('camera-prompt');

/* ==========================================================================
   SYNTHESIZED SPATIAL SOUND EFFECTS ENGINE (Web Audio API)
   ========================================================================== */
const SoundFX = (() => {
  let audioCtx = null;
  let masterGain = null;
  let noiseBuffer = null;
  const cooldowns = {
    hand: 0,
    gust: 0,
    swipe: 0,
    harmony: 0
  };
  const SCALE_NOTES = [523.25, 587.33, 659.25, 783.99, 987.77, 1046.5, 1174.66, 1318.51];

  function ensureContext() {
    if (!state.soundEnabled) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    if (!audioCtx) {
      audioCtx = new AC();
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 18;
      comp.ratio.value = 4;
      comp.attack.value = 0.005;
      comp.release.value = 0.15;

      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.34;
      comp.connect(masterGain);
      masterGain.connect(audioCtx.destination);
      masterGain._input = comp;

      // Reusable 0.5s stereo/mono airy noise buffer for scatter wind gusts
      const len = Math.floor(audioCtx.sampleRate * 0.5);
      noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 0.55);
      }
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone(freq, { type = 'sine', startOffset = 0, attack = 0.012, duration = 0.32, gain = 0.14, freqEnd = null } = {}) {
    try {
      const ctxA = ensureContext();
      if (!ctxA || !masterGain) return;
      const now = ctxA.currentTime + startOffset;
      const osc = ctxA.createOscillator();
      const g = ctxA.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (freqEnd) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), now + duration);
      }

      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(gain, now + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(g);
      g.connect(masterGain._input || masterGain);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch {
      // Ignore autoplay lock errors cleanly
    }
  }

  return {
    unlock() {
      ensureContext();
    },
    setEnabled(enabled) {
      state.soundEnabled = Boolean(enabled);
      if (masterGain && audioCtx) {
        masterGain.gain.setTargetAtTime(enabled ? 0.34 : 0.0001, audioCtx.currentTime, 0.03);
      }
    },
    playHandAppear(slotId = 0) {
      const now = performance.now();
      if (now - cooldowns.hand < 550) return;
      cooldowns.hand = now;
      const base = slotId === 0 ? 523.25 : 659.25;
      playTone(base, { type: 'sine', duration: 0.36, gain: 0.11 });
      playTone(base * 1.5, { type: 'triangle', startOffset: 0.045, duration: 0.42, gain: 0.08 });
    },
    playScatterGust(strength = 1.0) {
      const now = performance.now();
      if (now - cooldowns.gust < 260) return;
      cooldowns.gust = now;
      try {
        const ctxA = ensureContext();
        if (!ctxA || !masterGain || !noiseBuffer) return;

        const t0 = ctxA.currentTime;
        const src = ctxA.createBufferSource();
        src.buffer = noiseBuffer;

        const filter = ctxA.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.6;
        filter.frequency.setValueAtTime(360, t0);
        filter.frequency.exponentialRampToValueAtTime(Math.min(2600, 1450 * strength), t0 + 0.12);
        filter.frequency.exponentialRampToValueAtTime(320, t0 + 0.46);

        const g = ctxA.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(Math.min(0.28, 0.18 * strength), t0 + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.48);

        src.connect(filter);
        filter.connect(g);
        g.connect(masterGain._input || masterGain);
        src.start(t0);
        src.stop(t0 + 0.5);

        // Magical crystalline shimmer cascade
        const shimmerFreqs = [1046.5, 1318.51, 1567.98, 1975.53];
        shimmerFreqs.forEach((f, idx) => {
          playTone(f, {
            type: 'sine',
            startOffset: idx * 0.042,
            attack: 0.008,
            duration: 0.38,
            gain: 0.07
          });
        });
      } catch {
        // Ignore gracefully
      }
    },
    playSwipeChime(speedNorm = 0.5) {
      const now = performance.now();
      if (now - cooldowns.swipe < 360) return;
      cooldowns.swipe = now;
      const idx = Math.min(SCALE_NOTES.length - 1, Math.max(0, Math.floor(speedNorm * SCALE_NOTES.length)));
      playTone(SCALE_NOTES[idx], { type: 'sine', attack: 0.008, duration: 0.28, gain: 0.065 });
    },
    playDualHandHarmony() {
      const now = performance.now();
      if (now - cooldowns.harmony < 1300) return;
      cooldowns.harmony = now;
      playTone(392.0, { type: 'sine', attack: 0.06, duration: 0.65, gain: 0.075 });
      playTone(587.33, { type: 'triangle', startOffset: 0.05, attack: 0.06, duration: 0.65, gain: 0.065 });
      playTone(987.77, { type: 'sine', startOffset: 0.1, attack: 0.05, duration: 0.65, gain: 0.05 });
    },
    playCountdownBeep(step = 3) {
      const freq = step === 1 ? 880 : 660;
      playTone(freq, { type: 'sine', attack: 0.006, duration: 0.16, gain: 0.13 });
    },
    playCaptureChime(isDone = false) {
      if (isDone) {
        playTone(587.33, { type: 'sine', duration: 0.24, gain: 0.12 });
        playTone(880.0, { type: 'sine', startOffset: 0.08, duration: 0.36, gain: 0.13 });
      } else {
        playTone(1174.66, { type: 'triangle', attack: 0.004, duration: 0.12, gain: 0.14, freqEnd: 520 });
      }
    },
    playClick() {
      playTone(720, { type: 'sine', attack: 0.004, duration: 0.065, gain: 0.05 });
    }
  };
})();

// Load the 4 glossy 3D element images
const shapeImages = [];
let loadedImagesCount = 0;
ASSET_PATHS.forEach((src, idx) => {
  const img = new Image();
  img.onload = () => {
    loadedImagesCount++;
  };
  img.src = src;
  shapeImages[idx] = img;
});

/* ==========================================================================
   PRE-RENDERED SPRITE CACHES (Zero-Stall Shadow & Luminous Spark Sprites)
   ========================================================================== */
const SHAPE_PALETTES = [
  { rgb: '142, 255, 72', hex: '#8eff48' },   // Green Star
  { rgb: '56, 232, 255', hex: '#38e8ff' },   // Cyan Tri-lobe
  { rgb: '45, 130, 255', hex: '#2d82ff' },   // Cobalt Spinner
  { rgb: '80, 255, 210', hex: '#50ffd2' }    // Mint Arrow
];

const shadowSprite = (() => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0, 12, 28, 0.36)');
  grad.addColorStop(0.55, 'rgba(0, 12, 28, 0.14)');
  grad.addColorStop(1, 'rgba(0, 12, 28, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
})();

const sparkSprites = [...SHAPE_PALETTES, { rgb: '255, 255, 255', hex: '#ffffff' }].map((pal) => {
  // Soft glowing bokeh orb
  const orb = document.createElement('canvas');
  orb.width = 48;
  orb.height = 48;
  const oc = orb.getContext('2d');
  const og = oc.createRadialGradient(24, 24, 0.5, 24, 24, 22);
  og.addColorStop(0, 'rgba(255, 255, 255, 1)');
  og.addColorStop(0.22, `rgba(${pal.rgb}, 0.92)`);
  og.addColorStop(0.55, `rgba(${pal.rgb}, 0.28)`);
  og.addColorStop(1, 'rgba(0, 0, 0, 0)');
  oc.fillStyle = og;
  oc.fillRect(0, 0, 48, 48);

  // Crisp 4-point star glint sprite
  const star = document.createElement('canvas');
  star.width = 64;
  star.height = 64;
  const sc = star.getContext('2d');
  const sg = sc.createRadialGradient(32, 32, 0.5, 32, 32, 26);
  sg.addColorStop(0, 'rgba(255, 255, 255, 1)');
  sg.addColorStop(0.2, `rgba(${pal.rgb}, 0.85)`);
  sg.addColorStop(0.5, `rgba(${pal.rgb}, 0.18)`);
  sg.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sc.fillStyle = sg;
  sc.fillRect(0, 0, 64, 64);

  // Tapered horizontal + vertical glint flares
  sc.save();
  sc.translate(32, 32);
  for (let pass = 0; pass < 2; pass++) {
    sc.beginPath();
    sc.moveTo(-26, 0);
    sc.quadraticCurveTo(0, -2.5, 26, 0);
    sc.quadraticCurveTo(0, 2.5, -26, 0);
    sc.fillStyle = pass === 0 ? 'rgba(255, 255, 255, 0.95)' : `rgba(${pal.rgb}, 0.55)`;
    sc.fill();
    sc.rotate(Math.PI * 0.5);
  }
  sc.restore();

  return { orb, star };
});

/* ==========================================================================
   3D BOID CLASS (Silky Bird-like Flocking Element)
   ========================================================================== */
function smoothFlowField(x, y, t) {
  const n1 = Math.sin(y * 0.0042 + t * 0.72) + Math.cos((x + y) * 0.0028 - t * 0.48);
  const n2 = Math.cos(x * 0.0042 - t * 0.64) + Math.sin((x - y) * 0.0028 + t * 0.52);
  return { fx: n1 * 0.5, fy: n2 * 0.5 };
}

class Boid {
  constructor(index) {
    this.index = index;
    this.shapeIdx = index % ASSET_PATHS.length;
    this.reset();
  }

  reset() {
    const w = state.width || 1280;
    const h = state.height || 720;
    this.x = Math.random() * w;
    this.y = Math.random() * h;
    // z in [-0.95, 0.95]: -0.95 is far background, +0.95 is close foreground
    this.z = (Math.random() * 2 - 1) * 0.9;

    const angle = Math.random() * Math.PI * 2;
    const speed = 2.4 + Math.random() * 2.6;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.vz = 0;

    this.ax = 0;
    this.ay = 0;
    this.az = 0;

    // Smaller, delicate jewel-like size tiers so 180+ elements look silky and abundant
    const tierRoll = (this.index * 37) % 20;
    if (tierRoll < 3) {
      this.baseSize = 29 + Math.random() * 10; // Hero accents
      this.maxSpeed = 7.2 + Math.random() * 1.5;
    } else if (tierRoll < 13) {
      this.baseSize = 18 + Math.random() * 9;  // Core nimble flock
      this.maxSpeed = 8.0 + Math.random() * 1.7;
    } else {
      this.baseSize = 11 + Math.random() * 7;  // Tiny swiftlets
      this.maxSpeed = 8.8 + Math.random() * 1.9;
    }

    this.maxForce = 0.34 + Math.random() * 0.14;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.orbitSign = Math.random() < 0.5 ? 1 : -1;
    this.orbitSpeed = this.orbitSign * (0.024 + Math.random() * 0.028);
    this.orbitRadius = 48 + Math.random() * 118;
    this.orbitTilt = 0.46 + Math.random() * 0.46;
    this.orbitPlane = (Math.random() - 0.5) * 0.9;

    // Smooth orientation & 3D banking state
    this.heading = angle;
    this.bankAngle = 0;
    this.spinPhase = Math.random() * Math.PI * 2;
    this.spinSpeed = (Math.random() - 0.5) * 0.03;
    this.pulsePhase = Math.random() * Math.PI * 2;
    this.sparkCooldown = Math.random() * 20;

    // Startle / fly-away & return cycle state
    this.startleTimer = 0;
    this.returnSparkBoost = 0;

    // Breadcrumb history for curved Bezier motion ribbons
    this.history = [];
  }

  pickValidShape() {
    if (state.enabledShapes[this.shapeIdx]) return this.shapeIdx;
    const activeIndices = state.enabledShapes
      .map((on, i) => (on ? i : -1))
      .filter((i) => i !== -1);
    if (activeIndices.length === 0) return 0;
    this.shapeIdx = activeIndices[this.index % activeIndices.length];
    return this.shapeIdx;
  }

  applyForce(fx, fy, fz = 0) {
    this.ax += fx;
    this.ay += fy;
    this.az += fz;
  }

  update(boids, hands, dt, time) {
    const w = state.width;
    const h = state.height;
    const minDim = Math.min(w, h);

    // Tick startle (fly-away) & return sparkle timers
    if (this.startleTimer > 0) {
      this.startleTimer = Math.max(0, this.startleTimer - dt);
    }
    if (this.returnSparkBoost > 0) {
      this.returnSparkBoost = Math.max(0, this.returnSparkBoost - dt);
    }

    // 1. Classic Craig Reynolds Flocking (Separation, Alignment, Cohesion)
    // In dual-hand mode, weight alignment & cohesion toward same-hand group so left/right sub-flocks split crisply
    const twoHandsActive = hands.length >= 2;
    const myGroup = this.index & 1;
    const perceptionRadius = minDim * 0.105;
    const perceptionSq = perceptionRadius * perceptionRadius;
    const desiredSeparation = minDim * 0.03 * state.scaleMult;
    const separationSq = desiredSeparation * desiredSeparation;

    let alignX = 0, alignY = 0, alignZ = 0;
    let cohX = 0, cohY = 0, cohZ = 0;
    let sepX = 0, sepY = 0, sepZ = 0;
    let flockWeight = 0;
    let sepCount = 0;

    for (let i = 0; i < boids.length; i++) {
      const other = boids[i];
      if (other === this) continue;

      const dx = other.x - this.x;
      if (dx > perceptionRadius || dx < -perceptionRadius) continue;
      const dy = other.y - this.y;
      if (dy > perceptionRadius || dy < -perceptionRadius) continue;

      const distSq = dx * dx + dy * dy;

      if (distSq > 0 && distSq < perceptionSq) {
        const wGroup = (!twoHandsActive || (other.index & 1) === myGroup) ? 1.0 : 0.14;
        alignX += other.vx * wGroup;
        alignY += other.vy * wGroup;
        alignZ += other.vz * wGroup;

        cohX += other.x * wGroup;
        cohY += other.y * wGroup;
        cohZ += other.z * wGroup;
        flockWeight += wGroup;

        if (distSq < separationSq) {
          const dist = Math.sqrt(distSq);
          const push = (desiredSeparation - dist) / desiredSeparation;
          sepX -= (dx / dist) * push * 1.5;
          sepY -= (dy / dist) * push * 1.5;
          sepZ -= (other.z - this.z) * 0.04;
          sepCount++;
        }
      }
    }

    const maxSpd = this.maxSpeed * state.speedMult;
    const maxFrc = this.maxForce * state.speedMult;

    if (flockWeight > 0.05) {
      // Alignment steer
      alignX /= flockWeight;
      alignY /= flockWeight;
      const alignMag = Math.hypot(alignX, alignY) || 1;
      alignX = (alignX / alignMag) * maxSpd - this.vx;
      alignY = (alignY / alignMag) * maxSpd - this.vy;
      const alignCur = Math.hypot(alignX, alignY) || 1;
      const alignLim = Math.min(alignCur, maxFrc);
      this.applyForce((alignX / alignCur) * alignLim * 1.05, (alignY / alignCur) * alignLim * 1.05);

      // Cohesion steer
      cohX = cohX / flockWeight - this.x;
      cohY = cohY / flockWeight - this.y;
      const cohMag = Math.hypot(cohX, cohY) || 1;
      cohX = (cohX / cohMag) * maxSpd - this.vx;
      cohY = (cohY / cohMag) * maxSpd - this.vy;
      const cohCur = Math.hypot(cohX, cohY) || 1;
      const cohLim = Math.min(cohCur, maxFrc * (twoHandsActive ? 0.78 : 1.0));
      this.applyForce((cohX / cohCur) * cohLim * 0.68, (cohY / cohCur) * cohLim * 0.68);
    }

    if (sepCount > 0) {
      sepX /= sepCount;
      sepY /= sepCount;
      const sepMag = Math.hypot(sepX, sepY) || 1;
      sepX = (sepX / sepMag) * maxSpd - this.vx;
      sepY = (sepY / sepMag) * maxSpd - this.vy;
      const sepCur = Math.hypot(sepX, sepY) || 1;
      const sepLim = Math.min(sepCur, maxFrc * 1.75);
      this.applyForce((sepX / sepCur) * sepLim * 1.65, (sepY / sepCur) * sepLim * 1.65, sepZ * 0.02);
    }

    // Subtle organic air-current flow field for bird-like thermal gliding
    const flow = smoothFlowField(this.x, this.y, time);
    this.applyForce(flow.fx * maxFrc * 0.36, flow.fy * maxFrc * 0.36);

    // 2. Target Attraction: Snappy dual-hand split & agile orbiting (paused during startle fly-away!)
    let targetZ = 0;
    let handCatchUpBoost = 0;
    const isStartled = this.startleTimer > 0;
    // During startle (>16 frames left), hand attraction is off so flock scatters cleanly;
    // then smoothly eases back in over the final 16 frames so elements swoop back around!
    let attractFactor = 1;
    if (this.startleTimer > 16) {
      attractFactor = 0;
    } else if (this.startleTimer > 0) {
      const u = (16 - this.startleTimer) / 16;
      attractFactor = u * u * (3 - 2 * u);
    }

    if (hands.length > 0 && attractFactor > 0.01) {
      const hand = hands.length === 1
        ? hands[0]
        : (hands.find((h) => h.slotId === myGroup) || hands[this.index % hands.length]);
      const handOpacity = hand.opacity !== undefined ? hand.opacity : 1;
      const handSpeed = hand.speed || 0;

      this.orbitAngle += this.orbitSpeed * state.speedMult * (1 + Math.min(0.85, handSpeed * 0.03)) * dt;

      // Contract orbit slightly during brisk hand movement for crisp magnetic lock, expand when close to cam
      const closeFactor = hand.closeFactor || 0;
      const motionTighten = Math.max(0.58, 1 - Math.min(0.4, handSpeed * 0.014));
      const cosA = Math.cos(this.orbitAngle);
      const sinA = Math.sin(this.orbitAngle);
      const breatheR = this.orbitRadius * motionTighten * (0.82 + 0.18 * Math.sin(time * 1.3 + this.index * 0.2)) * (1 + closeFactor * 0.85);
      const ex = cosA * breatheR;
      const ey = sinA * breatheR * this.orbitTilt;

      const planeAng = this.orbitPlane + time * 0.18 * this.orbitSign;
      const cosP = Math.cos(planeAng);
      const sinP = Math.sin(planeAng);

      let targetX = hand.x + (ex * cosP - ey * sinP);
      let targetY = hand.y + (ex * sinP + ey * cosP);

      // Nimble fingertip weaving
      if (hand.fingertips && hand.fingertips.length > 0) {
        const tip = hand.fingertips[this.index % hand.fingertips.length];
        targetX = targetX * 0.68 + tip.x * 0.32;
        targetY = targetY * 0.68 + tip.y * 0.32;
      }

      // Compute elliptical tangent velocity so boids glide continuously along curves
      const txRaw = -sinA * this.orbitSign;
      const tyRaw = cosA * this.orbitTilt * this.orbitSign;
      const tx = txRaw * cosP - tyRaw * sinP;
      const ty = txRaw * sinP + tyRaw * cosP;
      const tLen = Math.hypot(tx, ty) || 1;

      const dx = targetX - this.x;
      const dy = targetY - this.y;
      const dist = Math.hypot(dx, dy) || 1;
      const distNorm = Math.min(1, dist / (minDim * 0.42));
      handCatchUpBoost = Math.max(distNorm, Math.min(1, handSpeed * 0.045));

      // Responsive arrival + agile swirl + direct velocity lead when hands move quickly (especially 2-hand splits)
      const approachSpeed = Math.min(maxSpd * (1.8 + handCatchUpBoost * 0.65), dist * 0.115);
      const swirlSpeed = maxSpd * (0.72 * (1 - distNorm * 0.35));
      const wakeVx = Math.max(-18, Math.min(18, (hand.vx || 0) * 0.72));
      const wakeVy = Math.max(-18, Math.min(18, (hand.vy || 0) * 0.72));

      const desiredVx = (dx / dist) * approachSpeed + (tx / tLen) * swirlSpeed + wakeVx;
      const desiredVy = (dy / dist) * approachSpeed + (ty / tLen) * swirlSpeed + wakeVy;

      const steerX = desiredVx - this.vx;
      const steerY = desiredVy - this.vy;
      const steerMag = Math.hypot(steerX, steerY) || 1;
      const steerBoost = 2.9 + distNorm * 1.15 + Math.min(0.85, handSpeed * 0.03);
      const pullLim = Math.min(steerMag, state.pullStrength * maxFrc * steerBoost * handOpacity * attractFactor);
      this.applyForce((steerX / steerMag) * pullLim, (steerY / steerMag) * pullLim);

      // Gentle close-camera keep-out cushion if user holds palm right in front of lens
      if (closeFactor > 0.15) {
        const hdx = this.x - hand.x;
        const hdy = this.y - hand.y;
        const hDist = Math.hypot(hdx, hdy) || 1;
        const cushionR = (hand.palmRadius || 90) * (1.2 + closeFactor * 0.9);
        if (hDist < cushionR) {
          const push = ((cushionR - hDist) / cushionR) * maxFrc * 2.4 * closeFactor;
          this.applyForce((hdx / hDist) * push, (hdy / hDist) * push);
        }
      }

      targetZ = Math.sin(this.orbitAngle + this.index * 0.35) * 0.85;
    } else if (!isStartled) {
      // 3. Idle State: Graceful interlocking figure-8 murmuration ribbons
      const t = time * 0.52 * state.speedMult;
      const ribbonOffset = (this.index % 2) * 1.15;
      const leaderX = w * 0.5 + Math.sin(t + ribbonOffset) * (w * 0.33);
      const leaderY = h * 0.5 + Math.sin(t * 2 + ribbonOffset) * (h * 0.24);

      this.orbitAngle += this.orbitSpeed * 0.75 * dt;
      const cosA = Math.cos(this.orbitAngle + this.index * 0.15);
      const sinA = Math.sin(this.orbitAngle + this.index * 0.15);
      const targetX = leaderX + cosA * (this.orbitRadius * 1.2);
      const targetY = leaderY + sinA * (this.orbitRadius * 0.85);

      const dx = targetX - this.x;
      const dy = targetY - this.y;
      const dist = Math.hypot(dx, dy) || 1;

      const desiredVx = (dx / dist) * Math.min(maxSpd * 0.95, dist * 0.045) - sinA * this.orbitSign * (maxSpd * 0.45);
      const desiredVy = (dy / dist) * Math.min(maxSpd * 0.95, dist * 0.045) + cosA * this.orbitSign * (maxSpd * 0.45);

      const steerX = desiredVx - this.vx;
      const steerY = desiredVy - this.vy;
      const steerMag = Math.hypot(steerX, steerY) || 1;
      const lim = Math.min(steerMag, maxFrc * 1.05);
      this.applyForce((steerX / steerMag) * lim, (steerY / steerMag) * lim);

      targetZ = Math.sin(t + this.index * 0.24) * 0.82;
    } else {
      // While startled & flying away, fan out in 3D depth too
      targetZ = this.z > 0 ? 0.9 : -0.9;
    }

    // Smooth 3D depth tracking
    const zEase = 1 - Math.exp(-0.08 * dt);
    this.z += (targetZ - this.z) * zEase;

    // Soft progressive screen margin containment so scattered birds arc gracefully back in
    const margin = 72;
    const turnForce = maxFrc * (isStartled ? 2.2 : 1.75);
    if (this.x < margin) this.applyForce(((margin - this.x) / margin) * turnForce, 0);
    if (this.x > w - margin) this.applyForce(-((this.x - (w - margin)) / margin) * turnForce, 0);
    if (this.y < margin) this.applyForce(0, ((margin - this.y) / margin) * turnForce);
    if (this.y > h - margin) this.applyForce(0, -((this.y - (h - margin)) / margin) * turnForce);

    // Frame-rate independent velocity & position integration
    const prevHeading = this.heading;
    this.vx += this.ax * dt;
    this.vy += this.ay * dt;

    // Gentle speed clamping (allow snappy catch-up & dramatic swoop speed during startle burst!)
    const speed = Math.hypot(this.vx, this.vy) || 0.001;
    const effectiveMax = isStartled
      ? maxSpd * 2.2
      : hands.length > 0 ? maxSpd * (1.58 + handCatchUpBoost * 0.55) : maxSpd * 0.98;
    if (speed > effectiveMax) {
      const dampRate = isStartled ? 0.08 : 0.28;
      const damped = speed + (effectiveMax - speed) * (1 - Math.exp(-dampRate * dt));
      this.vx = (this.vx / speed) * damped;
      this.vy = (this.vy / speed) * damped;
    } else if (speed < 1.5) {
      this.vx = (this.vx / speed) * 1.5;
      this.vy = (this.vy / speed) * 1.5;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Reset accelerations
    this.ax = 0;
    this.ay = 0;
    this.az = 0;

    // Responsive exponential heading & 3D banking interpolation
    const targetHeading = Math.atan2(this.vy, this.vx);
    let diff = targetHeading - prevHeading;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    const headingEase = 1 - Math.exp(-0.34 * dt);
    this.heading = prevHeading + diff * headingEase;

    const turnRate = diff / Math.max(0.35, dt);
    const targetBank = Math.max(-0.9, Math.min(0.9, turnRate * 4.5 * state.tiltIntensity));
    const bankEase = 1 - Math.exp(-0.22 * dt);
    this.bankAngle += (targetBank - this.bankAngle) * bankEase;

    this.spinPhase += this.spinSpeed * (0.75 + speed * 0.14) * dt;
    this.pulsePhase += 0.055 * dt;

    // Emit magical slipstream micro-sparks (boosted during scatter & return swoops!)
    const boostMult = this.returnSparkBoost > 0 ? 2.4 : 1;
    this.sparkCooldown -= dt * boostMult * (0.65 + speed * 0.14 + Math.abs(this.bankAngle) * 1.5);
    if (state.showSparks && this.sparkCooldown <= 0) {
      this.sparkCooldown = 20 + Math.random() * 38;
      if (auraSparks.length < 300) {
        const shapeIdx = this.pickValidShape();
        const tailDist = this.baseSize * state.scaleMult * 0.35;
        spawnSpark(
          this.x - Math.cos(this.heading) * tailDist + (Math.random() - 0.5) * 6,
          this.y - Math.sin(this.heading) * tailDist + (Math.random() - 0.5) * 6,
          this.vx * 0.2 + (Math.random() - 0.5) * 0.6,
          this.vy * 0.2 + (Math.random() - 0.5) * 0.6 - 0.15,
          this.returnSparkBoost > 0 && Math.random() < 0.35 ? 4 : shapeIdx,
          5 + Math.random() * 7,
          24 + Math.random() * 20,
          this.returnSparkBoost > 0 ? Math.random() < 0.65 : Math.random() < 0.42
        );
      }
    }

    // Record breadcrumb history for smooth Bezier ribbons
    if (state.showTrails) {
      this.history.push({ x: this.x, y: this.y });
      if (this.history.length > 9) this.history.shift();
    } else if (this.history.length > 0) {
      this.history.length = 0;
    }
  }

  draw(ctx) {
    const shapeIdx = this.pickValidShape();
    const img = shapeImages[shapeIdx];
    if (!img || !img.complete) return;

    // Depth-based perspective scale (z in [-0.95, +0.95] -> scale [0.56, 1.32])
    const depthScale = 0.94 + this.z * 0.38;
    const breath = 1 + Math.sin(this.pulsePhase) * 0.045;
    const size = this.baseSize * state.scaleMult * depthScale * breath;
    const speed = Math.hypot(this.vx, this.vy);

    // Draw silky tapered quadratic Bezier ribbon behind element
    if (state.showTrails && this.history.length > 3) {
      const pts = this.history;
      const len = pts.length;
      const rgb = SHAPE_PALETTES[shapeIdx].rgb;
      const baseWidth = Math.max(1.2, size * 0.095);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let seg = 0; seg < 3; seg++) {
        const startIdx = Math.floor((seg / 3) * (len - 2));
        const endIdx = Math.min(len - 2, Math.ceil(((seg + 1) / 3) * (len - 2)) + 1);
        if (endIdx <= startIdx) continue;

        ctx.beginPath();
        const p0 = pts[startIdx];
        const p1 = pts[startIdx + 1];
        ctx.moveTo((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);

        for (let i = startIdx + 1; i < endIdx; i++) {
          const xc = (pts[i].x + pts[i + 1].x) * 0.5;
          const yc = (pts[i].y + pts[i + 1].y) * 0.5;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }

        const segAlpha = (seg + 1) * 0.08 * (0.65 + (this.z + 1) * 0.18);
        ctx.strokeStyle = `rgba(${rgb}, ${segAlpha.toFixed(3)})`;
        ctx.lineWidth = baseWidth * (0.4 + seg * 0.3);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Whisper-soft enchanted luminous halo behind each element
    if (state.showSparks) {
      const haloSize = size * 1.9;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = (0.14 + 0.08 * Math.sin(this.pulsePhase)) * (0.7 + (this.z + 1) * 0.15);
      ctx.drawImage(sparkSprites[shapeIdx].orb, this.x - haloSize * 0.5, this.y - haloSize * 0.5, haloSize, haloSize);
      ctx.restore();
    }

    // Fast pre-rendered soft shadow for foreground depth pop
    if (this.z > 0.15) {
      const shSize = size * 1.15;
      ctx.save();
      ctx.globalAlpha = Math.min(0.4, (this.z - 0.15) * 0.48);
      ctx.drawImage(shadowSprite, this.x - shSize * 0.5, this.y - shSize * 0.5 + 6 * this.z, shSize, shSize);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(this.x, this.y);

    // Rotate toward flight direction + shape natural offset
    const rot = this.heading + SHAPE_ANGLE_OFFSET[shapeIdx];
    ctx.rotate(rot);

    // Smooth 3D banking/pitch squeeze using non-uniform scale
    const pitchStretch = 1 + Math.min(0.18, speed * 0.012) * state.tiltIntensity;
    const bankSqueeze = Math.max(0.48, Math.cos(this.bankAngle * 0.92));
    ctx.scale(pitchStretch, bankSqueeze);

    // Symmetrical shapes also get a gentle organic glide twist
    if (shapeIdx !== 3) {
      ctx.rotate(Math.sin(this.spinPhase) * 0.24 * state.tiltIntensity);
    }

    // Depth opacity so distant elements softly blend and foreground elements gleam
    ctx.globalAlpha = Math.max(0.62, Math.min(1, 0.88 + this.z * 0.2));
    ctx.drawImage(img, -size * 0.5, -size * 0.5, size, size);
    ctx.restore();
  }
}

/* ==========================================================================
   FLOCK MANAGER, GUST SHOCKWAVES & LUMINOUS SPARKS SYSTEM
   ========================================================================== */
const boids = [];
const auraSparks = [];
const ambientMotes = [];
const gustRipples = [];

function spawnSpark(x, y, vx, vy, colorIdx = 1, size = 10, maxLife = 36, isStar = false) {
  auraSparks.push({
    x,
    y,
    vx,
    vy,
    colorIdx: colorIdx % sparkSprites.length,
    size,
    age: 0,
    maxLife,
    isStar,
    twinklePhase: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.18 + Math.random() * 0.18,
    rot: Math.random() * Math.PI
  });
}

function initAmbientMotes() {
  const targetMotes = 34;
  while (ambientMotes.length < targetMotes) {
    ambientMotes.push({
      x: Math.random() * (state.width || 1280),
      y: Math.random() * (state.height || 720),
      vx: (Math.random() - 0.5) * 0.35,
      vy: -0.15 - Math.random() * 0.35,
      size: 6 + Math.random() * 12,
      colorIdx: Math.floor(Math.random() * sparkSprites.length),
      phase: Math.random() * Math.PI * 2,
      isStar: Math.random() < 0.3
    });
  }
}

function updateAndDrawSparks(ctx, dt, time) {
  const w = state.width;
  const h = state.height;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  // 0. Draw expanding iridescent gust shockwave ripples
  for (let i = gustRipples.length - 1; i >= 0; i--) {
    const rp = gustRipples[i];
    rp.age += dt;
    if (rp.age >= rp.maxLife) {
      gustRipples.splice(i, 1);
      continue;
    }
    const p = rp.age / rp.maxLife;
    const easeOut = 1 - Math.pow(1 - p, 3);
    const curR = rp.startRadius + (rp.maxRadius - rp.startRadius) * easeOut;
    const alpha = Math.pow(1 - p, 1.8) * 0.55;

    ctx.strokeStyle = `rgba(${rp.rgb}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, 4.5 * (1 - p));
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, curR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner delicate echo ring
    if (p > 0.08) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.55).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, 2 * (1 - p));
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, curR * 0.72, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (!state.showSparks) {
    auraSparks.length = 0;
    ctx.restore();
    return;
  }

  initAmbientMotes();

  // 1. Update & draw subtle ambient floating stardust motes
  for (let i = 0; i < ambientMotes.length; i++) {
    const m = ambientMotes[i];
    m.x += (m.vx + Math.sin(time * 0.6 + m.phase) * 0.25) * dt;
    m.y += m.vy * dt;

    if (m.y < -20) {
      m.y = h + 20;
      m.x = Math.random() * w;
    }
    if (m.x < -20) m.x = w + 20;
    if (m.x > w + 20) m.x = -20;

    const twinkle = 0.22 + 0.28 * (0.5 + 0.5 * Math.sin(time * 2.2 + m.phase));
    const sprite = m.isStar ? sparkSprites[m.colorIdx].star : sparkSprites[m.colorIdx].orb;
    ctx.globalAlpha = twinkle;
    ctx.drawImage(sprite, m.x - m.size * 0.5, m.y - m.size * 0.5, m.size, m.size);
  }

  // 2. Update & draw active hand/wake sparks
  for (let i = auraSparks.length - 1; i >= 0; i--) {
    const s = auraSparks[i];
    s.age += dt;
    if (s.age >= s.maxLife) {
      auraSparks.splice(i, 1);
      continue;
    }

    const drag = Math.pow(0.955, dt);
    s.vx *= drag;
    s.vy = s.vy * drag - 0.018 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.rot += 0.03 * dt;

    const progress = s.age / s.maxLife;
    const envelope = progress < 0.16
      ? progress / 0.16
      : Math.pow(1 - (progress - 0.16) / 0.84, 1.5);

    const twinkle = s.isStar
      ? 0.65 + 0.35 * Math.sin(s.age * s.twinkleSpeed + s.twinklePhase)
      : 0.8 + 0.2 * Math.sin(s.age * 0.2 + s.twinklePhase);

    const alpha = Math.max(0, Math.min(1, envelope * twinkle * 0.94));
    const drawSize = s.size * (0.75 + 0.45 * (1 - progress));
    const sprite = s.isStar ? sparkSprites[s.colorIdx].star : sparkSprites[s.colorIdx].orb;

    ctx.globalAlpha = alpha;
    if (s.isStar) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.drawImage(sprite, -drawSize * 0.5, -drawSize * 0.5, drawSize, drawSize);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, s.x - drawSize * 0.5, s.y - drawSize * 0.5, drawSize, drawSize);
    }
  }

  ctx.restore();
}

function syncBoidCount() {
  while (boids.length < state.boidCount) {
    boids.push(new Boid(boids.length));
  }
  if (boids.length > state.boidCount) {
    boids.length = state.boidCount;
  }
}

/**
 * Triggers a magical scatter wave away from a quickly moving or close-to-camera hand;
 * startled elements fly outward, shimmer with sparks, then swoop back around.
 */
function triggerHandScatterGust(hand, strength = 1.0, handIdx = 0) {
  const minDim = Math.min(state.width, state.height);
  const maxDist = Math.max(state.width, state.height) * 0.72;
  const clampedStrength = Math.max(0.8, Math.min(1.65, strength));

  state.gustFlashUntil = performance.now() + 1350;
  SoundFX.playScatterGust(clampedStrength);

  // Add subtle expanding shockwave ripple
  gustRipples.push({
    x: hand.x,
    y: hand.y,
    startRadius: (hand.palmRadius || 60) * 0.75,
    maxRadius: minDim * (0.36 + 0.14 * clampedStrength),
    age: 0,
    maxLife: 28,
    rgb: handIdx % 2 === 0 ? '128, 255, 68' : '34, 230, 255'
  });

  // Burst of magical starlight sparks around the hand
  if (state.showSparks) {
    const burstCount = 30;
    for (let s = 0; s < burstCount && auraSparks.length < 300; s++) {
      const ang = (s / burstCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const spd = (3.5 + Math.random() * 7.5) * clampedStrength;
      spawnSpark(
        hand.x + Math.cos(ang) * 18,
        hand.y + Math.sin(ang) * 18,
        Math.cos(ang) * spd + (hand.vx || 0) * 0.25,
        Math.sin(ang) * spd + (hand.vy || 0) * 0.25,
        s % 3 === 0 ? 4 : handIdx % 2 === 0 ? 0 : 1,
        10 + Math.random() * 14,
        28 + Math.random() * 20,
        Math.random() < 0.7
      );
    }
  }

  // Push glossy flock elements radially outward with staggered startle timers so they scatter & return in waves
  for (let i = 0; i < boids.length; i++) {
    const b = boids[i];
    const dx = b.x - hand.x;
    const dy = b.y - hand.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > maxDist) continue;

    const falloff = 1 - dist / maxDist;
    const radialX = dx / dist;
    const radialY = dy / dist;
    // Slight curved swirl + hand swipe direction carry
    const tangX = -radialY * b.orbitSign * 0.32;
    const tangY = radialX * b.orbitSign * 0.32;

    const impulse = (10 + 11 * falloff) * clampedStrength * state.speedMult;
    b.vx = b.vx * 0.25 + (radialX + tangX) * impulse + (hand.vx || 0) * 0.38;
    b.vy = b.vy * 0.25 + (radialY + tangY) * impulse + (hand.vy || 0) * 0.38;

    // Dramatic 3D depth scatter (some soar past lens, some dart back)
    b.z = Math.max(-0.92, Math.min(0.92, b.z + (i % 2 === 0 ? 0.55 : -0.45)));

    // Staggered fly-away duration (~0.45s - 0.9s) before curving smoothly back around
    b.startleTimer = 26 + falloff * 18 + Math.random() * 14;
    b.returnSparkBoost = 55;
  }

  // Also scatter the independent Cyan/Blue Network Element nodes
  for (let i = 0; i < networkNodes.length; i++) {
    const node = networkNodes[i];
    const dx = node.x - hand.x;
    const dy = node.y - hand.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > maxDist) continue;
    const falloff = 1 - dist / maxDist;
    const impulse = (8.5 + 9 * falloff) * clampedStrength * state.speedMult;
    node.vx = node.vx * 0.3 + (dx / dist) * impulse + (hand.vx || 0) * 0.34;
    node.vy = node.vy * 0.3 + (dy / dist) * impulse + (hand.vy || 0) * 0.34;
    node.startleTimer = 22 + falloff * 16 + Math.random() * 12;
  }
}

function scatterFlockBurst() {
  const cx = state.width * 0.5;
  const cy = state.height * 0.5;
  triggerHandScatterGust({ x: cx, y: cy, vx: 0, vy: 0, palmRadius: 65 }, 1.25, 1);
}

/* ==========================================================================
   HAND AURA & ENERGY RING RENDERER
   ========================================================================== */
function drawHandAuras(ctx, hands, time) {
  if (hands.length === 0) return;

  const intensity = state.auraIntensity;

  hands.forEach((hand, idx) => {
    const { x, y, vx = 0, vy = 0, palmRadius = 68, fingertips = [], opacity = 1 } = hand;
    const handSpd = Math.hypot(vx, vy);

    // Emit delicate shimmering sparks from moving hand & fingertips
    if (state.showSparks && opacity > 0.2 && auraSparks.length < 300) {
      const emitChance = Math.min(0.9, 0.16 + handSpd * 0.055);
      if (Math.random() < emitChance) {
        const angle = Math.random() * Math.PI * 2;
        const r = palmRadius * (0.4 + Math.random() * 0.65);
        spawnSpark(
          x + Math.cos(angle) * r,
          y + Math.sin(angle) * r,
          vx * 0.2 + Math.cos(angle) * 0.5,
          vy * 0.2 + Math.sin(angle) * 0.5 - 0.3,
          idx % 2 === 0 ? 0 : 1,
          9 + Math.random() * 10,
          30 + Math.random() * 22,
          Math.random() < 0.45
        );
      }
      if (fingertips.length > 0 && Math.random() < 0.28 + Math.min(0.55, handSpd * 0.045)) {
        const tip = fingertips[Math.floor(Math.random() * fingertips.length)];
        spawnSpark(
          tip.x + (Math.random() - 0.5) * 6,
          tip.y + (Math.random() - 0.5) * 6,
          vx * 0.15 + (Math.random() - 0.5) * 0.8,
          vy * 0.15 + (Math.random() - 0.5) * 0.8 - 0.35,
          4,
          10 + Math.random() * 10,
          26 + Math.random() * 18,
          true
        );
      }
    }

    if (!state.showAura) return;

    const eff = intensity * opacity;
    const primaryHue = idx % 2 === 0 ? '128, 255, 68' : '34, 230, 255';
    const secondaryHue = idx % 2 === 0 ? '34, 230, 255' : '128, 255, 68';

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // 1. Soft radial energy bloom around palm
    const outerRadius = palmRadius * (2.15 + Math.sin(time * 3.2 + idx) * 0.14) * intensity;
    const grad = ctx.createRadialGradient(x, y, palmRadius * 0.08, x, y, outerRadius);
    grad.addColorStop(0, `rgba(255, 255, 255, ${0.42 * eff})`);
    grad.addColorStop(0.28, `rgba(${primaryHue}, ${0.36 * eff})`);
    grad.addColorStop(0.62, `rgba(${secondaryHue}, ${0.16 * eff})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, outerRadius, 0, Math.PI * 2);
    ctx.fill();

    // 2. Rotating segmented tech-organic energy ring around palm
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(time * (idx % 2 === 0 ? 1.0 : -1.0));
    ctx.strokeStyle = `rgba(${primaryHue}, ${0.65 * eff})`;
    ctx.lineWidth = 2.2;
    ctx.setLineDash([18, 12, 6, 12]);
    ctx.beginPath();
    ctx.arc(0, 0, palmRadius * 0.95, 0, Math.PI * 2);
    ctx.stroke();

    // Counter-rotating inner ring
    ctx.rotate(-time * 2.0);
    ctx.strokeStyle = `rgba(${secondaryHue}, ${0.5 * eff})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 14]);
    ctx.beginPath();
    ctx.arc(0, 0, palmRadius * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 3. Glowing fingertip nodes & subtle energy filaments to palm
    fingertips.forEach((tip, tIdx) => {
      const lineGrad = ctx.createLinearGradient(x, y, tip.x, tip.y);
      lineGrad.addColorStop(0, `rgba(${primaryHue}, ${0.12 * eff})`);
      lineGrad.addColorStop(1, `rgba(${secondaryHue}, ${0.55 * eff})`);
      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      const tipRadius = 16 + Math.sin(time * 4.5 + tIdx) * 3;
      const tipGrad = ctx.createRadialGradient(tip.x, tip.y, 1, tip.x, tip.y, tipRadius);
      tipGrad.addColorStop(0, `rgba(255, 255, 255, ${eff})`);
      tipGrad.addColorStop(0.35, `rgba(${secondaryHue}, ${0.85 * eff})`);
      tipGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = tipGrad;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, tipRadius, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  });

  // Harmonic energy bridge & merge sparks when two hands approach
  if (hands.length >= 2 && state.showAura) {
    const h1 = hands[0];
    const h2 = hands[1];
    const dist = Math.hypot(h2.x - h1.x, h2.y - h1.y);
    const mergeThreshold = Math.min(state.width, state.height) * 0.42;
    if (dist < mergeThreshold) {
      const closeness = 1 - dist / mergeThreshold;
      const minOp = Math.min(h1.opacity ?? 1, h2.opacity ?? 1);
      const alpha = closeness * 0.62 * intensity * minOp;

      if (closeness > 0.35 && minOp > 0.5) {
        SoundFX.playDualHandHarmony();
      }

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const bridgeGrad = ctx.createLinearGradient(h1.x, h1.y, h2.x, h2.y);
      bridgeGrad.addColorStop(0, `rgba(128, 255, 68, ${alpha})`);
      bridgeGrad.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * 1.2})`);
      bridgeGrad.addColorStop(1, `rgba(34, 230, 255, ${alpha})`);
      ctx.strokeStyle = bridgeGrad;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(h1.x, h1.y);
      ctx.lineTo(h2.x, h2.y);
      ctx.stroke();
      ctx.restore();

      if (state.showSparks && Math.random() < closeness * 0.55 && auraSparks.length < 300) {
        const t = Math.random();
        spawnSpark(
          h1.x + (h2.x - h1.x) * t + (Math.random() - 0.5) * 12,
          h1.y + (h2.y - h1.y) * t + (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 1.2,
          (Math.random() - 0.5) * 1.2 - 0.3,
          Math.random() < 0.5 ? 0 : 1,
          12 + Math.random() * 10,
          28 + Math.random() * 16,
          true
        );
      }
    }
  }
}

/**
 * Standalone Cyan & Electric-Blue Cyber-Network Constellation Element.
 * Simulates an independent spatial mesh of glowing nodes and interconnecting filaments
 * (separate from the glossy shape elements) that drifts on air currents and weaves smoothly around hands.
 */
const networkNodes = [];

class NetworkNode {
  constructor(index) {
    this.index = index;
    this.isCyan = (index & 1) === 0;
    this.reset();
  }

  reset() {
    const w = state.width || 1280;
    const h = state.height || 720;
    this.x = Math.random() * w;
    this.y = Math.random() * h;
    const angle = Math.random() * Math.PI * 2;
    const spd = 1.2 + Math.random() * 1.6;
    this.vx = Math.cos(angle) * spd;
    this.vy = Math.sin(angle) * spd;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.orbitSign = (this.index % 2 === 0) ? 1 : -1;
    this.orbitSpeed = this.orbitSign * (0.012 + Math.random() * 0.016);
    this.orbitRadius = 90 + Math.random() * 195;
    this.orbitTilt = 0.55 + Math.random() * 0.42;
    this.pulsePhase = Math.random() * Math.PI * 2;
    this.radius = 1.6 + Math.random() * 1.3;
    this.startleTimer = 0;
  }

  update(hands, dt, time) {
    const w = state.width || 1280;
    const h = state.height || 720;
    const minDim = Math.min(w, h) || 720;

    if (this.startleTimer > 0) {
      this.startleTimer = Math.max(0, this.startleTimer - dt);
    }

    const flow = smoothFlowField(this.x * 0.85, this.y * 0.85, time * 0.9 + 1.7);
    let ax = flow.fx * 0.14;
    let ay = flow.fy * 0.14;

    // Attract gently into wide constellation lattice when hands are present and node isn't startled
    let attractFactor = 1;
    if (this.startleTimer > 12) attractFactor = 0;
    else if (this.startleTimer > 0) attractFactor = (12 - this.startleTimer) / 12;

    if (hands && hands.length > 0 && attractFactor > 0.01) {
      this.orbitAngle += this.orbitSpeed * state.speedMult * dt;
      const mySlot = this.index % hands.length;
      const hand = hands.length >= 2
        ? (hands.find((hd) => hd.slotId === mySlot) || hands[mySlot])
        : hands[0];

      // 25% of network nodes bridge dynamically between hands when 2 hands are locked!
      let anchorX = hand.x;
      let anchorY = hand.y;
      if (hands.length >= 2 && (this.index % 4 === 0)) {
        const mix = 0.5 + 0.35 * Math.sin(time * 0.9 + this.index);
        anchorX = hands[0].x * mix + hands[1].x * (1 - mix);
        anchorY = hands[0].y * mix + hands[1].y * (1 - mix);
      }

      const scaleSpan = minDim / 720;
      const rx = this.orbitRadius * scaleSpan * (1 + (hand.closeFactor || 0) * 0.75);
      const ry = rx * this.orbitTilt;
      const targetX = anchorX + Math.cos(this.orbitAngle) * rx;
      const targetY = anchorY + Math.sin(this.orbitAngle) * ry;

      const dx = targetX - this.x;
      const dy = targetY - this.y;
      const dist = Math.hypot(dx, dy) || 1;
      const pull = Math.min(0.45, dist * 0.0025) * attractFactor * (hand.opacity ?? 1);
      ax += (dx / dist) * pull + ((hand.vx || 0) * 0.032);
      ay += (dy / dist) * pull + ((hand.vy || 0) * 0.032);
    } else if (this.startleTimer <= 0) {
      // Wide studio constellation sweep when idle
      const t = time * 0.34 + this.index * 0.41;
      const homeX = w * 0.5 + Math.cos(t * 0.7 + this.index) * (w * 0.42);
      const homeY = h * 0.5 + Math.sin(t * 0.9 + this.index * 0.7) * (h * 0.38);
      ax += (homeX - this.x) * 0.0009;
      ay += (homeY - this.y) * 0.0009;
    }

    // Soft screen margin bounce/turn
    const margin = 44;
    if (this.x < margin) ax += (margin - this.x) * 0.008;
    if (this.x > w - margin) ax -= (this.x - (w - margin)) * 0.008;
    if (this.y < margin) ay += (margin - this.y) * 0.008;
    if (this.y > h - margin) ay -= (this.y - (h - margin)) * 0.008;

    this.vx = (this.vx + ax * dt) * Math.pow(0.965, dt);
    this.vy = (this.vy + ay * dt) * Math.pow(0.965, dt);

    const maxSpd = (this.startleTimer > 0 ? 11.5 : 5.4) * state.speedMult;
    const spd = Math.hypot(this.vx, this.vy);
    if (spd > maxSpd) {
      this.vx = (this.vx / spd) * maxSpd;
      this.vy = (this.vy / spd) * maxSpd;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.pulsePhase += 0.06 * dt;
  }
}

function syncNetworkNodes() {
  const target = state.networkNodeCount || 72;
  while (networkNodes.length < target) {
    networkNodes.push(new NetworkNode(networkNodes.length));
  }
  if (networkNodes.length > target) {
    networkNodes.length = target;
  }
}

function updateNetworkNodes(hands, dt, time) {
  if (!state.showNetworkLines) return;
  syncNetworkNodes();
  for (let i = 0; i < networkNodes.length; i++) {
    networkNodes[i].update(hands, dt, time);
  }
}

function drawNetworkLines(ctx, hands, time) {
  if (!state.showNetworkLines || networkNodes.length === 0) return;

  const w = state.width || 1280;
  const h = state.height || 720;
  const minDim = Math.max(320, Math.min(w, h));
  const maxDist = minDim * 0.19;
  const maxDistSq = maxDist * maxDist;
  const n = networkNodes.length;

  const cyanSoft = [];
  const cyanStrong = [];
  const blueSoft = [];
  const blueStrong = [];
  const cyanTethers = [];
  const blueTethers = [];
  const seenEdges = new Set();

  // Connect each independent network node to up to 3 nearest sibling network nodes
  for (let i = 0; i < n; i++) {
    const a = networkNodes[i];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;

    let idx0 = -1, idx1 = -1, idx2 = -1;
    let d0 = maxDistSq, d1 = maxDistSq, d2 = maxDistSq;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = networkNodes[j];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const dx = b.x - a.x;
      if (dx > maxDist || dx < -maxDist) continue;
      const dy = b.y - a.y;
      if (dy > maxDist || dy < -maxDist) continue;
      const dSq = dx * dx + dy * dy;
      if (dSq >= d2) continue;

      if (dSq < d0) {
        d2 = d1; idx2 = idx1;
        d1 = d0; idx1 = idx0;
        d0 = dSq; idx0 = j;
      } else if (dSq < d1) {
        d2 = d1; idx2 = idx1;
        d1 = dSq; idx1 = j;
      } else {
        d2 = dSq; idx2 = j;
      }
    }

    const candidates = [idx0, idx1, idx2];
    const dists = [d0, d1, d2];
    for (let k = 0; k < 3; k++) {
      const j = candidates[k];
      if (j < 0) continue;
      const minIdx = i < j ? i : j;
      const maxIdx = i < j ? j : i;
      const key = minIdx * 1024 + maxIdx;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);

      const b = networkNodes[j];
      const closeness = 1 - Math.sqrt(dists[k]) / maxDist;
      const isCyan = a.isCyan !== b.isCyan ? ((minIdx + maxIdx) & 1) === 0 : a.isCyan;
      const strong = closeness > 0.42;

      if (isCyan) {
        (strong ? cyanStrong : cyanSoft).push(a.x, a.y, b.x, b.y);
      } else {
        (strong ? blueStrong : blueSoft).push(a.x, a.y, b.x, b.y);
      }
    }
  }

  // Neural filaments connecting locked palms to nearest standalone network nodes
  const tetherMax = minDim * 0.35;
  const tetherMaxSq = tetherMax * tetherMax;
  if (hands && hands.length > 0) {
    for (let hIdx = 0; hIdx < hands.length; hIdx++) {
      const hand = hands[hIdx];
      if (!hand || !Number.isFinite(hand.x) || !Number.isFinite(hand.y)) continue;
      if ((hand.opacity ?? 1) <= 0.08) continue;

      const nearest = [];
      for (let i = 0; i < n; i++) {
        const node = networkNodes[i];
        if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        const dx = node.x - hand.x;
        const dy = node.y - hand.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < tetherMaxSq) {
          nearest.push({ x: node.x, y: node.y, dSq, isCyan: node.isCyan });
        }
      }
      nearest.sort((u, v) => u.dSq - v.dSq);
      const limit = Math.min(9, nearest.length);
      for (let m = 0; m < limit; m++) {
        const target = nearest[m];
        if (target.isCyan) {
          cyanTethers.push(hand.x, hand.y, target.x, target.y);
        } else {
          blueTethers.push(hand.x, hand.y, target.x, target.y);
        }
      }
    }
  }

  const strokeSegments = (coords, style, lineWidth) => {
    if (coords.length === 0) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let i = 0; i < coords.length; i += 4) {
      ctx.moveTo(coords[i], coords[i + 1]);
      ctx.lineTo(coords[i + 2], coords[i + 3]);
    }
    ctx.stroke();
  };

  const pulse = 0.85 + 0.15 * Math.sin(time * 2.5);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  strokeSegments(blueSoft, `rgba(26, 128, 255, ${(0.22 * pulse).toFixed(3)})`, 1.0);
  strokeSegments(cyanSoft, `rgba(0, 255, 201, ${(0.2 * pulse).toFixed(3)})`, 0.95);
  strokeSegments(blueStrong, `rgba(0, 149, 255, ${(0.45 * pulse).toFixed(3)})`, 1.45);
  strokeSegments(cyanStrong, `rgba(34, 230, 255, ${(0.42 * pulse).toFixed(3)})`, 1.35);
  strokeSegments(blueTethers, `rgba(30, 138, 255, ${(0.34 * pulse).toFixed(3)})`, 1.15);
  strokeSegments(cyanTethers, `rgba(0, 255, 201, ${(0.32 * pulse).toFixed(3)})`, 1.1);

  // Soft outer glow halos & crisp core junction nodes of the standalone network element
  ctx.fillStyle = `rgba(0, 255, 201, ${(0.18 * pulse).toFixed(3)})`;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const node = networkNodes[i];
    if (!node.isCyan) continue;
    const hr = node.radius * 2.6;
    ctx.moveTo(node.x + hr, node.y);
    ctx.arc(node.x, node.y, hr, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.fillStyle = `rgba(48, 155, 255, ${(0.2 * pulse).toFixed(3)})`;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const node = networkNodes[i];
    if (node.isCyan) continue;
    const hr = node.radius * 2.6;
    ctx.moveTo(node.x + hr, node.y);
    ctx.arc(node.x, node.y, hr, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.fillStyle = `rgba(0, 255, 201, ${(0.78 * pulse).toFixed(3)})`;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const node = networkNodes[i];
    if (!node.isCyan) continue;
    ctx.moveTo(node.x + node.radius, node.y);
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.fillStyle = `rgba(64, 170, 255, ${(0.8 * pulse).toFixed(3)})`;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const node = networkNodes[i];
    if (node.isCyan) continue;
    ctx.moveTo(node.x + node.radius, node.y);
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.restore();
}

/* ==========================================================================
   CAMERA & MEDIAPIPE HAND TRACKING
   ========================================================================== */
let mpHands = null;
let isProcessingFrame = false;
const mpInputCanvas = document.createElement('canvas');
const mpInputCtx = mpInputCanvas.getContext('2d');

async function initCameraAndTracking() {
  setupMediaPipeHands();
  await startWebcam();
}

function setupMediaPipeHands() {
  if (typeof window.Hands === 'undefined') {
    statusEl.textContent = 'Interactive Motion Mode Ready';
    return;
  }

  try {
    mpHands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    // Low-latency dual-hand inference settings for snappy 2-hand responsiveness
    mpHands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.45
    });

    mpHands.onResults(onMediaPipeResults);
    state.mpReady = true;
  } catch (err) {
    console.warn('MediaPipe initialization fallback:', err);
    state.mpReady = false;
  }
}

function onMediaPipeResults(results) {
  if (state.virtualHandsMode) return;

  const w = state.width;
  const h = state.height;
  const rawHands = [];

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    const scale = Math.max(w / vw, h / vh);
    const sw = vw * scale;
    const sh = vh * scale;
    const ox = (w - sw) * 0.5;
    const oy = (h - sh) * 0.5;

    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
      const lm = results.multiHandLandmarks[i];
      const mapX = (nx) => ox + (state.mirrorCam ? 1 - nx : nx) * sw;
      const mapY = (ny) => oy + ny * sh;

      // Palm center approximated from wrist (0), index MCP (5), pinky MCP (17), middle MCP (9)
      const palmX = (mapX(lm[0].x) + mapX(lm[5].x) + mapX(lm[9].x) + mapX(lm[17].x)) / 4;
      const palmY = (mapY(lm[0].y) + mapY(lm[5].y) + mapY(lm[9].y) + mapY(lm[17].y)) / 4;

      // Fingertip indices: 4 (thumb), 8 (index), 12 (middle), 16 (ring), 20 (pinky)
      const tipIndices = [4, 8, 12, 16, 20];
      const fingertips = tipIndices.map((idx) => ({
        x: mapX(lm[idx].x),
        y: mapY(lm[idx].y)
      }));

      // Estimate hand scale & camera closeness from both palm length & palm width
      const wristToMiddle = Math.hypot(
        mapX(lm[9].x) - mapX(lm[0].x),
        mapY(lm[9].y) - mapY(lm[0].y)
      );
      const palmWidth = Math.hypot(
        mapX(lm[17].x) - mapX(lm[5].x),
        mapY(lm[17].y) - mapY(lm[5].y)
      );
      const apparentScale = Math.max(wristToMiddle, palmWidth * 1.18);

      rawHands.push({
        x: palmX,
        y: palmY,
        palmRadius: Math.max(36, Math.min(220, apparentScale * 0.92)),
        fingertips
      });
    }
  }

  updateSmoothedHands(rawHands);
}

function updateSmoothedHands(rawHands) {
  const prevHands = state.smoothedHands;
  const nextSmoothed = [];
  const minDim = Math.min(state.width, state.height) || 720;

  // Thresholds for quick-movement swipe and close-to-camera lunge scatter
  const quickMoveThreshold = minDim * 0.02;
  const swipeChimeThreshold = minDim * 0.011;
  const closeRatioThreshold = 0.145;
  const lungeGrowthThreshold = minDim * 0.0042;

  // Optimal nearest-neighbor matching between raw MediaPipe detections and tracked slots (prevents 2-hand ID swaps)
  const pairedPrev = new Array(rawHands.length).fill(null);
  const usedPrevIdx = new Set();

  if (rawHands.length === 1 && prevHands.length >= 1) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let p = 0; p < prevHands.length; p++) {
      const d = Math.hypot(rawHands[0].x - prevHands[p].x, rawHands[0].y - prevHands[p].y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = p;
      }
    }
    pairedPrev[0] = prevHands[bestIdx];
    usedPrevIdx.add(bestIdx);
  } else if (rawHands.length >= 2 && prevHands.length >= 2) {
    const d00 = Math.hypot(rawHands[0].x - prevHands[0].x, rawHands[0].y - prevHands[0].y);
    const d11 = Math.hypot(rawHands[1].x - prevHands[1].x, rawHands[1].y - prevHands[1].y);
    const d01 = Math.hypot(rawHands[0].x - prevHands[1].x, rawHands[0].y - prevHands[1].y);
    const d10 = Math.hypot(rawHands[1].x - prevHands[0].x, rawHands[1].y - prevHands[0].y);
    if (d00 + d11 <= d01 + d10) {
      pairedPrev[0] = prevHands[0];
      pairedPrev[1] = prevHands[1];
      usedPrevIdx.add(0);
      usedPrevIdx.add(1);
    } else {
      pairedPrev[0] = prevHands[1];
      pairedPrev[1] = prevHands[0];
      usedPrevIdx.add(0);
      usedPrevIdx.add(1);
    }
  } else if (rawHands.length >= 2 && prevHands.length === 1) {
    const d0 = Math.hypot(rawHands[0].x - prevHands[0].x, rawHands[0].y - prevHands[0].y);
    const d1 = Math.hypot(rawHands[1].x - prevHands[0].x, rawHands[1].y - prevHands[0].y);
    const matchIdx = d0 <= d1 ? 0 : 1;
    pairedPrev[matchIdx] = prevHands[0];
    usedPrevIdx.add(0);
  }

  const usedSlotIds = new Set(pairedPrev.filter(Boolean).map((h) => h.slotId ?? 0));

  for (let i = 0; i < rawHands.length; i++) {
    const raw = rawHands[i];
    const prev = pairedPrev[i];

    if (prev) {
      const dist = Math.hypot(raw.x - prev.x, raw.y - prev.y);
      // Fast, responsive adaptive smoothing with snappy 2-hand velocity tracking
      const alpha = Math.min(0.94, 0.56 + dist * 0.011);
      const sx = prev.x + (raw.x - prev.x) * alpha;
      const sy = prev.y + (raw.y - prev.y) * alpha;
      const vx = prev.vx * 0.25 + (sx - prev.x) * 0.75;
      const vy = prev.vy * 0.25 + (sy - prev.y) * 0.75;
      const speed = Math.hypot(vx, vy);

      const newRadius = prev.palmRadius + (raw.palmRadius - prev.palmRadius) * 0.48;
      const palmGrowth = newRadius - prev.palmRadius;
      const palmRatio = newRadius / minDim;
      const closeFactor = Math.max(0, Math.min(1, (palmRatio - 0.13) / 0.09));
      const isClose = palmRatio > closeRatioThreshold;
      const wasClose = Boolean(prev.wasClose);
      let burstCooldown = Math.max(0, (prev.burstCooldown || 0) - 1);

      const fingertips = (raw.fingertips || []).map((tip, idx) => {
        const pTip = prev.fingertips && prev.fingertips[idx] ? prev.fingertips[idx] : tip;
        const tipAlpha = Math.min(0.96, alpha + 0.08);
        return {
          x: pTip.x + (tip.x - pTip.x) * tipAlpha,
          y: pTip.y + (tip.y - pTip.y) * tipAlpha
        };
      });

      const slotId = prev.slotId !== undefined ? prev.slotId : i;
      const handObj = {
        slotId,
        x: sx,
        y: sy,
        vx,
        vy,
        speed,
        palmRadius: newRadius,
        palmRatio,
        closeFactor,
        wasClose: isClose,
        burstCooldown,
        fingertips,
        opacity: Math.min(1, (prev.opacity ?? 0.55) + 0.25),
        missingFrames: 0
      };

      if (speed > swipeChimeThreshold) {
        SoundFX.playSwipeChime(Math.min(1, speed / (minDim * 0.045)));
      }

      // Trigger magical fly-away scatter on quick swipe OR moving closer to camera!
      const isQuickSwipe = speed > quickMoveThreshold;
      const isCameraLunge = (palmGrowth > lungeGrowthThreshold && palmRatio > 0.105) || (isClose && !wasClose);
      if (state.enableGustScatter && burstCooldown <= 0 && (isQuickSwipe || isCameraLunge)) {
        const gustStr = Math.max(
          isQuickSwipe ? Math.min(1.55, 0.95 + (speed - quickMoveThreshold) / (minDim * 0.03)) : 0,
          isCameraLunge ? 1.25 : 0
        );
        triggerHandScatterGust(handObj, gustStr, slotId);
        handObj.burstCooldown = 32;
      }

      nextSmoothed.push(handObj);
    } else {
      let freeSlot = 0;
      while (usedSlotIds.has(freeSlot)) freeSlot++;
      usedSlotIds.add(freeSlot);

      const palmRatio = (raw.palmRadius || 68) / minDim;
      SoundFX.playHandAppear(freeSlot);
      nextSmoothed.push({
        slotId: freeSlot,
        x: raw.x,
        y: raw.y,
        vx: 0,
        vy: 0,
        speed: 0,
        palmRadius: raw.palmRadius || 68,
        palmRatio,
        closeFactor: Math.max(0, Math.min(1, (palmRatio - 0.13) / 0.09)),
        wasClose: palmRatio > closeRatioThreshold,
        burstCooldown: 10,
        fingertips: raw.fingertips || [],
        opacity: 0.65,
        missingFrames: 0
      });
    }
  }

  // Smoothly coast unmatched hands briefly so temporary 1-2 frame occlusion doesn't drop a flock split
  for (let p = 0; p < prevHands.length; p++) {
    if (usedPrevIdx.has(p)) continue;
    const prev = prevHands[p];
    if (prev && (prev.missingFrames || 0) < 8) {
      const mf = (prev.missingFrames || 0) + 1;
      const fadedOp = Math.max(0, (prev.opacity ?? 1) - 0.14);
      if (fadedOp > 0.04) {
        nextSmoothed.push({
          ...prev,
          x: prev.x + prev.vx * 0.4,
          y: prev.y + prev.vy * 0.4,
          vx: prev.vx * 0.8,
          vy: prev.vy * 0.8,
          burstCooldown: Math.max(0, (prev.burstCooldown || 0) - 1),
          opacity: fadedOp,
          missingFrames: mf
        });
      }
    }
  }

  nextSmoothed.sort((a, b) => (a.slotId ?? 0) - (b.slotId ?? 0));
  state.smoothedHands = nextSmoothed;

  // Update status indicator
  const camBadge = state.cameraFacing === 'environment' ? 'Rear Cam' : 'Front Cam';
  if (performance.now() < state.gustFlashUntil) {
    statusEl.textContent = '✦ Gust Burst • Elements Scattering & Returning';
  } else if (state.virtualHandsMode) {
    statusEl.textContent = 'Virtual Dual-Hand Simulation • Swipe or Hold Click to Scatter';
  } else if (state.smoothedHands.length === 2) {
    statusEl.textContent = `${camBadge} • 2 Hands Locked (High-Response Split)`;
  } else if (state.smoothedHands.length === 1) {
    statusEl.textContent = `${camBadge} • 1 Hand Locked • Swipe or Approach to Scatter`;
  } else if (state.camActive) {
    statusEl.textContent = `${camBadge} Live • Raise Hands to Attract Flock`;
  }
}

let activeCameraDeviceId = null;
let camRequestSeq = 0;

function stopCurrentWebcamStream() {
  const existing = videoEl.srcObject;
  if (existing && typeof existing.getTracks === 'function') {
    existing.getTracks().forEach((track) => track.stop());
  }
  videoEl.srcObject = null;
}

function updateCameraUIState() {
  const labelEl = document.getElementById('cam-facing-label');
  const chkMirror = document.getElementById('chk-mirror');
  if (labelEl) {
    labelEl.textContent = state.cameraFacing === 'environment' ? 'Rear Cam' : 'Front Cam';
  }
  if (chkMirror) {
    chkMirror.checked = state.mirrorCam;
  }
}

async function startWebcam(preferredFacing = state.cameraFacing, specificDeviceId = null) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    enableVirtualSimulation('Camera API unavailable in this browser context.');
    return;
  }

  const reqSeq = ++camRequestSeq;
  stopCurrentWebcamStream();

  try {
    const videoConstraints = specificDeviceId
      ? {
          deviceId: { exact: specificDeviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      : {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: { ideal: preferredFacing }
        };

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });

    if (reqSeq !== camRequestSeq) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const track = stream.getVideoTracks()[0];
    if (track && typeof track.getSettings === 'function') {
      const settings = track.getSettings();
      if (settings.deviceId) activeCameraDeviceId = settings.deviceId;
      if (settings.facingMode === 'environment' || settings.facingMode === 'user') {
        state.cameraFacing = settings.facingMode;
      } else {
        state.cameraFacing = preferredFacing;
      }
    } else {
      state.cameraFacing = preferredFacing;
    }

    state.mirrorCam = state.cameraFacing !== 'environment';
    updateCameraUIState();

    videoEl.srcObject = stream;
    await videoEl.play();
    if (reqSeq !== camRequestSeq) return;
    state.camActive = true;
    cameraPromptEl.classList.add('hidden');
    const camBadge = state.cameraFacing === 'environment' ? 'Rear Cam' : 'Front Cam';
    statusEl.textContent = `${camBadge} Live • Raise Hands to Attract Flock`;
  } catch (err) {
    if (reqSeq !== camRequestSeq) return;
    console.warn('Webcam permission or hardware unavailable, enabling interactive simulation:', err);
    state.camActive = false;
    enableVirtualSimulation();
  }
}

async function switchCamera() {
  SoundFX.playClick();
  const nextFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  state.cameraFacing = nextFacing;
  state.mirrorCam = nextFacing === 'user';
  updateCameraUIState();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  const reqSeq = ++camRequestSeq;
  stopCurrentWebcamStream();

  // Attempt 1: exact facingMode (switches front <-> rear reliably on phones/iPads)
  try {
    const exactStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: { exact: nextFacing }
      },
      audio: false
    });
    if (reqSeq !== camRequestSeq) {
      exactStream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = exactStream.getVideoTracks()[0];
    if (track && track.getSettings) {
      activeCameraDeviceId = track.getSettings().deviceId || activeCameraDeviceId;
    }
    videoEl.srcObject = exactStream;
    await videoEl.play();
    if (reqSeq !== camRequestSeq) return;
    state.camActive = true;
    statusEl.textContent = `${nextFacing === 'environment' ? 'Rear Cam' : 'Front Cam'} Active • Raise Hands`;
    return;
  } catch {
    if (reqSeq !== camRequestSeq) return;
  }

  // Attempt 2: cycle through multiple videoinput devices (e.g. Mac + Continuity / external USB cam)
  try {
    if (navigator.mediaDevices.enumerateDevices) {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      if (reqSeq !== camRequestSeq) return;
      if (devices.length > 1) {
        const curIdx = devices.findIndex((d) => d.deviceId === activeCameraDeviceId);
        const nextDevice = devices[(curIdx + 1) % devices.length];
        await startWebcam(nextFacing, nextDevice.deviceId);
        return;
      }
    }
  } catch {
    if (reqSeq !== camRequestSeq) return;
  }

  // Attempt 3: single-camera system fallback with updated facing/mirror preference
  await startWebcam(nextFacing);
}

function enableVirtualSimulation() {
  state.virtualHandsMode = true;
  document.getElementById('btn-toggle-sim').classList.add('active');
  cameraPromptEl.classList.add('hidden');
  statusEl.textContent = 'Virtual Dual-Hand Simulation • Swipe or Hold Click to Scatter';
}

function buildSimulatedHands(time) {
  const w = state.width;
  const h = state.height;
  const minDim = Math.min(w, h) || 720;
  const hands = [];
  // Holding mouse/touch simulates pushing hand closer to camera!
  const simPalmR = state.pointerPressed ? Math.max(125, minDim * 0.175) : 64;

  if (state.virtualHandsMode) {
    const h1x = state.pointerActive
      ? state.pointerX * w
      : w * 0.5 + Math.sin(time * 0.72) * (w * 0.24);
    const h1y = state.pointerActive
      ? state.pointerY * h
      : h * 0.5 + Math.sin(time * 1.44) * (h * 0.16);

    const h2x = w * 0.5 - Math.sin(time * 0.65 + 0.6) * (w * 0.24);
    const h2y = h * 0.5 + Math.cos(time * 1.15) * (h * 0.17);

    [
      { x: h1x, y: h1y, phase: 0, radius: state.pointerActive ? simPalmR : 64 },
      { x: h2x, y: h2y, phase: 2.1, radius: 64 }
    ].forEach((pos) => {
      const tips = [];
      for (let f = 0; f < 5; f++) {
        const ang = -Math.PI * 0.85 + (f / 4) * (Math.PI * 0.7) + Math.sin(time * 2 + pos.phase + f) * 0.08;
        const r = pos.radius + Math.sin(time * 3 + f) * 6;
        tips.push({
          x: pos.x + Math.cos(ang) * r,
          y: pos.y + Math.sin(ang) * r
        });
      }
      hands.push({
        x: pos.x,
        y: pos.y,
        palmRadius: pos.radius,
        fingertips: tips
      });
    });

    updateSmoothedHands(hands);
  } else if (state.pointerActive) {
    const px = state.pointerX * w;
    const py = state.pointerY * h;
    const tips = [];
    for (let f = 0; f < 5; f++) {
      const ang = -Math.PI * 0.85 + (f / 4) * (Math.PI * 0.7);
      tips.push({
        x: px + Math.cos(ang) * simPalmR,
        y: py + Math.sin(ang) * simPalmR
      });
    }
    updateSmoothedHands([{ x: px, y: py, palmRadius: simPalmR, fingertips: tips }]);
  }
}

/* ==========================================================================
   BACKGROUND & CAMERA FEED RENDERER
   ========================================================================== */
function drawCameraCover(ctx, w, h, time) {
  if (state.camActive && videoEl.readyState >= 2) {
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    const scale = Math.max(w / vw, h / vh);
    const sw = vw * scale;
    const sh = vh * scale;
    const ox = (w - sw) * 0.5;
    const oy = (h - sh) * 0.5;

    ctx.save();
    if (state.mirrorCam) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, ox, oy, sw, sh);
    ctx.restore();

    // Subtle cinematic vignette so glossy elements pop
    const vig = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.35, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(2, 8, 18, 0.38)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  } else {
    // Rich interactive dark studio backdrop when camera is off / in virtual mode
    const bgGrad = ctx.createRadialGradient(
      w * 0.5 + Math.sin(time * 0.4) * (w * 0.15),
      h * 0.45 + Math.cos(time * 0.3) * (h * 0.12),
      40,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.85
    );
    bgGrad.addColorStop(0, '#102542');
    bgGrad.addColorStop(0.55, '#071324');
    bgGrad.addColorStop(1, '#030710');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle studio grid lines
    ctx.save();
    ctx.strokeStyle = 'rgba(34, 230, 255, 0.05)';
    ctx.lineWidth = 1;
    const step = 64;
    for (let x = (w % step) * 0.5; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = (h % step) * 0.5; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ==========================================================================
   MAIN RENDER & SIMULATION LOOP
   ========================================================================== */
let lastTime = performance.now();

function resizeCanvas() {
  const rect = stageEl.getBoundingClientRect();
  state.width = Math.max(320, Math.floor(rect.width));
  state.height = Math.max(320, Math.floor(rect.height));
  canvas.width = state.width;
  canvas.height = state.height;
}

function tick(now) {
  const dt = Math.min(2.2, (now - lastTime) / 16.667);
  lastTime = now;
  state.time += 0.016 * dt;

  // Send compact downscaled webcam frame to MediaPipe Hands for fast dual-hand latency
  if (state.camActive && state.mpReady && !state.virtualHandsMode && !isProcessingFrame && videoEl.readyState >= 2) {
    isProcessingFrame = true;
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;
    const targetW = Math.min(480, vw);
    const targetH = Math.max(180, Math.round((vh / vw) * targetW));
    if (mpInputCanvas.width !== targetW || mpInputCanvas.height !== targetH) {
      mpInputCanvas.width = targetW;
      mpInputCanvas.height = targetH;
    }
    mpInputCtx.drawImage(videoEl, 0, 0, targetW, targetH);
    mpHands.send({ image: mpInputCanvas }).finally(() => {
      isProcessingFrame = false;
    });
  }

  // If in virtual simulation or mouse/touch fallback, update virtual hands
  if (state.virtualHandsMode || ((!state.camActive || !state.mpReady) && state.pointerActive)) {
    buildSimulatedHands(state.time);
  }

  const w = state.width;
  const h = state.height;

  // 1. Draw mirrored camera feed (or studio backdrop)
  drawCameraCover(ctx, w, h, state.time);

  // 2. Update independent Cyber Network Constellation element & glossy 3D boids
  updateNetworkNodes(state.smoothedHands, dt, state.time);
  syncBoidCount();
  for (let i = 0; i < boids.length; i++) {
    boids[i].update(boids, state.smoothedHands, dt, state.time);
  }
  const sortedBoids = boids.slice().sort((a, b) => a.z - b.z);

  // 3. Layer depth cleanly: Background elements -> Independent Cyan/Blue Network Element -> Hand Aura & Sparks -> Foreground elements
  for (let i = 0; i < sortedBoids.length; i++) {
    if (sortedBoids[i].z < 0) sortedBoids[i].draw(ctx);
  }

  drawNetworkLines(ctx, state.smoothedHands, state.time);
  drawHandAuras(ctx, state.smoothedHands, state.time);
  updateAndDrawSparks(ctx, dt, state.time);

  for (let i = 0; i < sortedBoids.length; i++) {
    if (sortedBoids[i].z >= 0) sortedBoids[i].draw(ctx);
  }

  requestAnimationFrame(tick);
}

/* ==========================================================================
   VIDEO BOOTH CAPTURE (3s COUNTDOWN, BOOMERANG, VIDEO, SNAPSHOT)
   ========================================================================== */
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNumEl = document.getElementById('countdown-number');
const recIndicator = document.getElementById('recording-indicator');
const recLabel = document.getElementById('rec-label');
const recTimer = document.getElementById('rec-timer');
const recProgressFill = document.getElementById('rec-progress-fill');
const btnRecord = document.getElementById('btn-record');

const previewModal = document.getElementById('preview-modal');
const previewVideo = document.getElementById('preview-video');
const previewImage = document.getElementById('preview-image');
const previewBadge = document.getElementById('preview-badge');
const btnDownload = document.getElementById('btn-download');
const downloadLabel = document.getElementById('download-label');

async function triggerBoothCapture() {
  if (state.isRecording || state.isCountingDown) return;
  SoundFX.unlock();

  if (state.useCountdown) {
    state.isCountingDown = true;
    countdownOverlay.classList.remove('hidden');
    for (let c = 3; c >= 1; c--) {
      countdownNumEl.textContent = String(c);
      SoundFX.playCountdownBeep(c);
      await new Promise((r) => setTimeout(r, 900));
    }
    countdownOverlay.classList.add('hidden');
    state.isCountingDown = false;
  }

  SoundFX.playCaptureChime(false);
  if (state.captureMode === 'snapshot') {
    captureSnapshot();
  } else if (state.captureMode === 'boomerang') {
    captureBoomerang();
  } else {
    captureStandardVideo(5000);
  }
}

function captureSnapshot() {
  const dataUrl = canvas.toDataURL('image/png');
  SoundFX.playCaptureChime(true);
  showPreviewModal({
    type: 'image',
    url: dataUrl,
    filename: `aeroflock-snapshot-${Date.now()}.png`,
    badge: 'SNAPSHOT CAPTURED',
    buttonText: 'Download PNG Snapshot'
  });
}

function getSupportedMimeType() {
  const types = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1.4d002a',
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function getSupportedMp4MimeType() {
  const mime = getSupportedMimeType();
  return mime.includes('mp4') ? mime : '';
}

let mp4MuxerModPromise = null;
function loadMp4Muxer() {
  if (!mp4MuxerModPromise) {
    mp4MuxerModPromise = import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm');
  }
  return mp4MuxerModPromise;
}

/**
 * Creates a WebCodecs H.264 + mp4-muxer encoding session so Video and Boomerang captures
 * export directly to .mp4 even on browsers whose MediaRecorder only supports WebM.
 */
async function createMp4FrameSession(width, height, fps = 30) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs VideoEncoder unavailable');
  }

  const encW = Math.max(2, width & ~1);
  const encH = Math.max(2, height & ~1);
  const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();

  const avcCodecs = ['avc1.640033', 'avc1.4d002a', 'avc1.42002a', 'avc1.42001f'];
  let chosenConfig = null;
  for (const codec of avcCodecs) {
    const cfg = {
      codec,
      width: encW,
      height: encH,
      bitrate: 8_000_000,
      framerate: fps
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support && support.supported) {
        chosenConfig = support.config || cfg;
        break;
      }
    } catch {
      // Try next H.264 profile/level
    }
  }
  if (!chosenConfig) {
    throw new Error('No supported H.264 VideoEncoder config found');
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: encW,
      height: encH
    },
    fastStart: 'in-memory'
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    }
  });
  encoder.configure(chosenConfig);

  const encCanvas = document.createElement('canvas');
  encCanvas.width = encW;
  encCanvas.height = encH;
  const encCtx = encCanvas.getContext('2d');
  const frameDurationUs = Math.round(1_000_000 / fps);
  const keyInterval = Math.max(1, Math.round(fps));

  return {
    addFrame(sourceCanvas, frameIndex) {
      if (encodeError) throw encodeError;
      encCtx.clearRect(0, 0, encW, encH);
      encCtx.drawImage(sourceCanvas, 0, 0, encW, encH);
      const frame = new VideoFrame(encCanvas, {
        timestamp: frameIndex * frameDurationUs,
        duration: frameDurationUs
      });
      encoder.encode(frame, { keyFrame: frameIndex % keyInterval === 0 });
      frame.close();
    },
    async finish() {
      if (encodeError) throw encodeError;
      await encoder.flush();
      encoder.close();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    }
  };
}

function showVideoDownloadModal(blob, prefix, mimeType) {
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const isBoomerang = prefix === 'boomerang';
  SoundFX.playCaptureChime(true);
  finishRecordingUI();
  showPreviewModal({
    type: 'video',
    url,
    filename: `aeroflock-${prefix}-${Date.now()}.${ext}`,
    badge: isBoomerang ? `BOOMERANG LOOP READY (.${ext.toUpperCase()})` : `VIDEO CLIP READY (.${ext.toUpperCase()})`,
    buttonText: isBoomerang ? `Download ${ext.toUpperCase()} Boomerang` : `Download ${ext.toUpperCase()} Video`
  });
}

function recordStreamWithMediaRecorder(stream, durationMs, prefix, label, fallbackMime) {
  const mimeType = fallbackMime || getSupportedMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const outMime = mimeType || 'video/webm';
    const blob = new Blob(chunks, { type: outMime });
    showVideoDownloadModal(blob, prefix, outMime);
  };

  startRecordingUI(label, durationMs);
  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, durationMs);
}

async function captureStandardVideo(durationMs = 5000) {
  const mp4Mime = getSupportedMp4MimeType();
  if (mp4Mime) {
    const stream = canvas.captureStream(60);
    recordStreamWithMediaRecorder(stream, durationMs, 'video', 'REC MP4', mp4Mime);
    return;
  }

  if (typeof VideoEncoder !== 'undefined') {
    state.isRecording = true;
    try {
      const fps = 30;
      const session = await createMp4FrameSession(canvas.width, canvas.height, fps);
      let frameIdx = 0;
      startRecordingUI('REC MP4', durationMs);

      const frameTimer = setInterval(() => {
        try {
          session.addFrame(canvas, frameIdx++);
        } catch (err) {
          console.warn('Frame capture warning:', err);
        }
      }, 1000 / fps);

      setTimeout(async () => {
        clearInterval(frameTimer);
        recLabel.textContent = 'FINALIZING MP4...';
        try {
          const blob = await session.finish();
          showVideoDownloadModal(blob, 'video', 'video/mp4');
        } catch (err) {
          console.warn('WebCodecs MP4 finalization failed:', err);
          finishRecordingUI();
        }
      }, durationMs);
      return;
    } catch (err) {
      console.warn('WebCodecs MP4 unavailable, falling back to MediaRecorder:', err);
      state.isRecording = false;
    }
  }

  const stream = canvas.captureStream(60);
  recordStreamWithMediaRecorder(stream, durationMs, 'video', 'REC VIDEO', getSupportedMimeType());
}

/**
 * Captures frames for 1.6s and encodes a forward + reverse ping-pong Boomerang video in MP4!
 */
function captureBoomerang() {
  const captureDurationMs = 1600;
  const fps = 30;
  const frames = [];

  startRecordingUI('BOOMERANG', captureDurationMs);

  const frameInterval = setInterval(() => {
    const frameCopy = document.createElement('canvas');
    frameCopy.width = canvas.width;
    frameCopy.height = canvas.height;
    frameCopy.getContext('2d').drawImage(canvas, 0, 0);
    frames.push(frameCopy);
  }, 1000 / fps);

  setTimeout(async () => {
    clearInterval(frameInterval);
    recLabel.textContent = 'ENCODING MP4...';

    // Build ping-pong sequence: Forward + Reverse + Forward + Reverse
    const pingPongSeq = [
      ...frames,
      ...frames.slice(1, -1).reverse(),
      ...frames,
      ...frames.slice(1, -1).reverse()
    ];

    if (typeof VideoEncoder !== 'undefined' && pingPongSeq.length > 0) {
      try {
        const session = await createMp4FrameSession(canvas.width, canvas.height, fps);
        for (let i = 0; i < pingPongSeq.length; i++) {
          session.addFrame(pingPongSeq[i], i);
          if (i % 8 === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        const blob = await session.finish();
        showVideoDownloadModal(blob, 'boomerang', 'video/mp4');
        return;
      } catch (err) {
        console.warn('WebCodecs Boomerang MP4 encoding failed, using MediaRecorder:', err);
      }
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = canvas.width;
    outCanvas.height = canvas.height;
    const outCtx = outCanvas.getContext('2d');

    const stream = outCanvas.captureStream(fps);
    const mimeType = getSupportedMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const outMime = mimeType || 'video/webm';
      const blob = new Blob(chunks, { type: outMime });
      showVideoDownloadModal(blob, 'boomerang', outMime);
    };

    recorder.start();
    let idx = 0;
    const playTimer = setInterval(() => {
      if (idx >= pingPongSeq.length) {
        clearInterval(playTimer);
        recorder.stop();
        return;
      }
      outCtx.drawImage(pingPongSeq[idx], 0, 0);
      idx++;
    }, 1000 / fps);
  }, captureDurationMs);
}

let recIntervalId = null;

function startRecordingUI(label, durationMs) {
  state.isRecording = true;
  btnRecord.classList.add('recording');
  recIndicator.classList.remove('hidden');
  recLabel.textContent = label;
  const start = performance.now();

  clearInterval(recIntervalId);
  recIntervalId = setInterval(() => {
    const elapsed = performance.now() - start;
    const pct = Math.min(100, (elapsed / durationMs) * 100);
    recProgressFill.style.width = `${pct}%`;
    const remSec = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
    recTimer.textContent = `00:0${remSec}`;
  }, 50);
}

function finishRecordingUI() {
  clearInterval(recIntervalId);
  state.isRecording = false;
  btnRecord.classList.remove('recording');
  recIndicator.classList.add('hidden');
  recProgressFill.style.width = '0%';
}

function showPreviewModal({ type, url, filename, badge, buttonText }) {
  previewBadge.textContent = badge;
  btnDownload.href = url;
  btnDownload.download = filename;
  downloadLabel.textContent = buttonText;

  if (type === 'video') {
    previewImage.classList.add('hidden');
    previewVideo.classList.remove('hidden');
    previewVideo.src = url;
    previewVideo.play().catch(() => {});
  } else {
    previewVideo.pause();
    previewVideo.classList.add('hidden');
    previewImage.classList.remove('hidden');
    previewImage.src = url;
  }

  previewModal.classList.remove('hidden');
}

/* ==========================================================================
   UI EVENT LISTENERS & CONTROLS
   ========================================================================== */
function bindUIEvents() {
  window.addEventListener('resize', resizeCanvas);

  // Pointer interaction on stage canvas (allows testing hand attraction, fast swipe & close-push)
  stageEl.addEventListener('pointermove', (e) => {
    const rect = stageEl.getBoundingClientRect();
    state.pointerX = (e.clientX - rect.left) / rect.width;
    state.pointerY = (e.clientY - rect.top) / rect.height;
    state.pointerActive = true;
  });

  stageEl.addEventListener('pointerdown', (e) => {
    SoundFX.unlock();
    const rect = stageEl.getBoundingClientRect();
    state.pointerX = (e.clientX - rect.left) / rect.width;
    state.pointerY = (e.clientY - rect.top) / rect.height;
    state.pointerActive = true;
    state.pointerPressed = true;
  });

  window.addEventListener('pointerup', () => {
    state.pointerPressed = false;
  });
  window.addEventListener('pointercancel', () => {
    state.pointerPressed = false;
  });

  stageEl.addEventListener('pointerleave', () => {
    state.pointerPressed = false;
    if (!state.virtualHandsMode) {
      state.pointerActive = false;
      if (!state.camActive) state.smoothedHands = [];
    }
  });

  // Aspect Ratio Switcher
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const aspect = btn.dataset.aspect;
      appEl.classList.remove('aspect-full', 'aspect-9-16', 'aspect-16-9');
      if (aspect === '9:16') appEl.classList.add('aspect-9-16');
      else if (aspect === '16:9') appEl.classList.add('aspect-16-9');
      else appEl.classList.add('aspect-full');
      setTimeout(resizeCanvas, 50);
      setTimeout(resizeCanvas, 420);
    });
  });

  // Capture Mode Selector
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.captureMode = btn.dataset.mode;
    });
  });

  // Shutter / Record Button
  btnRecord.addEventListener('click', triggerBoothCapture);

  // Scatter Flock Button
  document.getElementById('btn-scatter').addEventListener('click', () => {
    SoundFX.unlock();
    scatterFlockBurst();
  });

  // Switch Camera (Front / Rear)
  document.getElementById('btn-switch-cam').addEventListener('click', () => {
    SoundFX.unlock();
    switchCamera();
  });

  // Sound Effects Sync (HUD Button + Settings Checkbox)
  const btnSound = document.getElementById('btn-sound');
  const soundLabel = document.getElementById('sound-label');
  const chkSound = document.getElementById('chk-sound');
  const setSoundEnabledUI = (enabled) => {
    SoundFX.setEnabled(enabled);
    if (enabled) SoundFX.unlock();
    btnSound.classList.toggle('active', enabled);
    btnSound.classList.toggle('muted', !enabled);
    soundLabel.textContent = enabled ? 'Sound' : 'Muted';
    chkSound.checked = enabled;
    if (enabled) SoundFX.playClick();
  };

  btnSound.addEventListener('click', () => {
    setSoundEnabledUI(!state.soundEnabled);
  });
  chkSound.addEventListener('change', (e) => {
    setSoundEnabledUI(e.target.checked);
  });

  // Toggle Virtual Dual-Hand Simulation
  const btnToggleSim = document.getElementById('btn-toggle-sim');
  btnToggleSim.addEventListener('click', () => {
    state.virtualHandsMode = !state.virtualHandsMode;
    btnToggleSim.classList.toggle('active', state.virtualHandsMode);
    if (!state.virtualHandsMode) {
      state.smoothedHands = [];
      statusEl.textContent = state.camActive
        ? 'Camera Live • Raise Hands to Attract Flock'
        : 'Move Cursor to Guide Flock';
    }
  });

  // Settings Drawer
  const settingsDrawer = document.getElementById('settings-drawer');
  document.getElementById('btn-settings').addEventListener('click', () => {
    settingsDrawer.classList.toggle('hidden');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    settingsDrawer.classList.add('hidden');
  });

  // Kiosk Mode Toggle
  document.getElementById('btn-kiosk').addEventListener('click', () => {
    state.kioskMode = !state.kioskMode;
    appEl.classList.toggle('kiosk-mode', state.kioskMode);
  });

  // Sliders & Checkboxes
  const sliderCount = document.getElementById('slider-count');
  const valCount = document.getElementById('val-count');
  sliderCount.addEventListener('input', (e) => {
    state.boidCount = parseInt(e.target.value, 10);
    valCount.textContent = String(state.boidCount);
  });

  const sliderSpeed = document.getElementById('slider-speed');
  const valSpeed = document.getElementById('val-speed');
  sliderSpeed.addEventListener('input', (e) => {
    state.speedMult = parseFloat(e.target.value);
    valSpeed.textContent = `${state.speedMult.toFixed(1)}x`;
  });

  const sliderScale = document.getElementById('slider-scale');
  const valScale = document.getElementById('val-scale');
  sliderScale.addEventListener('input', (e) => {
    state.scaleMult = parseFloat(e.target.value);
    valScale.textContent = `${state.scaleMult.toFixed(2)}x`;
  });

  const sliderPull = document.getElementById('slider-pull');
  const valPull = document.getElementById('val-pull');
  sliderPull.addEventListener('input', (e) => {
    state.pullStrength = parseFloat(e.target.value);
    valPull.textContent = state.pullStrength >= 1.25 ? 'Magnetic' : state.pullStrength < 0.7 ? 'Loose' : 'Balanced';
  });

  const sliderTilt = document.getElementById('slider-tilt');
  const valTilt = document.getElementById('val-tilt');
  sliderTilt.addEventListener('input', (e) => {
    state.tiltIntensity = parseFloat(e.target.value);
    valTilt.textContent = `${Math.round(state.tiltIntensity * 100)}%`;
  });

  document.getElementById('chk-aura').addEventListener('change', (e) => {
    state.showAura = e.target.checked;
  });
  document.getElementById('slider-aura').addEventListener('input', (e) => {
    state.auraIntensity = parseFloat(e.target.value);
  });
  document.getElementById('chk-sparks').addEventListener('change', (e) => {
    state.showSparks = e.target.checked;
  });
  document.getElementById('chk-network').addEventListener('change', (e) => {
    state.showNetworkLines = e.target.checked;
  });
  document.getElementById('chk-gust').addEventListener('change', (e) => {
    state.enableGustScatter = e.target.checked;
  });
  document.getElementById('chk-trails').addEventListener('change', (e) => {
    state.showTrails = e.target.checked;
  });
  document.getElementById('chk-mirror').addEventListener('change', (e) => {
    state.mirrorCam = e.target.checked;
  });
  document.getElementById('chk-countdown').addEventListener('change', (e) => {
    state.useCountdown = e.target.checked;
  });

  // Active Element Shape Toggles
  document.querySelectorAll('.asset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.dataset.shape, 10);
      const activeCount = state.enabledShapes.filter(Boolean).length;
      if (state.enabledShapes[idx] && activeCount <= 1) return; // Keep at least 1 active
      state.enabledShapes[idx] = !state.enabledShapes[idx];
      chip.classList.toggle('active', state.enabledShapes[idx]);
    });
  });

  // Preview Modal Close
  const closePreview = () => {
    previewModal.classList.add('hidden');
    previewVideo.pause();
  };
  document.getElementById('btn-close-preview').addEventListener('click', closePreview);
  document.getElementById('btn-retake').addEventListener('click', closePreview);

  // Camera Prompt Buttons
  document.getElementById('btn-retry-cam').addEventListener('click', startWebcam);
  document.getElementById('btn-sim-mode').addEventListener('click', () => {
    enableVirtualSimulation();
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    SoundFX.unlock();
    if (e.code === 'Space' && previewModal.classList.contains('hidden')) {
      e.preventDefault();
      triggerBoothCapture();
    } else if (e.key === 'h' || e.key === 'H') {
      state.kioskMode = !state.kioskMode;
      appEl.classList.toggle('kiosk-mode', state.kioskMode);
    } else if (e.key === 'b' || e.key === 'B') {
      scatterFlockBurst();
    } else if (e.key === 'c' || e.key === 'C') {
      switchCamera();
    } else if (e.key === 'a' || e.key === 'A') {
      btnSound.click();
    } else if (e.key === 'm' || e.key === 'M') {
      btnToggleSim.click();
    } else if (e.key === 's' || e.key === 'S') {
      settingsDrawer.classList.toggle('hidden');
    } else if (e.key === 'Escape') {
      if (!previewModal.classList.contains('hidden')) closePreview();
      if (state.kioskMode) {
        state.kioskMode = false;
        appEl.classList.remove('kiosk-mode');
      }
    }
  });
}

// Boot the Interactive Video Booth
resizeCanvas();
syncBoidCount();
syncNetworkNodes();
bindUIEvents();
initCameraAndTracking();
requestAnimationFrame(tick);
