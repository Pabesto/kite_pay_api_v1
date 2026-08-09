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
const qrOwnerCache = require('./qrOwnerCache');
const reviewMode = require('./reviewMode'); // in-memory manual-review-mode registry (single-process)
const dashboardCounters = require('./dashboardCounters');
const partnerApiRoutes = require('./partnerApi');
const partnerWebhooks = require('./partnerWebhooks');

const fs = require('fs');
const path = require('path');

// --- Configuration & Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy (Render/Nginx) that sets X-Forwarded-For. Trust exactly ONE
// proxy hop so express-rate-limit keys on the real client IP — not the proxy, and not a
// spoofable header (which `trust proxy: true` would allow). Override via TRUST_PROXY if
// your infra has a different number of proxies in front.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

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
const APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID = process.env.APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID;
// Manual-review feature: rejected transactions log + daily rejected rollup (defaults match setup-review-schema.js)
const APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID = process.env.APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID;
const APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID = process.env.APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID;
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
const APPWRITE_API_PARTNERS_COLLECTION_ID = process.env.APPWRITE_API_PARTNERS_COLLECTION_ID;
const APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID = process.env.APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID;
const APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID = process.env.APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID;
const APPWRITE_CONFIG_COLLECTION_ID = process.env.APPWRITE_CONFIG_COLLECTION_ID;
const APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID = process.env.APPWRITE_TEST_DAILY_QR_SUMMARIES_COLLECTION_ID;
// PineLabs merchant credentials (default matches setup-pinelab-accounts-schema.js).
// Secret-bearing collection — server API key only, never exposed to client SDKs.
const APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID = process.env.APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID || 'pinelab_accounts';
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;

// Razorpay webhook secret (from dashboard → Settings → Webhooks)
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// Set LOG_RAZORPAY_WEBHOOK=false in .env to silence the full webhook payload log.
const LOG_RAZORPAY_WEBHOOK = String(process.env.LOG_RAZORPAY_WEBHOOK ?? 'true').toLowerCase() !== 'false';

const { httpServer, emitTxnNew, emitQrAlert, emitForceRefresh, emitTxnStatusNew, emitPendingReview, emitReviewResolved } = initSocket(app, {
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
    { name: 'Daily flagged summary',     id: APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID },
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
const GRACEFUL_SHUTDOWN_MS  = 15_000; // max ms to wait for in-flight requests on shutdown (includes DRAIN_MS)
const DRAIN_MS              = 5_000;  // how long /health reports 503 before we stop accepting connections
// ─────────────────────────────────────────────────────────────────────────────

// Flipped by gracefulShutdown so /health can report 503 while draining. Providers
// retry on 503 (same contract as lock contention), so a webhook that arrives during
// a deploy is retried rather than lost to a connection-refused.
let isShuttingDown = false;

console.log(`Server starting with Appwrite endpoint ${APPWRITE_ENDPOINT} and Redis URL ${process.env.REDIS_URL}`);

// ─── Redis Client ────────────────────────────────────────────────────────────
const redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
});
// REQUIRED — do not remove. Without an 'error' listener, node-redis re-throws 'error'
// events as uncaught exceptions and the process exits. During a Redis outage these fire
// continuously, which would crash-loop this payment-critical server. This listener keeps
// the app alive; it already degrades to Appwrite / in-memory fallbacks while Redis is down.
redisClient.on('error', (e) => console.error('Redis error:', e?.message || e));
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

// ─────────────────────────────────────────────────────────────────────────────-

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

// calucateQrs();

// import { Query } from 'appwrite'; // Make sure to import Query

// const txns = await fetchAllTransactions();

// fetchAllTransactions().then((txns) => {
//     console.log(`Successfully fetched ${txns.length} transactions.`);
// });

async function fetchAllTransactions() {
    let allTxns = [];
    let lastId = null;
    let hasMore = true;

    // const qrIds = ['9620580800', '9620580700', '9620580900', '9620580600'];  // RUVI QR codes

    // const qrIds = ['0096206465', '0096206464', '0096206463', '0096206462', '0096206461', '0096206460', '0096206459',
    //     '0096206458', '0096206457', '0096206456', '0096206455', '0096206454', '0096206453'];  // NICE QR codes

    const qrIds = [ '0096206459','0096206458', '0096206457', '0096206456', '0096206455', '0096206454', '0096206453'];  // NICE QR codes


    while (hasMore) {
        console.log(`Fetching transactions batch after ID: ${lastId || 'start'}`);

        // Rebuild queries array freshly on every iteration to avoid cursor accumulation
        const queries = [
            Query.limit(100), 
            Query.equal('qrCodeId', qrIds) 
        ];

        // Only add the cursor if we actually have a previous page's last ID
        if (lastId) {
            queries.push(Query.cursorAfter(lastId));
        }

        // Make the API call
        const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            queries
        );

        // Add the fetched documents to our main array
        allTxns = allTxns.concat(response.documents);

        // Check if there are more documents to fetch
        if (response.documents.length < 100) {
            hasMore = false; // Reached the end
        } else {
            // Update the lastId to the last document in the current batch
            lastId = response.documents[response.documents.length - 1].$id;
        }
    }

    // --- Data Processing & Aggregation ---
    const vpaSummary = {};

    allTxns.forEach(txn => {
        const vpa = txn.vpa;
        const amount = Number(txn.amount) || 0; 

        if (!vpaSummary[vpa]) {
            vpaSummary[vpa] = {
                totalAmount: 0,
                txnCount: 0
            };
        }

        vpaSummary[vpa].totalAmount += amount;
        vpaSummary[vpa].txnCount += 1;
    });

    // Convert object to an array and sort by totalAmount descending
    const sortedVpaArray = Object.entries(vpaSummary).sort((a, b) => {
        return b[1].totalAmount - a[1].totalAmount;
    });

    console.log(sortedVpaArray);

    // --- File Generation ---
    let fileContent = "VPA SUMMARY REPORT (Sorted by Total Amount - Descending)\n";
    fileContent += "============================================================\n\n";

    sortedVpaArray.forEach(([vpa, data], index) => {
        const amount = (Number(data.totalAmount) || 0) / 100; // (/100 assumed for Paise to INR conversion)
        fileContent += `${index + 1}. VPA: ${vpa}\n`;
        fileContent += `   Total Transactions: ${data.txnCount}\n`;
        fileContent += `   Total Amount: ${amount.toFixed(2)}\n`; // Added .toFixed(2) for clean currency formatting
        fileContent += "------------------------------------------------------------\n";
    });

    try {
        const filePath = path.join(process.cwd(), 'vpa_report_nice.txt');
        fs.writeFileSync(filePath, fileContent, 'utf8');
        console.log(`✅ File successfully saved to: ${filePath}`);
    } catch (error) {
        console.error("❌ Error writing the file:", error);
    }

    return allTxns;
}

// fetchAllManualHolds().then((txns) => {
//     console.log(`Successfully fetched ${txns.length} Manual Holds.`);
// });

async function fetchAllManualHolds(baseQueries = []) {
    let allDocuments = [];
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
        // 1. Clone your existing queries array and append the limit
        baseQueries.push(Query.greaterThan('newAvailable', 0));
        const currentQueries = [...baseQueries, Query.limit(100)];
        
        // 2. If we have a cursor from the previous batch, look AFTER it
        if (lastId) {
            currentQueries.push(Query.cursorAfter(lastId));
        }

        const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID, 
            APPWRITE_MANUAL_HOLD_COLLECTION_ID, 
            currentQueries
        );

        // 3. Push the current batch into our main array
        allDocuments.push(...result.documents);

        // 4. Check if we need to keep fetching
        if (result.documents.length < 100) {
            hasMore = false; // We reached the end
        } else {
            // Set the cursor to the ID of the last document in this batch
            lastId = result.documents[result.documents.length - 1].$id;
        }

        // Print final raw data metrics
        console.log(`\n--- FETCH COMPLETE ---`);
        console.log(`Total database documents fetched from Appwrite: ${allDocuments.length}`);

    }

    // 5. Map the full list of accumulated records
    const records = allDocuments.map(doc => ({
        $id: doc.$id,
        qrId: doc.qrId,
        assignedUserId: doc.assignedUserId,
        action: doc.action,
        amountPaise: doc.amountPaise,
        previousHold: doc.previousHold,
        newHold: doc.newHold,
        newAvailable: doc.newAvailable,
        reason: doc.reason,
        adminId: doc.adminId,
        adminName: doc.adminName,
        createdAt: doc.createdAt,
    }));

    // 6. Filter for records where newAvailable > 0
    const positiveAvailableRecords = records.filter(record => record.newAvailable > 0);

    // 7. Log the count and the matching records
    console.log(`Total records with newAvailable > 0: ${positiveAvailableRecords.length}`);
    // console.log("Matching Records:", positiveAvailableRecords);

    // Turn the records array into readable, indented text
    const fileOutputText = JSON.stringify(positiveAvailableRecords, null, 4);
    
    // Save locally to your environment
    fs.writeFileSync('positive_available_records.txt', fileOutputText, 'utf-8');
    
    console.log(`Saved ${positiveAvailableRecords.length} records to positive_available_records.txt`);
    
    // Optional: Return the filtered records if you need them outside this function
    return positiveAvailableRecords;
}

// // Usage:
// console.log(`Successfully fetched ${txns.length} transactions.`);

// calucateQrs();

async function calucateQrs() {
    let allDocs = [];
        let offset = 0;
        const limit = 100;

        while (true) {
            const response = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                [
                    // Query.isNotNull('assignedUserId'),
                    Query.limit(limit),
                    Query.offset(offset)
                ]
            );

            allDocs.push(...response.documents);

            if (response.documents.length < limit) {
                break;
            }

            offset += limit;
        }

        withdrawalApprovedAmount = 0;
        commissionPaid = 0;
        totalPayInAmount = 0;
        AmountOnHold = 0;

        for (const qr of allDocs) {

            // if(qr.isActive === false) {
            //     continue; // skip inactive QRs
            // }

            withdrawalApprovedAmount += Number(qr.withdrawalApprovedAmount || 0);
            commissionPaid += Number(qr.commissionPaid || 0);
            totalPayInAmount += Number(qr.totalPayInAmount || 0);
            AmountOnHold += Number(qr.amountOnHold || 0);
        }

        console.log('Total active QR codes with assignedUserId:', allDocs.length);
        console.log('Total approved withdrawal amount across all QRs:', withdrawalApprovedAmount);
        console.log('Total commission paid across all QRs:', commissionPaid);
        console.log('Total amount on hold across all QRs:', AmountOnHold);
        console.log('Total pay-in amount across all QRs:', totalPayInAmount);

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

// Init qrOwnerCache — maps each QR code to the single subadmin who owns it, so every
// transaction can be stamped with `ownerSubadminId` at write time and partners can
// fetch their transactions with a single indexed query.
qrOwnerCache.init({ databases, Query, APPWRITE_DATABASE_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_USERS_META_COLLECTION_ID });
const QR_OWNER_REFRESH_MS = Number(process.env.QR_OWNER_REFRESH_MS) || 10 * 60 * 1000; // 10 min
(async () => {
    try {
        await qrOwnerCache.buildAll();
        setInterval(() => { qrOwnerCache.refresh().catch(e => console.error('qrOwnerCache refresh failed:', e.message)); }, QR_OWNER_REFRESH_MS);
    } catch (e) {
        console.error('qrOwnerCache initial build failed — will self-heal lazily:', e.message);
    }
})();

// Init the outbound partner-webhook system: build the enabled-partner index and start the
// retry worker that redelivers failed webhooks with exponential backoff.
partnerWebhooks.init({ databases, Query, ID, APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID, APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID });
const PARTNER_WEBHOOK_INDEX_REFRESH_MS = Number(process.env.PARTNER_WEBHOOK_INDEX_REFRESH_MS) || 10 * 60 * 1000;
const PARTNER_WEBHOOK_WORKER_MS = Number(process.env.PARTNER_WEBHOOK_WORKER_MS) || 60 * 1000;
const PARTNER_WEBHOOK_SUCCESS_RETENTION_DAYS = Number(process.env.PARTNER_WEBHOOK_SUCCESS_RETENTION_DAYS) || 30;
const PARTNER_WEBHOOK_DEAD_RETENTION_DAYS = Number(process.env.PARTNER_WEBHOOK_DEAD_RETENTION_DAYS) || 90;
(async () => {
    try {
        await partnerWebhooks.reloadIndex();
        setInterval(() => { partnerWebhooks.reloadIndex().catch(e => console.error('partnerWebhooks index refresh failed:', e.message)); }, PARTNER_WEBHOOK_INDEX_REFRESH_MS);
        partnerWebhooks.startWorker(PARTNER_WEBHOOK_WORKER_MS);

        // Prune old terminal deliveries daily so the log stays bounded (not infinite growth).
        const runPrune = () => partnerWebhooks.pruneOld({
            successDays: PARTNER_WEBHOOK_SUCCESS_RETENTION_DAYS,
            deadDays: PARTNER_WEBHOOK_DEAD_RETENTION_DAYS,
        }).catch(e => console.error('partnerWebhooks prune failed:', e.message));
        setInterval(runPrune, 24 * 60 * 60 * 1000);
        setTimeout(runPrune, 60 * 1000); // once, shortly after boot
    } catch (e) {
        console.error('partnerWebhooks init failed:', e.message);
    }
})();

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

// Redis availability watchdog.
// node-redis auto-reconnects after a connection DROPS, but not when the INITIAL connect
// failed (Redis was down at boot) or the client fully closed. This periodic check retries
// connect() in that case. While Redis is down, all cache callers (userMetaCache, etc.)
// already fall through to Appwrite via their `isReady` guards; once this reconnects, they
// transparently resume using Redis on their next call — nothing else to toggle.
const REDIS_RECONNECT_CHECK_MS = Number(process.env.REDIS_RECONNECT_CHECK_MS) || 5 * 60 * 1000;
let _redisReconnecting = false;
setInterval(async () => {
    if (redisClient.isOpen || _redisReconnecting) return; // already connected / connecting
    _redisReconnecting = true;
    try {
        await redisClient.connect();
        console.log('Redis reconnected — cache re-enabled');
        await syncCountersFromAppwrite(); // reseed counters from source of truth
    } catch (e) {
        console.error('Redis reconnect attempt failed — staying on Appwrite direct:', e.message);
    } finally {
        _redisReconnecting = false;
    }
}, REDIS_RECONNECT_CHECK_MS);
// ─────────────────────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  // Never throttle the liveness probe — a 429 would read as "unhealthy" to Render
  // and restart a service whose only problem is that it is busy.
  skip: (req) => req.path === '/health',
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

// Centralized "increment everywhere" finalize pipeline — extracted to its own module
// (transactionFinalize.js) so it is unit-testable in isolation and reusable from
// admin.js (the manual-review approve path). Built here — BEFORE the route mounts
// below — so it can be passed into adminRoutes(). updateQrTotalAtomic /
// updateDailyQrTotal are hoisted function declarations, so referencing them is safe.
const finalizeTransaction = require('./transactionFinalize')({
    updateQrTotalAtomic,
    updateDailyQrTotal,
    emitTxnNew,
    partnerWebhooks,
    withRedisTimeout,
    redisClient,
});

// Pass Appwrite and authentication dependencies to the route handlers
// QR code routes use the admin authentication middleware
app.use('/api', qrCodeRoutes(APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee,roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/admin', adminRoutes(APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_DAILY_DELETED_SUMMARY_COLLECTION_ID, APPWRITE_DAILY_FLAGGED_SUMMARY_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_DASHBOARD_COUNTERS_COLLECTION_ID, APPWRITE_MANUAL_HOLD_COLLECTION_ID, APPWRITE_CONFIG_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient, emitTxnStatusNew, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, finalizeTransaction, APPWRITE_REJECTED_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_REJECTED_SUMMARY_COLLECTION_ID, emitReviewResolved));

// Admin routes use the admin authentication middleware
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_CONFIG_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Merchant API routes
app.use('/api/merchant', apiMerchantRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, APPWRITE_API_MERCHANTS_COLLECTION_ID, APPWRITE_API_MERCHANTS_REQUESTS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient));

// Partner API routes — external systems fetch the transactions under their subadmin
app.use('/api/partner', partnerApiRoutes(databases, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_API_PARTNERS_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_PARTNER_WEBHOOK_DELIVERIES_COLLECTION_ID, authenticateAdmin));

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

// Liveness probe — this is the path Render polls.
// Deliberately checks NOTHING but the process itself. Redis and Appwrite are
// optional-at-runtime (every feature degrades without them), so reporting them here
// would let a transient dependency blip restart a healthy single-instance payments
// process mid-webhook. Dependency detail belongs in /health/deep.
app.get('/health', (req, res) => {
    // 503 while draining so Render stops routing and providers retry their webhooks.
    if (isShuttingDown) return res.status(503).json({ status: 'shutting_down' });
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Diagnostics — admin only, and NOT the Render health path.
// Always returns 200 even when a dependency is down: the body carries the detail.
// A non-200 here would tempt someone to point Render at it and reintroduce exactly
// the spurious-restart hazard /health avoids.
app.get('/health/deep', authenticateAdmin, async (req, res) => {
    let appwriteReachable = false;
    let appwriteError = null;
    try {
        await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, [Query.limit(1)]);
        appwriteReachable = true;
    } catch (e) {
        appwriteError = e?.message || String(e);
    }

    const mem = process.memoryUsage();
    return res.status(200).json({
        success: true,
        status: isShuttingDown ? 'shutting_down' : 'ok',
        shuttingDown: isShuttingDown,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: {
            rss: Math.round(mem.rss / 1048576),
            heapUsed: Math.round(mem.heapUsed / 1048576),
        },
        redis: {
            // Never report the connection URL — it carries credentials.
            connected: !!redisClient?.isOpen,
            countersDirty: !!redisClient?.countersDirty,
            countersStale: !!redisClient?.countersStale,
        },
        appwrite: { reachable: appwriteReachable, error: appwriteError },
        pinelabs: {
            enabled: !!pinelabPoller,
            accountIds: pinelabPoller?.accountIds || [],   // ids only, never credentials
        },
        timestamp: new Date().toISOString(),
    });
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
                return null;
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
            return qrDoc; // SUCCESS — return the QR doc so callers can emit to the assigned user

        } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) {
                console.error(`❌ QR ${qrCodeId} failed after ${attempts} attempts`);
                return null;
            }
            // 50ms backoff (proven safe)
            await new Promise(r => setTimeout(r, 50));
        }
    }
}

// Look up a QR's direct assignedUserId (the operator user). Used only by the review
// gate, and only when a 'user'-scope manual window is active, so it stays off the
// normal auto hot path. Returns the userId or null.
async function resolveAssignedUserId(qrCodeId) {
    try {
        const r = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_QRCODE_COLLECTION_ID,
            [Query.equal('qrId', qrCodeId), Query.limit(1)]
        );
        return r.documents[0]?.assignedUserId || null;
    } catch (e) {
        console.error('resolveAssignedUserId error:', e?.message || e);
        return null;
    }
}

// Resolve the owner ids the review gate should match a 'user'-scope window against:
// always the managing subadmin (ownerSubadminId, cached/free), plus the QR's direct
// assignedUserId when — and only when — a user-scope window is active.
async function resolveReviewOwners(qrCodeId) {
    const ownerSubadminId = await qrOwnerCache.resolve(qrCodeId);
    const ownerIds = ownerSubadminId ? [ownerSubadminId] : [];
    if (reviewMode.hasActiveUserWindows()) {
        const assignedUserId = await resolveAssignedUserId(qrCodeId);
        if (assignedUserId && assignedUserId !== ownerSubadminId) ownerIds.push(assignedUserId);
    }
    return { ownerSubadminId, ownerIds };
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

app.post('/webhook-print', webhookParser, async (req, res) => {

    const data = req.body;

    // if (LOG_RAZORPAY_WEBHOOK) 
    console.log("📩 Webhook Received /webhook-print:", JSON.stringify(data, null, 2));
    return res.status(200).send('Webhook received');
    
});

// Main For Pabesto Tech PVT Ltd. Razorpay Webhook Handler
// PABESTO TECH PVT LTD. RAZORPAY WEBHOOK HANDLER — FULLY PRODUCTION-READY WITH IDEMPOTENCY, LOCKING, AND REAL-TIME EMIT
app.post('/razorpay-webhook', webhookParser, async (req, res) => {

    const data = req.body;

    // if (LOG_RAZORPAY_WEBHOOK) console.log("📩 Razorpay Webhook Received /razorpay-webhook:", JSON.stringify(data, null, 2));

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

        // Review gate: hold for admin review if a manual window covers this txn, else finalize now.
        // 'user'-scope matches the QR's managing subadmin OR its direct assignedUserId.
        const { ownerSubadminId, ownerIds } = await resolveReviewOwners(qrCodeId);
        const reviewWindowMs = Number(ConfigManager.get('txn_review_window_ms', 10000)) || 10000;
        const { manual, fields: reviewFields } = reviewMode.reviewFieldsFor(qrCodeId, ownerIds, amountPaise, reviewWindowMs);

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
                ownerSubadminId,
                ...reviewFields,
            }
        );

        if (manual) {
            // HELD for admin review — no increments. Notify admins; resolution (approve/reject/timeout) comes later.
            // console.log(`[ReviewMode] HELD pending ${created.$id} qr=${qrCodeId} amount=${amountPaise} until=${reviewFields.reviewExpiresAt}`);
            emitPendingReview({
                $id: created.$id,
                qrCodeId,
                paymentId,
                amount: amountPaise,
                provider: created.provider,
                vpa,
                rrnNumber,
                created_at: isoDate,
                reviewExpiresAt: reviewFields.reviewExpiresAt,
                ownerSubadminId,
            });
        } else {
            // STEPS 5–8: centralized finalize — daily total, QR totals, emit, partner webhook, counters
            await finalizeTransaction(created, {
                emitPayload: {
                    $id:        created.$id,
                    qrCodeId,
                    paymentId,
                    amount:     amountPaise,
                    rrnNumber,
                    vpa,
                    provider:   'razorpay',
                    created_at: new Date(isoDate).toISOString(),
                },
            });
        }

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

    //console.log('Webhook Event Received at /webhook:', { ip: req.ip });

    const data = req.body;

    // if (LOG_RAZORPAY_WEBHOOK) console.log("📩 Razorpay Webhook Received /razorpay-webhook:", JSON.stringify(data, null, 2));

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

        // Review gate: hold for admin review if a manual window covers this txn, else finalize now.
        // 'user'-scope matches the QR's managing subadmin OR its direct assignedUserId.
        const { ownerSubadminId, ownerIds } = await resolveReviewOwners(qrCodeId);
        const reviewWindowMs = Number(ConfigManager.get('txn_review_window_ms', 10000)) || 10000;
        const { manual, fields: reviewFields } = reviewMode.reviewFieldsFor(qrCodeId, ownerIds, amountPaise, reviewWindowMs);

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
                ownerSubadminId,
                ...reviewFields,
            }
        );

        if (manual) {
            // HELD for admin review — no increments. Notify admins; resolution (approve/reject/timeout) comes later.
            // console.log(`[ReviewMode] HELD pending ${created.$id} qr=${qrCodeId} amount=${amountPaise} until=${reviewFields.reviewExpiresAt}`);
            emitPendingReview({
                $id: created.$id,
                qrCodeId,
                paymentId,
                amount: amountPaise,
                provider: created.provider,
                vpa,
                rrnNumber,
                created_at: isoDate,
                reviewExpiresAt: reviewFields.reviewExpiresAt,
                ownerSubadminId,
            });
        } else {
            // 6–9. Centralized finalize — daily total, QR totals, emit, partner webhook, counters
            await finalizeTransaction(created, {
                emitPayload: {
                    $id: created.$id,
                    qrCodeId,
                    paymentId,
                    amount: amountPaise,
                    rrnNumber: rrnNumber || null,
                    vpa: vpa || null,
                    provider: 'razorpay',
                    created_at: isoDate,
                },
            });
        }

        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to process webhook:', error.message);
        res.status(500).send('Error processing webhook');
    } finally {
        await releaseLock(lockKey, paymentId);
    }
});

// UNIFIED WEBHOOK — accepts both payload shapes that /razorpay-webhook (Ezetap flat)
// and /webhook (Razorpay nested qr_code.credited) handle, normalizes them, and runs
// the same downstream pipeline. Auto-detects shape from the body; no caller change
// required. The two legacy endpoints above remain functional.
app.post('/payment-webhook', webhookParser, async (req, res) => {

    const body = req.body || {};

    // STEP 1: detect payload shape and extract normalized fields
    let qrCodeId, paymentId, rrnNumber, amountPaise, vpa, isoDate, shape;

    if (body.event === 'qr_code.credited') {
        // Razorpay nested shape (mirrors /webhook)
        shape = 'razorpay-nested';
        const paymentEntity = body?.payload?.payment?.entity;
        // Use notes.username as the QR identifier (payment-level first, qr_code-level fallback)
        qrCodeId  = paymentEntity?.notes?.username
                 || body?.payload?.qr_code?.entity?.notes?.username;
        paymentId = paymentEntity?.id;
        rrnNumber = paymentEntity?.acquirer_data?.rrn || null;
        amountPaise = paymentEntity?.amount; // already paise
        vpa = paymentEntity?.vpa || null;
        const unixTimestamp = paymentEntity?.created_at;
        if (unixTimestamp) {
            isoDate = new Date(unixTimestamp * 1000).toISOString();
        }
    } else if (body.status === 'AUTHORIZED' && body.tid) {
        // Ezetap/Pabesto flat shape (mirrors /razorpay-webhook)
        shape = 'ezetap-flat';
        qrCodeId  = body.tid;
        paymentId = body.Id;
        rrnNumber = body.rrNumber || null;
        amountPaise = rupeesToPaiseStrict(body.amount);
        vpa = body.customerName || null;
        if (body.postingDate) {
            isoDate = new Date(body.postingDate).toISOString();
        }
    } else {
        // Neither shape matched — reject without locking or writing anything
        if (body.event && body.event !== 'qr_code.credited') {
            return res.status(400).send('Unsupported event type');
        }
        if (body.status && body.status !== 'AUTHORIZED') {
            return res.status(400).send('Payment not authorized: ' + body.status);
        }
        return res.status(400).send('Unrecognized webhook payload');
    }

    // STEP 2: validate required normalized fields
    if (!qrCodeId)    { return res.status(400).send('QR Code ID not found'); }
    if (!paymentId)   { return res.status(400).send('Payment ID not found'); }
    if (!amountPaise) { return res.status(400).send('Amount not found'); }
    if (!isoDate)     { isoDate = new Date().toISOString(); }

    const payloadString = JSON.stringify(req.body);

    // STEP 3: acquire per-QR distributed lock — same pattern as the legacy endpoints
    const lockKey = `lock:qr:${qrCodeId}`;
    const acquired = await acquireLock(lockKey, paymentId, LOCK_TTL_SECONDS);
    if (!acquired) {
        return res.status(503).send('Processing conflict, retry');
    }

    try {
        // STEP 4: idempotency check — under lock
        const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            [Query.equal('paymentId', paymentId), Query.limit(1)]
        );
        if (existing.documents.length) {
            return res.status(200).send('Duplicate webhook ignored');
        }

        // Review gate: hold for admin review if a manual window covers this txn, else finalize now.
        // 'user'-scope matches the QR's managing subadmin OR its direct assignedUserId.
        const { ownerSubadminId, ownerIds } = await resolveReviewOwners(qrCodeId);
        const reviewWindowMs = Number(ConfigManager.get('txn_review_window_ms', 10000)) || 10000;
        const { manual, fields: reviewFields } = reviewMode.reviewFieldsFor(qrCodeId, ownerIds, amountPaise, reviewWindowMs);

        // STEP 5: save raw webhook record (source of truth)
        const created = await databases.createDocument( 
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            ID.unique(),
            {
                payload:    payloadString,
                qrCodeId,
                paymentId,
                rrnNumber,
                amount:     amountPaise,
                vpa,
                provider:   'razorpay',
                created_at: isoDate,
                status:     'normal',
                ownerSubadminId,
                ...reviewFields,
            }
        );

        if (manual) {
            // HELD for admin review — no increments. Notify admins; resolution (approve/reject/timeout) comes later.
            // console.log(`[ReviewMode] HELD pending ${created.$id} qr=${qrCodeId} amount=${amountPaise} until=${reviewFields.reviewExpiresAt}`);
            emitPendingReview({
                $id: created.$id,
                qrCodeId,
                paymentId,
                amount: amountPaise,
                provider: created.provider,
                vpa,
                rrnNumber,
                created_at: isoDate,
                reviewExpiresAt: reviewFields.reviewExpiresAt,
                ownerSubadminId,
            });
        } else {
            // STEPS 6–9: centralized finalize — daily total, QR totals, emit, partner webhook, counters
            await finalizeTransaction(created, {
                emitPayload: {
                    $id:        created.$id,
                    qrCodeId,
                    paymentId,
                    amount:     amountPaise,
                    rrnNumber,
                    vpa,
                    provider:   'razorpay',
                    created_at: isoDate,
                },
            });
        }

        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error(`❌ Failed to process payment-webhook (${shape}):`, error.message);
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

const { startPinelabMultiPoller } = require('./pinelabMultiPoller');

// const ENABLE_PINELAB_POLLER = process.env.ENABLE_PINELAB_POLLER;
const ENABLE_PINELAB_POLLER = true; // default to disabled to avoid unintended consequences; enable explicitly with env var

// Accounts live in the `pinelab_accounts` collection (server-API-key only, secrets
// encrypted at rest) rather than in this file. Metrics/watermarks stay isolated per
// `accountId` in Redis (pinelabs:poller:<id>:*), so enabling/disabling an account
// never disturbs another account's watermark.
//
// `let`, not `const`: POST /admin/pinelabs/reload stops and replaces this handle.
let pinelabPoller = null;
let pinelabLoadError = null;      // surfaced by /admin/pinelabs/status when a load fails
let pinelabLoadedAt = null;

// Reads enabled accounts. Shape matches what startPinelabMultiPoller expects:
// [{ id, clientId, clientSecret }]
async function loadPinelabAccounts() {
    const res = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID,
        [Query.equal('enabled', true), Query.limit(100)]
    );
    return res.documents
        .filter(d => d.accountId && d.clientId && d.clientSecret)
        .map(d => ({ id: d.accountId, clientId: d.clientId, clientSecret: d.clientSecret }));
}

function buildPinelabPoller(accounts) {
    return startPinelabMultiPoller(
        {
            databases,
            Query,
            ID,
            redisClient,
            acquireLock,
            releaseLock,
            emitTxnNew,
            emitPendingReview,
            updateDailyQrTotal,
            finalizeTransaction,
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            APPWRITE_QRCODE_COLLECTION_ID,
            LOCK_TTL_SECONDS,
        },
        {
            env: 'production',
            intervalMs: Number(process.env.PINELAB_POLLER_INTERVAL_MS) || 1 * 60 * 1000,
            bufferMinutes: 2,        // small guard against micro-delays (txn anchor is ground truth)
            maxLookbackMinutes: 60,  // ceiling on window size during quiet periods
            pageSize: 100,
            maxPagesPerTick: 50,
            dryRun: false,
            accounts,
        }
    );
}

// Stops any running poller and starts a fresh one from the current collection state.
// Always stops first so a failed reload can never leave two pollers polling the same
// account — that would double the API load and race on the same watermark keys.
async function reloadPinelabPoller() {
    try { pinelabPoller?.stop(); } catch (e) { console.error('[pinelabs] error stopping poller:', e); }
    pinelabPoller = null;

    if (!ENABLE_PINELAB_POLLER) {
        pinelabLoadError = 'poller disabled (ENABLE_PINELAB_POLLER=false)';
        return { started: false, accountIds: [], reason: pinelabLoadError };
    }

    try {
        const accounts = await loadPinelabAccounts();
        pinelabLoadError = null;
        pinelabLoadedAt = new Date().toISOString();

        if (!accounts.length) {
            console.warn('[pinelabs] no enabled accounts found — poller not started');
            return { started: false, accountIds: [], reason: 'no enabled accounts' };
        }

        pinelabPoller = buildPinelabPoller(accounts);
        console.log(`[pinelabs] poller started with ${accounts.length} account(s): ${accounts.map(a => a.id).join(', ')}`);
        return { started: true, accountIds: pinelabPoller.accountIds };
    } catch (e) {
        // Polling is the only crediting path for PineLabs, so a failure here is
        // serious — but if Appwrite is unreachable the poller could not persist
        // anything anyway. Stay stopped, make it visible, and let an admin call
        // /admin/pinelabs/reload once Appwrite is back (no redeploy needed).
        pinelabLoadError = e?.message || String(e);
        console.error('[pinelabs] CRITICAL: could not load accounts — poller NOT running:', pinelabLoadError);
        return { started: false, accountIds: [], reason: pinelabLoadError };
    }
}

// Boot. Not awaited — a slow Appwrite must not block the HTTP server from binding
// (Render's health check would fail and restart us into the same stall).
reloadPinelabPoller().catch(e => console.error('[pinelabs] boot reload failed:', e));

// Admin-only: trigger a manual PineLabs poll. Omit from/to to run with the
// normal watermark window; pass both for an explicit backfill window.
// Body: { from?, to? } — either 'YYYY-MM-DD' or naive IST 'YYYY-MM-DDTHH:mm:ss'.
// Both are IST wall-time, matching every other date filter in this API.

const PINELAB_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date-only value covers that whole IST day. Without this, a plain 'YYYY-MM-DD'
// from a date picker reaches the poller's toIstDate(), becomes an Invalid Date, and
// fmtIst() throws inside runOnce's per-account try/catch — surfacing as
// { error: 'Invalid time value' } inside an HTTP 200. That silent no-op is the
// failure this normalisation exists to prevent.
function pinelabExpandIstBound(value, endOfDay) {
  const v = String(value).trim();
  return PINELAB_DATE_ONLY.test(v) ? `${v}T${endOfDay ? '23:59:59' : '00:00:00'}` : v;
}

// Mirrors the poller's own naive-IST interpretation; used here only to validate
// before we hand the strings over.
function pinelabParseIst(v) {
  return new Date(/[zZ]|[+\-]\d{2}:?\d{2}$/.test(v) ? v : v.replace(' ', 'T') + '+05:30');
}

app.post('/admin/pinelabs/poll', authenticateAdmin, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if ((from && !to) || (!from && to)) {
      return res.status(400).json({ error: 'Provide both from and to, or neither' });
    }
    if (!pinelabPoller) {
      return res.status(503).json({ error: 'PineLabs poller is disabled' });
    }

    const window = {};
    if (from && to) {
      const fromStr = pinelabExpandIstBound(from, false);
      const toStr   = pinelabExpandIstBound(to, true);

      if (isNaN(pinelabParseIst(fromStr).getTime()) || isNaN(pinelabParseIst(toStr).getTime())) {
        return res.status(400).json({
          error: "from/to must be 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm:ss' (IST wall-time)",
        });
      }
      if (pinelabParseIst(fromStr) > pinelabParseIst(toStr)) {
        return res.status(400).json({ error: 'from must not be after to' });
      }
      window.from = fromStr;
      window.to = toStr;
    }

    const result = await pinelabPoller.runOnce(window);
    res.json({ ok: true, window: from && to ? window : 'watermark', ...result });
  } catch (e) {
    console.error('[admin/pinelabs/poll] error:', e);
    res.status(500).json({ error: e.message || 'poll failed' });
  }
});

// ─── PineLabs account management ─────────────────────────────────────────────
// All admin-only. `clientSecret` is never returned by any of these — it is
// write-only from the API's point of view. Rotate it by PATCHing a new value.

const pickPinelabAccount = (d) => ({
    $id: d.$id,
    accountId: d.accountId,
    clientId: d.clientId,
    label: d.label || null,
    enabled: d.enabled !== false,
    // clientSecret deliberately omitted — never expose it, not even to admins.
    clientSecretSet: !!d.clientSecret,
});

// Is the poller actually running, and on which accounts?
app.get('/admin/pinelabs/running', authenticateAdmin, (req, res) => {
    res.json({
        running: !!pinelabPoller,
        enabledByFlag: !!ENABLE_PINELAB_POLLER,
        accountIds: pinelabPoller?.accountIds || [],
        loadedAt: pinelabLoadedAt,
        loadError: pinelabLoadError,
    });
});

app.get('/admin/pinelabs/accounts', authenticateAdmin, async (req, res) => {
    try {
        const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID,
            [Query.limit(100), Query.orderAsc('accountId')]
        );
        res.json({ success: true, accounts: result.documents.map(pickPinelabAccount) });
    } catch (e) {
        console.error('[admin/pinelabs/accounts] list error:', e);
        res.status(500).json({ error: e.message || 'failed to list accounts' });
    }
});

app.post('/admin/pinelabs/accounts', authenticateAdmin, async (req, res) => {
    try {
        const { accountId, clientId, clientSecret, label, enabled } = req.body || {};
        if (!accountId || !clientId || !clientSecret) {
            return res.status(400).json({ error: 'accountId, clientId and clientSecret are required' });
        }
        // accountId becomes a Redis key segment (pinelabs:poller:<id>:*), so keep it
        // to a safe charset — a stray ':' would silently collide with another key.
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) {
            return res.status(400).json({ error: 'accountId must match ^[a-zA-Z0-9_-]{1,64}$' });
        }

        const dupe = await databases.listDocuments(
            APPWRITE_DATABASE_ID, APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID,
            [Query.equal('accountId', accountId), Query.limit(1)]
        );
        if (dupe.documents.length) {
            return res.status(409).json({ error: `Account "${accountId}" already exists` });
        }

        const created = await databases.createDocument(
            APPWRITE_DATABASE_ID, APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID, ID.unique(),
            { accountId, clientId, clientSecret, label: label || null, enabled: enabled !== false }
        );
        console.log(`[pinelabs] account "${accountId}" created by ${req.user?.userId || 'admin'}`);
        res.status(201).json({
            success: true,
            account: pickPinelabAccount(created),
            note: 'Call POST /admin/pinelabs/reload to apply this to the running poller.',
        });
    } catch (e) {
        console.error('[admin/pinelabs/accounts] create error:', e);
        res.status(500).json({ error: e.message || 'failed to create account' });
    }
});

// Enable/disable, relabel, or rotate credentials. Only the keys present are changed.
app.patch('/admin/pinelabs/accounts/:accountId', authenticateAdmin, async (req, res) => {
    try {
        const { accountId } = req.params;
        const found = await databases.listDocuments(
            APPWRITE_DATABASE_ID, APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID,
            [Query.equal('accountId', accountId), Query.limit(1)]
        );
        if (!found.documents.length) return res.status(404).json({ error: 'Account not found' });

        // Whitelist — never mass-assign req.body onto a credential document.
        const patch = {};
        const { clientId, clientSecret, label, enabled } = req.body || {};
        if (clientId !== undefined)     patch.clientId = clientId;
        if (clientSecret !== undefined) patch.clientSecret = clientSecret;
        if (label !== undefined)        patch.label = label;
        if (enabled !== undefined)      patch.enabled = !!enabled;
        if (!Object.keys(patch).length) {
            return res.status(400).json({ error: 'Provide at least one of clientId, clientSecret, label, enabled' });
        }

        const updated = await databases.updateDocument(
            APPWRITE_DATABASE_ID, APPWRITE_PINELAB_ACCOUNTS_COLLECTION_ID, found.documents[0].$id, patch
        );
        console.log(`[pinelabs] account "${accountId}" updated (${Object.keys(patch).join(', ')}) by ${req.user?.userId || 'admin'}`);
        res.json({
            success: true,
            account: pickPinelabAccount(updated),
            note: 'Call POST /admin/pinelabs/reload to apply this to the running poller.',
        });
    } catch (e) {
        console.error('[admin/pinelabs/accounts] update error:', e);
        res.status(500).json({ error: e.message || 'failed to update account' });
    }
});

// Re-read the collection and restart the poller with the new account list.
app.post('/admin/pinelabs/reload', authenticateAdmin, async (req, res) => {
    try {
        const result = await reloadPinelabPoller();
        console.log(`[pinelabs] reload requested by ${req.user?.userId || 'admin'} — started=${result.started}`);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('[admin/pinelabs/reload] error:', e);
        res.status(500).json({ error: e.message || 'reload failed' });
    }
});

// Admin-only: read poller health/metrics from Redis
app.get('/admin/pinelabs/status', authenticateAdmin, async (req, res) => {
  try {
    const metrics = [
      'latestTxnAt',
      'lastRunAt',
      'lastTxnsSeen',
      'lastTxnsSaved',
      'lastDurationMs',
      'consecutiveFailures',
      'lastError',
    ];
    const accountIds = pinelabPoller?.accountIds || [];
    const out = {};
    await Promise.all(accountIds.map(async (id) => {
      const values = await Promise.all(
        metrics.map(m => redisClient.get(`pinelabs:poller:${id}:${m}`).catch(() => null))
      );
      const acct = {};
      metrics.forEach((m, i) => { acct[m] = values[i]; });
      out[id] = acct;
    }));
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
    if (isShuttingDown) return;              // SIGTERM then SIGINT must not drain twice
    isShuttingDown = true;                   // /health starts reporting 503 immediately
    console.log(`\n${signal} received — starting graceful shutdown`);
    try { pinelabPoller?.stop(); } catch (e) { console.error('Error stopping PineLabs poller:', e); }

    // Armed before the drain so the deadline is measured from the signal, not from
    // the end of draining — GRACEFUL_SHUTDOWN_MS is the whole budget, DRAIN_MS included.
    setTimeout(() => {
        console.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_MS).unref(); // .unref() so this timer doesn't keep the process alive on its own

    // Keep accepting requests for a moment so Render sees the 503 and drains traffic
    // before the socket closes — a webhook arriving now gets a retryable 503 instead
    // of connection-refused.
    console.log(`Draining for ${DRAIN_MS}ms before closing the HTTP server`);
    await new Promise((r) => setTimeout(r, DRAIN_MS));

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
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
// ─────────────────────────────────────────────────────────────────────────────
