// The parent's voice, as a direction-finding cue.
//
// Distance sets the volume and how muffled the call is; the angle between
// where the player is facing and where the parent actually is sets the
// left/right pan. So turning on the spot moves the voice across the stereo
// field, and it centres when the player faces the parent. No on-screen UI is
// involved -- the player stays visually lost while still having something to
// follow.
//
// Everything here is optional at runtime. If the audio files are not present
// the module logs once and turns into a no-op, so the scene still builds and
// runs with no sound assets at all. Drop files into `public/audio/` to enable:
//
//   public/audio/call1.mp3   "おーい" (1-2 s)
//   public/audio/call2.mp3   optional variation
//   public/audio/call3.mp3   optional variation
//   public/audio/relief.mp3  optional, played once at the reunion
//
// Browsers will not start an AudioContext without a user gesture, so `resume()`
// has to be called from a real click -- main.ts does that from the same click
// that grabs pointer lock.

// Relative, not root-absolute: on GitHub Pages the app is served from a
// repository subpath, and "/audio/..." would resolve to the domain root.
const CALL_FILES = ["audio/call1.mp3", "audio/call2.mp3", "audio/call3.mp3"];
const RELIEF_FILE = "audio/relief.mp3";
const AMBIENCE_FILE = "audio/ambience.mp3";

/** Beyond this the call is inaudible. */
const MAX_AUDIBLE_M = 90;
/** Gap between calls. Long enough not to nag, short enough to navigate by. */
const CALL_INTERVAL_MS = 4200;

export class CallAudio {
  private ctx: AudioContext | null = null;
  private calls: AudioBuffer[] = [];
  private relief: AudioBuffer | null = null;
  private loaded = false;
  private warned = false;

  private master: GainNode | null = null;
  private echoDelay: DelayNode | null = null;

  // Crowd murmur. Uses public/audio/ambience.mp3 when present, and falls back
  // to synthesis when it is not, so the scene always has some presence.
  private ambienceGain: GainNode | null = null;
  private ambienceStarted = false;
  private ambienceSynth = false;
  private babbleBus: GainNode | null = null;
  private ambienceBuffer: AudioBuffer | null = null;
  private nextBabbleMs = 0;
  private ambienceTarget = 0;

  private listener = { lat: 0, lng: 0, heading: 0 };
  private source: { lat: number; lng: number } | null = null;
  private lastCallMs = 0;
  private enabled = true;
  private nextCallIndex = 0;

  /** True once at least one call file decoded successfully. */
  get hasVoice(): boolean {
    return this.calls.length > 0;
  }

  /** Which murmur source is in use, for the debug readout. */
  get ambienceKind(): string {
    if (!this.ambienceStarted) return "未開始";
    return this.ambienceSynth ? "合成" : "audio/ambience.mp3";
  }

  /** Must be triggered by a user gesture. Idempotent. */
  async resume(): Promise<void> {
    if (!this.ctx) {
      type WithWebkit = typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor =
        window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();

      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);

      // A cheap corridor echo: one delay line fed back at low gain. Not a
      // convolution reverb, but underground passages have exactly this kind of
      // slapback, and it costs nothing and needs no impulse-response file.
      this.echoDelay = this.ctx.createDelay(1.0);
      this.echoDelay.delayTime.value = 0.28;
      const feedback = this.ctx.createGain();
      feedback.gain.value = 0.32;
      const echoMix = this.ctx.createGain();
      echoMix.gain.value = 0.5;
      this.echoDelay.connect(feedback);
      feedback.connect(this.echoDelay);
      this.echoDelay.connect(echoMix);
      echoMix.connect(this.master);
    }

    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (!this.loaded) await this.load();
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.ctx) return;

    const fetchBuffer = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        // A dev server that falls back to index.html for missing files would
        // hand back HTML with a 200; decodeAudioData rejects it, which is
        // caught below, so a missing file can never break startup.
        return await this.ctx!.decodeAudioData(bytes);
      } catch {
        return null;
      }
    };

    this.ambienceBuffer = await fetchBuffer(AMBIENCE_FILE);
    const results = await Promise.all(CALL_FILES.map(fetchBuffer));
    this.calls = results.filter((b): b is AudioBuffer => b !== null);
    this.relief = await fetchBuffer(RELIEF_FILE);

    if (this.calls.length === 0) {
      if (!this.warned) {
        console.info(
          "[audio] no call files found in /audio/ -- voice guidance is off. " +
            "Add call1.mp3 (and optionally call2/call3, relief) to enable it.",
        );
        this.warned = true;
      }
    } else {
      console.info(
        `[audio] ${this.calls.length} call clip(s) loaded` +
          (this.relief ? " + relief" : ""),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Crowd murmur
  // -------------------------------------------------------------------------

  /**
   * Pink-ish noise, a few seconds long, looped. Paul Kellet's IIR approximation:
   * cheap, and close enough to 1/f that it reads as a room rather than as hiss.
   * White noise sounds like static; the crowd needs the energy weighted low.
   */
  private makeNoiseBuffer(ctx: AudioContext, seconds = 4): AudioBuffer {
    const frames = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, frames, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < frames; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        data[i] = pink * 0.06;
      }
    }
    return buf;
  }

  /**
   * Builds the murmur. A recorded file is always better, so it wins if present;
   * otherwise three layers of band-limited noise stand in.
   *
   * The synthesised version leans on two things. Speech energy sits roughly
   * between 200 Hz and 4 kHz, so bandpasses around the vowel formants turn
   * noise from "hiss" into "voices". And a crowd is not steady -- individual
   * conversations swell and fade -- so each layer's gain is walked to a new
   * random value every few hundred milliseconds, which is what produces babble
   * rather than a drone.
   */
  private startAmbience(): void {
    if (!this.ctx || !this.master || this.ambienceStarted) return;
    this.ambienceStarted = true;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    this.ambienceGain = gain;

    if (this.ambienceBuffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ambienceBuffer;
      src.loop = true;
      src.connect(gain);
      src.start();
      console.info("[audio] ambience: using audio/ambience.mp3");
      return;
    }

    // No file: synthesise.
    //
    // The first attempt sounded like surf, and for a good reason: filtered pink
    // noise with a slow amplitude envelope is *exactly* what breaking waves are.
    // Three things separate a crowd from water, and all three were missing.
    //
    //   1. Rate. Waves swell over seconds; speech modulates at the syllable
    //      rate, roughly 4-6 Hz. The old modulation ran at 2-5 Hz *periods*
    //      (220-540 ms with 250 ms smoothing), which lands squarely on "swell".
    //   2. Onset. Water rises gradually. Syllables start in a few tens of ms.
    //   3. Pitch. Noise has none. Voices are driven by vocal folds and have a
    //      fundamental, which is most of what makes a sound read as a person.
    //
    // So the bed is now only a quiet room tone, and the crowd itself is built
    // from many short *pitched* utterances -- a sawtooth at a plausible
    // fundamental, shaped by vowel formant filters, with a fast attack. Enough
    // of them overlapping turns into babble; individually they are too short and
    // too quiet to pick out.
    this.ambienceSynth = true;

    // Quiet room tone underneath. Deliberately much lower than before and with
    // no slow modulation of its own -- that modulation was the surf.
    const noise = this.makeNoiseBuffer(this.ctx);
    const bedSrc = this.ctx.createBufferSource();
    bedSrc.buffer = noise;
    bedSrc.loop = true;
    const bedBand = this.ctx.createBiquadFilter();
    bedBand.type = "bandpass";
    bedBand.frequency.value = 500;
    bedBand.Q.value = 0.6;
    const bedGain = this.ctx.createGain();
    bedGain.gain.value = 0.18;
    bedSrc.connect(bedBand);
    bedBand.connect(bedGain);
    bedGain.connect(gain);
    bedSrc.start();

    this.babbleBus = this.ctx.createGain();
    this.babbleBus.gain.value = 1;
    // Distance mush: a crowd heard across a concourse has no crisp high end.
    const mush = this.ctx.createBiquadFilter();
    mush.type = "lowpass";
    mush.frequency.value = 2600;
    this.babbleBus.connect(mush);
    mush.connect(gain);
    const babbleSend = this.ctx.createGain();
    babbleSend.gain.value = 0.3;
    mush.connect(babbleSend);
    babbleSend.connect(this.echoDelay as DelayNode);

    console.info("[audio] ambience: synthesised (no ambience.mp3 found)");
  }

  /**
   * How loud the murmur should be, 0..1. Driven by how many people are actually
   * near the player, so the sound follows the simulation instead of being a flat
   * background bed: quiet corridors go quiet, busy concourses fill up.
   */
  setAmbience(intensity: number): void {
    this.ambienceTarget = Math.max(0, Math.min(1, intensity));
    if (!this.ctx) return;
    if (!this.ambienceStarted) this.startAmbience();
    if (!this.ambienceGain) return;
    // Slew rather than jump, or walking past a doorway clicks.
    this.ambienceGain.gain.setTargetAtTime(
      this.ambienceTarget * 0.5,
      this.ctx.currentTime,
      0.4,
    );
  }

  /** Fades the murmur out, e.g. as the closing shot lifts away from the crowd. */
  fadeAmbience(seconds = 3): void {
    if (!this.ctx || !this.ambienceGain) return;
    this.ambienceGain.gain.setTargetAtTime(
      0,
      this.ctx.currentTime,
      Math.max(0.1, seconds / 3),
    );
  }

  /**
   * Japanese vowel formants (F1, F2) in Hz. A sawtooth pushed through a pair of
   * bandpasses at these frequencies is a crude vowel, which is all that is
   * needed once dozens of them overlap.
   */
  private static readonly VOWELS: [number, number][] = [
    [800, 1200], // a
    [300, 2300], // i
    [350, 800], // u
    [500, 1800], // e
    [500, 900], // o
  ];

  /**
   * Spawns one short utterance. Fast attack, syllable-length, pitched, panned at
   * random. Nodes are created per utterance and stop themselves, which is the
   * normal Web Audio pattern -- they are garbage once `stop()` has fired.
   */
  private spawnUtterance(level: number): void {
    if (!this.ctx || !this.babbleBus) return;
    const now = this.ctx.currentTime;

    // Adults, both registers: male fundamentals sit near 85-155 Hz, female near
    // 165-255 Hz. Picking across both keeps the crowd from sounding uniform.
    const male = Math.random() < 0.5;
    const f0 = male ? 85 + Math.random() * 70 : 165 + Math.random() * 90;

    // One syllable. Long enough to be voiced, short enough that the modulation
    // it creates lands in the 4-6 Hz band that reads as speech.
    const dur = 0.13 + Math.random() * 0.14;
    const attack = 0.02 + Math.random() * 0.015;

    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, now);
    // A little intonation, or every syllable sounds like a machine.
    osc.frequency.linearRampToValueAtTime(
      f0 * (0.92 + Math.random() * 0.16),
      now + dur,
    );

    const [f1, f2] = CallAudio.VOWELS[
      Math.floor(Math.random() * CallAudio.VOWELS.length)
    ];
    const jitter = (): number => 0.9 + Math.random() * 0.2;

    const band1 = this.ctx.createBiquadFilter();
    band1.type = "bandpass";
    band1.frequency.value = f1 * jitter();
    band1.Q.value = 6;

    const band2 = this.ctx.createBiquadFilter();
    band2.type = "bandpass";
    band2.frequency.value = f2 * jitter();
    band2.Q.value = 8;

    // Formants in parallel, not in series: in series the second one would mostly
    // cancel the first, leaving almost nothing through.
    const mix = this.ctx.createGain();
    mix.gain.value = 1;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.9 * level, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.random() * 2 - 1;

    osc.connect(band1);
    osc.connect(band2);
    band1.connect(mix);
    band2.connect(mix);
    mix.connect(env);
    env.connect(panner);
    panner.connect(this.babbleBus);

    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  /**
   * Keeps the babble going. The spawn rate scales with the crowd, so a busy
   * concourse is a wall of voices and an empty passage is nearly silent.
   */
  private stepBabble(nowMs: number): void {
    if (!this.ctx || !this.ambienceSynth || !this.babbleBus) return;
    if (this.ambienceTarget <= 0.001) return;

    // Up to ~26 utterances a second at full density. With syllables ~0.2 s long
    // that is around 5 sounding at once -- cheap, and mushy enough to stop any
    // single one being identifiable.
    const perSecond = 4 + 22 * this.ambienceTarget;
    const interval = 1000 / perSecond;
    if (this.nextBabbleMs === 0) this.nextBabbleMs = nowMs;
    // Cap the catch-up, or a backgrounded tab returns and fires hundreds at once.
    let budget = 6;
    while (this.nextBabbleMs <= nowMs && budget-- > 0) {
      this.spawnUtterance(0.06 + 0.05 * Math.random());
      // Irregular spacing: evenly spaced syllables sound like a machine gun.
      this.nextBabbleMs += interval * (0.5 + Math.random());
    }
    if (this.nextBabbleMs < nowMs) this.nextBabbleMs = nowMs;
  }

  /** Heading in degrees (0 = north, clockwise), as PersonViewPlugin reports it. */
  setListener(lat: number, lng: number, headingDeg: number): void {
    this.listener = { lat, lng, heading: headingDeg * (Math.PI / 180) };
  }

  setSource(lat: number, lng: number): void {
    this.source = { lat, lng };
  }

  /** Stops further calls (e.g. after the reunion). */
  stopCalling(): void {
    this.enabled = false;
  }

  startCalling(): void {
    this.enabled = true;
  }

  /** Call once per frame. Cheap when there is nothing to play. */
  update(nowMs: number): void {
    this.stepBabble(nowMs);
    if (!this.enabled || !this.ctx || !this.source || this.calls.length === 0) {
      return;
    }
    if (nowMs - this.lastCallMs < CALL_INTERVAL_MS) return;

    const dLat = (this.source.lat - this.listener.lat) * 110540;
    const dLng =
      (this.source.lng - this.listener.lng) *
      110540 *
      Math.cos(this.listener.lat * (Math.PI / 180));
    const distance = Math.hypot(dLat, dLng);
    if (distance > MAX_AUDIBLE_M) {
      // Still advance the clock so it does not fire a burst on approach.
      this.lastCallMs = nowMs;
      return;
    }

    this.lastCallMs = nowMs;
    this.playCall(distance, Math.atan2(dLng, dLat));
  }

  private playCall(distance: number, bearing: number): void {
    if (!this.ctx || !this.master || !this.echoDelay) return;

    const buffer = this.calls[this.nextCallIndex % this.calls.length];
    this.nextCallIndex++;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    // A little pitch variation so repeats do not sound like a loop.
    src.playbackRate.value = 0.97 + Math.random() * 0.06;

    // Inverse-ish falloff, clamped so a nearby call cannot be deafening.
    const near = 4;
    const gainValue = Math.min(1, near / Math.max(near, distance)) ** 0.8;
    const gain = this.ctx.createGain();
    gain.gain.value = gainValue;

    // Relative angle: 0 means the player is facing the parent.
    const relative = bearing - this.listener.heading;
    const pan = Math.max(-1, Math.min(1, Math.sin(relative)));
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;

    // Distance muffling: far calls lose their high end, which is a much
    // stronger distance cue than volume alone.
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    const t = Math.min(1, distance / MAX_AUDIBLE_M);
    lp.frequency.value = 7000 - 5800 * t;

    // Behind the listener also reads as slightly duller.
    const behind = Math.cos(relative) < 0;
    if (behind) lp.frequency.value *= 0.75;

    src.connect(lp);
    lp.connect(gain);
    gain.connect(panner);
    panner.connect(this.master);
    // Echo gets more prominent with distance, like a real passage.
    const echoSend = this.ctx.createGain();
    echoSend.gain.value = 0.15 + 0.35 * t;
    panner.connect(echoSend);
    echoSend.connect(this.echoDelay);

    src.start();
  }

  playRelief(): void {
    if (!this.ctx || !this.master || !this.relief) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.relief;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
  }
}
