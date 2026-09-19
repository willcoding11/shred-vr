# Shred VR

A WebXR snowboarding game where your two controllers **are** your two feet, plus a browser map
editor that streams edits to the headset while you work.

```
npm install
npm start            # editor + preview on http://localhost:8080, headset on https://<lan-ip>:8443
```

## This is a VR game

There is no desktop mode, deliberately. The entire control scheme is "the board is the rigid
thing between your two hands, anywhere in 3D", and there is no honest way to map that onto a
mouse. Open `/game/` on a desktop browser and you get a preview of the map you are editing —
drag to look, scroll to zoom — and a button to put the headset on.

## Play on the headset

1. Start the server, then open **Headset link** in the editor for the URL and a QR code.
2. On the Quest browser open `https://<pc-lan-ip>:8443/game/`, accept the self-signed
   certificate once, and tap **Enter VR**.
   No certificate warning wanted? Run `npm run adb-reverse` and open `http://localhost:8080/game/`
   on the headset instead.
3. Hold the controllers low, roughly where your feet would be. The first pose you hold is taken
   as "board flat" — no button to press.

## Your controllers are your feet

Not a metaphor. Where a controller is in your room is where that binding is, and the board is
the rigid body spanning between them. You can lift it, stand it on edge, swing the nose round or
press the tail down, anywhere in space. Nothing is interpreted into a "steer" value first.

A consequence worth knowing: the board ends up at hand height, so the snow surface does too, and
your head sits only about 0.8 m above it. You are very close to the board, and that closeness is
most of why this control scheme feels the way it does.

| What you do | What happens |
| --- | --- |
| Lay the board across the hill, dig the uphill edge in, shove it backwards under you | The edge will not slide, so you go forward. A skate start, same as a real board |
| Roll the board onto an edge | The sidecut cuts an arc and your path bends along it. More edge, tighter arc |
| Swing the board across your travel and lean into the hill | Hockey stop |
| Roll onto the **downhill** edge while sliding at speed | You catch it and go down, exactly as you would in real life |
| Drive the board down into the snow with your feet | It throws you up. An edged board throws you sideways too, because the push follows the board's own face |
| Lift the board | No contact, no grip. You fall until it meets the snow again |
| Press the nose in | It ploughs and scrubs speed. Sit back and the nose lifts clear |

Turning only ever happens because an edge is cutting. There is no steering assist, no auto-turn
and no yaw servo anywhere in the code, and **the world never rotates you**: your heading is your
body's heading in the room, so a big turn is something you physically make.

### How the physics actually works

The rider is a point mass. The board is a rigid plate held wherever your hands are. The only
thing joining them is the contact patch, and every force is computed from the velocity of *that*,
not of you:

    v_contact = v_rider + v_board_relative_to_rider

Your feet are on the board, so moving your feet drags the contact patch through the snow. That
single line is why there is no "skate start" feature and no "jump" function. Shove a gripping
edge and the snow shoves you back. Drive the board down and the snow, which will not move, sends
you up instead. Both are the same contact under different geometry, which is what the game was
always meant to be.

| Relation | Used for |
|---|---|
| `F = mu_lat * N`, `mu_lat ~ tan(psi)` | how much an edge at angle psi can hold |
| `R = Rsc * cos(psi)` | the arc a tilted board is bent into |
| `beta_sc = asin(L / 2R)` | the angle its tip presents to the snow, which starts the turn |
| `F_lat = -F_max * tanh(beta / beta_peak)` | force building with slip angle, then washing out |
| `N = m * sqrt((g cos a)^2 + a_lat^2)` | why a committed carve grips harder than a timid one |
| `mu = 0.03..0.08` | base friction by snow type, from 2021 field data |
| `F = 0.5 * rho * CdA * v^2` | air drag |

### Carving, and why your hands do the turning

Turning happens exactly one way. You swing the board; that opens a slip angle between where the
board points and where you are actually going; the edge grips that slip angle and drags your
velocity round to follow it. There is no steering input anywhere in the file. A flat board opens
the very same slip angle and has almost no grip to convert it, which is why it skids instead.

Hold the board still while tilted and it runs nearly straight, coming round about five degrees.
That is not the physics giving up. A real board carves *because it rotates through the arc*, and
if you refuse to rotate it, it does not carve.

The measurement that matters is what a turn **costs**, per degree of direction change, because
comparing raw speed kept is meaningless when one technique comes round 104 degrees and the other
manages 17. At 14 degrees of slope, swung at 0.9 rad/s for two seconds:

| | degrees round | speed lost per degree | sustained |
|---|---|---|---|
| Carving, 45° of edge | 104 | 0.012 m/s | 1.0 g |
| Skidding, flat base | 17 | 0.397 m/s | 0.1 g |

A carve is **33 times cheaper per degree** than a skid, and that gap is the whole skill. Swing
faster than an edge angle can hold and it washes out: at 2.5 rad/s a 60 degree edge rails round
137 degrees, while 20 degrees of edge manages 31 and costs seven times as much per degree.

Nothing ends a run. Trees stop you dead and you have to start again, which costs you far more than
a reset screen would.

### What this model will not do

It will not create energy. On flat ground, where there is no gravity to draw on, nothing you do
with your hands can raise your horizontal speed: a steady swing, a hard swing, rocking edge to
edge and outright flailing all peak at exactly 100% of the speed you started with. That assertion
is in the test suite because the model once failed it. Holding a steady swing pinned the slip
angle where the edge force has a forward component, with nothing charged for the snow that force
was cutting through, and waggling the board on the flat took you from 36 km/h to 41. The along-
travel part of an edge force is induced drag, never thrust.

Two earlier attempts at this section are worth recording, because both looked right and neither
was. Using the sidecut as a slip-angle offset gave a held edge 0.015 g and a 647 m radius while
the line above it computed 5.7 m. Replacing that with an explicit groove constraint - measure how
fast the board is swung, drive the path round at that rate, clip to the sidecut - was fifty lines
that changed a two-second carve by **one degree** while making it cost more speed. Both are gone.
The slip-angle curve was doing all the work the whole time.

**Slow motion** is held on either grip. It scales game time but not the run clock, and hand
velocity goes into the physics unscaled, so the same real hand movement produces the same push
either way. It buys you control, never a better result.

Buttons: trigger recalibrates · A/X back to the last gate, tapped twice restarts · either grip
holds slow motion · B/Y menu. Hand tracking maps the same four onto index, ring, pinky and
middle pinches.

### What Slowp actually does

Checked against the store page, the developer's own answers and player footage:

- **Confirmed.** Controller position is the binding position, hands held low at waist height so
  the snow ends up there, and turning comes only from carving — "the board won't follow the
  terrain by itself, that's your job to point it forward and tilt it to carve correctly."
- **Confirmed.** Ollies are physical, spins are physical and the view rotates with you.
- **Unconfirmed.** The push-off-the-edge start. There is a Restart binding, and the developer
  describes getting going as pointing the board forward and starting to turn. A physical
  jump-start and a community technique called boot slapping do both show up in player video, so
  the skate start here is kept — it is how a real board starts and it works.
- **Not built here.** Slowp can detach the controllers from the bindings (Hold Feet) so your
  hands become free hands for grabs, and it has a rewind.

## How the physics works

Every force is read off the board's real geometry against the snow, sampled at nine points along
its length and across its width — so a board rolled onto an edge touches on that edge, and a
board with its nose up is riding its tail.

- **Edge angle** is how far the deck is rolled away from the snow about the board's own axis.
  A held edge tries to bend your path onto the sidecut arc, radius = 8 m × cos(edge angle).
- Holding that arc costs `v²/r` of grip and an edge supplies at most `g·cos(slope)·tan(edge)`,
  so below roughly 32 km/h you carve the true sidecut radius and above it every turn opens out
  toward a drift. That limit is Komissarov's, not a fudge.
- Turning and holding sideslip share one friction circle, and the turn is allocated first.
  Damping-first looks reasonable and is wrong: gravity keeps feeding cross-board drift, the
  damper eats the budget, and then more edge angle produces *less* turn.
- Base friction is the measured 0.03–0.08 by snow type, drag is quadratic, and a rider leaves
  the ground when the terrain's curvature exceeds what gravity can bend the path around.

Measured terminal speeds land at 65 km/h on 10°, 99 on 20° and 123 on 30°, against literature
values of roughly 60 / 95 / 115. Background and sources are in `docs/research.md`.

## Editor

`http://localhost:8080/editor/` — sculpt with Raise / Lower / Smooth / Flatten / Reset / Roughen /
Kicker / Berm brushes (size, strength, edge falloff), place or scatter trees, rocks, gates,
fences, lamps, signs, a hut and snowmen, move the start gate and finish line, tweak time of day /
fog / snowfall / snow type, and create levels from presets. Everything autosaves and streams live
to any connected headset. Undo/redo, slope-colour overlay, a minimap with the rider's live
position, and a headset link with a QR code. Deleting a map moves it to `maps/.trash`.

Keys: `1–8` terrain tools · `Q/W/E/R` place / scatter / remove / select · `F/G` start / finish ·
`[ ]` brush size · `Ctrl+Z / Ctrl+Y` undo / redo · `Ctrl+S` save · `Delete` remove selected ·
`Home` frame map.

## Tools

```
npm run gen-maps                     # regenerate the three starter maps
npm run render-maps                  # top-down PNG + stats for each map into ./renders
node tools/physics-check.mjs         # 21 assertions: does the model do what the controls promise?
node tools/sim-test.js <map> follow  # a virtual player rides the map top to bottom
node tools/sim-test.js <map> gates   # ...aiming for the gates instead
node tools/sim-test.js <map> drop <z> <kmh> [secs] [x]   # probe one feature at one arrival speed
node tools/vr-panel-test.mjs         # the in-headset panels face the player
node tools/ws-test.mjs               # the live-sync relay, end to end
node tools/ws-stability.mjs 40       # a live client survives the server heartbeat
```

The virtual player in `sim-test.js` only does what a real one can: it puts the board somewhere
and holds it there. It has no steering function, because the game has none.

## Design notes

Things that were only obvious once they were wrong:

- **A carve has to rotate the velocity, not the board.** The board is wherever your hands are, so
  the only thing an edge can do is bend your path.
- **Riders only leave the ground if you compare curvature against gravity.** Projecting velocity
  onto the surface each step glues them down and every lip and cliff goes inert.
- **Gravity belongs in one place.** Applying it in full and then adding its in-plane component
  again nearly doubles every slope, and it hides as "the maps feel fast".
- **The board has width.** Sample only the centre line and a board standing on its edge floats.
- **The panels are children of the rig.** Their positions are rig-local but `lookAt` wants world
  space, and mixing the two points the HUD away from the player.
- For the maps: **the rideable floor has to be narrower than the feature it shapes.** A gully
  that swings 34 m inside a 31 m flat floor is a drawing, not terrain.

## Layout

```
server/index.js          express + websocket relay, map storage, self-signed https
public/shared/           map format + brushes, terrain mesh, props, scenery, live client
public/game/             controls.js (hands -> board pose), physics.js (pose -> forces), main.js
public/editor/           editor: viewport, tools, panels, live sync
tools/                   map generator, renderer, and the test harnesses above
```
