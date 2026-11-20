# Mimic Party

A multiplayer voice-mimic party game. A meme sound plays, everyone records their own voice copying it at the same time, and the game scores each attempt 0-100 by comparing it to the original. Best copy of the round gets +10 bonus.

## Run it

```bash
npm install
ADMIN_PASSWORD=choose-something npm start     # default password is "admin"
```

- Game: http://localhost:3000  (create a room, friends join with the 4-letter code)
- Admin: http://localhost:3000/admin.html  (add / delete sounds + their meme image)

First run creates 3 placeholder beeps so you can play immediately. Delete them in admin once you add real meme sounds.

## Playing from phones
Browsers only allow microphone access on **https** (or localhost). To test with friends:
- Deploy to any Node host (Render, Railway, Fly.io...), or
- Tunnel your laptop: `npx cloudflared tunnel --url http://localhost:3000` and share the https link.

Uploaded files live in `uploads/` and `data/sounds.json`, so use a persistent disk when deploying.

## How a round works
1. Server picks a random sound; everyone's browser downloads it (`round`, then `ready`).
2. `listen`: sound plays with the meme image. 3. `countdown` 3-2-1. 4. `record`: everyone records for sound length + 1.5 s.
5. Each browser scores its own recording against the original (`public/score.js`) and sends the 0-100 number.
6. Server shows results, bonus, leaderboard, next round.

## Scoring (public/score.js)
Both clips are trimmed of silence, converted to 12 MFCCs (normalised per speaker, so a different voice is not punished) plus a loudness contour, then compared with Dynamic Time Warping blended with a no-warp comparison (so rhythm still matters). Wrong length is penalised. `npm run test:score` runs a sanity check on synthetic voices.

**Tune it with real voices:** every round logs `[mimic] score {score, dist}` in the browser console. Adjust `D_GOOD` / `D_BAD` at the top of `score.js` until a decent copy lands ~75-90 and a random noise lands < 20.

## Known limits / next steps
- Scoring runs in each player's browser, so a determined player could cheat by editing the client. Fine for friends; for public rooms move scoring to the server.
- Not a "does it sound like the *same words*" check, it compares sound shape and rhythm, not speech recognition. Pitch contour matching would be a good addition.
- No reconnect: a player who refreshes leaves the room. Late joiners can't enter mid-game.
- Visuals are minimal. A 3D stage like the video would be a Three.js layer on top of the same server.
