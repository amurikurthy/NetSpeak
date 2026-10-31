# netspeak

Self-hosted intercom with clean program feeds. One container, one port (**443**), no database.

- **Rooms** with per-room push-to-talk or latch, live "who's talking", per-room volume
- **Program feeds**: unprocessed stereo Opus (up to 256 kbps), separate volume, auto-dims while people talk
- **Permissions**: users, groups, guest invite links; per room/feed *listen / talk / send* for everyone, groups or single users. Changes apply instantly to connected clients
- **Phone friendly PWA**: installable, keeps playing with the screen off, reconnects on its own
- **Noise handling** for phones: echo cancel + noise suppression + auto gain + low-cut + noise gate. Feeds bypass all of it
- **Single port**: web app, API and audio all ride one TLS connection (WebSocket). Nothing else to forward, works behind strict firewalls, reverse proxies and tunnels

## Deploy

Needs a Linux machine with Docker and port 443 reachable. Image: `ghcr.io/amurikurthy/netspeak:latest`, built by GitHub Actions on every push to `main` (amd64 + arm64, so Raspberry Pi works).

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/amurikurthy/NetSpeak/main/install.sh | sh
```

It creates `./netspeak`, pulls the image, starts it and prints the admin login. No configuration needed.

**Or by hand (pull the image):**

```bash
mkdir netspeak && cd netspeak
curl -fsSLO https://raw.githubusercontent.com/amurikurthy/NetSpeak/main/docker-compose.yml
docker compose up -d
docker compose logs netspeak    # first-start admin password
```

**Or build from source:**

```bash
git clone https://github.com/amurikurthy/NetSpeak && cd NetSpeak
docker compose up -d --build
```

**Update:** `docker compose pull && docker compose up -d` (your data in `./data` is kept).

**No compose:**

```bash
docker run -d --name netspeak --restart unless-stopped -p 443:443 -v netspeak:/data \
  ghcr.io/amurikurthy/netspeak:latest
```

Open `https://your-host`, sign in as `admin`, and change the password under Settings.

> First time only: GitHub publishes the image as private. In the repo, open Packages → netspeak → Package settings → Change visibility → Public so `docker pull` works without logging in.

### HTTPS (required for the microphone)

Zero configuration. On each connection netspeak looks at the hostname the browser used:

| You open | You get |
|---|---|
| `https://any-name-pointing-here.example.com` | a trusted Let's Encrypt certificate, fetched automatically on the first visit (a few seconds, validated over port 443 only, no port 80) |
| an IP address, `box.local`, `localhost` | a self-signed certificate (one browser warning; installing as an app may be limited) |
| behind Caddy/Traefik/nginx/Cloudflare Tunnel | set `NETSPEAK_TLS: "off"` (listens on 8080) and `NETSPEAK_TRUST_PROXY: "1"`; the proxy must pass WebSockets |

For a trusted certificate you only need a DNS record for any name pointing at the server's public IP and port 443 reachable from the internet. Setting `NETSPEAK_DOMAIN` is optional and locks the server to that one hostname. Certificate requests are rate-limited so scanners can't exhaust Let's Encrypt limits.

### Environment

| Variable | Default | |
|---|---|---|
| `NETSPEAK_DOMAIN` | | optional: only this hostname may get a certificate |
| `NETSPEAK_TLS` | auto | `auto` (Let's Encrypt + self-signed fallback), `selfsigned`, `off` |
| `NETSPEAK_PORT` | 443 (8080 if TLS off) | |
| `NETSPEAK_ADMIN_PASSWORD` | random, logged | initial admin password |
| `NETSPEAK_EMAIL` | | Let's Encrypt contact |
| `NETSPEAK_TRUST_PROXY` | | `1` to trust `X-Forwarded-For` for login rate limiting |
| `NETSPEAK_DATA` | /data | state directory (one JSON file + certs). Back up this folder |

## Using it

**Admin → Groups/Users/Rooms/Feeds/Invites.** Put people in groups, then grant groups access on each room or feed (Listen, Talk, Send). Guests get an invite link (`/join/…`), enter a name and land in the groups you chose; the link can expire or be limited in uses. Admins can access everything.

**Program audio.** Either open a feed on a device with a line-in/interface and choose *Send from this device* (echo cancel, noise suppression and AGC are forced off, stereo Opus 192 kbps by default), or push from anything ffmpeg can read. Packets are relayed as-is, never re-encoded:

```bash
ffmpeg -re -i INPUT -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 -f ogg - \
  | curl -sS -T - https://HOST/ingest/FEED_KEY
```

(The key is shown in Admin → Feeds → Ingest.) Use 20 ms frames. Opus is lossy even at 256 kbps; it is transparent for broadcast monitoring but is not bit-exact PCM.

## Browser support and the screen-off caveat

Audio uses WebCodecs Opus: Chrome/Edge 94+, Firefox 130+, Safari 26+. Listening continues with the screen off because output goes through a media element with a Media Session. **Talking** with the screen off works on Android Chrome (installed PWA); iOS suspends microphone capture when the app is backgrounded, which no web app can override, so on iPhones keep the screen on (Settings → Keep screen on).

## Security notes

Passwords are bcrypt-hashed, sessions are signed HttpOnly cookies, logins are rate limited, WebSocket origin is checked, and every audio frame is checked against the sender's current permissions on the server. Audio is encrypted in transit by TLS but not end-to-end: the server can hear rooms. The ingest key grants publish rights to its feed: treat it like a password.

## Develop

```bash
go run .    # set NETSPEAK_DATA=./data NETSPEAK_PORT=8443
```
No build step for the frontend (plain ES modules in `web/`), embedded into the binary.
