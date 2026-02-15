const express = require('express');

const router = express.Router();
const WALLET_COLLECTION_ID = 'wallet'; // Replace with your actual collection ID

const WALLET_TRANSACTIONS_COLLECTION_ID = 'walletTransactions'; // Replace with your actual collection ID
// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {

    // Define your wallet routes here, using the passed dependencies and middleware

    const QRCode = require('qrcode');
    const COMPANY_NAME = 'KitePay Pvt Ltd';
    const UPI_VPA = 'kitepay@ybl'; // Replace with your company's UPI VPA
    const vpa = UPI_VPA;

    // Helper function to generate UPI QR code
    async function generateUpiQR(userId, amount, txnId) {
        console.log('🔧 [Wallet API] Generating UPI QR for user:', userId, 'amount:', amount);
                // 3. Generate UPI deep link
        const upiLink = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(COMPANY_NAME)}&am=${amount.toFixed(2)}&cu=INR&tn=Order-${encodeURIComponent(txnId)}`;
    
        // 4. Generate QR code
        const qrBase64 = await QRCode.toDataURL(upiLink, {
            width: 300,
            margin: 1,
            color: {
                dark: '#000000',
                light: '#FFFFFF',
            },
        });
        return qrBase64;
    }

    // ✅ GET /wallet/balance
    // ✅ Debug-friendly wallet APIs
    router.get('/balance', authenticateToken, async (req, res) => {
        console.log('🔍 [Wallet API] GET /balance - userId:', req.user.userId);

        try {
            const userId = req.user.userId;
            console.log('📊 [Wallet API] Querying wallet for user:', userId);

            const walletResponse = await databases.listDocuments(
                APPWRITE_DATABASE_ID, WALLET_COLLECTION_ID,
                [Query.equal('userId', userId), Query.limit(1)]
            );

            const wallet = walletResponse.documents[0];
            const defaultWallet = {
                balance: 0, holdBalance: 0, totalRecharges: 0,
                totalWithdrawals: 0, totalAmountRecharged: 0, totalAmountWithdrawn: 0
            };

            if (!wallet) {
                console.log('⚠️ [Wallet API] No wallet found, using defaults');
                return res.json({
                    success: true,
                    walletId: null,
                    ...defaultWallet,
                    availableBalance: 0,
                });
            }

            const balance = parseFloat(wallet.balance || 0);
            const holdBalance = parseFloat(wallet.holdBalance || 0);
            const availableBalance = balance - holdBalance;

            console.log('✅ [Wallet API] Balance found:', {
                walletId: wallet.$id,
                balance,
                holdBalance,
                availableBalance
            });

            res.json({
                success: true,
                walletId: wallet.$id,
                balance,
                holdBalance,
                availableBalance,
                totalRecharges: parseInt(wallet.totalRecharges || 0),
                totalWithdrawals: parseInt(wallet.totalWithdrawals || 0),
                totalAmountRecharged: parseFloat(wallet.totalAmountRecharged || 0),
                totalAmountWithdrawn: parseFloat(wallet.totalAmountWithdrawn || 0),
            });

        } catch (error) {
            console.error('💥 [Wallet API] Balance error:', {
                userId: req.user.userId,
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Failed to fetch balance',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // ✅ GET /wallet/transactions (paginated)
    router.get('/transactions', authenticateToken, async (req, res) => {
        console.log('🔍 [Wallet API] GET /transactions - userId:', req.user.userId, 'limit:', req.query.limit, 'cursor:', req.query.cursor);

        try {
            const userId = req.user.userId;
            const limit = parseInt(req.query.limit || 25);
            const cursor = req.query.cursor;

            const queries = [
                Query.equal('userId', userId),
                Query.orderDesc('$createdAt'),
                Query.limit(limit)
            ];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            console.log('📊 [Wallet API] Executing query with', queries.length, 'conditions');

            const response = await databases.listDocuments(
                APPWRITE_DATABASE_ID, WALLET_TRANSACTIONS_COLLECTION_ID,
                queries
            );

            console.log('✅ [Wallet API] Found', response.documents.length, 'transactions, total:', response.total);

            const nextCursor = response.documents.length === limit ?
                response.documents[response.documents.length - 1].$id : null;

            res.json({
                success: true,
                transactions: response.documents.map(doc => ({
                    $id: doc.$id,
                    walletId: doc.walletId,
                    userId: doc.userId,
                    amount: parseFloat(doc.amount || 0),
                    status: doc.status,
                    type: doc.type,
                    paymentId: doc.paymentId,
                    rrnNumber: doc.rrnNumber,
                    isCredit: doc.isCredit,
                    $createdAt: doc.$createdAt,
                })),
                total: response.total,
                nextCursor
            });

        } catch (error) {
            console.error('💥 [Wallet API] Transactions error:', {
                userId: req.user.userId,
                limit: req.query.limit,
                cursor: req.query.cursor,
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Failed to fetch transactions',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // ✅ POST /wallet/recharge
    router.post('/recharge', authenticateToken, async (req, res) => {
        console.log('💰 [Wallet API] POST /recharge - userId:', req.user.userId, 'amount:', req.body.amount);

        try {
            const userId = req.user.userId;
            const { amount } = req.body;

            if (!amount || amount <= 0) {
                return res.status(400).json({ error: 'Invalid amount' });
            }

            // 1. Get/create wallet
            console.log('📥 [Wallet API] Checking wallet for user:', userId);
            let walletResponse = await databases.listDocuments(
                APPWRITE_DATABASE_ID, WALLET_COLLECTION_ID,
                [Query.equal('userId', userId)]
            );
            let wallet = walletResponse.documents[0];

            if (!wallet) {
                console.log('➕ [Wallet API] Creating new wallet for user:', userId);
                wallet = await databases.createDocument(
                    APPWRITE_DATABASE_ID, WALLET_COLLECTION_ID, ID.unique(),
                    {
                        userId,
                        balance: 0,
                        holdBalance: 0,
                        totalRecharges: 0,
                        totalWithdrawals: 0,
                        totalAmountRecharged: 0,
                        totalAmountWithdrawn: 0
                    }
                );
            }

            // 2. Create pending transaction
            console.log('📝 [Wallet API] Creating pending transaction');
            const transaction = await databases.createDocument(
                APPWRITE_DATABASE_ID, WALLET_TRANSACTIONS_COLLECTION_ID, ID.unique(),
                {
                    walletId: wallet.$id,
                    userId,
                    amount,
                    status: 'pending',
                    type: 'recharge',
                    isCredit: true,
                    description: 'UPI QR Recharge'
                }
            );

            // 3. Generate QR base64
            console.log('🖼️ [Wallet API] Generating QR code');
            const qrBase64 = await generateUpiQR(userId, amount, transaction.$id);

            console.log('✅ [Wallet API] Recharge initiated:', {
                transactionId: transaction.$id,
                walletId: wallet.$id,
                amount,
                qrLength: qrBase64.length
            });

            res.json({
                success: true,
                transactionId: transaction.$id,
                qrBase64,
                expirySeconds: 360,
                walletId: wallet.$id
            });

        } catch (error) {
            console.error('💥 [Wallet API] Recharge error:', {
                userId: req.user.userId,
                amount: req.body.amount,
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Recharge initiation failed',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // ✅ POST /wallet/transactions/:id/cancel
    router.post('/transactions/:transactionId/cancel', authenticateToken, async (req, res) => {
        console.log('⏹️ [Wallet API] POST /cancel - transactionId:', req.params.transactionId, 'userId:', req.user.userId);

        try {
            const userId = req.user.userId;
            const { transactionId } = req.params;

            console.log('📋 [Wallet API] Fetching transaction:', transactionId);
            const transaction = await databases.getDocument(
                APPWRITE_DATABASE_ID, WALLET_TRANSACTIONS_COLLECTION_ID, transactionId
            );

            if (transaction.userId !== userId) {
                console.log('🚫 [Wallet API] User mismatch:', { userId, txnUserId: transaction.userId });
                return res.status(403).json({ error: 'Unauthorized transaction' });
            }

            if (transaction.status !== 'pending') {
                console.log('🚫 [Wallet API] Invalid status:', transaction.status);
                return res.status(400).json({ error: 'Cannot cancel non-pending transaction' });
            }

            await databases.updateDocument(
                APPWRITE_DATABASE_ID, WALLET_TRANSACTIONS_COLLECTION_ID, transactionId,
                { status: 'cancelled' }
            );

            console.log('✅ [Wallet API] Transaction cancelled:', transactionId);
            res.json({ success: true });

        } catch (error) {
            console.error('💥 [Wallet API] Cancel error:', {
                transactionId: req.params.transactionId,
                userId: req.user.userId,
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                error: 'Cancel failed',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    return router;


}