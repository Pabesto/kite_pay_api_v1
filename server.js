// server.js
// This is the main server file. It sets up the Express app, the Appwrite connection,
// and the routes for QR code management and webhook processing.

require('dotenv').config();
const moment = require('moment-timezone');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const { Client, Databases, Storage, Users, Account, ID, Query, InputFile } = require('node-appwrite');

const { createServer } = require('http');
const { Server } = require('socket.io');

// Import the route files
const qrCodeRoutes = require('./qrcode');
const adminRoutes = require('./admin');
const withdrawRoutes = require('./withdraw');

const { initSocket } = require('./socketServer');

// --- Configuration & Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;

const { httpServer, emitTxnNew , emitQrAlert } = initSocket(app);

const { updateDashboardCounter } = require('./dashboardCounters');

httpServer.listen(PORT, () => {
  console.log(`HTTP + WS listening on :${PORT}`);
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
//
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

// console.log(process.env.RAZORPAY_KEY_ID);

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

app.use(
  bodyParser.json({
    verify: (req, res, buf, encoding) => {
      req.rawBody = buf.toString(encoding || 'utf8'); // keep exact raw text
    },
  })
);

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
        // After successful token verification, check the user's labels
        // if (!req.user || !(req.user.labels?.includes('admin') || req.user.labels?.includes('subadmin'))) {
        //     return res.status(403).json({ error: 'Not authorized: Admin or SubAdmin required.' });
        // }

        // if (!req.user || !(req.user.labels?.includes('admin') || req.user.labels?.includes('subadmin'))) {
        //     return res.status(403).json({ error: 'Not authorized: Admin or SubAdmin required.' });
        // }

        if (!req.user || !['admin', 'subadmin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Not authorized: Admin or SubAdmin required.' });
        }

        next();
    });
};

// async function authenticateAdminOrSubAdmin(req, res, next) {
//     try {
//         const jwt = req.headers.authorization?.split(" ")[1]; // Bearer <token>
//         if (!jwt) {
//             return res.status(401).json({ error: "Missing token" });
//         }

//         // 🔑 Get user from Appwrite Account API
//         const appwriteUser = await account.get();

//         // 📦 Fetch role from your `users_meta` collection
//         const userMeta = await databases.listDocuments(
//             APPWRITE_DATABASE_ID,
//             APPWRITE_USERS_META_COLLECTION_ID,
//             [Query.equal("userId", appwriteUser.$id)]
//         );

//         console.log("User role data:", userMeta);

//         if (userMeta.total === 0) {
//             return res.status(403).json({ error: "User metadata not found" });
//         }

//         const meta = userMeta.documents[0];

//         // Attach full user info for later use
//         req.user = {
//             $id: appwriteUser.$id,
//             email: appwriteUser.email,
//             name: appwriteUser.name,
//             role: meta.role,
//             parentId: meta.parentId || null,
//         };

//         // ✅ Allow only admin or sub-admin
//         if (meta.role === "admin" || meta.role === "sub-admin") {
//             return next();
//         }

//         return res.status(403).json({ error: "Not allowed" });
//     } catch (err) {
//         console.error("❌ Auth error:", err.message || err);
//         return res.status(401).json({ error: "Invalid or expired token" });
//     }
// }


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
app.use('/api', qrCodeRoutes(databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/admin', adminRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));

function rupeesToPaiseStrict(rupees) {
  const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
  const frac = (fracPart + '00').slice(0, 2); // exactly 2 decimals
  return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// This is the route you provide to the Razorpay/Ezetap team
app.post('/razorpay-webhook', async (req, res) => {
    const data = req.body;

    console.log("📩 Webhook Received:", data);

    const payloadString = JSON.stringify(req.body);
  try {
    const created = await databases.createDocument(
      APPWRITE_DATABASE_ID,
      'razorpay_webhook',
      ID.unique(),
      {
        payload: payloadString, // avoid storing full payload for Cashfree to save space
      }
    );
  } catch (e){

  }

    // LOGIC: Check for 'status' field [cite: 897]
    if (data.status === "AUTHORIZED") {
        // [cite: 898] "Authorized" means transaction successfully executed
        console.log("✅ Payment Success:", data.txnId);
        
        // Perform your database updates here
    } else if (data.status === "FAILED") {
        // [cite: 898] "Failed" means money won't be deducted
        console.log("❌ Payment Failed");
    }

    // IMPORTANT: You must return HTTP 200, otherwise they will retry 3 times 
    res.status(200).send("OK");
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

app.post('/cashfree/webhook', async (req, res) => {
  console.log('Webhook Event Received: Cashfree');

  // 1) Signature headers (required)
  const cfSignature = req.headers['x-webhook-signature'];
  const cfTimestamp = req.headers['x-webhook-timestamp'];
  if (!cfSignature || !cfTimestamp) {
    return res.status(400).send('Missing Cashfree signature headers');
  }

  // 2) Verify signature: Base64(HMACSHA256(timestamp + rawBody, Client Secret))
  try {
    const signedPayload = `${cfTimestamp}${req.rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
      .update(signedPayload)
      .digest('base64');

    // Alternatively, via SDK:
    // Cashfree.PGVerifyWebhookSignature(cfSignature, req.rawBody, cfTimestamp);

    if (expectedSig !== cfSignature) {
      console.warn('❌ Cashfree webhook signature mismatch');
      return res.status(400).send('Invalid signature');
    }
  } catch (err) {
    console.error('Signature verification error:', err.message);
    return res.status(400).send('Signature verification failed');
  }
  console.log('✅ Cashfree webhook verified'); // [verified]

  // 3) Event filter (Payments)
  const cfEventType = req.body?.type;
  if (cfEventType !== 'PAYMENT_SUCCESS_WEBHOOK') {
    console.log('❌ Unsupported event type:', cfEventType);
    return res.status(400).send('Unsupported event type');
  }

  // 4) Extract and map fields from the provided sample JSON
  const payload = req.body?.data || {};
  const order = payload?.order || {};
  const payment = payload?.payment || {};
  const upi = payment?.payment_method?.upi || {};

  // Prefer the custom QR code tag as the identifier
  const qrCodeId = order?.order_tags?.cf_form_id || order?.order_id;
  const paymentId = payment?.cf_payment_id; // unique per attempt
  const rrnNumber = payment?.bank_reference;
//   const amount = Number(payment?.payment_amount || 0);
  const amountRupees = payment?.payment_amount; // e.g., "10.01" or 10.01
  const amountPaise = rupeesToPaiseStrict(amountRupees); // 1001
  const vpa = upi?.upi_id;
  const createdAt = req.body?.event_time || payment?.payment_time;

  if (!qrCodeId) return res.status(400).send('QR Code ID not found');
  if (!paymentId) return res.status(400).send('Payment ID not found');

  // 5) Idempotency guard (process each cf_payment_id once)
  // Idempotency guard: skip if this paymentId is already recorded
    const existing = await databases.listDocuments(
    APPWRITE_DATABASE_ID,
    APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
        [Query.equal('paymentId', paymentId), Query.limit(1)]
    ); // requires an index on paymentId for performance

    if (existing.documents.length) {
        return res.status(200).send('Duplicate webhook ignored'); // already processed
    }

  // 6) Persist raw webhook payload + mapped fields
  const payloadString = JSON.stringify(req.body);
  try {
    const created = await databases.createDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
      ID.unique(),
      {
        payload: '', // avoid storing full payload for Cashfree to save space
        qrCodeId: qrCodeId,
        paymentId: paymentId,
        rrnNumber: rrnNumber,
        amount: amountPaise,
        vpa: vpa,
        provider: 'cashfree',
        created_at: createdAt,
        status: 'normal',
      }
    );

    (async () => {
    try {
        await updateDailyQrTotal(
        qrCodeId,
        createdAt,
        amountPaise
        );
        console.log('Daily QR total updated successfully.');
    } catch (error) {
        console.error('Error updating daily QR total:', error);
    }
    })();

    const eventPayload = {
        $id: created.$id,                                    // document id
        qrCodeId,
        paymentId,                                           // string
        amount: amountPaise,                           // exact integer
        rrnNumber: rrnNumber || null,
        vpa: vpa || null,
        provider: 'cashfree',
        created_at: new Date(createdAt).toISOString(),    // normalize to ISO
    }; // normalized event payload for clients [2]

    // 5) Emit only to intended audiences (user + QR rooms)
    emitTxnNew({
        assignedUserId : '',      // may be null if QR not found
        qrCodeId,
        payload: eventPayload,
    }); // Socket.IO selective emit via rooms [1]

    // 4️⃣ Update global counters (async, no await)
    // totalTxCount
    await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalTxCount', 1).catch((e) => {
        console.error('Error updating dashboard counter:', e);
    });

    // totalApiTx
    await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalApiTx', 1).catch((e) => {
        console.error('Error updating dashboard counter:', e);
    });

    // totalAmountReceived
    await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAmountReceived', finalAmount).catch((e) => {
        console.error('Error updating dashboard counter:', e);
    });

  } catch (e) {
    console.error('Persist webhook error:', e?.message || e);
    return res.status(500).send('Error saving webhook');
  }

    // 7) Update QR totals atomically
    try {
    const qrResult = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_QRCODE_COLLECTION_ID,
        [Query.equal('qrId', qrCodeId), Query.limit(1)]
    );

    if (!qrResult.documents.length) {
        // console.log(`QR Code with qrId ${qrCodeId} not found`);
        return res.status(200).send('OK'); // or handle not-found differently
    }

    const qrDoc = qrResult.documents[0];            // <- take first doc
    // const qrDoc = qrResult.documents;           
    const qrDocId = qrDoc.$id;                     // <- required documentId
    const newCount = (qrDoc.totalTransactions || 0) + 1;
    const newTotal  = (qrDoc.totalPayInAmount || 0) + amountPaise;

    // Recompute available after changing total
    const approved = Number(qrDoc.withdrawalApprovedAmount || 0);
    const requested = Number(qrDoc.withdrawalRequestedAmount || 0);
    const onHold = Number(qrDoc.amountOnHold || 0);
    const commissionOnHold = Number(qr.commissionOnHold || 0);
    const commissionPaid = Number(qr.commissionPaid || 0);
    const newAvailable = newTotal - approved - requested - onHold - commissionOnHold - commissionPaid;

    await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_QRCODE_COLLECTION_ID,
        qrDocId,                                     // <- pass $id here
        {
            totalTransactions: newCount,
            totalPayInAmount: newTotal ,
            amountAvailableForWithdrawal: newAvailable, // <-- add this
        }
    );

    // emitTxnNew({
    //     assignedUserId: qrDoc.assignedUserId,
    //     qrCodeId,
    //     payload,
    // });

    // console.log(`QR totals updated for qrId ${qrCodeId}`);
    return; // continue flow as needed
    } catch (e) {
    // console.error('QR totals update error:', e?.message || e);
    return res.status(500).send('Error updating QR totals');
    }


  // 8) Final response
  return res.status(200).send('Webhook received and processed');
});

// --- Webhook Endpoint ---
// Secret:   4@cQVD6GBGa2G7j
app.post('/webhook', async (req, res) => {
    console.log('Webhook Event Received');

    // Verify the webhook signature
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!razorpaySignature) {
        return res.status(400).send('Missing Razorpay signature');
    }

    // Create HMAC SHA256 with your webhook secret
    const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

    // Compare signatures
    if (expectedSignature === razorpaySignature) {
        console.log('✅ Webhook verified successfully');
        // console.log('📦 Webhook Data:', req.body);

        // TODO: Handle payment/capture/order event here

        //return res.status(200).send('OK');
    } else {
        console.warn('❌ Webhook signature mismatch!');
        return res.status(400).send('Invalid signature');
    }

    const eventType = req.body?.event;

    if (eventType !== 'qr_code.credited') {
        // console.log('❌ Unsupported event type:', eventType);
        return res.status(400).send('Unsupported event type');
    }

    const qrCodeId = req.body?.payload?.qr_code?.entity?.id;
    const paymentsAmount = req.body?.payload?.qr_code?.entity?.payments_amount_received;
    const paymentsCount = req.body?.payload?.qr_code?.entity?.payments_count_received;


    if (!qrCodeId) {
        // console.log('❌ QR Code ID not found in payload');
        return res.status(400).send('QR Code ID not found');
    }

    const paymentId = req.body?.payload?.payment?.entity?.id;
    if (!paymentId) {
        // console.log('❌ Payment ID not found in payload');
        return res.status(400).send('Payment ID not found');
    }
    const rrnNumber = req.body?.payload?.payment?.entity?.acquirer_data?.rrn;
    const amount = req.body?.payload?.payment?.entity?.amount;
    const vpa = req.body?.payload?.payment?.entity?.vpa;
    const unixTimestamp = req.body?.payload?.payment?.entity?.created_at;

    const isoDate = new Date(unixTimestamp * 1000).toISOString();

    // const istString = new Date(unixTimestamp * 1000).toLocaleString('en-IN', {
    //     timeZone: 'Asia/Kolkata'
    // });

    const payloadString = JSON.stringify(req.body);

    try {
        const result = await databases.createDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            ID.unique(),
            {
                payload: payloadString,
                qrCodeId: qrCodeId,
                paymentId: paymentId,
                rrnNumber: rrnNumber,
                amount: amount,
                vpa: vpa,
                created_at: isoDate
            }
        );

        /////////////////////////////////////////////////////////////////////////////////////////////////

        // 3️⃣ Update the corresponding QR code totals
        if (qrCodeId && paymentsAmount != null && paymentsCount != null) {
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                [
                    Query.equal('qrId', qrCodeId),
                    Query.limit(1)
                ]
            );

            if (qrResult.documents.length) {
                const qrDoc = qrResult.documents[0];
                await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_QRCODE_COLLECTION_ID,
                    qrDoc.$id,
                    {
                        totalTransactions: paymentsCount,
                        totalPayInAmount: paymentsAmount
                    }
                );
                // console.log(`QR totals updated for qrId ${qrCodeId}`);
            } else {
                // console.log(`QR Code with qrId ${qrCodeId} not found`);
            }
        }


        // console.log('✅ Webhook data saved to Appwrite:', result.$id);
        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to save webhook:', error.message);
        res.status(500).send('Error saving webhook');
    }
});

async function updateDailyQrTotal(qrCodeId, txnDate, amountDelta) {
  // Convert txnDate to IST date string "YYYY-MM-DD"
  const istDate = moment.tz(txnDate, 'Asia/Kolkata');
  const dayString = istDate.format('YYYY-MM-DD');

  console.log('IST dayString:', dayString);
  console.log('qrId:', qrCodeId);

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

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
