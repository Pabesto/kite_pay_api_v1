// -----------------------------------------------------------------------------------------------------
// withdrawalAccounts.js
// This file contains the API endpoints for withdrawalAccounts.

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

const WITHDRAWAL_ACCOUNTS_COLLECTION_ID = 'withdrawal_accounts'; // Replace with your actual collection ID

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, Withdrawal_request_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole) => {

    // Define your withdrawalAccounts routes here, using the passed dependencies and middleware
    // ✅ LIST: GET /withdrawal_accounts - User's own accounts only
    router.get('/withdrawal_accounts', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            
            const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID, // or your DATABASE_ID
            WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
            [
                Query.equal('userId', userId),
                Query.orderDesc('$createdAt'),
                Query.limit(25)
                // Add cursor: Query.cursorAfter(req.query.cursor) for pagination if needed
            ]
            );

            if(response.documents.length === 0) {
                return res.json({
                    success: true,
                    accounts: [],
                    total: 0
                });
            }

            res.json({
            success: true,
            accounts: response.documents.map(doc => ({
                $id: doc.$id,
                userId: doc.userId,
                mode: doc.mode,
                notes: doc.notes,
                upiId: doc.upiId,
                holderName: doc.holderName,
                accountNumber: doc.accountNumber,
                ifscCode: doc.ifscCode,
                bankName: doc.bankName,
                $createdAt: doc.$createdAt,
                $updatedAt: doc.$updatedAt
            })),
            total: response.total,
            nextCursor: response.documents.length === 25 ? response.documents[response.documents.length - 1].$id : null
            });

        } catch (error) {
            console.error('❌ List withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to fetch withdrawal accounts' , errorDetails: error.message});
        }
    });


    // ✅ CREATE: POST /withdrawal_accounts - Add new account (with validation)
    router.post('/withdrawal_accounts', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { mode, notes, upiId, holderName, accountNumber, ifscCode, bankName } = req.body;

            // Basic validation (add more as needed)
            if (!mode) return res.status(400).json({ error: 'Mode is required' });
            if (accountNumber && accountNumber.length > 25) return res.status(400).json({ error: 'Account number too long' });
            if (ifscCode && ifscCode.length > 25) return res.status(400).json({ error: 'IFSC code too long' });

            const document = {
                userId,
                mode,
                notes: notes || null,
                upiId: upiId || null,
                holderName: holderName || null,
                accountNumber: accountNumber || null,
                ifscCode: ifscCode || null,
                bankName: bankName || null
            };

            const response = await databases.createDocument(
            APPWRITE_DATABASE_ID,
            WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
            ID.unique(),
            document,
            // [
            //     Permission.read(Role.user(userId)),
            //     Permission.update(Role.user(userId)),
            //     Permission.delete(Role.user(userId))
            // ]
            );

            res.status(201).json({
                success: true,
                message: 'Withdrawal account added successfully',
                account: { ...document, $id: response.$id, $createdAt: response.$createdAt }
            });
        } catch (error) {
            console.error('❌ Create withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to create withdrawal account' });
        }
    });


    // ✅ EDIT (UPDATE): PUT /withdrawal_accounts/:accountId
    router.put('/withdrawal_accounts/:accountId', authenticateToken, async (req, res) => {
        try {
            const { accountId } = req.params;
            const userId = req.user.userId;
            const updates = req.body; // { notes, upiId, etc. }

            // Optional: Fetch first to verify ownership (extra security)
            const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
            [Query.equal('userId', userId), Query.equal('$id', accountId), Query.limit(1)]
            );
            if (existing.documents.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
            }

            // Validate lengths
            if (updates.accountNumber && updates.accountNumber.length > 25) {
            return res.status(400).json({ error: 'Account number too long' });
            }
            // Add other validations...

            const response = await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
            accountId,
            updates
            );

            res.json({
            success: true,
            message: 'Withdrawal account updated successfully',
            account: response
            });
        } catch (error) {
            console.error('❌ Update withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to update withdrawal account' });
        }
    });

    // ✅ DELETE: DELETE /withdrawal_accounts/:accountId
    router.delete('/withdrawal_accounts/:accountId', authenticateToken, async (req, res) => {
        try {
            const { accountId } = req.params;
            const userId = req.user.userId;

            // Verify ownership
            const existing = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                [Query.equal('userId', userId), Query.equal('$id', accountId), Query.limit(1)]
            );

            if (existing.documents.length === 0) {
                return res.status(404).json({ error: 'Account not found' });
            }

            await databases.deleteDocument(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                accountId
            );

            res.json({
            success: true,
            message: 'Withdrawal account deleted successfully'
            });
        } catch (error) {
            console.error('❌ Delete withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to delete withdrawal account' });
        }
    });


    return router;

};

