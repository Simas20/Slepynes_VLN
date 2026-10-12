# Slėpynės – hide and seek on foot in Vilnius

A small web app for a walking hide and seek game in Senamiestis (and optionally Naujamiestis), inspired by the Jet Lag style of play. One person hides, everyone else hunts them down by asking questions. Everything runs in the phone browser, nobody installs anything.

## What is in the box

```
server.js                Node server (game logic, rooms, timers, photo answers)
public/index.html        Page shell
public/app.js            Everything the players see
public/style.css         Look and feel
public/cards.js          All questions, cards, curses and rules (edit freely)
public/zones.js          Play area polygons (edit to move the borders)
vilnius-play-area.kml    Same borders, for Google My Maps if you want them there too
render.yaml              One-click config for Render hosting
```

## Try it on your laptop first

You need Node 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000 in two browser windows, create a game in one and join with the code in the other. Location works on localhost. On a real phone the site must be on HTTPS, which the hosting below gives you for free.

## Put it online (about 20 minutes, 1 to 2 EUR)

1. **Buy a domain.** The cheapest real option right now is a `.xyz` at Porkbun, around 1 USD for the first year (renewal is around 13 USD, so just let it expire if you only need one evening). Something like `slepynes.xyz` or `vilniusseek.xyz`.
2. **Put the code on GitHub.** Create a new repository, then use "Add file" and "Upload files" and drag in the whole folder (everything except `node_modules`).
3. **Deploy on Render.** Sign up at render.com, choose New, then Blueprint, and pick your repository. It reads `render.yaml` and creates a free web service in Frankfurt. After a minute or two the game is live on `https://slepynes.onrender.com` (or similar). That address already works on its own.
4. **Connect the domain.** In Render open the service, then Settings, then Custom Domains, and add your domain. Render shows the DNS records to create. Add exactly those in Porkbun under "DNS" for your domain. HTTPS is set up automatically once the records are found (usually minutes).

### Good to know about the free plan

- The free service sleeps after 15 minutes without traffic and takes about a minute to wake up. Open the site a few minutes before you meet.
- While people are playing it stays awake, because every phone sends its position every few seconds.
- Games live in memory. If Render restarts the service, running games are lost. For one evening this is very unlikely to matter, but do not leave a game open for days.

## How a round works

1. Everyone opens the site. One person taps "Create a game" and shares the 4-letter code (or the "Invite friends" link).
2. In the lobby, pick the hider (tap Hider next to their name). The host sets the hiding time (default 30 min), the hiding zone size (default 200 m) and whether Naujamiestis is in play.
3. Start. The hider walks off and taps "Lock zone here" at their spot. Seekers wait at Cathedral Square.
4. When hiding time ends, seekers pick questions. The hider's phone buzzes, the app suggests the right answer for radar, measuring and thermometer questions from GPS, and the hider answers.
5. Answering earns the hider cards. Time bonuses add minutes at the end, power ups (veto, randomize, relocate and more) help, curses slow the seekers down. Seekers see active curses on top of the screen and tick them off when done.
6. Answers are drawn on the seekers' map (circles for radar and measuring, a shaded half for thermometer), so the area shrinks as you go.
7. When a seeker walks into the hiding zone, everyone is told and the hider must freeze. Press "Found" when the hider is spotted. Total time is the seeking time plus time bonus cards still in hand. Swap roles and go again, the results table keeps every round.

The full rules are in the app menu.

## Changing things

- **Borders.** Edit the `[lat, lng]` lists in `public/zones.js`. Right-click a spot in Google Maps to copy its coordinates. The borders were traced by hand, so check them on the map before the game.
- **Questions and cards.** Everything is in `public/cards.js` as plain text. Add a question, change a curse, adjust how many cards the hider draws.
- **Start point.** `start` in `public/zones.js`.

## Safety

It is dark in the evening. Agree on a meeting point and a time limit, keep phones charged (bring a power bank, GPS drains batteries), stay on public streets and open courtyards, and nobody runs across roads.
