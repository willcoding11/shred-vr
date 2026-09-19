# Research brief: hands-as-feet VR snowboarding (Slowp) + snowboard physics for a Three.js/WebXR model

## 1. Topic 1 — Slowp (the game the user means)

**Identity.** *Slowp* by **Cruel Byte** ("Bunny Joker"), Meta Quest 2/Pro/3/3S, App Lab → Horizon Store, $9.99, Early Access since 18 Apr 2023, v0.99.144. Gear: snowboard, ski, snow skate. 50+ official / 1200+ community maps, multiplayer, replay mode. Comfort *Moderate*; Standing / Sitting / Roomscale; controllers only. Dev site cruelbyte.com/slowp (control tutorials are on their Discord, not public).

**Developer's own words on control (all that is public):**
- Store: "**Full control using your hands as feet**" … "As real-life snowboarders, we believe carving the snow in VR should be the best feeling in the world, so we tuned the physics until it felt perfect." … "Realistic Snowboard, Ski and Snow Skate physics" … "Grab tricks included!" … "Optional virtual goggles to eliminate motion sickness."
- Early-build text (ClubHouseVR mirror): "You only have to **position your hands to the side pointing the board forward** and start making turns. Keep in mind that **the board won't follow the terrain by itself, that's your job to point it forward and tilt it to carve correctly**." … "If you are prone to motion sickness, maybe you shouldn't play." … "Just press any Button to restart."
- Press blurb: "To control your character, you use your hands, as the controllers do not track well at your feet."
- FAQ settings: "**hand tilt angle**, input mapping and more"; also HUD, drone/replay, pass-through (MR), goggles (a goggle-frame vignette), viewing filters.
- Player evidence: jump is hand-driven ("Trying to jump to a tall ledge feels like my hands are too heavy"); flips/corks are done with body/hand motion (community video "How to flip in SlowpVR"); no in-game tutorial for skis.

**Mapping implied by the above (inference, labelled as such):** hands hang at your sides ≈ over the two bindings; the **line between the two controllers = board long axis** (yaw); the **hands' common roll = edge/tilt angle** ("tilt it to carve"); **height difference = nose/tail pitch** ("point it forward" = keep the board plane parallel to the slope). Because the board plane is *not* auto-aligned to terrain, edge engagement is computed from the hand-defined board plane vs the local ground plane; a mis-tilted board catches or scrubs. "Hand tilt angle" is a calibration offset between resting wrist roll and zero edge angle. Jump = quick upward hand throw (as in Carve). Grabs via grip buttons.

## 2. Carve Snowboarding (Chuhai Labs / Giles Goddard) — the best-documented hands-as-feet scheme

- Goddard: "players control the board by standing (or sitting) similar to how they would with real snowboarding, i.e. with their side facing along the board and their arms either side of them to help with balance." "**It's basically their hands that are controlling the orientation of the board so when they rotate the board rotates with them.**" "**To jump you pull your hands upwards, the faster you do it the higher you'll jump.**" Leg sensors were tried and rejected: "extremely tiring and actually makes it very hard to control the board."
- Reviews: "Each hand basically controls one end of the board, so to steer left you point your front hand to the left and pull your back hand round to the right." "To steer forward keep your hands parallel to the hill; **to slow or stop, shift your hands so they are perpendicular**" (yaw across the fall line = skid/hockey stop). "**Full Tilt mode lets you tilt the board with your wrists**" (wrist roll → edge angle; off by default). Grabs: grip button; spins: hold triggers mid-air and swing arms. Comfort: optional snow-vignette at launch; seated mode (less control). Board origin is tied to the headset, so leaning forward moves the board — anchor the board to a calibrated floor point instead.
- Realistic Snowboarding (Quest): forces from "**edge angle, momentum, and snowboard direction**"; crash if "you catch an edge, land a flip too early, or mess up a landing"; a difficulty slider sets crash tolerance.

**Takeaways for a WebXR model:** board yaw = atan2 of (backHand→frontHand) projected on the ground; edge angle = mean controller roll about that axis (optionally gained ×1.5–2 so ±30° wrist = ±60° edge); nose/tail pressure = hand height difference and/or HMD lean fore/aft along the board axis; heel/toe weight = HMD lateral offset from the mid-hand point; jump = upward hand velocity above a threshold (~1.5 m/s), height ∝ velocity; skid/stop = deliberately yawing the board toward 90° to velocity. Calibrate a neutral pose at start; rate-limit deltas per frame to swallow tracking spikes.

## 3. Non-VR reference control schemes
- **Shredders** (Foampunch, sim): left stick steer/carve, right stick sharp carve = speed check, RT pop, LT to "right" the boarder before landing (miss it → wipeout), pre-wind arms for >360 spins. Devs: "You don't turn. You carve. You don't jump. You pop." Snow types change slip.
- **Unity snowboard threads:** shipped board/surf games use a "steerable vehicle" controller, not rigidbody friction: speed is a scalar along heading, heading is rotated by input, lateral velocity is removed/damped (`AddForce(-k * Project(v, right))`).
- **kds1111/50-50 traction design:** heading and velocity decoupled; landing > ~15° off-axis triggers a timed "landing slide" pulling velocity toward heading with light speed loss; powerslide = reduced grip + higher yaw rate; grip ramps back gradually.

## 4. Physics — what to implement

**4.1 Geometry.** Sidecut radius `Rsc = (L²/4 + d²)/(2d)` (L = effective edge length, d = sidecut depth). Snowboards: 6–10 m, most 8–9 m, all-mountain 7–9 m (e.g. L=1.2 m, d=22 mm → 8.2 m). Skis: SL 13 m, GS 30 m, DH 50 m.

**4.2 Carved turn.** Edge angle Ψ (board base to snow): `R = Rsc · cos Ψ` (Ψ=60° → R=Rsc/2; Ψ→0 → R=Rsc). Racers measured at 62–66° in turns; recreational carving ~30–60°; extreme carvers near 90°. Balance ("Ideal Carving Equation", Komissarov): with slope α, traverse angle β (0 = across, 90° = fall line), speed v:
`tan Φ = v²/(g R cos α) − tan α · cos β`
Φ is the inclination of effective gravity; a balanced rigid rider needs Ψ ≈ Φ (hip/knee angulation lets Ψ exceed Φ, which is what gives control). Normal load `Fn = m g cos α / cos Φ`, g-force `cos α / cos Φ` (limit ≈3 g ⇒ Φ ≈ 70°; board-bend limit ≈80°). Since R shrinks with Ψ while Φ grows with v, pure balanced carving is only possible for `v < Vsc = √(g Rsc cos α)` (8 m board → 8.9 m/s; 13 m ski → 11.3 m/s); above that riders must skid part of the turn. Pure carving is only sustainable on slopes below `tan αc ≈ 2.3 μ + 0.06` (μ=0.04 → 8.7°, μ=0.10 → 16.5°); steeper = hybrid turns.

**4.3 Edge grip limit / snow fracture.** Carving holds while `tan Φ < 2 Sc² L / (m g H cos α)`; race snow Sc≈0.52 N/mm², H≈0.21 N/mm³ ⇒ penetration < ~5 mm, Φ < ~81°. Softer snow fractures at lower shear ⇒ only low-Ψ carving before it skids. Game version: available lateral accel `a_lat,max = grip(snow) · (Fn/m) · f(Ψ)`; if required `v²/R` exceeds it, blend into skid.

**4.4 Skidded turn / speed check / hockey stop (snow-machining model).** For an edged board sliding with attack (slip) angle γ between velocity and board axis, the cutting force is `Fc = N · tan(Ψ − τ) ≈ N · tan Ψ` (τ = atan μ ≈ 2° for μ≤0.04; below Ψ≈τ the board just slides on Coulomb friction). Split it: braking `Fb = Fc · sin γ` (opposes velocity), turning `Ft = Fc · cos γ` (perpendicular). Orthogonal skid (γ=90°) gives effective `μ_eff = tan Ψ` → 1.0 at Ψ=45° (a hockey stop decelerates at ~1 g). Typical turn slip angles are 10–20°, giving μ_eff ≈ 0.18–0.36 at Ψ=45°. A flat board across the fall line (Ψ≈0) plows with far less force — and is the edge-catch condition (§4.7).

**4.5 Longitudinal friction and drag.** `dv/dt = g sin α · sin β − μ Fn/m − (Cd A ρ / 2m) v²` (Fn/m rises with g-force in turns, so turning costs speed even when carved). Measured base friction (Frontiers 2021 field study, 12 conditions): skis 0.023–0.139, snowboards 0.026–0.143; means 0.054 / 0.060. Well-waxed race gear ≤0.04. Speed dependence is small: about −0.012 per m/s below ~4 m/s, +0.001–0.007 per m/s on wet snow above 8 m/s. Air: ρ≈1.2 kg/m³, Cd·A ≈ 0.35 m² tuck, 0.5–0.6 upright. Terminal speeds (computed; m=75 kg, μ=0.05, CdA=0.55): 10° → 17 m/s, 20° → 26 m/s, 30° → 32 m/s; recreational cruising 8–15 m/s.

**4.6 Snow types (μ measured; grip modifier is a design choice).**
| Snow | μ | grip / notes |
|---|---|---|
| Groomed spring, dry | 0.026–0.037 | firm, high edge hold |
| Winter groomed warm/cold | 0.048–0.059 | baseline |
| New snow, dry | 0.060–0.073 | softer, fractures sooner (lower Ψ max), "slippery" feel |
| Very wet spring | 0.072–0.082 | sticky |
| Very wet new snow | 0.136–0.138 | sticky, slow |
| Ice | ~0.02–0.04 | very low μ; edge only holds with sharp edge/high Ψ; skids easily |

**4.7 Fore/aft weight.** Instruction sources: 60–80% front foot at initiation (engages the nose, starts the arc), ~50/50 mid-turn, 40/60 at exit; back-weighted → "front edge disengages and the tail washes out" (skid). Model: pressure offset `p ∈ [−1,1]` (nose/tail) from hand-height difference or head fore/aft lean; turn-initiation yaw rate `∝ (1 + k_p · p)`; tail grip `∝ (1 − k_w · max(0, −p))`; effective edge length (hence Rsc) shrinks when weight is far forward/back.

**4.8 Edge catch.** Occurs when the *downhill* edge is lower than the uphill edge while the board has lateral velocity (board tilt vs local slope normal has the wrong sign), or when landing flat/edge-first on a slope too shallow for the board angle. Below ~3 m/s the edge pivots (rider rotates around it); above, it releases and converts forward speed into airborne rotation (a "flying" catch). Implement: if `sign(edgeAngle) == sign(lateralVel)` and |lateralVel| > v_c and Ψ > deadzone → catch; severity ∝ speed.

**4.9 Air and landing.** Ballistic flight; pop from upward hand velocity (Carve/Slowp), e.g. `v_up = clamp(k · handVel, 0, 4 m/s)`. Landing impact = velocity component along the landing-surface normal; matching the landing slope to the trajectory (transition) keeps it low. Tolerances used in games: yaw off-axis < 15° = clean, up to ~45–60° = slide with speed loss, worse (or edge-first / under-rotated) = bail; Realistic Snowboarding exposes this as a difficulty slider.

**4.10 Recommended hybrid controller (arcade-sim).** Per fixed step: (1) rotate board yaw toward the hand-derived heading with a rate limit; (2) compute slip γ between velocity and board axis; (3) if `v²/R_carve ≤ a_lat,max` and |γ| < γ_carve (~5–8°): carve — bend the velocity direction along an arc of `R = Rsc cos Ψ`, remove lateral velocity fully; (4) else skid — apply `Fb, Ft` from §4.4 with γ, decay lateral velocity with time constant τ_grip (0.1–0.3 s) scaled by snow grip; (5) apply gravity component, μ·Fn friction, drag; (6) check edge-catch and landing rules.

## 5. Tunable parameters
| Parameter | Range | Default |
|---|---|---|
| Rsc | 6–10 m (board), 13–30 m (ski) | 8 m |
| Edge angle cap | 60–80° | 70° |
| μ base | 0.03–0.08 (0.14 wet) | 0.05 |
| Cd·A | 0.35–0.6 m² | 0.5 |
| Carve slip threshold γ_carve | 3–10° | 6° |
| Skid μ_eff | tan Ψ · sin γ (0.1–1.0) | — |
| Grip recovery τ | 0.1–0.4 s | 0.2 s |
| Max sustained g | 2–3 | 2.5 |
| Landing yaw tolerance | 15° clean / 45° slide | — |
| Edge-catch min speed | 2–4 m/s | 3 m/s |
| Hand-roll → edge gain | 1.0–2.0 | 1.5 |
| Jump hand-velocity threshold | 1–2 m/s | 1.5 m/s |

## Sources
- Slowp store: https://www.meta.com/experiences/slowp/5324326507687177/ · SideQuest: https://sidequestvr.com/app/1322/slowp · Dev FAQ: http://cruelbyte.com/slowp/ · Alt Lab page: https://www.altlabvr.com/slowp · Early dev text: https://www.clubhousevr.com/game/slowp/ · Press: https://questrequestvr.wordpress.com/2024/06/28/slowp-a-free-vr-snowboarding-skiing-game-on-metaquest-applab/ · Dev video: https://www.youtube.com/watch?v=yXANqP0Xico
- Carve: https://www.gamereactor.eu/giles-goddard-from-1080-to-carve-snowboarding-from-n64-to-oculus-quest/ · https://www.meta.com/blog/no-chairlift-necessary-carve-snowboarding-shreds-onto-the-quest-platform-today/ · https://www.uploadvr.com/carve-snowboarding-review/ · https://www.thevrgrid.com/carve-snowboarding/ · Realistic Snowboarding: https://www.meta.com/experiences/realistic-snowboarding/9926486507447219/
- Shredders: https://kotaku.com/shredders-xbox-series-x-s-pc-snowboarding-game-pass-foa-1848733449 · https://www.thegamer.com/shredders-beginner-tips/ · Unity threads: https://discussions.unity.com/t/carving-effect-challenge/462178 · https://discussions.unity.com/threads/simulating-snowboard-or-sledge-physics.988701/ · Traction design: https://github.com/kds1111/50-50/issues/18
- Komissarov, Modelling of carving turns (ICE, limits, critical slope): https://arxiv.org/abs/1812.02539 · Side-slipping / snow machining (hockey stop): https://doi.org/10.1007/s12283-021-00340-7 (OA: https://eprints.whiterose.ac.uk/id/eprint/169742/) · Carved turn: https://en.wikipedia.org/wiki/Carved_turn · Utah ski-physics FAQ (sidecut, drag eq.): https://www.math.utah.edu/~eyre/rsbfaq/physics.html · Snowboard physics (skid vs carve, lean angle): https://www.real-world-physics-problems.com/physics-of-snowboarding.html
- Friction field data: https://www.frontiersin.org/journals/mechanical-engineering/articles/10.3389/fmech.2021.728722/full · Sidecut values: https://www.snowboardingdays.com/snowboard-sidecut-radius-guide/ · Racer edge angles: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7739813/ · Edge catch: https://www.mechanicsofsport.com/snowboarding/catching_an_edge/edge_catch_mechanics.html · Fore/aft weight: https://www.ridingboards.com/should-you-lean-forward-or-back-snowboarding/ · https://ncstate.pressbooks.pub/skiingandsnowboarding/chapter/turning/
