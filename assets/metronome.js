// Client-side Web Audio metronome + hype-loop engine, plus a round/break
// "program" timer. Uses a standard lookahead scheduler for the metronome
// ticks so timing doesn't drift, and a simple elapsed-time counter (driven
// by the poll interval) for the round/break countdown, which only needs
// second-level precision.

function getMetro() {
  if (!window._metro) {
    window._metro = {
      ctx: null,
      fxGain: null,
      hypeGain: null,
      isRunning: false,
      bpm: 140,
      beats: 4,
      subdivisions: 1,
      currentTick: 0,
      tickSeq: 0,
      nextNoteTime: 0,
      timerID: null,
      lookahead: 25,
      scheduleAheadTime: 0.4,
      notesInQueue: [],
      fxPreset: "soft_tock",
      hypeUrl: null,
      hypeBuffer: null,
      hypeSource: null,
      bufferCache: {},
      mix: 50,
      lastResetToken: null,
      program: {
        phase: "idle", // 'idle' | 'round' | 'break' | 'finished'
        rounds: 1,
        roundMs: 60000,
        breakMs: 30000,
        currentRound: 1,
        remainingMs: 0,
        totalPunches: 0,
        lastPollTime: 0,
      },
      countdown: {
        active: false,
        remainingMs: 0,
        lastPollTime: 0,
        storeDataSnapshot: null,
        configuredSeconds: 10,
      },
      previewGain: null,
      preview: {
        hypeModalWasOpen: false,
        lastHypeUrl: null,
        hypeSource: null,
        fxModalWasOpen: false,
        lastFxPreset: null,
      },
    };
  }
  return window._metro;
}

function ensureCtx(m) {
  if (!m.ctx) {
    m.ctx = new (window.AudioContext || window.webkitAudioContext)();
    m.fxGain = m.ctx.createGain();
    m.hypeGain = m.ctx.createGain();
    m.previewGain = m.ctx.createGain();
    m.previewGain.gain.value = 0.6;
    m.bellGain = m.ctx.createGain();
    m.bellGain.gain.value = 0.5; // fixed — round bell isn't affected by the Mix slider
    m.fxGain.connect(m.ctx.destination);
    m.hypeGain.connect(m.ctx.destination);
    m.previewGain.connect(m.ctx.destination);
    m.bellGain.connect(m.ctx.destination);
  }
  if (m.ctx.state === "suspended") {
    m.ctx.resume();
  }
}

// Browsers only allow creating/resuming an AudioContext synchronously
// inside a real user-gesture event (a click). By the time a Dash callback
// round-trips to the server and back to update state-store, the browser no
// longer considers it "inside" that gesture, so the context can get stuck
// suspended forever. Unlocking directly on any real click/tap sidesteps
// that entirely.
if (!window._metroUnlockAttached) {
  window._metroUnlockAttached = true;
  const unlock = function () {
    ensureCtx(getMetro());
  };
  document.addEventListener("click", unlock, { capture: true });
  document.addEventListener("touchstart", unlock, { capture: true });
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}

function loadBuffer(m, url) {
  if (!url) return Promise.resolve(null);
  if (m.bufferCache[url]) return Promise.resolve(m.bufferCache[url]);
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((data) => m.ctx.decodeAudioData(data))
    .then((buf) => {
      m.bufferCache[url] = buf;
      return buf;
    });
}

// Equal-power crossfade so combined loudness stays roughly constant across
// the whole slider range instead of dipping in the middle.
function setMix(m, val) {
  const t = Math.max(0, Math.min(100, val)) / 100;
  const fxGainVal = Math.cos(t * 0.5 * Math.PI);
  const hypeGainVal = Math.sin(t * 0.5 * Math.PI);
  if (m.fxGain) m.fxGain.gain.value = fxGainVal * 4;
  if (m.hypeGain) m.hypeGain.gain.value = hypeGainVal * 0.2;
}

// Breaks always play hype music at full volume (same as Mix=100), no
// matter what the Mix slider is set to for rounds — a break shouldn't be
// muted just because you like the metronome loud during training.
function applyMixForPhase(m) {
  if (m.program && m.program.phase === "break") {
    setMix(m, 100);
  } else {
    setMix(m, m.mix);
  }
}

// ---- Metronome click sounds ----
// Each preset is its own small synthesis recipe rather than one generic
// tone with knobs. isAccent (the last hit in the combo — the power punch)
// always gets extra pitch and/or volume so it stands out.

function getNoiseBuffer(m) {
  if (m._noiseBuffer) return m._noiseBuffer;
  const length = Math.floor(m.ctx.sampleRate * 0.3);
  const buffer = m.ctx.createBuffer(1, length, m.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  m._noiseBuffer = buffer;
  return buffer;
}

function playSoftTock(m, time, isAccent) {
  const peak = isAccent ? 1.0 : 0.4;
  const freq = isAccent ? 900 : 560;
  const osc = m.ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  const gain = m.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);
  osc.connect(gain);
  gain.connect(m.fxGain);
  osc.start(time);
  osc.stop(time + 0.13);
}

function playSoftThump(m, time, isAccent) {
  const peak = isAccent ? 0.9 : 0.4;
  const freq = isAccent ? 320 : 230;
  const osc = m.ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  const gain = m.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.015); // softer attack than tock
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
  osc.connect(gain);
  gain.connect(m.fxGain);
  osc.start(time);
  osc.stop(time + 0.2);
}

function playHeavyBag(m, time, isAccent) {
  const peak = isAccent ? 1.0 : 0.5;

  // Low-end "body" of the hit.
  const bodyFreq = isAccent ? 130 : 100;
  const osc = m.ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(bodyFreq, time);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, bodyFreq * 0.5), time + 0.15);
  const bodyGain = m.ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, time);
  bodyGain.gain.exponentialRampToValueAtTime(peak, time + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
  osc.connect(bodyGain);
  bodyGain.connect(m.fxGain);
  osc.start(time);
  osc.stop(time + 0.18);

  // Short filtered-noise "impact" texture layered on top.
  const noiseSrc = m.ctx.createBufferSource();
  noiseSrc.buffer = getNoiseBuffer(m);
  const noiseFilter = m.ctx.createBiquadFilter();
  noiseFilter.type = "lowpass";
  noiseFilter.frequency.value = isAccent ? 500 : 350;
  const noiseGain = m.ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, time);
  noiseGain.gain.exponentialRampToValueAtTime(peak * 0.6, time + 0.002);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.08);
  noiseSrc.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(m.fxGain);
  noiseSrc.start(time);
  noiseSrc.stop(time + 0.09);
}

function playBassDrop(m, time, isAccent) {
  const peak = isAccent ? 1.0 : 0.5;
  const startFreq = isAccent ? 480 : 380;
  const osc = m.ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(startFreq, time);
  osc.frequency.exponentialRampToValueAtTime(35, time + 0.22);
  const gain = m.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
  osc.connect(gain);
  gain.connect(m.fxGain);
  osc.start(time);
  osc.stop(time + 0.26);
}

function playKick808(m, time, isAccent) {
  // Pure sine pitch-drop, no noise/click transient layered on top — keeps
  // it warm and headphone-safe rather than snappy. Attack is a short
  // linear ramp (6ms) rather than a near-instant jump, which is what
  // creates an audible "click" at the front of a percussive hit.
  const peak = isAccent ? 0.85 : 0.45;
  const startFreq = isAccent ? 150 : 120;
  const osc = m.ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(startFreq, time);
  osc.frequency.exponentialRampToValueAtTime(35, time + 0.22);
  const gain = m.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
  osc.connect(gain);
  gain.connect(m.fxGain);
  osc.start(time);
  osc.stop(time + 0.28);
}

function playRetroClap(m, time, isAccent) {
  // Three slightly-offset noise bursts (like a real clap's overlapping
  // hand-claps), each bandpass-filtered around 1200Hz rather than left as
  // raw full-spectrum noise — that filtering is what keeps it from
  // sounding like a sharp, sibilant snap in headphones. Soft 6ms attack
  // on each layer for the same reason.
  const peak = isAccent ? 0.7 : 0.35;
  const offsets = [0, 0.012, 0.024];
  offsets.forEach((offset, idx) => {
    const t = time + offset;
    const noiseSrc = m.ctx.createBufferSource();
    noiseSrc.buffer = getNoiseBuffer(m);
    const filter = m.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;
    const layerGain = m.ctx.createGain();
    const layerPeak = idx === offsets.length - 1 ? peak : peak * 0.7;
    layerGain.gain.setValueAtTime(0.0001, t);
    layerGain.gain.linearRampToValueAtTime(layerPeak, t + 0.006);
    layerGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noiseSrc.connect(filter);
    filter.connect(layerGain);
    layerGain.connect(m.fxGain);
    noiseSrc.start(t);
    noiseSrc.stop(t + 0.1);
  });
}

// Boxing-bell tone for round start/end — several sine oscillators at
// slightly inharmonic frequency ratios (the classic recipe for a metallic
// "bell" timbre, as opposed to a pure single-frequency tone), with a long
// decay. Always plays through its own dedicated gain node, independent of
// whichever FX preset is selected and independent of the Mix slider.
function playBell(m) {
  if (!m.ctx) return;
  const time = m.ctx.currentTime + 0.01;
  const fundamental = 880;
  const partials = [1, 2.0, 2.76, 4.07, 5.4];
  const decay = 1.8;
  partials.forEach((ratio, idx) => {
    const osc = m.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fundamental * ratio, time);
    const partialGain = m.ctx.createGain();
    const peak = 0.5 / (idx + 1);
    partialGain.gain.setValueAtTime(0.0001, time);
    partialGain.gain.linearRampToValueAtTime(peak, time + 0.008);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    osc.connect(partialGain);
    partialGain.connect(m.bellGain);
    osc.start(time);
    osc.stop(time + decay + 0.1);
  });
}

function playClick(m, time, isAccent) {
  switch (m.fxPreset) {
    case "soft_thump":
      playSoftThump(m, time, isAccent);
      break;
    case "heavy_bag":
      playHeavyBag(m, time, isAccent);
      break;
    case "bass_drop":
      playBassDrop(m, time, isAccent);
      break;
    case "kick_808":
      playKick808(m, time, isAccent);
      break;
    case "retro_clap":
      playRetroClap(m, time, isAccent);
      break;
    case "soft_tock":
    default:
      playSoftTock(m, time, isAccent);
      break;
  }
}

function scheduleTick(m, beatIndex, time) {
  const totalTicks = m.beats * m.subdivisions;
  const isAccent = beatIndex === totalTicks - 1; // power punch = last hit in the combo
  playClick(m, time, isAccent);
  m.notesInQueue.push({ beatIndex: beatIndex, time: time, seq: m.tickSeq++, isAccent: isAccent });
  m.program.totalPunches += 1;
}

function scheduler() {
  const m = getMetro();
  if (m.program.phase !== "round") return; // no ticks scheduled during break/idle/finished
  while (m.nextNoteTime < m.ctx.currentTime + m.scheduleAheadTime) {
    scheduleTick(m, m.currentTick, m.nextNoteTime);
    const secondsPerBeat = 60.0 / m.bpm;
    const tickDuration = secondsPerBeat / m.subdivisions;
    m.nextNoteTime += tickDuration;
    m.currentTick = (m.currentTick + 1) % (m.beats * m.subdivisions);
  }
}

function stopHype(m) {
  if (m.hypeSource) {
    try {
      m.hypeSource.stop();
    } catch (e) {
      /* already stopped */
    }
    m.hypeSource.disconnect();
    m.hypeSource = null;
  }
}

function startHype(m) {
  stopHype(m);
  if (!m.hypeBuffer) return;
  const src = m.ctx.createBufferSource();
  src.buffer = m.hypeBuffer;
  src.loop = true;
  src.connect(m.hypeGain);
  src.start(0);
  m.hypeSource = src;
}

function stopPreviewHype(m) {
  if (m.preview.hypeSource) {
    try {
      m.preview.hypeSource.stop();
    } catch (e) {
      /* already stopped */
    }
    m.preview.hypeSource.disconnect();
    m.preview.hypeSource = null;
  }
}

function stopEngine(m) {
  if (m.timerID) {
    clearInterval(m.timerID);
    m.timerID = null;
  }
  stopHype(m);
  m.notesInQueue = [];
}

function hardReset(m, storeData) {
  stopEngine(m);
  m.program = {
    phase: "idle",
    rounds: storeData.rounds || 1,
    roundMs: (storeData.round_minutes || 1) * 60000,
    breakMs: (storeData.break_seconds || 30) * 1000,
    currentRound: 1,
    remainingMs: 0,
    totalPunches: 0,
    lastPollTime: 0,
  };
  m.countdown = {
    active: false,
    remainingMs: 0,
    lastPollTime: 0,
    storeDataSnapshot: null,
    configuredSeconds: storeData.countdown_seconds || 10,
  };
  m.currentTick = 0;
  m.notesInQueue = [];
}

function startEngine(m, storeData) {
  ensureCtx(m);
  applyMixForPhase(m);

  const p = m.program;
  if (p.phase === "idle" || p.phase === "finished") {
    // Fresh run — (re)load program config and start from round 1.
    p.rounds = storeData.rounds || 1;
    p.roundMs = (storeData.round_minutes || 1) * 60000;
    p.breakMs = (storeData.break_seconds || 30) * 1000;
    p.currentRound = 1;
    p.phase = "round";
    p.remainingMs = p.roundMs;
    p.totalPunches = 0;
  }
  // Otherwise we're resuming from a pause mid-round or mid-break — keep
  // currentRound / phase / remainingMs / totalPunches exactly as they were.

  p.lastPollTime = performance.now();

  loadBuffer(m, m.hypeUrl)
    .then((buf) => {
      m.hypeBuffer = buf;
    })
    .then(() => {
      if (!m.isRunning) return; // stopped again while the hype track was loading
      m.currentTick = 0;
      m.notesInQueue = [];
      m.nextNoteTime = m.ctx.currentTime + 0.1;
      startHype(m);
      if (m.timerID) clearInterval(m.timerID);
      m.timerID = setInterval(scheduler, m.lookahead);
    });
}

function renderSnapshot(m, storeData) {
  const p = m.program;
  if (p.phase === "idle") {
    const rounds = storeData.rounds || 1;
    const roundMs = (storeData.round_minutes || 1) * 60000;
    return {
      timerText: formatTime(roundMs),
      timerClass: "round-timer round-timer-blue",
      statusText: "ROUND 1/" + rounds,
      punchesText: String(p.totalPunches),
      beatText: "--",
      beatClass: "beat-display",
    };
  }
  if (p.phase === "finished") {
    return {
      timerText: "00:00",
      timerClass: "round-timer round-timer-blue",
      statusText: "DONE",
      punchesText: String(p.totalPunches),
      beatText: "--",
      beatClass: "beat-display",
    };
  }
  // Paused mid-round or mid-break: show frozen values.
  const isBreak = p.phase === "break";
  return {
    timerText: formatTime(p.remainingMs),
    timerClass: isBreak ? "round-timer round-timer-magenta" : "round-timer round-timer-blue",
    statusText: isBreak ? "BREAK" : "ROUND " + p.currentRound + "/" + p.rounds,
    punchesText: String(p.totalPunches),
    beatText: "--",
    beatClass: "beat-display",
  };
}

const NO_UPDATE_7 = function () {
  const nu = window.dash_clientside.no_update;
  return [nu, nu, nu, nu, nu, nu, nu];
};

window.dash_clientside = Object.assign({}, window.dash_clientside, {
  clientside: {
    // Fires on every state-store change (bpm/fx/hype/mix/rounds/etc,
    // running toggles, and reset). Handles: hard resets, kicking off the
    // 10s get-ready countdown, starting/stopping the engine, live
    // parameter updates while running, and rendering the idle/paused
    // display snapshot when not running.
    updateAudioEngine: function (storeData) {
      const nu = window.dash_clientside.no_update;
      if (!storeData) {
        return [nu, nu, nu, nu, nu, nu, nu, nu, nu];
      }

      const m = getMetro();

      if (m.lastResetToken === null || storeData.reset_token !== m.lastResetToken) {
        hardReset(m, storeData);
        m.lastResetToken = storeData.reset_token;
      }

      const wantRunning = !!storeData.running;
      m.bpm = storeData.bpm || m.bpm;
      m.beats = storeData.beats || m.beats;
      m.subdivisions = storeData.subdivisions || 1;
      m.mix = storeData.mix === undefined ? m.mix : storeData.mix;
      m.fxPreset = storeData.fx_preset || m.fxPreset;

      const newHypeUrl = storeData.hype_url || null;
      const hypeChanged = newHypeUrl !== m.hypeUrl;
      m.hypeUrl = newHypeUrl;

      let countdownOpen = nu;
      let countdownText = nu;

      if (wantRunning && !m.isRunning && !m.countdown.active) {
        // Start pressed (fresh or resume) — begin the get-ready countdown
        // (duration picked in the Get Ready modal) instead of starting the
        // engine immediately.
        ensureCtx(m);
        const seconds = storeData.countdown_seconds || 10;
        m.countdown.active = true;
        m.countdown.remainingMs = seconds * 1000;
        m.countdown.configuredSeconds = seconds;
        m.countdown.lastPollTime = performance.now();
        m.countdown.storeDataSnapshot = storeData;
        countdownOpen = true;
        countdownText = String(seconds);
      } else if (!wantRunning) {
        // Stop or Reset — cancel any in-progress countdown and halt audio.
        if (m.countdown.active) {
          m.countdown.active = false;
          countdownOpen = false;
          countdownText = "";
        }
        if (m.isRunning) {
          m.isRunning = false;
          stopEngine(m);
        }
      } else if (wantRunning && m.isRunning) {
        applyMixForPhase(m);
        if (hypeChanged) {
          ensureCtx(m);
          loadBuffer(m, m.hypeUrl).then((buf) => {
            m.hypeBuffer = buf;
            startHype(m);
          });
        }
      } else if (m.ctx) {
        // wantRunning && !m.isRunning && countdown already active — a
        // setting tweak mid-countdown (Mix slider, or picking a different
        // Get Ready duration while it's counting down).
        setMix(m, m.mix);
        if (m.countdown.active) {
          const seconds = storeData.countdown_seconds || 10;
          if (seconds !== m.countdown.configuredSeconds) {
            m.countdown.configuredSeconds = seconds;
            m.countdown.remainingMs = seconds * 1000;
            countdownOpen = true;
            countdownText = String(seconds);
          }
        }
      }

      if (!m.isRunning && !m.countdown.active) {
        const snap = renderSnapshot(m, storeData);
        return [
          nu,
          snap.timerText,
          snap.timerClass,
          snap.statusText,
          snap.punchesText,
          nu,
          snap.beatClass,
          countdownOpen,
          countdownText,
        ];
      }
      return [nu, nu, nu, nu, nu, nu, nu, countdownOpen, countdownText];
    },

    // Fires every 100ms while running (disabled otherwise). Drives the
    // 10s get-ready countdown, the round/break countdown, phase
    // transitions, live beat display, and punch counter, and signals back
    // to Dash when the whole program ends.
    pollDisplay: function (n_intervals, storeData) {
      const nu = window.dash_clientside.no_update;
      const m = getMetro();

      if (m.countdown.active) {
        const now = performance.now();
        const delta = now - (m.countdown.lastPollTime || now);
        m.countdown.lastPollTime = now;
        m.countdown.remainingMs -= delta;

        if (m.countdown.remainingMs <= 0) {
          m.countdown.active = false;
          m.isRunning = true;
          startEngine(m, m.countdown.storeDataSnapshot || storeData);
          playBell(m);
          return [nu, nu, nu, nu, nu, nu, nu, false, ""];
        }
        const secondsLeft = Math.ceil(m.countdown.remainingMs / 1000);
        return [nu, nu, nu, nu, nu, nu, nu, true, String(secondsLeft)];
      }

      if (!m.isRunning || !m.ctx) {
        return [nu, nu, nu, nu, nu, nu, nu, nu, nu];
      }

      const p = m.program;
      const now = performance.now();
      const delta = now - (p.lastPollTime || now);
      p.lastPollTime = now;
      p.remainingMs -= delta;

      let justFinished = false;

      if (p.remainingMs <= 0) {
        if (p.phase === "round") {
          if (p.currentRound >= p.rounds) {
            p.phase = "finished";
            justFinished = true;
          } else {
            p.phase = "break";
            p.remainingMs += p.breakMs;
          }
          applyMixForPhase(m);
          playBell(m); // round end
        } else if (p.phase === "break") {
          p.phase = "round";
          p.currentRound += 1;
          p.remainingMs += p.roundMs;
          m.currentTick = 0;
          m.notesInQueue = [];
          m.nextNoteTime = m.ctx.currentTime + 0.1;
          applyMixForPhase(m);
          playBell(m); // round start
        }
      }

      let beatClass = nu;
      if (p.phase === "round") {
        const nowAudio = m.ctx.currentTime;
        let current = null;
        while (m.notesInQueue.length && m.notesInQueue[0].time < nowAudio) {
          current = m.notesInQueue.shift();
        }
        if (current !== null) {
          const parity = current.seq % 2 === 0 ? "pulse-a" : "pulse-b";
          const type = current.isAccent ? "beat-major" : "beat-minor";
          beatClass = "beat-display " + parity + " " + type;
        }
      } else {
        beatClass = "beat-display";
      }

      const timerText = formatTime(Math.max(0, p.remainingMs));
      const timerClass = p.phase === "break" ? "round-timer round-timer-magenta" : "round-timer round-timer-blue";
      const statusText =
        p.phase === "break" ? "BREAK" : p.phase === "finished" ? "DONE" : "ROUND " + p.currentRound + "/" + p.rounds;
      const punchesText = String(p.totalPunches);

      let newStoreData = nu;
      if (justFinished) {
        stopEngine(m);
        m.isRunning = false;
        newStoreData = Object.assign({}, storeData, { running: false });
      }

      return [nu, beatClass, timerText, timerClass, statusText, punchesText, newStoreData, nu, nu];
    },

    // Fires on state-store changes and on the Hype/FX modals opening or
    // closing. Lets you hear a sound the instant you pick it in either
    // modal — independent of whether a training session is actually
    // running — and stops playback the moment the modal closes.
    handlePreview: function (storeData, hypeModalOpen, fxModalOpen) {
      const nu = window.dash_clientside.no_update;
      if (!storeData) return nu;
      const m = getMetro();

      // ---- Hype preview (loops while the modal stays open) ----
      if (!hypeModalOpen) {
        stopPreviewHype(m);
        m.preview.hypeModalWasOpen = false;
        m.preview.lastHypeUrl = null;
      } else if (!m.preview.hypeModalWasOpen) {
        // Modal just opened — record the current selection as the
        // baseline so simply opening it doesn't trigger a preview.
        m.preview.hypeModalWasOpen = true;
        m.preview.lastHypeUrl = storeData.hype_url || null;
      } else if ((storeData.hype_url || null) !== m.preview.lastHypeUrl) {
        const newUrl = storeData.hype_url || null;
        m.preview.lastHypeUrl = newUrl;
        stopPreviewHype(m);
        // If a session is already running, the main engine (see
        // updateAudioEngine) already switches the live hype track itself
        // — starting a second preview loop here would overlap with it
        // and sound like an echo/phasing mess.
        if (newUrl && !m.isRunning) {
          ensureCtx(m);
          loadBuffer(m, newUrl).then((buf) => {
            if (!m.preview.hypeModalWasOpen) return; // modal closed while loading
            if (m.preview.lastHypeUrl !== newUrl) return; // superseded by a newer pick
            if (m.isRunning) return; // session started while loading
            const src = m.ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.connect(m.previewGain);
            src.start(0);
            m.preview.hypeSource = src;
          });
        }
      }

      // ---- FX preview (one-shot click per selection) ----
      if (!fxModalOpen) {
        m.preview.fxModalWasOpen = false;
        m.preview.lastFxPreset = null;
      } else if (!m.preview.fxModalWasOpen) {
        m.preview.fxModalWasOpen = true;
        m.preview.lastFxPreset = storeData.fx_preset || null;
      } else if ((storeData.fx_preset || null) !== m.preview.lastFxPreset) {
        const newPreset = storeData.fx_preset || null;
        m.preview.lastFxPreset = newPreset;
        if (newPreset) {
          ensureCtx(m);
          const originalPreset = m.fxPreset;
          m.fxPreset = newPreset;
          playClick(m, m.ctx.currentTime + 0.02, false);
          m.fxPreset = originalPreset;
        }
      }

      return nu;
    },
  },
});