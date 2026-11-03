import type { CSSProperties } from 'react';

/**
 * MTV-08 design lab — operational viewport STAGING STUDY (v2, critique-pass).
 *
 * Originally-authored 2D SVG composition (no third-party artwork, no
 * manufacturer trademarks, no WebGL). Purpose: judge viewport prominence,
 * asset scale, camera framing, evidence selection and the finance-inspector
 * relationship. Production WebGL scene = MTV-09 (issue #11).
 *
 * Framings animate (overview → asset → event); `reducedMotion` snaps
 * instantly and stops rotors/strobes/radar.
 */

export type SceneTheme = 'day' | 'night';
export type Framing = 'overview' | 'asset' | 'event';

interface SceneProps {
  theme: SceneTheme;
  framing: Framing;
  onFraming?: (f: Framing) => void;
  selectedPin: string | null;
  onSelectPin: (pinId: string) => void;
  reducedMotion: boolean;
  className?: string;
  /** hide the in-scene framing HUD when the host provides its own controls */
  hudFraming?: boolean;
}

const PALETTE = {
  day: {
    skyTop: '#d9e9f2',
    skyBot: '#f2f8fb',
    seaTop: '#a3c6d8',
    seaMid: '#8fb9ce',
    seaBot: '#7cabc4',
    fog: 'rgba(240,247,251,0.85)',
    wave: '#7fa9c0',
    whitecap: 'rgba(255,255,255,0.65)',
    towerTop: '#46586a',
    towerBot: '#2e3a44',
    structure: '#33414d',
    structureLit: '#46586a',
    blade: '#3e4e5c',
    rotor: 'rgba(62,78,92,0.30)',
    drone: '#26313b',
    droneLit: '#3c4b59',
    pin: '#b4232a',
    pinRing: 'rgba(180,35,42,0.35)',
    hud: '#33414d',
    hudBg: 'rgba(255,255,255,0.78)',
    stars: 'transparent',
    beacon: '#5fa8d3',
    scan: 'rgba(95,168,211,0.12)',
    glint: 'rgba(255,255,255,0.55)',
  },
  night: {
    skyTop: '#05080f',
    skyBot: '#0e1a2b',
    seaTop: '#0b141f',
    seaMid: '#081019',
    seaBot: '#050b12',
    fog: 'rgba(14,26,43,0.9)',
    wave: '#16273b',
    whitecap: 'rgba(158,190,220,0.28)',
    towerTop: '#14202f',
    towerBot: '#050a10',
    structure: '#04070c',
    structureLit: '#101a28',
    blade: '#0d1622',
    rotor: 'rgba(232,178,62,0.20)',
    drone: '#0d141d',
    droneLit: '#1b2736',
    pin: '#e8b23e',
    pinRing: 'rgba(232,178,62,0.30)',
    hud: '#d7e3f0',
    hudBg: 'rgba(6,10,17,0.72)',
    stars: '#afc4dc',
    beacon: '#e8b23e',
    scan: 'rgba(232,178,62,0.10)',
    glint: 'rgba(220,233,245,0.20)',
  },
} as const;

const FRAMINGS: Record<Framing, { tx: number; ty: number; s: number }> = {
  overview: { tx: 0, ty: 0, s: 1 },
  event: { tx: -326, ty: -112, s: 2.2 },
  asset: { tx: -840, ty: -396, s: 2.6 },
};

export function Scene(props: SceneProps) {
  const {
    theme,
    framing,
    selectedPin,
    onSelectPin,
    onFraming,
    reducedMotion,
    className,
    hudFraming = true,
  } = props;
  const c = PALETTE[theme];
  const f = FRAMINGS[framing];

  const frameStyle: CSSProperties = {
    transform: `translate(${f.tx}px, ${f.ty}px) scale(${f.s})`,
    transition: reducedMotion ? 'none' : 'transform 900ms cubic-bezier(0.22, 0.61, 0.36, 1)',
    transformOrigin: '0 0',
  };
  const spin = (dur: string): CSSProperties => ({
    animation: `lab-scene-spin ${dur} linear infinite`,
    animationPlayState: reducedMotion ? 'paused' : 'running',
    transformBox: 'fill-box',
    transformOrigin: 'center',
  });

  return (
    <div className={className}>
      <svg
        viewBox="0 0 1200 675"
        role="img"
        aria-label="Synthetic staging of the Havsul field inspection: offshore wind turbine T-12 with a service platform and inspection UAV SEAGULL-2 holding station near blade B. An interactive evidence pin marks the suspected crack. 2D staging study; production 3D arrives in MTV-09."
        data-testid="lab-viewport"
        data-framing={framing}
      >
        <defs>
          <linearGradient id={`sky-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.skyTop} />
            <stop offset="100%" stopColor={c.skyBot} />
          </linearGradient>
          <linearGradient id={`sea-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.seaTop} />
            <stop offset="55%" stopColor={c.seaMid} />
            <stop offset="100%" stopColor={c.seaBot} />
          </linearGradient>
          <linearGradient id={`tower-${theme}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={c.towerBot} />
            <stop offset="45%" stopColor={c.towerTop} />
            <stop offset="100%" stopColor={c.towerBot} />
          </linearGradient>
          <linearGradient id={`fog-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.fog} />
            <stop offset="100%" stopColor={c.fog} stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`moon-${theme}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#dce9f5" stopOpacity={theme === 'night' ? 0.85 : 0} />
            <stop offset="55%" stopColor="#dce9f5" stopOpacity={theme === 'night' ? 0.16 : 0} />
            <stop offset="100%" stopColor="#dce9f5" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`glint-${theme}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor={c.glint} />
            <stop offset="100%" stopColor={c.glint} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`scan-${theme}`} x1="0" y1="0" x2="0.9" y2="0.5">
            <stop offset="0%" stopColor={c.scan} stopOpacity="0.6" />
            <stop offset="100%" stopColor={c.scan} stopOpacity="0" />
          </linearGradient>
        </defs>

        <rect width="1200" height="675" fill={`url(#sky-${theme})`} />

        {theme === 'night' && (
          <g aria-hidden="true">
            <circle cx="985" cy="118" r="230" fill={`url(#moon-${theme})`} />
            <circle cx="985" cy="118" r="33" fill="#dce9f5" opacity="0.94" />
            <circle cx="972" cy="108" r="6" fill="#c3d4e4" opacity="0.5" />
            <circle cx="998" cy="130" r="4" fill="#c3d4e4" opacity="0.4" />
            {STARS.map(([x, y, r, o], i) => (
              <circle key={i} cx={x} cy={y} r={r} fill={c.stars} opacity={o} />
            ))}
          </g>
        )}

        {/* distant fleet on the horizon */}
        <g aria-hidden="true" opacity={theme === 'night' ? 0.45 : 0.3} fill={c.structure}>
          <rect x="70" y="418" width="54" height="9" rx="4" />
          <rect x="82" y="404" width="7" height="15" />
          <rect x="166" y="421" width="38" height="6" rx="3" />
          <rect x="150" y="415" width="4" height="7" />
        </g>

        {/* sea with three depth bands + horizon fog */}
        <rect x="0" y="430" width="1200" height="82" fill={c.seaTop} />
        <rect x="0" y="512" width="1200" height="80" fill={c.seaMid} />
        <rect x="0" y="592" width="1200" height="83" fill={c.seaBot} />
        <rect x="0" y="428" width="1200" height="44" fill={`url(#fog-${theme})`} />
        {theme === 'night' && (
          <ellipse cx="985" cy="452" rx="120" ry="26" fill={`url(#glint-${theme})`} />
        )}

        <g aria-hidden="true" stroke={c.wave} strokeWidth="1.3" opacity="0.75">
          {WAVES.map(([x, y, w], i) => (
            <path
              key={i}
              d={`M${x} ${y} h${w}`}
              strokeDasharray="16 12"
              opacity={0.4 + (y / 675) * 0.6}
            />
          ))}
        </g>
        <g aria-hidden="true" stroke={c.whitecap} strokeWidth="1.6" strokeLinecap="round">
          {WHITECAPS.map(([x, y, w], i) => (
            <path key={i} d={`M${x} ${y} q${w / 2} -3 ${w} 0`} fill="none" opacity="0.7" />
          ))}
        </g>

        <g style={frameStyle}>
          {/* turbine T-12 */}
          <g>
            <path
              d="M318 430 Q331 300 324 168 L340 168 Q336 300 348 430 Z"
              fill={`url(#tower-${theme})`}
            />
            <rect x="314" y="150" width="46" height="24" rx="7" fill={c.structureLit} />
            <rect x="352" y="156" width="10" height="12" rx="4" fill={c.structure} />
            <g style={spin('26s')}>
              <g fill={c.blade}>
                <path d="M337 163 Q343 108 341 62 Q337 52 333 62 Q331 108 337 163 Z" />
                <path d="M337 163 Q391 186 429 208 Q435 199 425 195 Q386 176 337 163 Z" />
                <path d="M337 163 Q283 140 245 118 Q239 127 249 131 Q288 150 337 163 Z" />
              </g>
              <circle cx="337" cy="163" r="6" fill={c.structureLit} />
              <circle cx="337" cy="163" r="2.2" fill={theme === 'night' ? '#e8b23e' : '#8fb8cc'} />
            </g>
            {/* tower base + transition piece */}
            <path d="M312 430 h44 l6 14 h-56 Z" fill={c.structure} />
            <rect x="310" y="418" width="48" height="12" rx="3" fill={c.structureLit} />
            <path
              d="M331 172 v238"
              stroke={c.structure}
              strokeWidth="1.4"
              opacity="0.5"
              strokeDasharray="3 6"
            />
            <circle cx="337" cy="192" r="2.6" fill={c.beacon}>
              {!reducedMotion && (
                <animate
                  attributeName="opacity"
                  values="1;0.25;1"
                  dur="2.4s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <text x="296" y="466" className="scene-tag" fill={c.hud}>
              T-12 · HAVSUL
            </text>
          </g>

          {/* service platform */}
          <g>
            <polygon points="905,430 917,430 914,318 908,318" fill={c.structure} />
            <polygon points="987,430 999,430 996,318 990,318" fill={c.structure} />
            <polygon points="897,432 912,432 905,444 893,444" fill={c.structure} opacity="0.65" />
            <polygon points="984,432 999,432 1000,444 988,444" fill={c.structure} opacity="0.65" />
            <rect x="862" y="286" width="182" height="34" rx="5" fill={c.structureLit} />
            <rect x="862" y="318" width="182" height="9" fill={c.structure} opacity="0.7" />
            <rect x="880" y="252" width="52" height="36" rx="3" fill={c.structure} />
            <rect x="880" y="252" width="52" height="7" fill={c.structureLit} opacity="0.8" />
            {theme === 'night' &&
              [886, 900, 914, 922].map((x) => (
                <rect key={x} x={x} y="262" width="7" height="7" fill="#e8b23e" opacity="0.75" />
              ))}
            <rect x="952" y="262" width="8" height="26" fill={c.structure} />
            <path
              d="M956 268 L1004 244"
              stroke={c.structure}
              strokeWidth="5"
              strokeLinecap="round"
            />
            <path d="M1004 244 v22" stroke={c.structure} strokeWidth="2.6" />
            <circle cx="1004" cy="270" r="3" fill={c.beacon}>
              {!reducedMotion && (
                <animate
                  attributeName="opacity"
                  values="0.25;1;0.25"
                  dur="2.4s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <text x="872" y="466" className="scene-tag" fill={c.hud}>
              SERVICE DECK
            </text>
          </g>

          {/* inspection drone SEAGULL-2 */}
          <g
            role="button"
            tabIndex={0}
            aria-label="Focus inspection UAV SEAGULL-2"
            data-testid="pin-asset"
            onClick={() => onFraming?.('asset')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFraming?.('asset');
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            <g transform="translate(600 285)">
              <path
                d="M-52 -20 L-18 -6 L18 -6 L52 -20"
                stroke={c.drone}
                strokeWidth="7"
                strokeLinecap="round"
              />
              <path
                d="M-52 34 L-18 20 L18 20 L52 34"
                stroke={c.drone}
                strokeWidth="7"
                strokeLinecap="round"
              />
              <rect x="-25" y="-9" width="50" height="32" rx="9" fill={c.drone} />
              <rect x="-25" y="-9" width="50" height="9" rx="4.5" fill={c.droneLit} />
              <path d="M-14 -3 h28" stroke={c.structure} strokeWidth="1.6" opacity="0.7" />
              <rect x="-6" y="17" width="12" height="6" rx="2" fill={c.structure} />
              <circle cx="0" cy="29" r="7.5" fill="#101820" />
              <circle cx="0" cy="29" r="4" fill="#2c3a47" />
              <circle
                cx="-1.4"
                cy="27.6"
                r="1.2"
                fill={theme === 'night' ? '#9fd0e8' : '#7fa9c0'}
              />
              {[-52, 52].map((x) =>
                [-20, 34].map((y) => (
                  <g key={`${x}-${y}`}>
                    <circle cx={x} cy={y} r="4.5" fill={c.structure} />
                    <ellipse cx={x} cy={y} rx="19" ry="3.4" fill={c.rotor} style={spin('0.5s')} />
                    <ellipse
                      cx={x}
                      cy={y}
                      rx="19"
                      ry="0.7"
                      fill={theme === 'night' ? 'rgba(232,178,62,0.5)' : 'rgba(62,78,92,0.5)'}
                    />
                  </g>
                )),
              )}
              <circle cx="-24" cy="-3" r="2.4" fill={theme === 'night' ? '#e8b23e' : '#b4232a'}>
                {!reducedMotion && (
                  <animate
                    attributeName="opacity"
                    values="1;0.1;1"
                    dur="1.1s"
                    repeatCount="indefinite"
                  />
                )}
              </circle>
              <text x="-24" y="-12" className="scene-tag" fill={c.hud} textAnchor="middle">
                SEAGULL-2
              </text>
            </g>
          </g>

          {/* inspection scan cone under the drone */}
          <g aria-hidden="true" opacity={reducedMotion ? 0 : 1}>
            <path d="M600 324 L492 424 L708 424 Z" fill={`url(#scan-${theme})`} />
          </g>

          {/* evidence pin EV-2214 at blade B */}
          <g
            role="button"
            tabIndex={0}
            aria-label="Select evidence EV-2214: suspected crack, blade B, 38 meter span"
            data-testid="pin-event"
            onClick={() => {
              onSelectPin('EV-2214');
              onFraming?.('event');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectPin('EV-2214');
                onFraming?.('event');
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            <g transform="translate(430 205)">
              <circle
                r="16"
                fill="none"
                stroke={c.pinRing}
                strokeWidth="10"
                style={
                  reducedMotion
                    ? undefined
                    : {
                        animation: 'lab-pin-pulse 2.2s ease-out infinite',
                        transformBox: 'fill-box',
                        transformOrigin: 'center',
                      }
                }
              />
              {/* crosshair ticks */}
              {([0, 90, 180, 270] as const).map((deg) => (
                <line
                  key={deg}
                  x1="0"
                  y1="-27"
                  x2="0"
                  y2="-21"
                  stroke={c.pin}
                  strokeWidth="2"
                  transform={`rotate(${deg})`}
                />
              ))}
              <circle r="11" fill={c.pin} />
              <path
                d="M-3.2 1.2 L-0.6 4 L3.6 -2.2"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              {selectedPin === 'EV-2214' && (
                <circle r="24" fill="none" stroke={c.pin} strokeWidth="2" strokeDasharray="5 5" />
              )}
              <g transform="translate(20 -14)">
                <rect x="0" y="-11" width="86" height="21" rx="4" fill={c.hudBg} />
                <text x="7" y="4" className="scene-tag" fill={c.pin}>
                  EV-2214 · 38 m
                </text>
              </g>
            </g>
          </g>
        </g>

        {/* frame-corner brackets — sensor-feed reading */}
        <g aria-hidden="true" fill="none" stroke={c.hud} strokeWidth="2" opacity="0.55">
          <path d="M14 34 V16 h18" />
          <path d="M1168 16 h18 v18" />
          <path d="M1186 641 v18 h-18" />
          <path d="M32 659 H14 v-18" />
        </g>

        {/* HUD instruments */}
        <g className="scene-hud" aria-hidden="true">
          <rect x="18" y="18" width="212" height="132" rx="8" fill={c.hudBg} />
          <text x="32" y="42" className="hud-k" fill={c.hud}>
            SEAGULL-2 · STATION HOLD
          </text>
          <text x="32" y="64" className="hud-v" fill={c.hud}>
            ALT 41 m · GS 4.2 m/s
          </text>
          <text x="32" y="84" className="hud-v" fill={c.hud}>
            WIND 9 m/s / 214° · BAT 71 %
          </text>
          <text x="32" y="104" className="hud-v" fill={c.hud}>
            GIMBAL −42° · OPTICAL 240 f
          </text>
          <text x="32" y="124" className="hud-k" fill={theme === 'night' ? '#e8b23e' : c.pin}>
            EVENT EV-2214 · BLADE B · 38 m
          </text>
          <text x="32" y="142" className="hud-k" fill={c.hud}>
            62.1462° N, 5.9123° E (SIM)
          </text>
        </g>

        {hudFraming && (
          <g className="scene-hud" aria-hidden="true">
            <rect x="1008" y="575" width="174" height="82" rx="8" fill={c.hudBg} />
            <text x="1022" y="598" className="hud-k" fill={c.hud}>
              FRAMING
            </text>
            {(['overview', 'asset', 'event'] as Framing[]).map((fr, i) => (
              <text
                key={fr}
                x="1022"
                y={619 + i * 16}
                className={framing === fr ? 'hud-v hud-v--on' : 'hud-v'}
                fill={c.hud}
                opacity={framing === fr ? 1 : 0.66}
              >
                {framing === fr ? '› ' : '  '}
                {fr === 'overview' ? 'Overview' : fr === 'asset' ? 'Asset focus' : 'Event focus'}
              </text>
            ))}
          </g>
        )}

        {/* capture indicator */}
        <g className="scene-hud" aria-hidden="true">
          <circle cx="1160" cy="30" r="4" fill={c.pin}>
            {!reducedMotion && (
              <animate
                attributeName="opacity"
                values="1;0.2;1"
                dur="1.6s"
                repeatCount="indefinite"
              />
            )}
          </circle>
          <text x="1146" y="34" className="hud-k" fill={c.hud} textAnchor="end">
            SIM FEED 14:28:41
          </text>
        </g>
      </svg>
    </div>
  );
}

const STARS: Array<[number, number, number, number]> = [
  [90, 60, 1.4, 0.9],
  [240, 96, 1, 0.7],
  [420, 48, 1.6, 0.8],
  [610, 110, 1, 0.6],
  [700, 40, 1.3, 0.85],
  [830, 88, 1, 0.65],
  [1120, 210, 1.4, 0.8],
  [60, 200, 1, 0.6],
  [180, 160, 1.2, 0.7],
  [520, 150, 0.9, 0.5],
  [760, 160, 1.2, 0.75],
  [1060, 60, 1, 0.6],
];

const WAVES: Array<[number, number, number]> = [
  [30, 470, 90],
  [220, 505, 120],
  [500, 462, 80],
  [760, 530, 130],
  [1000, 480, 100],
  [130, 585, 140],
  [420, 620, 110],
  [820, 600, 150],
  [1060, 650, 120],
  [300, 555, 70],
  [640, 570, 90],
  [80, 655, 100],
];

const WHITECAPS: Array<[number, number, number]> = [
  [140, 486, 26],
  [560, 494, 30],
  [905, 500, 24],
  [320, 560, 34],
  [700, 574, 28],
  [1080, 588, 32],
  [220, 640, 38],
  [860, 648, 30],
];

export const SCENE_KEYFRAMES = `
@keyframes lab-scene-spin { to { transform: rotate(360deg); } }
@keyframes lab-pin-pulse {
  0% { transform: scale(0.7); opacity: 0.9; }
  70% { transform: scale(1.9); opacity: 0; }
  100% { transform: scale(1.9); opacity: 0; }
}
`;
