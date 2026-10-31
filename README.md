# NetSpeak

Self-hosted intercom with clean program feeds. One container, one port (**443**), no database.

- **Rooms** with per-room push-to-talk or latch, live "who's talking", per-room volume
- **Synchronised program feed**: the server stamps every program packet with its clock, each device measures its offset from that clock, and everyone plays each packet at stamp + a fixed delay (250 ms by default), so all listeners hear the same sound at the same moment. Rooms are not delayed
- **Program feeds**: stereo Opus at 192 kbps with a compressor and limiter at the sending end, so levels stay even and never clip. Listeners just get a volume slider
- **Permissions**: users created by the admin, assigned straight to rooms and feeds with *listen / talk / send*. Changes apply instantly to connected clients
- **Phone friendly PWA**: installable, keeps playing with the screen off, reconnects on its own
- **Feedback protection**: an automatic suppressor finds howling tones on your mic and cuts just that frequency, so you can still hear everyone while you talk (and talk over each other). Earbuds remain the real cure for two devices in one room
- **Voice mic processing**: noise suppression with a gentle low-cut, a built-in software echo canceller that learns from what the device is playing, and automatic feedback suppression. The browser's own echo cancellation is off because it forces Android into phone-call audio mode (a separate call volume). Earbuds or a headset are still the best protection. No auto gain, no gate. Program feeds bypass all of it
- **Single port**: web app, API and audio all ride one connection (WebSocket). Nothing else to forward, works behind reverse proxies and tunnels

## Deploy

Needs a Linux machine with Docker. Save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  netspeak:
    image: ghcr.io/amurikurthy/netspeak:latest
    container_name: netspeak
    restart: unless-stopped
    ports:
      - "443:443"                     # HTTPS with a self-signed cert; your reverse proxy terminates the real one
    volumes:
      - ./data:/data                  # users, rooms, keys: back this folder up
    environment:
      NETSPEAK_ADMIN_PASSWORD: ""     # first start only. Empty = random, printed in the logs
```

```bash
docker compose up -d
docker compose logs netspeak    # first-start admin password
```

Open the site through your reverse proxy, sign in as `admin`, and change the password under Settings. The image is built for amd64 and arm64 (Raspberry Pi works) by GitHub Actions on every push to `main`.

**Update:** `docker compose pull && docker compose up -d` (your data in `./data` is kept).

### Reverse proxy

NetSpeak serves HTTPS on 443 with a self-signed certificate and expects your reverse proxy to present the real one. The proxy must **pass WebSockets** (audio uses `/ws`) and **keep the original Host header** (the WebSocket origin check compares it). Browsers need HTTPS for the microphone, so the proxy's certificate is what users see.

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

**Behind a login (Pangolin, Authelia, Cloudflare Access, basic auth).** The app is installable as long as the proxy lets three things through: `/manifest.webmanifest`, `/sw.js` and `/icons/`. The page asks the browser to send your login cookie with the manifest request (`crossorigin="use-credentials"`), which is enough for most setups. If installing still fails, add a rule that skips authentication for those paths (in Pangolin: a resource rule allowing them), then check Settings → Diagnostics → "Check why the app can't install".

To skip the self-signed hop, set `NETSPEAK_TLS: "off"` and the container speaks plain HTTP on 8080 (map `8080:8080` and proxy to `http://netspeak:8080`). Opening the container directly without a proxy also works: you get a browser warning once.

### Environment

| Variable | Default | |
|---|---|---|
| `NETSPEAK_TLS` | selfsigned | `selfsigned` (HTTPS on 443) or `off` (plain HTTP on 8080) |
| `NETSPEAK_PORT` | 443 (8080 if TLS off) | listen port |
| `NETSPEAK_ADMIN_PASSWORD` | random, logged | initial admin password |
| `NETSPEAK_FEED_DELAY_MS` | 250 | fixed delay every listener adds to program audio so all devices stay in sync. Must exceed your slowest listener's network delay (50 to 2000) |
| `NETSPEAK_TRUST_PROXY` | 1 | trust `X-Forwarded-For` from your proxy; set `0` if exposed directly |
| `NETSPEAK_DATA` | /data | state directory (one JSON file + certs). Back up this folder |

## Using it

**Admin → Users/Rooms/Feeds.** The admin creates a user account for each person and ticks which rooms and feeds they can listen to, talk in or send to (or sets a room to "Everyone"). Admins can access everything.

**Program audio.** Either open a feed on a device with a line-in/interface and choose *Send from this device* (echo cancel, noise suppression and AGC are off; a compressor and limiter even out the level, and a send-level slider sets how hot it goes out), or push from anything ffmpeg can read. The server relays Opus packets as-is and never re-encodes them, so any compressing happens at the sender; the ffmpeg line below does it with `-af`:

```bash
ffmpeg -re -i INPUT -af "acompressor=threshold=0.063:ratio=3:attack=10:release=250,alimiter=limit=0.8" -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 -f ogg - \
  | curl -sS -T - https://HOST/ingest/FEED_KEY
```

(The key is shown in Admin → Feeds → Ingest.) Use 20 ms frames. Opus is lossy, but at 192 kbps it is transparent for monitoring; it is not bit-exact PCM.

## Browser support and the screen-off caveat

Audio uses WebCodecs Opus: Chrome/Edge 94+, Firefox 130+, Safari 26+. Listening continues with the screen off because output goes through a media element with a Media Session. **Talking** with the screen off works on Android Chrome (installed PWA); iOS suspends microphone capture when the app is backgrounded, which no web app can override, so on iPhones keep the screen on (Settings → Keep screen on).

## Security notes

Passwords are bcrypt-hashed, sessions are signed HttpOnly cookies, logins are rate limited, WebSocket origin is checked, and every audio frame is checked against the sender's current permissions on the server. Audio is encrypted in transit by TLS but not end-to-end: the server can hear rooms. The ingest key grants publish rights to its feed: treat it like a password.

## Develop

```bash
go run .    # set NETSPEAK_DATA=./data NETSPEAK_PORT=8443
```
No build step for the frontend (plain ES modules in `web/`), embedded into the binary.
