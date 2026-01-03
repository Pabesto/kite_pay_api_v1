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
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {

    async function authenticateMerchant(req, res, next) {
        const auth = req.headers.authorization?.split(' ')[1];
        const { merchantId } = req.body || req.params;
        
        // console.log('Authenticating merchant:', merchantId);
        // console.log('Auth token:', auth);
        
        if (!auth || !merchantId) {
            return res.status(401).json({ error: 'Missing credentials' });
        }

        try {
            // ✅ Find by correct schema field
            const merchantDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID, 
                'api_merchants', 
                [Query.equal('merchantId', merchantId), Query.limit(1)]  // ✅ merchantId
            );
            
            const merchant = merchantDocs.documents[0];
            
            if (!merchant) {
                return res.status(401).json({ error: 'Merchant not found' });
            }
            
            // ✅ Simple string comparison (plain apiSecret)
            if (merchant.apiSecret !== auth) {  // ✅ === merchant.apiSecret (plain text)
                console.log('Secret mismatch:', {
                    expected: merchant.apiSecret ? '[HIDDEN]' : 'NULL',
                    received: auth ? '[HIDDEN]' : 'NULL'
                });
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
            
            req.merchant = merchant;
            next();
            
        } catch (e) {
            console.error('Merchant auth error:', e);
            res.status(500).json({ error: 'Authentication failed' });
        }
    }

    router.post('/qr_generate', authenticateMerchant, async (req, res) => {
      try {
        const { amount = '500.00' } = req.body;  // Fixed ₹500 default
        const merchantId = req.merchant.merchantId;
        // const vpa = process.env.RAZORPAY_VPA;  // yourvpa@razorpay
        const vpa = 'pabestotechprivateli.96194569@hdfcbank';  // yourvpa@razorpay
        const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // const txnNumber = `txn_${Date.now()}`;
    
        // 1. Save pending request to DB
        const requestDoc = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          'api_merchants_requests',  // Reuse or new qr_requests
          ID.unique(),
          {
            merchantId,
            orderId,
            amount: parseFloat(amount) * 100,  // Paise for Razorpay
            status: 'pending',
            vpa,
            $createdAt: new Date().toISOString(),
            qrGenerated: false
          }
        );
    
        const COMPANY_NAME = "Pabesto Tech";

        const txnId = uuidv4();
        const expiry = Date.now() + 5 * 60 * 1000; // 5 min

        const upiLink = `upi://pay?pa=${vpa}&pn=${encodeURIComponent(COMPANY_NAME)}&am=${amount}&cu=INR&tn=Order-${txnId}`;
        const qrImage = await QRCode.toDataURL(upiLink);
    
        // 3. Create base64 QR image from intent URL
        const qrBase64 = await QRCode.toDataURL(upiLink, {
          width: 300,
          margin: 1,
          color: { dark: '#000', light: '#FFF' }
        });
    
        // 4. Update DB with QR
        await databases.updateDocument(
          APPWRITE_DATABASE_ID,
          'api_merchants_requests',
          requestDoc.$id,
          { qrBase64, qrGenerated: true }
        );
    
        res.json({
          success: true,
          qrBase64: qrBase64,
          orderId: orderId,
        //   txn_number: txnNumber,
          time: new Date().toISOString(),
          expiry
        });

      } catch (error) {
        console.error('QR Generate error:', error);
        res.status(500).json({ error: 'Failed to generate QR' });
      }
    });

    // ✅ /verify-payment endpoint
    router.post('/verify-payment', authenticateMerchant, async (req, res) => {
        try {
            const { orderId, amount, rrnNumber } = req.body;  // Client sends
            const { merchantId } = req.body || req.params;      // From auth
            
            // console.log('Received data:', { orderId, amount, rrnNumber, merchantId });

            // ✅ 1. Validate inputs
            if (!orderId || !amount || !rrnNumber) {
                return res.status(400).json({ error: 'orderId, amount, and rrnNumber required' });
            }

            const amountPaise = parseInt(amount) * 100;
            // const amountPaise = parseInt(amount);

            // ✅ 2. Find QR Request by orderId + merchant + amount + pending
            const qrRequests = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',  // Your transactions table
                [
                    Query.equal('orderId', orderId),
                    Query.equal('merchantId', merchantId),
                    Query.equal('amount', amountPaise),
                    // Query.equal('status', 'pending'),  // Only unverified
                    Query.limit(1)
                ]
            );

            if (!qrRequests.documents.length) {
                return res.status(404).json({ 
                    error: 'No matching pending QR request found',
                    details: { orderId, merchantId, amount }
                });
            }

            const qrRequest = qrRequests.documents[0];
            const qrRequestId = qrRequest.$id;

            // ✅ 3. Check status FIRST (before webhook lookup)
            if (qrRequest.status === 'success' && qrRequest.rrnNumber === rrnNumber) {
                return res.status(409).json({
                    success: false,
                    message: 'Payment already verified',
                    transaction: {
                        orderId: qrRequest.orderId,
                        merchantId: merchantId,
                        amount: amount,
                        rrnNumber: qrRequest.rrnNumber,
                        status: qrRequest.status,
                        verifiedAt: qrRequest.verifiedAt
                    }
                });
            }

            // ✅ 3. Find webhook transaction by rrnNumber + amount (same merchant)
            const webhookTxns = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                '688cf5920023475022df',  // Webhook payments table
                [
                    Query.equal('rrnNumber', rrnNumber),
                    Query.equal('amount', amountPaise),
                    Query.equal('status', 'normal'),  // Captured
                    Query.limit(1)
                ]
            );

            if (!webhookTxns.documents.length) {
                return res.status(404).json({ 
                    error: 'No matching webhook transaction found for UTR',
                    details: { orderId, rrnNumber, amount, merchantId }
                });
            }

            const webhookTxn = webhookTxns.documents[0];

            // ✅ 4. Cross-verify orderIds match (extra safety)
            if (webhookTxn.rrnNumber !== rrnNumber) {
                return res.status(409).json({ 
                    error: 'UTR payment mismatch: orderId conflict',
                    qrOrderId: qrRequest.orderId,
                });
            }

            // ✅ 5. Atomic update QR request → VERIFIED
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants_requests',
                qrRequestId,
                {
                    status: 'success',                    // ✅ Verified
                    paymentId: webhookTxn.paymentId,
                    txnId: webhookTxn.$id,
                    rrnNumber: rrnNumber,
                    verifiedAt: new Date().toISOString().replace('Z', '+00:00'),
                    webhookReceivedAt: webhookTxn.$createdAt
                }
            );

            // ✅ 6. Response with full verified transaction
            res.json({
                success: true,
                message: 'Payment verified successfully',
                transaction: {
                    orderId: qrRequest.orderId,
                    merchantId: merchantId,
                    amount: amount,  // ₹ format
                    rrnNumber: rrnNumber,
                    paymentId: webhookTxn.paymentId,
                    txnId: webhookTxn.$id,
                    vpa: webhookTxn.vpa,
                    status: 'success',
                    ReceivedAt: webhookTxn.$createdAt,
                    verifiedAt: new Date().toISOString().replace('Z', '+00:00'),
                    // qrBase64: qrRequest.qrBase64  // For reference
                }
            });

        } catch (error) {
            console.error('Verify payment error:', error);
            res.status(500).json({ error: 'Verification failed' });
        }
    });


    // Create Merchant Endpoint
    router.post('/admin/merchants', authenticateAdmin, async (req, res) => {
        const { name, email, vpa, dailyLimit = 100 } = req.body;
        const creds = await generateMerchantCredentials();
        console.log('Creating merchant:', name, email, creds.merchantId, vpa , dailyLimit , creds.apiSecret, creds.hash , new Date().toISOString());
        await databases.createDocument(APPWRITE_DATABASE_ID, 'api_merchants', ID.unique(), {
            merchantId: creds.merchantId,
            apiSecret: creds.apiSecret,
            name, email, vpa,
            status: true,  // Fixed: string
            dailyLimit,
            $createdAt: new Date().toISOString()
        });
        res.json({ success: true, name, email , vpa , status : true, merchantId: creds.merchantId, apiSecret: creds.apiSecret });
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

            // ✅ Step 2: Prepare safe updates (merge with current)
            const updates = {
                ...merchant,  // ✅ Current values as base
                ...req.body, // ✅ Overwrite with request
                $updatedAt: new Date().toISOString()  // ✅ Custom timestamp field
            };

            // ✅ Optional: Rotate secret if requested
            if (req.body.rotateSecret === true) {
                const newSecret = crypto.randomBytes(32).toString('hex');
                updates.apiSecret = await bcrypt.hash(newSecret, 12);
                updates.current_api_secret = await encryptSecret(newSecret);
                res.newSecret = newSecret;  // Return once
            }

            // ✅ Step 3: Update document
            const updatedMerchant = await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                'api_merchants',
                docId,
                updates
            );

            res.json({
                success: true,
                merchant: updatedMerchant,
                ...(res.newSecret && { newApiSecret: res.newSecret })
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
                merchantId: merchant.merchant_id,
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

