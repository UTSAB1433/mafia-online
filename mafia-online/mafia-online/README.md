# Mafia Online

Play Mafia with friends in the browser. Share a room link, everyone picks a name and a voice, and the **server acts as the moderator**. No player has to run the game.

- Roles are dealt in secret. Each player is only ever sent what their role is allowed to know.
- **Night:** only the Mafia can talk, by voice or chat. Everyone else is asleep and muted.
- **Day:** everyone alive can use their mic or type. Typed chat is **read aloud in a male, female or neutral voice** (chosen when joining), so text-only players are never ignored.
- **Ping** is shown under every player's name. **Nobody is ever kicked for lag.** A slow or dropped player keeps their seat, everyone sees a "high ping" or "reconnecting" note, the game waits a little longer for them, and they rejoin by reopening the link in the same browser.
- Roles: Villager, Mafia, Godfather, Detective, Doctor, Bodyguard, Vigilante, Jester, Serial Killer.
- 5 to 15 players per room.

## Run it

Needs Node 18 or newer. There are no dependencies to install.

```bash
npm start
# open http://localhost:3000
```

## Put it online for your friends

The microphone only works on **HTTPS** (or localhost), so deploy it somewhere that gives you an HTTPS address.

- **Render / Railway / Fly.io:** create a Node web service from this folder. Start command: `node server.js`. They provide HTTPS automatically. (A `Dockerfile` is included if your host prefers it.)
- **Quick test from your own computer:** run `npm start`, then expose it with a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000` and send the `https://` link to friends.

Open the site, enter a name, pick a voice, press **Create a room**, then send the invite link. Friends open it, choose a name, and join.

The server keeps rooms in memory, so restarting it ends running games. Run a single instance.

## Voice chat notes

Voice goes directly between players' browsers (WebRTC), so it costs your server almost nothing. Audio-only mesh works well up to about 10 to 12 players.

Some networks (strict corporate or mobile networks) block direct connections. If a friend can't hear anyone, add a TURN relay:

```
TURN_URL=turn:your.turn.host:3478   TURN_USER=name   TURN_PASS=secret   node server.js
```

Several URLs can be given, separated by commas.

## Settings

The host can change these in the lobby: which optional roles are in, whether dead players' roles are shown, Doctor self-protect, tie rule (no elimination, revote, random), and night, discussion and voting lengths.

Other environment variables: `PORT` (default 3000), `MIN_PLAYERS` (default 5).

## How ping and lag are handled

Each browser measures its round-trip time to the server every 2 seconds and reports it. Ping over 250 ms is flagged as high and announced in chat. If a player is slow or reconnecting when a night or vote timer ends, the server waits an extra 15 seconds once. Actions are retried by the browser, so a laggy tap still counts. The only time a seat is released is in the lobby, if someone has been gone for a full minute, so the host can start without them.

## Tests

```bash
npm test
```

Bots play 8 full games against the real server with every role turned on. The test checks that hidden roles never leak, that Mafia chat and voice stay private at night, that high-ping and disconnected players keep their seat and role, and that voice signaling is relayed.

## Files

- `server.js` the whole backend and game moderator (one file, no dependencies)
- `public/index.html` the whole game client
- `test.js` automated bot test
