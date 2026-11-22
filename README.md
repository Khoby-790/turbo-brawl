# Turbo Brawl

Online multiplayer 3D combat racer. Up to 8 cars per room (friends + CPU drivers),
power-up boxes (Turbo, Rocket, Triple Rocket, Homing Missile, Mine, Oil Slick, Shockwave, Shield,
Mega Turbo - odds depend on race position, so trailing drivers get the big weapons), 6 tracks (Canyon Loop, Harbor Hairpins,
Desert Dash, Alpine Pass, Palm Beach, Downtown Dusk), lobby chat, and touch controls for phones.

- 3D chase camera (Three.js) with a physically based sky, golden-hour lighting, clouds and lens flare
- Post-processing: bloom, ambient occlusion (Ultra), colour grading, speed blur, SMAA/FXAA
- Detailed sports cars: clear-coat paint, glass, spoked wheels with brake discs, race numbers
- Normal-mapped asphalt, concrete and ground; swaying grass, varied trees, reflective harbour water
- Graphics setting (Low / Medium / High / Ultra) on the start screen; phones default to Low
- Tyre-model physics: grip limits, power oversteer, handbrake drifts, gears, walls and car-to-car impacts
- Six cars to choose from in the garage, each with its own handling: GT Coupe, Muscle, Rally Hatch,
  Trail Truck, Prototype and Dune Buggy (stat bars + a 3D showroom in the lobby)
- Stunt jumps: kicker ramps send you flying; spin in the air for 360s and land straight to earn turbo
- Shortcuts: narrow dirt cut-throughs behind "SHORTCUT" arches - shorter, but less grip and a jump of their own on some tracks
- Skid marks, tyre smoke, sparks, explosions, body roll
- Procedural audio: engine through the gears, tyre squeal, crashes, wind and crowd

## Run locally
    npm install
    npm start          # http://localhost:3000

## Play with friends
Create a race, click **Copy invite link**, send it. Friends open the link, type a name and join.
The host picks track / laps / CPU count and starts the race.

## Deploy (anything that runs Node + WebSockets)
- **Render**: New Web Service -> this repo -> Build `npm install`, Start `npm start`.
- **Railway / Fly.io**: same commands; the server reads `PORT` from the environment.

## Controls
Arrows / WASD to drive (left/right in the air to spin), Space for handbrake, E or Shift to use an item,
R to reset onto the track, C to switch camera,
Enter to chat, M to mute.

## Code layout
- `server.js` - static file server + WebSocket rooms, CPU drivers, items, results
- `public/shared.js` - tracks, car physics and CPU driving (shared by server and browser)
- `public/world.js` - 3D scene: terrain, road, walls, scenery, car models, particles, skid marks
- `public/cars.js` - the six car models
- `public/gfx.js` - quality presets, post-processing chain, sky, clouds, lens flare
- `public/audio.js` - procedural sound engine
- `public/game.js` - game loop, input, networking, camera, HUD
