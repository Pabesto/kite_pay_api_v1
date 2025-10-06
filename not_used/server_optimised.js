require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const { Client, Databases, Storage, Users, Account, ID, Query, InputFile } = require('node-appwrite');

const qrCodeRoutes = require('./qrcode');
const adminRoutes = require('./admin');
const withdrawRoutes = require('./withdraw');

const app = express();
const PORT = process.env.PORT || 3000;

// Appwrite config from .env
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_QRCODE_COLLECTION_ID = process.env.APPWRITE_QRCODE_COLLECTION_ID;
const APPWRITE_WEBHOOK_DATA_COLLECTION_ID = process.env.APPWRITE_WEBHOOK_DATA_COLLECTION_ID;
const APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID = process.env.APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID;
const APPWRITE_USERS_META_COLLECTION_ID = process.env.APPWRITE_USERS_META_COLLECTION_ID;
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

const databases = new Databases(client);
const account = new Account(client);
const storage = new Storage(client);
const users = new Users(client);

app.use(cors());
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Authentication token is required.' });

        const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);

        const userAccount = new Account(userClient);
        const user = await userAccount.get();

        const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal('userId', user.$id)]
        );
        if (list.documents.length === 0) return res.status(404).json({ error: 'User metadata not found' });

        req.user = list.documents[0];
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
};

const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized: Admin privileges required.' });
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

// --- Role Middleware ---
async function roleAuth(req, res, next) {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ error: "Unauthorized: No token" });

        const jwtClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);

        const userAccount = new Account(jwtClient);
        let appwriteUser;
        try {
            appwriteUser = await userAccount.get();
        } catch {
            return res.status(401).json({ error: "Invalid token" });
        }

        const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal("appwrite_id", appwriteUser.$id)]
        );
        if (response.documents.length === 0) return res.status(403).json({ error: "User meta not found" });

        req.userMeta = {
            appwrite_id: response.documents[0].appwrite_id,
            role: response.documents[0].role,
            parent_id: response.documents[0].parent_id,
        };
        next();
    } catch {
        return res.status(500).json({ error: "Internal server error" });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.userMeta) return res.status(401).json({ error: "Unauthorized" });
        if (!roles.includes(req.userMeta.role)) return res.status(403).json({ error: "Forbidden: Role not allowed" });
        next();
    };
}

// --- Routes ---
app.use('/api', qrCodeRoutes(databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, roleAuth, requireRole));
app.use('/api/admin', adminRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WEBHOOK_DATA_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));
app.use('/api/user', withdrawRoutes(databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, APPWRITE_QRCODE_COLLECTION_ID, APPWRITE_WITHDRAWAL_REQUEST_COLLECTION_ID, APPWRITE_BUCKET_ID, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole));

// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
    const razorpaySignature = req.headers['x-razorpay-signature'];
    if (!razorpaySignature) return res.status(400).send('Missing Razorpay signature');

    const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

    if (expectedSignature !== razorpaySignature) return res.status(400).send('Invalid signature');

    const eventType = req.body?.event;
    if (eventType !== 'qr_code.credited') return res.status(400).send('Unsupported event type');

    const qrCodeId = req.body?.payload?.qr_code?.entity?.id;
    const paymentsAmount = req.body?.payload?.qr_code?.entity?.payments_amount_received;
    const paymentsCount = req.body?.payload?.qr_code?.entity?.payments_count_received;
    const paymentId = req.body?.payload?.payment?.entity?.id;
    if (!qrCodeId || !paymentId) return res.status(400).send('QR Code ID or Payment ID not found');

    const rrnNumber = req.body?.payload?.payment?.entity?.acquirer_data?.rrn;
    const amount = req.body?.payload?.payment?.entity?.amount;
    const vpa = req.body?.payload?.payment?.entity?.vpa;
    const unixTimestamp = req.body?.payload?.payment?.entity?.created_at;
    const isoDate = new Date(unixTimestamp * 1000).toISOString();
    const payloadString = JSON.stringify(req.body);

    try {
        const result = await databases.createDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_WEBHOOK_DATA_COLLECTION_ID,
            ID.unique(),
            {
                payload: payloadString,
                qrCodeId,
                paymentId,
                rrnNumber,
                amount,
                vpa,
                created_at: isoDate
            }
        );

        if (qrCodeId && paymentsAmount != null && paymentsCount != null) {
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_QRCODE_COLLECTION_ID,
                [Query.equal('qrId', qrCodeId), Query.limit(1)]
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
            }
        }
        res.status(200).send('Webhook received and saved');
    } catch (error) {
        res.status(500).send('Error saving webhook');
    }
});

// Test endpoint to list all users
app.get('/test/users', async (req, res) => {
    try {
        const result = await users.list();
        const simplifiedUsers = result.users.map(user => ({
            $id: user.$id,
            email: user.email,
            name: user.name,
            labels: user.labels,
        }));
        res.json(simplifiedUsers);
    } catch {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.send('QR Code Admin API is running!');
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});