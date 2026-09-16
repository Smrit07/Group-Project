require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./src/routes/authRoutes');
const menuRoutes = require('./src/routes/menuRoutes');
const counterRoutes = require('./src/routes/counterRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const queueRoutes = require('./src/routes/queueRoutes');
const simulationRoutes = require('./src/routes/simulationRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const server = http.createServer(app);

// Socket.io powers the "no page refresh needed" requirement (NFR-04):
// staff order board, student order status and queue banner all listen
// for these events on the front end.
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
});
app.set('io', io); // so controllers can do req.app.get('io').emit(...)

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`Client disconnected: ${socket.id}`));
});

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/counters', counterRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/simulations', simulationRoutes);
app.use('/api/reports', reportRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route not found.' }));
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Smart Cafeteria API listening on http://localhost:${PORT}`);
});
