// -----------------------------------------------------------------------------------------------------
// routes/admin.js
// This file contains the API endpoints for user management.

const express = require('express');
const multer = require('multer');
const moment = require('moment-timezone');
const { Client, Account } = require('node-appwrite');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const { emitQrLimit } = require('./socketServer');

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');

const { updateDashboardCounter } = require('./dashboardCounters');

const ConfigManager = require('./configManager'); // Import ConfigManager to access configuration values
const userMetaCache = require('./userMetaCache');

dayjs.extend(utc);
dayjs.extend(tz);
// Optional: set default TZ once
dayjs.tz.setDefault('Asia/Kolkata');

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, webhook_collectionId, bucketId, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, APPWRITE_COMMISSION_TRANSACTIONS_COLLECTION_ID, APPWRITE_DAILY_COMMISSION_SUMMARIES_COLLECTION_ID, APPWRITE_ALL_TIME_COMMISSION_TOTAL_COLLECTION_ID, APPWRITE_MONTHLY_COMMISSION_TOTALS_COLLECTION_ID, updateDailyQrTotal, emitTxnNew, authenticateToken, authenticateAdminOrLabel, authenticateAdmin, authenticateAdminOrSubAdmin, authenticateAdminOrSubAdminOrEmployee, InputFile, roleAuth, requireRole, redisClient, emitTxnStatusNew) => {
    // router.use(roleAuth); // All routes will now have req.userMeta

    function getISTDateTime() {
        return moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    }

    function isExportTimeAllowed() {
        const windows = [
            { from: '09:00 AM', to: '10:00 AM' },
            // { from: '04:00 PM', to: '08:00 PM' },
        ];
        const now = moment().tz('Asia/Kolkata');
        const nowMinutes = now.hours() * 60 + now.minutes();
        const toMinutes = (timeStr) => {
            const t = moment(timeStr, 'hh:mm A');
            return t.hours() * 60 + t.minutes();
        };
        return windows.some(({ from, to }) => {
            const start = toMinutes(from);
            const end = toMinutes(to);
            return nowMinutes >= start && nowMinutes < end;
        });
    }

    // Atomic lock release — only deletes the key if its value still matches ours.
    // Prevents accidentally releasing a lock that another process acquired after ours expired.
    const RELEASE_LOCK_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
    async function releaseLock(key, val) {
        try { await redisClient.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [val] }); } catch (e) { console.error(`releaseLock failed for ${key} — lock will expire after TTL:`, e.message); }
    }

    // Acquire a distributed lock with retry. Same pattern as server.js acquireLock.
    async function acquireLock(key, value, ttlSeconds = 15) {
        try {
            const result = await redisClient.set(key, value, { NX: true, EX: ttlSeconds });
            return result === 'OK';
        } catch (e) {
            console.error('acquireLock error:', e);
            return false; // fail safe — reject request rather than proceed unprotected
        }
    }

    // Acquire daily summary lock with retry — serializes all totalsJson read-modify-writes for a given date.
    // Must be used by ANY code path that modifies totalsJson (edit, delete, manual txn).
    async function acquireDailyLock(dayString) {
        const key = `lock:daily:${dayString}`;
        const val = `admin:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        for (let attempt = 0; attempt < 20; attempt++) {
            if (await acquireLock(key, val, 10)) return { key, val };
            await new Promise(r => setTimeout(r, 50 + attempt * 40));
        }
        throw new Error(`Could not acquire daily lock for ${dayString} after 20 retries`);
    }

    // Returns true when an Appwrite error is caused by an invalid/expired pagination cursor
    function isCursorError(err) {
        const msg = (err?.message || '').toLowerCase();
        return err?.code === 400 && (msg.includes('cursor') || msg.includes('document with the requested id could not be found'));
    }

    // 🔥 List all users AppWrite Collections users_meta
    router.get('/users', authenticateAdminOrLabel('all_transactions', { isSubadminAllowed: true }), async (req, res) => {
        const {limit = 25, cursor} = req.query;
    
        const requestorId = req.user.userId;
        const role = req.user.role; // 'admin' | 'subadmin'

        const limitNum = Math.min(parseInt(limit) || 25, 200);
        // limitNum = limit;

        try {
            const queries = [];

            // If a cursor was sent, validate and use it for pagination
            if (cursor) {
                if (!/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                    return res.status(400).json({ error: 'Invalid cursor format' });
                }
                queries.push(Query.cursorAfter(cursor));
            }

            // Consistent ordering is CRUCIAL for cursor pagination
            queries.push(Query.orderDesc('$id'));

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

                // const result = await databases.listDocuments(
                //     APPWRITE_DATABASE_ID,
                //     APPWRITE_USERS_META_COLLECTION_ID,
                //     queries // must be an array
                // );

                // console.log('Employee user list query result count:', result.total);

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
                assigned_to: doc.assigned_to || null,
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
            if (isCursorError(err)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
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
            assigned_to: doc.assigned_to || null,
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
    
    router.get('/employees', authenticateAdmin, async (req, res) => {
    const requestorId = req.user.userId;
    const role = req.user.role; // 'admin' | 'subadmin'

    try {
        const queries = [];

        if (role !== 'admin') {
            return res.status(403).json({ error: 'only admins can see employees' });
        }

        queries.push(Query.equal('role', 'employee'));
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
        assigned_to: doc.assigned_to || null,
        status: doc.status,
        labels: doc.labels,
        commission : doc.commission || 0,
        }));

        return res.json(simplifiedUsers);
    } catch (err) {
        console.error('List employees error:', err);
        return res.status(500).json({ error: 'Failed to fetch employees' });
    }
    });

    // 🔐 Create new user (admin/sub-admin allowed)
    router.post('/create-user', authenticateAdminOrSubAdmin, async (req, res) => {
        const { name, email, password, role } = req.body;
        let creatorId = req.user.userId;

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
            await userMetaCache.invalidate(userId);

            // Update dashboard counters in parallel
            const counterUpdates = [
                updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalUsers', 1),
            ];
            if (role === 'subadmin') counterUpdates.push(updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantActive', 1));
            else if (role === 'user') counterUpdates.push(updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'activeUsers', 1));
            await Promise.all(counterUpdates).catch(console.error);

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

    // 🔐 Assign employee to employee (admin-only or employee with all_users)
    router.put('/assign-subadmin/:employeeId', authenticateAdmin, async (req, res) => {
        const { employeeId } = req.params;
        const { userId, unassign = false } = req.body; // userId can be string; unassign=true clears parentId

        try {

            if (!userId) {
                return res.status(400).json({ message: 'userId is required' });
            }

            const requester = req.user; // { id, role }
            const isAdmin = requester.role === 'admin';
            // const isSubadmin = requester.role === 'subadmin';

            if (!isAdmin) {
                return res.status(403).json({ message: 'Forbidden only admins can assign users to Employees' });
            }
        
            if(unassign == false){
                // Validate target is an EMPLOYEE
                const targetEmployee = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, employeeId);
                if (targetEmployee.role !== 'employee') {
                    return res.status(400).json({ message: 'Target is not an EMPLOYEE' });
                }
            }

            // Step 1: Find document where userId matches
            const userDoc = await userMetaCache.getUserMeta(userId);

            if (!userDoc) {
            throw new Error('User document not found');
            }

            const documentId = userDoc.$id; // Get the actual document ID

            const update = { assigned_to: unassign ? null : employeeId };

            console.log(`Updating user ${userId} assignment to employee ${employeeId}, unassign: ${unassign}`);

            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, documentId, update);
            await userMetaCache.invalidate(userId);

            return res.status(200).json({ message: 'Assignment updated.' });
        } catch (err) {
            console.error('Assign user error:', err);
            return res.status(500).json({ message: 'Failed to update assignment', error: err.message });
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
            await userMetaCache.invalidate(userId);

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

        const doc = await userMetaCache.getUserMeta(userIdtoEdit);
        if (!doc) {
        return res.status(404).json({ error: 'User metadata document not found in users_mets' });
        }

        if (userRequested.role === 'subadmin') {
        if (doc.parentId !== userRequested.userId) {
            return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
        }
        }
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

        // Update specialized user data (name/email) and metadata in parallel
        const userUpdates = [];
        if (name !== undefined) userUpdates.push(users.updateName(userIdtoEdit, name));
        if (email !== undefined) userUpdates.push(users.updateEmail(userIdtoEdit, email));
        userUpdates.push(databases.updateDocument(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            docId,
            updatePayload
        ));
        await Promise.all(userUpdates);
        await userMetaCache.invalidate(userIdtoEdit);

        return res.json({ message: 'User updated successfully' });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to update user' });
    }
    });

    // 🔐 Reset user password ( admin/sub-admin or employee with all_users allowed )
    router.post('/reset-password/:id', authenticateAdminOrSubAdmin, async (req, res) => {
        const userId = req.params.id;
        const { password, logoutAll } = req.body;

        const userRequested = req.user; // set by your JWT middleware

        // Find document in users_meta collection matching userId
        const userDoc = await userMetaCache.getUserMeta(userId);
        if (!userDoc) {
            return res.status(404).json({ error: 'User metadata document not found in users_meta' });
        }

        if(userRequested.role === 'subadmin'){
            if(userDoc.parentId !== userRequested.userId){
                return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
            }
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

            if (logoutAll === true) {
                try {
                    await users.deleteSessions(userId);
                } catch (sessionErr) {
                    console.error('Failed to logout all sessions:', sessionErr.message);
                }
            }

            return res.json({ message: 'Password reset successfully', loggedOutAll: logoutAll === true });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: err.message || 'Failed to reset password' });
        }
    });

    // POST /reset-password-own (self password reset with current password verification)
    router.post('/reset-password-own', authenticateToken, async (req, res) => {
        const { currentPassword, newPassword, logoutAll } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'currentPassword and newPassword are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        if (currentPassword === newPassword) {
            return res.status(400).json({ error: 'New password must be different from current password' });
        }

        try {
            const token = req.headers['authorization']?.split(' ')[1];

            const userClient = new Client()
                .setEndpoint('https://fra.cloud.appwrite.io/v1')
                .setProject('688c98fd002bfe3cf596')
                .setJWT(token);

            const account = new Account(userClient);

            // This verifies the current password and updates to the new one
            // await account.updatePassword(newPassword, currentPassword);

            const result = await account.updatePassword({
                password: newPassword,
                oldPassword: currentPassword // optional
            });

            console.log('Password reset own result:', result);

            // If logoutAll is true, delete all sessions for this user
            if (logoutAll === true) {
                try {
                    await users.deleteSessions(req.user.userId);
                } catch (sessionErr) {
                    console.error('Failed to logout all sessions:', sessionErr.message);
                }
            }

            return res.json({ message: 'Password updated successfully', loggedOutAll: logoutAll === true });
        } catch (err) {
            console.error('Reset password own error:', err.message);

            if (err.code === 401 || err.type === 'user_invalid_credentials') {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            return res.status(500).json({ error: err.message || 'Failed to update password' });
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

           // Update status in users_meta collection
            const doc = await userMetaCache.getUserMeta(userId);
            if (!doc) {
                return res.status(404).json({ error: 'User metadata document not found in users_meta' });
            }

             if(userRequested.role === 'subadmin'){
                if(doc.parentId !== userRequested.userId){
                    return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
                }
            }

            const docId = doc.$id;

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                docId,
                { status }
            );
            await userMetaCache.invalidate(userId);

            const delta = status ? 1 : -1;
            if (doc.role === 'subadmin') {
                await Promise.all([
                    updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantActive', delta),
                    updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'merchantDisabled', -delta),
                ]).catch(console.error);
            } else if (doc.role === 'user') {
                await Promise.all([
                    updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'activeUsers', delta),
                    updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'disabledUsers', -delta),
                ]).catch(console.error);
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
        const userRequested = req.user; // set by your JWT middleware

        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }

        console.log(`Attempting to delete user ${userId} by requester ${userRequested.userId} with role ${userRequested.role}`);

        try {
            const user = await users.get(userId);

            if (user.labels?.includes('admin')) {
                return res.status(403).json({ error: 'Cannot delete admin users' });
            }

            // Find and delete corresponding document in users_meta collection
            const userMetaDoc = await userMetaCache.getUserMeta(userId);

            if (userMetaDoc) {

                if(userMetaDoc.role == 'admin'){
                    return res.status(403).json({ error: 'Cannot delete admin users' });
                }

                // Get the user ID of the user being deleted
                const userIdofUserDeleting = userMetaDoc.userId;

                // Check if user has assigned QR codes before allowing deletion
                const response = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, 
                    [Query.equal('assignedUserId', userIdofUserDeleting)]
                );

                // console.log(`QR codes assigned to user ${userId}:`, response.total);

                if (response.total > 0) {
                    return res.status(400).json({ message: "Cannot delete user with assigned QR codes. Please unassign them first." }); 
                }

                await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userMetaDoc.$id);
                await userMetaCache.invalidate(userId);

                // Delete user in Appwrite users service
                await users.delete(userId);

                // Update dashboard counters
                const role = userMetaDoc.role;
                const status = userMetaDoc.status;
                const deleteCounterUpdates = [
                    updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalUsers', -1),
                ];
                if (role === 'subadmin') {
                    deleteCounterUpdates.push(updateDashboardCounter(databases, APPWRITE_DATABASE_ID, status ? 'merchantActive' : 'merchantDisabled', -1));
                } else if (role === 'user') {
                    deleteCounterUpdates.push(updateDashboardCounter(databases, APPWRITE_DATABASE_ID, status ? 'activeUsers' : 'disabledUsers', -1));
                }
                await Promise.all(deleteCounterUpdates).catch(console.error);
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

    // Helper: convert amount to paise
    const toPaise = (amt) => Math.round(amt * 100);

    // Admin-only: fetch all or filtered transactions
    router.get('/transactions', authenticateAdminOrLabel('all_transactions', { isSubadminAllowed: true }), async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to, status, searchField, searchValue } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);

        let filters = [];

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';

        // userRequested.labels;
        // console.log('User role and labels:', userRequested.role, userRequested.labels);

        // console.log('Transaction query params:', req.query);


            let resultAllQr = [];
            let resultAllQrId = [];

            if (req.user.role === 'employee' && !userId && !qrId) {
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

                if(merchantIds.length === 0){
                    return res.status(500).json({ message: "Failed to fetch Transactions No Merchants assigned." });
                }else if(merchantIds.length === 1){
                    queries.push(Query.equal('parentId', merchantIds[0]));
                }else{
                    merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                    queries.push(Query.or(orQueries));
                }

                // let orQueries = [];
                // merchantIds.forEach(id => orQueries.push(Query.equal('parentId', id)));
                // queries.push(Query.or(orQueries));

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
                queries.push(orQueries2.length === 1 ? orQueries2[0] : Query.or(orQueries2));

                // console.log('Employee user list query result count:', usersRes.total);

                resultAllQr = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    Qr_collectionId,
                    queries,
                );

                resultAllQrId = resultAllQr.documents.map(q => q.qrId);
                // console.log('Employee QR code query result count:', resultAllQr.total);

                // console.log(`Employee ${req.user.$id} has access to QR codes:`, resultAllQrId);
                // documents = response.documents;
            }

        try {
            if (req.user.role === 'employee' && !userId && !qrId) {
                // console.log(`Employee ${req.user.$id} is fetching transactions without userId or qrId filters, applying access control based on assigned QR codes.`);
                if (resultAllQrId.length == 0) {
                    // console.log(`Employee ${req.user.$id} has no assigned QR codes, returning empty transactions list.`);
                    return res.status(200).json({ transactions: [] });
                }else{
                    // console.log(`Employee ${req.user.$id} has access to QR codes:`, resultAllQrId);
                    let employeeAssignedQrs = [];
                    resultAllQrId.forEach(id => employeeAssignedQrs.push(Query.equal('qrCodeId', id)));
                    filters.push(Query.or(employeeAssignedQrs));
                }
            }else{
                // console.log(`User ${req.user.$id} with role ${req.user.role} is fetching transactions with filters - userId: ${userId}, qrId: ${qrId}`);
            }
            
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

            // Date filtering helper — timezone-safe, works on any server
            function toISTRange(dateStr) {
                const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
                const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
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
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback', 'failed']); // enum gate [14]
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

            if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                return res.status(400).json({ error: 'Invalid cursor format' });
            }
            filters.push(Query.or([Query.equal('deleted', false), Query.isNull('deleted')]));
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
                imageUrl: d.imageUrl || null,
            });
            const docs = transactions.documents.map(pickTxn);

            // const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            return res.status(200).json({ transactions: docs, nextCursor });
            
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('Error fetching transactions:', error);
            return res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    });

    // Fetch only soft-deleted transactions (admin only)
    router.get('/deleted_transactions_only', authenticateAdmin, async (req, res) => {
        const { limit = 25, cursor, from, to, searchField, searchValue } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 100);

        let filters = [Query.equal('deleted', true)];

        try {
            function toISTRange(dateStr) {
                const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
                const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
                return { start, end };
            }

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

            if (searchField && searchValue) {
                const fulltextFields = ['vpa', 'paymentId', 'qrCodeId'];
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

            if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                return res.status(400).json({ error: 'Invalid cursor format' });
            }
            const queries = [...filters, Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            const transactions = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);

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
                imageUrl: d.imageUrl || null,
            });
            const docs = transactions.documents.map(pickTxn);
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            return res.status(200).json({ transactions: docs, nextCursor });
        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('Error fetching deleted transactions:', error);
            return res.status(500).json({ error: 'Failed to fetch deleted transactions' });
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

            // Date filter helper — timezone-safe, works on any server
            function toISTRange(dateStr) {
                const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
                const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
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
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback', 'failed']); // enum gate [14]
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

            if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                return res.status(400).json({ error: 'Invalid cursor format' });
            }
            filters.push(Query.or([Query.equal('deleted', false), Query.isNull('deleted')]));
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
                imageUrl: d.imageUrl || null,
            });
            const docs = transactions.documents.map(pickTxn);

            // const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({ transactions: docs, nextCursor });

        } catch (error) {
            if (isCursorError(error)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
            console.error('❌ Error in /user/transactions:', error);
            res.status(500).json({ error: 'Failed to fetch user transactions' });
        }
    });

    // Export endpoint with same filters but returns all matching transactions (up to a reasonable max limit) for CSV export
    router.get('/user/transactions/export', authenticateToken, async (req, res) => {
        const { userId, qrId, from, to, status, searchField, searchValue, maxTxns = 50 } = req.query;
        const maxTxnsNum = Math.min(parseInt(maxTxns) || 50, 500);  // safety limit

        // console.log('Export transaction query params:', req.query);

        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        const isAdmin = userRequested.role === 'admin';

        const isEmployee = userRequested.role === 'employee';

        if(!isAdmin){
            await ConfigManager.refresh();
        
            // Master kill switch — if exports disabled, only admin can download
            const isExportsEnabled = ConfigManager.get('exports_enabled');
            if (!isExportsEnabled) {
                return res.status(403).json({ error: 'Exports are currently disabled' });
            }

            // Time window check — only admin is exempt
            const isExportTimeWindowsEnabled = ConfigManager.get('export_time_windows_enabled');
            if (isExportTimeWindowsEnabled && !isExportTimeAllowed()) {
                return res.status(403).json({ error: 'Export is only allowed during permitted time windows' });
            }

            if (!userId && !qrId) {
                return res.status(400).json({ error: 'userId or qrId is required' });
            }

            if (isEmployee) {
                // Employee can export for subadmins assigned to them + users under those subadmins
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                    [Query.equal('assigned_to', userRequested.userId), Query.equal('role', 'subadmin'), Query.limit(100)]
                );
                const merchantIds = merchantsRes.documents.map(d => d.userId);
                let allowedIds = [...merchantIds];
                if (merchantIds.length > 0) {
                    const usersRes = await databases.listDocuments(
                        APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                        [Query.equal('parentId', merchantIds), Query.limit(500)]
                    );
                    allowedIds.push(...usersRes.documents.map(d => d.userId));
                }
                if (userId && !allowedIds.includes(userId)) {
                    return res.status(403).json({ error: 'Forbidden: This user is not under your management' });
                }
                // If only qrId passed, verify the QR belongs to an allowed user
                if (!userId && qrId) {
                    const qrDoc = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [Query.equal('qrId', qrId), Query.limit(1)]);
                    if (qrDoc.documents.length === 0 || !allowedIds.includes(qrDoc.documents[0].assignedUserId)) {
                        return res.status(403).json({ error: 'Forbidden: This QR is not under your management' });
                    }
                }
            } else if (!isSubadmin && userId && userRequested.userId !== userId) {
                return res.status(403).json({ error: 'Forbidden: Cannot access other users\' transactions' });
            }

        }

        if (!userId && !qrId) {
            return res.status(400).json({ error: 'userId or qrId is required' });
        }

        let allTxns = [];
        let cursor = null;

        do {
            const filters = [];

            try {
            if (!userId && qrId) {
                // Only qrId passed — query directly by qrId
                filters.push(Query.equal('qrCodeId', qrId));
            } else {
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
            }

            // Date filter helper — timezone-safe, works on any server
            function toISTRange(dateStr) {
                const start = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toDate();
                const end = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toDate();
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
                const allowedStatuses = new Set(['normal', 'cyber', 'refund', 'chargeback', 'failed']);
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

            filters.push(Query.or([Query.equal('deleted', false), Query.isNull('deleted')]));
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

    router.post("/create-image-entry-in-transaction", authenticateAdminOrLabel('manual_transactions'), async (req, res) => {
        try {   
            const { txnId, imageUrl } = req.body;
            if (!txnId || !imageUrl) {
                return res.status(400).json({ error: 'txnId and imageUrl are required' });
            }   
            try { await databases.getDocument(APPWRITE_DATABASE_ID, webhook_collectionId, txnId); }
            catch (e) { return res.status(404).json({ error: 'Transaction not found' }); }
            const updated = await databases.updateDocument(APPWRITE_DATABASE_ID, webhook_collectionId, txnId, { imageUrl });
            return res.status(200).json({ success: true, transaction: updated });
        } catch (error) {
            console.error('Error in /create-image-entry-in-transaction:', error);
            return res.status(500).json({ error: 'Failed to add image URL to transaction' });
        }
    });

    router.post("/delete-transaction-image", authenticateAdminOrLabel('manual_transactions'), async (req, res) => {
        try { 
            const { txnId } = req.body;
            if (!txnId) {
                return res.status(400).json({ error: 'txnId is required' });
            }   

            // Step 1: Fetch transaction to get current imageUrl and fileId
            let tx;
            try { tx = await databases.getDocument(APPWRITE_DATABASE_ID, webhook_collectionId, txnId); }
            catch (e) { return res.status(404).json({ error: 'Transaction not found' }); }

            // Step 2: Extract fileId from imageUrl or transaction data
            // Assuming imageUrl format: .../buckets/{bucketId}/files/{fileId}/view
            const fileId = tx.imageUrl ? 
                tx.imageUrl.match(/files\/([a-f0-9\-]+)\//)?.[1] : 
                null;

            if (!fileId) {
                return res.status(400).json({ error: 'No image file found in transaction' });
            }

            // Step 3: Delete file from Appwrite Storage
            await storage.deleteFile(bucketId, fileId);
            // console.log(`✅ Deleted file: ${fileId}`);

            // Step 4: Remove imageUrl from transaction (set to null/empty)
            const updated = await databases.updateDocument(
                APPWRITE_DATABASE_ID, 
                webhook_collectionId, 
                txnId, 
                { imageUrl: null }  // Clear the image field
            );

            return res.status(200).json({ 
                success: true, 
                message: 'Image deleted successfully',
                transaction: updated 
            });

        } catch (error) {
            // console.error('Error in /delete-transaction-image:', error);
            return res.status(500).json({ error: 'Failed to delete transaction image' });
        }
    });

    // Admin-only: update transaction status with reconciliation logic
    router.patch('/transactions/:id/status', authenticateAdminOrLabel('edit_transactions'), async (req, res) => {
        try {
            const { id: TxnID } = req.params;
            const { status } = req.body;

            // 1) Validate payload contains ONLY status
            if (Object.keys(req.body).some(k => k !== 'status')) {
            return res.status(400).json({ error: 'Only status can be updated here' });
            }
            const allowed = new Set(['normal', 'cyber', 'refund', 'chargeback', 'failed']);
            if (typeof status !== 'string' || !allowed.has(status.toLowerCase())) {
            return res.status(400).json({ error: 'Invalid status' });
            }
            const nextStatus = status.toLowerCase();

            // 2) Load transaction
            let tx;
            try { tx = await databases.getDocument(APPWRITE_DATABASE_ID, webhook_collectionId, TxnID); }
            catch (e) { return res.status(404).json({ error: 'Transaction not found' }); }

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
            // ── failed transitions ──
            } else if (prev === 'normal' && next === 'failed') {
            await inc('failedCount', 1);
            await inc('failedAmount', amt);
            } else if (prev === 'failed' && next === 'normal') {
            await inc('failedCount', -1);
            await inc('failedAmount', -amt);
            } else if (prev === 'failed' && next === 'cyber') {
            await inc('failedCount', -1);
            await inc('failedAmount', -amt);
            await inc('cyberCount', 1);
            await inc('cyberAmount', amt);
            } else if (prev === 'failed' && next === 'refund') {
            await inc('failedCount', -1);
            await inc('failedAmount', -amt);
            await inc('refundCount', 1);
            await inc('refundAmount', amt);
            } else if (prev === 'failed' && next === 'chargeback') {
            await inc('failedCount', -1);
            await inc('failedAmount', -amt);
            await inc('chargebackCount', 1);
            await inc('chargebackAmount', amt);
            } else if (prev === 'cyber' && next === 'failed') {
            await inc('cyberCount', -1);
            await inc('cyberAmount', -amt);
            await inc('failedCount', 1);
            await inc('failedAmount', amt);
            } else if (prev === 'refund' && next === 'failed') {
            await inc('refundCount', -1);
            await inc('refundAmount', -amt);
            await inc('failedCount', 1);
            await inc('failedAmount', amt);
            } else if (prev === 'chargeback' && next === 'failed') {
            await inc('chargebackCount', -1);
            await inc('chargebackAmount', -amt);
            await inc('failedCount', 1);
            await inc('failedAmount', amt);
            } else {
            console.log('Unhandled transition:', prev, '->', next, 'no counters changed');
            }

            // Emit status change event to user/QR rooms
            emitTxnStatusNew({
                assignedUserId: tx.assignedUserId || '',
                qrCodeId: tx.qrCodeId || '',
                payload: {
                    txnId: TxnID,
                    qrCodeId: tx.qrCodeId,
                    previousStatus: prevStatus,
                    newStatus: nextStatus,
                    amount: Number(tx.amount || 0),
                    rrnNumber: tx.rrnNumber || null,
                    updatedAt: updated.$updatedAt,
                },
            });

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
        let tx;
        try { tx = await databases.getDocument(APPWRITE_DATABASE_ID, webhook_collectionId, TxnID); }
        catch (e) { return res.status(404).json({ error: 'Transaction not found' }); } // standard REST practice [web:185]

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

        // 5) Helpers
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

        // Acquire per-QR lock(s) before any balance read-modify-write.
        // Sort QR IDs for consistent acquisition order — prevents deadlock when two edits swap QRs.
        const editLockVal = TxnID;
        const editLocks = [];
        const qrsToLock = [...new Set([oldQrId, newQrId].filter(Boolean))].sort();
        for (const qId of qrsToLock) {
            const lk = `lock:qr:${qId}`;
            let lkAcquired = false;
            try {
                const r = await redisClient.set(lk, editLockVal, { NX: true, EX: 20 });
                lkAcquired = r === 'OK';
            } catch (e) {
                console.error('Redis lock error in transaction edit:', e);
                lkAcquired = false; // fail safe — reject rather than proceed unprotected
            }
            if (!lkAcquired) {
                for (const { key, val } of editLocks) {
                    await releaseLock(key, val);
                }
                return res.status(409).json({ error: `QR ${qId} is currently being modified by another operation. Please try again in a moment.` });
            }
            editLocks.push({ key: lk, val: editLockVal });
        }
        try {

        // Fetch old QR doc once — reused in both 5A and 5B
        let oldQrDoc = null;
        if (oldQrId) {
            const oldQrList = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('qrId', oldQrId),
                Query.limit(1),
            ]);
            if (oldQrList.documents.length) oldQrDoc = oldQrList.documents[0];
        }

        // 5A) Same QR, amount changed: adjust based on existing status
        if (hasAmountChange && !movedQr) {
        const amountDiff = newAmountPaise - oldAmountPaise; // +/- delta [web:185]

            if (oldQrDoc) {
                const qr = oldQrDoc;

                if (isPrevNormal) {
                    // Normal: adjust ledger total; available derives from totals
                    // amountDiff is in paise (1 rupee = 100 paise) — can be negative if amount reduced
                    const newTotal = Number(qr.totalPayInAmount || 0) + amountDiff;
                    const newAvailable = recomputeAvailable({ ...qr, totalPayInAmount: newTotal });
                    // Block edit if it would push available below zero (pending/approved withdrawals exceed new total)
                    if (newAvailable < 0) {
                        return res.status(409).json({
                            error: 'Cannot reduce this transaction amount: it would cause the available withdrawal balance to go negative. Cancel or reject any pending withdrawals on this QR first.',
                            withdrawalRequested: Number(qr.withdrawalRequestedAmount || 0),
                            withdrawalApproved: Number(qr.withdrawalApprovedAmount || 0),
                        });
                    }
                    await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                        totalPayInAmount: newTotal,
                        amountAvailableForWithdrawal: newAvailable,
                    });
                } else {
                    // Non-normal: adjust both ledger total and hold; available derives from both
                    const delta = (newAmountPaise - oldAmountPaise); // paise delta
                    const newTotal = Number(qr.totalPayInAmount || 0) + delta;
                    const newHold = Number(qr.amountOnHold || 0) + delta;
                    const newAvailable = recomputeAvailable({ ...qr, totalPayInAmount: newTotal, amountOnHold: newHold });
                    if (newAvailable < 0) {
                        return res.status(409).json({
                            error: 'Cannot reduce this transaction amount: it would cause the available withdrawal balance to go negative. Cancel or reject any pending withdrawals on this QR first.',
                            withdrawalRequested: Number(qr.withdrawalRequestedAmount || 0),
                            withdrawalApproved: Number(qr.withdrawalApprovedAmount || 0),
                        });
                    }
                    await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, qr.$id, {
                        totalPayInAmount: newTotal,
                        amountOnHold: newHold,
                        amountAvailableForWithdrawal: newAvailable,
                    });
                }
            }

        }

        // 5B) QR changed: remove prior impact from old QR, add new impact to new QR, based on existing status
        if (movedQr) {
        // Old QR: reverse prior impact (reuse oldQrDoc fetched above)
        if (oldQrId && oldQrDoc) {
            const oldQr = oldQrDoc;
            if (isPrevNormal) {
                const newTotal = Number(oldQr.totalPayInAmount || 0) - oldAmountPaise;
                const newAvailableOldQr = recomputeAvailable({ ...oldQr, totalPayInAmount: newTotal });
                if (newAvailableOldQr < 0) {
                    return res.status(409).json({
                        error: 'Cannot move this transaction: removing it from the source QR would cause the available withdrawal balance to go negative. Cancel or reject any pending withdrawals on this QR first.',
                        withdrawalRequested: Number(oldQr.withdrawalRequestedAmount || 0),
                        withdrawalApproved: Number(oldQr.withdrawalApprovedAmount || 0),
                    });
                }
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
                totalPayInAmount: newTotal,
                totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
                amountAvailableForWithdrawal: newAvailableOldQr,
                }); // remove from totals for normal tx [web:176][web:179]
            } else {
                const newHold = Number(oldQr.amountOnHold || 0) - oldAmountPaise;
                const newAvailableOldQr = recomputeAvailable({ ...oldQr, amountOnHold: newHold });
                if (newAvailableOldQr < 0) {
                    return res.status(409).json({
                        error: 'Cannot move this transaction: removing it from the source QR would cause the available withdrawal balance to go negative. Cancel or reject any pending withdrawals on this QR first.',
                        withdrawalRequested: Number(oldQr.withdrawalRequestedAmount || 0),
                        withdrawalApproved: Number(oldQr.withdrawalApprovedAmount || 0),
                    });
                }
                await databases.updateDocument(APPWRITE_DATABASE_ID, Qr_collectionId, oldQr.$id, {
                amountOnHold: newHold,
                totalTransactions: Math.max(0, (oldQr.totalTransactions || 0) - 1),
                amountAvailableForWithdrawal: newAvailableOldQr,
                }); // remove from hold for non-normal tx [web:170][web:176]
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
            const postAmount = Number(newAmountPaise ?? oldAmountPaise); // use new amount if changed [web:185]

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

        // Daily summary reconciliation — handles all change combinations (amount, QR, or date)
        {
            const oldDateStr = moment.tz(tx.created_at, 'Asia/Kolkata').format('YYYY-MM-DD');
            const newDateStr = updates.created_at
                ? moment.tz(updates.created_at, 'Asia/Kolkata').format('YYYY-MM-DD')
                : oldDateStr;
            const effectiveNewAmount = newAmountPaise ?? oldAmountPaise;
            const sameSlot = (oldDateStr === newDateStr) && (newQrId === oldQrId);

            if (sameSlot && effectiveNewAmount !== oldAmountPaise) {
                // Same QR + same date, only amount changed: apply delta in place
                const dailyLock = await acquireDailyLock(oldDateStr);
                try {
                const summaryList = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                    [Query.equal('date', oldDateStr), Query.limit(1)]
                );
                if (summaryList.total > 0) {
                    const doc = summaryList.documents[0];
                    let totalsObj = {};
                    try { totalsObj = JSON.parse(doc.totalsJson || '{}'); } catch (e) { console.error('CORRUPT totalsJson for doc', doc.$id, '— aborting to prevent data loss'); throw new Error('Daily summary JSON is corrupted — manual fix required'); }
                    const slotDelta = effectiveNewAmount - oldAmountPaise;
                    const slotNewAmt = Number(totalsObj[oldQrId] || 0) + slotDelta;
                    if (slotNewAmt < 0) throw new Error('Daily summary total cannot go negative');
                    totalsObj[oldQrId] = slotNewAmt;
                    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, doc.$id, { totalsJson: JSON.stringify(totalsObj) });
                }
                } finally { await releaseLock(dailyLock.key, dailyLock.val); }
            } else if (!sameSlot) {
                // QR or date changed: subtract old amount from old slot, add new amount to new slot
                // Lock old date, then new date (sorted order to prevent deadlock if they differ)
                const datesToLock = [...new Set([oldDateStr, newDateStr])].sort();
                const dailyLocks = [];
                for (const d of datesToLock) { dailyLocks.push(await acquireDailyLock(d)); }
                try {
                const oldSummaryList = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                    [Query.equal('date', oldDateStr), Query.limit(1)]
                );
                if (oldSummaryList.total > 0) {
                    const doc = oldSummaryList.documents[0];
                    let totalsObj = {};
                    try { totalsObj = JSON.parse(doc.totalsJson || '{}'); } catch (e) { console.error('CORRUPT totalsJson for doc', doc.$id, '— aborting to prevent data loss'); throw new Error('Daily summary JSON is corrupted — manual fix required'); }
                    totalsObj[oldQrId] = Math.max(0, Number(totalsObj[oldQrId] || 0) - oldAmountPaise);
                    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, doc.$id, { totalsJson: JSON.stringify(totalsObj) });
                }
                const newSummaryList = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                    [Query.equal('date', newDateStr), Query.limit(1)]
                );
                if (newSummaryList.total > 0) {
                    const doc = newSummaryList.documents[0];
                    let totalsObj = {};
                    try { totalsObj = JSON.parse(doc.totalsJson || '{}'); } catch (e) { console.error('CORRUPT totalsJson for doc', doc.$id, '— aborting to prevent data loss'); throw new Error('Daily summary JSON is corrupted — manual fix required'); }
                    totalsObj[newQrId] = Number(totalsObj[newQrId] || 0) + effectiveNewAmount;
                    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, doc.$id, { totalsJson: JSON.stringify(totalsObj) });
                }
                } finally { for (const lk of dailyLocks) await releaseLock(lk.key, lk.val); }
            }
            // else: sameSlot and no amount change → nothing to update in daily summaries
        }

        // All balance checks passed — now persist the transaction document
        const updated = await databases.updateDocument(
            APPWRITE_DATABASE_ID,
            webhook_collectionId,
            TxnID,
            updates
        );

        return res.status(200).json({ message: 'Transaction updated', transaction: updated });
        } finally {
            // Release all QR locks acquired for this edit
            for (const { key, val } of editLocks) {
                await releaseLock(key, val);
            }
        }
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

            if (tx.deleted === true) {
                return res.status(400).json({ error: 'Transaction is already deleted' });
            }

            const amountPaise = Number(tx.amount || 0); // paise
            const qrId = tx.qrCodeId;

            // Acquire per-QR lock before balance read-modify-write
            const deleteLockKey = `lock:qr:${qrId}`;
            const deleteLockVal = id;
            if (qrId) {
                let deleteLockAcquired = false;
                try {
                    const r = await redisClient.set(deleteLockKey, deleteLockVal, { NX: true, EX: 20 });
                    deleteLockAcquired = r === 'OK';
                } catch (e) {
                    console.error('Redis lock error in transaction delete:', e);
                    deleteLockAcquired = false; // fail safe
                }
                if (!deleteLockAcquired) {
                    return res.status(409).json({ error: 'QR is currently being modified by another operation. Please try again in a moment.' });
                }
            }
            try {

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

                // Recompute available as a derived field — all values in paise (1 rupee = 100 paise)
                const approved = Number(qrDoc.withdrawalApprovedAmount || 0);
                const requested = Number(qrDoc.withdrawalRequestedAmount || 0);
                const commissionOnHold = Number(qrDoc.commissionOnHold || 0);
                const commissionPaid = Number(qrDoc.commissionPaid || 0);
                const nextAvailable = nextTotal - approved - requested - nextHold - commissionOnHold - commissionPaid;

                // Block deletion if it would make the available balance go negative.
                // This means pending/approved withdrawals exceed what the QR actually received.
                // Admin must reject/cancel those withdrawals before deleting this transaction.
                if (nextAvailable < 0) {
                    return res.status(409).json({
                        error: 'Cannot delete this transaction: it would cause the available withdrawal balance to go negative. Cancel or reject any pending withdrawals on this QR first.',
                        currentAvailable: nextTotal - approved - requested - nextHold - commissionOnHold - commissionPaid,
                        withdrawalRequested: requested,
                        withdrawalApproved: approved,
                    });
                }

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
            const dailyLock = await acquireDailyLock(dayString);
            try {
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

            // Parse totalsJson — abort if corrupted to prevent wiping other QRs' data
            let totalsObj = {};
            try {
                totalsObj = JSON.parse(doc.totalsJson || '{}');
            } catch (e) {
                console.error('CORRUPT totalsJson for doc', doc.$id, '— aborting to prevent data loss');
                throw new Error('Daily summary JSON is corrupted — manual fix required');
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
            } finally { await releaseLock(dailyLock.key, dailyLock.val); }


            } else {
                    console.warn(`QR ${qrId} not found during delete reconciliation`);
                }
            }

            // 3) Decrement counters BEFORE deleting the document.
            // If Redis fails here, the transaction is still intact — admin can retry.
            // If we deleted first and then Redis failed, the transaction is gone with no counter fix.
            // amountPaise is in paise (1 rupee = 100 paise)
            const deleteCounters = [
                redisClient.incrBy('counter:totalTxCount', -1)
                    .then(() => { redisClient.countersDirty = true; })
                    .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed (delete tx):', e); }),
                redisClient.incrBy('counter:totalAmountReceived', -amountPaise)
                    .then(() => { redisClient.countersDirty = true; })
                    .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed (delete tx):', e); }),
            ];
            if (tx.provider === 'manual') {
                deleteCounters.push(updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalManualTx', -1)
                    .catch((e) => { console.error('Error updating totalManualTx counter:', e); }));
            } else {
                deleteCounters.push(redisClient.incrBy('counter:totalApiTx', -1)
                    .then(() => { redisClient.countersDirty = true; })
                    .catch((e) => { redisClient.countersStale = true; console.error('Error updating totalApiTx counter:', e); }));
            }
            await Promise.all(deleteCounters);

            // 4) Soft-delete the transaction document — counters are already decremented
            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                webhook_collectionId,
                id,
                { deleted: true }
            );

            return res.status(200).json({ message: 'Transaction deleted', id });
            } finally {
                // Release the QR lock acquired for this delete
                if (qrId) {
                    await releaseLock(deleteLockKey, deleteLockVal);
                }
            }
        } catch (err) {
            console.error('❌ Delete transaction error:', err.message || err);
            return res.status(500).json({ error: err.message || 'Delete failed' });
        }
    });

    // Manual transaction creation endpoint
    router.post("/transactions/manual", authenticateAdminOrLabel('manual_transactions'), async (req, res) => {
        try {
            const { qrCodeId, rrnNumber, amount, isoDate } = req.body;

            // ✅ Validate required fields
            if (!qrCodeId || !rrnNumber || !amount || !isoDate) {
            return res.status(400).json({
                error: "qrCodeId, rrnNumber, amount, and isoDate are required",
            });
            }

            // RRN idempotency lock — ensures only one request per RRN proceeds even under concurrent retries.
            // Redis NX: only the first request acquires the lock; duplicates get 409.
            // DB duplicate check below is the second line of defence after the lock expires.
            const rrnLockKey = `rrnProcessing:${rrnNumber}`;
            let rrnLockAcquired = false;
            try {
                const r = await redisClient.set(rrnLockKey, '1', { NX: true, EX: 30 });
                rrnLockAcquired = r === 'OK';
            } catch (e) {
                console.error('Redis RRN lock error:', e);
                rrnLockAcquired = false; // fail safe
            }
            if (!rrnLockAcquired) {
                return res.status(409).json({ error: 'A transaction with this RRN is already being processed. Please try again.' });
            }

            let finalAmount, result;
            try {
                // ✅ Check for duplicate RRN (DB guard — catches retries after lock expires)
                const duplicate = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    webhook_collectionId,
                    [Query.equal("rrnNumber", rrnNumber)]
                );

                if (duplicate.documents.length) {
                    return res.status(400).json({ error: "Duplicate RRN detected" });
                }

                // ✅ Convert values
                finalAmount = toPaise(amount);

                // Create document in webhook_data collection
                result = await databases.createDocument(
                    APPWRITE_DATABASE_ID,
                    webhook_collectionId,
                    ID.unique(),
                    {
                        payload: "",
                        qrCodeId: qrCodeId,
                        paymentId: "",
                        rrnNumber: rrnNumber,
                        amount: finalAmount,
                        vpa: "",
                        provider: 'manual',
                        created_at: isoDate,
                        status: 'normal',
                    }
                );
            } finally {
                // Release RRN lock once the document is created (or if it failed)
                await releaseLock(rrnLockKey, '1');
            }

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

            // Acquire QR lock before updating daily summary and QR totals.
            // Same lock key as webhooks — serializes manual transactions with live payment webhooks.
            const manualLockKey = `lock:qr:${qrCodeId}`;
            const manualLockVal = result.$id;
            let manualLockAcquired = false;
            try {
                const r = await redisClient.set(manualLockKey, manualLockVal, { NX: true, EX: 20 });
                manualLockAcquired = r === 'OK';
            } catch (e) {
                console.error('Redis lock error in manual transaction:', e);
                manualLockAcquired = false; // fail safe
            }
            if (!manualLockAcquired) {
                console.warn(`QR ${qrCodeId} lock busy during manual transaction — QR totals may lag by one cycle`);
            }
            try {
                // finalAmount is in paise (1 rupee = 100 paise)
                await updateDailyQrTotal(qrCodeId, isoDate, finalAmount);

                // Update QR code totals under the same lock
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
                            amountAvailableForWithdrawal: newAvailable,
                        }
                        );
                    }
                }
            } finally {
                if (manualLockAcquired) {
                    await releaseLock(manualLockKey, manualLockVal);
                }
            }

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

            // Update global counters:
            // totalTxCount and totalAmountReceived live in Redis (atomic INCRBY, no race)
            // totalManualTx is low-frequency and stays in Appwrite
            // finalAmount is in paise (1 rupee = 100 paise)
            await Promise.all([
                redisClient.incrBy('counter:totalTxCount', 1)
                    .then(() => { redisClient.countersDirty = true; })
                    .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed (manual tx):', e); }),
                redisClient.incrBy('counter:totalAmountReceived', finalAmount)
                    .then(() => { redisClient.countersDirty = true; })
                    .catch((e) => { redisClient.countersStale = true; console.error('Redis counter update failed (manual tx):', e); }),
                updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalManualTx', 1)
                    .catch((e) => { console.error('Error updating totalManualTx counter:', e); }),
            ]);

            return res.status(201).json({
                message: "Transaction uploaded successfully",
                transaction: result,
            });

        } catch (err) {
            console.error("❌ Manual transaction error:", err.message || err);
            return res.status(500).json({ error: err.message || "Transaction upload failed" });
        }
    });

    router.get('/getMyMetaData', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId; // set by your JWT middleware

            // console.log('getMyMetaData for userId:', userId);

            const doc = await userMetaCache.getUserMeta(userId);

            if (!doc) {
            return res.status(404).json({ error: 'User metadata not found' });
            }

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
                const startISO = moment.tz(dateStr, 'Asia/Kolkata').startOf('day').utc().toISOString();
                const endISO = moment.tz(dateStr, 'Asia/Kolkata').endOf('day').utc().toISOString();
                return { startISO, endISO };
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

            if (cursor && !/^[a-zA-Z0-9_:-]{1,255}$/.test(cursor)) {
                return res.status(400).json({ error: 'Invalid cursor format' });
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
            if (isCursorError(err)) return res.status(400).json({ error: 'Invalid or expired pagination cursor' });
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

    // ✅ Manual hold on QR — admin can add/remove hold amount (paise)
    // POST /manual-hold-on-qr { qrId, amountPaise, action: 'hold' | 'release', reason }
    const MANUAL_HOLD_COLLECTION_ID = 'manual_hold_transactions';

    router.post('/manual-hold-on-qr', authenticateAdmin, async (req, res) => {
        const { qrId, amountPaise, action, reason } = req.body;

        // --- Validation ---
        if (!qrId) return res.status(400).json({ error: 'qrId is required' });
        if (!action || !['hold', 'release'].includes(action))
            return res.status(400).json({ error: 'action must be "hold" or "release"' });
        if (!amountPaise || !Number.isInteger(amountPaise) || amountPaise <= 0)
            return res.status(400).json({ error: 'amountPaise must be a positive integer' });

        // --- Acquire per-QR Redis lock ---
        const lockKey = `lock:qr:${qrId}`;
        const lockVal = `hold-${Date.now()}`;
        let lockAcquired = false;
        try {
            const r = await redisClient.set(lockKey, lockVal, { NX: true, EX: 20 });
            lockAcquired = r === 'OK';
        } catch (e) {
            console.error('Redis lock error in manual-hold-on-qr:', e);
        }
        if (!lockAcquired)
            return res.status(409).json({ error: 'QR is currently being modified. Try again shortly.' });

        try {
            // --- Fetch QR doc ---
            const qrResult = await databases.listDocuments(
                APPWRITE_DATABASE_ID, Qr_collectionId,
                [Query.equal('qrId', qrId), Query.limit(1)]
            );
            if (!qrResult.documents.length)
                return res.status(404).json({ error: 'QR not found' });

            const qrDoc = qrResult.documents[0];
            const currentHold = Number(qrDoc.amountOnHold || 0);

            let newHold;
            if (action === 'hold') {
                newHold = currentHold + amountPaise;
            } else {
                if (amountPaise > currentHold)
                    return res.status(400).json({ error: `Cannot release ${amountPaise} paise. Only ${currentHold} paise currently on hold.` });
                newHold = currentHold - amountPaise;
            }

            // Recompute available
            const total     = Number(qrDoc.totalPayInAmount || 0);
            const approved  = Number(qrDoc.withdrawalApprovedAmount || 0);
            const requested = Number(qrDoc.withdrawalRequestedAmount || 0);
            const commHold  = Number(qrDoc.commissionOnHold || 0);
            const commPaid  = Number(qrDoc.commissionPaid || 0);
            const newAvailable = total - approved - requested - newHold - commHold - commPaid;

            // Update QR balance
            await databases.updateDocument(
                APPWRITE_DATABASE_ID, Qr_collectionId, qrDoc.$id,
                {
                    amountOnHold: newHold,
                    amountAvailableForWithdrawal: newAvailable,
                }
            );

            // Save hold transaction record
            const holdRecord = {
                qrId,
                assignedUserId: qrDoc.assignedUserId || null,
                action,
                amountPaise,
                previousHold: currentHold,
                newHold,
                newAvailable,
                reason: reason || null,
                adminId: req.user.userId,
                adminName: req.user.name || null,
                createdAt: istDateTimeNow(),
            };

            await databases.createDocument(
                APPWRITE_DATABASE_ID,
                MANUAL_HOLD_COLLECTION_ID,
                ID.unique(),
                holdRecord
            );

            console.log(`✅ Manual ${action} on QR ${qrId}: ${amountPaise} paise by ${req.user.userId}. Reason: ${reason || 'N/A'}`);

            return res.status(200).json({
                success: true,
                message: `${action === 'hold' ? 'Hold placed' : 'Hold released'} successfully`,
                record: holdRecord,
            });
        } catch (err) {
            console.error('❌ Manual hold error:', err);
            return res.status(500).json({ error: err.message || 'Failed to update hold' });
        } finally {
            await releaseLock(lockKey, lockVal);
        }
    });

    // ✅ GET /manual-hold-on-qr — role-based hold history
    // admin: all records (optional ?qrId, ?userId filters)
    // subadmin: only QRs assigned/managed by them or their users
    // employee: only QRs of subadmins/users assigned to them
    // user: only their own QRs
    router.get('/manual-hold-on-qr', authenticateToken, async (req, res) => {
        try {
            const { qrId, cursor, limit } = req.query;
            const limitNum = Math.min(Number(limit) || 25, 100);
            const role = req.user.role;
            const requestorId = req.user.userId;

            const queries = [Query.orderDesc('$createdAt'), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));

            if (role === 'admin') {
                // Admin sees all — optional filters
                if (qrId) queries.unshift(Query.equal('qrId', qrId));
                if (req.query.userId) queries.unshift(Query.equal('assignedUserId', req.query.userId));

            } else if (role === 'subadmin') {
                // Subadmin sees holds on QRs assigned to them or their users
                const usersRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                    [Query.equal('parentId', requestorId), Query.limit(100)]
                );
                const userIds = usersRes.documents.map(d => d.userId);
                const allIds = [requestorId, ...userIds];
                queries.unshift(Query.equal('assignedUserId', allIds));
                if (qrId) queries.unshift(Query.equal('qrId', qrId));

            } else if (role === 'employee') {
                // Employee sees holds on QRs of subadmins assigned to them + their users
                const merchantsRes = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                    [Query.equal('assigned_to', requestorId), Query.equal('role', 'subadmin'), Query.limit(100)]
                );
                const merchantIds = merchantsRes.documents.map(d => d.userId);

                // Also get users under those subadmins
                let allIds = [...merchantIds];
                if (merchantIds.length > 0) {
                    const usersRes = await databases.listDocuments(
                        APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                        [Query.equal('parentId', merchantIds), Query.limit(500)]
                    );
                    allIds.push(...usersRes.documents.map(d => d.userId));
                }

                if (allIds.length === 0)
                    return res.status(200).json({ success: true, records: [], total: 0, nextCursor: null });

                queries.unshift(Query.equal('assignedUserId', allIds));
                if (qrId) queries.unshift(Query.equal('qrId', qrId));

            } else {
                // Regular user — only their own QRs
                queries.unshift(Query.equal('assignedUserId', requestorId));
                if (qrId) queries.unshift(Query.equal('qrId', qrId));
            }

            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID, MANUAL_HOLD_COLLECTION_ID, queries
            );

            const records = result.documents.map(doc => ({
                $id: doc.$id,
                qrId: doc.qrId,
                assignedUserId: doc.assignedUserId,
                action: doc.action,
                amountPaise: doc.amountPaise,
                previousHold: doc.previousHold,
                newHold: doc.newHold,
                newAvailable: doc.newAvailable,
                reason: doc.reason,
                adminId: doc.adminId,
                adminName: doc.adminName,
                createdAt: doc.createdAt,
            }));

            const nextCursor = records.length === limitNum ? result.documents[records.length - 1].$id : null;

            return res.status(200).json({ success: true, records, total: result.total, nextCursor });
        } catch (err) {
            console.error('❌ List hold records error:', err);
            return res.status(500).json({ error: 'Failed to fetch hold records' });
        }
    });

    function istDateTimeNow(){
        return moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS[Z]');
    }

    // GET /dashboard/counters
    router.get('/dashboard/counters', authenticateAdmin, async (req, res) => {

        const Qr_today_pay_in_limit = ConfigManager.get('qr_limit_today_pay_in', 30000000); // default 3L if not set

        const actor = req.user;

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

            const todayDayString = moment.tz('Asia/Kolkata').format('YYYY-MM-DD');
            const yesterdayDayString = moment.tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');

            const fetchSummary = (date) => databases.listDocuments(
                APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [Query.equal('date', date), Query.limit(1)]
            );

            const [existingDocs, existingDocsYesterday] = await Promise.all([
                fetchSummary(todayDayString), fetchSummary(yesterdayDayString)
            ]);

            let todayPayInAllQrs = 0;
            let yesterdayPayInAllQrs = 0;

            // Yesterday
            if (existingDocsYesterday.total > 0) {
                let totalsObj;
                try {
                    totalsObj = JSON.parse(existingDocsYesterday.documents[0].totalsJson || '{}');
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson in yesterday summary (read-only) —', e.message);
                    totalsObj = {};
                }
                yesterdayPayInAllQrs = Object.values(totalsObj).reduce((sum, value) => sum + parseInt(value || 0, 10), 0);
            }

            if (existingDocs.total > 0) {
                // Document exists - parse JSON string and update totals object
                const doc = existingDocs.documents[0];
                const totalsJsonStr = doc.totalsJson || '{}';

                let totalsObj;
                try {
                    totalsObj = JSON.parse(totalsJsonStr);
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson in daily summary (read-only path) —', e.message);
                    totalsObj = {};
                }

                todayPayInAllQrs = Object.values(totalsObj).reduce((sum, value) => {
                    return sum + parseInt(value || 0, 10);
                }, 0);

                // 1) Fetch all QRs assigned to this user
                const qrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                    Query.equal('assignedUserId', actor.userId),
                    Query.limit(100),
                    Query.orderAsc('$id'),
                ]);

                const userQrIds = qrs.map(q => q.qrId);

                 // ✅ Separate logic: Check each user QR individually for 10000 limit
                const userQrEntries = Object.entries(totalsObj).filter(([qrid]) => userQrIds.includes(qrid));

                userQrEntries.forEach(([qrid, valueStr]) => {
                    const value = parseInt(valueStr || 0, 10);
                    if (value >= Qr_today_pay_in_limit) {
                        // Execute function for this specific QR that crossed limit
                        // handleQrLimitCrossed(qrid, value);
                        const payload = { userid: actor.userId, qrCodeId: qrid, todayPayIn: value };
                        emitQrLimit({ qrCodeId: qrid, payload: payload });
                    }
                });

                // console.log('User QRs totals:', todayPayInAllQrs, 'Crossed limit:', userQrEntries.filter(([, v]) => parseInt(v || 0, 10) >= 10000).map(([qrid]) => qrid));

                // console.log('📊 Raw totalsObj from DB:', totalsObj);

                // console.log('📊 Stored totals sum:', todayPayInAllQrs, 'from', Object.keys(totalsObj).length, 'QRs')    ;
            }

            // Helper to get value or 0
            const get = (k) => (map.has(k) ? map.get(k) : 0);

            // Override the 3 counters that are now maintained atomically in Redis.
            // Appwrite values lag up to 5 minutes behind due to the periodic flush.
            // Redis is the source of truth for these 3.
            if (redisClient?.isReady) {
                try {
                    const [rTxCount, rApiTx, rAmountReceived] = await Promise.all([
                        redisClient.get('counter:totalTxCount'),
                        redisClient.get('counter:totalApiTx'),
                        redisClient.get('counter:totalAmountReceived'),
                    ]);
                    if (rTxCount !== null) map.set('totalTxCount', Number(rTxCount));
                    if (rApiTx !== null) map.set('totalApiTx', Number(rApiTx));
                    if (rAmountReceived !== null) map.set('totalAmountReceived', Number(rAmountReceived));
                } catch (e) {
                    console.error('Redis counter read failed, using Appwrite values:', e?.message);
                }
            }

            // Build the structured response
            const payload = {
            // Totals
            totalTxCount: get('totalTxCount'),
            totalAmountReceived: get('totalAmountReceived'),
            todayPayInAllQrs: todayPayInAllQrs,
            yesterdayPayInAllQrs: yesterdayPayInAllQrs,
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
            failedCount: get('failedCount'),
            failedAmount: get('failedAmount'),

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
    router.get('/dashboard/subadmin/:merchantId', authenticateAdminOrSubAdminOrEmployee, async (req, res) => {
        const { merchantId } = req.params;
        const actor = req.user;

        const isSelf = actor.userId === merchantId;
        const isAdmin = actor.role === 'admin';
        const isEmployee = actor.role === 'employee';

        // console.log(`Dashboard for merchantId: ${merchantId} requested by userId: ${actor.userId} with role: ${actor.role}`);

        const Qr_today_pay_in_limit = ConfigManager.get('qr_limit_today_pay_in', 30000000); // default 3L if not set

        const todayDayString = moment.tz('Asia/Kolkata').format('YYYY-MM-DD');
        const yesterdayDayString = moment.tz('Asia/Kolkata').clone().subtract(1, 'day').format('YYYY-MM-DD');

        try {
            // Authorization: allow admin or the merchant owner
            // if (actor.role !== 'admin' && actor.userId !== merchantId && actor.role !== 'employee') 
            if(!isAdmin && !isSelf && !isEmployee) {
                // console.log(`User ${actor.userId} with role ${actor.role} is not authorized to view dashboard for merchant ${merchantId}`);
                return res.status(403).json({ message: 'Forbidden' });
            }

            // 1) Fetch all QRs managed by merchantId (paginate)
            const AllManagedQrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('managedByUserId', merchantId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            // 1) Fetch all QRs managed by merchantId (paginate)
            const AllSelfAssignedQrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('assignedUserId', merchantId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            // QRs managed by merchantId but assigned to someone else (their sub-users)
            const AllUserAssignedQrs = AllManagedQrs.filter(q => q.assignedUserId !== merchantId);

            const AllManagedQrIds = AllManagedQrs.map(q => q.qrId);
            const AllSelfAssignedQrIds = AllSelfAssignedQrs.map(q => q.qrId);
            const AllUserAssignedQrIds = AllUserAssignedQrs.map(q => q.qrId);

            // console.log(`Merchant ${merchantId} has ${AllManagedQrs.length} managed QRs, ${AllSelfAssignedQrs.length} self-assigned QRs, ${AllUserAssignedQrs.length} user-assigned QRs`);

            // console.log(`Merchant ${merchantId} has ${AllManagedQrs.length} QRs IDS [${userQrIds.join(', ')}]`);

            const existingDocs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                    Query.equal('date', todayDayString),
                    Query.limit(1),
                ]
            );

            let todayPayInAllQrs = 0;
            let todayPayInSelfAssignedQrs = 0;
            let todayPayInUserAssignedQrs = 0;

            if (existingDocs.total > 0) {
                // Document exists - parse JSON string and update totals object
                const doc = existingDocs.documents[0];
                const totalsJsonStr = doc.totalsJson || '{}';

                let totalsObj;
                try {
                    totalsObj = JSON.parse(totalsJsonStr);
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson in daily summary (read-only path) —', e.message);
                    totalsObj = {};
                }

                // OPTIONAL: If you need user-specific subset (instead of all)
                // Total across all QRs assigned to this merchant (not just self-assigned)
                todayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllManagedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                todayPayInSelfAssignedQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllSelfAssignedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                todayPayInUserAssignedQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllUserAssignedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                // ✅ Separate logic: Check each user QR individually for 10000 limit
                const userQrEntries = Object.entries(totalsObj).filter(([qrid]) => AllManagedQrIds.includes(qrid));

                userQrEntries.forEach(([qrid, valueStr]) => {
                        const value = parseInt(valueStr || 0, 10);
                        if (value >= Qr_today_pay_in_limit) {
                            // Execute function for this specific QR that crossed limit
                            // handleQrLimitCrossed(qrid, value);
                            const payload = { userid: actor.userId, qrCodeId: qrid, todayPayIn: value };
                            emitQrLimit({ qrCodeId: qrid, payload: payload });
                        }
                });

            }

            // Yesterday's pay-in
            const existingDocsYesterday = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                    Query.equal('date', yesterdayDayString),
                    Query.limit(1),
                ]
            );

            let yesterdayPayInAllQrs = 0;
            let yesterdayPayInSelfAssignedQrs = 0;
            let yesterdayPayInUserAssignedQrs = 0;

            if (existingDocsYesterday.total > 0) {
                const doc = existingDocsYesterday.documents[0];
                let totalsObj;
                try {
                    totalsObj = JSON.parse(doc.totalsJson || '{}');
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson for doc', doc.$id, '(read-only) —', e.message);
                    totalsObj = {};
                }

                yesterdayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllManagedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                yesterdayPayInSelfAssignedQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllSelfAssignedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);

                yesterdayPayInUserAssignedQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => AllUserAssignedQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);
            }

            // 2) Aggregate QR-derived counters for AllManagedQrs
            let totalTxCount = 0;
            let totalAmountReceived = 0;
            let totalAvailableAmount = 0;
            let totalWithdrawalPendingAmount = 0;
            let totalAmountPaid = 0;
            let totalAmountOnHold = 0;

            let totalCommissionOnHold = 0;         // sum of qr.commissionOnHold (paise)
            let totalCommissionPaid = 0;           // sum of qr.commissionPaid (paise)

            let totalQrsAssignedToMerchant = AllManagedQrs.length;
            let qrCodesActive = 0;
            let qrCodesDisabled = 0;

            let totalMerchantProfit = 0;

            for (const qr of AllManagedQrs) {
                const isActive = !!qr.isActive;

                const txAmount = parseInt(qr.totalPayInAmount || 0, 10);
                const avail = parseInt(qr.amountAvailableForWithdrawal || 0, 10);
                const paid = parseInt(qr.withdrawalApprovedAmount || 0, 10);
                const pendingW = parseInt(qr.withdrawalRequestedAmount || 0, 10);
                const onHold = parseInt(qr.amountOnHold || 0, 10);

                const commHold = parseInt(qr.commissionOnHold || 0, 10);
                const commPaid = parseInt(qr.commissionPaid || 0, 10);

                if (isActive) qrCodesActive++; else qrCodesDisabled++;
                totalTxCount += parseInt(qr.totalTransactions || 0, 10);
                totalAmountReceived += txAmount;
                totalAvailableAmount += avail;
                totalWithdrawalPendingAmount += pendingW;
                totalAmountPaid += paid;
                totalAmountOnHold += onHold;

                totalCommissionOnHold += commHold;
                totalCommissionPaid += commPaid;
            }

            // 2b) Aggregate QR-derived counters for AllSelfAssignedQrs
            let selfTotalTxCount = 0;
            let selfTotalAmountReceived = 0;
            let selfTotalAvailableAmount = 0;
            let selfTotalWithdrawalPendingAmount = 0;
            let selfTotalAmountPaid = 0;
            let selfTotalAmountOnHold = 0;
            
            let selfTotalCommissionOnHold = 0;         // sum of qr.commissionOnHold (paise)
            let selfTotalCommissionPaid = 0;           // sum of qr.commissionPaid (paise)

            let selfQrCodesActive = 0;
            let selfQrCodesDisabled = 0;

            for (const qr of AllSelfAssignedQrs) {
                const isActive = !!qr.isActive;
                const txAmount = parseInt(qr.totalPayInAmount || 0, 10);
                const avail = parseInt(qr.amountAvailableForWithdrawal || 0, 10);
                const paid = parseInt(qr.withdrawalApprovedAmount || 0, 10);
                const pendingW = parseInt(qr.withdrawalRequestedAmount || 0, 10);
                const onHold = parseInt(qr.amountOnHold || 0, 10);

                const commHold = parseInt(qr.commissionOnHold || 0, 10);
                const commPaid = parseInt(qr.commissionPaid || 0, 10);

                if (isActive) selfQrCodesActive++; else selfQrCodesDisabled++;
                selfTotalTxCount += parseInt(qr.totalTransactions || 0, 10);
                selfTotalAmountReceived += txAmount;
                selfTotalAvailableAmount += avail;
                selfTotalWithdrawalPendingAmount += pendingW;
                selfTotalAmountPaid += paid;
                selfTotalAmountOnHold += onHold;

                selfTotalCommissionOnHold += commHold;
                selfTotalCommissionPaid += commPaid;
            }

            // 2c) Aggregate QR-derived counters for AllUserAssignedQrs (managed by merchant, assigned to sub-users)
            let userTotalTxCount = 0;
            let userTotalAmountReceived = 0;
            let userTotalAvailableAmount = 0;
            let userTotalWithdrawalPendingAmount = 0;
            let userTotalAmountPaid = 0;
            let userTotalAmountOnHold = 0;

            let userTotalCommissionOnHold = 0;         // sum of qr.commissionOnHold (paise)
            let userTotalCommissionPaid = 0;           // sum of qr.commissionPaid (paise)

            let userQrCodesActive = 0;
            let userQrCodesDisabled = 0;

            for (const qr of AllUserAssignedQrs) {

                // console.log(`Processing user-assigned QR ${qr.qrId} assigned to user ${qr.assignedUserId} with totalPayInAmount ${qr.totalPayInAmount}`);

                const isActive = !!qr.isActive;
                const txAmount = parseInt(qr.totalPayInAmount || 0, 10);
                const avail = parseInt(qr.amountAvailableForWithdrawal || 0, 10);
                const paid = parseInt(qr.withdrawalApprovedAmount || 0, 10);
                const pendingW = parseInt(qr.withdrawalRequestedAmount || 0, 10);
                const onHold = parseInt(qr.amountOnHold || 0, 10);

                const commHold = parseInt(qr.commissionOnHold || 0, 10);
                const commPaid = parseInt(qr.commissionPaid || 0, 10);

                if (isActive) userQrCodesActive++; else userQrCodesDisabled++;
                userTotalTxCount += parseInt(qr.totalTransactions || 0, 10);
                userTotalAmountReceived += txAmount;
                userTotalAvailableAmount += avail;
                userTotalWithdrawalPendingAmount += pendingW;
                userTotalAmountPaid += paid;
                userTotalAmountOnHold += onHold;

                userTotalCommissionOnHold += commHold;
                userTotalCommissionPaid += commPaid;
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

            let withdrawableAmount = totalAvailableAmount - todayPayInAllQrs;
            let selfWithdrawableAmount = selfTotalAvailableAmount - todayPayInSelfAssignedQrs;
            let userWithdrawableAmount = userTotalAvailableAmount - todayPayInUserAssignedQrs;

            // Response
            return res.json({
                merchantId,

                // --- AllManagedQrs metrics ---
                totalQrsAssignedToMerchant,
                todayPayInAllQrs,
                yesterdayPayInAllQrs,
                totalTxCount,
                totalAmountReceived,
                totalAvailableAmount,
                withdrawableAmount,
                qrCodesActive,
                qrCodesDisabled,
                totalAmountPaid,
                totalWithdrawalPendingAmount,
                totalAmountOnHold,
                totalCommissionOnHold,
                totalCommissionPaid,

                // --- AllSelfAssignedQrs metrics ---
                totalSelfAssignedQrs: AllSelfAssignedQrs.length,
                todayPayInSelfAssignedQrs,
                yesterdayPayInSelfAssignedQrs,
                selfTotalTxCount,
                selfTotalAmountReceived,
                selfTotalAvailableAmount,
                selfWithdrawableAmount,
                selfQrCodesActive,
                selfQrCodesDisabled,
                selfTotalAmountPaid,
                selfTotalWithdrawalPendingAmount,
                selfTotalAmountOnHold,
                selfTotalCommissionOnHold,
                selfTotalCommissionPaid,

                // --- AllUserAssignedQrs metrics (managed by merchant, assigned to sub-users) ---
                totalUserAssignedQrs: AllUserAssignedQrs.length,
                todayPayInUserAssignedQrs,
                yesterdayPayInUserAssignedQrs,
                userTotalTxCount,
                userTotalAmountReceived,
                userTotalAvailableAmount,
                userWithdrawableAmount,
                userQrCodesActive,
                userQrCodesDisabled,
                userTotalAmountPaid,
                userTotalWithdrawalPendingAmount,
                userTotalAmountOnHold,
                userTotalCommissionOnHold,
                userTotalCommissionPaid,

                // --- Other ---
                totalMerchantProfit,

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

        const Qr_today_pay_in_limit = ConfigManager.get('qr_limit_today_pay_in', 30000000); // default 3L if not set

        const todayDayString = moment.tz('Asia/Kolkata').format('YYYY-MM-DD');;
        const yesterdayDayString = moment.tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');

        try {
            // Authorization: allow admin, the same user, or that user's manager/subadmin if policy allows
            const isSelf = actor.userId === userId;
            const isAdmin = actor.role === 'admin';
            const isEmployee = actor.role === 'employee';

            const isSubadmin = actor.role === 'subadmin';

            if (isSubadmin && !isSelf) {
                // Subadmin can only view users under them (parentId === subadmin's userId)
                const userDoc = await databases.listDocuments(
                    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                    [Query.equal('userId', userId), Query.equal('parentId', actor.userId), Query.limit(1)]
                );
                if (userDoc.documents.length === 0)
                    return res.status(403).json({ message: 'This user is not managed by you' });
            } else if (!isAdmin && !isSelf && !isEmployee) {
                return res.status(403).json({ message: 'Forbidden' });
            }

            // 1) Fetch all QRs assigned to this user
            const qrs = await listAllDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
                Query.equal('assignedUserId', userId),
                Query.limit(100),
                Query.orderAsc('$id'),
            ]);

            const userQrIds = qrs.map(q => q.qrId);

            const existingDocsTodayPayin = await databases.listDocuments (
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                    Query.equal('date', todayDayString),
                    Query.limit(1),
                ]
            );

            let todayPayInAllQrs = 0;

            // Check if document for today's date exists
            if (existingDocsTodayPayin.total > 0) {
                // Document exists - parse JSON string and update totals object
                const doc = existingDocsTodayPayin.documents[0];
                const totalsJsonStr = doc.totalsJson || '{}';

                let totalsObj;
                try {
                    totalsObj = JSON.parse(totalsJsonStr);
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson in daily summary (read-only path) —', e.message);
                    totalsObj = {};
                }
                // OPTIONAL: If you need user-specific subset (instead of all)
                todayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => userQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);
                // ✅ Separate logic: Check each user QR individually for 10000 limit
                const userQrEntries = Object.entries(totalsObj).filter(([qrid]) => userQrIds.includes(qrid));
                userQrEntries.forEach(([qrid, valueStr]) => {
                        const value = parseInt(valueStr || 0, 10);
                        if (value >= Qr_today_pay_in_limit) {
                            // Execute function for this specific QR that crossed limit
                            // handleQrLimitCrossed(qrid, value);
                            const payload = { userid: actor.userId, qrCodeId: qrid, todayPayIn: value };
                            emitQrLimit({ qrCodeId: qrid, payload: payload });
                        }
                });
            }

            const existingDocsYesterdayPayin = await databases.listDocuments (
                APPWRITE_DATABASE_ID,
                APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                [
                    Query.equal('date', yesterdayDayString),
                    Query.limit(1),
                ]
            );

            let yesterdayPayInAllQrs = 0;

            // Check if document for today's date exists
            if (existingDocsYesterdayPayin.total > 0) {
                // Document exists - parse JSON string and update totals object
                const doc = existingDocsYesterdayPayin.documents[0];
                const totalsJsonStr = doc.totalsJson || '{}';

                let totalsObj;
                try {
                    totalsObj = JSON.parse(totalsJsonStr);
                } catch (e) {
                    console.error('WARNING: corrupted totalsJson in daily summary (read-only path) —', e.message);
                    totalsObj = {};
                }
                // OPTIONAL: If you need user-specific subset (instead of all)
                yesterdayPayInAllQrs = Object.entries(totalsObj)
                    .filter(([qrid]) => userQrIds.includes(qrid))
                    .reduce((sum, [, value]) => sum + parseInt(value || 0, 10), 0);
                
                    // ✅ Separate logic: Check each user QR individually for 10000 limit
                // const userQrEntries = Object.entries(totalsObj).filter(([qrid]) => userQrIds.includes(qrid));
                // userQrEntries.forEach(([qrid, valueStr]) => {
                //         const value = parseInt(valueStr || 0, 10);
                //         if (value >= Qr_today_pay_in_limit) {
                //             // Execute function for this specific QR that crossed limit
                //             // handleQrLimitCrossed(qrid, value);
                //             const payload = { userid: actor.userId, qrCodeId: qrid, todayPayIn: value };
                //             emitQrLimit({ qrCodeId: qrid, payload: payload });
                //         }
                // });
            }

            // 2) Aggregate QR-derived counters
            let totalQrs = qrs.length;
            let qrCodesActive = 0;
            let qrCodesDisabled = 0;

            let totalTxCount = 0;           // sum of qr.totalTransactions (count)
            let totalAmountPayIn = 0;       // sum of qr.totalPayInAmount (paise)

            let withdrawableAmount = 0;          // sum of qr.amountAvailableForWithdrawal (paise)

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

            withdrawableAmount = totalAvailableAmount - todayPayInAllQrs;

            // 3) Respond
            return res.json({
                userId,
                // QR breakdown
                totalQrs,
                todayPayInAllQrs,
                yesterdayPayInAllQrs,
                qrCodesActive,
                qrCodesDisabled,

                // Transactions
                totalTxCount,
                totalAmountPayIn,

                // Payouts
                totalWithdrawalApprovedAmount,
                totalWithdrawalPendingAmount,
                totalAvailableAmount,
                withdrawableAmount,
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

    // ─────────────────────────────────────────────────────────────────────────
    // GET /payin-summary
    // Returns daily payin totals from daily_qr_summaries, scoped to the caller's role.
    //
    // Query params:
    //   from        — start date YYYY-MM-DD (default: today)
    //   to          — end date   YYYY-MM-DD (default: today)
    //   userId      — (admin/subadmin only) filter to a specific user's QRs
    //   qrId        — filter to a single QR code
    //
    // Response shape:
    //   { days: [ { date, totalPaise, totalRs, qrs: { qrId: paise, ... } } ],
    //     grandTotalPaise, grandTotalRs, todayPaise, todayRs, yesterdayPaise, yesterdayRs }
    // ─────────────────────────────────────────────────────────────────────────
    router.get('/payin-summary', authenticateToken, async (req, res) => {
        try {
            const actor = req.user;
            const isAdmin = actor.role === 'admin';
            const isSubadmin = actor.role === 'subadmin';
            const isEmployee = actor.role === 'employee';

            const todayStr = moment.tz('Asia/Kolkata').format('YYYY-MM-DD');
            const yesterdayStr = moment.tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');

            const from = req.query.from || todayStr;
            const to = req.query.to || todayStr;
            const filterUserId = req.query.userId || null;
            const filterQrId = req.query.qrId || null;

            // 1) Determine which QR IDs the caller can see
            let allowedQrIds = null; // null = all (admin)

            if (isAdmin || isEmployee) {
                if (filterUserId) {
                    // Admin filtering by a specific user
                    allowedQrIds = await getQrIdsForUser(filterUserId);
                }
                // else null = show all QRs (admin sees everything)
            } else if (isSubadmin) {
                if (filterUserId) {
                    // Subadmin filtering by a user — must be under them
                    const managedUsers = await databases.listDocuments(
                        APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
                        [Query.equal('parentId', actor.userId)]
                    );
                    const managedUserIds = managedUsers.documents.map(u => u.userId);
                    if (filterUserId !== actor.userId && !managedUserIds.includes(filterUserId)) {
                        return res.status(403).json({ error: 'You can only view your own users' });
                    }
                    allowedQrIds = await getQrIdsForUser(filterUserId);
                } else {
                    // Subadmin sees all QRs under their management
                    allowedQrIds = [...(await getQrIdsForSubadmin(actor.userId))];
                }
            } else {
                // Regular user — only their own QRs
                allowedQrIds = await getQrIdsForUser(actor.userId);
            }

            // Apply single QR filter if provided
            if (filterQrId) {
                if (allowedQrIds && !allowedQrIds.includes(filterQrId)) {
                    return res.status(403).json({ error: 'You do not have access to this QR code' });
                }
                allowedQrIds = [filterQrId];
            }

            // 2) Fetch daily summary docs for the date range
            const startDate = moment.tz(from, 'Asia/Kolkata');
            const endDate = moment.tz(to, 'Asia/Kolkata');
            if (!startDate.isValid() || !endDate.isValid() || endDate.isBefore(startDate)) {
                return res.status(400).json({ error: 'Invalid date range' });
            }

            const days = [];
            let grandTotalPaise = 0;
            let todayPaise = 0;
            let yesterdayPaise = 0;

            // Iterate each day in range
            const cursor = startDate.clone();
            while (cursor.isSameOrBefore(endDate, 'day')) {
                const dateStr = cursor.format('YYYY-MM-DD');

                const summaryDocs = await databases.listDocuments(
                    APPWRITE_DATABASE_ID,
                    APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID,
                    [Query.equal('date', dateStr), Query.limit(1)]
                );

                let dayTotal = 0;
                let qrBreakdown = {};

                if (summaryDocs.total > 0) {
                    let totalsObj = {};
                    try {
                        totalsObj = JSON.parse(summaryDocs.documents[0].totalsJson || '{}');
                    } catch (e) {
                        console.error('WARNING: corrupted totalsJson for date', dateStr, '—', e.message);
                        totalsObj = {};
                    }

                    // Filter to allowed QRs
                    for (const [qrId, paise] of Object.entries(totalsObj)) {
                        if (allowedQrIds && !allowedQrIds.includes(qrId)) continue;
                        const amount = parseInt(paise || 0, 10);
                        qrBreakdown[qrId] = amount;
                        dayTotal += amount;
                    }
                }

                days.push({
                    date: dateStr,
                    totalPaise: dayTotal,
                    totalRs: dayTotal / 100,
                    qrs: qrBreakdown,
                });

                grandTotalPaise += dayTotal;
                if (dateStr === todayStr) todayPaise = dayTotal;
                if (dateStr === yesterdayStr) yesterdayPaise = dayTotal;

                cursor.add(1, 'day');
            }

            return res.json({
                days,
                grandTotalPaise,
                grandTotalRs: grandTotalPaise / 100,
                todayPaise,
                todayRs: todayPaise / 100,
                yesterdayPaise,
                yesterdayRs: yesterdayPaise / 100,
            });
        } catch (err) {
            console.error('Payin summary error:', err);
            return res.status(500).json({ error: 'Failed to fetch payin summary' });
        }
    });

    // ===================== Config Management (Admin Only) =====================

    const ALLOWED_CONFIG_TYPES = ['string', 'integer', 'double', 'boolean', 'json'];

    function validateConfigVal(type, val) {
        if (typeof val !== 'string') return 'val must be a string';
        if (type === 'integer') {
            if (!/^-?\d+$/.test(val)) return 'val must be a valid integer (e.g. "100")';
        } else if (type === 'double') {
            if (isNaN(parseFloat(val))) return 'val must be a valid number (e.g. "10.5")';
        } else if (type === 'boolean') {
            if (!['true', 'false', '1', '0', 'yes', 'no'].includes(val.toLowerCase())) return 'val must be a boolean string (true/false/1/0/yes/no)';
        } else if (type === 'json') {
            try { JSON.parse(val); } catch (e) { return 'val must be valid JSON'; }
        }
        return null;
    }

    // GET all configs
    router.get('/config', async (_req, res) => {
        try {
            await ConfigManager.refresh();
            const rawDocs = ConfigManager.getRawDocs();
            res.json({ success: true, configs: rawDocs.map(d => ({ id: d.$id, key: d.key, val: d.val ?? String(d.value ?? ''), type: d.type, description: d.description ?? '', $createdAt: d.$createdAt, $updatedAt: d.$updatedAt })) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || 'Failed to fetch configs' });
        }
    });

    // POST create new config
    router.post('/config', authenticateAdmin, async (req, res) => {
        try {
            const { key, val, type, description } = req.body;
            if (!key || typeof key !== 'string' || !key.trim()) {
                return res.status(400).json({ error: 'key is required and must be a non-empty string' });
            }
            if (!type || !ALLOWED_CONFIG_TYPES.includes(type)) {
                return res.status(400).json({ error: `type is required and must be one of: ${ALLOWED_CONFIG_TYPES.join(', ')}` });
            }
            if (val == null) {
                return res.status(400).json({ error: 'val is required' });
            }
            const valErr = validateConfigVal(type, val);
            if (valErr) return res.status(400).json({ error: valErr });

            // Check if key already exists
            await ConfigManager.refresh();
            const existing = ConfigManager.getRawDoc(key.trim());
            if (existing) {
                return res.status(409).json({ error: `Config key "${key.trim()}" already exists. Use PUT to update.` });
            }

            const createData = { key: key.trim(), val, type };
            if (description != null) createData.description = String(description);

            await databases.createDocument(
                '688ca9f3003e593a6227',
                '68a73217002ed987b246',
                ID.unique(),
                createData
            );

            await ConfigManager.refresh();
            res.json({ success: true, message: `Config "${key.trim()}" created` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || 'Failed to create config' });
        }
    });

    // PUT update existing config
    router.put('/config', authenticateAdmin, async (req, res) => {
        try {
            const { key, val, type, description } = req.body;
            if (!key || typeof key !== 'string' || !key.trim()) {
                return res.status(400).json({ error: 'key is required' });
            }

            await ConfigManager.refresh();
            const doc = ConfigManager.getRawDoc(key.trim());
            if (!doc) {
                return res.status(404).json({ error: `Config key "${key.trim()}" not found` });
            }

            const updateData = {};
            const effectiveType = type || doc.type;

            if (type) {
                if (!ALLOWED_CONFIG_TYPES.includes(type)) {
                    return res.status(400).json({ error: `type must be one of: ${ALLOWED_CONFIG_TYPES.join(', ')}` });
                }
                updateData.type = type;
            }

            if (val != null) {
                const valErr = validateConfigVal(effectiveType, val);
                if (valErr) return res.status(400).json({ error: valErr });
                updateData.val = val;
            }

            if (description != null) {
                updateData.description = String(description);
            }

            if (Object.keys(updateData).length === 0) {
                return res.status(400).json({ error: 'Nothing to update. Provide val, type, and/or description.' });
            }

            await databases.updateDocument(
                '688ca9f3003e593a6227',
                '68a73217002ed987b246',
                doc.$id,
                updateData
            );
            await ConfigManager.refresh();
            res.json({ success: true, message: `Config "${key.trim()}" updated` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || 'Failed to update config' });
        }
    });

    // DELETE config
    router.delete('/config', authenticateAdmin, async (req, res) => {
        try {
            const { key } = req.body;
            if (!key || typeof key !== 'string' || !key.trim()) {
                return res.status(400).json({ error: 'key is required' });
            }

            await ConfigManager.refresh();
            const doc = ConfigManager.getRawDoc(key.trim());
            if (!doc) {
                return res.status(404).json({ error: `Config key "${key.trim()}" not found` });
            }

            await databases.deleteDocument(
                '688ca9f3003e593a6227',
                '68a73217002ed987b246',
                doc.$id
            );
            await ConfigManager.refresh();
            res.json({ success: true, message: `Config "${key.trim()}" deleted` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || 'Failed to delete config' });
        }
    });

    return router;

};
