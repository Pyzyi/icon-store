# Icon Store

**Your own icon server for your home lab.** Upload icons, copy the link, use it in your dashboard.

If you run a dashboard like [Homepage](https://gethomepage.dev), [Homarr](https://homarr.dev) or
[Dashy](https://dashy.to), every service needs an icon — ideally at a URL that never changes. Icon Store does
exactly that: upload an image and you instantly get a permanent direct link such as

```
http://192.168.1.10:3011/icons/proxmox_k3j9x0abcd.png
```

Paste that link into your dashboard as the icon and you're done. Everything stays on your own server: no cloud,
no account.

## Features

- 🖼️ **Upload** PNG, SVG, JPG, WEBP, ICO and GIF — several files at once via drag & drop
- 🔗 **Copy the link** with one click. The link never changes, not even when you rename the icon.
- 🏷️ **Names and tags**, plus **search** by name, file name and tag
- ✏️ **Edit and delete** (deleting always asks for confirmation)
- 💾 **Backup**: download all icons as a ZIP and restore it later
- 🌗 Light and dark mode, English and German UI (picked from your browser language), works on mobile
- 🔒 Protected by a password (the "admin key"); uploaded files are checked and sanitised

---

## Installation (ZimaOS / CasaOS)

All you need is the [`compose.yaml`](compose.yaml) from this repo and a key you generate yourself.

### Step 1: Generate an admin key

The admin key is your password for the web interface. It must be random and at least 32 characters long.

Open the **Terminal** in ZimaOS and run:

```sh
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo
```

This prints one line of 64 characters, e.g. `9f2c4e…a71b`. **Copy it and keep it safe**, for example in your
password manager.

<details>
<summary>Other ways to generate a key</summary>

- Linux/macOS with OpenSSL: `openssl rand -hex 32` (OpenSSL is _not_ installed on ZimaOS)
- Via Docker (downloads the tiny Alpine image once, ~8 MB; the container is removed right after):
  `docker run --rm alpine sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'"; echo`
- Windows PowerShell:
  `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { '{0:x2}' -f $_ })`

Please don't make up a phrase yourself — a random key is practically impossible to guess.

</details>

### Step 2: Install the app

1. ZimaOS → **App Store** → **"+" / Install a customized app** (top right)
2. Choose the **Docker Compose** tab
3. Paste the entire content of [`compose.yaml`](compose.yaml)
4. Find this line:
   ```yaml
   ADMIN_KEY: 'CHANGE_ME_generate_a_random_key'
   ```
   and replace the placeholder with your key — keep the quotes:
   ```yaml
   ADMIN_KEY: '9f2c4e…a71b'
   ```
5. Click **Install**

> As long as the placeholder is still there, the app **deliberately refuses to start**. That way it can never
> run without password protection by accident.

### Step 3: Get started

1. Open `http://<your-server-ip>:3011` in your browser
2. Sign in with your admin key
3. **Upload icons** → choose or drop files → add name/tags → **Upload**
4. The link is copied automatically — or click the copy button on any card

### Using an icon in your dashboard

**Homepage** (`services.yaml`):

```yaml
- Proxmox:
    href: https://proxmox.local:8006
    icon: http://192.168.1.10:3011/icons/proxmox_k3j9x0abcd.png
```

**Homarr / Dashy / others:** paste the link into the icon or image URL field.

---

## FAQ

**Where is my data stored?**
In `/DATA/AppData/icon-store/data` on your server: `icons/` holds the images, `metadata.json` the names and
tags.

**How do I make a backup?**
In the app, click **Backup** → **Download backup**. The same dialog restores a backup ZIP; existing icons are
never overwritten.

**How do I update?**
Pull the new image in the ZimaOS terminal:

```sh
docker pull ghcr.io/pyzyi/icon-store:2
```

Then open the app's settings in ZimaOS and click **Save** so the container is recreated with the new version.
A plain restart is not enough. Your data and links are kept.

**I forgot my key.**
Generate a new one (step 1), enter it as `ADMIN_KEY` in the app settings in ZimaOS and restart the app. Your
icons are kept.

**The app doesn't start.**
Check the app's logs in ZimaOS. The app states exactly what is missing — for example if the placeholder is
still set as the key or the key is too short.

**Can I make it reachable from the internet?**
Yes, but only behind a reverse proxy with HTTPS (e.g. Nginx Proxy Manager). In that case set
`TRUST_PROXY: '1'` in `compose.yaml`. Without HTTPS, please use it on your home network only.

**I'm using the old version by mr-shadow00/Icon-Store.**
You can switch directly; all existing links keep working:

1. Back up the data folder first:
   `sudo cp -a /DATA/AppData/icon-store/data /DATA/AppData/icon-store-backup`
2. Uninstall the old app. If ZimaOS asks whether to delete the app data: **No**.
3. Install this version as described above. It uses the same folder and the same port (3011).

On first start your old data is migrated automatically; a copy of the old metadata is kept as
`metadata.v1.bak.json`.

---

## Settings

Optional, under `environment:` in `compose.yaml`:

| Variable            | Default | Meaning                                                    |
| ------------------- | ------- | ---------------------------------------------------------- |
| `ADMIN_KEY`         | –       | **Required.** Your password, at least 32 characters        |
| `MAX_UPLOAD_MB`     | `8`     | Maximum size per file                                      |
| `MAX_TOTAL_SIZE_MB` | `1024`  | Storage limit for all icons together                       |
| `TRUST_PROXY`       | `false` | Set to `1` when running behind a reverse proxy             |
| `PUBLIC_BROWSE`     | `false` | `true` = icon list can be viewed without login (read-only) |

To change the port, edit `published: '3011'`.

## Security in a nutshell

- The app won't start without a valid key. Login uses a secure session cookie; login attempts are limited
  (5 per minute).
- Uploaded files are checked for their real type; SVGs are stripped of scripts, raster images are re-saved to
  remove hidden data and metadata.
- The container runs without root privileges, with a read-only file system and limited memory (256 MB).
- All actions (login, upload, edit, delete) are logged — the key itself never is.

---

## For developers

Source code, tests, Dockerfile and detailed documentation live on the
[`source`](https://github.com/Pyzyi/icon-store/tree/source) branch. The Docker image
`ghcr.io/pyzyi/icon-store` (amd64 and arm64) is built from there automatically via GitHub Actions.

Inspired by [mr-shadow00/Icon-Store](https://github.com/mr-shadow00/Icon-Store). License: MIT.
