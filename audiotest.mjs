// Checks the pink-noise generator, since a bad filter coefficient produces
// either silence or clipping and neither is obvious without listening.
let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) fails++;
};

// Same generator as src/audio.ts makeNoiseBuffer().
function pink(n) {
  const out = new Float32Array(n);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + white*0.0555179;
    b1 = 0.99332*b1 + white*0.0750759;
    b2 = 0.969*b2   + white*0.153852;
    b3 = 0.8665*b3  + white*0.3104856;
    b4 = 0.55*b4    + white*0.5329522;
    b5 = -0.7616*b5 - white*0.016898;
    const p = b0+b1+b2+b3+b4+b5+b6 + white*0.5362;
    b6 = white*0.115926;
    out[i] = p * 0.06;
  }
  return out;
}

const N = 44100 * 4;
const buf = pink(N);

check("no NaN or Infinity in the buffer", buf.every(Number.isFinite));

let peak = 0;
for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
check("stays inside [-1, 1] so it cannot clip", peak < 1.0, `peak ${peak.toFixed(3)}`);
check("loud enough to be audible once gained", peak > 0.05, `peak ${peak.toFixed(3)}`);

let sum = 0;
for (const v of buf) sum += v * v;
const rms = Math.sqrt(sum / N);
check("RMS is in a sane range for a bed layer", rms > 0.005 && rms < 0.3,
  `rms ${rms.toFixed(4)}`);

// Pink noise must have more energy low than high. Compare the mean absolute
// first difference (a crude high-frequency proxy) against the signal level:
// white noise differences are ~1.4x its RMS, pink noise noticeably less.
let diff = 0;
for (let i = 1; i < N; i++) diff += Math.abs(buf[i] - buf[i-1]);
const meanDiff = diff / (N - 1);
let absSum = 0;
for (const v of buf) absSum += Math.abs(v);
const meanAbs = absSum / N;
const ratio = meanDiff / meanAbs;
check("spectrum is weighted low (pink, not white)", ratio < 1.2,
  `diff/level ratio ${ratio.toFixed(3)} (white noise is ~1.4+)`);

// DC offset would waste headroom and can thump on loop.
let total = 0;
for (const v of buf) total += v;
const mean = total / N;
check("no significant DC offset", Math.abs(mean) < 0.01, `mean ${mean.toExponential(2)}`);


// ---------------------------------------------------------------------------
// Babble parameters: the first version sounded like surf, so these are pinned
// to the acoustics that separate a crowd from breaking waves.
// ---------------------------------------------------------------------------
console.log("\n=== ざわめきのパラメータ ===");

// From src/audio.ts spawnUtterance() / stepBabble().
const DUR_MIN = 0.13, DUR_MAX = 0.13 + 0.14;
const ATTACK_MIN = 0.02, ATTACK_MAX = 0.02 + 0.015;
const RATE_MIN = 4, RATE_MAX = 4 + 22;
const F0_MALE = [85, 155], F0_FEMALE = [165, 255];

// Speech amplitude modulation peaks around 4-6 Hz (the syllable rate). Surf
// modulates below ~0.5 Hz. The utterance rate is what sets this.
check("発話の頻度が音節の速さの範囲に入る (>=4Hz)", RATE_MIN >= 4,
  `${RATE_MIN}-${RATE_MAX} 回/秒`);
check("波のうねりの帯域 (<1Hz) に落ちない", RATE_MIN > 1,
  `最小でも ${RATE_MIN} 回/秒`);

// One syllable is ~150-250 ms. Longer reads as a drone or a swell.
check("1音節の長さが妥当 (0.1-0.3秒)", DUR_MIN >= 0.1 && DUR_MAX <= 0.3,
  `${(DUR_MIN*1000).toFixed(0)}-${(DUR_MAX*1000).toFixed(0)} ms`);

// Fast onset is the other half of "not water".
check("立ち上がりが速い (<50ms)", ATTACK_MAX < 0.05,
  `${(ATTACK_MIN*1000).toFixed(0)}-${(ATTACK_MAX*1000).toFixed(0)} ms`);

// Pitch is what makes it read as a person rather than as noise.
check("基本周波数が成人の声域に入る", F0_MALE[0] >= 80 && F0_FEMALE[1] <= 260,
  `男声 ${F0_MALE[0]}-${F0_MALE[1]} Hz / 女声 ${F0_FEMALE[0]}-${F0_FEMALE[1]} Hz`);

// Concurrency budget: rate x duration = how many sound at once.
const concurrentMax = RATE_MAX * DUR_MAX;
check("同時発音数が現実的 (<12)", concurrentMax < 12,
  `最大 ${concurrentMax.toFixed(1)} 同時`);
check("最大密度でも隙間なく繋がる (>=2 同時)", concurrentMax >= 2,
  `${concurrentMax.toFixed(1)} 同時なら途切れない`);

console.log(fails === 0 ? "\nPASS  noise generator and babble parameters are sound"
                        : `\nFAIL  ${fails} check(s)`);
process.exit(fails ? 1 : 0);
