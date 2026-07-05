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
    };
  }
  return window._metro;
}

function ensureCtx(m) {
  if (!m.ctx) {
    m.ctx = new (window.AudioContext || window.webkitAudioContext)();
    m.fxGain = m.ctx.createGain();
    m.hypeGain = m.ctx.createGain();
    m.fxGain.connect(m.ctx.destination);
    m.hypeGain.connect(m.ctx.destination);
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

function playHeartBeat(m, time, isAccent) {
  const peak = isAccent ? 1.0 : 0.55;

  function pulse(t, freq, pk, dur) {
    const osc = m.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    const gain = m.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(pk, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(m.fxGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  pulse(time, isAccent ? 110 : 90, peak, 0.09); // "lub"
  pulse(time + 0.13, isAccent ? 95 : 75, peak * 0.7, 0.07); // "dub"
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
    case "heart_beat":
      playHeartBeat(m, time, isAccent);
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
  m.currentTick = 0;
  m.notesInQueue = [];
}

function startEngine(m, storeData) {
  ensureCtx(m);
  setMix(m, m.mix);

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
    // running toggles, and reset). Handles: hard resets, starting/stopping
    // the engine, live parameter updates while running, and rendering the
    // idle/paused display snapshot when not running.
    updateAudioEngine: function (storeData) {
      const nu = window.dash_clientside.no_update;
      if (!storeData) {
        return [nu, nu, nu, nu, nu, nu, nu];
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

      if (wantRunning && !m.isRunning) {
        m.isRunning = true;
        startEngine(m, storeData);
      } else if (!wantRunning && m.isRunning) {
        m.isRunning = false;
        stopEngine(m);
      } else if (wantRunning && m.isRunning) {
        setMix(m, m.mix);
        if (hypeChanged) {
          ensureCtx(m);
          loadBuffer(m, m.hypeUrl).then((buf) => {
            m.hypeBuffer = buf;
            startHype(m);
          });
        }
      } else if (m.ctx) {
        setMix(m, m.mix);
      }

      if (!m.isRunning) {
        const snap = renderSnapshot(m, storeData);
        return [nu, snap.timerText, snap.timerClass, snap.statusText, snap.punchesText, snap.beatText, snap.beatClass];
      }
      return [nu, nu, nu, nu, nu, nu, nu];
    },

    // Fires every 100ms while running (disabled otherwise). Drives the
    // round/break countdown, phase transitions, live beat display, and
    // punch counter, and signals back to Dash when the whole program ends.
    pollDisplay: function (n_intervals, storeData) {
      const nu = window.dash_clientside.no_update;
      const m = getMetro();
      if (!m.isRunning || !m.ctx) {
        return [nu, nu, nu, nu, nu, nu, nu];
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
        } else if (p.phase === "break") {
          p.phase = "round";
          p.currentRound += 1;
          p.remainingMs += p.roundMs;
          m.currentTick = 0;
          m.notesInQueue = [];
          m.nextNoteTime = m.ctx.currentTime + 0.1;
        }
      }

      let beatText = nu;
      let beatClass = nu;
      if (p.phase === "round") {
        const nowAudio = m.ctx.currentTime;
        let current = null;
        while (m.notesInQueue.length && m.notesInQueue[0].time < nowAudio) {
          current = m.notesInQueue.shift();
        }
        if (current !== null) {
          beatText = String(current.beatIndex + 1);
          const parity = current.seq % 2 === 0 ? "flash-even" : "flash-odd";
          const accent = current.isAccent ? " accent" : "";
          beatClass = "beat-display " + parity + accent;
        }
      } else {
        beatText = "--";
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

      return [beatText, beatClass, timerText, timerClass, statusText, punchesText, newStoreData];
    },
  },
});
