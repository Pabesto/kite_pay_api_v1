// -----------------------------------------------------------------------------------------------------
// routes/qrcode.js
// This file contains the API endpoints for QR code management.

const express = require('express');
const { ID, Query } = require('node-appwrite');
const Razorpay = require("razorpay");
const fs = require("fs");
const axios = require("axios");
const { File } = require('buffer');
const userMetaCache = require('./userMetaCache');
const qrOwnerCache = require('./qrOwnerCache');
const path = require('path');
const moment = require('moment-timezone');

const ConfigManager = require('./configManager'); // for the `integrations` allow-list
const { updateDashboardCounter } = require('./dashboardCounters');
const { type } = require('os');
const { compare } = require('bcrypt');

// Production mode
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Mirrors the Appwrite enum on the qr_codes `type` attribute. Keep in sync with the
// collection — an unlisted value makes createDocument throw "invalid format".
const QR_TYPES = ['paytm', 'pinelabs', 'cashfree', 'razorpay', 'other'];

// We will now pass the required dependencies and middleware from the main server file
module.exports = (APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, bucketId,APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, roleAuth, requireRole) => {
    const router = express.Router();

    async function getUserName(userId) {
        try {
            const user = await users.get(userId);
            return user.name || null;
        } catch (err) {
            console.error("Error fetching user name:", err.message);
            return null;
        }
    }

    async function getUserEmail(userId) {
        try {
            const user = await users.get(userId);
            return user.email || null;
        } catch (err) {
            console.error("Error fetching user email:", err.message);
            return null;
        }
    }

    async function getUserDetails(userId) {
        try {
            const user = await users.get(userId); // one API call
            return {
            name: user.name || null,
            email: user.email || null,
            };
        } catch (err) {
            console.error("Error fetching user details:", err.message);
            return { name: null, email: null };
        }
    }

    async function getUser(userId) {
        try {
            const User = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal('userId', userId)]
            );
            if (User.documents.length === 0) {
                return null;
            }
            return User.documents[0];
        } catch (err) {
            console.error("Error fetching getUser:", err.message);
            return null;
        }
    }

    async function assignQrToUser({qrId, assignedUserId, managedByUserId = null}) {
        // Find the QR document by qrId
        const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', qrId)
        ]);

        if (docResult.documents.length === 0) {
            throw new Error("QR Code not found");
        }

        const docId = docResult.documents[0].$id;

        // Update assignment
        if(managedByUserId){
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                docId,
                { assignedUserId: assignedUserId === '' ? null : assignedUserId }
            );
        }else{
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                docId,
                { assignedUserId: assignedUserId === '' ? null : assignedUserId }
            );
        }
        

        return { success: true, docId };
    }

    async function assignQrToUserNew({ qrId, assignedUserId, managedByUserId = null }) {
        // 1) Lookup QR by qrId
        const qrDocs = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', qrId)
        ]);
        if (!qrDocs.documents.length) throw new Error('QR Code not found');

        const qr = qrDocs.documents[0];

        // 2) Build update payload
        const payload = {};
        // normalize empty string -> null
        const normalizedAssigned = (assignedUserId === '' ? null : assignedUserId) ?? null;

        if (managedByUserId) {
            // transfer or first assignment by admin to merchant
            payload.managedByUserId = managedByUserId;
            payload.assignedUserId = normalizedAssigned ?? managedByUserId; // choose policy
            // Option: if merchant-level assignment, default assignment to merchant
        } else {
            // internal reassignment within same merchant
            payload.assignedUserId = normalizedAssigned;
        }

        // 5) Update once
        const updated = await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
            qr.$id,
            payload
        );

        // 6) Emit audit log (optional)
        // await logAssignmentEvent({ actorId, qrId: qr.$id, old: qr, new: updated });

        return { success: true, docId: updated.$id };
    }

    // GET all QR codes For Admin and Employees
    // This is a public endpoint
    router.get('/qr-codes', authenticateAdminOrLabel('view_qr_codes', { isSubadminAllowed: true }), async (req, res) => {
        try {
            const { limit = 50, cursor } = req.query;
            const limitNum = Math.min(parseInt(limit) || 25, 100);

            let resultAllQr = [];
            let roleFilters = [];

            if (req.user.role === 'employee') {
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('assigned_to', req.user.$id),
                        Query.equal('role', 'subadmin'),
                        Query.limit(100)
                    ]
                );

                const merchantIds = merchantsRes.documents.map(d => d.userId);

                let queries = [];
                let orQueries = [];

                if(merchantIds.length === 0){
                    return res.status(500).json({ message: "Failed to fetch QR codes No Merchants assigned." });
                }else if(merchantIds.length === 1){
                    queries.push(Query.equal('parentId', merchantIds[0]));
                }else{
                    merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                    queries.push(Query.or(orQueries));
                }

                const usersRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    queries
                );

                queries = [];

                const userIds = usersRes.documents.map(d => d.userId);

                let orQueries2 = [];

                merchantIds.forEach(id => orQueries2.push(Query.equal('assignedUserId', id)));
                userIds.forEach(id => orQueries2.push(Query.equal('assignedUserId', id)));

                // Also include QR codes not assigned to anyone
                orQueries2.push(Query.and([
                    Query.isNull('assignedUserId'),
                    Query.isNull('managedByUserId'),
                ]));

                roleFilters.push(Query.or(orQueries2));

            } else if(req.user.role === 'subadmin'){
                console.log('Subadmin fetching QR codes for userId:', req.user.userId);

                const usersUnderSubadmin = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('parentId', req.user.userId),
                        Query.equal('role', 'user'),
                        Query.limit(100)
                    ]
                );

                const usersUnderSubadminIds = usersUnderSubadmin.documents.map(d => d.userId);

                let queriesUser = [];

                if(usersUnderSubadminIds.length === 0){
                    return res.status(500).json({ message: "Failed to fetch Qr No Users assigned.", error: "Qr Fetch Failed" });
                }else if(usersUnderSubadminIds.length === 1){
                    roleFilters.push(Query.or([
                        Query.equal('assignedUserId', usersUnderSubadminIds[0]),
                        Query.equal('managedByUserId', req.user.userId)
                    ]));
                }else{
                    usersUnderSubadminIds.forEach(id => queriesUser.push(Query.equal('assignedUserId', id)));
                    queriesUser.push(Query.equal('managedByUserId', req.user.userId));
                    roleFilters.push(Query.or(queriesUser));
                }

            }

            // Build final query with pagination
            const finalQueries = [
                ...roleFilters,
                Query.orderDesc('createdAt'),
                Query.limit(limitNum),
            ];
            if (cursor) {
                if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                    return res.status(400).json({ error: 'Invalid cursor format' });
                }
                finalQueries.push(Query.cursorAfter(cursor));
            }

            resultAllQr = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, finalQueries);

            const qrCodes = resultAllQr.documents.map(doc => ({
                $id: doc.$id,
                qrId: doc.qrId,
                companyName: doc.companyName || null,
                integrationName: doc.integrationName || null,
                fileId: doc.fileId,
                imageUrl: doc.imageUrl,
                assignedUserId: doc.assignedUserId || null,
                managedByUserId: doc.managedByUserId || null,
                createdAt: doc.createdAt,
                isActive: doc.isActive,
                totalTransactions : doc.totalTransactions || 0,
                totalPayInAmount : doc.totalPayInAmount || 0,
                withdrawalRequestedAmount : doc.withdrawalRequestedAmount || 0,
                withdrawalApprovedAmount : doc.withdrawalApprovedAmount || 0,
                amountAvailableForWithdrawal : doc.amountAvailableForWithdrawal || 0,
                amountOnHold : doc.amountOnHold || 0,
                commissionOnHold : doc.commissionOnHold || 0,
                commissionPaid : doc.commissionPaid || 0,
            }));

            const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            const yesterdayDate = new Date();
            yesterdayDate.setDate(yesterdayDate.getDate() - 1);
            const yesterdayISO = yesterdayDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

            // Fetch daily aggregate docs for today and yesterday
            const [dailySummaryDocs, yesterdaySummaryDocs] = await Promise.all([
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', todayISO), Query.limit(1),
                ]),
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', yesterdayISO), Query.limit(1),
                ]),
            ]);

            let todayTotalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                todayTotalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in daily summary (read-only) —', e.message);
            }
            }

            let yesterdayTotalsObj = {};
            if (yesterdaySummaryDocs.total > 0) {
            try {
                yesterdayTotalsObj = JSON.parse(yesterdaySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in yesterday summary (read-only) —', e.message);
            }
            }

            // Map today and yesterday totals to each QR code
            const qrCodesWithTotals = qrCodes.map(qr => ({
                ...qr,
                todayTotalPayIn: todayTotalsObj[qr.qrId] || 0,
                yesterdayTotalPayIn: yesterdayTotalsObj[qr.qrId] || 0,
            }));

            const nextCursor = qrCodesWithTotals.length === limitNum ? qrCodesWithTotals[qrCodesWithTotals.length - 1].$id : null;

            return res.status(200).json({ qrCodes: qrCodesWithTotals, nextCursor });

        } catch (error) {
            console.error('Error fetching QR codes:', error);
            return res.status(500).json({ message: "Failed to fetch QR codes.", error: error.message });
        }
    });

    async function saveQrEntry({
        qrId,
        qrType,
        companyName,
        integrationName = null,
        fileId,
        imageUrl,
        createdByUserId,
        createdAt,
        assignedUserId = null,
        }) {

            console.log('Saving QR Entry:', {
                qrId,
                qrType,
                companyName,
                integrationName,
            });

        // After successful creation:
        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsUploaded', 1).catch(console.error);

        // Increment type-specific counter
        if (qrType === 'pinelabs') {
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPinelabsQrs', 1).catch(console.error);
        } else if (qrType === 'paytm') {
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPaytmQrs', 1).catch(console.error);
        } else {
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalOtherQrs', 1).catch(console.error);
        }

        if (assignedUserId) {
            // You may want to check if assignedUserId is a merchant
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', 1).catch(console.error);
        }

        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesActive', 1).catch(console.error);

        return await databases.createDocument(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
            ID.unique(),
            {
            qrId,
            // enum attribute — omit rather than write null/'' when the caller sent no type
            ...(qrType ? { type: qrType } : {}),
            companyName,
            ...(integrationName ? { integrationName } : {}),
            fileId,
            imageUrl,
            assignedUserId,
            createdByUserId,
            isActive: true,
            createdAt,
            }
        );
    }

    // POST a new QR code entry
    // This is an admin-only endpoint
    router.post('/create-qr-entry', authenticateAdmin, async (req, res) => {
        const { companyName, fileId, imageUrl , createdAt } = req.body;
        // integrationName is free text in Appwrite, but must be one of the admin-managed
        // `integrations` config values. Empty config = no list configured = skip the check.
        const integrations = ConfigManager.get('integrations', []);
        const rawIntegration = req.body.integrationName == null ? null : String(req.body.integrationName).trim();
        // store the config's canonical casing so listings don't drift ("Paytm" vs "paytm")
        const integrationName = rawIntegration
            ? (integrations.find(i => i.toLowerCase() === rawIntegration.toLowerCase()) || rawIntegration)
            : null;
        // qrIds are stored lowercase so every later compare (ingest, extension qrRef) is case-insensitive by construction.
        const qrId = String(req.body.qrId || '').trim().toLowerCase();
        // `type` is an Appwrite enum: normalise casing, then reject anything unlisted with a 400
        // instead of letting createDocument fail with a 500. Omitted stays omitted (legacy behaviour).
        const qrType = req.body.qrType == null ? null : String(req.body.qrType).trim().toLowerCase();

        // console.log('Create QR Entry request body:', req.body);

        if (!qrId || !fileId || !imageUrl) {
            return res.status(400).json({ message: "Missing required fields: qrId, fileId, or imageUrl." });
        }

        if (qrType !== null && !QR_TYPES.includes(qrType)) {
            return res.status(400).json({ message: `Invalid qrType ${JSON.stringify(req.body.qrType)}. Must be one of: ${QR_TYPES.join(', ')}.` });
        }

        if (integrationName && integrations.length && !integrations.includes(integrationName)) {
            return res.status(400).json({ message: `Invalid integrationName ${JSON.stringify(req.body.integrationName)}. Must be one of: ${integrations.join(', ')}.` });
        }

        try {

            // ✅ 1. Check if qrId already exists
            const existing = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
                [Query.equal("qrId", qrId)]
            );

            if (existing.total > 0) {
                return res.status(400).json({ message: `QR Code ID "${qrId}" already exists.` });
            }

            const newQrCode = await saveQrEntry({
                qrId,
                qrType,
                companyName,
                integrationName,
                fileId,
                imageUrl,
                createdByUserId: req.user.userId, // set by your JWT middleware
                createdAt,
            });

            // 2. If assignedUserId is provided, update user prefs
            // if (assignedUserId) {
            //     await users.updatePrefs(assignedUserId, {
            //         qrId,
            //         fileId
            //     });
            // }

            // Refresh this QR's owner in the cache so new payments are attributed immediately.
            qrOwnerCache.reload(qrId).catch(e => console.error('qrOwnerCache.reload (create) failed:', e.message));

            return res.status(201).json({ message: "QR Code entry created successfully.", qrCode: newQrCode });
        } catch (error) {
            console.error('Error creating QR code entry:', error);
            return res.status(500).json({ message: "Failed to create QR code entry.", error: error.message });
        }
    });

    // DELETE a QR code
    // This is an admin-only endpoint
    router.delete('/delete-qr/:qrId', authenticateAdmin, async (req, res) => {
        const { qrId } = req.params;

        try {
            const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('qrId', qrId)
            ]);
            
            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: "QR Code not found." });
            }

            const doc = docResult.documents[0];

            if(doc.assignedUserId !== null){
                return res.status(400).json({ message: "Cannot delete a QR code assigned to a user. Please unassign it first." });
            }

            const fileId = doc.fileId;
            const docId = doc.$id;

            await storage.deleteFile(bucketId, fileId);
            await databases.deleteDocument(APPWRITE_DATABASE_ID, Qr_collectionId, docId);

            // Drop this QR from the owner cache (no longer exists).
            qrOwnerCache.invalidateQr(qrId);

            // Decrement dashboard counters
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsUploaded', -1).catch(console.error);

            // Decrement type-specific counter
            if (doc.type === 'pinelabs') {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPinelabsQrs', -1).catch(console.error);
            } else if (doc.type === 'paytm') {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPaytmQrs', -1).catch(console.error);
            } else {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalOtherQrs', -1).catch(console.error);
            }

            // Decrement assigned counter if assigned
            if (doc.assignedUserId) {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', -1).catch(console.error);
            }

            // Decrement active/disabled counters
            if (doc.isActive === true) {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesActive', -1).catch(console.error);
            } else {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesDisabled', -1).catch(console.error);
            }

            return res.status(200).json({ message: "QR Code and file deleted successfully." });
        } catch (error) {
            console.error('Error deleting QR code:', error);
            return res.status(500).json({ message: "Failed to delete QR code.", error: error.message });
        }
    });

    // PATCH a QR code entry  
    // This is an admin-only endpoint
    router.patch('/edit-qr/:qrId', authenticateAdmin, async (req, res) => {
        const { qrId } = req.params;
        const { qrType, companyName, integrationName, fileId, imageUrl } = req.body;

        console.log('Edit QR Entry request:', { qrId, qrType, companyName, integrationName, fileId, imageUrl });

        // Validate at least one field is provided for update
        if (!qrType && !companyName && !integrationName && !fileId && !imageUrl) {
            return res.status(400).json({ message: "At least one field (qrType, companyName, integrationName, fileId, or imageUrl) must be provided for update." });
        }

        try {
            // 1. Find the QR document by qrId
            const docResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal('qrId', qrId)]
            );

            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: `QR Code ID "${qrId}" not found.` });
            }

            const doc = docResult.documents[0];
            const docId = doc.$id;
            const oldFileId = doc.fileId;

            // 2. Build update payload with only provided fields
            const updatePayload = {};
            if (qrType !== undefined) updatePayload.qrType = qrType;
            if (companyName !== undefined) updatePayload.companyName = companyName;
            // Free-text tag, same treatment as companyName. Admin-only via the route's
            // authenticateAdmin middleware. Appwrite column: integrationName (text, optional).
            if (integrationName !== undefined) updatePayload.integrationName = integrationName;
            if (fileId !== undefined) updatePayload.fileId = fileId;
            if (imageUrl !== undefined) updatePayload.imageUrl = imageUrl;

            // 4. Update the QR document
            const updatedQr = await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                docId,
                updatePayload
            );

            // 3. If fileId changed, delete old file (if different)
            if (fileId && fileId !== oldFileId) {
                try {
                    await storage.deleteFile(bucketId, oldFileId);
                    console.log(`Deleted old file: ${oldFileId}`);
                } catch (fileError) {
                    if (fileError.code === 404) {
                        console.log(`Old file ${oldFileId} not found, continuing...`);
                    } else {
                        throw fileError;
                    }
                }
            }

            // // 5. Update dashboard counters if type changed
            // if (qrType && qrType !== doc.qrType) {
            //     // Decrement old type counter
            //     if (doc.qrType === 'pinelabs') {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPinelabsQrs', -1).catch(console.error);
            //     } else if (doc.qrType === 'paytm') {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPaytmQrs', -1).catch(console.error);
            //     } else {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalOtherQrs', -1).catch(console.error);
            //     }

            //     // Increment new type counter
            //     if (qrType === 'pinelabs') {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPinelabsQrs', +1).catch(console.error);
            //     } else if (qrType === 'paytm') {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalPaytmQrs', +1).catch(console.error);
            //     } else {
            //         await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalOtherQrs', +1).catch(console.error);
            //     }
            // }

            return res.status(200).json({ 
                message: "QR Code updated successfully.", 
                qrCode: updatedQr 
            });

        } catch (error) {
            console.error('Error editing QR code entry:', error);
            return res.status(500).json({ message: "Failed to update QR code entry.", error: error.message });
        }
    });

    // PUT to toggle the isActive status
    // This is an admin-only endpoint
    router.put('/toggle-qr-status/:qrId', authenticateAdminOrLabel('toggle_qr_status', { isSubadminAllowed: false }), async (req, res) => {
        const { qrId } = req.params;
        const { isActive } = req.body;

        const userRequested = req.user; // set by your JWT middleware

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: "Invalid value for 'isActive'." });
        }

        try {
            const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('qrId', qrId)
            ]);

            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: "QR Code not found." });
            }

            if(userRequested.role === 'subadmin'){
                if(docResult.documents[0].createdByUserId !== userRequested.$id){
                    return res.status(403).json({ message: 'Forbidden: Cannot edit QR codes not created by you' });
                }
                if(isActive === true){
                    return res.status(403).json({ message: 'Forbidden: Subadmin cannot toggle QR codes Status' });
                }
            } else {    
                // sub-admins can only edit QR codes they created
            }

            const docId = docResult.documents[0].$id;

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                docId,
                { isActive }
            );

            // Update dashboard counters
            if (isActive === true) {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesActive', 1).catch(console.error);
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesDisabled', -1).catch(console.error);
            } else {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesActive', -1).catch(console.error);
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'qrCodesDisabled', 1).catch(console.error);
            }

            return res.status(200).json({ message: "QR Code status updated successfully." });
        } catch (error) {
            console.error('Error toggling QR code status:', error);
            return res.status(500).json({ message: "Failed to update QR code status.", error: error.message });
        }
    });

    // PUT to assign a user to a QR code
    router.put('/assign-qr-user/:qrId', authenticateAdminOrLabel('assign_qr_codes', { isSubadminAllowed: true }), async (req, res) => {
        const { qrId } = req.params;
        const { assignedUserId } = req.body; // may be null (unassign)
        const actor = req.user;

        try {
            const qrDocs = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('qrId', qrId),
                Query.limit(1),
            ]);

            if (!qrDocs.documents.length) return res.status(404).json({ message: 'QR Code not found.' });

            const qr = qrDocs.documents[0];
            const prevAssigned = qr.assignedUserId || null;

            // Normalize input
            const normalizedAssigned = assignedUserId === '' ? null : assignedUserId ?? null;

            // Validate assignee (if not unassign)
            if (normalizedAssigned) {
                    const assignee = await getUser(normalizedAssigned); // implement
                if (!assignee) return res.status(400).json({ message: 'Assignee not found.' });

                // If QR has an owner, assignee must be under that owner
                if (qr.managedByUserId && assignee.parentId !== qr.managedByUserId) {
                    return res.status(409).json({ message: 'Assignee not under QR’s manager.' });
                }
                // Optional: if MANAGED is null and your rule treats it as subadmin-owned, validate against ownerSubadminId
                // if (!qr.managedByUserId && assignee.parentId !== qr.ownerSubadminId) { ... }
            }

            // Update only assignedUserId
            const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                assignedUserId: normalizedAssigned,
            });

            // Counters for "assigned" state
            const newAssigned = updated.assignedUserId || null;
            if (!prevAssigned && newAssigned) {
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', 1).catch(console.error);
            } else if (prevAssigned && !newAssigned) {
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', -1).catch(console.error);
            }

            // Assignee changed → recompute this QR's owner in the cache.
            qrOwnerCache.reload(qrId).catch(e => console.error('qrOwnerCache.reload (assign-user) failed:', e.message));

            return res.status(200).json({ message: 'Assignee updated.' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ message: 'Failed to update assignee.', error: e.message });
        }
    });

    // PUT /assign-qr-manager/:qrId
    // Body: { managedByUserId: string | '' | null }
    // Behavior:
    // - managedByUserId === null or '' => unlink_block: allowed only if assignedUserId is null
    // - managedByUserId is a valid id => transfer with strict block:
    //     - if assignedUser exists and assignee.parentId !== managedByUserId => 409 block
    //     - if assignedUser missing and was expected => 409 block
    //     - if assignedUser null or in-scope => proceed
    router.put('/assign-qr-manager/:qrId', authenticateAdminOrLabel('assign_qr_codes'), async (req, res) => {
        const { qrId } = req.params;
        const { managedByUserId: rawManaged } = req.body;

        try {

            // Normalize: '' -> null
            const normalizedManaged = (rawManaged === '' ? null : (rawManaged ?? null));

            // Load QR
            const qrDocs = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', qrId),
            Query.limit(1),
            ]);
            if (!qrDocs.documents.length) return res.status(404).json({ message: 'QR Code not found.' });
            const qr = qrDocs.documents[0];

            const prevAssigned = qr.assignedUserId || null;

            // UNLINK (unlink_block)
            if (normalizedManaged === null) {
            if (qr.assignedUserId) {
                return res.status(409).json({
                code: 'UNLINK_BLOCKED_ASSIGNED',
                message: 'Cannot clear manager while QR is assigned; unassign first.',
                });
            }
            const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                managedByUserId: null
            });
            qrOwnerCache.reload(qrId).catch(e => console.error('qrOwnerCache.reload (unlink-manager) failed:', e.message));
            return res.status(200).json({ message: 'Manager unlinked.', updated });
            }

            // TRANSFER (block strategy)
            // Only admin can transfer a QR that already has a manager
            if (qr.managedByUserId && qr.managedByUserId !== normalizedManaged && req.user.role !== 'admin') {
                return res.status(403).json({ message: 'Only admin can transfer QR to a different manager.' });
            }

            // Validate target manager
            const manager = await getUser(normalizedManaged);
            if (!manager) return res.status(400).json({ message: 'Manager not found.' });

            // If currently assigned, the assignee must be under the new manager
            if (qr.assignedUserId) {
            const assignee = await getUser(qr.assignedUserId);
            if (!assignee) {
                return res.status(409).json({
                code: 'ASSIGNEE_NOT_FOUND',
                message: 'Existing assignee not found; reassign or unassign first.',
                });
            }
            if (assignee.parentId !== normalizedManaged) {
                return res.status(409).json({
                code: 'ASSIGNEE_OUT_OF_SCOPE',
                message: 'Assignee not under new manager; reassign or unassign first.',
                details: {
                    qrId,
                    assigneeId: assignee.$id,
                    assigneeParentId: assignee.parentId ?? null,
                    targetManagerId: normalizedManaged,
                },
                });
            }
            }

            // Normal policy:
            // - Set managedByUserId to the new manager.
            // - If currently unassigned, default-assign to the manager (optional; keep if desired).
            const payload = {
            managedByUserId: normalizedManaged,
            ...(qr.assignedUserId ? {} : { assignedUserId: normalizedManaged }),
            };

            const updated = await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
            qr.$id,
            payload
            );

            // Counters only on null <-> non-null transitions
            const newAssigned = updated.assignedUserId || null;
            if (!prevAssigned && newAssigned) {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', 1).catch(console.error);
            } else if (prevAssigned && !newAssigned) {
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', -1).catch(console.error);
            }

            // Manager (and possibly assignee) changed → recompute this QR's owner in the cache.
            qrOwnerCache.reload(qrId).catch(e => console.error('qrOwnerCache.reload (assign-manager) failed:', e.message));

            return res.status(200).json({ message: 'Manager updated.', updated });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ message: 'Failed to update manager.', error: e.message });
        }
    });

    // GET QR codes for a specific user
    // This endpoint can be accessed by admin, subadmin, or the user themselves
    router.get('/qr-codes/user/:userId', authenticateToken, async (req, res) => {
        const { userId } = req.params;
        const { limit = 100, cursor } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);

        if (!userId) {
            return res.status(400).json({ message: 'Missing userId parameter' });
        }

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';

        try {
            const queries = [];

            if (isSubadmin) {
                queries.push(Query.contains('managedByUserId', userRequested.userId));
            } else {
                queries.push(Query.equal('assignedUserId', userId));
            }

            queries.push(Query.orderDesc('createdAt'));
            queries.push(Query.limit(limitNum));
            if (cursor) {
                if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                    return res.status(400).json({ error: 'Invalid cursor format' });
                }
                queries.push(Query.cursorAfter(cursor));
            }

            const response = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, queries);

            const userQrCodes = response.documents.map(doc => ({
                $id: doc.$id,
                qrId: doc.qrId,
                companyName: doc.companyName || null,
                integrationName: doc.integrationName || null,
                fileId: doc.fileId,
                imageUrl: doc.imageUrl,
                assignedUserId: doc.assignedUserId || null,
                managedByUserId: doc.managedByUserId || null,
                createdAt: doc.createdAt,
                isActive: doc.isActive,
                totalTransactions: doc.totalTransactions || 0,
                totalPayInAmount: doc.totalPayInAmount || 0,
                withdrawalRequestedAmount : doc.withdrawalRequestedAmount || 0,
                withdrawalApprovedAmount : doc.withdrawalApprovedAmount || 0,
                amountAvailableForWithdrawal : doc.amountAvailableForWithdrawal || 0,
                amountOnHold : doc.amountOnHold || 0,
                commissionOnHold : doc.commissionOnHold || 0,
                commissionPaid : doc.commissionPaid || 0,
            }));

            const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            const yesterdayDate = new Date();
            yesterdayDate.setDate(yesterdayDate.getDate() - 1);
            const yesterdayISO = yesterdayDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

            const [dailySummaryDocs, yesterdaySummaryDocs] = await Promise.all([
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', todayISO), Query.limit(1),
                ]),
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', yesterdayISO), Query.limit(1),
                ]),
            ]);

            let todayTotalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                todayTotalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in daily summary (read-only) —', e.message);
            }
            }

            let yesterdayTotalsObj = {};
            if (yesterdaySummaryDocs.total > 0) {
            try {
                yesterdayTotalsObj = JSON.parse(yesterdaySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in yesterday summary (read-only) —', e.message);
            }
            }

            const qrCodesWithTotals = userQrCodes.map(qr => ({
                ...qr,
                todayTotalPayIn: todayTotalsObj[qr.qrId] || 0,
                yesterdayTotalPayIn: yesterdayTotalsObj[qr.qrId] || 0,
            }));

            const nextCursor = qrCodesWithTotals.length === limitNum ? qrCodesWithTotals[qrCodesWithTotals.length - 1].$id : null;

            return res.status(200).json({ qrCodes: qrCodesWithTotals, nextCursor });
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            return res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
        }
    });

    // GET QR codes assigned to a specific user (only those assigned, not created)
    // This endpoint can be accessed by admin, subadmin, or the user themselves
    router.get('/qr-codes/user_assigned/:userId', authenticateToken, async (req, res) => {
        const { userId } = req.params;
        const { limit = 100, cursor } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);

        // console.log(`[/qr-codes/user_assigned] userId=${userId}, limit=${limitNum}, cursor=${cursor || 'none'}`);

        if (!userId) {
            return res.status(400).json({ message: 'Missing userId parameter' });
        }

        const userRequested = req.user;
        const isAdmin = userRequested.role === 'admin';
        const isSubadmin = userRequested.role === 'subadmin';

        // console.log(`[/qr-codes/user_assigned] requestor=${userRequested.userId}, role=${userRequested.role}`);

        // Admin can access any user's QR codes
        // Subadmin can access QR codes of users under them
        // User can only access their own
        if (!isAdmin && !isSubadmin && userRequested.userId !== userId) {
            return res.status(403).json({ message: 'Forbidden: Cannot access QR codes of other users' });
        }

        // Subadmin can only access users under them
        if (isSubadmin && userRequested.userId !== userId) {
            const userMeta = await userMetaCache.getUserMeta(userId);
            if (!userMeta || userMeta.parentId !== userRequested.userId) {
                return res.status(403).json({ message: 'Forbidden: This user is not under your management' });
            }
        }

        try {
            const queries = [
                Query.equal('assignedUserId', userId),
                Query.orderDesc('createdAt'),
                Query.limit(limitNum),
            ];
            if (cursor) {
                if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                    return res.status(400).json({ error: 'Invalid cursor format' });
                }
                queries.push(Query.cursorAfter(cursor));
            }

            // console.log(`[/qr-codes/user_assigned] querying with ${queries.length} filters`);

            const response = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, queries);

            // console.log(`[/qr-codes/user_assigned] found ${response.documents.length} QR codes`);

            const userQrCodes = response.documents.map(doc => ({
                $id: doc.$id,
                qrId: doc.qrId,
                companyName: doc.companyName || null,
                integrationName: doc.integrationName || null,
                fileId: doc.fileId,
                imageUrl: doc.imageUrl,
                assignedUserId: doc.assignedUserId || null,
                managedByUserId: doc.managedByUserId || null,
                createdAt: doc.createdAt,
                isActive: doc.isActive,
                totalTransactions: doc.totalTransactions || 0,
                totalPayInAmount: doc.totalPayInAmount || 0,
                withdrawalRequestedAmount : doc.withdrawalRequestedAmount || 0,
                withdrawalApprovedAmount : doc.withdrawalApprovedAmount || 0,
                amountAvailableForWithdrawal : doc.amountAvailableForWithdrawal || 0,
                amountOnHold : doc.amountOnHold || 0,
            }));

            const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            const yesterdayDate = new Date();
            yesterdayDate.setDate(yesterdayDate.getDate() - 1);
            const yesterdayISO = yesterdayDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

            const [dailySummaryDocs, yesterdaySummaryDocs] = await Promise.all([
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', todayISO), Query.limit(1),
                ]),
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('date', yesterdayISO), Query.limit(1),
                ]),
            ]);

            let todayTotalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                todayTotalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in daily summary (read-only) —', e.message);
            }
            }

            let yesterdayTotalsObj = {};
            if (yesterdaySummaryDocs.total > 0) {
            try {
                yesterdayTotalsObj = JSON.parse(yesterdaySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                console.error('WARNING: corrupted totalsJson in yesterday summary (read-only) —', e.message);
            }
            }

            const qrCodesWithTotals = userQrCodes.map(qr => ({
                ...qr,
                todayTotalPayIn: todayTotalsObj[qr.qrId] || 0,
                yesterdayTotalPayIn: yesterdayTotalsObj[qr.qrId] || 0,
            }));

            const nextCursor = qrCodesWithTotals.length === limitNum ? qrCodesWithTotals[qrCodesWithTotals.length - 1].$id : null;

            // console.log(`[/qr-codes/user_assigned] returning ${qrCodesWithTotals.length} QRs, nextCursor=${nextCursor || 'null'}`);

            return res.status(200).json({ qrCodes: qrCodesWithTotals, nextCursor });
        } catch (error) {
            console.error('[/qr-codes/user_assigned] Error:', error);
            return res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
        }
    });

    // // Helper to fetch QR IDs a subadmin can access
    // async function getQrIdsForSubadmin(subadminId) {
    //     const qrIds = new Set();

    //     try {
    //         // QRs created by the subadmin
    //         const createdQrs = await databases.listDocuments(
    //         APPWRITE_DATABASE_ID,
    //         Qr_collectionId,
    //         [Query.equal("createdByUserId", subadminId)]
    //         );

    //         createdQrs.documents.forEach(q => qrIds.add(q.qrId));

    //         // QRs assigned directly to the subadmin
    //         const subadminAssignedQrs = await getQrIdsForUser(subadminId);
    //         subadminAssignedQrs.forEach(id => qrIds.add(id));

    //         // Users under the subadmin
    //         const managedUsers = await databases.listDocuments(
    //         APPWRITE_DATABASE_ID,
    //         APPWRITE_USERS_META_COLLECTION_ID,
    //         [Query.equal("parentId", subadminId)]
    //         );
    //         const managedUserIds = managedUsers.documents.map(u => u.userId);

    //         // QRs assigned to those managed users
    //         if (managedUserIds.length > 0) {
    //         const qrDocs = await databases.listDocuments(
    //             APPWRITE_DATABASE_ID,
    //             Qr_collectionId,
    //             [Query.equal("assignedUserId", managedUserIds)]
    //         );
    //         qrDocs.documents.forEach(q => qrIds.add(q.qrId));
    //         }

    //         return Array.from(qrIds);
    //     } catch (err) {
    //         console.error(`❌ Error in getQrIdsForSubadmin(${subadminId}):`, err);
    //         return [];
    //     }
    // }

    // // Helper to get QR IDs for a user
    // async function getQrIdsForUser(userId) {
    //     try {
    //         const response = await databases.listDocuments(
    //         APPWRITE_DATABASE_ID,
    //         Qr_collectionId, // Ensure this matches your actual QR codes collection ID
    //         [Query.equal('assignedUserId', userId)]
    //         );
    //         return response.documents.map(doc => doc.qrId);
    //     } catch (error) {
    //         console.error('Error fetching QR codes for user:', error);
    //         return [];
    //     }
    // }

    async function createRazorpayQr(userId) {

        const { name, email } = await getUserDetails(userId);

        const qr = await razorpay.qrCode.create({
            type: "upi_qr",
            name: email || "Kite User",
            usage: "multiple_use",
            fixed_amount: false,
            description: `${name || "Kite User"} : ${email || ""}`,
            notes: {
            userId,
            },
        });

        return qr; // contains id, image_url, etc.
    }

    async function createRazorpayQrSinglePayment(userId, amountInPaise) {
        const { name, email } = await getUserDetails(userId);

        // Current time + 4 minutes (in seconds)
        const closeBy = Math.floor(Date.now() / 1000) + (4 * 60);

        const qr = await razorpay.qrCode.create({
            type: "upi_qr",
            name: email || "Kite User",
            usage: "single_use",
            fixed_amount: true,
            payment_amount: amountInPaise,
            customer_id: email,
            close_by: closeBy,
            description: `${name || "Kite User"} : ${email || ""}`,
            notes: {
                userId,
            },
        });

        return qr;
    }

    // --------------------
    // Download QR image
    // --------------------
    async function downloadQrImage(url, path) {
        const response = await axios.get(url, { responseType: "arraybuffer" });
        fs.writeFileSync(path, response.data);
        return path;
    }

    // --------------------
    // Upload to Appwrite + Save Metadata
    // --------------------
    async function uploadQrToAppwrite(localPath, userId, razorpayQr) {

        // 2. Ensure file exists
        if (!fs.existsSync(localPath)) {
        throw new Error(`Downloaded file missing: ${localPath}`);
        }

        // Use readFileSync to create a buffer instead of a stream
        const fileBuffer = fs.readFileSync(localPath);
    
        // Get file name from path
        const fileName = path.basename(localPath);
        
        // Create File object with proper metadata
        const fileObject = new File([fileBuffer], fileName, {
            type: 'image/png' // or appropriate MIME type
        });

        // 3. Upload to Appwrite Storage
        const file = await storage.createFile(
            bucketId,
            ID.unique(),
            fileObject
        );

        // console.log("File uploaded to Appwrite Storage:", file);

        const imageUrl = `${APPWRITE_ENDPOINT}/storage/buckets/${bucketId}/files/${file.$id}/view?project=${APPWRITE_PROJECT_ID}`;

        // Save metadata in Appwrite collection
        // const newQrCode = await databases.createDocument(
        //     databaseId,
        //     Qr_collectionId,
        //     ID.unique(),
        //     {
        //     userId,
        //     razorpayQrId: razorpayQr.id,
        //     razorpayQrUrl: razorpayQr.image_url,
        //     storageFileId: file.$id,
        //     active: true,
        //     }
        // );

      const istTime = moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');

        const newQrCode = await saveQrEntry({
            qrId: razorpayQr.id,
            companyName: 'companyName',
            fileId: file.$id,
            imageUrl: imageUrl,
            createdByUserId: userId,
            createdAt: istTime,
        });

        return { file, newQrCode, razorpayQr };

    }

    async function uploadQrDirect(url) {
        const response = await axios.get(url, { responseType: "stream" });

        const file = await storage.createFile(
            bucketId,
            ID.unique(),
            response.data // 👈 pass stream directly
        );

        return file;
    }

    async function hasFiveActiveQRCodes(userId) {
        if (!userId) {
            throw new Error("Missing userId parameter");
        }

        try {
            const response = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal('assignedUserId', userId)]
            );

            // console.log(`User ${userId} has ${response.total} total QR codes assigned.`);

            // for (const doc of response.documents) {
            //     console.log(`QR Code ${doc.qrId} isActive: ${doc.isActive}`);
            // }

            // Count only active QR codes
            const activeCount = response.documents.filter(doc => doc.isActive === true).length;

            return {
                hasFiveActive: activeCount >= 5,
                activeCount
            };
        } catch (error) {
            console.error('Error checking active QR codes:', error);
            throw error;
        }
    }

    // // this was used for razorpay test account
    // router.post("/create-qr/:userId",authenticateAdminOrSubAdmin, async (req, res) => {
    //     // console.log('Create QR request for userId:', req.params.userId);
    //     try {
    //         // const { userId } = req.params;
    //         const userId = req.user.userId; // set by your JWT middleware
            
    //         // console.log('Creating QR for userId:', userId);

    //         // Check limit before assigning
    //         const { hasFiveActive, activeCount } = await hasFiveActiveQRCodes(userId);

    //         if (hasFiveActive) {
    //             // console.log(`User already has ${activeCount} active QR codes. Cannot assign more.`);
    //             return res.status(400).json({
    //                 message: `User already has ${activeCount} active QR codes. Cannot assign more.`
    //             });
    //         }

    //         // 1. Create QR in Razorpay
    //         const qr = await createRazorpayQr(userId);

    //         // 2. Download QR image
    //         const localPath = `/tmp/${qr.id}.png`;
    //         await downloadQrImage(qr.image_url, localPath);

    //         // 3. Save QR metadata in Appwrite (DB + Storage)
    //         await uploadQrToAppwrite(localPath, userId, qr);

    //         // 4. Assign QR to user using extracted method
    //         await assignQrToUser({
    //             qrId: qr.id,
    //             assignedUserId: userId
    //         });

    //         res.json({
    //             success: true,
    //             razorpayQrId: qr.id,
    //             // appwriteFileId: file.$id,
    //             // appwriteDocId: doc.$id,
    //             qrImageUrl: qr.image_url,
    //         });
    //     } catch (err) {
    //         console.error("Error creating QR:", err);
    //         res.status(500).json({ success: false, error: err.message });
    //     }
    // });

    // router.post("/create-admin-qr/:userId", authenticateAdmin, async (req, res) => {
    //     // console.log('Create QR request for userId:', req.params.userId);
    //     try {
    //         const { userId } = req.params;

    //         // console.log('Creating QR for userId:', userId);

    //         // Check limit before assigning
    //         const { hasFiveActive, activeCount } = await hasFiveActiveQRCodes(userId);

    //         if (hasFiveActive) {
    //             // console.log("User already has ${activeCount} active QR codes. Cannot assign more.");
    //             return res.status(400).json({
    //                 message: `User already has ${activeCount} active QR codes. Cannot assign more.`
    //             });
    //         }

    //         // 1. Create QR in Razorpay
    //         const qr = await createRazorpayQr(userId);

    //         // 2. Download QR image
    //         const localPath = `/tmp/${qr.id}.png`;
    //         await downloadQrImage(qr.image_url, localPath);

    //         // 3. Save QR metadata in Appwrite (DB + Storage)
    //         await uploadQrToAppwrite(localPath, userId, qr);

    //         // 4. Assign QR to user using extracted method
    //         await assignQrToUser({
    //             qrId: qr.id,
    //             assignedUserId: userId
    //         });

    //         res.json({
    //             success: true,
    //             razorpayQrId: qr.id,
    //             // appwriteFileId: file.$id,
    //             // appwriteDocId: doc.$id,
    //             qrImageUrl: qr.image_url,
    //         });
    //     } catch (err) {
    //         console.error("Error creating QR:", err);
    //         res.status(500).json({ success: false, error: err.message });
    //     }
    // });

    return router;

};