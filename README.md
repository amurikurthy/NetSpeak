# netspeak

Self-hosted intercom with clean program feeds. One container, one port (**443**), no database.

- **Rooms** with per-room push-to-talk or latch, live "who's talking", per-room volume
- **Program feeds**: unprocessed stereo Opus (up to 256 kbps), separate volume, auto-dims while people talk
- **Permissions**: users, groups, guest invite links; per room/feed *listen / talk / send* for everyone, groups or single users. Changes apply instantly to connected clients
- **Phone friendly PWA**: installable, keeps playing with the screen off, reconnects on its own
- **Noise handling** for phones: echo cancel + noise suppression + auto gain + low-cut + noise gate. Feeds bypass all of it
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
      NETSPEAK_TRUST_PROXY: "1"       # use X-Forwarded-For from your proxy
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt: ["no-new-privileges:true"]
```

```bash
docker compose up -d
docker compose logs netspeak    # first-start admin password
```

Open the site through your reverse proxy, sign in as `admin`, and change the password under Settings. The image is built for amd64 and arm64 (Raspberry Pi works) by GitHub Actions on every push to `main`.

**Update:** `docker compose pull && docker compose up -d` (your data in `./data` is kept).

### Reverse proxy

netspeak serves HTTPS on 443 with a self-signed certificate and expects your reverse proxy to present the real one. The proxy must **pass WebSockets** (audio uses `/ws`) and **keep the original Host header** (the WebSocket origin check compares it). Browsers need HTTPS for the microphone, so the proxy's certificate is what users see.

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

To skip the self-signed hop, set `NETSPEAK_TLS: "off"` and the container speaks plain HTTP on 8080 (map `8080:8080` and proxy to `http://netspeak:8080`). Opening the container directly without a proxy also works: you get a browser warning once.

### Environment

| Variable | Default | |
|---|---|---|
| `NETSPEAK_TLS` | selfsigned | `selfsigned` (HTTPS on 443) or `off` (plain HTTP on 8080) |
| `NETSPEAK_PORT` | 443 (8080 if TLS off) | listen port |
| `NETSPEAK_ADMIN_PASSWORD` | random, logged | initial admin password |
| `NETSPEAK_TRUST_PROXY` | | `1` to trust `X-Forwarded-For` (set in the compose file) |
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
