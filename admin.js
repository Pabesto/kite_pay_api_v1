// -----------------------------------------------------------------------------------------------------
// routes/admin.js
// This file contains the API endpoints for user management.

const express = require('express');
const multer = require('multer');
const moment = require('moment-timezone');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');

const { updateDashboardCounter } = require('./dashboardCounters');

dayjs.extend(utc);
dayjs.extend(tz);
// Optional: set default TZ once
dayjs.tz.setDefault('Asia/Kolkata');

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, webhook_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {
    // router.use(roleAuth); // All routes will now have req.userMeta

    function getISTDateTime() {
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
        return new Date(Date.now() + istOffset).toISOString();
    }

    // 🔥 List all users AppWrite Users
    // router.get('/users', authenticateAdmin, async (req, res) => {
    //     try {
    //         const result = await users.list();

    //         const simplifiedUsers = result.users.map(user => ({
    //             $id: user.$id,
    //             email: user.email,
    //             name: user.name,
    //             status: user.status,
    //             labels: user.labels,
    //         }));

    //         return res.json(simplifiedUsers);
    //     } catch (err) {
    //         console.error('List users error:', err);
    //         return res.status(500).json({ error: 'Failed to fetch users' });
    //     }
    // });

    // 🔥 List all users AppWrite Collections users_meta
    router.get('/users', authenticateAdminOrLabel('all_transactions', { isSubadminAllowed: true }), async (req, res) => {
        const {limit = 25, cursor} = req.query;
    
        const requestorId = req.user.userId;
        const role = req.user.role; // 'admin' | 'subadmin'

        const limitNum = Math.min(parseInt(limit) || 25, 200);
        // limitNum = limit;

        try {
            const queries = [];

            // If a cursor was sent, use it for pagination
            if (cursor) {
                queries.push(Query.cursorAfter(cursor));
            }

            // Consistent ordering is CRUCIAL for cursor pagination
            queries.push(Query.orderAsc('$id'));

            // Role-based filtering
            if (role === 'subadmin') {
                queries.push(Query.equal('parentId', requestorId));
            } else if (role === 'employee') {
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    [
                        Query.equal('assigned_to', requestorId),
                        Query.equal('role', 'subadmin'),
                        Query.limit(100)  // Merchants rarely >100/emp
                    ]
                );

                const merchantIds = merchantsRes.documents.map(d => d.userId);

                if (cursor) queries.push(Query.cursorAfter(cursor));
                queries.push(Query.orderAsc('$id'));

                let orQueries = [Query.equal('assigned_to', requestorId)];
                // let orQueries = [];
                merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                queries.push(Query.or(orQueries));

                const result = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    queries // must be an array
                );

                console.log('Employee user list query result count:', result.total);

            }

            // admins see all; subadmins only their users
             // smaller chunks for pagination
            queries.push(Query.limit(limitNum));

            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                queries // must be an array
            );

            const simplifiedUsers = result.documents.map(doc => ({
                $id: doc.userId,
                email: doc.email,
                name: doc.name,
                role: doc.role,
                parentId: doc.parentId,
                status: doc.status,
                labels: doc.labels,
                commission : doc.commission || 0,
            }));

            const docs = simplifiedUsers;
        
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({
                transactions: docs, // still newest first
                nextCursor
            });

        } catch (err) {
            console.error('List users error:', err);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }
    });

    // 🔥 List all Subadmin
    router.get('/subadmins', authenticateAdmin, async (req, res) => {
        const requestorId = req.user.userId;
        const role = req.user.role; // 'admin' | 'subadmin'

        try {
            const queries = [];

            if (role !== 'admin') {
                return res.status(403).json({ error: 'only admins can see sub-admins' });
            }

            queries.push(Query.equal('role', 'subadmin'));
            // admins see all subadmins; subadmins see none

            const search = req.query.search; // ?search=John or ?search=email@host
            if (search !== undefined && search.trim().length > 0) {
                // For partial matches (Appwrite >= v1.0.0), use Query.search:
                queries.push(Query.search('name', search));
                // queries.push(Query.search('email', search));
                // For exact, use Query.equal('email', search) or Query.equal('name', search)
            }

            const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            queries // must be an array
            );

            const simplifiedUsers = result.documents.map(doc => ({
            $id: doc.userId,
            email: doc.email,
            name: doc.name,
            role: doc.role,
            parentId: doc.parentId,
            status: doc.status,
            labels: doc.labels,
            commission : doc.commission || 0,
            }));

            return res.json(simplifiedUsers);
        } catch (err) {
            console.error('List sub-admins error:', err);
            return res.status(500).json({ error: 'Failed to fetch sub-admins' });
        }
    });
    
    //     } catch (err) {
    //         console.error('List users error:', err);
    //         return res.status(500).json({ error: 'Failed to fetch users' });
    //     }
    // });

    // 🔐 Create new user (admin-only)
    // router.post('/create-user', authenticateAdminOrSubAdmin, async (req, res) => {
    //     const {name, email, password } = req.body;

    //     if (!name || !email || !password) {
    //         return res.status(400).json({ error: 'Name, Email and password are required' });
    //     }

    //     try {
    //         const response = await users.create(
    //             ID.unique(),
    //             email,
    //             undefined,
    //             password,
    //             name
    //         );

    //         return res.status(201).json({
    //             message: 'User created successfully',
    //             user: {
    //                 $id: response.$id,
    //                 email: response.email,
    //                 name: response.name,
    //             },
    //         });
    //     } catch (err) {
    //         console.error('❌ Create user error:', err.message || err);
    //         return res.status(500).json({ error: err.message || 'User creation failed' });
    //     }
    // });

    // 🔐 Create new user (admin/sub-admin allowed)
    router.post('/create-user', authenticateAdminOrSubAdmin, async (req, res) => {
        const { name, email, password, role } = req.body;
        creatorId = req.user.userId;

        if(role === 'admin'){
            return res.status(400).json({ error: 'admin cant be created' });
        }

        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: 'Name, Email, Password and Role are required' });
        }

        if (req.user.role === 'subadmin' && role !== 'user') {
            return res.status(403).json({ error: 'Sub-admins can only create users' });
        }

        if(req.user.role === 'admin'){
            creatorId = null; // if users have been created by admin, parentId will be null
        }

        try {
            // 1) Create Appwrite auth user
            const response = await users.create(ID.unique(), email, undefined, password, name);

            await users.updateLabels(response.$id, [role]);

            // 2) Prepare payload
            const userId = response.$id; // must be $id
            const payload = {
                userId,
                email: response.email,
                name: response.name,
                role,
                parentId: creatorId,
                status: true,
                commission: 0,
            };

            // 3) Idempotent metadata write: use 1:1 docId = userId
            try {
            // console.log('Creating user metadata document for userId:', userId);
            await databases.createDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                userId,                // <-- 1:1 mapping: docId equals auth user $id
                payload
            );
            } catch (e) {
            console.error('Error creating user metadata document:', e);
            if (e?.code === 409) {
                    // Either docId already exists or a unique index collided; update in place
                    await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_USERS_META_COLLECTION_ID,
                    userId,
                    payload
                    );
                } else {
                    throw e;
                }
            }

            // Update dashboard counters
            if(role === 'subadmin'){
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantActive', 1).catch(console.error);
            }else if(role === 'user'){
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'activeUsers', 1).catch(console.error);
            }

            // Total users count (all roles)
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalUsers', 1).catch(console.error);

            return res.status(201).json({
            message: 'User created successfully',
            user: {
                $id: response.$id,
                email: response.email,
                name: response.name,
                role,
                parentId: creatorId,
            },
            });
        } catch (err) {
            console.error('❌ Create user error:', err.message || err);
            return res.status(500).json({ error: err.message || 'User creation failed' });
        }
    });

    // 🔐 Assign user to sub-admin (admin-only or employee with all_users)
    router.put('/assign-user/:subadminId', authenticateAdmin, async (req, res) => {
        const { subadminId } = req.params;
        const { userId, unassign = false } = req.body; // userId can be string; unassign=true clears parentId

        try {

            if (!userId) {
                return res.status(400).json({ message: 'userId is required' });
            }

            const requester = req.user; // { id, role }
            const isAdmin = requester.role === 'admin';
            // const isSubadmin = requester.role === 'subadmin';

            if (!isAdmin) {
                return res.status(403).json({ message: 'Forbidden only admins can assign users to SUBADMINS' });
            }

            // if (isSubadmin && requester.id !== subadminId) {
            //     return res.status(403).json({ message: 'Subadmin can only assign to self' });
            // }

            // Validate target is a SUBADMIN
            const targetSubadmin = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, subadminId);
            if (targetSubadmin.role !== 'subadmin') {
                return res.status(400).json({ message: 'Target is not a SUBADMIN' });
            }

            // Optional extra guard for subadmins: only modify users already under them
            // if (isSubadmin) {
            //     const u = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId);
            //     if (u.parentId && u.parentId !== requester.id) {
            //         return res.status(403).json({ message: 'Not allowed to modify this user' });
            //     }
            // }

            const update = { parentId: unassign ? null : subadminId };
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId, update);

            return res.status(200).json({ message: 'Assignment updated.' });
        } catch (err) {
            console.error('Assign user error:', err);
            return res.status(500).json({ message: 'Failed to update assignment', error: err.message });
        }
    });

    // ✏️ Edit user endpoint ( admin/sub-admin or employee with all_users allowed )
    router.put('/edit-user/:id', authenticateAdminOrSubAdmin, async (req, res) => {
    const userIdtoEdit = req.params.id;
    const { name, email, labels, commission } = req.body;
    const userRequested = req.user;

    if (!userIdtoEdit) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    if (
        name === undefined &&
        email === undefined &&
        labels === undefined &&
        commission === undefined
    ) {
        return res.status(400).json({ error: 'At least one field must be provided to update' });
    }

    try {
        const user = await users.get(userIdtoEdit);

        if (user.labels?.includes('admin')) {
        return res.status(403).json({ error: 'Cannot edit admin users' });
        }

        const list = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_USERS_META_COLLECTION_ID,
        [Query.equal('userId', userIdtoEdit)]
        );
        if (list.documents.length === 0) {
        return res.status(404).json({ error: 'User metadata document not found in users_mets' });
        }

        if (userRequested.role === 'subadmin') {
        if (list.documents[0].parentId !== userRequested.userId) {
            return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
        }
        }

        const doc = list.documents[0];
        const docId = doc.$id;

        const updatePayload = {};

        if (name !== undefined) updatePayload.name = name;
        if (email !== undefined) updatePayload.email = email;
        if (labels !== undefined) updatePayload.labels = labels;
        if (commission !== undefined) {
        const commissionNum = Number(commission);
        if (isNaN(commissionNum)) {
            return res.status(400).json({ error: 'Commission must be a valid number' });
        }
        updatePayload.commission = commissionNum;
        }

        // Update specialized user data (name/email) if present 
        if (name !== undefined) await users.updateName(userIdtoEdit, name);
        if (email !== undefined) await users.updateEmail(userIdtoEdit, email);

        // Update metadata document with labels or commission or other fields
        await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_USERS_META_COLLECTION_ID,
        docId,
        updatePayload
        );

        return res.json({ message: 'User updated successfully' });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to update user' });
    }
    });

    // 🔐 Reset user password ( admin/sub-admin or employee with all_users allowed )
    router.post('/reset-password/:id', authenticateAdminOrSubAdmin, async (req, res) => {
        const userId = req.params.id;
        const { password } = req.body;

        const userRequested = req.user; // set by your JWT middleware

        // Find document in users_mets collection matching userId
        const list = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [
                Query.equal('userId', userId)
            ]
        );
        if (list.documents.length === 0) {
            return res.status(404).json({ error: 'User metadata document not found in users_mets' });
        }

        if(userRequested.role === 'subadmin'){
            if(list.documents[0].parentId !== userRequested.userId){
                return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
            }   
        } else {    
            // sub-admins can only edit users they created
        }

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        try {
            const user = await users.get(userId);

            if (user.labels?.includes('admin')) {
                return res.status(403).json({ error: 'Cannot reset password for admin users' });
            }

            await users.updatePassword(userId, password);

            return res.json({ message: 'Password reset successfully' });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: err.message || 'Failed to reset password' });
        }
    });

    // POST /update-user-status
    router.post('/update-user-status',authenticateAdminOrSubAdmin, async (req, res) => {
        const { userId, status } = req.body;
        const userRequested = req.user; // set by your JWT middleware

        if (!userId || typeof status !== 'boolean') {
            return res.status(400).json({ error: 'Missing or invalid fields' });
        }

        try {
            const user = await users.get(userId);

            if (user.labels.includes('admin')) {
                return res.status(403).json({ error: 'Forbidden: Cannot change status of admin users' });
            }

            const result = await users.updateStatus(userId, status);

           // Update status in users_mets collection
            const list = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                [
                    Query.equal('userId', userId)
                ]
            );
            if (list.documents.length === 0) {
                return res.status(404).json({ error: 'User metadata document not found in users_meta' });
            }

             if(userRequested.role === 'subadmin'){
                if(list.documents[0].parentId !== userRequested.userId){
                    return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
                }   
            } else {    
                // sub-admins can only edit users they created
            }

            const doc = list.documents[0];
            const docId = doc.$id;

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                docId,
                { status }
            );

            if(doc.role === 'subadmin'){
                // Update dashboard counter for subadmin status change
                const delta = status ? 1 : -1;
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantActive', delta).catch(console.error);
                // merchantDisabled
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantDisabled', -delta).catch(console.error);
            }else if(doc.role === 'user'){
                // Update dashboard counter for user status change
                const delta = status ? 1 : -1;
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'activeUsers', delta).catch(console.error);
                // disabledUsers
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'disabledUsers', -delta).catch(console.error);
            }

            return res.json({ success: true, status: result.status });
        } catch (err) {
            console.error('❌ Status update failed:', err.message);
            return res.status(500).json({ error: 'Failed to update status' });
        }
    });

    // 🧹 Delete user endpoint
    router.delete('/delete-user/:id', authenticateAdmin, async (req, res) => {
        const userId = req.params.id;

        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }

        try {
            const user = await users.get(userId);

            if (user.labels?.includes('admin')) {
                return res.status(403).json({ error: 'Cannot delete admin users' });
            }

            // Find and delete corresponding document in users_mets collection
            const list = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                [
                    Query.equal('userId', userId)
                ]
            );

            if (list.documents.length > 0) {
                const docId = list.documents[0].$id;

                const response = await databases.listDocuments(APPWRITE_DATABASE_ID,Qr_collectionId, // Ensure this matches your actual QR codes collection ID
                    [Query.equal('assignedUserId', docId.userId)]
                );

                if (response.total > 0) {
                    return res.status(400).json({ message: "Cannot delete user with assigned QR codes. Please unassign them first." }); 
                }

                await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, docId);

                // Delete user in Appwrite users service
                await users.delete(userId);

                // Update dashboard counters
                const role = list.documents[0].role;
                const status = list.documents[0].status;
                if (role === 'subadmin') {
                    if (status === true) {
                        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantActive', -1).catch(console.error);
                    } else {
                        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantDisabled', -1).catch(console.error);
                    }
                } else if (role === 'user') {
                    if (status === true) {
                        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'activeUsers', -1).catch(console.error);
                    } else {
                        await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'disabledUsers', -1).catch(console.error);
                    }
                }
                // Total users count (all roles)
                await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalUsers', -1).catch(console.error);
            }

            return res.status(200).json({ message: 'User deleted successfully' });
        } catch (err) {
            return res.status(500).json({ error: err.message || 'Failed to delete user' });
        }
    });

    // Helper to get QR IDs for a user
    async function getQrIdsForUser(userId) {
        try {
            const response = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Qr_collectionId, // Ensure this matches your actual QR codes collection ID
            [Query.equal('assignedUserId', userId)]
            );
            return response.documents.map(doc => doc.qrId);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            return [];
        }
    }

    // Helper to fetch QR IDs a subadmin can access
    async function getQrIdsForSubadmin(subadminId) {
        const qrIds = new Set();

        try {
            // QRs created by the subadmin
            const createdQrs = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            Qr_collectionId,
            [Query.equal("createdByUserId", subadminId)]
            );

            createdQrs.documents.forEach(q => qrIds.add(q.qrId));

            // QRs assigned directly to the subadmin
            const subadminAssignedQrs = await getQrIdsForUser(subadminId);
            subadminAssignedQrs.forEach(id => qrIds.add(id));

            // Users under the subadmin
            const managedUsers = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal("parentId", subadminId)]
            );
            const managedUserIds = managedUsers.documents.map(u => u.userId);

            // QRs assigned to those managed users
            if (managedUserIds.length > 0) {
            const qrDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal("assignedUserId", managedUserIds)]
            );
            qrDocs.documents.forEach(q => qrIds.add(q.qrId));
            }

            return Array.from(qrIds);
        } catch (err) {
            console.error(`❌ Error in getQrIdsForSubadmin(${subadminId}):`, err);
            return [];
        }
    }

    // Admin-only: fetch all or filtered transactions
    router.get('/transactions', authenticateAdminOrLabel('all_transactions', { isSubadminAllowed: true }), async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to, status, searchField, searchValue } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);

        let filters = [];

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';

        // userRequested.labels;
        console.log('User role and labels:', userRequested.role, userRequested.labels);

        // console.log('Transaction query params:', req.query);

        try {
            if (userId && qrId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.includes(qrId)) {
                    filters.push(Query.equal('qrCodeId', qrId));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            } else if (qrId) {
                filters.push(Query.equal('qrCodeId', qrId));
            } else if (userId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.length > 0) {
                    filters.push(Query.equal('qrCodeId', userQrIds));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            }

            // Date filtering helper (unchanged)
            function toISTRange(dateStr) {
                const d = new Date(dateStr);
                const start = new Date(d);
                start.setHours(0, 0, 0, 0);
                start.setMinutes(start.getMinutes() - 330);
                const end = new Date(d);
                end.setHours(23, 59, 59, 999);
                end.setMinutes(end.getMinutes() - 330);
                return { start, end };
            }

            // Date filters
            if (from && to) {
                if (from === to) {
                    const { start, end } = toISTRange(from);
                    filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
                } else {
                    const { start } = toISTRange(from);
                    const { end } = toISTRange(to);
                    filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
                }
            } else if (from && !to) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else if (!from && to) {
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual("created_at", end.toISOString()));
            }

            // Add single-field search if both parameters provided
            if (searchField && searchValue) {
                const fulltextFields = ['vpa', 'paymentId', 'qrCodeId'];
                const exactMatchFields = ['amount', 'rrnNumber'];

                if (fulltextFields.includes(searchField)) {
                    // Use fulltext search for these fields
                    filters.push(Query.search(searchField, searchValue));
                } else if (searchField === 'amount') {
                    const amountValue = parseInt(searchValue, 10);
                    if (isNaN(amountValue)) {
                    return res.status(400).json({ error: 'Amount must be an integer value' });
                    }
                    filters.push(Query.equal('amount', amountValue*100));
                } else if (searchField === 'rrnNumber') {
                    // rrnNumber exact match as string
                    filters.push(Query.equal('rrnNumber', searchValue));
                } else {
                    return res.status(400).json({ error: 'Invalid searchField parameter' });
                }
            }

            if(status){
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback']); // enum gate [14]
                if (!allowedStatuses.has(status.toLowerCase())) {
                    return res.status(400).json({ error: 'Invalid status filter' }); // 400 on bad input [14]
                }
                if(status.toLowerCase() === 'normal'){
                    filters.push(
                        Query.or([
                            Query.equal('status', 'normal'),
                            Query.equal('status', ''),       // if some docs stored empty string
                            Query.isNull('status'),          // null or missing field
                        ])
                    );
                }else{
                    filters.push(Query.equal('status', status.toLowerCase()));
                }
            }

            const queries = [...filters, Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (cursor) {
            queries.push(Query.cursorAfter(cursor));
            }

            // console.log('Transaction query filters:', queries);

            const transactions = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);

            const pickTxn = (d) => ({
                $id: d.$id,   
                id: d.$id,                // keep if needed
                qrCodeId: d.qrCodeId,
                paymentId: d.paymentId,
                rrnNumber: d.rrnNumber,
                amount: d.amount,
                vpa: d.vpa,
                created_at: d.created_at,
                status: d.status,
            });
            const docs = transactions.documents.map(pickTxn);

            // const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({ transactions: docs, nextCursor });

        } catch (error) {
            console.error('Error fetching transactions:', error);
            res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    });

    // GET /transactions/aggregate
    // Admin/Subadmin with all_transactions label
    // GET /transactions/aggregate-all
    // router.get('/transactions/aggregate-all', async (req, res) => {
    // const {
    //     startCursor,
    //     pageLimit = 100,
    //     maxPages = 200, // scans up to 20,000 docs by default
    // } = req.query;

    // const limitNum = Math.min(parseInt(pageLimit) || 100, 100);
    // const maxPagesNum = Math.min(parseInt(maxPages) || 200, 200);

    // try {
    //     let totalCount = 0;
    //     let vpaNullCount = 0;
    //     let vpaPresentCount = 0;
    //     let totalAmountPaise = 0;

    //     let cursor = startCursor || null;
    //     let page = 0;
    //     let hasMore = true;

    //     while (hasMore && page < maxPagesNum) {
    //     const queries = [Query.orderDesc('created_at'), Query.limit(limitNum)];
    //     if (cursor) queries.push(Query.cursorAfter(cursor));

    //     const resp = await databases.listDocuments(
    //         APPWRITE_DATABASE_ID,
    //         webhook_collectionId,
    //         queries
    //     );

    //     const docs = resp.documents || [];

    //     for (const d of docs) {
    //         totalCount += 1;

    //         const v = d.vpa;
    //         const vpaEmpty = v == null || (typeof v === 'string' && v.trim() === '');
    //         if (vpaEmpty) vpaNullCount += 1; else vpaPresentCount += 1;

    //         const amt = Number.isFinite(d.amount) ? d.amount : parseInt(d.amount || 0, 10);
    //         if (!isNaN(amt)) totalAmountPaise += amt;
    //     }

    //     if (docs.length === limitNum) {
    //         cursor = docs[docs.length - 1].$id;
    //         hasMore = true;
    //     } else {
    //         hasMore = false;
    //         if (docs.length > 0) cursor = docs[docs.length - 1].$id;
    //     }

    //     page += 1;
    //     }

    //     return res.status(200).json({
    //     totalCount,
    //     vpaNullCount,
    //     vpaPresentCount,
    //     totalAmountPaise,
    //     hasMore,
    //     cursor,
    //     pageSize: limitNum,
    //     pagesScanned: page,
    //     });
    // } catch (err) {
    //     console.error('Error aggregating all transactions:', err);
    //     return res.status(500).json({ error: 'Failed to aggregate transactions' });
    // }
    // });

    // Helper: convert amount to paise
    const toPaise = (amt) => Math.round(amt * 100);

    router.patch('/transactions/:id/status', authenticateAdminOrLabel('edit_transactions'), async (req, res) => {
        try {
            const { id: TxnID } = req.params;
            const { status } = req.body;

            // 1) Validate payload contains ONLY status
            if (Object.keys(req.body).some(k => k !== 'status')) {
            return res.status(400).json({ error: 'Only status can be updated here' });
            }
            const allowed = new Set(['normal','cyber','refund','chargeback']);
            if (typeof status !== 'string' || !allowed.has(status.toLowerCase())) {
            return res.status(400).json({ error: 'Invalid status' });
            }
            const nextStatus = status.toLowerCase();

            // 2) Load transaction
            const txDocs = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId,
            [Query.equal('$id', TxnID), Query.limit(1)]);
            const tx = txDocs.documents[0];
            if (!tx) return res.status(404).json({ error: 'Transaction not found' });

            const prevStatus = ((tx.status || 'normal').trim().toLowerCase());
            if (prevStatus === nextStatus) {
                return res.status(200).json({ message: 'No status change', transaction: tx });
            }

            // 3) Update status field on transaction
            const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, webhook_collectionId, TxnID, { status: nextStatus });

            // 4) Reconcile holds for the QR (boundary crossing only)
            if (tx.qrCodeId) {
            const qrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId,
                [Query.equal('qrId', tx.qrCodeId), Query.limit(1)]);
            if (qrList.documents.length) {
                const qr = qrList.documents[0];
                const amt = Number(updated.amount ?? tx.amount ?? 0);
                const currentHold = Number(qr.amountOnHold || 0);

                const crossingToHold = prevStatus === 'normal' && nextStatus !== 'normal';
                const releasingHold = prevStatus !== 'normal' && nextStatus === 'normal';

                let nextHold = currentHold;
                if (crossingToHold) nextHold = currentHold + amt;
                if (releasingHold) nextHold = currentHold - amt;

                const total = Number(qr.totalPayInAmount || 0);
                const approved = Number(qr.withdrawalApprovedAmount || 0);
                const requested = Number(qr.withdrawalRequestedAmount || 0);
                const commissionOnHold = Number(qr.commissionOnHold || 0);
                const commissionPaid = Number(qr.commissionPaid || 0);
                const nextAvailable = total - approved - requested - nextHold - (commissionOnHold + commissionPaid);

                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                amountOnHold: nextHold,
                amountAvailableForWithdrawal: nextAvailable,
                });
            }
            }

            const toInt = (x) => (Number.isFinite(x) ? x : parseInt(x || 0, 10));
            const amt = toInt(updated.amount);

            const prev = (prevStatus || 'normal').toLowerCase();
            const next = (nextStatus || 'normal').toLowerCase();

            // Helpers
            const inc = (key, delta) =>
            updateDashboardCounter(databases, APPWRITE_DATABASE_ID, key, delta).catch((e) =>
                console.error(`Error updating ${key}:`, e)
            );

            if (prev === next) {
            console.log('Status unchanged:', prev, '->', next);
            } else if (prev === 'normal' && next === 'cyber') {
            console.log('normal -> cyber');
            await inc('cyberCount', 1);
            await inc('cyberAmount', amt);
            } else if (prev === 'normal' && next === 'refund') {
            console.log('normal -> refund');
            await inc('refundCount', 1);
            await inc('refundAmount', amt);
            } else if (prev === 'normal' && next === 'chargeback') {
            console.log('normal -> chargeback');
            await inc('chargebackCount', 1);
            await inc('chargebackAmount', amt);
            } else if (prev === 'cyber' && next === 'normal') {
            console.log('cyber -> normal');
            await inc('cyberCount', -1);
            await inc('cyberAmount', -amt);
            } else if (prev === 'refund' && next === 'normal') {
            console.log('refund -> normal');
            await inc('refundCount', -1);
            await inc('refundAmount', -amt);
            } else if (prev === 'chargeback' && next === 'normal') {
            console.log('chargeback -> normal');
            await inc('chargebackCount', -1);
            await inc('chargebackAmount', -amt);
            } else if (prev === 'cyber' && next === 'refund') {
            console.log('cyber -> refund');
            await inc('cyberCount', -1);
            await inc('cyberAmount', -amt);
            await inc('refundCount', 1);
            await inc('refundAmount', amt);
            } else if (prev === 'cyber' && next === 'chargeback') {
            console.log('cyber -> chargeback');
            await inc('cyberCount', -1);
            await inc('cyberAmount', -amt);
            await inc('chargebackCount', 1);
            await inc('chargebackAmount', amt);
            } else if (prev === 'refund' && next === 'cyber') {
            console.log('refund -> cyber');
            await inc('refundCount', -1);
            await inc('refundAmount', -amt);
            await inc('cyberCount', 1);
            await inc('cyberAmount', amt);
            } else if (prev === 'refund' && next === 'chargeback') {
            console.log('refund -> chargeback');
            await inc('refundCount', -1);
            await inc('refundAmount', -amt);
            await inc('chargebackCount', 1);
            await inc('chargebackAmount', amt);
            } else if (prev === 'chargeback' && next === 'cyber') {
            console.log('chargeback -> cyber');
            await inc('chargebackCount', -1);
            await inc('chargebackAmount', -amt);
            await inc('cyberCount', 1);
            await inc('cyberAmount', amt);
            } else if (prev === 'chargeback' && next === 'refund') {
            console.log('chargeback -> refund');
            await inc('chargebackCount', -1);
            await inc('chargebackAmount', -amt);
            await inc('refundCount', 1);
            await inc('refundAmount', amt);
            } else {
            console.log('Unhandled transition:', prev, '->', next, 'no counters changed');
            }

            return res.status(200).json({ message: 'Status updated', transaction: updated });
        } catch (err) {
            console.error('❌ Status update error:', err);
            return res.status(500).json({ error: err.message || 'Update failed' });
        }
    });

    // ✏️ Edit transaction endpoint
    router.patch('/transactions/:id',  authenticateAdminOrLabel('edit_transactions'), async (req, res) => {
    try {
        const { id: TxnID } = req.params;
        const { qrCodeId, rrnNumber, amount, isoDate /* status removed */ } = req.body;

        // Guard: status is not allowed in this endpoint
        if ('status' in req.body) {
            return res.status(400).json({ error: 'Use /transactions/:id/status to update status' });
        } // enforce separation of concerns [web:185][web:198]

        // 1) Fetch existing transaction
        const Txndocuments = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        webhook_collectionId,
        [Query.equal('$id', TxnID), Query.limit(1)]
        );
        const tx = Txndocuments.documents[0];
        if (!tx) return res.status(404).json({ error: 'Transaction not found' }); // standard REST practice [web:185]

        // 2) Prepare validated updates (partial)
        const updates = {};
        if (typeof rrnNumber === 'string' && rrnNumber.trim()) {
        updates.rrnNumber = rrnNumber.trim();
        }
        if (typeof qrCodeId === 'string' && qrCodeId.trim()) {
        updates.qrCodeId = qrCodeId.trim();
        }
        if (typeof isoDate === 'string' && isoDate.trim()) {
            const iso = new Date(isoDate);
        if (isNaN(iso.getTime())) {
            return res.status(400).json({ error: 'isoDate must be ISO-8601' });
        } // input validation best practice [web:185]
        updates.created_at = iso.toISOString();
        }
        let newAmountPaise;
        if (amount !== undefined && amount !== null) {
            newAmountPaise = toPaise(String(amount)); // normalize rupees to paise [web:185]
            updates.amount = newAmountPaise;
        }

        // 3) Early exit if no updates
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        } // minimal mutation principle [web:185]

        // 4) Capture old for reconciliation
        const oldQrId = tx.qrCodeId;
        const oldAmountPaise = Number(tx.amount || 0);
        const prevStatus = ((tx.status && tx.status.trim()) || 'normal').toLowerCase(); // use existing status only [web:185]

        // 5) Persist transaction updates
        const updated = await databases.updateDocument(
        APPWRITE_DATABASE_ID,
        webhook_collectionId,
        TxnID,
        updates
        ); // apply partial update before aggregates [web:198]

        // 6) Helpers
        const recomputeAvailable = (qrDocLike) => {
            const total = Number(qrDocLike.totalPayInAmount || 0);
            const approved = Number(qrDocLike.withdrawalApprovedAmount || 0);
            const requested = Number(qrDocLike.withdrawalRequestedAmount || 0);
            const commissionOnHold = Number(qrDocLike.commissionOnHold || 0);
            const commissionPaid = Number(qrDocLike.commissionPaid || 0);
            const hold = Number(qrDocLike.amountOnHold || 0);
            return total - approved - requested - hold - (commissionOnHold + commissionPaid);
        }; // available is derived, not set arbitrarily [web:170][web:176]

        const hasAmountChange = typeof newAmountPaise === 'number' && newAmountPaise !== oldAmountPaise;
        const newQrId = updates.qrCodeId ?? oldQrId;
        const movedQr = newQrId !== oldQrId;

        const isPrevNormal = prevStatus === 'normal'; // status snapshot used for reconciliation [web:185]

        // 5A) Same QR, amount changed: adjust based on existing status
        if (hasAmountChange && !movedQr) {
        const amountDiff = newAmountPaise - oldAmountPaise; // +/- delta [web:185]

        const qrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', oldQrId),
            Query.limit(1),
        ]);
            if (qrList.documents.length) {
                const qr = qrList.documents[0];

                if (isPrevNormal) {
                    // Normal: adjust ledger total; available derives from totals
                    const newTotal = Number(qr.totalPayInAmount || 0) + amountDiff;
                    await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                        totalPayInAmount: newTotal,
                        amountAvailableForWithdrawal: recomputeAvailable({ ...qr, totalPayInAmount: newTotal }),
                    }); // no hold change in normal edits [web:176][web:179]
                } else {
                    // Non-normal: adjust both ledger total and hold; available derives from both
                    const delta = (newAmountPaise - oldAmountPaise);
                    const newTotal = Number(qr.totalPayInAmount || 0) + delta;
                    const newHold = Number(qr.amountOnHold || 0) + delta;
                    await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                        totalPayInAmount: newTotal,
                        amountOnHold: newHold,
                        amountAvailableForWithdrawal: recomputeAvailable({ ...qr, totalPayInAmount: newTotal, amountOnHold: newHold }),
                    });
                }
            }

            // const iso = new Date(isoDate);

            const istDate = moment.tz(tx.created_at, 'Asia/Kolkata');
            const istDateFromIso = istDate.format('YYYY-MM-DD HH:mm:ss');
            console.log('istDate:', istDateFromIso);

            const dayString = istDate.format('YYYY-MM-DD'); // directly format date only

            console.log('dayString:', dayString);
            console.log('isoDate:', dayString);
            console.log('qrId:', oldQrId);

            // Query existing document by date only (no qrId filter, since totalsJson covers all)
            const existingQrSummary = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', dayString),
                Query.limit(1),
            ]
            );

            const delta = newAmountPaise - oldAmountPaise;

            if (existingQrSummary.total > 0) {
            // Document exists - parse JSON string and update totals object
            const doc = existingQrSummary.documents[0];
            const totalsJsonStr = doc.totalsJson || '{}';

            let totalsObj;
            try {
                totalsObj = JSON.parse(totalsJsonStr);
            } catch (e) {
                totalsObj = {};
            }

            const oldAmount = Number(totalsObj[oldQrId] || 0);
            const newAmount = oldAmount + delta;

            if (newAmount < 0) {
                throw new Error('Total amount cannot be negative');
            }

            totalsObj[oldQrId] = newAmount;

            // Serialize and update the document
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                doc.$id,
                {
                    totalsJson: JSON.stringify(totalsObj),
                }
            );
            }
            // else {
            // // No summary exists - create a new one if newAmount > 0
            // if (newAmount > 0) {
            //     await databases.createDocument(
            //     APPWRITE_DATABASE_ID,
            //     APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            //     ID.unique(),
            //     {
            //         qrId: oldQrId,
            //         date: dayString,
            //         total_amount: newAmount,
            //         last_updated: new Date().toISOString(),
            //     }
            //     );
            // }
            // }

        }

        // 5B) QR changed: remove prior impact from old QR, add new impact to new QR, based on existing status
        if (movedQr) {
        // Old QR: reverse prior impact
        if (oldQrId) {
            const oldQrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', oldQrId),
            Query.limit(1),
            ]);
            if (oldQrList.documents.length) {
            const oldQr = oldQrList.documents[0];
            if (isPrevNormal) {
                const newTotal = Number(oldQr.totalPayInAmount || 0) - oldAmountPaise;
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
                totalPayInAmount: newTotal,
                totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
                amountAvailableForWithdrawal: recomputeAvailable({ ...oldQr, totalPayInAmount: newTotal }),
                }); // remove from totals for normal tx [web:176][web:179]
            } else {
                const newHold = Number(oldQr.amountOnHold || 0) - oldAmountPaise;
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
                amountOnHold: newHold,
                totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
                amountAvailableForWithdrawal: recomputeAvailable({ ...oldQr, amountOnHold: newHold }),
                }); // remove from hold for non-normal tx [web:170][web:176]
            }
            }
        }

        // New QR: apply current impact with existing status
        if (newQrId) {
            const newQrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
            Query.equal('qrId', newQrId),
            Query.limit(1),
            ]);
            if (newQrList.documents.length) {
            const newQr = newQrList.documents[0];
            const postAmount = Number(updated.amount ?? oldAmountPaise); // use new amount if changed [web:185]

            if (isPrevNormal) {
                const newTotal = Number(newQr.totalPayInAmount || 0) + postAmount;
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, newQr.$id, {
                totalPayInAmount: newTotal,
                totalTransactions: (newQr.totalTransactions || 0) + 1,
                amountAvailableForWithdrawal: recomputeAvailable({ ...newQr, totalPayInAmount: newTotal }),
                }); // add to totals for normal tx [web:176][web:179]
            } else {
                const newHold = Number(newQr.amountOnHold || 0) + postAmount;
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, newQr.$id, {
                amountOnHold: newHold,
                totalTransactions: (newQr.totalTransactions || 0) + 1,
                amountAvailableForWithdrawal: recomputeAvailable({ ...newQr, amountOnHold: newHold }),
                }); // add to holds for non-normal tx [web:170][web:176]
            }
            } else {
            console.warn(`Target QR ${newQrId} not found while reconciling`); // operational logging [web:185]
            }
        }
        }

        return res.status(200).json({ message: 'Transaction updated', transaction: updated });
    } catch (err) {
        console.error('❌ Edit transaction error:', err.message || err);
        return res.status(500).json({ error: err.message || 'Update failed' });
    }
    });

    // DELETE /admin/transactions/:id
    router.delete('/transactions/:id', authenticateAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            // 1) Load transaction by $id
            const tx = await databases.getDocument(
            APPWRITE_DATABASE_ID,
            webhook_collectionId,
            id
            );
            if (!tx) return res.status(404).json({ error: 'Transaction not found' });

            const amountPaise = Number(tx.amount || 0); // paise
            const qrId = tx.qrCodeId;

            // 2) Reconcile QR aggregates (if linked)
            if (qrId) {
            const qrList = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal('qrId', qrId), Query.limit(1)]
            );

            if (qrList.documents.length) {
                const qrDoc = qrList.documents[0];

                // Determine existing status classification
                const prevStatus = ((tx.status || 'normal').trim().toLowerCase());
                const isPrevNormal = prevStatus === 'normal';

                // Start from current values
                const currentTotal = Number(qrDoc.totalPayInAmount || 0);
                const currentHold = Number(qrDoc.amountOnHold || 0);

                // Apply removal based on status
                const nextTotal = isPrevNormal
                ? Math.max(0, currentTotal - amountPaise)
                : (currentTotal - amountPaise); // non-normal removal doesn't change ledger total
                const nextHold = isPrevNormal
                ? currentHold
                : Math.max(0, currentHold - amountPaise); // remove from holds for non-normal

                // Recompute available as a derived field (include holds)
                const approved = Number(qrDoc.withdrawalApprovedAmount || 0);
                const requested = Number(qrDoc.withdrawalRequestedAmount || 0);
                const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
                const commissionPaid = Number(qrDoc.commissionPaid || 0);
                const nextAvailable = nextTotal - approved - requested - nextHold - commissionOnHold - commissionPaid;

                await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                qrDoc.$id,
                    {
                        totalPayInAmount: nextTotal,
                        amountOnHold: nextHold,
                        totalTransactions: Math.max(0, (qrDoc.totalTransactions || 0) - 1),
                        amountAvailableForWithdrawal: nextAvailable,
                    }
                );

            const istDate = moment.tz(tx.created_at, 'Asia/Kolkata');
            const istDateFromIso = istDate.format('YYYY-MM-DD HH:mm:ss');
            console.log('istDate:', istDateFromIso);

            const dayString = istDate.format('YYYY-MM-DD'); // direct date format
            console.log('dayString:', dayString);
            console.log('isoDate:', dayString);
            console.log('qrId:', qrId);

            // Query existing document only by date because totalsJson contains all qrId totals
            const existingQrSummary = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
            [
                Query.equal('date', dayString),
                Query.limit(1),
            ]
            );

            if (existingQrSummary.total > 0) {
            const doc = existingQrSummary.documents[0];

            // Parse totalsJson string or fallback to empty object
            let totalsObj = {};
            try {
                totalsObj = JSON.parse(doc.totalsJson || '{}');
            } catch (e) {
                totalsObj = {};
            }

            const currentTotal = Number(totalsObj[qrId] || 0);
            const newTotal = currentTotal - amountPaise;

            if (newTotal < 0) {
                throw new Error('Total amount cannot be negative');
            }

            totalsObj[qrId] = newTotal;

            // Serialize updated object and save
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                doc.$id,
                {
                    totalsJson: JSON.stringify(totalsObj),
                }
            );
            } 
            // Optionally handle creation of new document if none exists


            } else {
                    console.warn(`QR ${qrId} not found during delete reconciliation`);
                }
            }

            // 3) Delete the transaction
            await databases.deleteDocument(
                APPWRITE_DATABASE_ID,
                webhook_collectionId,
                id
            );

            // After successful deletion
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalTxCount', -1).catch((e) => {
                console.error('Error updating dashboard counter:', e);
            });

            if (tx.provider === 'manual') {
                    await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalManualTx', -1).catch((e) => {
                    console.error('Error updating dashboard counter:', e);
                });
            } else {
                    await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalApiTx', -1).catch((e) => {
                    console.error('Error updating dashboard counter:', e);
                });
            }

            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAmountReceived', -amountPaise).catch((e) => {
                console.error('Error updating dashboard counter:', e);
            });

            return res.status(200).json({ message: 'Transaction deleted', id });
        } catch (err) {
            console.error('❌ Delete transaction error:', err.message || err);
            return res.status(500).json({ error: err.message || 'Delete failed' });
        }
    });

    router.post("/transactions/manual", authenticateAdminOrLabel('manual_transactions'), async (req, res) => {
        try {
            const { qrCodeId, rrnNumber, amount, isoDate } = req.body;

            // ✅ Validate required fields
            if (!qrCodeId || !rrnNumber || !amount || !isoDate) {
            return res.status(400).json({
                error: "qrCodeId, rrnNumber, amount, and isoDate are required",
            });
            }

            // ✅ Check for duplicate RRN
            const duplicate = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                webhook_collectionId, // webhook_data collection ID
                [Query.equal("rrnNumber", rrnNumber)]
            );

            if (duplicate.documents.length) {
                return res.status(400).json({ error: "Duplicate RRN detected" });
            }

            // ✅ Convert values
            const finalAmount = toPaise(amount);

            // Create document in webhook_data collection
            const result = await databases.createDocument(
                APPWRITE_DATABASE_ID,
                webhook_collectionId, // webhook_data collection ID
                ID.unique(),
                    {
                        payload: "", // optional, can be passed too
                        qrCodeId: qrCodeId,
                        paymentId: "", // optional
                        rrnNumber: rrnNumber,
                        amount: finalAmount,
                        vpa: "", // optional
                        provider: 'manual',
                        created_at: isoDate, // current IST time
                        status: 'normal', // default status
                    }
            );

            // (async () => {
            // try {
            //     await updateDailyQrTotal(
            //         qrCodeId,
            //         isoDate,
            //         finalAmount
            //     );
            //     console.log('Daily QR total updated successfully.');
            // } catch (error) {
            //     console.error('Error updating daily QR total:', error);
            // }
            // })();

            await updateDailyQrTotal(qrCodeId, isoDate, amountPaise).catch((e) => {
                console.error('❌ Error updating daily QR total:', error?.message || error);
            });

            const eventPayload = {
                $id: result.$id,                                    // document id
                qrCodeId : qrCodeId,
                paymentId : "",                                           // string
                amount: finalAmount,                           // exact integer
                rrnNumber: rrnNumber || null,
                vpa: "",
                provider: 'manual',
                created_at: isoDate,    // normalize to ISO
                status: 'normal',                                 // default status
            }; // normalized event payload for clients [2]

            // 5) Emit only to intended audiences (user + QR rooms)
            emitTxnNew({
                assignedUserId : '',      // may be null if QR not found
                qrCodeId,
                payload: eventPayload,
            });

            // 3️⃣ Update the corresponding QR code totals
            if (qrCodeId) {
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal('qrId', qrCodeId), Query.limit(1)]
            );

                if (qrResult.documents.length) {
                    const qrDoc = qrResult.documents[0];

                    const newTransactions = (qrDoc.totalTransactions || 0) + 1;
                    const newTotal = (qrDoc.totalPayInAmount || 0) + finalAmount;

                    // Recompute available from updated total
                    const approved = Number(qrDoc.withdrawalApprovedAmount || 0);
                    const requested = Number(qrDoc.withdrawalRequestedAmount || 0);

                    const onHold = Number(qrDoc.amountOnHold || 0);
                    const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
                    const commissionPaid = Number(qrDoc.commissionPaid || 0);
                    const newAvailable = newTotal - approved - requested - onHold - commissionOnHold - commissionPaid;

                    await databases.updateDocument(
                    APPWRITE_DATABASE_ID,
                    Qr_collectionId,
                    qrDoc.$id,
                    {
                        totalTransactions: newTransactions,
                        totalPayInAmount: newTotal,
                        amountAvailableForWithdrawal: newAvailable, // <-- add this
                    }
                    );
                }
            }

            // 4️⃣ Update global counters (async, no await)
            // totalTxCount
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalTxCount', 1).catch((e) => {
                console.error('Error updating dashboard counter:', e);
            });

            // totalManualTx
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalManualTx', 1).catch((e) => {
                console.error('Error updating dashboard counter:', e);
            });

            // totalAmountReceived
            await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalAmountReceived', finalAmount).catch((e) => {
                console.error('Error updating dashboard counter:', e);
            });

            return res.status(201).json({
                message: "Transaction uploaded successfully",
                transaction: result,
            });

        } catch (err) {
            console.error("❌ Manual transaction error:", err.message || err);
            return res.status(500).json({ error: err.message || "Transaction upload failed" });
        }
    });

    // Fetch transactions only for that user with optional one-field search
    router.get('/user/transactions', authenticateToken, async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to, status, searchField, searchValue } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 50);

        // console.log('Transaction query params:', req.query);

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';

        if (!isSubadmin && userRequested.userId !== userId) {
            return res.status(403).json({ error: 'Forbidden: Cannot access other users\' transactions' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const filters = [];

        try {
            const userQrIds = isSubadmin ? await getQrIdsForSubadmin(userId) : await getQrIdsForUser(userId);
            // console.log('User QR IDs:', userQrIds);
            if (qrId) {
                if (userQrIds.includes(qrId) || isAdmin) {
                    filters.push(Query.equal('qrCodeId', qrId));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            } else {
                if (userQrIds.length === 0) {
                    return res.status(200).json({ transactions: [] });
                }
                filters.push(Query.equal('qrCodeId', userQrIds));
            }

            // Date filter helper same as above
            function toISTRange(dateStr) {
            const d = new Date(dateStr);
            const start = new Date(d);
            start.setHours(0, 0, 0, 0);
            start.setMinutes(start.getMinutes() - 330);
            const end = new Date(d);
            end.setHours(23, 59, 59, 999);
            end.setMinutes(end.getMinutes() - 330);
            return { start, end };
            }

            if (from && to) {
            if (from === to) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
            } else {
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
            }
            } else if (from && !to) {
            const { start, end } = toISTRange(from);
            filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
            } else if (!from && to) {
            const { end } = toISTRange(to);
            filters.push(Query.lessThanEqual('created_at', end.toISOString()));
            }

            // Single field search if provided and valid
            if (searchField && searchValue) {
                const fulltextFields = ['vpa', 'paymentId', 'qrCodeId'];
                const exactMatchFields = ['amount', 'rrnNumber'];

                if (fulltextFields.includes(searchField)) {
                    // Use fulltext search for these fields
                    filters.push(Query.search(searchField, searchValue));
                } else if (searchField === 'amount') {
                    const amountValue = parseInt(searchValue, 10);
                    if (isNaN(amountValue)) {
                    return res.status(400).json({ error: 'Amount must be an integer value' });
                    }
                    filters.push(Query.equal('amount', amountValue*100));
                } else if (searchField === 'rrnNumber') {
                    // rrnNumber exact match as string
                    filters.push(Query.equal('rrnNumber', searchValue));
                } else {
                    return res.status(400).json({ error: 'Invalid searchField parameter' });
                }
            }

            if(status){
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback']); // enum gate [14]
                if (!allowedStatuses.has(status.toLowerCase())) {
                    return res.status(400).json({ error: 'Invalid status filter' }); // 400 on bad input [14]
                }
                if(status.toLowerCase() === 'normal'){
                    filters.push(
                        Query.or([
                            Query.equal('status', 'normal'),
                            Query.equal('status', ''),       // if some docs stored empty string
                            Query.isNull('status'),          // null or missing field
                        ])
                    );
                }else{
                    filters.push(Query.equal('status', status.toLowerCase()));
                }
            }

            const queries = [...filters, Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const transactions = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);

            const pickTxn = (d) => ({
                $id: d.$id,   
                id: d.$id,                // keep if needed
                qrCodeId: d.qrCodeId,
                paymentId: d.paymentId,
                rrnNumber: d.rrnNumber,
                amount: d.amount,
                vpa: d.vpa,
                created_at: d.created_at,
                status: d.status,
            });
            const docs = transactions.documents.map(pickTxn);

            // const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({ transactions: docs, nextCursor });

        } catch (error) {
            console.error('❌ Error in /user/transactions:', error);
            res.status(500).json({ error: 'Failed to fetch user transactions' });
        }
    });

    router.get('/user/transactions/export', authenticateToken, async (req, res) => {
        const { userId, qrId, from, to, status, searchField, searchValue, maxTxns = 50 } = req.query;
        const maxTxnsNum = Math.min(parseInt(maxTxns) || 50, 500);  // safety limit

        console.log('Export transaction query params:', req.query);

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';

        if(!isAdmin){

            if (!isSubadmin && userRequested.userId !== userId) {
                return res.status(403).json({ error: 'Forbidden: Cannot access other users\' transactions' });
            }

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

        }

        let allTxns = [];
        let cursor = null;

        do {
            const filters = [];

            try {
            const userQrIds = isSubadmin ? await getQrIdsForSubadmin(userId) : await getQrIdsForUser(userId);
            
            if (qrId) {
                if (userQrIds.includes(qrId) || isAdmin) {
                filters.push(Query.equal('qrCodeId', qrId));
                } else {
                return res.status(200).json({ transactions: [] });
                }
            } else {
                if (userQrIds.length === 0) {
                return res.status(200).json({ transactions: [] });
                }
                filters.push(Query.equal('qrCodeId', userQrIds));
            }

            // Date filter helper (copied exactly)
            function toISTRange(dateStr) {
                const d = new Date(dateStr);
                const start = new Date(d);
                start.setHours(0, 0, 0, 0);
                start.setMinutes(start.getMinutes() - 330);
                const end = new Date(d);
                end.setHours(23, 59, 59, 999);
                end.setMinutes(end.getMinutes() - 330);
                return { start, end };
            }

            if (from && to) {
                if (from === to) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
                } else {
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
                }
            } else if (from && !to) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between('created_at', start.toISOString(), end.toISOString()));
            } else if (!from && to) {
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual('created_at', end.toISOString()));
            }

            // Single field search (copied exactly)
            if (searchField && searchValue) {
                const fulltextFields = ['vpa', 'paymentId', 'qrCodeId'];
                const exactMatchFields = ['amount', 'rrnNumber'];

                if (fulltextFields.includes(searchField)) {
                filters.push(Query.search(searchField, searchValue));
                } else if (searchField === 'amount') {
                const amountValue = parseInt(searchValue, 10);
                if (isNaN(amountValue)) {
                    return res.status(400).json({ error: 'Amount must be an integer value' });
                }
                filters.push(Query.equal('amount', amountValue * 100));
                } else if (searchField === 'rrnNumber') {
                filters.push(Query.equal('rrnNumber', searchValue));
                } else {
                return res.status(400).json({ error: 'Invalid searchField parameter' });
                }
            }

            if (status) {
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback']);
                if (!allowedStatuses.has(status.toLowerCase())) {
                return res.status(400).json({ error: 'Invalid status filter' });
                }
                if (status.toLowerCase() === 'normal') {
                filters.push(
                    Query.or([
                    Query.equal('status', 'normal'),
                    Query.equal('status', ''),
                    Query.isNull('status'),
                    ])
                );
                } else {
                filters.push(Query.equal('status', status.toLowerCase()));
                }
            }

            const queries = [
                ...filters,
                Query.orderDesc('created_at'),
                Query.limit(100),
                ...(cursor ? [Query.cursorAfter(cursor)] : [])
            ];

            const result = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);
            allTxns.push(...result.documents);
            cursor = result.documents[99]?.$id;

            } catch (error) {
            console.error('❌ Export pagination error:', error);
            break;
            }

        } while (allTxns.length < maxTxnsNum && cursor);

        // Limit to requested max
        allTxns = allTxns.slice(0, maxTxnsNum);

        const pickTxn = (d) => ({
            $id: d.$id,
            id: d.$id,
            qrCodeId: d.qrCodeId,
            paymentId: d.paymentId,
            rrnNumber: d.rrnNumber,
            amount: d.amount,
            vpa: d.vpa,
            created_at: d.created_at,
            status: d.status,
        });

        const docs = allTxns.map(pickTxn);

        res.json({
            success: true,
            count: docs.length,
            transactions: docs,
            filters: { userId, qrId, from, to, status, searchField, searchValue }
        });

    });


    router.get('/getMyMetaData', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId; // set by your JWT middleware

            // console.log('getMyMetaData for userId:', userId);

            const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal('userId', userId)] // must be in an array
            );

            if (!result.documents.length) {
            return res.status(404).json({ error: 'User metadata not found 2' });
            }

            const doc = result.documents[0];

            // console.log('getMyMetaData doc:', doc);

            // Optionally pick only safe fields
            const payload = {
            id: doc.userId,
            email: doc.email,
            name: doc.name,
            role: doc.role,
            parentId: doc.parentId,
            status: doc.status,
            labels: doc.labels,
            commission: doc.commission || 0,
            // childrenCount: doc.childrenCount, // if you added counter cache
            };

            // console.log('getMyMetaData payload:', payload);

            return res.json(payload);
        } catch (err) {
            console.error('getMyMetaData error:', err);
            return res.status(500).json({ error: 'Failed to fetch metadata' });
        }
    });

    // GET /commissions
    // Roles: admin and subadmin (optional narrowing by current user)
    router.get('/commissions',authenticateAdminOrLabel('all_commissions', { isSubadminAllowed: true }),
        async (req, res) => {
            const {
            userId,
            earningType,           // 'admin' | 'subadmin'
            sourceWithdrawalId,    // exact match
            minAmount,             // paise or rupees? assume paise; see normalize below
            maxAmount,
            from,                  // 'YYYY-MM-DD' (IST day)
            to,                    // 'YYYY-MM-DD' (IST day)
            searchField,           // 'userId' | 'sourceWithdrawalId'
            searchValue,
            limit = 25,
            cursor
            } = req.query;

            const limitNum = Math.min(parseInt(limit) || 25, 50);
            const filters = [];

            const requestorId = req.user.userId;
            const role = req.user.role; // 'admin' | 'subadmin'

            try {
            // Access control example: subadmin can default to own commissions unless labels widen it
            const requester = req.user;
            const isSubadmin = requester.role === 'subadmin';
            const isAdmin = requester.role === 'admin';

            // Field filters
            if (userId && isAdmin) {
                filters.push(Query.equal('userId', userId));
            }

            if(isSubadmin) {
                filters.push(Query.equal('userId', requester.userId));
            }

            if (earningType) {
                const allowed = new Set(['admin', 'subadmin']);
                const et = String(earningType).toLowerCase();
                if (!allowed.has(et)) {
                return res.status(400).json({ error: 'Invalid earningType' });
                }
                filters.push(Query.equal('earningType', et));
            }

            if (sourceWithdrawalId) {
                filters.push(Query.equal('sourceWithdrawalId', sourceWithdrawalId));
            }

            // Search: allow search on userId or sourceWithdrawalId (text)
            if (searchField && searchValue) {
                const searchable = new Set(['userId', 'sourceWithdrawalId']);
                if (!searchable.has(searchField)) {
                return res.status(400).json({ error: 'Invalid searchField' });
                }
                filters.push(Query.search(searchField, String(searchValue)));
            }

            // Amount range (normalize to integer)
            const toInt = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? Math.trunc(n) : null;
            };
            const minA = toInt(minAmount);
            const maxA = toInt(maxAmount);
            if (minA != null && maxA != null) {
                filters.push(Query.between('amount', minA, maxA));
            } else if (minA != null) {
                filters.push(Query.greaterThanEqual('amount', minA));
            } else if (maxA != null) {
                filters.push(Query.lessThanEqual('amount', maxA));
            }

            // IST day range helper
            function istDayRangeISO(dateStr) {
                const d = new Date(dateStr);
                const start = new Date(d);
                start.setHours(0, 0, 0, 0);
                // shift to UTC by subtracting 5h30m to represent IST day in UTC
                start.setMinutes(start.getMinutes() - 330);
                const end = new Date(d);
                end.setHours(23, 59, 59, 999);
                end.setMinutes(end.getMinutes() - 330);
                return { startISO: start.toISOString(), endISO: end.toISOString() };
            }

            // Date filters (createdAt field is ISO string)
            if (from && to) {
                if (from === to) {
                const { startISO, endISO } = istDayRangeISO(from);
                filters.push(Query.between('createdAt', startISO, endISO));
                } else {
                const { startISO } = istDayRangeISO(from);
                const { endISO } = istDayRangeISO(to);
                filters.push(Query.between('createdAt', startISO, endISO));
                }
            } else if (from && !to) {
                const { startISO, endISO } = istDayRangeISO(from);
                filters.push(Query.between('createdAt', startISO, endISO));
            } else if (!from && to) {
                const { endISO } = istDayRangeISO(to);
                filters.push(Query.lessThanEqual('createdAt', endISO));
            }

            // Build query list with ordering + pagination
            const queries = [
                ...filters,
                Query.orderDesc('createdAt'),  // ensure index on createdAt
                Query.limit(limitNum),
            ];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            // Fetch
            const resp = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID,
                queries
            ); // list with filters/order/cursor [web:50][web:91]

            // Shape response
            const pick = (d) => ({
                $id: d.$id,
                id: d.$id,
                userId: d.userId,
                sourceWithdrawalId: d.sourceWithdrawalId,
                amount: d.amount,
                commissionRate: d.commissionRate,
                earningType: d.earningType,
                createdAt: d.createdAt,
            });

            const docs = resp.documents.map(pick);
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            return res.status(200).json({ commissions: docs, nextCursor });
            } catch (err) {
            console.error('Error fetching commissions:', err);
            return res.status(500).json({ error: 'Failed to fetch commissions' });
            }
        }
    );

    function parseModeAndRange(q) {
        const tz = 'Asia/Kolkata';
        const mode = String(q.mode || 'today').toLowerCase();

        const asISTStart = (ts) => dayjs(ts).tz(tz).startOf('day'); // IST midnight
        const fmt = (d) => d.tz(tz).format('YYYY-MM-DD');           // IST day key

        if (mode === 'today') {
            const d = asISTStart(dayjs());
            return { start: d, end: d, startStr: fmt(d), endStr: fmt(d) };
        }

        if (mode === 'date') {
            const d = asISTStart(String(q.date));
            if (!d.isValid()) throw new Error('Invalid date');
            return { start: d, end: d, startStr: fmt(d), endStr: fmt(d) };
        }

        if (mode === 'range') {
            const s = asISTStart(String(q.start));
            const e = asISTStart(String(q.end));
            if (!s.isValid() || !e.isValid()) throw new Error('Invalid range');
            if (e.isBefore(s)) throw new Error('end < start');
            return { start: s, end: e, startStr: fmt(s), endStr: fmt(e) };
        }

        if (mode === 'last') {
            const n = Math.max(1, Math.min(366, parseInt(String(q.days || '7'), 10) || 7));
            const end = asISTStart(dayjs());              // today (IST) start
            const start = end.subtract(n - 1, 'day');     // n days inclusive
            return { start, end, startStr: fmt(start), endStr: fmt(end) };
        }

        throw new Error('Invalid mode');
    }

    router.get('/commissions/summary', async (req, res) => {
    try {
        const userId = String(req.query.userId || '').trim();
        if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

        const { start, end } = parseModeAndRange(req.query);
        const startStr = start.format('YYYY-MM-DD');
        const endStr = end.format('YYYY-MM-DD');

        // Pre-build day buckets
        const days = [];
        for (let d = start.clone(); !d.isAfter(end); d = d.add(1, 'day')) {
        days.push({ date: d.format('YYYY-MM-DD'), commissionPaise: 0 });
        }
        const idx = new Map(days.map((x, i) => [x.date, i]));

        // Fetch daily docs in range
        const docs = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, [
            Query.between('date', startStr, endStr),
            Query.orderAsc('date'),
            Query.limit(100),
        ]);

        for (const doc of docs.documents) {
        const dateStr = String(doc.date);
        const i = idx.get(dateStr);
        if (i === undefined) continue;

        const raw = doc.commissionsJson;
        let paise = 0;
        if (typeof raw === 'string') {
            try {
            const json = JSON.parse(raw);
            paise = Number(json[userId] || 0);
            } catch (e) {
            // ignore malformed JSON
            }
        } else if (raw && typeof raw === 'object') {
            paise = Number(raw[userId] || 0);
        }
        days[i].commissionPaise = paise;
        }

        const totalPaise = days.reduce((s, d) => s + d.commissionPaise, 0);

        return res.json({
        success: true,
        userId,
        range: { start: startStr, end: endStr },
        totalPaise,
        days, // [{ date, commissionPaise }]
        });
    } catch (e) {
        return res.status(400).json({ success: false, message: e && e.message ? e.message : 'Bad request' });
    }
    });

    router.get('/commissions/summary-all', async (req, res) => {
    try {
        const { start, end, startStr, endStr } = parseModeAndRange(req.query);
        const includeUsers = String(req.query.includeUsers || 'false').toLowerCase() === 'true';

        // Fetch N daily docs (1 per day)
        const docs = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID,
        [
            Query.between('date', startStr, endStr),
            Query.orderAsc('date'),
            Query.limit(100),
        ]
        );

        // Pre-fill day buckets
        const buckets = [];
        for (let d = start.clone(); !d.isAfter(end); d = d.add(1, 'day')) {
        buckets.push({ date: d.format('YYYY-MM-DD'), totalPaise: 0 });
        }
        const idx = new Map(buckets.map((x, i) => [x.date, i]));

        // Optional per-user accumulators
        const perUser = includeUsers ? new Map() : null;

        for (const doc of docs.documents) {
        const dateStr = String(doc.date);
        const i = idx.get(dateStr);
        if (i === undefined) continue;

        const raw = doc.commissionsJson;
        let daySum = 0;

        const addUserVal = (uid, v) => {
            if (!perUser) return;
            if (!perUser.has(uid)) perUser.set(uid, { totalPaise: 0, days: new Map() });
            const u = perUser.get(uid);
            u.totalPaise += v;
            u.days.set(dateStr, (u.days.get(dateStr) || 0) + v);
        };

        if (typeof raw === 'string') {
            try {
            const obj = JSON.parse(raw);
            for (const uid in obj) {
                const v = Number(obj[uid] || 0);
                daySum += v;
                addUserVal(uid, v);
            }
            } catch {
            // ignore malformed
            }
        } else if (raw && typeof raw === 'object') {
            for (const uid in raw) {
            const v = Number(raw[uid] || 0);
            daySum += v;
            addUserVal(uid, v);
            }
        }

        buckets[i].totalPaise = daySum;
        }

        const grandTotal = buckets.reduce((s, b) => s + b.totalPaise, 0);

        // Materialize per-user output aligned to requested dates
        let perUserOut = undefined;
        if (perUser) {
        perUserOut = {};
        for (const [uid, data] of perUser.entries()) {
            const daysArr = buckets.map((b) => ({
            date: b.date,
            paise: data.days.get(b.date) || 0,
            }));
            perUserOut[uid] = {
                totalPaise: Number(data.totalPaise || 0),
                days: daysArr,
            };
        }
        }

        return res.json({
            success: true,
            range: { start: startStr, end: endStr },
            totalPaise: Number(grandTotal || 0),
            days: buckets.map(b => ({ date: b.date, totalPaise: Number(b.totalPaise || 0) })),
            perUser: perUserOut ?? undefined,
        });

    } catch (e) {
        return res.status(400).json({ success: false, message: e?.message || 'Bad request' });
    }
    });

    // GET /dashboard/counters
    router.get('/dashboard/counters', authenticateAdmin, async (req, res) => {
        try {
            const pageLimit = 100; // Appwrite max per page
            let cursor = null;
            let hasMore = true;

            // Accumulator map: id -> totals
            const map = new Map();

            while (hasMore) {
            const queries = [Query.limit(pageLimit)];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const resp = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                'dashboard_counters', // e.g., 'dashboard_counters'
                queries
            );

            const docs = resp.documents || [];

            for (const d of docs) {
                const key = d.id || d.$id; // prefer your 'id' field if present
                const valRaw = d.totals;
                const val = Number.isFinite(valRaw) ? valRaw : parseInt(valRaw || 0, 10);
                if (!map.has(key)) {
                map.set(key, isNaN(val) ? 0 : val);
                } else {
                // In case of duplicates, last-write-wins (or sum if preferred)
                map.set(key, isNaN(val) ? map.get(key) : val);
                }
            }

            if (docs.length === pageLimit) {
                cursor = docs[docs.length - 1].$id;
                hasMore = true;
            } else {
                hasMore = false;
            }
            }

            const istDate = moment.tz('Asia/Kolkata');
            const dayString = istDate.format('YYYY-MM-DD');

            const existingDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                Query.equal('date', dayString),
                Query.limit(1),
                ]
            );

            let todayPayInAllQrs = 0;

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

                todayPayInAllQrs = Object.values(totalsObj).reduce((sum, value) => {
                    return sum + parseInt(value || 0, 10);
                }, 0);

                console.log('📊 Raw totalsObj from DB:', totalsObj);

                console.log('📊 Stored totals sum:', todayPayInAllQrs, 'from', Object.keys(totalsObj).length, 'QRs')    ;
            }

            // Helper to get value or 0
            const get = (k) => (map.has(k) ? map.get(k) : 0);

            // Build the structured response
            const payload = {
            // Totals
            totalTxCount: get('totalTxCount'),
            totalAmountReceived: get('totalAmountReceived'),
            todayPayInAllQrs: todayPayInAllQrs, // from daily summary
            totalAdminProfit: get('totalAdminProfit'),
            totalMerchantProfit: get('totalMerchantProfit'),
            totalQrsUploaded: get('totalQrsUploaded'),
            totalQrsAssignedToMerchant: get('totalQrsAssignedToMerchant'),

            // QR breakdown
            totalPinelabsQrs: get('totalPinelabsQrs'),
            totalPaytmQrs: get('totalPaytmQrs'),
            totalOtherQrs: get('totalOtherQrs'),
            qrCodesActive: get('qrCodesActive'),
            qrCodesDisabled: get('qrCodesDisabled'),

            // Transaction types
            totalManualTx: get('totalManualTx'),
            totalApiTx: get('totalApiTx'),
            chargebackCount: get('chargebackCount'),
            chargebackAmount: get('chargebackAmount'),
            cyberCount: get('cyberCount'),
            cyberAmount: get('cyberAmount'),
            refundCount: get('refundCount'),
            refundAmount: get('refundAmount'),

            // Payouts
            totalAmountPaid: get('totalAmountPaid'),
            totalWithdrawalPendingAmount: get('totalWithdrawalPendingAmount'),

            // Users/Merchants
            activeUsers: get('activeUsers'),
            disabledUsers: get('disabledUsers'),
            merchantActive: get('merchantActive'),
            merchantPending: get('merchantPending'),
            merchantDisabled: get('merchantDisabled'),
            totalUsers: get('totalUsers'),

            // Memberships
            totalMembershipPurchased: get('totalMembershipPurchased'),
            pendingMembershipUsers: get('pendingMembershipUsers'),
            };

            return res.status(200).json(payload);
        } catch (err) {
            console.error('Error reading dashboard counters:', err);
            return res.status(500).json({ error: 'Failed to fetch dashboard counters' });
        }
    });

    // GET /dashboard/subadmin/:merchantId
    router.get('/dashboard/subadmin/:merchantId', authenticateAdminOrSubAdmin, async (req, res) => {
        const { merchantId } = req.params;
        const actor = req.user;

        const istDate = moment.tz('Asia/Kolkata');
        const dayString = istDate.format('YYYY-MM-DD');

        try {
            // Authorization: allow admin or the merchant owner
            if (actor.role !== 'admin' && actor.userId !== merchantId) {
            return res.status(403).json({ message: 'Forbidden' });
            }

            // 1) Fetch all QRs managed by merchantId (paginate)
            const qrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('managedByUserId', merchantId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            const userQrIds = qrs.map(q => q.qrId);

            console.log(`Merchant ${merchantId} has ${qrs.length} QRs IDS [${userQrIds.join(', ')}]`);

            const existingDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                Query.equal('date', dayString),
                Query.limit(1),
                ]
            );

            let todayPayInAllQrs = 0;

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

                // ✅ SUM ALL QR totals from stored JSON (today's complete aggregate)
                // todayPayInAllQrs = Object.values(totalsObj).reduce((sum, value) => {
                //     return sum + parseInt(value || 0, 10);
                // }, 0);

                // console.log('📊 Raw totalsObj from DB:', totalsObj);

                // OPTIONAL: If you need user-specific subset (instead of all)
                todayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => userQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                // console.log('📊 Stored totals sum:', todayPayInAllQrs, 'from', Object.keys(totalsObj).length, 'QRs');
            }

            // 2) Aggregate QR-derived counters
            let totalTxCount = 0;
            let totalAmountReceived = 0;         // sum of qr.totalTransactions (if that is amount); if it's count, rename accordingly
            let totalAvailableAmount = 0;        // sum of qr.amountAvailableForWithdrawal
            let totalWithdrawalPendingAmount = 0;// sum of qr.withdrawalRequestedAmount
            let totalAmountPaid = 0;             // sum of qr.withdrawalApprovedAmount
            let totalAmountOnHold = 0;             // sum of qr.amountOnHold

            let totalQrsAssignedToMerchant = qrs.length;
            let qrCodesActive = 0;
            let qrCodesDisabled = 0;

            let totalMerchantProfit = 0;      // compute if you have commission rules per qr/txn

            for (const qr of qrs) {
            // Adjust these field names to your schema
            const isActive = !!qr.isActive;
            const txAmount = parseInt(qr.totalPayInAmount || 0, 10); // if this is count, rename to totalTxCount and keep amount separate
            const avail = parseInt(qr.amountAvailableForWithdrawal || 0, 10);
            const paid = parseInt(qr.withdrawalApprovedAmount || 0, 10);
            const pendingW = parseInt(qr.withdrawalRequestedAmount || 0, 10);
            const onHold = parseInt(qr.amountOnHold || 0, 10);

            if (isActive) qrCodesActive++; else qrCodesDisabled++;
                totalAmountReceived += txAmount;
                totalTxCount += parseInt(qr.totalTransactions || 0, 10); // if you store counts separately
                totalAvailableAmount += avail;
                totalAmountPaid += paid;
                totalWithdrawalPendingAmount += pendingW;
                totalAmountOnHold += onHold;
            }

            // 3) Users under this merchant
            const usersAll = await listAllDocuments(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, [
                Query.equal('parentId', merchantId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            const commission_list = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID,
                [ Query.equal('userId', merchantId), Query.limit(1) ]
            );

             if (commission_list.total > 0) {
                const row = commission_list.documents[0];
                totalMerchantProfit = Number(row.totalCommissionPaise || 0)
             }

            const activeUsers = usersAll.filter(u => u.status === true && u.role === 'user').length;
            const disabledUsers = usersAll.filter(u => u.status !== true && u.role === 'user').length;
            const totalUsers = usersAll.filter(u => u.role === 'user').length;

            // 4) Membership rollups (optional; set 0 if unmanaged here)
            // Implement if you track memberships per user under merchant
            const totalMembershipPurchased = 0;
            const pendingMembershipUsers = 0;

            // Response
            return res.json({
                merchantId,
                // Overview
                totalTxCount,
                todayPayInAllQrs,
                totalAmountReceived,
                totalAvailableAmount,
                totalMerchantProfit, // compute if you have commission rules per qr/txn
                totalQrsAssignedToMerchant,

                // QR breakdown
                qrCodesActive,
                qrCodesDisabled,

                // Payouts
                totalAmountPaid,
                totalWithdrawalPendingAmount,
                totalAmountOnHold,

                // Users
                activeUsers,
                disabledUsers,
                totalUsers,

                // Memberships
                totalMembershipPurchased,
                pendingMembershipUsers,
            });
        } catch (e) {
            console.error('Subadmin dashboard error:', e);
            return res.status(500).json({ message: 'Failed to build dashboard', error: e.message });
        }
    });

    // GET /dashboard/user/:userId
    router.get('/dashboard/user/:userId', authenticateToken, async (req, res) => {
        const { userId } = req.params;
        const actor = req.user;

        const istDate = moment.tz('Asia/Kolkata');
        const dayString = istDate.format('YYYY-MM-DD');

        try {
            // Authorization: allow admin, the same user, or that user's manager/subadmin if policy allows
            const isSelf = actor.userId === userId;
            const isAdmin = actor.role === 'admin';
            if (!isAdmin && !isSelf) {
            // Optional: allow parent/manager
            // if (actor.role === 'subadmin' && await isUserUnderMerchant(userId, actor.userId)) { /* allow */ }
            // else
            return res.status(403).json({ message: 'Forbidden' });
            }

            // 1) Fetch all QRs assigned to this user
            const qrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('assignedUserId', userId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            const userQrIds = qrs.map(q => q.qrId);

            const existingDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                Query.equal('date', dayString),
                Query.limit(1),
                ]
            );

            let todayPayInAllQrs = 0;

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

                console.log('📊 Raw totalsObj from DB:', totalsObj);

                // OPTIONAL: If you need user-specific subset (instead of all)
                todayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => userQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                console.log('📊 Stored totals sum:', todayPayInAllQrs, 'from', Object.keys(totalsObj).length, 'QRs');
            }

            // 2) Aggregate QR-derived counters
            let totalQrs = qrs.length;
            let qrCodesActive = 0;
            let qrCodesDisabled = 0;

            let totalTxCount = 0;           // sum of qr.totalTransactions (count)
            let totalAmountPayIn = 0;       // sum of qr.totalPayInAmount (paise)

            let totalWithdrawalApprovedAmount = 0; // sum of qr.withdrawalApprovedAmount (paise)
            let totalWithdrawalPendingAmount = 0;  // sum of qr.withdrawalRequestedAmount (paise)
            let totalAvailableAmount = 0;          // sum of qr.amountAvailableForWithdrawal (paise)
            let totalAmountOnHold = 0;             // sum of qr.amountOnHold (paise)

            let totalCommissionOnHold = 0;         // sum of qr.commissionOnHold (paise)
            let totalCommissionPaid = 0;           // sum of qr.commissionPaid (paise)

            for (const qr of qrs) {
            const isActive = !!qr.isActive;

            // Adjust field names to your actual schema
            const txCount = parseInt(qr.totalTransactions || 0, 10);
            const payIn = parseInt(qr.totalPayInAmount || 0, 10);

            const wApproved = parseInt(qr.withdrawalApprovedAmount || 0, 10);
            const wPending = parseInt(qr.withdrawalRequestedAmount || 0, 10);
            const avail = parseInt(qr.amountAvailableForWithdrawal || 0, 10);
            const onHold = parseInt(qr.amountOnHold || 0, 10);

            const commHold = parseInt(qr.commissionOnHold || 0, 10);
            const commPaid = parseInt(qr.commissionPaid || 0, 10);

            if (isActive) qrCodesActive++; else qrCodesDisabled++;

            totalTxCount += txCount;
            totalAmountPayIn += payIn;

            totalWithdrawalApprovedAmount += wApproved;
            totalWithdrawalPendingAmount += wPending;
            totalAvailableAmount += avail;
            totalAmountOnHold += onHold;

            totalCommissionOnHold += commHold;
            totalCommissionPaid += commPaid;
            }

            // 3) Respond
            return res.json({
            userId,
            // QR breakdown
            totalQrs,
            todayPayInAllQrs,
            qrCodesActive,
            qrCodesDisabled,

            // Transactions
            totalTxCount,
            totalAmountPayIn,

            // Payouts
            totalWithdrawalApprovedAmount,
            totalWithdrawalPendingAmount,
            totalAvailableAmount,
            totalAmountOnHold,

            // Commission
            totalCommissionOnHold,
            totalCommissionPaid,
            });
        } catch (e) {
            console.error('User dashboard error:', e);
            return res.status(500).json({ message: 'Failed to build user dashboard', error: e.message });
        }
    });


    async function listAllDocuments(dbId, colId, baseQueries, pageSize = 100) {
        let out = [];
        let cursor = null;
        while (true) {
            const queries = [...baseQueries];
            if (cursor) queries.push(Query.cursorAfter(cursor));
            const page = await databases.listDocuments(dbId, colId, queries);
            out = out.concat(page.documents);
            if (!page.documents.length) break;
            cursor = page.documents[page.documents.length - 1].$id;
            if (page.documents.length < pageSize) break;
        }
        return out;
    }

    return router;
    
};
