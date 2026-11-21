# Turbo Brawl

Online multiplayer arcade combat racer. Up to 8 cars per room (friends + CPU drivers),
power-up boxes (Turbo, Rocket, Oil Slick, Shield), 3 tracks, lobby chat, and touch controls for phones.

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
Arrows / WASD to drive, Space to use item, Enter to chat, M to mute.

## Code layout
- `server.js` - static file server + WebSocket rooms, CPU drivers, items, results
- `public/shared.js` - tracks and car physics (shared by server and browser)
- `public/game.js` - rendering, input, networking, sound
