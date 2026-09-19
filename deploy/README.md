# Deployment files

| File | Platform | What it is |
|---|---|---|
| `httpd-smart-cafeteria.conf` | Windows | Apache config, `C:\xampp\...` paths. |
| `httpd-smart-cafeteria-mac.conf` | macOS | Same config, `/Applications/XAMPP/xamppfiles/...` paths. |
| `htaccess-for-htdocs.txt` | Either | Fallback for when you cannot edit `httpd.conf`. Covers SPA routing and caching but not the proxy. Rename to `.htaccess`. |
| `start-smart-cafeteria.bat` / `.sh` | Windows / macOS+Linux | Starts the Node API and the Python DES engine, installing dependencies on first run. |
| `stop-smart-cafeteria.bat` / `.sh` | Windows / macOS+Linux | Stops those two. Leaves Apache and MySQL alone. |

On macOS: `chmod +x deploy/*.sh` once, then `./deploy/start-smart-cafeteria.sh` /
`./deploy/stop-smart-cafeteria.sh`. Logs go to `deploy/api.log` and
`deploy/des-engine.log` — `tail -f` either while it's running.

Setup instructions are at the top of `httpd-smart-cafeteria.conf` and in the
root `README.md`.

## Why the proxy approach is better

With `httpd-smart-cafeteria.conf`, the browser sees a single origin for the
page, the API and the WebSocket. That means no CORS, no mixed-content problem
if the college ever puts a certificate on Apache, and one URL to hand to the
module tutor. It also works from a phone on the same network without editing
any URLs, because the app calls `/api` relative to whatever host loaded it.

The `.htaccess` route requires the frontend to be built with an absolute
`VITE_API_BASE` pointing at port 4000, which breaks the moment someone opens it
on a phone — where "localhost" is the phone.

## Why `stop-smart-cafeteria.bat` targets window titles

Because `taskkill /IM node.exe` would also kill VS Code's language server, any
other Node project you have running, and anything else that happens to be a
Node process. Killing by window title only takes down the two windows this
project started.

## macOS

Use the `.sh` scripts and `httpd-smart-cafeteria-mac.conf` above — they are
full equivalents of the Windows files, not a fallback. The one thing the
script does **not** do for you is build the frontend and copy it into htdocs,
since that copy can need `sudo` depending on how XAMPP was installed:

```bash
cd frontend && npm run build
cp -r dist /Applications/XAMPP/xamppfiles/htdocs/smart-cafeteria
```

## Linux

The `.sh` scripts work unchanged. For Apache, copy
`httpd-smart-cafeteria-mac.conf` and change the two
`/Applications/XAMPP/xamppfiles/...` paths to your XAMPP location — typically
`/opt/lampp/...`.
