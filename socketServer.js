// server.js (CommonJS)
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

function initSocket(app) {
  // reuse the same HTTP server as Express
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket'],
  });

  // Auth middleware: expect Bearer token in auth or headers
//   io.use((socket, next) => {
//     try {
//       const token =
//         socket.handshake.auth?.token ||
//         (socket.handshake.headers.authorization || '').split(' ')[15];
//       if (!token) return next(new Error('Unauthorized'));
//       const payload = jwt.verify(token, process.env.JWT_SECRET);
//       socket.data.userId = payload.id || payload.userId;
//       if (!socket.data.userId) return next(new Error('Unauthorized'));
//       return next();
//     } catch (e) {
//       return next(new Error('Unauthorized'));
//     }
//   });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'userId:', socket.data.userId);
    const userId = socket.data.userId;
    // join per-user room
    socket.join(`room:user:${userId}`);

    // client asks to subscribe to specific QR codes it owns
    socket.on('subscribe:qrs', async ({ qrIds }) => {
      if (!Array.isArray(qrIds)) return;
      for (const qrId of qrIds) {
        // TODO: validate ownership: isQrAssignedToUser(qrId, userId)
        // Only join if the QR is assigned to this user
        socket.join(`room:qr:${qrId}`);
      }
    });

    socket.on('unsubscribe:qrs', ({ qrIds }) => {
      if (!Array.isArray(qrIds)) return;
      for (const qrId of qrIds) socket.leave(`room:qr:${qrId}`);
    });

    socket.on('disconnect', () => {
      // optional logging/cleanup
    });
  });

  // Helper: emit a new transaction event to intended audiences
  function emitTxnNew({ assignedUserId, qrCodeId, payload }) {
    if (assignedUserId) {
      io.to(`room:user:${assignedUserId}`).emit('txn:new', payload);
    }
    if (qrCodeId) {
      io.to(`room:qr:${qrCodeId}`).emit('txn:new', payload);
    }
  }

  return { httpServer, io, emitTxnNew };
}

module.exports = { initSocket };
