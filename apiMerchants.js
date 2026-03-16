// -----------------------------------------------------------------------------------------------------
// apiMerchants.js
// This file contains the API endpoints for apiMerchants.

const express = require('express');
const multer = require('multer');
const moment = require('moment-timezone');
const QRCode = require('qrcode');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require("uuid");
const { UPIQRGenerator } = require('upiqrcode');  // ✅ Stable package

const { updateDashboardCounter } = require('./dashboardCounters');

const router = express.Router();

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient) => {

    // Atomic lock helpers
    const RELEASE_LOCK_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
    async function acquireLock(key, value, ttlSeconds = 15) {
        try {
            const result = await redisClient.set(key, value, { NX: true, EX: ttlSeconds });
            return result === 'OK';
        } catch (e) {
            console.error('acquireLock error:', e);
            return false;
        }
    }
    async function releaseLock(key, val) {
        try { await redisClient.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [val] }); } catch (e) { console.error(`releaseLock failed for ${key}:`, e.message); }
    }

    async function authenticateMerchant(req, res, next) {
        const auth = req.headers.authorization?.split(' ')[1];
        const { merchantId } = req.body || req.params;

        if (!auth || !merchantId) {
            return res.status(401).json({ error: 'Missing credentials' });
        }

        try {
            const merchantDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                [Query.equal('merchantId', merchantId), Query.limit(1)]
            );

            const merchant = merchantDocs.documents[0];

            if (!merchant) {
                return res.status(401).json({ error: 'Merchant not found' });
            }

            // Verify secret using bcrypt
            const secretValid = await bcrypt.compare(auth, merchant.apiSecret);
            if (!secretValid) {
                return res.status(401).json({ error: 'Invalid API secret' });
            }

            // ✅ Additional checks
            if (!merchant.status) {
                return res.status(403).json({ error: 'Merchant account suspended' });
            }

            // ✅ Rate limit check (daily QR count)
            // const today = new Date().toISOString().split('T')[0];
            // const todayRequests = await databases.listDocuments(
            //     APPWRITE_DATABASE_ID,
            //     TRANSACTIONS_COLLECTION_ID,
            //     [
            //         Query.equal('merchantId', merchantId),
            //         Query.greaterThanEqual('createdAt', `${today}T00:00:00Z`),
            //         Query.limit(1)
            //     ]
            // );

            // if (todayRequests.total >= merchant.daily_limit) {
            //     return res.status(429).json({ 
            //         error: 'Daily QR limit exceeded', 
            //         limit: merchant.daily_limit,
            //         used: todayRequests.total 
            //     });
            // }

            // console.log(merchant.vpa);

            req.merchant = merchant;
            req.vpa = merchant.vpa;
            next();

        } catch (e) {
            console.error('Merchant auth error:', e);
            res.status(500).json({ error: 'Authentication failed' });
        }

    }

    // ✅ /qr_generate endpoint
    router.post('/qr_generate', authenticateMerchant, async (req, res) => {
        try {
            // 1. Extract & validate inputs
            const { amount } = req.body || {};
            const merchantId = req.merchant?.merchantId;

            if (!merchantId) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized: merchantId missing',
                });
            }

            if (!amount) {
                return res.status(401).json({
                    success: false,
                    error: 'Error: amount missing',
                });
            }

            // Validate amount
            const amountNumber = parseFloat(amount);
            if (isNaN(amountNumber) || amountNumber <= 0 || amountNumber > 100000) { // ₹1L max
                return res.status(400).json({
                    success: false,
                    error: 'Invalid amount: must be positive number ≤ ₹100,000',
                });
            }

            const amountPaise = Math.round(amountNumber * 100);
            const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            // const vpa = 'pabestotechprivateli.96194569@hdfcbank'; // Move to env later
            const vpa = req.vpa;
            const COMPANY_NAME = 'Pabesto Tech';
            const txnId = uuidv4();
            const expiry = Date.now() + 5 * 60 * 1000; // 5 min

            // 2. Create pending request in DB
            const requestDoc = await databases.createDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',
                ID.unique(),
                {
                    merchantId,
                    orderId,
                    amount: amountPaise, // Store in paise
                    status: 'pending',
                    vpa,
                    qrGenerated: false,
                }
            );

            // 3. Generate UPI deep link
            const upiLink = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(COMPANY_NAME)}&am=${amountNumber.toFixed(2)}&cu=INR&tn=Order-${encodeURIComponent(txnId)}`;

            // 4. Generate QR code
            const qrBase64 = await QRCode.toDataURL(upiLink, {
                width: 300,
                margin: 1,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF',
                },
            });

            // 5. Update DB with QR
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',
                requestDoc.$id,
                {
                    qrBase64,
                    qrGenerated: true,
                    qrLink: upiLink,
                }
            );

            // 6. Success response
            res.status(201).json({
                success: true,
                message: 'QR code generated successfully',
                data: {
                    orderId,
                    amount: amount, // Same as input
                    qrBase64,
                    qrLink: upiLink,
                    expiry: new Date(expiry).toISOString(),
                    // requestId: requestDoc.$id,
                },
            });

        } catch (error) {
            console.error('QR Generate error:', error);

            // Specific error handling
            if (error.code === 409) { // Document conflict
                return res.status(409).json({
                    success: false,
                    error: 'Order ID conflict - retry requested',
                });
            }

            return res.status(500).json({
                success: false,
                error: 'Failed to generate QR code',
            });
        }
    });


    // ✅ /verify-payment endpoint
    router.post('/verify-payment', authenticateMerchant, async (req, res) => {
        try {
            // 1. Extract + basic validation
            const { orderId, amount, rrnNumber } = req.body || {};
            const merchantId = req.merchant?.merchantId;

            if (!merchantId) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized: merchantId missing',
                });
            }

            if (!orderId || !amount || !rrnNumber) {
                return res.status(400).json({
                    success: false,
                    error: 'orderId, amount, and rrnNumber are required',
                });
            }

            // amount numeric check
            const amountNumber = Number(amount);
            if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'amount must be a positive number',
                });
            }

            const amountPaise = Math.round(amountNumber * 100);

            // 2. Find QR request
            const qrRequests = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',
                [
                    Query.equal('orderId', orderId),
                    Query.equal('merchantId', merchantId),
                    Query.equal('amount', amountPaise),
                    // Query.equal('status', 'pending'),
                    Query.limit(1),
                ]
            );

            if (!qrRequests.documents.length) {
                return res.status(404).json({
                    success: false,
                    error: 'No matching QR request found',
                    details: { orderId, merchantId, amount: amountNumber },
                });
            }

            const qrRequest = qrRequests.documents[0];
            const qrRequestId = qrRequest.$id;

            // 3. If already verified for this rrn, treat as idempotent
            if (qrRequest.status === 'success' && qrRequest.rrnNumber === rrnNumber) {
                return res.status(200).json({
                    success: true,
                    message: 'Payment already verified',
                    transaction: {
                        orderId: qrRequest.orderId,
                        merchantId,
                        amount: amount, // original input
                        rrnNumber: qrRequest.rrnNumber,
                        status: qrRequest.status,
                        paymentId: qrRequest.paymentId,
                        txnId: qrRequest.txnId,
                        verifiedAt: qrRequest.verifiedAt,
                        receivedAt: qrRequest.webhookReceivedAt,
                    },
                });
            }

            // 4. Find webhook transaction
            const webhookTxns = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                '688cf5920023475022df', // webhook payments
                [
                    Query.equal('rrnNumber', rrnNumber),
                    Query.equal('amount', amountPaise),
                    Query.equal('status', 'normal'),
                    Query.limit(1),
                ]
            );

            if (!webhookTxns.documents.length) {
                return res.status(404).json({
                    success: false,
                    error: 'No matching webhook transaction found for rrnNumber',
                    details: { orderId, rrnNumber, amount: amountNumber, merchantId },
                });
            }

            const webhookTxn = webhookTxns.documents[0];
            const webhookTxnId = webhookTxn.$id;

            // 5. Prevent double verification (idempotency)
            if (webhookTxn.alreadyVerified) {
                // 200 because the resource is already in the desired state
                return res.status(200).json({
                    success: true,
                    message: 'Payment already verified',
                    transaction: {
                        orderId: qrRequest.orderId,
                        merchantId,
                        amount: amount, // original input
                        rrnNumber: qrRequest.rrnNumber ?? rrnNumber,
                        status: qrRequest.status ?? 'success',
                        paymentId: webhookTxn.paymentId,
                        txnId: webhookTxn.$id,
                        vpa: webhookTxn.vpa,
                        receivedAt: webhookTxn.$createdAt,
                        verifiedAt: qrRequest.verifiedAt,
                    },
                });
            }

            // 6. Extra rrn safety (technically redundant but ok)
            if (webhookTxn.rrnNumber !== rrnNumber) {
                return res.status(409).json({
                    success: false,
                    error: 'UTR payment mismatch',
                    qrOrderId: qrRequest.orderId,
                });
            }

            // 7. Acquire lock to prevent concurrent double-verification
            const verifyLockKey = `lock:verify:${rrnNumber}`;
            const verifyLockVal = `${merchantId}:${Date.now()}`;
            const verifyLockAcquired = await acquireLock(verifyLockKey, verifyLockVal, 15);
            if (!verifyLockAcquired) {
                return res.status(409).json({ success: false, error: 'This payment is already being verified. Please try again.' });
            }

            try {
            // Re-check alreadyVerified under lock (fresh read)
            const freshTxn = await databases.getDocument(APPWRITE_DATABASE_ID, '688cf5920023475022df', webhookTxnId);
            if (freshTxn.alreadyVerified) {
                return res.status(200).json({ success: true, message: 'Payment already verified' });
            }

            // 8. Mark webhook as verified
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                '688cf5920023475022df',
                webhookTxnId,
                {
                    api_merchants_request_id: qrRequestId,
                    alreadyVerified: true,
                }
            );

            // 9. Mark QR request as success
            const verifiedAt = new Date().toISOString().replace('Z', '+00:00');

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',
                qrRequestId,
                {
                    status: 'success',
                    paymentId: webhookTxn.paymentId,
                    txnId: webhookTxn.$id,
                    rrnNumber,
                    verifiedAt,
                    webhookReceivedAt: webhookTxn.$createdAt,
                }
            );

            // 10. Success response
            return res.status(200).json({
                success: true,
                message: 'Payment verified successfully',
                transaction: {
                    orderId: qrRequest.orderId,
                    merchantId,
                    amount: amount, // original input
                    rrnNumber,
                    paymentId: webhookTxn.paymentId,
                    txnId: webhookTxn.$id,
                    vpa: webhookTxn.vpa,
                    status: 'success',
                    receivedAt: webhookTxn.$createdAt,
                    verifiedAt,
                },
            });
            } finally {
                await releaseLock(verifyLockKey, verifyLockVal);
            }
        } catch (error) {
            console.error('Verify payment error:', error);
            return res.status(500).json({
                success: false,
                error: 'Verification failed',
            });
        }
    });

    async function generateMerchantCredentials() {
        const merchantId = 'mid_' + ID.unique().slice(-8).toUpperCase();
        const apiSecret = crypto.randomBytes(32).toString('hex');
        const hash = await bcrypt.hash(apiSecret, 12);
        return { merchantId, apiSecret, hash };
    }

    // Create Merchant Endpoint
    router.post('/admin/merchants', authenticateAdmin, async (req, res) => {
        const { name, email, vpa, dailyLimit = 100 } = req.body;
        const creds = await generateMerchantCredentials();
        await databases.createDocument(APPWRITE_DATABASE_ID, 'api_merchants', ID.unique(), {
            merchantId: creds.merchantId,
            apiSecret: creds.hash,  // Store bcrypt hash, not plain text
            name, email, vpa,
            status: true,
            dailyLimit,
        });
        // Return plain secret once — merchant must save it, we only store the hash
        res.json({ success: true, name, email, vpa, status: true, merchantId: creds.merchantId, apiSecret: creds.apiSecret });
    });

    // List Merchants Endpoint
    router.get('/admin/merchants', authenticateAdmin, async (req, res) => {
        try {
            const { search = '', status, limit = 25, cursor } = req.query;
            const queries = [
                limit ? Query.limit(parseInt(limit)) : [],
                cursor ? Query.cursorAfter(cursor) : [],
                // search ? Query.search('name', search) : [],
                // search ? Query.search('email', search) : [],
                // status ? Query.equal('status', status) : [],
                Query.orderDesc('$createdAt')
            ].flat();

            const merchants = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                queries
            );

            res.json({
                success: true,
                merchants: merchants.documents,
                total: merchants.total,
                cursor: merchants.documents.length ? merchants.documents[merchants.documents.length - 1].$id : null
            });
        } catch (error) {
            console.error('List merchants error:', error);
            res.status(500).json({ error: 'Failed to list merchants' });
        }
    });

    // ✅ Update Merchant Endpoint - Uses merchantId
    router.put('/admin/merchants/:merchantId', authenticateAdmin, async (req, res) => {
        try {
            const { merchantId } = req.params;

            // ✅ Step 1: Find document by merchant_id
            const merchantDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                [
                    Query.equal('merchantId', merchantId),  // ✅ Schema field
                    Query.limit(1)
                ]
            );

            if (!merchantDocs.documents.length) {
                return res.status(404).json({ error: 'Merchant not found' });
            }

            const merchant = merchantDocs.documents[0];
            const docId = merchant.$id;

            // Step 2: Prepare safe updates (only allowed fields)
            const { name, email, vpa, dailyLimit, status, rotateSecret } = req.body;
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (email !== undefined) updates.email = email;
            if (vpa !== undefined) updates.vpa = vpa;
            if (dailyLimit !== undefined) updates.dailyLimit = dailyLimit;
            if (status !== undefined) updates.status = status;

            // Optional: Rotate secret if requested
            let newSecret = null;
            if (rotateSecret === true) {
                newSecret = crypto.randomBytes(32).toString('hex');
                updates.apiSecret = await bcrypt.hash(newSecret, 12);
            }

            // Step 3: Update document
            const updatedMerchant = await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                docId,
                updates
            );

            res.json({
                success: true,
                merchant: updatedMerchant,
                ...(newSecret && { newApiSecret: newSecret })
            });
        } catch (error) {
            console.error('Update merchant error:', error);
            res.status(500).json({ error: 'Failed to update merchant' });
        }
    });



    // ✅ Toggle Merchant Status Endpoint (PUT - idempotent)
    router.put('/admin/merchants/:merchantId/toggle', authenticateAdmin, async (req, res) => {
        try {
            const { merchantId } = req.params;

            // ✅ Find document by merchant_id (indexed field)
            const merchantDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                [
                    Query.equal('merchantId', merchantId),  // ✅ Fixed: merchant_id (schema field)
                    Query.limit(1)
                ]
            );

            if (!merchantDocs.documents.length) {
                return res.status(404).json({ error: 'Merchant not found' });
            }

            const merchant = merchantDocs.documents[0];
            const docId = merchant.$id;
            const newStatus = !merchant.status;  // ✅ Toggle boolean

            // ✅ Update with toggled status
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                docId,
                {
                    status: newStatus,                    // ✅ Toggled value
                    $updatedAt: new Date().toISOString()   // ✅ Custom field
                }
            );

            res.json({
                success: true,
                merchantId: merchant.merchantId,
                previousStatus: merchant.status,
                newStatus: newStatus,
                statusText: newStatus ? 'Active' : 'Suspended',
                message: newStatus ? 'Merchant reactivated successfully' : 'Merchant suspended successfully'
            });
        } catch (error) {
            console.error('Toggle merchant error:', error);
            res.status(500).json({ error: 'Failed to toggle merchant status' });
        }
    });



    return router;

};

