// server.js
// This is the main server file. It sets up the Express app, the Appwrite connection,
// and the routes for QR code management and webhook processing.

require('dotenv').config();
const moment = require('moment-timezone');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const cors = require('cors');
const compression = require('compression'); // Added compression middleware
const { Client, Databases, Storage, Users, Account, ID, Query, InputFile } = require('node-appwrite');

const { createServer } = require('http');
const { Server } = require('socket.io');

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Import the route files
const qrCodeRoutes = require('./qrcode');
const adminRoutes = require('./admin');
const withdrawRoutes = require('./withdraw');
const apiMerchantRoutes = require('./apiMerchants');
const withdrawalAccountsRoutes = require('./withdrawalAccounts');
const walletRoutes = require('./wallet');

// 🔥 PINELEABS FILE IMPORT
const digiqrRoutes = require('./pinelabs_digiqr.routes');

const { initSocket } = require('./socketServer');

const ConfigManager = require('./configManager');

const { createClient } = require('redis');

// --- Configuration & Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;

const { httpServer, emitTxnNew , emitQrAlert, emitForceRefresh } = initSocket(app);

httpServer.listen(PORT, () => {
  console.log(`HTTP + WS listening on :${PORT}`);
});

// Global error handlers
process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
});

// Catch uncaught exceptions
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
});


// Appwrite Configuration from your provided webhook file
const APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const APPWRITE_PROJECT_ID = '688c98fd002bfe3cf596';
const APPWRITE_API_KEY = 'standard_b2443fedac19c0903a7a280fbb0d121ea52353d7d81533f1b8a76dab54721871a595a87624511da1ad635336e50946caf684a8650bfe4fd4f5d9839cb916e595314f8b2921cc78dcd477e468393bcd4932616d3412da4e5cc5d6d79a4b31e391d2d5e1172eaa08a2fafc3b2b8615bc9ec57b17d70884c7b48957ccdc7d8d803a';
const APPWRITE_DATABASE_ID = '688ca9f3003e593a6227';
const APPWRITE_QRCODE_COLLECTION_ID = '688f6b46002963a163aa';
const APPWRITE_WEBHOOK_DATA_COLLECTION_ID = '688cf5920023475022df'; // This was not in your webhook file, keeping the placeholder for completeness
const APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID = '68920fba001e27b604c9'
const APPWRITE_USERS_META_COLLECTION_ID = 'users_meta_test';
const APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID = 'daily_qr_summaries';
const APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID = 'daily_commission_summaries';
const APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID = 'all_time_commission_total';
const APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID = 'monthly_commission_totals';
const APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID = 'commission_transactions'; // This was not in your webhook file, keeping the placeholder for completeness
const APPWRITE_BUCKET_ID = '688d2517002810ac532b'; // This was not in your webhook file, keeping the placeholder for completeness

// Your Razorpay webhook secret (from dashboard → Settings → Webhooks)
const RAZORPAY_WEBHOOK_SECRET = '4@cQVD6GBGa2G7j';

// Initialize Appwrite SDK with the server key for backend operations
const client = new Client();
client
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

const databases = new Databases(client);
const account = new Account(client);
const storage = new Storage(client);
const users = new Users(client);

// 🔥 Initialize ConfigManager with your databases instance
ConfigManager.init(databases);

// Startup health check — verify critical Appwrite collection IDs are reachable
(async () => {
  const collectionsToCheck = [
    { name: 'QR codes',                  id: APPWRITE_QRCODE_COLLECTION_ID },
    { name: 'Webhook data',              id: APPWRITE_WEBHOOK_DATA_COLLECTION_ID },
    { name: 'Users meta',                id: APPWRITE_USERS_META_COLLECTION_ID },
    { name: 'Withdrawal requests',       id: APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID },
    { name: 'Daily QR summaries',        id: APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID },
    { name: 'Commission transactions',   id: APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID },
  ];
  const failed = [];
  for (const col of collectionsToCheck) {
    try {
      await databases.listDocuments(APPWRITE_DATABASE_ID, col.id, [Query.limit(1)]);
    } catch (e) {
      failed.push(`${col.name} (${col.id}): ${e?.message || e}`);
    }
  }
  if (failed.length) {
    console.error('⚠️  Startup health check FAILED for the following collections:');
    failed.forEach(f => console.error('   •', f));
  } else {
    console.log('✅ Startup health check passed — all collections reachable');
  }
})();

// ─── Redis Client ────────────────────────────────────────────────────────────
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://red-d6osqip4tr6s73d1ba50:6379',
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
});
redisClient.on('error', (e) => console.error('Redis error:', e));
redisClient.on('reconnecting', () => console.log('Redis reconnecting...'));
redisClient.on('ready', () => console.log('Redis connected'));


// Acquire a distributed lock. Returns true if lock was acquired.
// Uses SET NX EX which is atomic in Redis — safe under concurrency.
async function acquireLock(key, value, ttlSeconds = 15) {
    try {
        const result = await redisClient.set(key, value, { NX: true, EX: ttlSeconds });
        return result === 'OK';
    } catch (e) {
        console.error('acquireLock error:', e);
        return true; // degrade gracefully if Redis is down — idempotency check is still the first defence
    }
}

// Release lock only if we are the owner (prevents releasing another process's lock)
async function releaseLock(key, value) {
    try {
        const current = await redisClient.get(key);
        if (current === value) await redisClient.del(key);
    } catch (e) {
        console.error('releaseLock error:', e);
    }
}

// On startup: seed Redis counters from Appwrite if Redis is empty (e.g. after a restart)
async function syncCountersFromAppwrite() {
    const counterNames = ['totalTxCount', 'totalApiTx', 'totalAmountReceived'];
    for (const name of counterNames) {
        try {
            const exists = await redisClient.exists(`counter:${name}`);
            if (!exists) {
                const list = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, 'dashboard_counters',
                    [Query.equal('id', name), Query.limit(1)]
                );
                const val = Number(list.documents[0]?.totals || 0);
                await redisClient.set(`counter:${name}`, val);
                console.log(`Seeded counter ${name} = ${val} from Appwrite`);
            }
        } catch (e) {
            console.error(`Failed to seed counter ${name}:`, e);
        }
    }
}

// Every 1 minutes: flush Redis counter values back to Appwrite as a backup
async function flushCountersToAppwrite() {
    const counterNames = ['totalTxCount', 'totalApiTx', 'totalAmountReceived'];
    for (const name of counterNames) {
        try {
            const val = await redisClient.get(`counter:${name}`);
            if (val === null) continue;
            const list = await databases.listDocuments(
                APPWRITE_DATABASE_ID, 'dashboard_counters',
                [Query.equal('id', name), Query.limit(1)]
            );
            if (list.documents.length > 0) {
                await databases.updateDocument(
                    APPWRITE_DATABASE_ID, 'dashboard_counters', list.documents[0].$id,
                    { totals: Number(val) }
                );
            }
        } catch (e) {
            console.error(`Failed to flush counter ${name} to Appwrite:`, e);
        }
    }
}

// Connect Redis, seed counters, start periodic flush
(async () => {
    try {
        await redisClient.connect();
        await syncCountersFromAppwrite();
        setInterval(flushCountersToAppwrite, COUNTER_FLUSH_MS);
        console.log('Redis setup complete');
    } catch (e) {
        console.error('Redis connect failed — continuing without Redis:', e);
    }
})();
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────
const LOCK_TTL_SECONDS      = 15;   // Redis lock TTL for webhook/QR operations
const COUNTER_FLUSH_MS      = 1 * 60 * 1000; // how often Redis counters flush to Appwrite (1 min)
const GRACEFUL_SHUTDOWN_MS  = 10_000; // max ms to wait for in-flight requests on shutdown
// ─────────────────────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter specifically for webhook endpoints
// This is used for the webhook routes to prevent abuse
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});

// Middleware
app.use(cors()); // Enables cross-origin requests
// Parse raw body for signature verification
// app.use(
//   bodyParser.json({
//     verify: (req, res, buf) => {
//       req.rawBody = buf.toString(); // Store raw body for HMAC check
//     },
//   })
// );

app.use(compression());  // Add after CORS, before body-parser

app.use(globalLimiter);
// app.use(helmet()); // Set security headers

app.use(
  bodyParser.json({
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || 'utf8'); // keep exact raw text
    },
  })
);

// 1. Define the parser with your verify logic (Scoped ONLY to this variable)
const webhookParser = express.json({
    verify: (req, res, buf, encoding) => {
        req.rawBody = buf.toString(encoding || 'utf8'); // keep exact raw text
    },
});

// --- Authentication Middleware ---
// This middleware verifies the user's JWT token via Appwrite's server-side API.
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Authentication token is required.' });
        }

        // console.log('Verifying token:', token);

        // Create a new client instance for this specific request with the user's JWT
        const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);

        const account = new Account(userClient);
        const user = await account.get(); // This call verifies the JWT with Appwrite

        // console.log('Authenticated user:', user.$id);

        // req.user = user;

         // Query your users_meta collection by userId (user.$id)
        const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [
                Query.equal('userId', user.$id)
            ]
        );

        if (list.documents.length === 0) {
            return res.status(404).json({ error: 'User metadata not found' });
        }

        // Attach the users_meta document to req.user
        req.user = list.documents[0];

        next();
    } catch (err) {
        console.error('JWT verification error:', err.message);
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
};

// Higher-order middleware for label-based auth
const authenticateAdminOrLabel = (requiredLabel, { isSubadminAllowed = false } = {}) => (req, res, next) => {
    authenticateToken(req, res, () => {
        const { role, labels } = req.user || {};
        if  (role === 'admin' ||
            (isSubadminAllowed && role === 'subadmin') ||
            (role === 'employee' && Array.isArray(labels) && labels.includes(requiredLabel))
        ) {
            return next();
        }

        return res.status(403).json({ error: 'Not authorized for this action.' });
    });
};


// --- Admin Authentication Middleware ---
// This middleware first authenticates the token and then checks for the 'admin' label.
const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if ( !req.user || !['admin'].includes(req.user.role) ) {
            return res.status(403).json({ error: 'Not authorized: Admin required.' });
        }
        next();
    });
};

const authenticateAdminOrSubAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (!req.user || !['admin', 'subadmin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Not authorized: Admin or SubAdmin required.' });
        }

        next();
    });
};

const authenticateAdminOrSubAdminOrEmployee = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (!req.user || !['admin', 'subadmin', 'employee'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Not authorized: Admin, SubAdmin or Employee required.' });
        }

        next();
    });
};

// Middleware to load user role & meta info
async function roleAuth(req, res, next) {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            return res.status(401).json({ error: "Unauthorized: No token" });
        }

        // Create a JWT-based client
        const jwtClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);

        const account = new Account(jwtClient);
        let appwriteUser;
        try {
            appwriteUser = await account.get();
        } catch (err) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal("appwrite_id", appwriteUser.$id)]
        );

        if (response.documents.length === 0) {
            return res.status(403).json({ error: "User meta not found" });
        }

        req.userMeta = {
            appwrite_id: response.documents[0].appwrite_id,
            role: response.documents[0].role,
            parent_id: response.documents[0].parent_id,
            labels : response.documents[0].labels || [],
        };

        next();
    } catch (error) {
        console.error("roleAuth error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
}

// Middleware factory to require specific roles
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.userMeta) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (!roles.includes(req.userMeta.role)) {
            return res.status(403).json({ error: "Forbidden: Role not allowed" });
        }
        next();
    };
}

// Pass Appwrite and authentication dependencies to the route handlers
// QR code routes use the admin authentication middleware
app.use('/api', qrCodeRoutes(databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee,roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/admin', adminRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Admin routes use the admin authentication middleware
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Merchant API routes
app.use('/api/merchant', apiMerchantRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole));

// Withdrawal Accounts routes
app.use('/api/withdrawal-accounts', withdrawalAccountsRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole));

// Wallet routes
app.use('/api/wallet', walletRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole));

// Pinelabs QR routes
app.use('/pinelabs', digiqrRoutes);

function rupeesToPaiseStrict(rupees) {
  const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
  const frac = (fracPart + '00').slice(0, 2); // exactly 2 decimals
  return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

function toInt(value) {
  return value ? parseInt(value, 10) : 0;
}

app.get('/get_app_config', async (req, res) => {

    // const result = await databases.listDocuments(
    //       APPWRITE_DATABASE_ID,
    //       '68a73217002ed987b246',
    //     );

    // console.log('Config documents:', result);

    // const docs = result.documents;  // direct access

    // const config = docs.reduce((acc, doc) => {
    //   acc[doc.key] = doc.value;
    //   return acc;
    // }, {});

    // console.log('✅ Config JSON:', config);

    // console.log('Max Withdrawal Amount:', config.max_withdrawal_amount);

    // const maxAmount = toInt(config.max_withdrawal_amount);  // 200000 or fallback 0

    // console.log('Max Withdrawal Amount Value:', maxAmount);


    /////////////////////////////////////////////////////////

    // const result = await databases.listDocuments(
    //         APPWRITE_DATABASE_ID,
    //         '68a73217002ed987b246',
    //         [
    //           Query.equal('key', 'max_withdrawal_requests'),  // ← Add this!
    //           Query.limit(1)  // Just one result
    //         ]
    //       );

    //       const max_withdrawal_requests = result.documents[0];  // Your single document

    //       console.log('Max Withdrawal Requests Config:', max_withdrawal_requests.value);

    // Example: get value for "overhead_balance_required"
    // const docs = result.data.documents;

    // const overheadDoc = docs.find(d => d.key === 'overhead_balance_required');

    // if (overheadDoc) {
    //   const overheadValue = overheadDoc.value; // 5000
    //   console.log('overhead_balance_required:', overheadValue);
    // }

    // Usage:
    // const maxWithdrawal = getConfigValue(result, 'max_withdrawal_amount');
    // const minWithdrawal = getConfigValue(result, 'min_withdrawal_amount');

    // console.log('Max Withdrawal:', maxWithdrawal);
    // console.log('Min Withdrawal:', minWithdrawal);

    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rate limiter specifically for webhook endpoints
app.use('/paytm/payment-sync', webhookLimiter);
// Endpoint to receive Paytm transaction
app.post("/paytm/payment-sync", async (req, res) => {
  try {
    const data = req.body;

    // Basic validation
    if (!data.amount || !data.orderId) {
      return res.status(400).json({ error: "Missing amount or orderId" });
    }

    const amount = data?.amount || {};
    const paymentId = data?.orderId || {};
    const qrCodeId = data?.accountOf || {};
    const fromUpi = data?.fromUpi || {};
    const timestamp = data?.timestamp || {};
    const txn_time = data?.txn_time || {};

    const amountRupees = amount;
    const amountPaise = rupeesToPaiseStrict(amountRupees);

    // 1. Convert to Date Object (Multiply by 1000)
    const dateObj = new Date(txn_time * 1000);

    // 2. Convert to ISO String
    const isoString = dateObj.toISOString();
    
    if (!qrCodeId) return res.status(400).json({ error: 'QR Code ID not found' });

    // Idempotency guard
    const existing = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
      [Query.equal('paymentId', paymentId), Query.limit(1)]
    );

    if (existing.documents.length) {
      return res.status(200).json({ message: 'Duplicate webhook ignored' });
    }

    // Persist webhook
    const payloadString = JSON.stringify(req.body);
    let created;
    try {
      created = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        ID.unique(),
        {
          payload: '',
          qrCodeId: qrCodeId,
          paymentId: paymentId,
          rrnNumber: '',
          amount: amountPaise,
          vpa: fromUpi,
          provider: 'paytm',
          created_at: isoString,
          status: 'normal',
        }
      );
    } catch (e) {
      console.error('❌ Persist webhook error:', e?.message || e);
      return res.status(500).json({ error: 'Error saving webhook', details: e?.message });
    }

    // Update daily QR total (async, no await)
    // (async () => {
    //   try {
    //     await updateDailyQrTotal(qrCodeId, isoString, amountPaise);
    //     console.log('✅ Daily QR total updated successfully.');
    //   } catch (error) {
    //     console.error('❌ Error updating daily QR total:', error?.message || error);
    //   }
    // })();

    const eventPayload = {
      $id: created.$id,
      qrCodeId,
      paymentId,
      amount: amountPaise,
      rrnNumber: null,
      vpa: fromUpi || null,
      provider: 'paytm',
      created_at: new Date(isoString).toISOString(),
    };

    // Acquire per-QR distributed lock — same pattern as Razorpay webhook
    const lockKey = `lock:qr:${qrCodeId}`;
    const acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
    if (!acquired) {
      console.warn(`Lock busy for QR ${qrCodeId}, payment ${paymentId} — will retry`);
      return res.status(503).json({ message: 'Processing conflict, retry' });
    }

    try {
      // Update daily QR summary under lock (no race on same-day same-QR)
      try {
        await updateDailyQrTotal(qrCodeId, isoString, amountPaise);
      } catch (e) {
        console.error('❌ Error updating daily QR total:', e?.message || e);
      }

      // Fetch fresh QR doc under lock
      const qrResult = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_QRCODE_COLLECTION_ID,
        [Query.equal('qrId', qrCodeId), Query.limit(1)]
      );

      if (qrResult.documents.length > 0) {
        const qrDoc = qrResult.documents[0];
        const qrDocId = qrDoc.$id;
        const newCount = (qrDoc.totalTransactions || 0) + 1;
        const newTotal = (qrDoc.totalPayInAmount || 0) + amountPaise;

        // Recompute amountAvailableForWithdrawal from fresh fields under lock — no race possible
        const approved = Number(qrDoc.withdrawalApprovedAmount || 0);
        const requested = Number(qrDoc.withdrawalRequestedAmount || 0);
        const onHold = Number(qrDoc.amountOnHold || 0);
        const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
        const commissionPaid = Number(qrDoc.commissionPaid || 0);
        const newAvailable = newTotal - approved - requested - onHold - commissionOnHold - commissionPaid;

        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          APPWRITE_QRCODE_COLLECTION_ID,
          qrDocId,
          {
            totalTransactions: newCount,
            totalPayInAmount: newTotal,
            amountAvailableForWithdrawal: newAvailable,
          }
        );


        // Emit with real assignedUserId from QR doc
        emitTxnNew({
          assignedUserId: qrDoc.assignedUserId || '',
          qrCodeId,
          payload: eventPayload,
        });
      } else {
        console.warn(`⚠️ QR Code with qrId ${qrCodeId} not found — skipping QR totals`);
        emitTxnNew({ assignedUserId: '', qrCodeId, payload: eventPayload });
      }
    } finally {
      await releaseLock(lockKey, paymentId);
    }

    // Atomic dashboard counter increments via Redis INCRBY
    await Promise.all([
      redisClient.incrBy('counter:totalTxCount', 1),
      redisClient.incrBy('counter:totalApiTx', 1),
      redisClient.incrBy('counter:totalAmountReceived', amountPaise),
    ]).catch((e) => console.error('Redis counter update failed:', e?.message || e));

    console.log("✅ Received Paytm transaction:", data);
    res.status(200).json({ message: "Transaction processed successfully" });

  } catch (err) {
    console.error("❌ Error processing transaction:", err?.message || err);
    res.status(500).json({ error: "Internal server error", details: err?.message });
  }
});

// GET last timestamp (per company)
app.get("/paytm/last-timestamp-company", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({ error: "Missing company parameter" });
    }

    const keyName = `gmail_paytm_sync_timestamp_${company}`;

    const config_docs = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      '68a73217002ed987b246'
    );

    const timestampDoc = config_docs.documents.find(
      doc => doc.key === keyName
    );

    if (timestampDoc) {
      console.log(`[${company}] Found timestamp:`, timestampDoc.value);
      return res.json({ last_mail_timestamp: timestampDoc.value });
    }

    console.log(`[${company}] No timestamp found, sending default`);
    return res.json({ last_mail_timestamp: 1764272304 });

  } catch (err) {
    console.error("GET timestamp error:", err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE last timestamp (per company)
app.post("/paytm/update-last-timestamp-company", async (req, res) => {
  try {
    const { company, last_mail_timestamp } = req.body;

    if (!company) {
      return res.status(400).json({ error: "Missing company in body" });
    }

    if (!last_mail_timestamp) {
      return res.status(400).json({ error: "Missing last_mail_timestamp in body" });
    }

    const keyName = `gmail_paytm_sync_timestamp_${company}`;
    const COLLECTION_ID = '68a73217002ed987b246';

    const config_docs = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      COLLECTION_ID
    );

    const timestampDoc = config_docs.documents.find(
      doc => doc.key === keyName
    );

    const timestampInt = parseInt(last_mail_timestamp, 10);

    if (timestampDoc) {
      // UPDATE existing
      await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        COLLECTION_ID,
        timestampDoc.$id,
        { value: timestampInt }
      );

      console.log(`[${company}] Timestamp updated → ${timestampInt}`);
      return res.json({ success: true, message: "Timestamp updated" });

    } else {
      // CREATE new doc if not exists (recommended)
      await databases.createDocument(
        APPWRITE_DATABASE_ID,
        COLLECTION_ID,
        'unique()',
        {
          key: keyName,
          value: timestampInt
        }
      );

      console.log(`[${company}] Timestamp created → ${timestampInt}`);
      return res.json({ success: true, message: "Timestamp created" });
    }

  } catch (error) {
    console.error("POST timestamp error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to Send Paytm transaction last timestamp
app.get("/paytm/last-timestamp", async (req, res) => {
  // const unixTimestamp = Math.floor(new Date(dateHeader).getTime() / 1000);

      const config_docs = await databases.listDocuments(APPWRITE_DATABASE_ID, '68a73217002ed987b246');
      const timestampDoc = config_docs.documents.find(doc => doc.key === 'gmail_paytm_sync_timestamp');

      if (timestampDoc) {
        const timestampValue = timestampDoc.value;
        console.log('Found timestamp:', timestampValue);
        res.json({ last_mail_timestamp: timestampValue });
        return
      } else {
        console.log('No timestampDoc key found');
      }

    res.json({ last_mail_timestamp: "1764272304" });
});

// Endpoint to UPDATE the Paytm transaction timestamp
app.post("/paytm/update-last-timestamp", async (req, res) => {
    try {
        // 1. Get the new timestamp from the request body
        const { last_mail_timestamp } = req.body;

        if (!last_mail_timestamp) {
            return res.status(400).json({ error: "Missing last_mail_timestamp in body" });
        }

        const COLLECTION_ID = '68a73217002ed987b246'; // Your config collection ID

        // 2. Find the document (Same logic as your GET request)
        // Note: Using Query.equal is better performance if you have the Query object imported,
        // but here is your original logic using JS find():
        const config_docs = await databases.listDocuments(
            APPWRITE_DATABASE_ID, 
            COLLECTION_ID
        );
        
        const timestampDoc = config_docs.documents.find(doc => doc.key === 'gmail_paytm_sync_timestamp');

        if (timestampDoc) {
            // FIX: Ensure it is an Integer, not a String
            const timestampInt = parseInt(last_mail_timestamp, 10);

            // 3. UPDATE the document using its ID
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                COLLECTION_ID,
                timestampDoc.$id, // The unique ID of the document we found
                {
                    value: timestampInt // <--- Sending Integer now
                }
            );

            console.log(`Updated timestamp to: ${last_mail_timestamp}`);
            return res.json({ success: true, message: "Timestamp updated" });

        } else {
            console.log('No timestampDoc key found');
            return res.status(404).json({ error: "Config document not found" });
        }

    } catch (error) {
        console.error("Database Update Failed:", error);
        res.status(500).json({ error: error.message });
    }
});

async function updateQrTotalAtomic(qrCodeId, amountPaise) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            // EXACT SAME QUERY as daily totals ✅
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                [Query.equal('qrId', qrCodeId), Query.limit(1)]
            );

            if (!qrResult.documents.length) {
                console.log(`QR ${qrCodeId} not found`);
                return;
            }

            const qrDoc = qrResult.documents[0];

            // FRESH calculations every time (like daily)
            const newCount = (qrDoc.totalTransactions || 0) + 1;
            const newTotal = (qrDoc.totalPayInAmount || 0) + amountPaise;
            const newAvailable = newTotal 
                - Number(qrDoc.withdrawalApprovedAmount || 0)
                - Number(qrDoc.withdrawalRequestedAmount || 0)
                - Number(qrDoc.amountOnHold || 0)
                - Number(qrDoc.commissionOnHold || 0)
                - Number(qrDoc.commissionPaid || 0);

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                qrDoc.$id,
                {
                    totalTransactions: newCount,
                    totalPayInAmount: newTotal,
                    amountAvailableForWithdrawal: newAvailable,
                }
            );

            console.log(`✅ QR ${qrCodeId} → ${newTotal} (attempt ${attempts + 1})`);
            return; // SUCCESS

        } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) {
                console.error(`❌ QR ${qrCodeId} failed after ${attempts} attempts`);
                return;
            }
            // 50ms backoff (proven safe)
            await new Promise(r => setTimeout(r, 50));
        }
    }
}

app.get('/test_force_refresh', (req, res) => {
  const eventPayload = {
        qrId: 'doc.qrId',
        fileId: 'doc.fileId' || null,
        imageUrl: 'oc.imageUrl',
        assignedUserId: 'doc.assignedUserId '|| null,            // anywhere in last 4 hours [15]
  };

  emitForceRefresh({
    payload: eventPayload,
  }); // Socket.IO rooms emit

  return res.status(200).json({ ok: true, payload: eventPayload });
});

// http://localhost:3000/test_qralert
app.get('/test_qralert', (req, res) => {
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min; // [1] 
    const recentIso = (minutesBack = 60) => {
        const now = Date.now();
        const past = now - minutesBack * 60 * 1000;
        const ts = randInt(past, now);
        return new Date(ts).toISOString(); // ISO 8601 [15]
  };

  const eventPayload = {
        qrId: 'doc.qrId',
        fileId: 'doc.fileId' || null,
        imageUrl: 'oc.imageUrl',
        assignedUserId: 'doc.assignedUserId '|| null,
        createdAt: recentIso(240),               // anywhere in last 4 hours [15]
        isActive: true,
        totalTransactions: 0 || 0,
        totalPayInAmount: 0 || 0,
        withdrawalRequestedAmount : 0 || 0,
        withdrawalApprovedAmount : 0 || 0,
        amountAvailableForWithdrawal : 0 || 0,
        amountOnHold : 0 || 0,              // anywhere in last 4 hours [15]
  };

  emitQrAlert({
    payload: eventPayload,
  }); // Socket.IO rooms emit

  return res.status(200).json({ ok: true, payload: eventPayload });
});

// http://localhost:3000/test_websocket
app.get('/test_websocket', (req, res) => {
  // random helpers
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min; // [1] 
  const randAlnum = (len) => crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len); // [16]
  const recentIso = (minutesBack = 60) => {
    const now = Date.now();
    const past = now - minutesBack * 60 * 1000;
    const ts = randInt(past, now);
    return new Date(ts).toISOString(); // ISO 8601 [15]
  };

  // sample sets
  const vpAs = ['vpa@ybl', 'merchant@upi', 'random@okicici', 'shop@oksbi'];
  const providers = ['cashfree', 'razorpay', 'ccavenue', 'payu'];
  //   const qrId = String(randInt(100000000, 999999999)); // 9-digit QR code ID
  const qrId = '119188392'; // 9-digit QR code ID

  // Ensure amount is a multiple of 100 paise
  const rupees = randInt(1, 100000);     // 1–500 INR [1]
  const amount = rupees * 100;        // paise [1]

  const eventPayload = {
    $id: crypto.randomUUID(),                 // unique id [16]
    qrCodeId: qrId,
    paymentId: `pay_${randAlnum(10)}`,        // random payment-like id [16]
    amount: amount,             // paise: 1.00 to 500.00 INR [9]
    rrnNumber: `RRN${randInt(1000000000, 9999999999)}`, // 10-digit RRN-style
    vpa: vpAs[randInt(0, vpAs.length - 1)],
    provider: providers[randInt(0, providers.length - 1)],
    created_at: recentIso(240),               // anywhere in last 4 hours [15]
  };

  emitTxnNew({
    assignedUserId: null,
    qrCodeId: qrId,
    payload: eventPayload,
  }); // Socket.IO rooms emit

  return res.status(200).json({ ok: true, payload: eventPayload });
});

// This is the route you provide to the Razorpay/Ezetap team
// app.post('/razorpay-webhook', webhookParser, async (req, res) => {
//     const data = req.body;

//     console.log("📩 Webhook Received:", data);

//     const payloadString = JSON.stringify(req.body);

//   try {
//     const created = await databases.createDocument(
//       APPWRITE_DATABASE_ID,
//       'razorpay_webhook',
//       ID.unique(),
//       {
//         payload: payloadString, // avoid storing full payload for Cashfree to save space
//       }
//     );
//   } catch (e){

//   }

//     // LOGIC: Check for 'status' field [cite: 897]
//     if (data.status === "AUTHORIZED") {
//         // [cite: 898] "Authorized" means transaction successfully executed
//         console.log("✅ Payment Success:", data.txnId);
        
//         // Perform your database updates here
//     } else if (data.status === "FAILED") {
//         // [cite: 898] "Failed" means money won't be deducted
//         console.log("❌ Payment Failed");
//     }

//     // IMPORTANT: You must return HTTP 200, otherwise they will retry 3 times 
//     res.status(200).send("OK");
// });

// Main For Pabesto Tech PVT Ltd. Razorpay Webhook Handler
// This is the route you provide to the Razorpay/Ezetap team
app.post('/razorpay-webhook', webhookParser, async (req, res) => {
    const wdbg = (step, msg, extra) => {
        const ts = new Date().toISOString();
        if (extra !== undefined) console.log(`[RZ-WEBHOOK][${ts}] STEP ${step}: ${msg}`, extra);
        else                     console.log(`[RZ-WEBHOOK][${ts}] STEP ${step}: ${msg}`);
    };

    const data = req.body;

    // STEP 1: validate status field
    if (data?.status !== 'AUTHORIZED') {
        wdbg('1', 'BLOCKED — status is not AUTHORIZED', { status: data?.status });
        return res.status(400).send('Payment not authorized: ' + data?.status);
    }

    // STEP 2: parse & validate required fields
    const qrCodeId     = data.tid;
    const paymentId    = data.Id;
    const rrnNumber    = data.rrNumber  || null;
    const amountRupees = data.amount;
    const amountPaise  = rupeesToPaiseStrict(amountRupees);
    const vpa          = data.customerName || null;
    const postingDate  = data.postingDate;
    const isoDate      = new Date(postingDate).toISOString();
    const payloadString = JSON.stringify(req.body);

    if (!qrCodeId)    { wdbg('2', 'BLOCKED — qrCodeId (data.tid) missing');  return res.status(400).send('QR Code ID not found'); }
    if (!paymentId)   { wdbg('2', 'BLOCKED — paymentId (data.Id) missing');   return res.status(400).send('Payment ID not found'); }
    if (!amountPaise) { wdbg('2', 'BLOCKED — amount missing or zero');        return res.status(400).send('Amount not found'); }

    try {
        // STEP 3: idempotency check — skip if already processed
        const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            [Query.equal('paymentId', paymentId), Query.limit(1)]
        );
        if (existing.documents.length) {
            return res.status(200).send('Duplicate webhook ignored');
        }

        // STEP 4: save raw webhook record (source of truth)
        const created = await databases.createDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            ID.unique(),
            {
                payload:     payloadString,
                qrCodeId,
                paymentId,
                rrnNumber,
                amount:      amountPaise,
                vpa,
                provider:    'razorpay',
                created_at:  isoDate,
                status:      'normal',
            }
        );

        // STEP 5: update daily QR summary
        try {
            await updateDailyQrTotal(qrCodeId, isoDate, amountPaise);
        } catch (e) {
            console.error('❌ Error updating daily QR total:', e?.message || e);
        }

        // STEP 6: emit real-time event
        const eventPayload = {
            $id:        created.$id,
            qrCodeId,
            paymentId,
            amount:     amountPaise,
            rrnNumber,
            vpa,
            provider:   'razorpay',
            created_at: new Date(isoDate).toISOString(),
        };
        emitTxnNew({ assignedUserId: '', qrCodeId, payload: eventPayload });

        // STEP 7: update QR totals atomically (optimistic retry, no Redis lock needed here)
        await updateQrTotalAtomic(qrCodeId, amountPaise);

        // STEP 8: atomic Redis counter increments
        await Promise.all([
            redisClient.incrBy('counter:totalTxCount', 1),
            redisClient.incrBy('counter:totalApiTx', 1),
            redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]).catch((e) => {
            console.error('Redis counter update failed:', e?.message || e);
        });

        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to process razorpay-webhook:', error.message);
        res.status(500).send('Error processing webhook');
    }
});

// --- Webhook Endpoint ---
// Secret:   4@cQVD6GBGa2G7j
// ##### Mainly Used in Pabesto Tech Pvt Ltd Kitpay for Razorpay QR code payments. #####

app.post('/webhook', async (req, res) => {

  console.log('Webhook Event Received');

    const wdbg = (step, msg, extra) => {
        const ts = new Date().toISOString();
        if (extra !== undefined) console.log(`[WEBHOOK][${ts}] STEP ${step}: ${msg}`, extra);
        else                     console.log(`[WEBHOOK][${ts}] STEP ${step}: ${msg}`);
    };

    wdbg('0', 'Request received', {
        ip: req.ip,
        contentType: req.headers['content-type'],
        hasSignature: !!req.headers['x-razorpay-signature'],
        hasRawBody:   !!req.rawBody,
        rawBodyLen:   req.rawBody?.length ?? 0,
    });

    // 1. Verify Razorpay signature
    const razorpaySignature = req.headers['x-razorpay-signature'];
    if (!razorpaySignature) {
        wdbg('1', 'BLOCKED — missing x-razorpay-signature header');
        return res.status(400).send('Missing Razorpay signature');
    }

    if (!req.rawBody) {
        wdbg('1', 'BLOCKED — req.rawBody is undefined (bodyParser did not capture body; check Content-Type header)');
        return res.status(400).send('Missing raw body for signature verification');
    }

    const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

    if (expectedSignature !== razorpaySignature) {
        wdbg('1', 'BLOCKED — signature mismatch', {
            received: razorpaySignature.substring(0, 10) + '…',
            expected: expectedSignature.substring(0, 10) + '…',
        });
        console.warn('❌ Webhook signature mismatch!');
        return res.status(400).send('Invalid signature');
    }
    wdbg('1', 'Signature verified ✅');

    // 2. Filter event type
    const eventType = req.body?.event;
    wdbg('2', 'Event type received', { eventType });
    if (eventType !== 'qr_code.credited') {
        wdbg('2', 'BLOCKED — unsupported event type (not qr_code.credited)');
        return res.status(400).send('Unsupported event type');
    }

    // 3. Parse required fields
    const qrCodeId      = req.body?.payload?.qr_code?.entity?.id;
    const paymentId     = req.body?.payload?.payment?.entity?.id;
    const rrnNumber     = req.body?.payload?.payment?.entity?.acquirer_data?.rrn;
    const amountPaise   = req.body?.payload?.payment?.entity?.amount;
    const vpa           = req.body?.payload?.payment?.entity?.vpa;
    const unixTimestamp = req.body?.payload?.payment?.entity?.created_at;
    const isoDate       = new Date(unixTimestamp * 1000).toISOString();
    const payloadString = JSON.stringify(req.body);

    wdbg('3', 'Parsed fields', { qrCodeId, paymentId, rrnNumber, amountPaise, vpa, isoDate });

    if (!qrCodeId) { wdbg('3', 'BLOCKED — qrCodeId missing from payload'); return res.status(400).send('QR Code ID not found'); }
    if (!paymentId) { wdbg('3', 'BLOCKED — paymentId missing from payload'); return res.status(400).send('Payment ID not found'); }
    if (!amountPaise) { wdbg('3', 'BLOCKED — amount missing from payload'); return res.status(400).send('Amount not found'); }

    try {
        // 4. Idempotency check — reject duplicate paymentId before any writes
        wdbg('4', 'Checking duplicate paymentId in DB…', { paymentId });
        const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            [Query.equal('paymentId', paymentId), Query.limit(1)]
        );
        if (existing.total > 0) {
            wdbg('4', 'BLOCKED — duplicate paymentId already in DB', { existingDocId: existing.documents[0].$id });
            console.log('Duplicate webhook, ignoring:', paymentId);
            return res.status(200).send('Already processed');
        }
        wdbg('4', 'No duplicate found — proceeding ✅');

        // 5. Save raw webhook record (source of truth)
        wdbg('5', 'Creating transaction document in Appwrite…');
        const created = await databases.createDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            ID.unique(),
            {
                payload: payloadString,
                qrCodeId,
                paymentId,
                rrnNumber,
                amount: amountPaise,
                vpa,
                provider: 'razorpay',
                created_at: isoDate,
                status: 'normal',
            }
        );
        wdbg('5', 'Transaction document created ✅', { docId: created.$id });

        // 6. Acquire per-QR distributed lock
        const lockKey = `lock:qr:${qrCodeId}`;
        wdbg('6', 'Acquiring Redis lock…', { lockKey, ttl: LOCK_TTL_SECONDS });
        const acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
        if (!acquired) {
            wdbg('6', 'BLOCKED — lock busy, another payment for this QR is processing', { qrCodeId, paymentId });
            console.warn(`Lock busy for QR ${qrCodeId}, payment ${paymentId} — Razorpay will retry`);
            return res.status(503).send('Processing conflict, retry');
        }
        wdbg('6', 'Lock acquired ✅', { lockKey });

        try {
            // 7. Fetch fresh QR doc under lock
            wdbg('7', 'Fetching QR document from Appwrite…', { qrCodeId });
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                [Query.equal('qrId', qrCodeId), Query.limit(1)]
            );

            if (qrResult.documents.length > 0) {
                const qrDoc = qrResult.documents[0];
                const qrDocId = qrDoc.$id;
                const newCount = (qrDoc.totalTransactions || 0) + 1;
                const newTotal = (qrDoc.totalPayInAmount || 0) + amountPaise;

                const approved        = Number(qrDoc.withdrawalApprovedAmount || 0);
                const requested       = Number(qrDoc.withdrawalRequestedAmount || 0);
                const onHold          = Number(qrDoc.amountOnHold || 0);
                const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
                const commissionPaid  = Number(qrDoc.commissionPaid || 0);
                const newAvailable    = newTotal - approved - requested - onHold - commissionOnHold - commissionPaid;

                wdbg('7', 'QR doc found ✅', {
                    qrDocId,
                    prevTotal: qrDoc.totalPayInAmount,
                    newTotal,
                    newCount,
                    newAvailable,
                });

                wdbg('7b', 'Updating QR document totals…');
                await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_QRCODE_COLLECTION_ID,
                    qrDocId,
                    {
                        totalTransactions: newCount,
                        totalPayInAmount: newTotal,
                        amountAvailableForWithdrawal: newAvailable,
                    }
                );
                wdbg('7b', 'QR document updated ✅');

                // 8. Update daily QR summary
                wdbg('8', 'Updating daily QR summary…', { qrCodeId, isoDate, amountPaise });
                try {
                    await updateDailyQrTotal(qrCodeId, isoDate, amountPaise);
                    wdbg('8', 'Daily QR summary updated ✅');
                } catch (e) {
                    wdbg('8', '⚠️  Daily QR summary update FAILED (non-fatal)', { error: e.message });
                    console.error('Error updating daily QR total:', e);
                }

                // 9. Emit real-time event
                wdbg('9', 'Emitting real-time event…', { assignedUserId: qrDoc.assignedUserId || '(none)' });
                const assignedUserId = qrDoc.assignedUserId || '';
                const eventPayload = {
                    $id: created.$id,
                    qrCodeId,
                    paymentId,
                    amount: amountPaise,
                    rrnNumber: rrnNumber || null,
                    vpa: vpa || null,
                    provider: 'razorpay',
                    created_at: isoDate,
                };
                emitTxnNew({ assignedUserId, qrCodeId, payload: eventPayload });
                wdbg('9', 'Real-time event emitted ✅');

            } else {
                wdbg('7', '⚠️  QR NOT FOUND in DB — skipping QR totals and daily summary', { qrCodeId });
                console.warn(`QR ${qrCodeId} not found in DB — skipping QR totals and daily summary`);
            }
        } finally {
            wdbg('6f', 'Releasing Redis lock…', { lockKey });
            await releaseLock(lockKey, paymentId);
            wdbg('6f', 'Lock released ✅');
        }

        // 10. Atomic dashboard counter increments
        wdbg('10', 'Incrementing Redis dashboard counters…');
        await Promise.all([
            redisClient.incrBy('counter:totalTxCount', 1),
            redisClient.incrBy('counter:totalApiTx', 1),
            redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]).catch((e) => {
            wdbg('10', '⚠️  Redis counter update FAILED (non-fatal)', { error: e.message });
            console.error('Redis counter update failed:', e);
        });
        wdbg('10', 'Redis counters updated ✅');

        wdbg('DONE', '✅ Webhook fully processed — sending 200', { paymentId, qrCodeId });
        res.status(200).send('Webhook received and saved');
    } catch (error) {
        wdbg('ERR', '❌ Unhandled error in webhook processing', { message: error.message, stack: error.stack });
        console.error('❌ Failed to process webhook:', error.message);
        res.status(500).send('Error processing webhook');
    }
});

async function updateDailyQrTotal(qrCodeId, txnDate, amountDelta) {
  // Convert txnDate to IST date string "YYYY-MM-DD"
  const istDate = moment.tz(txnDate, 'Asia/Kolkata');
  const dayString = istDate.format('YYYY-MM-DD');


  // Query existing aggregate document for the day
  const existingDocs = await databases.listDocuments(
    APPWRITE_DATABASE_ID,
    APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
    [
      Query.equal('date', dayString),
      Query.limit(1),
    ]
  );

  if (existingDocs.total > 0) {
    // Document exists - parse JSON string and update totals object
    const doc = existingDocs.documents[0];
    const totalsJsonStr = doc.totalsJson || '{}';

    let totalsObj;
    try {
      totalsObj = JSON.parse(totalsJsonStr);
    } catch (e) {
      // fallback if corrupted JSON
      totalsObj = {};
    }

    // Compute new amount for given qrCodeId
    const oldAmount = Number(totalsObj[qrCodeId] || 0);
    const newAmount = oldAmount + amountDelta;

    if (newAmount < 0) {
      throw new Error('Total amount cannot be negative');
    }

    totalsObj[qrCodeId] = newAmount;

    // Serialize back and update document
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
      doc.$id,
      {
        totalsJson: JSON.stringify(totalsObj),
      }
    );
  } else {
    // Create new document with totalsJson initialized
    const totalsObj = { [qrCodeId]: amountDelta };

    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
      ID.unique(),
      {
        date: dayString,
        totalsJson: JSON.stringify(totalsObj),
      }
    );
  }
}

// Root endpoint for testing
app.get('/', (req, res) => {
    res.send('QR Code Admin API is running!');
});

// // Start the server
// app.listen(PORT, () => {
//     console.log(`🚀 Server is running on port ${PORT}`);
// });

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// Render sends SIGTERM on deploys/restarts. Give in-flight requests time to finish
// before closing DB/Redis connections, then exit cleanly.
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received — starting graceful shutdown`);
    httpServer.close(async () => {
        console.log('HTTP server closed — no new connections accepted');
        try {
            await redisClient.quit();
            console.log('Redis connection closed');
        } catch (e) {
            console.error('Error closing Redis during shutdown:', e);
        }
        process.exit(0);
    });
    // Force-kill after 10 s if requests haven't drained
    setTimeout(() => {
        console.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_MS).unref(); // .unref() so this timer doesn't keep the process alive on its own
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
// ─────────────────────────────────────────────────────────────────────────────
