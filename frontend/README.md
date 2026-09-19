# Smart Cafeteria — Frontend

Svelte + Vite single-page PWA for the Smart Cafeteria & Resource Queue
Optimizer.

## Setup

```
npm install
cp .env.example .env     # copy .env.example .env  on Windows
npm run dev              # http://localhost:5173
```

The dev server proxies `/api` and `/socket.io` to `http://localhost:4000`, so
the app uses the **same relative URLs in development as in production**. That
matters more than it sounds: with two different API base URLs and a conditional
you get the classic "works in dev, 404s in the build", and you only find out
after deploying.

## Building for XAMPP

```
npm run build
xcopy /E /I /Y dist C:\xampp\htdocs\smart-cafeteria
```

`VITE_BASE_PATH` in `.env` **must** match the folder under `htdocs`. Vite bakes
asset URLs in at build time, so a bundle built for `/` and served from
`/smart-cafeteria/` loads a blank white page with 404s on every asset. The
default in `.env.example` is `/smart-cafeteria/`.

Leave `VITE_API_BASE` and `VITE_SOCKET_URL` **empty**. The app then calls
`/api` and `/socket.io` on its own origin, which Apache proxies to Node. This
is what lets the same build work on `localhost` and from a phone on the campus
network without being rebuilt — an absolute `http://localhost:4000` would point
the phone at itself.

## What's here

- `src/App.svelte` — routes between login/register and the role-specific
  dashboard. Manager and admin share one dashboard, since their backend
  permissions overlap almost entirely.
- `src/pages/StudentView.svelte` — menu, order building, placement, tracking.
- `src/pages/StaffView.svelte` — live order board and counter open/close; inside
  the management dashboard it also assigns staff to counters (NFR-10).
- `src/pages/ManagementView.svelte` — menu management, the KPI summary, and the
  simulation panel.
- `src/pages/Profile.svelte` — FR-18. A user's own account only; nothing about
  any other user is ever fetched here.
- `src/components/QueueBanner.svelte` — the always-visible live queue estimate.
- `src/components/SimulationPanel.svelte` — the what-if staffing tool.
- `src/lib/` — `api.js` (fetch wrapper, typed errors, timeouts), `auth.js`
  (session store, persisted to localStorage), `socket.js` (Socket.io client and
  connection-state store), `notify.js` (FR-08 ready notifications).

## Three things worth explaining in the viva

**The banner says how good its own number is.** When the DES engine answers, it
shows the estimate plainly. When the engine is down and the backend has fallen
back to `queue / counters`, it adds *approximate — simulation offline*. And
when the WebSocket has dropped it shows *reconnecting…*, because silently
showing a stale queue length is worse than showing none — the entire value of
the banner is that it is current. It also polls faster (7s instead of 20s)
while the socket is down, and refreshes on tab focus, since phones suspend
timers in a backgrounded tab.

**The simulation panel checks the engine before you use the form.** An
unavailable engine is a greyed-out panel with the command to start it, not a
failed submit after you have typed everything in.

**The service worker never caches `/api`.** Cache-first on a queue estimate
would serve a four-hour-old wait time, which is worse than no app at all.
Static assets are cache-first (Vite content-hashes them, so a cached copy can
never be stale); navigations are network-first with a cached shell fallback, so
the page still opens offline and says the live queue is unavailable rather than
showing the browser's offline error.

## Design

No component library. Flat colour, hairline borders, and a ticket/counter
visual theme — amber for waiting, green for ready, clay-red for closed. The
full token list is in `src/lib/styles.css`.

> **Note for the report.** Both the proposal and the final report name
> Bootstrap 5 in the technology stack table. The code does not use it. Either
> amend the tables or rework the styling before submission.
