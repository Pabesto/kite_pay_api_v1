// -----------------------------------------------------------------------------------------------------
// routes/qrcode.js
// This file contains the API endpoints for QR code management.

const express = require('express');
const { ID, Query } = require('node-appwrite');
const Razorpay = require("razorpay");
const fs = require("fs");
const axios = require("axios");
const { File } = require('buffer');
const path = require('path');
const moment = require('moment-timezone');

const { updateDashboardCounter } = require('./dashboardCounters');
const { type } = require('os');


// --------------------
// Razorpay Setup
// --------------------
// TEST MODE
// const razorpay = new Razorpay({
//   key_id: 'rzp_test_R9fF4cePyFbq4m',
//   key_secret: 'YK65c6Y1AO6rNSx6SzMUv8wP',
// });
// Production mode
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// console.log(process.env.RAZORPAY_KEY_ID);
// console.log(process.env.RAZORPAY_KEY_SECRET);

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, bucketId,APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, roleAuth, requireRole) => {
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
    router.get('/qr-codes', authenticateAdminOrLabel('all_transactions'), async (req, res) => {
        try {

            let resultAllQr = [];

            if (req.user.role === 'employee') {
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('assigned_to', req.user.$id),
                        Query.equal('role', 'subadmin'),
                        Query.limit(100)  // Merchants rarely >100/emp
                    ]
                );

                const merchantIds = merchantsRes.documents.map(d => d.userId);

                // console.log(`Employee ${req.user.$id} has ${merchantIds.length} assigned merchants:`, merchantIds);

                let queries = [];

                let orQueries = [];
                // let orQueries = [];
                merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                queries.push(Query.or(orQueries));

                const usersRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    queries // must be an array
                );

                queries = [];

                const userIds = usersRes.documents.map(d => d.userId);

                // console.log(`Employee ${req.user.$id} has ${userIds.length} assigned users:`, userIds);

                let orQueries2 = [];

                merchantIds.forEach(id => orQueries2.push(Query.equal('assignedUserId', id)));
                userIds.forEach(id => orQueries2.push(Query.equal('assignedUserId', id)));
                queries.push(Query.or(orQueries2));

                // console.log('Employee user list query result count:', usersRes.total);

                resultAllQr = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    Qr_collectionId,
                    queries,
                );

                // console.log('Employee QR code query result count:', resultAllQr.total);

                // documents = response.documents;

            } else {

                resultAllQr = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, // Transactions collection
                    [
                        Query.orderDesc('createdAt'), // Add this line to sort descending by date
                        Query.limit(100) // Limits the results to 10 documents
                    ]
                );

            }

            const qrCodes = resultAllQr.documents.map(doc => ({
                qrId: doc.qrId,
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

            // Fetch the daily aggregate doc for today (only one document)
            const dailySummaryDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', todayISO),
                Query.limit(1),
            ]
            );

            let totalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                totalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                totalsObj = {};
            }
            }

            // Map today totals to each QR code
            const qrCodesWithTodayTotal = qrCodes.map(qr => {
                const todayTotalPayIn = totalsObj[qr.qrId] || 0;

                return {
                    ...qr,
                    todayTotalPayIn,
                };
            });

            res.status(200).json(qrCodesWithTodayTotal.reverse());// Reverse the order to show the most recent first

        } catch (error) {
            console.error('Error fetching QR codes:', error);
            res.status(500).json({ message: "Failed to fetch QR codes.", error: error.message });
        }
    });

    async function saveQrEntry({
        qrId,
        qrType,
        fileId,
        imageUrl,
        createdByUserId,
        createdAt,
        assignedUserId = null,
        }) {

            console.log('Saving QR Entry:', {
                qrId,
                qrType, 
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
            type: qrType,
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
        const { qrId, qrType, fileId, imageUrl , createdAt } = req.body;

        console.log('Create QR Entry request body:', req.body);

        if (!qrId || !fileId || !imageUrl) {
            return res.status(400).json({ message: "Missing required fields: qrId, fileId, or imageUrl." });
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

            res.status(201).json({ message: "QR Code entry created successfully.", qrCode: newQrCode });
        } catch (error) {
            console.error('Error creating QR code entry:', error);
            res.status(500).json({ message: "Failed to create QR code entry.", error: error.message });
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

            res.status(200).json({ message: "QR Code and file deleted successfully." });
        } catch (error) {
            console.error('Error deleting QR code:', error);
            res.status(500).json({ message: "Failed to delete QR code.", error: error.message });
        }
    });

    // PATCH a QR code entry  
    // This is an admin-only endpoint
    router.patch('/edit-qr/:qrId', authenticateAdmin, async (req, res) => {
        const { qrId } = req.params;
        const { qrType, fileId, imageUrl } = req.body;

        console.log('Edit QR Entry request:', { qrId, qrType, fileId, imageUrl });

        // Validate at least one field is provided for update
        if (!qrType && !fileId && !imageUrl) {
            return res.status(400).json({ message: "At least one field (qrType, fileId, or imageUrl) must be provided for update." });
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

            res.status(200).json({ 
                message: "QR Code updated successfully.", 
                qrCode: updatedQr 
            });

        } catch (error) {
            console.error('Error editing QR code entry:', error);
            res.status(500).json({ message: "Failed to update QR code entry.", error: error.message });
        }
    });


    // PUT to toggle the isActive status
    // This is an admin-only endpoint
    router.put('/toggle-qr-status/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
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
                    return res.status(403).json({ message: 'Forbidden: Subadmin cannot activate an active QR code' });
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

            res.status(200).json({ message: "QR Code status updated successfully." });
        } catch (error) {
            console.error('Error toggling QR code status:', error);
            res.status(500).json({ message: "Failed to update QR code status.", error: error.message });
        }
    });

    // PUT to assign a user to a QR code
    // This is an admin-only endpoint
    // MODIFIED: Endpoint to assign or unlink a user from a QR code
    // router.put('/assign-qr/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
    //     const { qrId } = req.params;
    //     const { assignedUserId , managedByUserId } = req.body; // assignedUserId can now be null or a string

    //     try {
    //         // Fetch current assignment
    //         const docResult = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
    //             Query.equal('qrId', qrId)
    //         ]);
    //         if (docResult.documents.length === 0) {
    //             return res.status(404).json({ message: "QR Code not found." });
    //         }
    //         const prevAssignedUserId = docResult.documents[0].assignedUserId;
    //         // Update assignment
    //         if(managedByUserId){
    //             const result = await assignQrToUserNew({
    //                 qrId,
    //                 assignedUserId,
    //                 managedByUserId : managedByUserId,
    //             });
    //         }else{
    //             const result = await assignQrToUserNew({
    //                 qrId,
    //                 assignedUserId
    //             });
    //         }
            
    //         // Only increment if previously unassigned and now assigned
    //         if (!prevAssignedUserId && assignedUserId) {
    //             await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', 1).catch(console.error);
    //         }
    //         // Only decrement if previously assigned and now unassigned
    //         else if (prevAssignedUserId && !assignedUserId) {
    //             await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', -1).catch(console.error);
    //         }
    //         // No change if reassigned from one user to another
    //         res.status(200).json({ message: "User assignment updated successfully." });
    //     } catch (error) {
    //         console.error('Error updating user assignment for QR code:', error);
    //         res.status(500).json({ message: "Failed to update user assignment.", error: error.message });
    //     }
    // });

    // PUT to assign a user to a QR code
    router.put('/assign-qr-user/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
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
    router.put('/assign-qr-manager/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
        const { qrId } = req.params;
        const { managedByUserId: rawManaged } = req.body;
        const actor = req.user;

        try {
            // Admin-only
            if (actor.role !== 'admin') {
            return res.status(403).json({ message: 'Only admin can change managedByUserId.' });
            }

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
            return res.status(200).json({ message: 'Manager unlinked.', updated });
            }

            // TRANSFER (block strategy)
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

        if (!userId) {
            return res.status(400).json({ message: 'Missing userId parameter' });
        }

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';
        const isEmployee = userRequested.role === 'employee';
        const requestorId = userRequested.userId;

        try {
            let documents = [];

            if (isSubadmin) {
                const response = await databases.listDocuments(
                        APPWRITE_DATABASE_ID,
                        Qr_collectionId,
                        [Query.contains('managedByUserId', userRequested.userId)]
                    );
                    documents = response.documents;
            } else {
                const response = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    Qr_collectionId,
                    [
                        // Query.or([
                        //     Query.equal('assignedUserId', userId),
                        //     Query.equal('createdByUserId', userId),
                        // ]),
                        Query.equal('assignedUserId', userId),
                        // Query.limit(50),
                    ]
                );
                documents = response.documents;
            }

            const userQrCodes = documents.map(doc => ({
                qrId: doc.qrId,
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

            // Fetch the daily aggregate doc for today (only one document)
            const dailySummaryDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', todayISO),
                Query.limit(1),
            ]
            );

            let totalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                totalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                totalsObj = {};
            }
            }

            // Map today totals to each QR code
            const userQrCodesWithTodayTotal = userQrCodes.map(qr => {
                const todayTotalPayIn = totalsObj[qr.qrId] || 0;

                return {
                    ...qr,
                    todayTotalPayIn,
                };
            });


            res.status(200).json(userQrCodesWithTodayTotal);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
        }
    });

    // GET QR codes assigned to a specific user (only those assigned, not created)
    // This endpoint can be accessed by admin, subadmin, or the user themselves
    router.get('/qr-codes/user_assigned/:userId', authenticateToken, async (req, res) => {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ message: 'Missing userId parameter' });
        }

        const userRequested = req.user;

        if(userRequested.userId !== userId){
            return res.status(403).json({ message: 'Forbidden: Cannot access QR codes of other users' });
        }

        try {
            let documents = [];

            const response = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [
                    Query.equal('assignedUserId', userId),
                    Query.limit(100),
                ]
            );
            
            documents = response.documents;

            const userQrCodes = documents.map(doc => ({
                qrId: doc.qrId,
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

            // Fetch the daily aggregate doc for today (only one document)
            const dailySummaryDocs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', todayISO),
                Query.limit(1),
            ]
            );

            let totalsObj = {};
            if (dailySummaryDocs.total > 0) {
            try {
                totalsObj = JSON.parse(dailySummaryDocs.documents[0].totalsJson || '{}');
            } catch (e) {
                totalsObj = {};
            }
            }

            // Map today totals to each QR code
            const userQrCodesWithTodayTotal = userQrCodes.map(qr => {
                const todayTotalPayIn = totalsObj[qr.qrId] || 0;

                return {
                    ...qr,
                    todayTotalPayIn,
                };
            });


            res.status(200).json(userQrCodesWithTodayTotal);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
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

    async function createRazorpayQrSingle(userId, amountInPaise) {
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

        const imageUrl = 'https://fra.cloud.appwrite.io/v1/storage/buckets/'+bucketId+'/files/'+file.$id+'/view?project=688c98fd002bfe3cf596';

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

      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(Date.now() + istOffset).toISOString();

        const newQrCode = await saveQrEntry({
            qrId: razorpayQr.id,
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