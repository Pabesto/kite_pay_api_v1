// -----------------------------------------------------------------------------------------------------
// routes/admin.js
// This file contains the API endpoints for user management.

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });


// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, Qr_collectionId, webhook_collectionId, bucketId, authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin, InputFile, roleAuth, requireRole) => {
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
    router.get('/users', authenticateAdminOrSubAdmin, async (req, res) => {
        const requestorId = req.user.userId;
        const role = req.user.role; // 'admin' | 'subadmin'

        try {
            const queries = [];

            if (role === 'subadmin') {
                queries.push(Query.equal('parentId', requestorId));
            }
            // admins see all; subadmins only their users

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
            }));

            return res.json(simplifiedUsers);
        } catch (err) {
            console.error('List users error:', err);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }
    });

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
            }));

            return res.json(simplifiedUsers);
        } catch (err) {
            console.error('List sub-admins error:', err);
            return res.status(500).json({ error: 'Failed to fetch sub-admins' });
        }
    });
    
    // // 🔥 List all users
    // router.get('/userss', async (req, res) => {
    //     try {
    //         return "Test";
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
            };

            // 3) Idempotent metadata write: use 1:1 docId = userId
            try {
            console.log('Creating user metadata document for userId:', userId);
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

    // ✏️ Edit user endpoint
    router.put('/edit-user/:id', authenticateAdminOrSubAdmin, async (req, res) => {
        const userIdtoEdit = req.params.id;
        const { name, email, labels } = req.body;

        const userRequested = req.user; // set by your JWT middleware

        if (!userIdtoEdit || (!name && !email && !labels)) {
            return res.status(400).json({ error: 'User ID and at least one field (name or email or labels) are required' });
        }

        try {
            const user = await users.get(userIdtoEdit);

            if (user.labels?.includes('admin')) {
                return res.status(403).json({ error: 'Cannot edit admin users' });
            }

            if (name) await users.updateName(userIdtoEdit, name);
            if (email) await users.updateEmail(userIdtoEdit, email);
            // if (labels) {
            //     if (!Array.isArray(labels)) {
            //         return res.status(400).json({ error: 'Labels must be an array' });
            //     }
            //     await users.updateLabels(userId, labels);
            // }

            // Find document in users_mets collection matching userId
            const list = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                [
                    Query.equal('userId', userIdtoEdit)
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

            const doc = list.documents[0];
            const docId = doc.$id;

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                docId,
                {
                    ...(name && { name }),
                    ...(email && { email }),
                    ...(labels && { labels }),
                }
            );

            return res.json({ message: 'User updated successfully' });
        } catch (err) {
            return res.status(500).json({ error: err.message || 'Failed to update user' });
        }
    });

    // 🔐 Reset user password
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

            const docId = list.documents[0].$id;

            await databases.updateDocument(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                docId,
                { status }
            );

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

            // Delete user in Appwrite users service
            await users.delete(userId);

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
                await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, docId);
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

    router.get('/transactions', authenticateAdmin, async (req, res) => {
        const { userId, qrId , limit = 25, cursor, from, to} = req.query;
        console.log('Fetching transactions with userId:', userId, 'qrId:', qrId, 'cursor:', cursor);
        console.log('Date filters:', { from, to });
        // Ensure limit is capped
        const limitNum = Math.min(parseInt(limit) || 25, 50);

        let filters = [];

        try {
            // Case 1: Both userId and qrId provided
            if (userId && qrId) {
                // Check if the qrId belongs to the user
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.includes(qrId)) {
                    filters.push(Query.equal('qrCodeId', qrId));
                } else {
                    console.log(`QR ID ${qrId} does not belong to user ${userId}`);
                    return res.status(200).json({ transactions: [] });
                }
            }
            // Case 2: Only qrId provided
            else if (qrId) {
                console.log('Fetching transactions for QR Code ID:', qrId);
                filters.push(Query.equal('qrCodeId', qrId));
            }
            // Case 3: Only userId provided
            else if (userId) {
                console.log('Fetching transactions for User ID:', userId);
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.length > 0) {
                    filters.push(Query.equal('qrCodeId', userQrIds));
                } else {
                    return res.status(200).json({ transactions: [] });
                }
            }

            // Helper: convert a date string (yyyy-mm-dd) into IST start/end of day ranges
            function toISTRange(dateStr) {
            const d = new Date(dateStr);

            // Start of IST day
            const start = new Date(d);
            start.setHours(0, 0, 0, 0);
            start.setMinutes(start.getMinutes() - 330); // shift -5:30 to UTC

            // End of IST day
            const end = new Date(d);
            end.setHours(23, 59, 59, 999);
            end.setMinutes(end.getMinutes() - 330); // shift -5:30 to UTC

            return { start, end };
            }

            // DATE FILTER CONDITIONS
            if (from && to) {
            if (from === to) {
                // Same date → only that IST day
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else {
                // Range → from start of 'from' IST day to end of 'to' IST day
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            }
            } else if (from && !to) {
                // Only 'from' → treat as single day filter
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else if (!from && to) {
                // Only 'to' → everything until end of that IST day
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual("created_at", end.toISOString()));
            }

            // Build query array
            const queries = [
                ...filters,
                Query.orderDesc('created_at'),
                Query.limit(limitNum) // smaller chunks for pagination
            ];

            // If a cursor was sent, use it for pagination
            if (cursor) {
                queries.push(Query.cursorAfter(cursor));
            }

            const transactions = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                webhook_collectionId,
                queries
            );

            const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({
                transactions: docs, // still newest first
                nextCursor
            });

        } catch (error) {
            console.error('Error fetching transactions:', error);
            res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    });

    router.get('/user/transactions', async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to} = req.query;
        console.log('🔍 [USER API] Fetching transactions for userId:', userId, 'qrId:', qrId, 'cursor:', cursor);
        console.log('🔍 [USER API] Date filters:', { from, to });
        // Ensure limit is capped
        const limitNum = Math.min(parseInt(limit) || 25, 50);

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        let filters = [];

        try {
            const userQrIds = await getQrIdsForUser(userId);

            // If qrId is provided, validate ownership
            if (qrId) {
                if (userQrIds.includes(qrId)) {
                    filters.push(Query.equal('qrCodeId', qrId));
                } else {
                    console.warn(`QR ID ${qrId} does not belong to user ${userId}`);
                    return res.status(200).json({ transactions: [] }); // Safe fallback
                }
            } else {
                // Get all transactions for all QR codes the user owns
                if (userQrIds.length === 0) {
                    return res.status(200).json({ transactions: [] });
                }
                filters.push(Query.equal('qrCodeId', userQrIds));
            }

            // Helper: convert a date string (yyyy-mm-dd) into IST start/end of day ranges
            function toISTRange(dateStr) {
            const d = new Date(dateStr);

            // Start of IST day
            const start = new Date(d);
            start.setHours(0, 0, 0, 0);
            start.setMinutes(start.getMinutes() - 330); // shift -5:30 to UTC

            // End of IST day
            const end = new Date(d);
            end.setHours(23, 59, 59, 999);
            end.setMinutes(end.getMinutes() - 330); // shift -5:30 to UTC

            return { start, end };
            }

            // DATE FILTER CONDITIONS
            if (from && to) {
            if (from === to) {
                // Same date → only that IST day
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else {
                // Range → from start of 'from' IST day to end of 'to' IST day
                const { start } = toISTRange(from);
                const { end } = toISTRange(to);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            }
            } else if (from && !to) {
                // Only 'from' → treat as single day filter
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else if (!from && to) {
                // Only 'to' → everything until end of that IST day
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual("created_at", end.toISOString()));
            }


            // Build query array
            const queries = [
                ...filters,
                Query.orderDesc('created_at'),
                Query.limit(limitNum) // smaller chunks for pagination
            ];

            // If a cursor was sent, use it for pagination
            if (cursor) {
                queries.push(Query.cursorAfter(cursor));
            }

            const transactions = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                webhook_collectionId,
                queries
            );
                
            const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;

            res.status(200).json({
                transactions: docs, // still newest first
                nextCursor
            });

        } catch (error) {
            console.error('❌ Error in /user/transactions:', error);
            res.status(500).json({ error: 'Failed to fetch user transactions' });
        }
    });
        

    router.get('/getMyMetaData', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId; // set by your JWT middleware

            console.log('getMyMetaData for userId:', userId);

            const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal('userId', userId)] // must be in an array
            );

            if (!result.documents.length) {
            return res.status(404).json({ error: 'User metadata not found 2' });
            }

            const doc = result.documents[0];

            console.log('getMyMetaData doc:', doc);

            // Optionally pick only safe fields
            const payload = {
            id: doc.userId,
            email: doc.email,
            name: doc.name,
            role: doc.role,
            parentId: doc.parentId,
            status: doc.status,
            labels: doc.labels,
            // childrenCount: doc.childrenCount, // if you added counter cache
            };

            console.log('getMyMetaData payload:', payload);

            return res.json(payload);
        } catch (err) {
            console.error('getMyMetaData error:', err);
            return res.status(500).json({ error: 'Failed to fetch metadata' });
        }
    });

    return router;
    
};
