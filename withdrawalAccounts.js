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

    async function fetchAccounts(userId) {
        return databases.listDocuments(
            APPWRITE_DATABASE_ID,
            WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
            [
                Query.equal('userId', userId),
                Query.orderDesc('$createdAt'),
                Query.limit(25)
            ]
        );
    }

    function formatAccounts(response) {
        return {
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
        };
    }

    // ✅ LIST (User): GET /user_withdrawal_accounts - Own accounts only
    router.get('/withdrawal_accounts', authenticateToken, async (req, res) => {
        try {
            const response = await fetchAccounts(req.user.userId);
            res.json(formatAccounts(response));
        } catch (error) {
            console.error('❌ List user_withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to fetch withdrawal accounts', errorDetails: error.message });
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

            // Fetch by document ID and verify ownership
            const existing = await databases.getDocument(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                accountId
            );
            if (!existing || existing.userId !== userId) {
                return res.status(404).json({ error: 'Account not found' });
            }

            // Validate lengths
            if (updates.accountNumber && updates.accountNumber.length > 25) {
                return res.status(400).json({ error: 'Account number too long' });
            }

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
            const existing = await databases.getDocument(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                accountId
            );
            if (!existing || existing.userId !== userId) {
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

    // ✅ LIST (Admin/Subadmin/Employee): GET /withdrawal_accounts?userId=xxx
    router.get('/admin_withdrawal_accounts', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
        try {
            const { userId } = req.query;
            if (!userId) return res.status(400).json({ error: 'userId query param is required' });

            const response = await fetchAccounts(userId);
            res.json(formatAccounts(response));
        } catch (error) {
            console.error('❌ List withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to fetch withdrawal accounts', errorDetails: error.message });
        }
    });

    // ✅ CREATE (Admin): POST /admin_withdrawal_accounts - Create account for any user
    router.post('/admin_withdrawal_accounts', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
        try {
            const { userId, mode, notes, upiId, holderName, accountNumber, ifscCode, bankName } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId is required' });
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
                document
            );

            res.status(201).json({
                success: true,
                message: 'Withdrawal account added successfully',
                account: { ...document, $id: response.$id, $createdAt: response.$createdAt }
            });
        } catch (error) {
            console.error('❌ Admin create withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to create withdrawal account' });
        }
    });

    // ✅ EDIT (Admin): PUT /admin_withdrawal_accounts/:accountId - Edit any account
    router.put('/admin_withdrawal_accounts/:accountId', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
        try {
            const { accountId } = req.params;
            const updates = req.body;

            console.log('Admin update request for accountId:', accountId, 'with updates:', updates);

            if (updates.accountNumber && updates.accountNumber.length > 25)
                return res.status(400).json({ error: 'Account number too long' });

            const response = await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                accountId,
                updates
            );

            res.json({ success: true, message: 'Withdrawal account updated successfully', account: response });
        } catch (error) {
            console.error('❌ Admin update withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to update withdrawal account' });
        }
    });

    // ✅ DELETE (Admin): DELETE /admin_withdrawal_accounts/:accountId - Delete any account
    router.delete('/admin_withdrawal_accounts/:accountId', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
        try {
            const { accountId } = req.params;

            await databases.deleteDocument(
                APPWRITE_DATABASE_ID,
                WITHDRAWAL_ACCOUNTS_COLLECTION_ID,
                accountId
            );

            res.json({ success: true, message: 'Withdrawal account deleted successfully' });
        } catch (error) {
            console.error('❌ Admin delete withdrawal_accounts error:', error.message);
            res.status(500).json({ error: 'Failed to delete withdrawal account' });
        }
    });

    return router;

};

