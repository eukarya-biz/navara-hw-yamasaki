// Framing. Without this the piece reads as "a grey corridor you can walk down"
// -- nothing on screen says you are four years old, alone, and looking for a
// parent, which is the entire subject.
//
// The intro also does real work beyond exposition: its button is a genuine user
// gesture, which is the only thing browsers accept for starting an AudioContext.
// Previously that was piggy-backed onto the canvas click that grabs pointer
// lock, which worked but tied audio to an unrelated interaction.

export type IntroCallbacks = {
  /** Fired when the player dismisses the intro. */
  onStart: () => void;
};

const PANEL_BASE =
  "position:fixed;inset:0;z-index:60;display:flex;align-items:center;" +
  "justify-content:center;background:rgba(14,12,10,.93);" +
  "transition:opacity .8s ease;";

const CARD_BASE =
  "max-width:600px;margin:24px;padding:38px 42px;border-radius:14px;" +
  "background:rgba(28,25,22,.96);color:#e8e2d8;" +
  "font:15px/1.9 system-ui,-apple-system,sans-serif;" +
  "box-shadow:0 24px 60px rgba(0,0,0,.5);";

const BUTTON_BASE =
  "margin-top:26px;padding:13px 32px;border:0;border-radius:8px;cursor:pointer;" +
  "background:#e8dcc0;color:#2a231a;font:600 15px system-ui,sans-serif;";

function makeEl(tag: string, style: string, html = ""): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  node.innerHTML = html;
  return node;
}

/**
 * The opening card. Deliberately short -- four lines of setup, then the
 * controls. A wall of text in front of an experience about disorientation
 * would be self-defeating.
 */
export function showIntro(callbacks: IntroCallbacks): void {
  const panel = makeEl("div", PANEL_BASE);
  const card = makeEl(
    "div",
    CARD_BASE,
    `
    <div style="font:600 24px/1.5 system-ui,sans-serif;color:#f2ead9;margin-bottom:6px;">
      迷子
    </div>
    <div style="font-size:13px;color:#9c9384;letter-spacing:.08em;margin-bottom:22px;">
      新宿駅・地下街
    </div>
    <p style="margin:0 0 14px;">
      あなたは4歳児で、家族と新宿駅を歩いていました。
    </p>
    <p style="margin:0 0 24px;">
      しかし、いつの間にか両親はいなくなっていました。
      どこかであなたを探している両親と再会しましょう。
    </p>
    <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:18px;
                font-size:13px;color:#a8a096;line-height:2;">
      <b style="color:#d6cec1;">W / S</b> 前へ・後ろへ &nbsp;
      <b style="color:#d6cec1;">A / D</b> 向きを変える &nbsp;
      <b style="color:#d6cec1;">Shift</b> 急ぐ<br>
      画面をクリックするとマウスで見回せます(Escで解除)
    </div>
  `,
  );

  const button = makeEl("button", BUTTON_BASE, "はじめる") as HTMLButtonElement;
  card.appendChild(button);
  panel.appendChild(card);
  document.body.appendChild(panel);

  const dismiss = (): void => {
    panel.style.opacity = "0";
    panel.style.pointerEvents = "none";
    window.setTimeout(() => panel.remove(), 900);
    callbacks.onStart();
  };

  button.addEventListener("click", dismiss, { once: true });
}

/**
 * The closing card. Mirrors the intro's shape so the piece feels bracketed,
 * and carries the data credits -- the natural place for them, since by this
 * point the player has finished rather than been interrupted.
 */
export type EndingInfo = {
  /** Seconds spent searching. */
  elapsedSec: number;
  /** Metres walked. */
  distanceM: number;
  /** Walkable floor area of the dataset, m². Measured from the walk grid. */
  walkableAreaM2: number;
  /**
   * Distance to the farthest reachable place from the start point, by the
   * shortest route (not a straight line, and not a perimeter measurement).
   */
  longestPathM: number;
};

/**
 * The closing card, shown once the camera has risen and the whole underground
 * is visible below. The backdrop is deliberately light so the aerial view stays
 * readable behind it -- the point being made is the *size* of the place, and
 * covering it up would undercut the text.
 *
 * The figures are measured from the shipped walk grid, not invented.
 */
export function showEnding(
  info: EndingInfo,
  onContinue: () => void,
): void {
  const mins = Math.floor(info.elapsedSec / 60);
  const secs = Math.round(info.elapsedSec % 60);
  const timeText = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

  const panel = makeEl(
    "div",
    "position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;" +
      "justify-content:center;background:linear-gradient(to top," +
      "rgba(12,10,8,.92) 0%,rgba(12,10,8,.75) 45%,rgba(12,10,8,0) 100%);" +
      "opacity:0;transition:opacity 1.4s ease;",
  );
  const card = makeEl(
    "div",
    "max-width:640px;margin:0 24px 52px;padding:30px 36px;border-radius:14px;" +
      "background:rgba(24,21,18,.9);color:#e8e2d8;" +
      "font:15px/1.9 system-ui,-apple-system,sans-serif;" +
      "box-shadow:0 20px 50px rgba(0,0,0,.55);",
    `
    <div style="font:600 23px/1.5 system-ui,sans-serif;color:#f7f0dd;margin-bottom:16px;">
      みつけた
    </div>
    <p style="margin:0 0 14px;">
      探していた時間は <b style="color:#f2ead9;">${timeText}</b>、
      歩いた距離は <b style="color:#f2ead9;">${Math.round(info.distanceM)} m</b> でした。
      青い線があなたの歩いた跡、
      <span style="color:#9fe8ff;">青い光</span>がはじめた場所、
      <span style="color:#ffd08a;">黄色い光</span>が両親を見つけた場所です。
    </p>
    <p style="margin:0 0 14px;color:#d8d0c2;">
      いま見えているのが、歩いていた場所の全体です。
      地下街の歩ける面積は
      <b style="color:#f2ead9;">${info.walkableAreaM2.toLocaleString()} m²</b>。
      いちばん遠い場所までは、最短の道を選んでも
      <b style="color:#f2ead9;">${Math.round(info.longestPathM)} m</b> 歩きます。
    </p>
    <p style="margin:0 0 22px;color:#c9c0b2;">
      想像してみてください。この迷路みたいな新宿の地下で、子どもとはぐれることを。
      子どもの目線は大人より低く、周囲を見渡すことができません。
      迷子の約8割は2歳から5歳のあいだに起きています。
    </p>
    <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:16px;
                font-size:12px;color:#948c82;line-height:1.9;">
      3D City Model (Project PLATEAU) Shinjuku Ward (FY2025) - MLIT<br>
      地理院タイル (国土地理院) / Sentinel-2 cloudless 2016 by EOX (Re:Earth Papers)<br>
      Rendered with Navara
    </div>
  `,
  );

  const button = makeEl(
    "button",
    BUTTON_BASE + "background:rgba(255,255,255,.14);color:#e8e2d8;margin-top:20px;",
    "このまま見る",
  ) as HTMLButtonElement;
  card.appendChild(button);
  panel.appendChild(card);
  document.body.appendChild(panel);

  // The camera rise is the moment; the text arrives after it has landed.
  window.setTimeout(() => {
    panel.style.opacity = "1";
  }, 300);

  button.addEventListener(
    "click",
    () => {
      panel.style.opacity = "0";
      panel.style.pointerEvents = "none";
      window.setTimeout(() => panel.remove(), 1400);
      onContinue();
    },
    { once: true },
  );
}
