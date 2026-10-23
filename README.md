# Icon Store

**Ihr eigener Icon-Server fürs Heimnetz.** Icons hochladen, Link kopieren, im Dashboard einbinden.

Wer ein Dashboard wie [Homepage](https://gethomepage.dev), [Homarr](https://homarr.dev) oder
[Dashy](https://dashy.to) nutzt, braucht für jeden Dienst ein Icon, am besten unter einer festen URL. Icon Store
ist genau dafür gebaut: Sie laden ein Bild hoch und bekommen sofort einen dauerhaften Direktlink wie

```
http://192.168.1.10:3011/icons/proxmox_k3j9x0abcd.png
```

Den Link fügen Sie im Dashboard als Icon ein, fertig. Alles bleibt bei Ihnen, ohne Cloud und ohne Konto.

## Was die App kann

- 🖼️ **Upload** von PNG, SVG, JPG, WEBP, ICO und GIF, auch mehrere Dateien auf einmal per Drag & Drop
- 🔗 **Link kopieren** mit einem Klick. Der Link ändert sich nie, auch nicht beim Umbenennen.
- 🏷️ **Name und Tags** vergeben, **Suche** über Name, Dateiname und Tags
- ✏️ **Bearbeiten und Löschen**, Löschen nur mit Sicherheitsabfrage
- 💾 **Backup** aller Icons als ZIP herunterladen und wieder einspielen
- 🌗 Hell- und Dunkelmodus, Deutsch und Englisch, funktioniert auch auf dem Handy
- 🔒 Geschützt durch ein Passwort (den „Admin-Key“). Hochgeladene Dateien werden geprüft und bereinigt.

---

## Installation (ZimaOS / CasaOS)

Sie brauchen nur die Datei [`compose.yaml`](compose.yaml) aus diesem Repo und einen selbst erzeugten Key.

### Schritt 1: Admin-Key erzeugen

Der Admin-Key ist Ihr Passwort für die Oberfläche. Er muss mindestens 32 Zeichen lang und zufällig sein.

Öffnen Sie in ZimaOS das **Terminal** und geben Sie ein:

```sh
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo
```

Heraus kommt eine Zeile mit 64 Zeichen, zum Beispiel `9f2c4e…a71b`. **Kopieren und sicher aufbewahren**,
etwa im Passwortmanager.

<details>
<summary>Andere Wege, einen Key zu erzeugen</summary>

- Linux/macOS mit OpenSSL: `openssl rand -hex 32`
- Über Docker (lädt einmalig das kleine Alpine-Image, ca. 8 MB):
  `docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'"; echo`
- Windows PowerShell:
  `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { '{0:x2}' -f $_ })`

Bitte keinen selbst ausgedachten Satz verwenden. Ein zufälliger Key ist praktisch nicht zu erraten.

</details>

### Schritt 2: App installieren

1. ZimaOS → **App Store** → oben rechts **„+“ / Benutzerdefinierte App installieren**
2. Reiter **Docker Compose** wählen
3. Den kompletten Inhalt von [`compose.yaml`](compose.yaml) einfügen
4. Diese Zeile suchen:
   ```yaml
   ADMIN_KEY: 'BITTE_AENDERN_openssl_rand_hex_32'
   ```
   und den Platzhalter durch Ihren Key ersetzen. Die Anführungszeichen bleiben stehen:
   ```yaml
   ADMIN_KEY: '9f2c4e…a71b'
   ```
5. **Installieren**

> Solange der Platzhalter drinsteht, **startet die App absichtlich nicht**. So läuft sie nie
> versehentlich ohne Passwortschutz.

### Schritt 3: Loslegen

1. Im Browser `http://<IP-Ihres-Servers>:3011` öffnen
2. Mit dem Admin-Key anmelden
3. **Icons hochladen** → Datei wählen oder hineinziehen → Name/Tags vergeben → **Hochladen**
4. Der Link wird automatisch kopiert. Sonst auf das Kopieren-Symbol der Karte klicken.

### Icon im Dashboard verwenden

**Homepage** (`services.yaml`):

```yaml
- Proxmox:
    href: https://proxmox.local:8006
    icon: http://192.168.1.10:3011/icons/proxmox_k3j9x0abcd.png
```

**Homarr / Dashy / andere:** Den Link einfach ins Feld für die Icon- bzw. Bild-URL einfügen.

---

## Gut zu wissen

**Wo liegen meine Daten?**
In `/DATA/AppData/icon-store/data` auf Ihrem Server: `icons/` enthält die Bilder, `metadata.json` die Namen
und Tags.

**Wie mache ich ein Backup?**
In der App oben auf **Backup** → **Backup herunterladen**. Über denselben Dialog lässt sich das ZIP wieder
einspielen. Vorhandene Icons werden dabei nicht überschrieben.

**Wie bekomme ich Updates?**
Im ZimaOS-Terminal das neue Image laden:

```sh
docker pull ghcr.io/pyzyi/icon-store:2
```

Danach in ZimaOS die Einstellungen der App öffnen und **Speichern** klicken. Dabei wird der Container mit der
neuen Version neu erstellt. Ein reiner Neustart reicht nicht. Ihre Daten und Links bleiben erhalten.

**Ich habe den Key vergessen.**
Erzeugen Sie einen neuen Key (Schritt 1), tragen Sie ihn in den App-Einstellungen von ZimaOS bei `ADMIN_KEY`
ein und starten Sie die App neu. Ihre Icons bleiben erhalten.

**Die App startet nicht.**
In ZimaOS die Logs der App ansehen. Die App schreibt dort genau, was fehlt, z. B. wenn noch der Platzhalter
als Key eingetragen ist oder der Key zu kurz ist.

**Kann ich die App aus dem Internet erreichbar machen?**
Ja, aber nur über einen Reverse Proxy mit HTTPS (z. B. Nginx Proxy Manager). Setzen Sie dann in der
`compose.yaml` `TRUST_PROXY: '1'`. Ohne HTTPS bitte nur im Heimnetz verwenden.

**Ich nutze die alte Version von mr-shadow00/Icon-Store.**
Sie können direkt umsteigen, alle bestehenden Links funktionieren weiter:

1. Zur Sicherheit den Datenordner kopieren:
   `sudo cp -a /DATA/AppData/icon-store/data /DATA/AppData/icon-store-backup`
2. Die alte App deinstallieren. Wenn ZimaOS fragt, ob die Daten gelöscht werden sollen: **Nein**.
3. Diese Version wie oben installieren. Sie nutzt denselben Ordner und denselben Port (3011).

Beim ersten Start werden die alten Daten automatisch übernommen. Eine Sicherung der alten Metadaten bleibt als
`metadata.v1.bak.json` liegen.

---

## Einstellungen

Optional in der `compose.yaml` unter `environment:` anpassbar:

| Variable            | Standard | Bedeutung                                               |
| ------------------- | -------- | ------------------------------------------------------- |
| `ADMIN_KEY`         | –        | **Pflicht.** Ihr Passwort, mindestens 32 Zeichen        |
| `MAX_UPLOAD_MB`     | `8`      | Maximale Größe pro Datei                                |
| `MAX_TOTAL_SIZE_MB` | `1024`   | Speichergrenze für alle Icons zusammen                  |
| `TRUST_PROXY`       | `false`  | Hinter einem Reverse Proxy auf `1` setzen               |
| `PUBLIC_BROWSE`     | `false`  | `true` = Icon-Liste auch ohne Login ansehen (nur lesen) |

Den Port ändern Sie bei `published: '3011'`.

## Sicherheit in Kürze

- Ohne gültigen Key startet die App nicht. Der Login läuft über ein sicheres Session-Cookie, Login-Versuche
  sind begrenzt (5 pro Minute).
- Hochgeladene Dateien werden auf ihren echten Typ geprüft. SVGs werden von Skripten befreit, Bilder neu
  gespeichert, um versteckte Daten und Metadaten zu entfernen.
- Der Container läuft ohne Root-Rechte, mit schreibgeschütztem Dateisystem und begrenztem Speicher (256 MB).
- Alle Aktionen (Login, Upload, Änderung, Löschung) werden protokolliert, der Key selbst nie.

---

## Für Entwickler

Quellcode, Tests, Dockerfile und ausführliche Dokumentation liegen im Branch
[`source`](https://github.com/Pyzyi/icon-store/tree/source). Das Docker-Image
`ghcr.io/pyzyi/icon-store` (amd64 und arm64) wird von dort automatisch per GitHub Actions gebaut.

Inspiriert von [mr-shadow00/Icon-Store](https://github.com/mr-shadow00/Icon-Store). Lizenz: MIT.
