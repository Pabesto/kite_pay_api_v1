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
const { Client, Databases, Storage, Users, Account, ID, Query, InputFile, TablesDB } = require('node-appwrite');

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

// Import the Socket.IO initialization function
const { initSocket } = require('./socketServer');

// Import the ConfigManager for dynamic configuration management
const ConfigManager = require('./configManager');

const { createClient } = require('redis');
const userMetaCache = require('./userMetaCache');
const dashboardCounters = require('./dashboardCounters');

// --- Configuration & Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;

// console.log(process.env.APPWRITE_ENDPOINT, 'is the Redis URL being used');

// Appwrite Configuration loaded from .env
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_QRCODE_COLLECTION_ID = process.env.APPWRITE_QRCODE_COLLECTION_ID;
const APPWRITE_WEBHOOK_DATA_COLLECTION_ID = process.env.APPWRITE_WEBHOOK_DATA_COLLECTION_ID;
const APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID = process.env.APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID;
const APPWRITE_USERS_META_COLLECTION_ID = process.env.APPWRITE_USERS_META_COLLECTION_ID;
const APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID = process.env.APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID;
const APPWRITE_DAILY_DELETED_SUMMARY_COLLECTION_ID = process.env.APPWRITE_DAILY_DELETED_SUMMARY_COLLECTION_ID;
const APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID = process.env.APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID;
const APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID = process.env.APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID;
const APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID = process.env.APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID;
const APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID = process.env.APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID;
const APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID = process.env.APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID;
const APPWRITE_MANUAL_HOLD_COLLECTION_ID = process.env.APPWRITE_MANUAL_HOLD_COLLECTION_ID;
const APPWRITE_WALLET_TRANSACTIONS_COLLECTION_ID = process.env.APPWRITE_WALLET_TRANSACTIONS_COLLECTION_ID;
const APPWRITE_WALLET_COLLECTION_ID = process.env.APPWRITE_WALLET_COLLECTION_ID;
const APPWRITE_WITHDRAWAL_ACCOUNTS_COLLECTION_ID = process.env.APPWRITE_WITHDRAWAL_ACCOUNTS_COLLECTION_ID;
const APPWRITE_API_MERCHANTS_COLLECTION_ID = process.env.APPWRITE_API_MERCHANTS_COLLECTION_ID;
const APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID = process.env.APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID;
const APPWRITE_CONFIG_COLLECTION_ID = process.env.APPWRITE_CONFIG_COLLECTION_ID;
const APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID = process.env.APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID;
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;

// Razorpay webhook secret (from dashboard → Settings → Webhooks)
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// Set LOG_RAZORPAY_WEBHOOK=false in .env to silence the full webhook payload log.
const LOG_RAZORPAY_WEBHOOK = String(process.env.LOG_RAZORPAY_WEBHOOK ?? 'true').toLowerCase() !== 'false';

const { httpServer, emitTxnNew, emitQrAlert, emitForceRefresh, emitTxnStatusNew } = initSocket(app, {
  appwriteEndpoint: APPWRITE_ENDPOINT,
  appwriteProjectId: APPWRITE_PROJECT_ID,
});

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

	// function istDateTimeNow(){
    //   const istOffset = 5.5 * 60 * 60 * 1000;
    //   const AtIST = new Date(Date.now() + istOffset).toISOString();
    //   return AtIST;
    // }

    // console.log('IST Time for server startup:', istDateTimeNow());
	
	// function istDateTimeNowNew(){
    //   return moment().tz('Asia/Kolkata').format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    // }

    // console.log('IST Time for server startup:', istDateTimeNowNew());

// console.log('IST Time for server startup:', moment().tz('Asia/Kolkata').format('hh:mm:a'));
// console.log('IST Time for server startup:', moment().tz('Asia/Kolkata').format('YYYY-MM-DDTHH:mm:ss.SSSZ'));
// → 2026-03-15T05:59:49.122+05:30

// await ConfigManager.migrateValueToVal(); // uncomment and run once to migrate, then comment out

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

const tablesDB = new TablesDB(client);

// 🔥 Initialize ConfigManager with your databases instance
ConfigManager.init({ databases, APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID });

// Startup health check — verify critical Appwrite collection IDs are reachable
(async () => {
  const collectionsToCheck = [
    { name: 'QR codes',                  id: APPWRITE_QRCODE_COLLECTION_ID },
    { name: 'Webhook data',              id: APPWRITE_WEBHOOK_DATA_COLLECTION_ID },
    { name: 'Users meta',                id: APPWRITE_USERS_META_COLLECTION_ID },
    { name: 'Withdrawal requests',       id: APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID },
    { name: 'Daily QR summaries',        id: APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID },
    { name: 'Daily deleted summary',     id: APPWRITE_DAILY_DELETED_SUMMARY_COLLECTION_ID },
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


// ─── Constants ───────────────────────────────────────────────────────────────
const LOCK_TTL_SECONDS      = 15;   // Redis lock TTL for webhook/QR operations
const COUNTER_FLUSH_MS      = 1 * 60 * 1000; // how often Redis counters flush to Appwrite (1 min)
const GRACEFUL_SHUTDOWN_MS  = 10_000; // max ms to wait for in-flight requests on shutdown
// ─────────────────────────────────────────────────────────────────────────────

console.log(`Server starting with Appwrite endpoint ${APPWRITE_ENDPOINT} and Redis URL ${process.env.REDIS_URL}`);

// ─── Redis Client ────────────────────────────────────────────────────────────
const redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
});
// redisClient.on('error', (e) => console.error('Redis error:', e));
redisClient.on('reconnecting', () => console.log('Redis reconnecting...'));
redisClient.on('ready', () => console.log('Redis connected'));

// Race a promise against a timeout (used for Redis ops that may hang on zombie connections)
function withRedisTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Redis op timed out after ${ms}ms`)), ms)),
    ]);
}

// ─── In-memory lock fallback (single-instance, used when Redis is down) ─────
const memLocks = new Map(); // key → { value, timer }

function memAcquire(key, value, ttlSeconds) {
    if (memLocks.has(key)) return false; // already held
    const timer = setTimeout(() => memLocks.delete(key), ttlSeconds * 1000);
    memLocks.set(key, { value, timer });
    return true;
}

function memRelease(key, value) {
    const entry = memLocks.get(key);
    if (entry && entry.value === value) {
        clearTimeout(entry.timer);
        memLocks.delete(key);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// Acquire a distributed lock. Tries Redis first, falls back to in-memory.
// Uses SET NX EX which is atomic in Redis — safe under concurrency.
async function acquireLock(key, value, ttlSeconds = 15) {
    try {
        const result = await withRedisTimeout(
            redisClient.set(key, value, { NX: true, EX: ttlSeconds }),
            3000
        );
        return result === 'OK';
    } catch (e) {
        console.error('acquireLock Redis failed, using in-memory fallback:', e.message);
        return memAcquire(key, value, ttlSeconds);
    }
}

// Release lock — tries Redis first, always cleans up in-memory fallback.
async function releaseLock(key, value) {
    const lua = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
    try {
        await withRedisTimeout(
            redisClient.eval(lua, { keys: [key], arguments: [value] }),
            3000
        );
    } catch (e) {
        console.error('releaseLock Redis failed:', e.message);
    }
    // Always clean up in-memory lock (no-op if not held there)
    memRelease(key, value);
}

// On startup: seed Redis counters from Appwrite if Redis is empty (e.g. after a restart)
async function syncCountersFromAppwrite() {
    const counterNames = ['totalTxCount', 'totalApiTx', 'totalAmountReceived'];
    try {
        // Check which counters are missing in Redis
        const missing = [];
        for (const name of counterNames) {
            const exists = await redisClient.exists(`counter:${name}`);
            if (!exists) missing.push(name);
        }
        if (!missing.length) return;

        // Single batch query instead of N individual queries
        const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID,
            [Query.equal('id', missing), Query.limit(missing.length)]
        );
        for (const doc of list.documents) {
            const val = Number(doc.totals || 0);
            await redisClient.set(`counter:${doc.id}`, val);
            console.log(`Seeded counter ${doc.id} = ${val} from Appwrite`);
        }
    } catch (e) {
        console.error('Failed to seed counters:', e);
    }
}

// Every 1 minutes: flush Redis counter values back to Appwrite as a backup.
// Only flushes if Redis counters are known to be accurate (no failed incrBy since last flush).
// Flags live on redisClient so admin.js (which receives redisClient) can also set them.
redisClient.countersDirty = false;  // set true when incrBy succeeds, false after flush
redisClient.countersStale = false;  // set true when incrBy fails — blocks flush until re-synced

async function flushCountersToAppwrite() {
    if (redisClient.countersStale) {
        // Redis missed increments — re-seed from Appwrite to avoid overwriting with stale values
        console.warn('Counters marked stale — re-syncing from Appwrite instead of flushing');
        try {
            const counterNames = ['totalTxCount', 'totalApiTx', 'totalAmountReceived'];
            const list = await databases.listDocuments(
                APPWRITE_DATABASE_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID,
                [Query.equal('id', counterNames), Query.limit(counterNames.length)]
            );
            for (const doc of list.documents) {
                const val = Number(doc.totals || 0);
                await redisClient.set(`counter:${doc.id}`, val);
            }
            redisClient.countersStale = false;
            redisClient.countersDirty = false;
            console.log('Counters re-synced from Appwrite');
        } catch (e) {
            console.error('Counter re-sync failed:', e);
        }
        return;
    }

    if (!redisClient.countersDirty) return; // nothing changed since last flush

    const counterNames = ['totalTxCount', 'totalApiTx', 'totalAmountReceived'];
    try {
        // Single batch query to get all counter doc IDs
        const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID,
            [Query.equal('id', counterNames), Query.limit(counterNames.length)]
        );
        for (const doc of list.documents) {
            const val = await redisClient.get(`counter:${doc.id}`);
            if (val === null) continue;
            await databases.updateDocument(
                APPWRITE_DATABASE_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID, doc.$id,
                { totals: Number(val) }
            );
        }
    } catch (e) {
        console.error('Failed to flush counters to Appwrite:', e);
    }
    redisClient.countersDirty = false;
}

// Init userMetaCache early so Appwrite fallback works even if Redis is down
userMetaCache.init({ redisClient, databases, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Query });
dashboardCounters.init({ APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID });

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
// Helper: race a promise against a timeout
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Authentication token is required.' });
        }

        // Create a new client instance for this specific request with the user's JWT
        const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);

        const account = new Account(userClient);
        const user = await withTimeout(account.get(), 9000, 'Appwrite account.get');

        // Query your users_meta collection by userId (user.$id) — cached in Redis
        let userMeta;
        try {
            userMeta = await withTimeout(userMetaCache.getUserMeta(user.$id), 8000, 'getUserMeta');
        } catch (metaErr) {
            console.error('User meta lookup failed for', user.$id, ':', metaErr.message);
            return res.status(503).json({ error: 'Service temporarily unavailable. Please retry.' });
        }

        if (!userMeta) {
            return res.status(404).json({ error: 'User metadata not found' });
        }

        // Attach the users_meta document to req.user
        req.user = userMeta;

        next();
    } catch (err) {
        console.error('JWT verification error:', err.message);
        if (err.message.includes('timed out')) {
            return res.status(504).json({ error: 'Authentication service timed out. Please retry.' });
        }
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
app.use('/api', qrCodeRoutes(APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee,roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/admin', adminRoutes(APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_DAILY_DELETED_SUMMARY_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID, APPWRITE_MANUAL_HOLD_COLLECTION_ID, APPWRITE_CONFIG_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient, emitTxnStatusNew));

// Admin routes use the admin authentication middleware
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_CONFIG_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Merchant API routes
app.use('/api/merchant', apiMerchantRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_API_MERCHANTS_COLLECTION_ID, APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Withdrawal Accounts routes
app.use('/api/withdrawal-accounts', withdrawalAccountsRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_WITHDRAWAL_ACCOUNTS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole));

// Wallet routes
app.use('/api/wallet', walletRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_WALLET_TRANSACTIONS_COLLECTION_ID, APPWRITE_WALLET_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole));

// Pinelabs QR routes
app.use('/pinelabs', digiqrRoutes);

function rupeesToPaiseStrict(rupees) {
  const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
  const frac = (fracPart + '00').slice(0, 2); // exactly 2 decimals
  return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

// GET /commission/totals — total commission earned per userId across all time
app.get('/commission/totals', async (_req, res) => {
    try {
        // Paginate through all commission transaction docs
        const PAGE_SIZE = 100;
        let allDocs = [];
        let lastId = null;

        while (true) {
            const queryFilters = [Query.limit(PAGE_SIZE), Query.orderAsc('$id')];
            if (lastId) queryFilters.push(Query.cursorAfter(lastId));

            const page = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
                queryFilters
            );

            allDocs = allDocs.concat(page.documents);
            if (page.documents.length < PAGE_SIZE) break;
            lastId = page.documents[page.documents.length - 1].$id;
        }

        // Group by userId — sum amount (paise) and track earningType
        const totals = {};
        for (const doc of allDocs) {
            const { userId, amount, earningType } = doc;
            if (!totals[userId]) {
                totals[userId] = { userId, earningType, totalAmountPaise: 0, totalAmountRs: 0, txCount: 0 };
            }
            totals[userId].totalAmountPaise += Number(amount || 0);
            totals[userId].txCount += 1;
        }

        // Convert paise → rupees for display
        for (const entry of Object.values(totals)) {
            entry.totalAmountRs = entry.totalAmountPaise / 100;
        }

        const result = Object.values(totals).sort((a, b) => b.totalAmountPaise - a.totalAmountPaise);

        // console.log('Commission totals by userId:', JSON.stringify(result, null, 2));

        return res.json({ count: result.length, totals: result });
    } catch (err) {
        console.error('Commission totals error:', err);
        return res.status(500).json({ error: 'Failed to compute commission totals' });
    }
});

// GET /commission/totals/monthly — commission per userId per month, built from raw tx docs
// Optional query params: ?userId=xxx  ?month=2026-03  ?earningType=admin|subadmin
app.get('/commission/totals/monthly', async (req, res) => {
    const { userId, month, earningType } = req.query;
    try {
        const PAGE_SIZE = 100;
        let allDocs = [];
        let lastId = null;

        while (true) {
            const queryFilters = [Query.limit(PAGE_SIZE), Query.orderAsc('$id')];
            if (lastId) queryFilters.push(Query.cursorAfter(lastId));
            if (userId) queryFilters.push(Query.equal('userId', userId));
            if (earningType) queryFilters.push(Query.equal('earningType', earningType));

            const page = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
                queryFilters
            );

            allDocs = allDocs.concat(page.documents);
            if (page.documents.length < PAGE_SIZE) break;
            lastId = page.documents[page.documents.length - 1].$id;
        }

        // Group by userId + month (derived from createdAt)
        const totals = {};
        for (const doc of allDocs) {
            const docMonth = moment.tz(doc.createdAt, 'Asia/Kolkata').format('YYYY-MM');
            if (month && docMonth !== month) continue;

            const key = `${doc.userId}__${docMonth}`;
            if (!totals[key]) {
                totals[key] = { userId: doc.userId, month: docMonth, earningType: doc.earningType, totalAmountPaise: 0, totalAmountRs: 0, txCount: 0 };
            }
            totals[key].totalAmountPaise += Number(doc.amount || 0);
            totals[key].txCount += 1;
        }

        for (const entry of Object.values(totals)) {
            entry.totalAmountRs = entry.totalAmountPaise / 100;
        }

        // Sort by month desc, then by amount desc
        const result = Object.values(totals).sort((a, b) =>
            b.month.localeCompare(a.month) || b.totalAmountPaise - a.totalAmountPaise
        );

        // console.log('Monthly commission totals:', JSON.stringify(result, null, 2));

        return res.json({ count: result.length, totals: result });
    } catch (err) {
        console.error('Monthly commission totals error:', err);
        return res.status(500).json({ error: 'Failed to compute monthly commission totals' });
    }
});

app.get('/get_daily_qr_summaries', async (req, res) => {

    const page = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                 [
                    // Query.equal('date', '2026-03-16'),
                    Query.contains('totalsJson', '"96199309"')
                 ]
            );

    return res.json({ page: page.length, totals: page });
});

app.get('/inc_test', async (req, res) => {
    const istDate = moment.tz(new Date(), 'Asia/Kolkata');
    const dayString = istDate.format('YYYY-MM-DD');
    const qr_code_id = "QR_09890";

    try {
        // Try to create the row first (optimistic insert).
        // If (qr_code_id, date) unique index is set in Appwrite, only one
        // concurrent "first insert" wins — all others hit the duplicate error
        // and fall through to the atomic increment below.
        try {
            await databases.createDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID,
                ID.unique(),
                {
                    qr_code_id: qr_code_id,
                    date: dayString,
                    total_pay_in_amount: 100,
                    transaction_count: 1,
                }
            );
        } catch (createErr) {
            // 409 = duplicate — row already exists, use atomic increment instead
            if (createErr?.code !== 409) throw createErr;

            const existingDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                    Query.equal('qr_code_id', qr_code_id),
                    Query.equal('date', dayString),
                    Query.limit(1),
                ]
            );

            const doc = existingDocs.documents[0];

            await tablesDB.incrementRowColumn(
                APPWRITE_DATABASE_ID,
                APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID,
                doc.$id,
                'total_pay_in_amount',
                100,
            );

            await tablesDB.incrementRowColumn(
                APPWRITE_DATABASE_ID,
                APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID,
                doc.$id,
                'transaction_count',
                1,
            );
        }

        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        console.error('/inc_test error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

function toInt(value) {
  return value ? parseInt(value, 10) : 0;
}

app.get("/api/get_app_config", async (req, res) => {
    try {
        await ConfigManager.refresh(); // Ensure we have the latest config
        const config = await ConfigManager.getConfig(databases);
        res.json({ success: true, config });
    } catch (err) {
        console.error("❌ Error fetching config:", err);
        res.status(500).json({ success: false, error: "Failed to fetch config" });
    }
});

// Rate limiter specifically for webhook endpoints
// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
app.use('/paytm/payment-sync', webhookLimiter);
// Endpoint to receive Paytm transaction

// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
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
    withRedisTimeout(Promise.all([
      redisClient.incrBy('counter:totalTxCount', 1),
      redisClient.incrBy('counter:totalApiTx', 1),
      redisClient.incrBy('counter:totalAmountReceived', amountPaise),
    ]), 3000).then(() => { redisClient.countersDirty = true; })
      .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed:', e?.message || e); });

    console.log("✅ Received Paytm transaction:", data);
    res.status(200).json({ message: "Transaction processed successfully" });

  } catch (err) {
    console.error("❌ Error processing transaction:", err?.message || err);
    res.status(500).json({ error: "Internal server error", details: err?.message });
  }
});

// GET last timestamp (per company)
// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
app.get("/paytm/last-timestamp-company", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({ error: "Missing company parameter" });
    }

    const keyName = `gmail_paytm_sync_timestamp_${company}`;

    await ConfigManager.refresh();
    const value = ConfigManager.get(keyName);

    if (value !== null) {
      console.log(`[${company}] Found timestamp:`, value);
      return res.json({ last_mail_timestamp: value });
    }

    console.log(`[${company}] No timestamp found, sending default`);
    return res.json({ last_mail_timestamp: 1764272304 });

  } catch (err) {
    console.error("GET timestamp error:", err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE last timestamp (per company)
// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
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
    const timestampInt = parseInt(last_mail_timestamp, 10);
    await ConfigManager.set(keyName, timestampInt);

    console.log(`[${company}] Timestamp saved → ${timestampInt}`);
    return res.json({ success: true, message: "Timestamp saved" });

  } catch (error) {
    console.error("POST timestamp error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to Send Paytm transaction last timestamp
// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
app.get("/paytm/last-timestamp", async (req, res) => {
  // const unixTimestamp = Math.floor(new Date(dateHeader).getTime() / 1000);

      await ConfigManager.refresh();
      const value = ConfigManager.get('gmail_paytm_sync_timestamp');

      if (value !== null) {
        console.log('Found timestamp:', value);
        return res.json({ last_mail_timestamp: value });
      }

      console.log('No timestampDoc key found');
      res.json({ last_mail_timestamp: "1764272304" });
});

// Endpoint to UPDATE the Paytm transaction timestamp
// NOT USING ENDPOINT NOW SO SKIP THIS CHECK FOR NOW 
app.post("/paytm/update-last-timestamp", async (req, res) => {
    try {
        // 1. Get the new timestamp from the request body
        const { last_mail_timestamp } = req.body;

        if (!last_mail_timestamp) {
            return res.status(400).json({ error: "Missing last_mail_timestamp in body" });
        }

        const timestampInt = parseInt(last_mail_timestamp, 10);
        await ConfigManager.set('gmail_paytm_sync_timestamp', timestampInt);

        console.log(`Updated timestamp to: ${timestampInt}`);
        return res.json({ success: true, message: "Timestamp updated" });

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
// PABESTO TECH PVT LTD. RAZORPAY WEBHOOK HANDLER — FULLY PRODUCTION-READY WITH IDEMPOTENCY, LOCKING, AND REAL-TIME EMIT
app.post('/razorpay-webhook', webhookParser, async (req, res) => {

    const data = req.body;

    if (LOG_RAZORPAY_WEBHOOK) console.log("📩 Razorpay Webhook Received /razorpay-webhook:", JSON.stringify(data, null, 2));

    // STEP 1: validate status field
    if (data?.status !== 'AUTHORIZED') {
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

    if (!qrCodeId)    { return res.status(400).send('QR Code ID not found'); }
    if (!paymentId)   { return res.status(400).send('Payment ID not found'); }
    if (!amountPaise) { return res.status(400).send('Amount not found'); }

    // Acquire per-QR distributed lock FIRST — same pattern as /webhook.
    // Serializes idempotency check + doc creation + QR update for the same QR code,
    // preventing duplicate writes when concurrent requests carry the same paymentId.
    const lockKey = `lock:qr:${qrCodeId}`;
    const acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
    if (!acquired) {
        return res.status(503).send('Processing conflict, retry');
    }

    try {
        // STEP 3: idempotency check — under lock, so no TOCTOU with concurrent same-paymentId requests
        const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            [Query.equal('paymentId', paymentId), Query.limit(1)]
        );
        if (existing.documents.length) {
            return res.status(200).send('Duplicate webhook ignored');
        }

        // STEP 4: save raw webhook record (source of truth) — under lock
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
        // STEP 7: update QR totals — under lock so no concurrent reads on same QR doc
        await updateQrTotalAtomic(qrCodeId, amountPaise);

        // STEP 8: atomic Redis counter increments (non-critical, outside lock scope is fine)
        withRedisTimeout(Promise.all([
            redisClient.incrBy('counter:totalTxCount', 1),
            redisClient.incrBy('counter:totalApiTx', 1),
            redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]), 3000).then(() => { redisClient.countersDirty = true; })
          .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed:', e?.message || e); });

        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to process razorpay-webhook:', error.message);
        res.status(500).send('Error processing webhook');
    } finally {
        await releaseLock(lockKey, paymentId);
    }
});

// --- Webhook Endpoint ---
// Secret:   4@cQVD6GBGa2G7j
// BEAST ARENA PVT LTD. RAZORPAY WEBHOOK HANDLER — MAIN ENTRY POINT FOR RAZORPAY QR CODE PAYMENTS
app.post('/webhook', async (req, res) => {

    //   console.log('Webhook Event Received at /webhook:', { ip: req.ip });

    if (LOG_RAZORPAY_WEBHOOK) console.log("📩 Razorpay Webhook Received /razorpay-webhook:", JSON.stringify(data, null, 2));

    // 1. Verify Razorpay signature
    // const razorpaySignature = req.headers['x-razorpay-signature'];
    // if (!razorpaySignature) {
    //     return res.status(400).send('Missing Razorpay signature');
    // }

    // if (!req.rawBody) {
    //     return res.status(400).send('Missing raw body for signature verification');
    // }

    // const expectedSignature = crypto
    //     .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    //     .update(req.rawBody)
    //     .digest('hex');

    // if (expectedSignature !== razorpaySignature) {
    //     console.warn('❌ Webhook signature mismatch!');
    //     return res.status(400).send('Invalid signature');
    // }

    // 2. Filter event type
    const eventType = req.body?.event;
    if (eventType !== 'qr_code.credited') {
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

    if (!qrCodeId)    { return res.status(400).send('QR Code ID not found'); }
    if (!paymentId)   { return res.status(400).send('Payment ID not found'); }
    if (!amountPaise) { return res.status(400).send('Amount not found'); }

    // Acquire per-QR distributed lock FIRST — same pattern as /razorpay-webhook.
    // Serializes idempotency check + doc creation + QR update for the same QR code,
    // preventing duplicate writes when concurrent requests carry the same paymentId.
    const lockKey = `lock:qr:${qrCodeId}`;
    const acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
    if (!acquired) {
        console.warn(`Lock busy for QR ${qrCodeId}, payment ${paymentId} — Razorpay will retry`);
        return res.status(503).send('Processing conflict, retry');
    }

    try {
        // 4. Idempotency check — under lock, so no TOCTOU with concurrent same-paymentId requests
        const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            [Query.equal('paymentId', paymentId), Query.limit(1)]
        );
        if (existing.total > 0) {
            console.log('Duplicate webhook, ignoring:', paymentId);
            return res.status(200).send('Already processed');
        }

        // 5. Save raw webhook record (source of truth) — under lock
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

        // 6. Update daily QR summary
        try {
            await updateDailyQrTotal(qrCodeId, isoDate, amountPaise);
        } catch (e) {
            console.error('❌ Error updating daily QR total:', e?.message || e);
        }

        // 7. Emit real-time event
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
        emitTxnNew({ assignedUserId: '', qrCodeId, payload: eventPayload });

        // 8. Update QR totals — under lock so no concurrent reads on same QR doc
        await updateQrTotalAtomic(qrCodeId, amountPaise);

        // 9. Atomic Redis counter increments (non-critical)
        await Promise.all([
            redisClient.incrBy('counter:totalTxCount', 1),
            redisClient.incrBy('counter:totalApiTx', 1),
            redisClient.incrBy('counter:totalAmountReceived', amountPaise),
        ]).then(() => { redisClient.countersDirty = true; })
          .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed:', e); });

        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to process webhook:', error.message);
        res.status(500).send('Error processing webhook');
    } finally {
        await releaseLock(lockKey, paymentId);
    }
});

async function updateDailyQrTotal(qrCodeId, txnDate, amountDelta) {
  // Convert txnDate to IST date string "YYYY-MM-DD"
  const istDate = moment.tz(txnDate, 'Asia/Kolkata');
  const dayString = istDate.format('YYYY-MM-DD');

  // Per-day Redis lock: serializes ALL concurrent writes to the same daily JSON document.
  // Without this, two payments for different QR codes arriving at the same time both read
  // the same totalsJson, compute independent updates, and one silently overwrites the other.
  const dailyLockKey = `lock:daily:${dayString}`;
  const dailyLockVal = `${qrCodeId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  let dailyLockAcquired = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    dailyLockAcquired = await acquireLock(dailyLockKey, dailyLockVal, 10); // 10s TTL
    if (dailyLockAcquired) break;
    await new Promise(r => setTimeout(r, 50 + attempt * 40)); // ~50–410ms backoff
  }
  if (!dailyLockAcquired) {
    throw new Error(`updateDailyQrTotal: could not acquire daily lock for ${dayString} after 10 retries`);
  }

  try {
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
      // Document exists — parse JSON string and update totals object
      const doc = existingDocs.documents[0];
      const totalsJsonStr = doc.totalsJson || '{}';

      let totalsObj;
      try {
        totalsObj = JSON.parse(totalsJsonStr);
      } catch (e) {
        console.error('CORRUPT totalsJson for doc', doc.$id, '— aborting to prevent data loss');
        throw new Error('Daily summary JSON is corrupted — manual fix required');
      }

      const oldAmount = Number(totalsObj[qrCodeId] || 0);
      const newAmount = oldAmount + amountDelta;

      if (newAmount < 0) {
        throw new Error('Total amount cannot be negative');
      }

      totalsObj[qrCodeId] = newAmount;

      await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
        doc.$id,
        { totalsJson: JSON.stringify(totalsObj) }
      );
    } else {
      // No document for this day yet — create it
      await databases.createDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
        ID.unique(),
        {
          date: dayString,
          totalsJson: JSON.stringify({ [qrCodeId]: amountDelta }),
        }
      );
    }
  } finally {
    await releaseLock(dailyLockKey, dailyLockVal);
  }
}

// ─── PineLabs transaction poller ─────────────────────────────────────────────
// Mirrors the Razorpay /webhook pipeline for PineLabs: periodically pulls
// SUCCESS transactions and persists them with dedup, QR totals, daily summary,
// socket emit, and dashboard counters. TID is used as the QR doc's qrId.
const { startPinelabPoller } = require('./pinelabPoller');

const ENABLE_PINELAB_POLLER = false;

const pinelabPoller = ENABLE_PINELAB_POLLER
  ? startPinelabPoller(
      {
        databases,
        Query,
        ID,
        redisClient,
        acquireLock,
        releaseLock,
        emitTxnNew,
        updateDailyQrTotal,
        APPWRITE_DATABASE_ID,
        APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        APPWRITE_QRCODE_COLLECTION_ID,
        LOCK_TTL_SECONDS,
      },
      {
        env: 'production',
        intervalMs: 1 * 60 * 1000,
        bufferMinutes: 5,        // small guard against micro-delays (txn anchor is ground truth)
        maxLookbackMinutes: 60,  // ceiling on window size during quiet periods
        pageSize: 100,
        maxPagesPerTick: 50,
        dryRun: false,
      }
    )
  : null;

// Admin-only: trigger a manual PineLabs poll. Omit from/to to run with the
// normal watermark window; pass both for an explicit backfill window.
// Body: { from?: ISOString, to?: ISOString }
app.post('/admin/pinelabs/poll', authenticateAdmin, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if ((from && !to) || (!from && to)) {
      return res.status(400).json({ error: 'Provide both from and to, or neither' });
    }
    if (!pinelabPoller) {
      return res.status(503).json({ error: 'PineLabs poller is disabled' });
    }
    const result = await pinelabPoller.runOnce({ from, to });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/pinelabs/poll] error:', e);
    res.status(500).json({ error: e.message || 'poll failed' });
  }
});

// Admin-only: read poller health/metrics from Redis
app.get('/admin/pinelabs/status', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'pinelabs:poller:latestTxnAt',
      'pinelabs:poller:lastRunAt',
      'pinelabs:poller:lastTxnsSeen',
      'pinelabs:poller:lastTxnsSaved',
      'pinelabs:poller:lastDurationMs',
      'pinelabs:poller:consecutiveFailures',
      'pinelabs:poller:lastError',
    ];
    const values = await Promise.all(keys.map(k => redisClient.get(k).catch(() => null)));
    const out = {};
    keys.forEach((k, i) => { out[k.replace('pinelabs:poller:', '')] = values[i]; });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || 'status failed' });
  }
});

// Root endpoint for testing
app.get('/', (req, res) => {
    res.send('KitePay API is running!');
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
    try { pinelabPoller?.stop(); } catch (e) { console.error('Error stopping PineLabs poller:', e); }
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
