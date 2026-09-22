# Why it looked empty, and what was done about it

The complaint was "the 3D world looks kinda empty somehow, and I don't know why". This is the
answer, and the record of the fix, because most of what was wrong was not obvious and two of the
diagnoses were confidently wrong before they were right.

## The measurement that started it

Over the snow in front of the rider, the standard deviation of the luminance was **4.5 out of
255**. The entire near field of every screenshot sat inside two histogram buckets. Nothing was
blown out -- the maximum was 234 and not one pixel clipped -- it was just flat. "Empty" turned out
to be something you can put a number on, and everything below was aimed at that number.

## The six things that were actually wrong

1. **One surface at one scale.** A single corduroy texture was multiplied over every square metre
   of every map: the piste, the gully walls, the summit headwall, the cornice, the rock chute and
   the village apron. When every surface on a mountain is the same surface there is nothing for
   the eye to measure any of it against.
2. **The mountain had no bones.** Rock only appeared past 58 degrees, which on these maps is
   nowhere. The summit and the headwall were smooth white domes and Ridge Line's cliff band was a
   white step.
3. **There was no distance.** Outside the map was a cylinder strip of flat-shaded peaks 1.2 km
   away and a 2.6 km untextured disc under it to cover the gap -- whose circular rim you could see
   from anywhere high on the hill. Between the edge of the playable ground and that ring there was
   nothing at all.
4. **The forest was a field of white cones.** 81 per cent of a conifer's surface faces sideways
   and only 8.6 per cent faces up, and on the fir every one of those side faces is painted the
   modeller's neutral 0.8 grey. A stand of them sat at the same value as the snow behind it, so
   the frame had no dark in it anywhere.
5. **Nothing was happening.** The lift chairs went round and a few flakes fell. That was the whole
   inventory of motion on a mountain.
6. **No colour script.** Five of the six runs shipped the default 0.35 time of day, 0.35 fog and
   0.20 snowfall straight out of `createMap`. Every map was the same mid-morning white.

## The fix, in the order it landed

Each of these is one commit on `alive-mountain`, and each commit message explains the reasoning in
more detail than this list does.

| | What |
|---|---|
| A review harness | `shredShots()` renders fixed viewpoints derived from the map and posts them to `npm run shots`. The same frame before and after, at one canvas size. |
| An hour per run | A `WEATHER` table in the generator. Times chosen for the sun's AZIMUTH as much as its height -- near 0.5 it aims down the fall line, which lights every face equally and is why noon looks flat. |
| The forest | Foliage graded to a dark blue-green on the way in; per-instance tint widened to 0.72-1.12 off two hashes; a conifer-only material that puts needles back under the modeller's snow on every face that is not sky-facing; snow caps on up-facing prop surfaces. |
| Tonal range | Curvature shading 0.26 to 0.38, exposure to 0.88, hemisphere fill roughly halved, and a tiling anisotropic snow normal map at a world scale that survives mipmapping. |
| The snow-state mask | `pisteMask()` derives where a groomer has been from the shape of the hill; `crustAt()` derives wind scour. Corduroy, micro-relief, roughness and curvature shading all read it. |
| Rock and the horizon | Rock from 36 to 49 degrees, noise-broken and aspect-biased. The peak ring and valley disc replaced by a real heightfield with its own baked sun and cast shadow. |
| Shadows | Tree shadows and a broad per-stand dimming marched into the terrain's vertex colours, and the LOD distances pushed out so the tiles stop deleting them. |
| One wind | A single gust signal driving spindrift particles, tree sway and the wind audio together. |

## Four things that were only obvious afterwards

- **A per-vertex effect is only as good as the LOD lets it be.** Every viewpoint measured
  *identical* with the tree shadows on and off. The distances were tuned against the silhouette,
  where a tile 200 m out genuinely does not need its shape -- but everything that makes the ground
  readable now lives in the vertex colours, and decimating a tile does not soften those, it
  deletes them. At stride 8 on a 3 m grid there is one sample every 24 m.
- **Aerial perspective belongs on the light, not on the paint.** The far range had its haze mixed
  into its vertex colours and was then lit, so the renderer multiplied the haze by the lighting: a
  ridge in shadow got dark haze, a ridge in sun got bright haze, and the distance cue cancelled
  itself out.
- **A clamped Lambert term has nothing to say about a backlit range.** Every face you can see on
  one is, strictly, in shade, so `max(0, N·L)` takes all of them to zero and the whole massif comes
  out as one flat silhouette. Wrapping the term keeps the gradation.
- **A review shot that lies is worse than no review shot.** Two hours went into hunting a terrain
  bug that was in the harness: the wide view sat 95 m up aimed 300 m ahead, which is a 35 degree
  downward pitch, which on a 75 degree lens puts the horizon two degrees from the top edge. The
  new far range was being cropped to the bottoms of its own slopes.

## The budget

Everything above is instanced, a single draw call, or baked into vertex colours. Measured at the
Real preset and the shipping draw distance, over nine viewpoints on each of seven maps:

| | draw calls | triangles |
|---|---|---|
| before | 98 | 204,350 |
| after | 98 | 218,302 |

The far range costs one draw call and gave one back by replacing two meshes with one. The extra
triangles are the LOD distances, bought deliberately.

## Not done

Deliberately left, in the order they are probably worth doing:

- **Instanced NPC skiers and riders**, on the piste and on the chairs. The strongest "alive" signal
  there is, and it gives scale in every vista.
- **A denser village**: clustered buildings, trodden paths in the mask, warm windows after dusk, a
  lift base station, a parked groomer.
- **A rider track ribbon**, so your own line stays on the snow behind you.
- **Wind ripples and sastrugi in the heightfield itself**, gated by the wind-crust state, so
  off-piste snow has shape and not only shading.
- **A cloud layer below summit height** on the high maps.
