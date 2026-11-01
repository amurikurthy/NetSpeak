# NetSpeak

A self-hosted intercom for crews, venues and events, with synchronised program audio. One small container, one port, no database, no accounts with anyone else: you run it, you own it.

People talk to each other in **rooms** from any phone or computer. Everyone can also listen to a **program feed** (the show audio, a mix, a stream) that plays in sync on every device. The admin decides, person by person, who can hear and talk where.

## Highlights

**Talking**
- Rooms with tap-to-latch or hold-to-talk. Tap the button once and you stay live until you tap again; hold it for push-to-talk. A room can be set to push-to-talk only
- Talking always goes to one room: starting in a second room moves you there
- See who is in every room you have access to, whether or not you have joined it, and who is actually speaking right now. Speakers jump to the front of the list and light up. Rooms you have no access to are not shown at all
- Join several rooms at once and hear them mixed, with a volume slider per room
- Headset or earbud button toggles your mic in the active room
- **Level meters** (with a white peak-hold line) on every room you have joined, on each program feed, and on the master listening volume. They show what you actually hear, after your volume sliders

**Program feeds**
- One-way stereo audio, Opus at 192 kbps, sent from a browser (line-in or audio interface) or pushed from ffmpeg, OBS or anything that can make an Ogg/Opus stream
- Compressor and limiter at the sending end keep the level even and stop peaks clipping
- **Synchronised playback.** The server stamps every program packet with its own clock, every device measures how far its clock is from the server's, and each device plays each packet a fixed time after its stamp (350 ms by default). Everyone hears the same sound at the same moment, and delay cannot build up. A device on a slow network gets a small extra cushion of its own, so its audio stays smooth. Once its network has been steady for a few seconds it hands that cushion back by playing a fraction of a percent faster, so it catches up with the other devices

**Made for phones**
- Installable web app (PWA). Keeps playing with the screen off
- A **floating window** (Picture-in-Picture, the `⧉ Float` button) shows who is talking while you use other apps. It lists the rooms you have joined, rooms with someone speaking first, with "+N more rooms" if they do not fit, a red "You are live" banner while your mic is open, and a listening-level meter. The app meters redraw on every screen refresh. The floating window draws its meter about 30 times a second, and slows itself to 10 on a phone that cannot keep up. A phone can only float video, so the status is drawn as a picture and updates only when something changes
- Keep screen on by default, plus a **Pocket lock** that blacks the screen out and ignores touches until you press and hold
- Recovers by itself when you come back to the app (if the audio never stopped, for example while the floating window was open, it changes nothing, so there is no glitch): reconnects, wakes the sound engine and restarts the mic. There is also a Reload button in Settings
- Plays on the phone's normal media volume, so there is one volume slider, not a separate "call" volume

**Clean microphone**
- Noise suppression with a gentle low-cut
- A **built-in echo canceller** that learns from what the device is playing and removes it from the mic, in software, so the phone never has to switch into call mode. It is kept light, and switches itself off if a device's audio thread starts to struggle, because smooth sound matters more than a little echo. While you are only listening, none of this runs at all, so listening costs the audio thread almost nothing
- An **automatic feedback suppressor** that finds a howling tone on the mic and cuts just that frequency. Nobody is muted, so you can hear others while you talk, and talk over each other
- Mic volume from 0 to 125%, and a level meter that goes green, yellow, orange and red
- Earbuds or a headset are still the best protection against feedback

**Access control**
- The admin creates a user for each person and ticks which rooms and feeds they can listen to, talk in, or send to. A room can also be open to everyone
- Changes apply instantly to people who are connected. Users can be disabled or kicked

**Simple to run**
- One Go binary in a tiny container (amd64 and arm64). State is one JSON file on a volume
- Web app, API and all audio travel over a single connection, so one port is all you forward

## Deploy

You need a machine with Docker. Save this as `docker-compose.yml` and start it:

```yaml
services:
  netspeak:
    image: ghcr.io/amurikurthy/netspeak:latest
    container_name: netspeak
    restart: unless-stopped
    ports:
      - "443:443"                     # HTTPS with a self-signed cert; your reverse proxy presents the real one
    volumes:
      - ./data:/data                  # users, rooms, keys: back this folder up
    environment:
      NETSPEAK_ADMIN_PASSWORD: ""     # first start only. Empty = random, printed in the logs
```

```bash
docker compose up -d
docker compose logs netspeak          # shows the first-start admin password
```

Open the site through your reverse proxy, sign in as `admin`, and change the password in Settings. A fresh install has three starter rooms and a Program feed, open to every user, so new accounts work immediately.

**Update:** `docker compose pull && docker compose up -d`. Your data in `./data` is kept.

The image is built for amd64 and arm64 (a Raspberry Pi works) by GitHub Actions on every push to `main`.

### Reverse proxy

NetSpeak serves HTTPS on 443 with a self-signed certificate and expects your reverse proxy to present the real one. Browsers only allow the microphone on trusted HTTPS, so the proxy's certificate is what people see. The proxy must **pass WebSockets** (audio uses `/ws`) and **keep the original Host header** (the WebSocket origin check compares it).

Caddy:

```
intercom.example.com {
    reverse_proxy https://netspeak:443 {
        transport http { tls_insecure_skip_verify }
    }
}
```

nginx:

```nginx
location / {
    proxy_pass https://netspeak:443;
    proxy_ssl_verify off;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 1h;
}
```

Traefik: add the service with `scheme: https` and a `serversTransport` with `insecureSkipVerify: true`.

To skip the self-signed hop, set `NETSPEAK_TLS: "off"`. The container then speaks plain HTTP on 8080: map `8080:8080` and proxy to `http://netspeak:8080`.

**Behind a login (Pangolin, Authelia, Cloudflare Access, basic auth).** The app can be installed as long as the proxy lets three things through: `/manifest.webmanifest`, `/sw.js` and `/icons/`. The page asks the browser to send your login cookie with the manifest request, which is enough for most setups. If installing still fails, add a rule that skips authentication for those paths (in Pangolin, a resource rule that allows them).

### Settings

All settings go in the `environment:` section of the compose file.

| Variable | Default | |
|---|---|---|
| `NETSPEAK_ADMIN_PASSWORD` | random, logged | initial admin password (first start only) |
| `NETSPEAK_FEED_DELAY_MS` | 350 | the fixed delay every listener adds to program audio so all devices stay in sync. It must be longer than your slowest listener's network delay (50 to 2000) |
| `NETSPEAK_TLS` | selfsigned | `selfsigned` (HTTPS on 443) or `off` (plain HTTP on 8080) |
| `NETSPEAK_PORT` | 443 (8080 if TLS is off) | listen port |
| `NETSPEAK_TRUST_PROXY` | 1 | trust `X-Forwarded-For` from your proxy. Set `0` if the container is exposed directly |
| `NETSPEAK_DATA` | /data | state directory: one JSON file plus certificates |

## Using it

**Admin.** Admins get an Admin button with three tabs.
- *Users*: create people, set their name and password, tick what they can reach (listen, talk; send for feeds), disable or kick them
- *Rooms*: name, colour and order; push-to-talk only; who can listen and talk. "Everyone" opens a room to all users
- *Feeds*: who can listen and who can send, plus each feed's ingest key and ready-made ffmpeg commands

**Talking.** Join a room with its switch. Tap the big button to latch your mic on, tap again to stop, or hold it for push-to-talk. Your microphone stays open while the app is open, which avoids the glitches phones make when a mic opens and closes, but nothing is sent until you talk.

**Listening.** On a first visit you join one room. After that the app remembers which rooms you switched on, and starts the program feed by itself. Each room and feed has its own volume.

**Sending program audio.** Either open a feed on a device with a line-in or audio interface and press *Send from this device* (echo cancellation, noise suppression and auto gain are all off; a compressor and limiter even out the level, and a send-level slider sets how hot it goes out), or push from anything that makes Ogg/Opus. The server relays the Opus packets untouched and never re-encodes them, so compression has to happen at the source. This ffmpeg line does it:

```bash
ffmpeg -re -i INPUT -af "acompressor=threshold=0.063:ratio=3:attack=10:release=250,alimiter=limit=0.8" \
  -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 -f ogg - \
  | curl -sS -T - https://HOST/ingest/FEED_KEY
```

The key is shown in Admin, Feeds, Ingest. Use 20 ms frames. Opus is lossy, but at 192 kbps it is transparent for monitoring. It is not bit-exact PCM.

**Settings** (in the app): microphone and speaker choice, keep screen on, Diagnostics, reload, sign out. People cannot change their own name or password: only an admin can, under Admin, Users. The signed-in name is shown under the app name in the top bar. Diagnostics shows the connection, the sound engine, the microphone, packets sent and received, the echo canceller, the feedback suppressor and the program-feed clock sync, which is the first place to look when something sounds wrong. For program audio, the "feed health" line shows how often the buffer ran dry and the longest gap between packets. If that gap is large, `docker compose logs netspeak` says where the stall is: either "no packets from the sender" (the sender or its connection) or "sending blocked" for a listener (that listener's network, or the reverse proxy in front).

## How it works

- **Transport.** Everything rides one WebSocket over HTTPS: control messages as JSON, audio as binary Opus packets. The server only relays. It never decodes or mixes audio, and checks every packet against the sender's current permissions
- **Codec.** The browser encodes and decodes Opus with WebCodecs. Voice is mono at 32 kbps, program audio is stereo at 192 kbps
- **Playback.** Room voices are queued right behind one another on the device's audio clock with a small cushion (80 ms). The program feed is scheduled from the server's stamps (see above): the device measures its clock offset with repeated ping/pong exchanges, smooths out noisy readings, and nudges playback by a few samples to track drift. A device whose network is slower than the delay plays late instead of skipping. Nothing is queued while the phone has suspended the sound engine, and Stop cancels whatever is already queued
- **Echo, noise and feedback.** While you are talking, the microphone passes through an AudioWorklet that runs a light 16 kHz frequency-domain echo canceller (using what the device is playing as the reference), a double-talk protection that stops it learning while you speak, and a feedback suppressor that places narrow notch filters on howling tones. If a device's audio thread starts to struggle, the echo canceller switches itself off, because smooth sound matters more than a little echo
- **State.** Users, rooms, feeds and access live in one JSON file in `/data`, written atomically. There is no database and no other service

## Browser support and phone notes

Audio uses WebCodecs Opus: Chrome and Edge 94+, Firefox 130+, Safari 26+.

- **Android (Chrome):** listening continues with the screen off. Talking often does too when the app is installed, but it varies by phone and battery settings, which is why Keep screen on and Pocket lock exist
- **iPhone:** iOS stops microphone capture when a web app goes to the background, and no web app can override that. Use the default Keep screen on and Pocket lock, and keep the app in front. Listening continues in the background
- **Install:** use the browser's own menu (Install app, or Add to Home Screen). Installing needs trusted HTTPS
- **Feedback:** if two devices are in one room, earbuds or a headset are the real fix

## Security

Passwords are bcrypt-hashed. Sessions are signed HttpOnly cookies, logins are rate limited, and the WebSocket origin is checked. Audio is encrypted in transit by TLS but not end to end: the server relays it and could listen. A feed's ingest key lets anyone who has it publish to that feed, so treat it like a password. Admins can rotate it.

## Development

```bash
NETSPEAK_DATA=./data NETSPEAK_PORT=8443 go run .
```

The frontend is plain ES modules in `web/`, embedded into the binary: there is no build step.

```bash
go test ./...                    # permissions, ordering, the server's stamp clock
node test/syncplay.test.mjs      # synchronised playout across devices with different networks, clocks and noisy readings
node test/feedback.test.js       # feedback suppressor, in a simulated howling loop
node test/aec.test.js            # echo canceller, with real synthesised speech (needs ffmpeg with flite; skips if missing)
```

CI runs all of these and publishes the image on every push to `main`.
