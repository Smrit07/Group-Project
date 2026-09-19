require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Server } = require('socket.io');

const pool = require('./src/config/db');
const desClient = require('./src/services/desClient');

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const menuRoutes = require('./src/routes/menuRoutes');
const counterRoutes = require('./src/routes/counterRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const queueRoutes = require('./src/routes/queueRoutes');
const simulationRoutes = require('./src/routes/simulationRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Behind XAMPP's Apache
// ---------------------------------------------------------------------------
// In the XAMPP deployment Apache serves the built PWA on port 80 and reverse
// proxies /api and /socket.io through to this process. Without trust proxy,
// every request appears to come from 127.0.0.1, which makes the access log
// useless and would break any future rate limiting.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// Two origins are normal here, not one: http://localhost during Apache-served
// use, and http://localhost:5173 while running the Vite dev server. A single
// CORS_ORIGIN forces a developer to edit .env every time they switch, and the
// usual "fix" for that is '*', which is worse. So a comma-separated allow-list.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, or the health check.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
  },
  credentials: true,
};

// ---------------------------------------------------------------------------
// Socket.io — the "no page refresh" requirement (NFR-04)
// ---------------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
  // Apache's mod_proxy_wstunnel handles the WebSocket upgrade, but if it has
  // not been enabled the client must still work. Keeping polling in the
  // transport list means a misconfigured Apache degrades to slower live
  // updates instead of no live updates.
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
});
app.set('io', io);

io.on('connection', (socket) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[socket] connected: ${socket.id}`);
  }
  socket.on('disconnect', (reason) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    }
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors(corsOptions));
// A 100kb cap: the largest legitimate body in this API is a 20-line order.
// The default 100kb is already the express default, but stating it here makes
// it a decision rather than an accident.
app.use(express.json({ limit: '100kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
// Reports on both dependencies rather than just answering "ok". The two ways
// this app fails on a fresh machine are "XAMPP's MySQL isn't started" and
// "nobody started the DES engine", and this endpoint names which.
app.get('/api/health', async (req, res) => {
  const [database, engine] = await Promise.all([
    pool.verifyConnection(),
    desClient.health(),
  ]);

  const healthy = database.connected;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    database,
    simulationEngine: {
      available: engine.available,
      url: desClient.DES_ENGINE_URL,
      modelVersion: engine.modelVersion || null,
      message: engine.available
        ? null
        : 'Wait times fall back to a simple average-rate estimate until the engine is running (NFR-09).',
      breaker: desClient.status(),
    },
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/counters', counterRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/simulations', simulationRoutes);
app.use('/api/reports', reportRoutes);

// ---------------------------------------------------------------------------
// Serving the built PWA
// ---------------------------------------------------------------------------
// Optional. In the documented XAMPP setup Apache serves frontend/dist from
// htdocs, and this block never runs. It exists so that the whole application
// can also be demonstrated from a single `npm start` on a machine where Apache
// has not been configured — which is what you want five minutes before a viva.
const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist');

// The build's asset URLs are absolute and baked in at build time by Vite's
// `base` option, so a bundle built for /smart-cafeteria/ requests its assets
// from /smart-cafeteria/assets/... even when Node serves it. Mounting the same
// directory at both '/' and that base path means one build works either way,
// instead of the app loading a blank white page because every asset 404s.
const frontendBasePath = (process.env.FRONTEND_BASE_PATH || '/smart-cafeteria/').replace(/\/+$/, '');

if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  console.log(`[server] Serving the built frontend from ${frontendDist}`);

  const staticOptions = {
      // Hashed asset filenames can be cached hard; index.html and the service
      // worker must not be, or a rebuild never reaches a browser that has
      // already installed the PWA.
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.[0-9a-f]{8,}\./.test(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  };

  app.use(express.static(frontendDist, staticOptions));
  if (frontendBasePath) {
    app.use(frontendBasePath, express.static(frontendDist, staticOptions));
  }

  // SPA fallback: any non-API GET returns index.html so the client-side view
  // logic can handle it. Scoped to GET so a POST to a mistyped API path still
  // returns a 404 rather than a page of HTML.
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ message: 'Route not found.' }));
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4000);

async function start() {
  // Check the database before opening the port, so a misconfiguration is
  // reported in this terminal rather than discovered later as a browser 500.
  const database = await pool.verifyConnection();

  if (database.connected) {
    console.log(`[db] Connected to MySQL ${database.version} (${database.database})`);
    if (database.warning) console.warn(`[db] ${database.warning}`);
  } else {
    console.error('\n  MySQL is not reachable.');
    console.error(`  ${database.error}\n`);
    console.error('  The API will still start so you can check http://localhost:4000/api/health,');
    console.error('  but every data request will fail until MySQL is running.\n');
  }

  const engine = await desClient.health();
  if (engine.available) {
    console.log(`[des] Simulation engine ready at ${desClient.DES_ENGINE_URL} (model ${engine.modelVersion})`);
  } else {
    console.warn(`[des] Simulation engine not reachable at ${desClient.DES_ENGINE_URL}.`);
    console.warn('[des] Wait times will use the fallback estimator and /api/simulations will return 503.');
    console.warn('[des] Start it with: cd des-engine && python app.py');
  }

  server.listen(PORT, () => {
    console.log(`\n  Smart Cafeteria API listening on http://localhost:${PORT}`);
    console.log(`  Health check:  http://localhost:${PORT}/api/health`);
    console.log(`  Allowed origins: ${allowedOrigins.join(', ')}\n`);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Ctrl+C during development, and the taskkill in deploy/stop-smart-cafeteria.bat,
// both land here. Closing the pool explicitly stops MySQL logging an aborted
// connection every time the server restarts, which otherwise fills XAMPP's
// error log with noise that looks like a real problem.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received — shutting down.`);

  const forced = setTimeout(() => {
    console.warn('[server] Shutdown took too long; exiting anyway.');
    process.exit(1);
  }, 8000);
  forced.unref();

  io.close();
  server.close(async () => {
    await pool.closePool();
    clearTimeout(forced);
    console.log('[server] Closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
