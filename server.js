// server.js
// This is the main server file. It sets up the Express app, the Appwrite connection,
// and the routes for QR code management and webhook processing.

require('dotenv').config();
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

const { httpServer, emitTxnNew } = initSocket(app);

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

// --- Admin Authentication Middleware ---
// This middleware first authenticates the token and then checks for the 'admin' label.
const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        // After successful token verification, check the user's labels
        // if (!req.user || !req.user.labels?.includes('admin')) {
        //     return res.status(403).json({ error: 'Not authorized: Admin privileges required.' });
        // }

        if (!req.user || !['admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Not authorized: Admin or SubAdmin required.' });
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
app.use('/api', qrCodeRoutes(databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/admin', adminRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));

// Admin routes use the admin authentication middleware
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));

function rupeesToPaiseStrict(rupees) {
  const [intPart = '0', fracPart = ''] = String(rupees).trim().split('.');
  const frac = (fracPart + '00').slice(0, 2); // exactly 2 decimals
  return parseInt(intPart, 10) * 100 + parseInt(frac, 10);
}

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
      }
    );

    const eventPayload = {
        id: created.$id,                                    // document id
        qrCodeId,                                           // string
        amountPaise: amountPaise,                           // exact integer
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
        console.log(`QR Code with qrId ${qrCodeId} not found`);
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
    const newAvailable = Math.max(0, newTotal - approved - requested);

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
        console.log('❌ Unsupported event type:', eventType);
        return res.status(400).send('Unsupported event type');
    }

    const qrCodeId = req.body?.payload?.qr_code?.entity?.id;
    const paymentsAmount = req.body?.payload?.qr_code?.entity?.payments_amount_received;
    const paymentsCount = req.body?.payload?.qr_code?.entity?.payments_count_received;


    if (!qrCodeId) {
        console.log('❌ QR Code ID not found in payload');
        return res.status(400).send('QR Code ID not found');
    }

    const paymentId = req.body?.payload?.payment?.entity?.id;
    if (!paymentId) {
        console.log('❌ Payment ID not found in payload');
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
                console.log(`QR totals updated for qrId ${qrCodeId}`);
            } else {
                console.log(`QR Code with qrId ${qrCodeId} not found`);
            }
        }


        console.log('✅ Webhook data saved to Appwrite:', result.$id);
        res.status(200).send('Webhook received and saved');
    } catch (error) {
        console.error('❌ Failed to save webhook:', error.message);
        res.status(500).send('Error saving webhook');
    }
});

// A test endpoint to list all users, adapted from your provided file.
// It uses the pre-initialized users client.
app.get('/test/users', async (req, res) => {
    try {
        const result = await users.list();

        const simplifiedUsers = result.users.map(user => ({
            $id: user.$id,
            email: user.email,
            name: user.name,
            labels: user.labels,
        }));

        return res.json(simplifiedUsers);
    } catch (err) {
        console.error('Test user list error:', err);
        return res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Root endpoint for testing
app.get('/', (req, res) => {
    res.send('QR Code Admin API is running!');
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
