# Icon Store

Selbst gehosteter Icon-Speicher für Dashboards wie Homepage, Homarr oder Dashy:
Icon hochladen, stabile Direkt-URL kopieren, als `<img>` einbinden.

Neu und gehärtet aufgebaut auf Basis der Idee von
[mr-shadow00/Icon-Store](https://github.com/mr-shadow00/Icon-Store). Das URL-Schema
`/icons/<name>_<zufall>.<ext>` ist identisch, bestehende Dashboard-Links funktionieren weiter.

- Upload von PNG, SVG, JPG/JPEG, WEBP, ICO, GIF, auch mehrere Dateien per Drag & Drop
- Name und Tags vergeben, Suche über Name, Dateiname und Tags
- Bearbeiten, Löschen (mit Bestätigung), Link mit einem Klick kopieren
- Backup und Wiederherstellung aller Icons inkl. Metadaten als ZIP
- Oberfläche auf Deutsch und Englisch, hell/dunkel, mobil, per Tastatur bedienbar

---

## Installation unter ZimaOS / CasaOS

### 1. Admin-Key erzeugen

Im ZimaOS-Terminal (oder auf einem beliebigen Rechner):

```sh
openssl rand -hex 32
```

Das Ergebnis (64 Zeichen) ist Ihr Passwort für die Oberfläche. Gut aufbewahren, z. B. im Passwortmanager.

### 2. App installieren

1. ZimaOS → **App Store** → **Benutzerdefinierte App installieren** (oben rechts, „+“) → Reiter **Docker Compose**.
2. Den Inhalt von [`compose.yaml`](compose.yaml) einfügen.
3. In der Zeile `ADMIN_KEY: "BITTE_AENDERN_openssl_rand_hex_32"` den Platzhalter durch Ihren Key ersetzen.
4. Installieren.

Danach ist die App unter `http://<zimaos-ip>:3011` erreichbar. Melden Sie sich mit dem Key an.

> Solange der Platzhalter drinsteht oder der Key kürzer als 32 Zeichen ist, **startet die App absichtlich nicht**.
> Im Log steht dann, was fehlt (ZimaOS → App → Einstellungen/Logs bzw. `docker logs icon-store`).

Die Daten liegen in `/DATA/AppData/icon-store/data`. Das Image (`ghcr.io/pyzyi/icon-store:2`) wird für
amd64 und arm64 automatisch von GitHub Actions gebaut.

### Icon in ein Dashboard einbinden

Auf das Kopieren-Symbol einer Karte klicken. Der Link sieht so aus:

```
http://<zimaos-ip>:3011/icons/proxmox_k3j9x0abcd.png
```

Homepage (`services.yaml`): `icon: http://192.168.1.10:3011/icons/proxmox_k3j9x0abcd.png`

---

## Migration von der alten Version

Die alte App hat den kompletten Ordner `/DATA/AppData/icon-store` (Code **und** Daten) in den Container
gehängt. Die Daten liegen dort im Unterordner `data/`, und genau diesen Ordner nutzt die neue Version.
Sie müssen also nichts verschieben.

1. **Sicherung anlegen** (empfohlen):
   ```sh
   sudo cp -a /DATA/AppData/icon-store/data /DATA/AppData/icon-store-data-backup
   ```
2. Alte App in ZimaOS **stoppen und deinstallieren**. Falls ZimaOS fragt, ob die App-Daten gelöscht werden
   sollen: **Nein**.
3. Neue App wie oben beschrieben installieren (gleicher Port 3011, damit alle Links gleich bleiben).
4. Beim ersten Start passiert automatisch Folgendes:
   - Der Init-Container übergibt den Datenordner an den unprivilegierten App-User (UID 1000). Die alte App
     lief als root.
   - `metadata.json` wird ins neue Format (v2) überführt. Das Original bleibt als `metadata.v1.bak.json` liegen.
   - Eine Konsistenzprüfung meldet im Log verwaiste Dateien oder Einträge ohne Datei. Es wird dabei nichts gelöscht.
5. Optional aufräumen: Die alten Code-Dateien (`server.js`, `public/`, `node_modules/`, `package*.json`) in
   `/DATA/AppData/icon-store/` werden nicht mehr gebraucht.

Alle bisherigen URLs funktionieren unverändert, Dateinamen und IDs bleiben erhalten.

---

## Konfiguration

Alle Einstellungen laufen über Umgebungsvariablen und werden beim Start geprüft. Bei ungültigen Werten
startet die App nicht und nennt alle Fehler auf einmal. Vollständige Liste: [`.env.example`](.env.example).

| Variable                 | Standard                      | Bedeutung                                                        |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------- |
| `ADMIN_KEY`              | – (Pflicht)                   | Mindestens 32 Zeichen, `openssl rand -hex 32`                    |
| `PORT` / `HOST`          | `3000` / `0.0.0.0`            | Port und Adresse im Container                                    |
| `DATA_DIR`               | `./data` (Image: `/app/data`) | Datenordner                                                      |
| `MAX_UPLOAD_MB`          | `8`                           | Maximale Größe pro Datei                                         |
| `MAX_TOTAL_SIZE_MB`      | `1024`                        | Speichergrenze für alle Icons zusammen                           |
| `MAX_IMPORT_MB`          | `1024`                        | Maximale Größe eines Backup-ZIPs                                 |
| `TRUST_PROXY`            | `false`                       | Hinter Reverse Proxy: `1` (Anzahl Proxys)                        |
| `COOKIE_SECURE`          | `auto`                        | `Secure`-Cookie automatisch bei HTTPS                            |
| `ALLOWED_ORIGINS`        | –                             | Zusätzlich erlaubte Origins für Schreibzugriffe                  |
| `SESSION_TTL_HOURS`      | `12`                          | Sitzungsdauer ohne Aktivität                                     |
| `LOGIN_RATE_LIMIT`       | `5`                           | Login-Versuche pro Minute und IP                                 |
| `UPLOAD_RATE_LIMIT`      | `120`                         | Uploads pro 10 Minuten und IP                                    |
| `PUBLIC_BROWSE`          | `false`                       | Icon-Liste ohne Login ansehen (nur lesen)                        |
| `ALLOW_API_BEARER`       | `false`                       | `Authorization: Bearer <ADMIN_KEY>` für Skripte erlauben         |
| `REENCODE_RASTER`        | `true`                        | PNG/JPEG/WebP/GIF neu kodieren (entfernt Metadaten)              |
| `AUDIT_LOG_FILE`         | –                             | Audit-Log zusätzlich in Datei schreiben                          |
| `ALLOW_INSECURE_NO_AUTH` | `false`                       | **Nur für Tests:** schaltet die Anmeldung ab, mit Warnung im Log |

**Hinter einem Reverse Proxy mit HTTPS** (z. B. Nginx Proxy Manager): `TRUST_PROXY: "1"` setzen. Das
Session-Cookie bekommt dann automatisch das `Secure`-Flag.

---

## Backup und Wiederherstellung

In der Oberfläche unter **Backup**:

- **Backup herunterladen**: ZIP mit `metadata.json` und allen Dateien unter `icons/`.
- **Backup einspielen**: Jede Datei durchläuft dieselben Prüfungen wie ein normaler Upload. Vorhandene
  Icons werden übersprungen, nie überschrieben. Dateinamen und damit URLs bleiben erhalten.

Ein ZIP des alten `data/`-Ordners (mit `metadata.json` und `icons/`) lässt sich ebenfalls einspielen.

---

## Ohne Docker

Node.js ≥ 22.12 (empfohlen: 24 LTS):

```sh
npm ci --omit=dev
cp .env.example .env      # ADMIN_KEY eintragen
npm run start:env         # oder: ADMIN_KEY=... npm start
```

## Image selbst bauen

```sh
docker build -t icon-store:local .
```

In `compose.yaml` dann `image: icon-store:local` verwenden. Bei einem Netz mit TLS-Inspektion kann eine
eigene CA übergeben werden: `docker build --secret id=ca,src=/pfad/ca.pem …`

## Entwicklung

```sh
npm ci
npm test            # Tests (node:test + supertest)
npm run coverage    # Testabdeckung mit Schwellwerten (Zeilen ≥ 80 %)
npm run lint        # ESLint + Prettier, keine Warnungen erlaubt
npm run typecheck   # tsc --checkJs auf JSDoc-Typen
npm run bench       # Such-Benchmark mit 5.000 Icons
npm run check       # alles zusammen
```

Struktur:

```
src/server.js          Start, Signale, sauberes Herunterfahren
src/app.js             Express-App: Middleware-Reihenfolge, Security-Header
src/config.js          Umgebungsvariablen lesen und validieren
src/routes/            auth, icons, backup, files (/icons/*)
src/lib/storage.js     metadata.json: Mutex, atomares Schreiben, Migration
src/lib/svg.js         SVG-Bereinigung (DOMPurify + jsdom, XML-Parser)
src/lib/filetype.js    Magic-Byte-Prüfung
src/lib/raster.js      Neu-Kodierung mit sharp
src/lib/backup.js      ZIP-Export/-Import
public/                Oberfläche (Vanilla JS, kein Build-Schritt)
```

## API für Skripte

Mit `ALLOW_API_BEARER=true`:

```sh
curl -H "Authorization: Bearer $ADMIN_KEY" -F file=@proxmox.svg -F name=Proxmox -F tags=virtualization \
  http://zimaos:3011/api/icons
```

| Methode        | Pfad                          | Zweck                               |
| -------------- | ----------------------------- | ----------------------------------- |
| `GET`          | `/api/health`                 | Healthcheck (öffentlich)            |
| `POST`         | `/api/login` / `/api/logout`  | Sitzung (Cookie)                    |
| `GET`          | `/api/icons?q=`               | Liste/Suche                         |
| `POST`         | `/api/icons`                  | Upload (`file`, `name`, `tags`)     |
| `PATCH`        | `/api/icons/:id`              | `{ "name": "...", "tags": "a, b" }` |
| `DELETE`       | `/api/icons/:id`              | Löschen                             |
| `GET` / `POST` | `/api/export` / `/api/import` | Backup                              |
| `GET`          | `/icons/<datei>`              | Icon-Auslieferung (öffentlich)      |

---

## Sicherheitsmaßnahmen (Kurzfassung)

- **Kein Start ohne gültigen Key**: Fehlender, zu kurzer oder Platzhalter-Key bricht den Start ab.
- **Login per Formular** statt `?key=`: Session-Cookie `HttpOnly`, `SameSite=Strict`, bei HTTPS `Secure`.
  Key-Vergleich zeitkonstant (SHA-256 + `timingSafeEqual`), nichts im `localStorage`.
- **CSRF-Schutz**: `SameSite=Strict`, zusätzlich Prüfung des `Origin`-Headers bei allen schreibenden Anfragen.
- **Rate Limiting**: Login 5/min pro IP, Uploads 120/10 min pro IP.
- **SVG-Bereinigung**: XML-Parser, DOMPurify im SVG-Profil, entfernt Scripts, Event-Handler, `foreignObject`
  und externe Referenzen (`href`, `url()`, `@import`). DOCTYPE/ENTITY werden abgelehnt (XXE, Billion Laughs).
- **Strikte Header unter `/icons`**: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
img-src data:; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`.
- **Dateityp über Magic Bytes**: Endung und Inhalt müssen übereinstimmen. Der Content-Type kommt fest aus
  einer Allowlist. Rasterbilder werden neu kodiert (Metadaten und angehängte Daten entfernt), mit Pixel-Limit
  gegen Decompression Bombs.
- **Oberfläche mit helmet**: strikte CSP ohne Inline-Script, keine externen Schriften (System-Fonts).
- **Datenintegrität**: atomares Schreiben (temp + fsync + rename), Mutex für alle Änderungen. Bei kaputter
  `metadata.json` startet die App nicht, statt sie zu überschreiben.
- **Pfadsicherheit**: Auslieferung und Löschen nur über exakte Dateinamen aus den Metadaten, zusätzlich
  `path.basename` und eine Allowlist für Dateinamen.
- **Grenzen**: Upload-Größe, Gesamtspeicher, Name ≤ 100, max. 20 Tags à 32 Zeichen, JSON-Body ≤ 16 KB,
  max. 4 gleichzeitige Uploads.
- **Fehlerantworten ohne Stacktrace**, mit stabilen Fehlercodes.
- **Audit-Log** (JSON auf stdout) für Login, Logout, Upload, Änderung, Löschung, Export, Import. Der Key wird
  nie geloggt.
- **Container**: läuft als `node` (UID 1000), `read_only`, `cap_drop: ALL`, `no-new-privileges`, 256 MB/1 CPU,
  kein npm im Laufzeit-Image, Basis-Image per Digest gepinnt, Healthcheck, sauberes Herunterfahren bei SIGTERM.

Details und Nachweise: [QUALITY.md](QUALITY.md).

## Lizenz

MIT, siehe [LICENSE](LICENSE).
