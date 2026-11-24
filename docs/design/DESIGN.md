---
name: Jun The Film
description: Visual system for a first-person, scroll-played arthouse film portfolio. Film Credit direction; diegetic scene palette, no brand color.
status: final
created: 2026-11-18
updated: 2026-11-19
sources:
  - ../../../specs/spec-portfolio-scrollytelling/SPEC.md
colors:
  # Grouped (not flat) on purpose: EXPERIENCE.md references these exact paths.
  scene:
    eyelid: '#0A0806'        # closed-eye warm black (wake sequence, CRT-off black)
    night: '#0F2226'         # teal shadow, base grade of the night
    overcast: '#12232A'      # rain sky at the horizon; zenith #050C12
    clear-night: '#0A1430'   # clear Shinkai sky at zenith; horizon #26335A
    monitor: '#F2D3A8'       # amber-white practical light (fills and light only)
    desk: '#3A2A1C'          # walnut
    coffee: '#4A2F1E'        # cold coffee
    dawn-1: '#E8A37A'        # peach horizon
    dawn-2: '#F3D9B8'        # cream sky, also the offer accent
    lightning: '#F4F1E8'     # film-white flash
  signal:
    warning: '#E0A43A'       # amber WARN, never text on light ground
    error: '#C8392E'         # error FILL and light only (4.08:1 on black: not a text color)
    error-text: '#FF7B6E'    # error text
    success: '#5FA37A'       # success fill (deploy bar, online dot)
    success-text: '#9FD3B1'  # success text
    alarm-red: '#E04A3C'     # monitor/room light when the alarm fires (light, not text)
    beacon-red: '#E0473A'    # rooftop aviation beacons in the cliffhanger
  ink:
    primary: '#F1EBE0'       # warm white
    soft: '#CFC8BC'          # secondary text
    muted: '#A8A196'         # captions, credit roles, inactive nav
    on-light: '#120D09'      # text on an ink-filled pill on hover
    terminal: '#C9D8D4'      # default terminal glyph color
  surface:
    scrim: '#060808D1'       # rgba(6,8,8,.82), behind every line of film text
    letterbox: '#000000'     # bars
    panel: '#060504'         # offer channels, archive/award panels, post-film pages
    hairline: '#2A241E'      # 1px dividers
typography:
  display-serif:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: clamp(34px, 6vw, 86px)
    fontWeight: '400'
    lineHeight: '1.05'
    letterSpacing: -0.02em
  title-serif:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: clamp(28px, 4.2vw, 58px)
    fontWeight: '400'
    lineHeight: '1'
    letterSpacing: -0.02em
  subtitle-serif:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: clamp(17px, 1.9vw, 26px)
    fontWeight: '400'
    lineHeight: '1.3'
  kanji-vertical:
    # RETIRED 2026-11-19: in-scene act title cards removed; unused in the film. Key kept so references do not break; use only if chrome needs it.
    status: retired
    fontFamily: '"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", "MS Mincho", serif'
    fontSize: clamp(40px, min(6.4vw, 8.5vh), 92px)
    fontWeight: '400'
    lineHeight: '1'
    letterSpacing: 0.14em
  kanji-chrome:
    # Chapter-nav kanji mark only (第一幕…第五幕), lang="ja", aria-hidden; the act name beside it carries the accessible label.
    fontFamily: '"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", "MS Mincho", serif'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1'
    letterSpacing: 0.08em
  ui-caps:
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: 10.5px
    fontWeight: '400'
    lineHeight: '1.4'
    letterSpacing: 0.32em
  body:
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif'
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  terminal:
    fontFamily: 'ui-monospace, "SF Mono", Consolas, "Liberation Mono", monospace'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.75'
  numeral:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: clamp(40px, 5.4vw, 76px)
    fontWeight: '400'
    lineHeight: '1'
rounded:
  none: 0px
  pill: 9999px
  card: 0px
spacing:
  letterbox: clamp(40px, 10dvh, 96px)        # 96px on normal desktop heights; shrinks at 400% zoom / short viewports
  letterbox-mobile: clamp(40px, 10dvh, 96px)
  min-hit: 44px                               # touch hit area via invisible padding; 24px minimum for fine pointers
  gutter: clamp(16px, 2.6vw, 40px)
  scene-margin: clamp(16px, 4vw, 64px)
  scrim-pad-x: 14px
  scrim-pad-y: 4px
  credit-gap: clamp(26px, 4vh, 44px)
  section: 64px
  hairline: 1px
components:
  letterbox-bar:
    background: '{colors.surface.letterbox}'
    height: '{spacing.letterbox}'
    padding-x: '{spacing.gutter}'
  chrome-nav:
    typography: '{typography.ui-caps}'
    color: '{colors.ink.soft}'
    color-active: '{colors.ink.primary}'
    act-index-font: '{typography.subtitle-serif.fontFamily}'
    act-index-size: 15px
    act-kanji: '{typography.kanji-chrome}'
    min-hit: '{spacing.min-hit}'
    focus-ring: '2px solid {colors.ink.primary}, 0 0 0 4px #000 halo'
  act-title-card:
    # RETIRED 2026-11-19: no in-scene act title cards in the film. Key kept so references do not break; do not build.
    status: retired
    kanji: '{typography.kanji-vertical}'
    latin: '{typography.title-serif}'
    latin-style: italic
    label: '{typography.ui-caps}'
    color: '{colors.ink.primary}'
    rule: '1px solid rgba(241,235,224,.35)'
    backing: 'radial scrim rgba(4,6,6,.72) to transparent'
  subtitle:
    # CC only: narration is visually hidden HTML, shown only when the CC toggle is on (off by default).
    typography: '{typography.subtitle-serif}'
    background: '{colors.surface.scrim}'
    color: '{colors.ink.primary}'
    padding: '{spacing.scrim-pad-y} {spacing.scrim-pad-x}'
  pill-cta:
    radius: '{rounded.pill}'
    border: '1px solid {colors.ink.primary}'
    color: '{colors.ink.primary}'
    hover-background: '{colors.ink.primary}'
    hover-color: '{colors.ink.on-light}'
    typography: '{typography.ui-caps}'
    padding: 8px 16px
    solid-padding: 12px 22px
    min-hit: '{spacing.min-hit}'
  hud:
    typography: '{typography.ui-caps}'
    color: '{colors.ink.soft}'
    chip-background: '{colors.surface.scrim}'
    deploy-track: '#3A332B'
    deploy-fill: '{colors.signal.success}'
    deploy-height: 2px
  countdown:
    typography: '{typography.numeral}'
    color: '{colors.signal.error-text}'
    color-resolved: '{colors.signal.success-text}'
    label: '{typography.ui-caps}'
    background: '{colors.surface.scrim}'
  terminal-screen:
    typography: '{typography.terminal}'
    color: '{colors.ink.terminal}'
    error: '{colors.signal.error-text}'
    warn: '#EDC07A'
    fixed: '{colors.signal.success-text}'
    background-incident: '#160B0B'
    background-resolved: '#0B1410'
  game-hit-circle:
    ring: '{colors.ink.primary}'
    ring-width: 2.5px
    approach-ring: '{colors.signal.error-text}'
    fill: 'rgba(22,11,11,.65)'
    number-font: '{typography.numeral.fontFamily}'
    hit: '{colors.signal.success-text}'
    miss: '{colors.signal.error-text}'
    cursor-trail: '{colors.scene.monitor}'
  end-credit-block:
    role: '{typography.ui-caps}'
    role-color: '#BDB6AA'
    name: '{typography.title-serif}'
    name-size: clamp(22px, 2.6vw, 34px)
    name-style: italic
    gap: '{spacing.credit-gap}'
    backing: 'radial vignette scrim rgba(5,6,7,.78) to transparent'
  credit-project-preview:
    frame-radius: '{rounded.none}'
    frame-border: '1px solid {colors.surface.hairline}'
    caption: '{typography.ui-caps}'
    live-badge: '{typography.ui-caps}'
    step-number: '{typography.numeral.fontFamily}'
  offer-panel:
    eyebrow: '{typography.ui-caps}'
    headline: '{typography.display-serif}'
    headline-size: clamp(32px, 5vw, 70px)
    accent: '{colors.scene.dawn-2}'
    channel-background: '{colors.surface.panel}'
    channel-hover: '#15110D'
    channel-divider: 'rgba(241,235,224,.14)'
    radius: '{rounded.none}'
  archive-panel:
    background: '{colors.surface.panel}'
    divider: '{colors.surface.hairline}'
    title: '{typography.title-serif}'
    meta: '{typography.ui-caps}'
    body: '{typography.body}'
    radius: '{rounded.card}'
  award-card:
    background: '{colors.surface.panel}'
    title: '{typography.subtitle-serif}'
    meta: '{typography.ui-caps}'
    radius: '{rounded.card}'
  name-card:
    background: '{colors.surface.scrim}'
    top-rule: '1px solid #4A2320'
    command: '{typography.terminal}'
    headline: '{typography.title-serif}'
    headline-style: italic
    input: '{typography.subtitle-serif}'
    input-rule: '1px solid #7A7268'      # >= 3:1 on panel/scrim (non-text contrast)
    color: '{colors.ink.primary}'
    radius: '{rounded.none}'
  certificate-card:
    background: '{colors.surface.panel}'
    border: '1px solid {colors.scene.dawn-2}'
    eyebrow: '{typography.ui-caps}'
    name: '{typography.title-serif}'
    name-style: italic
    score: '{typography.numeral}'
    meta: '{typography.ui-caps}'
    name-color: '{colors.ink.primary}'
    accent: '{colors.scene.dawn-2}'
    radius: '{rounded.none}'
    export-size: 1200x627px              # LinkedIn share / OG ratio 1.91:1, PNG
    preview-width: clamp(280px, 40vw, 480px)
  case-timeline:
    step-number: '{typography.numeral.fontFamily}'
    step-title: '{typography.subtitle-serif}'
    step-meta: '{typography.ui-caps}'
    rule: '1px solid {colors.surface.hairline}'
    active: '{colors.ink.primary}'
    inactive: '{colors.ink.muted}'
    background: '{colors.surface.scrim}'
  business-counter:
    value: '{typography.numeral}'
    label: '{typography.ui-caps}'
    color: '{colors.ink.primary}'
    label-color: '{colors.ink.soft}'
    background: '{colors.surface.scrim}'
  before-after-slider:
    frame-border: '1px solid {colors.surface.hairline}'
    handle: '{colors.ink.primary}'
    handle-size: '{spacing.min-hit}'
    label: '{typography.ui-caps}'
    radius: '{rounded.none}'
  testimonial-card:
    background: '{colors.surface.scrim}'
    quote: '{typography.subtitle-serif}'
    quote-style: italic
    name: '{typography.ui-caps}'
    company-color: '{colors.ink.muted}'
    photo-size: 56px
    photo-radius: '{rounded.pill}'
    radius: '{rounded.none}'
  district-card:
    background: '{colors.surface.scrim}'
    name: '{typography.subtitle-serif}'
    outcome: '{typography.body}'
    link: '{typography.ui-caps}'
    color: '{colors.ink.primary}'
    radius: '{rounded.none}'
  entry-screen:
    background: '{colors.scene.eyelid}'
    title: '{typography.display-serif}'
    option: '{typography.ui-caps}'
    selected-border: '1px solid {colors.ink.primary}'
    radius: '{rounded.pill}'
---

> Inherits product scope and capabilities from `SPEC.md` by reference. This file owns **how it looks**; how it behaves (playback, timing, interaction, reduced-motion paths) lives in `EXPERIENCE.md`.
> **The spines (this file and `EXPERIENCE.md`) win on conflict** with every visual reference below. Each reference is also linked inline where it applies:
> - [`mockups/film-prototype/index.html`](mockups/film-prototype/index.html): motion prototype (grade, letterbox chrome, HUD/game, live-review credits, cliffhanger, office hub). Its top-bar act card is superseded (see Layout & Spacing).
> - [`mockups/film-prototype/`](mockups/film-prototype/): motion reference source (`style.css` for the bar grid and type sizes, `main.js` / `game.js` for camera and game motion).
> - [`mockups/direction-film-credit.html`](mockups/direction-film-credit.html): static frame of the chosen Film Credit direction; its act card and "II · Sedih" label are superseded.
> - [`wireframes/ia.excalidraw`](wireframes/ia.excalidraw): surface map (owned by `EXPERIENCE.md` → IA).
> Art direction (3D sets, lighting, post-processing, characters, camera shot list, recommended hybrid rendering path): `art-direction.md`.
> Show, don't tell (which scene replaces each narration line): `script.md` → "Show, don't tell".

## Brand & Style

*Jun: The Film* is not a portfolio that has a film on it; it **is** a film. Every scroll position must look like a frame lifted from an arthouse feature: a heavy letterbox, a teal-shadow / amber-highlight cinema grade, a serif that belongs to the film and a quiet wide-tracked grotesk that belongs to the projectionist. The chosen direction is **Film Credit** (static frame: [`mockups/direction-film-credit.html`](mockups/direction-film-credit.html) for grade, letterbox and type; its in-picture act card is superseded).

- **Camera is first person.** The visitor is the software engineer: the frame is Jun's eyes at a desk in an open-plan office at night. Over-the-shoulder framing is not the default.
- **Cinematography.** Demon Slayer (ufotable) camera energy (low angle, Dutch tilt, speed-ramped push-in, bloom) is spent **once per act**, inside the FPS camera, at that act's single wow moment. Everything else is calm and observational.
- **Sky.** Makoto Shinkai / *Your Name* is the bar for the night sky and dawn: dense starfield, Milky Way band, graded gradients and soft glow.
- **Type restraint.** telemyr.com is the typographic reference: one grotesk, regular weight, tight display tracking, generous body leading, muted secondary text, pill CTA with an arrow.
- **Setting.** A real Tokyo-side open-plan office at night with a living city and a natural Mt. Fuji beyond the window.
- **Fidelity bar: photoreal AAA realism.** Every frame reads like a first-person still from a AAA game cinematic: realistic textures, materials and detail on the level of **Ghost of Tsushima** and **GTA 6** (replaces the earlier "painterly realism, anime-informed" target). Sky drama and the Japanese mood stay; the grade stays Film Credit. Flat CSS shapes, clip-path mountains and dot-grid cities are prototype stand-ins only. The recommended hybrid rendering path (offline-rendered, scroll-scrubbed video/image sequences plus realtime interactive layers) lives in `art-direction.md`.
- **Show, don't tell.** No narration subtitles on screen. The story is carried by staging, camera, light, sound and diegetic text (monitor, Slack, sticky notes, phone). Narration exists only as visually hidden HTML and as CC subtitles when the visitor turns CC on.

**Rejected:** neon cyberpunk, glassmorphism, generic portfolio templates, neo-brutalism, loud or oversaturated color.

## Colors

The palette is **diegetic**: every color is a light or a material that exists in the scene. There is **no brand color**. Color changes because time, weather and emotion change, never to decorate the UI.

**Cinema grade.** Shadows lean teal (`{colors.scene.night}`, applied as a soft-light teal wash `rgba(20,74,84,.26)` in the prototype), highlights lean amber from practical lights (`{colors.scene.monitor}`). Skin of the room is walnut `{colors.scene.desk}` and cold `{colors.scene.coffee}`.

**Scene states** (strict visual rules):

| State | Sky | Must show | Must not show |
|---|---|---|---|
| Wake / black | `{colors.scene.eyelid}` | warm black, monitor glow bleeding through | anything legible before the eyes open |
| Rain (Sendiri / Alone, Tegang / Tense) | `{colors.scene.overcast}` horizon, `#050C12` zenith | low overcast clouds, rain streaks, glass droplets, rain shadows on walls | stars, moon |
| Alarm (Tense) | sky shifts toward `#3A1414` | room light mixes from `{colors.scene.monitor}` toward `{colors.signal.alarm-red}` as a slow ramp (≥ 500 ms, ≤ 25% luminance change) | stepped or alternating full-screen red; any red change above the flash limits in `EXPERIENCE.md` → Flashing |
| Clear (Success) | `{colors.scene.clear-night}` zenith, `#26335A` horizon | Your-Name starfield, Milky Way band, full moon `#D9D2C4` with soft halo, moonlight shadows | rain, clouds over the moon |
| Dawn | `{colors.scene.dawn-1}` to `{colors.scene.dawn-2}` | moon setting, stars fading, sun rising **behind** Fuji, warm wash | moon high in the sky |
| Cliffhanger | dawn sky | city rooftop beacons `{colors.signal.beacon-red}` blinking 1, then 2, then 10, in phase, together < 25% of any 10° field (rates: `EXPERIENCE.md` → Flashing) | red over UI text; large or out-of-phase red blinking |

**Lightning** `{colors.scene.lightning}` is a film-white exposure flash, never pure `#FFFFFF`.

**Signal colors** are reserved for system state. `{colors.signal.error}` and `{colors.signal.alarm-red}` are fills and light only. Text that means "error" uses `{colors.signal.error-text}`; text that means "fixed" uses `{colors.signal.success-text}`. `{colors.signal.warning}` marks WARN lines and warning glows. Red never decorates.

**Ink** is warm white, never pure white: `{colors.ink.primary}` for content, `{colors.ink.soft}` for secondary text, `{colors.ink.muted}` for captions and credit roles.

**Contrast rule.** All film text sits on `{colors.surface.scrim}` (or the letterbox / panel) and must reach at least 4.5:1. The worst case is the scrim over a full lightning frame, which composites to `#313230`. Ratios (WCAG 2.x):

| Text | Ground | Ratio |
|---|---|---|
| ink.primary | letterbox `#000000` | 17.70 |
| ink.soft | letterbox | 12.64 |
| ink.muted | letterbox | 8.20 |
| ink.primary | scrim over lightning `#313230` | 10.86 |
| ink.soft | scrim over lightning | 7.76 |
| ink.muted | scrim over lightning | 5.03 |
| signal.error-text | scrim over lightning | 5.10 |
| signal.success-text | scrim over lightning | 7.63 |
| ink.primary | surface.panel `#060504` | 17.16 |
| scene.dawn-2 (offer accent) | surface.panel | 14.96 |
| ink.on-light | ink.primary (pill hover) | 16.28 |
| signal.error `#C8392E` | letterbox | 4.08, **fails: never use as text** |

Radial credit backings fade to transparent at the edges; text must stay inside the opaque core. [ASSUMPTION] Contrast of text against the radial backings' fading zone has not been measured; keep glyphs within the core (≥ .55 alpha).

## Typography

Three active families, each with one job (the Mincho role is retired). Weights stay at 400; hierarchy comes from size, italics, tracking and case, not bold.

- **Grotesk (Helvetica Neue stack): the projectionist.** `{typography.ui-caps}` for all chrome, labels, HUD, credit roles and eyebrows: 10.5px uppercase, tracked .24em to .42em (nav .28em, credit lines .32em, eyebrows and labels .42em). `{typography.body}` (16px / 1.6) for longer reading in archive and project pages; phone scale follows telemyr's uniform step-down.
- **Serif (Georgia class): the film.** Everything that belongs to the story: act names in the chapter nav, CC subtitles, credits, countdown numerals, the theme line, TO BE CONTINUED, the offer. `{typography.display-serif}` for title moments (TO BE CONTINUED, offer headline at clamp(32px, 5vw, 70px), centre credit cards at clamp(24px, 3.6vw, 52px)). `{typography.title-serif}` italic for credit names. `{typography.subtitle-serif}` roman for CC subtitles (only when CC is on), in the selected language only (ID or EN, never both stacked). Italic is the film's emphasis voice. [ASSUMPTION] Georgia is a stand-in; the final licensed serif (with italic) is open.
- **Mincho: chrome only.** `{typography.kanji-chrome}` sets the small kanji act mark (第一幕…第五幕) in the bottom-bar chapter nav, beside the serif act name; marked `lang="ja"` and `aria-hidden`. Ships as a system Mincho stack (no web font) [ASSUMPTION]. `{typography.kanji-vertical}` (vertical in-scene title cards) stays retired.
- **Mono: the machine.** `{typography.terminal}` for terminal, logs, Slack timestamps, game-over commands, the intrusion screen. Diegetic only; never used for site chrome.
- **Numerals.** `{typography.numeral}` uses tabular figures for the countdown and counters.

Display tracking is negative (-0.02em), body is neutral, caps are wide. No all-caps serif.

## Layout & Spacing

**The frame.** The page is a fixed stage with two `{colors.surface.letterbox}` bars of `{spacing.letterbox}` (96px at normal desktop heights, shrinking to 40px on short viewports and at high zoom) top and bottom; the picture lives between them, aiming at a 2.39:1 feel on desktop. All chrome lives **inside the bars**, set like opening credits (reference: bar grid in [`mockups/film-prototype/index.html`](mockups/film-prototype/index.html)):

- Top bar: left credit line ("Jun presents"), right nav (Lewati Cerita, Proyek, Penghargaan, pill Hubungi). **No centre act card** (the prototype's top-bar act card is superseded).
- Bottom bar: left chapter nav, five buttons each showing the kanji mark in `{typography.kanji-chrome}` plus the act name in serif (glossary: `EXPERIENCE.md` → IA → Act names: Mulai, Sendiri, Tegang, Berhasil, Akhir); inactive names in `{colors.ink.muted}`, the current act's name in italic `{colors.ink.primary}`. This is the only act labelling in the film. Right tools: round mute control, CC toggle, fullscreen toggle, Motion toggle (caps "Motion" label, underlined when reduced), Cinematic/Lite toggle, ID / EN with an underline on the active language.
- Every chrome control reserves a `{spacing.min-hit}` hit area through invisible padding, so the visuals do not change.
- **Reflow and zoom.** Below 320 CSS px wide or 480 CSS px tall, the bars drop to their 40px minimum and all chrome collapses into one menu button (caps "Menu") that opens a full-height menu sheet on `{colors.surface.panel}`; panels, the offer, the name card and the certificate card become full-height scrolling sheets. Behaviour: `EXPERIENCE.md` → Reflow and zoom.
- No scrollbar, progress bar or scroll indicator anywhere in the frame; the browser scrollbar is hidden.
- Bar padding is `{spacing.gutter}`. In-picture overlays (alarm copy, countdown, HUD) keep `{spacing.scene-margin}` from the picture edges.

**Film text placement.** No narration subtitles by default. When CC is on, CC subtitles (narration and SFX captions) sit centred near the bottom of the picture (about 7% up), max 92% wide. There are no in-scene title cards. Alarm copy is bottom-left; countdown top-right; HUD runs along the picture bottom.

**Long end credits.** Full screen within the frame. A centre column of credit text (role in caps, name in italic serif) rolls with `{spacing.credit-gap}` rhythm. **Project previews alternate left and right** of the centre column; each is a **live review / presentation** of the system (see `credit-project-preview`), and the centre text beside it carries numbered presenter steps synced to the demo. Project segments get more scroll distance than other beats. The roll ends with *Special thanks* to the visitor (the mysterious saviour). [ASSUMPTION] Preview frames occupy roughly 30 to 36% of picture width each, vertically centred on their credit block.

**Offer.** Left-aligned block, max 980px, centred in the frame: eyebrow with a hairline that draws to the right, display serif headline with an italic `{colors.scene.dawn-2}` accent, italic soft lead, then a 3-up channel grid (form, WhatsApp, email) separated by 1px gaps, then a muted privacy line.

**Post-film pages and project pages** (indexable HTML, office-styled): `{colors.surface.panel}` ground, `{spacing.section}` vertical padding plus the bar height, auto-fit columns of min 240px separated by `{colors.surface.hairline}` top rules.

**Fullscreen.** The film targets browser fullscreen (requested from the entry-screen choice). On iPhone Safari, which has no element fullscreen, the same layout fits to the visible viewport (`dvh`) [ASSUMPTION].

**Mobile (≤ 760px).** Bars keep `{spacing.letterbox-mobile}` but restack: top bar becomes two rows (a small Contact pill right; nav row below, spread). The chapter nav shows kanji marks only, with the current act's name beside its mark. Bottom bar stacks chapter index over tools. The credit line is hidden. HUD wraps: deploy bar and the "Biar Jun yang fix" (EN "Let Jun fix it") button go full width. Offer channels become one column. Credit previews stack above their text instead of alternating. [ASSUMPTION] Mobile bar height stays 96px as in the motion study; the earlier static mock used 120px.

## Elevation & Depth

UI cards do not float. **There are no drop shadows on UI.** Depth belongs to the picture:

- **Photoreal scene** (Cinematic): the office, desk props, window, city and Fuji are photoreal, lit with moonlight and monitor light casting real shadows. Cinematic shots are offline-rendered and scroll-scrubbed; realtime layers cover interactive parts (recommended hybrid in `art-direction.md`).
- **Parallax layers** at distinct depths: room, window glass with droplets, near city, mid city, far city, haze, Fuji, moon and stars.
- **Light bloom:** soft and wide, from the monitor, moon, sun, city windows and beacons. Never a neon edge glow.
- **Atmosphere:** light-pollution haze over the city (warm `rgba(230,170,120,·)`), atmospheric haze on Fuji, rain on glass.
- **Film finish:** grain (overlay, about .12 opacity), vignette (to .7 black at the corners), teal grade.
- **Scrims** are the only "elevation" for text: flat `{colors.surface.scrim}` boxes for HUD chips and CC subtitles (CC only; see Brand & Style → Show, don't tell); radial scrims for credits.
- **Rendering stack (shipping):** offline-rendered cinematic shots plus realtime interactive layers (see `art-direction.md`); for realtime parts, baked lightmaps for the static office plus a few realtime lights (monitor key, alarm, moon/dawn directional, corridor, office panels); post-processing in order ACES → soft bloom (screens, sky glow, beacons only) → subtle SSAO → depth of field for focus pulls (wake, Kia's note, whip back) → vignette → animated grain → grade LUT. No heavy chromatic aberration or lens dirt. Full plan and color script: `art-direction.md`.

**Reduced motion** (OS setting or the Motion toggle) uses a separate **still-plate set** in both tiers: one graded keyframe plate per beat, same composition and grade, joined by crossfades, with no camera drift, no parallax and static grain (asset list: `art-direction.md` → Reduced-motion asset set).

**Lite** keeps the same compositions as **2.5D pre-rendered layered plates** with parallax and depth (parallax off under reduced motion), same palette, same grade, grain and vignette. [ASSUMPTION] Plate count, resolution and whether grain is baked or live are decided in bmad-architecture.

## Shapes

The language is **square and hairline**, like a film title sequence. `{rounded.none}` for scrims, panels, channel tiles, preview frames and inputs (inputs are a single bottom hairline). `{rounded.card}` is also 0 and exists so archive and award surfaces can be tuned in one place. `{rounded.pill}` appears **only** on CTAs (Contact, Retry, "Biar Jun yang fix", sequel CTA) and the circular mute control. Dividers are 1px hairlines in `{colors.surface.hairline}` or `rgba(241,235,224,.14–.35)`.

## Components

- **letterbox-bar.** Solid black, 96px, full width, fixed above the picture. Hosts all chrome. Never transparent, never blurred.
- **chrome-nav.** `{typography.ui-caps}` in `{colors.ink.soft}`, `{colors.ink.primary}` on hover and when current. Chapter nav: kanji mark in `{typography.kanji-chrome}` plus the act name in the serif at 15px, `{colors.ink.muted}`; the current act shows "第二幕 *Sendiri*" (EN "*Alone*") in italic `{colors.ink.primary}`. Nav labels: Lewati Cerita, Proyek, **Penghargaan** (EN **Awards**; formerly "Sertifikat", renamed so it does not collide with the visitor's Server Saver Certificate), Hubungi. Contact is a `pill-cta`. Tools in the bottom bar: mute, **CC** toggle (caps label, underlined when on; off by default), **fullscreen** toggle, **Motion** toggle (caps label, underlined when reduced), Cinematic/Lite, ID / EN. Every control reserves `{spacing.min-hit}`. Focus ring: 2px `{colors.ink.primary}` outline with a 4px black outer halo, so it stays visible over dawn and lightning frames.
- **act-title-card. Retired.** In-scene act title cards (vertical kanji, Latin name, dust exit) are removed from the film; the chapter nav in the chrome is the only act labelling. Token keys stay, marked `status: retired`, so references do not break. Do not build.
- **subtitle (CC only).** Shown only when CC is on. One line group in `{typography.subtitle-serif}` on a tight scrim box, in the selected language only; carries narration (otherwise visually hidden HTML) and SFX captions. No second-language subline: EN shows English only, ID shows Indonesian only.
- **pill-cta.** Outline variant: 1px ink border, ink text, caps, arrow "→"; hover inverts to ink fill with `{colors.ink.on-light}` text. Solid variant (in-picture actions such as "Biar Jun yang fix"): ink fill, 12px 22px padding, 11.5px caps. Ghost variant: border `#5A534A`, soft text, for secondary actions (Skip name).
- **hud.** Row of caps chips on scrim (Lives, Combo, Deploy %), a 2px deploy track `#3A332B` that fills with `{colors.signal.success}`, and the solid pill. No icons-as-decoration.
- **countdown.** Serif tabular numeral in `{colors.signal.error-text}` with a caps label in muted, on scrim, top-right. Turns `{colors.signal.success-text}` when resolved.
- **terminal-screen.** Diegetic monitor content rendered as a texture: incident ground `#160B0B`, resolved ground `#0B1410`, default glyphs `{colors.ink.terminal}`, error lines `{colors.signal.error-text}`, warn `#EDC07A`, fixed lines `{colors.signal.success-text}`, faint scanlines. During the incident an **orders-waiting counter** (tabular `{typography.terminal}` figures in `{colors.signal.error-text}`) climbs on the terminal to carry the fear without words. Slack view: dark sidebar, channel names muted, online dot `{colors.signal.success}`. Intrusion view: red-tinted log wall, a scrim band, "⚠ Intrusion detected" blinking between `{colors.signal.error-text}` and `#B4463C` at 1 Hz, text-sized only (never a full-screen area; static under reduced motion), a mono stat line in ink ("2.4M requests/sec").
- **game-hit-circle.** Dark translucent fill, 2.5px ink ring, serif number inside, a shrinking approach ring in error-text, a faint error-text drop line with "ERR" label from above. Judgement text in italic serif: success-text for 300/100/50, error-text for MISS; a success ring blooms on hit. Combo "12×" in italic serif. Cursor trail is a short amber `{colors.scene.monitor}` stroke. Game-over panel: `rgba(6,8,8,.9)` panel with a dark red top hairline `#4A2320`, mono command line, italic serif headline, pill actions. The name panel is its own component, `name-card` (below). Motion reference: game in [`mockups/film-prototype/index.html`](mockups/film-prototype/index.html).
- **name-card.** Same panel language as game over: `{colors.surface.scrim}` sheet, dark red top hairline, mono command line ("$ deploy --credit"), italic title-serif headline, name input as a centred `{typography.subtitle-serif}` field whose only boundary is a 1px `#7A7268` bottom rule (≥ 3:1 on the scrim), solid pill [Simpan], ghost pills [Lewati] and [Tutup]. After a real win and name entry, the certificate-card appears inside the same sheet.
- **certificate-card (Server Saver Certificate).** The visitor's own certificate, never on the awards wall. Square `{colors.surface.panel}` card with a 1px `{colors.scene.dawn-2}` border: caps eyebrow "SERVER SAVER CERTIFICATE", italic title-serif name in ink, score in `{typography.numeral}`, caps date and "Jun: The Film" credit line, a small dawn-2 accent rule. On screen it previews at `clamp(280px, 40vw, 480px)` wide; the downloadable PNG is **1200 × 627 px** (LinkedIn/OG 1.91:1) with the same layout, scene-graded dawn backdrop and all text inside a 64px safe margin. Pills below: solid [Unduh] (EN [Download]), outline [Bagikan ke LinkedIn].
- **case-timeline (Act IV How I Work).** Horizontal row of 5 to 6 steps on a scrim band: serif step numeral, roman subtitle-serif step title, caps meta; a 1px hairline joins the steps and the active step is ink, the rest muted. Stacks vertically on phones.
- **business-counter (Act IV Business Numbers).** Large `{typography.numeral}` value (tabular figures) in ink over a caps label in soft, on scrim; 2 to 4 counters in a row, one column on phones. Business language only ("3 jam → 4 menit").
- **before-after-slider (Act IV).** Square-cornered hairline frame with two graded screenshots; a 1px ink divider with a circular ink handle of `{spacing.min-hit}`; caps "SEBELUM" / "SESUDAH" labels on scrim chips in the top corners.
- **testimonial-card (Act IV).** Scrim panel, 56px round photo (the only round image), italic subtitle-serif quote, caps name and company in muted. No quote-mark ornaments, no stars.
- **district-card (Act IV city gallery).** Small scrim card anchored near its district in the window: serif project name, one-line body outcome, caps "LIHAT DI ARSIP →" link. Under reduced motion the same cards render as a plain stacked list on `{colors.surface.panel}`.
- **end-credit-block.** Caps role in `#BDB6AA`, italic serif name, larger italic heading for sections (Cast & Crew, Starring, Supporting). On a soft radial vignette scrim, never a hard band.
- **credit-project-preview (live review).** Square-cornered frame with a hairline border, alternating left/right of the centre text, presenting the system as a **live review / presentation**: a scripted demo plays inside the frame (URL typed, real screens, a cursor that moves and clicks with a ripple, form typing, a success toast, dashboard counters and charts animating, presenter callouts), with a caps **LIVE DEMO** badge and a timecode in the frame corner. The centre text shows **numbered presenter steps** (step number in the serif numeral face) synced to the demo. Scroll-driven and reversible. A caps caption (project, years) sits under the frame. Previews are graded with the scene (slightly desaturated, teal shadows) so they belong to the film. Recording guidance: `art-direction.md` → End-credit live review. Motion reference: credits in [`mockups/film-prototype/index.html`](mockups/film-prototype/index.html). [ASSUMPTION] Demos are scripted captures or realtime HTML layers, not live iframes.
- **offer-panel.** Layout: see Layout & Spacing → Offer. Headline display serif with an italic dawn-2 accent; the primary channel shows its value in italic dawn-2; tiles on `{colors.surface.panel}`, hover `#15110D`. Privacy line in muted at 11.5px with a soft link. For winners, the panel repeats the visitor's `certificate-card` (first offered on the name card right after the name is entered).
- **archive-panel.** The project detail browser inside the office **archive cabinet**: a physical cabinet of labelled drawers/binders in the 3D office; picking one opens a square `{colors.surface.panel}` sheet with a title-serif project name, caps meta (time range, role, stack), and hairline-separated sections (sample PRD, API contract, tech stack, business flow, UI/UX, prototype). Document artifacts look like printed paper and binders lit by the desk lamp. The same content on the indexable project page uses the same panel styling.
- **award-card.** On the office **awards wall** (nav **Penghargaan / Awards**; Jun's own awards only, never the visitor's certificate): framed certificates hung on the wall (thin dark frames, slight paper warmth, picture-light glow). Opening one shows a square panel with the certificate image, a serif title and caps issuer/date. [ASSUMPTION] Frame material and wall layout are open to art direction.
- **entry-screen.** Cinema-style pre-roll on `{colors.scene.eyelid}`: a display-serif title, two choice pairs (**Masuk dengan suara** / **Tanpa suara**, EN "Enter with sound" / "Without sound"; [Cinematic] / [Lite]) as caps options where the selected one carries a 1px ink pill outline, a **Motion: penuh / dikurangi** toggle in the same caps style, and Skip Story / Contact in caps. The sound choice also requests browser fullscreen. For an unfinished returning visitor, a third pair appears in the same style: "Lanjutkan dari [babak]" / "Mulai dari awal" (EN "Continue from [act]" / "Start over"). A returning visitor who finished never sees this screen (lands in the office hub). Renders with type and color only, before any heavy asset. [ASSUMPTION] Entry-screen visuals are not prototyped yet; this spec derives them from existing tokens.

### Set dressing

The scene is part of the design system.

- **Office.** Open-plan workspace, not a bedroom. Jun's desk: monitor (Slack/terminal), laptop with code, keyboard, mouse, phone, cold coffee mug, pen cup, notebooks, document tray, rubber duck, lamp, plant; nearby bookshelf with binders, archive boxes, whiteboard architecture diagram, 守 poster, corkboard with sticky notes, wall clock, calendar, certificate, router LED. Sticky notes and prints use muted paper tones (`#D8D0C0`, `#B9A774`, `#8FA39A`, `#C78F7A`) with a dark red pin `#8A2E28`. **Kia's pink sticky note** ("jangan lupa makan :) — K") on Jun's monitor is a hero prop: it gets the close-up at the turning point, when the red alarm light dims while Jun looks at it. Jun's phone on the desk lights up with Kia's message at dawn.
- **Colleague desks.** UI/UX designer Irfan (male), PM Fath (male), QA Sarah (female), Marketing Rina (female), and Kia (female, Data & Support [ASSUMPTION]) at the desk beside Jun's, shown respectfully and mostly through objects. Empty at night but full of personal items that reveal each role; at dawn one or two colleagues arrive and the office warms up. [ASSUMPTION] Example props: UI/UX — pen tablet, color swatch fan, wireframe printouts; PM — roadmap printout, kanban sticky wall, headset; QA — device test rack, bug-tally sheet; Marketing — campaign calendar, brand samples, camera.
- **Living city.** Layered skyline (near, mid, far) with lit windows that flicker and change, light-pollution haze, moving traffic light streams, trains, signage, rooftop beacons and blinking aircraft lights. Busy, never dead.
- **Mt. Fuji.** Natural profile: concave slopes, snow gullies, atmospheric haze; reads blue-grey at night, warm rim at dawn with the sun behind it.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Treat every scroll position as a graded, photoreal film frame | Ship anything that looks like flat CSS shapes or a template |
| Tell the story through scene, light, sound and diegetic text | Put narration subtitles on screen by default, or show a scrollbar / progress indicator |
| Take color from the scene (time, weather, light) | Introduce a brand color or decorative accent |
| Put all film text on a scrim, ≥ 4.5:1 against the worst frame | Place text directly on sky, city or lightning |
| Use `signal.error` / `alarm-red` as light and fill only | Set text in `#C8392E` |
| Keep chrome inside the letterbox bars | Float nav or buttons over the picture (except in-scene game/HUD) |
| Serif for the film, grotesk for chrome, mono for machines | Bold weights, all-caps serif, mono in site chrome |
| Label acts only in the chrome chapter nav | Put act title cards (kanji or Latin) inside the picture |
| Spend one ufotable-style camera moment per act | Dutch angles and push-ins as a constant style |
| Soft, wide bloom; warm-white ink | Neon edges, glassmorphism blur panels, pure `#FFFFFF` text |
| Overcast rain sky with no stars or moon | Stars or moon visible through rain |
| Pills only for CTAs and the mute control | Rounded cards, rounded scrims |
| Give Lite the same compositions as 2.5D plates | Treat Lite as a different, plainer design |

### Open Questions

- Final licensed serif (with true italic) replacing Georgia. [ASSUMPTION]
- Mincho face for the chapter-nav kanji: system stack vs a subset web font (only 第一二三四五幕 are needed). The retired `kanji-vertical` token can be deleted once no references remain. [ASSUMPTION]
- Asset pipeline and rendering path for photoreal AAA realism (offline-rendered scroll-scrubbed sequences vs realtime, hub fidelity, Lite tier) and their download/decode budgets; owned by bmad-architecture, starting from `art-direction.md`. [ASSUMPTION]
- Live-review demo format (scripted capture vs realtime HTML layer) and frame size. [ASSUMPTION]
- iPhone Safari fit-to-screen layout (no element fullscreen) and whether to show an "Add to Home Screen" hint. [ASSUMPTION]
- CC toggle visual (caps "CC" label vs icon) and CC subtitle position relative to the HUD in Act III. [ASSUMPTION]
- Entry-screen, archive cabinet and awards wall visuals beyond the token-derived spec above are unprototyped. [ASSUMPTION]
- Mobile letterbox height (96px from motion study vs 120px from the static mock). [ASSUMPTION]
