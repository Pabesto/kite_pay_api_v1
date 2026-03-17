// server.js (CommonJS)
const http = require('http');
const { Client, Account, Databases, Query } = require('node-appwrite');
const { Server } = require('socket.io');

let io; // Declare io in outer scope for access in emit functions

function initSocket(app, { appwriteEndpoint, appwriteProjectId, appwriteApiKey, appwriteDatabaseId, usersMetaCollectionId }) {
  // reuse the same HTTP server as Express
  const httpServer = http.createServer(app);

  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket'],
  });

  // Appwrite admin client for querying users_meta
  const adminClient = new Client()
    .setEndpoint(appwriteEndpoint)
    .setProject(appwriteProjectId)
    .setKey(appwriteApiKey);
  const databases = new Databases(adminClient);

  // Auth middleware: verify Appwrite JWT via account.get()
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization || '').split(' ')[1];
      if (!token) return next(new Error('Unauthorized'));

      // Verify JWT by creating a user-scoped Appwrite client
      const userClient = new Client()
        .setEndpoint(appwriteEndpoint)
        .setProject(appwriteProjectId)
        .setJWT(token);

      const account = new Account(userClient);
      const user = await account.get();

      if (!user.$id) return next(new Error('Unauthorized'));

      // Fetch user metadata
      const list = await databases.listDocuments(
        appwriteDatabaseId,
        usersMetaCollectionId,
        [Query.equal('userId', user.$id)]
      );

      socket.data.userId = user.$id;
      socket.data.userMeta = list.documents[0] || null;
      return next();
    } catch (e) {
      console.error('Socket auth error:', e.message);
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, 'userId:', socket.data.userId);
    const userId = socket.data.userId;
    // join per-user room
    socket.join(`room:user:${userId}`);

    // client asks to subscribe to specific QR codes it owns
    socket.on('subscribe:qrs', async ({ qrIds }) => {
      // console.log('User subscribing to QR rooms:', qrIds);
      if (!Array.isArray(qrIds)) return;
      for (const qrId of qrIds) {
        // TODO: validate ownership: isQrAssignedToUser(qrId, userId)
        // Only join if the QR is assigned to this user
        socket.join(`room:qr:${qrId}`);
      }
    });

    // admin suscribes to all QR alerts for Work Starting
    socket.on('subscribe:qrsAlert', async ({qrId}) => {
        console.log('Admin subscribed to QR alerts');
        socket.join(`qrsAlert`);
      }
    );

    // admin Un-suscribes to all QR alerts for Work Starting
    socket.on('unsubscribe:qrsAlert', async (qrId) => {
        socket.leave(`qrsAlert`);
      }
    );

    socket.on('send:qrsAlert', async (qrId) => {
      // console.log('User sending QR alert for QR ID:', qrId);
      emitQrAlert({ payload: qrId });
      }
    );

    socket.on('unsubscribe:qrs', ({ qrIds }) => {
      if (!Array.isArray(qrIds)) return;
      for (const qrId of qrIds) socket.leave(`room:qr:${qrId}`);
    });

    socket.on('disconnect', () => {
      // optional logging/cleanup
    });
  });

  return { httpServer, io, emitTxnNew, emitQrAlert, emitQrLimit, emitForceRefresh, emitTxnStatusNew };
}

// Helper: emit a new transaction event to intended audiences
  function emitTxnNew({ assignedUserId, qrCodeId, payload }) {
    try {
      if (!io) return;
      if (assignedUserId) {
        io.to(`room:user:${assignedUserId}`).emit('txn:new', payload);
      }
      if (qrCodeId) {
        io.to(`room:qr:${qrCodeId}`).emit('txn:new', payload);
      }
    } catch (e) {
      console.error('emitTxnNew error:', e.message);
    }
  }

  function emitQrAlert({ payload }) {
    try {
      if (!io || !payload) return;
      io.to(`qrsAlert`).emit('qrsAlert', payload);
    } catch (e) {
      console.error('emitQrAlert error:', e.message);
    }
  }

  function emitQrLimit({ assignedUserId, qrCodeId, payload }) {
    try {
      if (!io) return;
      if (qrCodeId) {
        io.to(`room:qr:${qrCodeId}`).emit('qrLimitAlert', payload);
      }
    } catch (e) {
      console.error('emitQrLimit error:', e.message);
    }
  }

  function emitForceRefresh({ payload } = {}) {
    try {
      if (!io) return;
      io.emit('forceRefresh', payload);
    } catch (e) {
      console.error('emitForceRefresh error:', e.message);
    }
  }

  function emitTxnStatusNew({ assignedUserId, qrCodeId, payload }) {
    try {
      if (!io) return;
      if (assignedUserId) {
        io.to(`room:user:${assignedUserId}`).emit('txn:statusChange', payload);
      }
      if (qrCodeId) {
        io.to(`room:qr:${qrCodeId}`).emit('txn:statusChange', payload);
      }
    } catch (e) {
      console.error('emitTxnStatusNew error:', e.message);
    }
  }

module.exports = { initSocket, emitTxnNew, emitQrAlert, emitQrLimit, emitForceRefresh, emitTxnStatusNew };

