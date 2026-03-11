const express = require('express');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

module.exports = (
    databases, storage, users, ID, Query,
    APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID,
    Qr_collectionId, webhook_collectionId, bucketId,
    authenticateToken, authenticateAdmin, authenticateAdminOrSubAdmin,
    InputFile, roleAuth, requireRole
) => {

    // Helper: IST date conversion
    function toISTRange(dateStr) {
        const d = new Date(dateStr);
        const start = new Date(d); start.setHours(0, 0, 0, 0); start.setMinutes(start.getMinutes() - 330);
        const end = new Date(d); end.setHours(23, 59, 59, 999); end.setMinutes(end.getMinutes() - 330);
        return { start, end };
    }

    // Helper: fetch user metadata
    async function getUserMeta(userId) {
        const result = await databases.listDocuments(
            APPWRITE_DATABASE_ID,
            APPWRITE_USERS_META_COLLECTION_ID,
            [Query.equal('userId', userId)]
        );
        return result.documents[0];
    }

    // Helper: get QR IDs for user
    async function getQrIdsForUser(userId) {
        try {
            const response = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal('assignedUserId', userId)]
            );
            return response.documents.map(doc => doc.qrId);
        } catch (error) {
            return [];
        }
    }

    // Helper: get QR IDs for subadmin
    async function getQrIdsForSubadmin(subadminId) {
        const qrIds = new Set();
        try {
            const createdQrs = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                Qr_collectionId,
                [Query.equal("createdByUserId", subadminId)]
            );
            createdQrs.documents.forEach(q => qrIds.add(q.qrId));
            const subadminAssignedQrs = await getQrIdsForUser(subadminId);
            subadminAssignedQrs.forEach(id => qrIds.add(id));
            const managedUsers = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                [Query.equal("parentId", subadminId)]
            );
            const managedUserIds = managedUsers.documents.map(u => u.userId);
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
            return [];
        }
    }

    // List users
    router.get('/users', authenticateAdminOrSubAdmin, async (req, res) => {
        try {
            const queries = [];
            if (req.user.role === 'subadmin') queries.push(Query.equal('parentId', req.user.userId));
            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                queries
            );
            const simplifiedUsers = result.documents.map(doc => ({
                $id: doc.userId, email: doc.email, name: doc.name,
                role: doc.role, parentId: doc.parentId, status: doc.status, labels: doc.labels,
            }));
            res.json(simplifiedUsers);
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch users' });
        }
    });

    // List subadmins
    router.get('/subadmins', authenticateAdmin, async (req, res) => {
        try {
            if (req.user.role !== 'admin') return res.status(403).json({ error: 'only admins can see sub-admins' });
            const queries = [Query.equal('role', 'subadmin')];
            if (req.query.search) queries.push(Query.search('name', req.query.search));
            const result = await databases.listDocuments(
                APPWRITE_DATABASE_ID,
                APPWRITE_USERS_META_COLLECTION_ID,
                queries
            );
            const simplifiedUsers = result.documents.map(doc => ({
                $id: doc.userId, email: doc.email, name: doc.name,
                role: doc.role, parentId: doc.parentId, status: doc.status, labels: doc.labels,
            }));
            res.json(simplifiedUsers);
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch sub-admins' });
        }
    });

    // Create user
    router.post('/create-user', authenticateAdminOrSubAdmin, async (req, res) => {
        let creatorId = req.user.userId;
        const { name, email, password, role } = req.body;
        if (role === 'admin') return res.status(400).json({ error: 'admin cant be created' });
        if (!name || !email || !password || !role) return res.status(400).json({ error: 'Name, Email, Password and Role are required' });
        if (req.user.role === 'subadmin' && role !== 'user') return res.status(403).json({ error: 'Sub-admins can only create users' });
        if (req.user.role === 'admin') creatorId = null;
        try {
            const response = await users.create(ID.unique(), email, undefined, password, name);
            await users.updateLabels(response.$id, [role]);
            const userId = response.$id;
            const payload = { userId, email: response.email, name: response.name, role, parentId: creatorId, status: true };
            try {
                await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId, payload);
            } catch (e) {
                if (e?.code === 409) {
                    await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId, payload);
                } else throw e;
            }
            res.status(201).json({ message: 'User created successfully', user: { $id: userId, email: response.email, name: response.name, role, parentId: creatorId } });
        } catch (err) {
            res.status(500).json({ error: err.message || 'User creation failed' });
        }
    });

    // Assign user to subadmin
    router.put('/assign-user/:subadminId', authenticateAdmin, async (req, res) => {
        const { subadminId } = req.params;
        const { userId, unassign = false } = req.body;
        if (!userId) return res.status(400).json({ message: 'userId is required' });
        if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden only admins can assign users to SUBADMINS' });
        try {
            const targetSubadmin = await databases.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, subadminId);
            if (targetSubadmin.role !== 'subadmin') return res.status(400).json({ message: 'Target is not a SUBADMIN' });
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, userId, { parentId: unassign ? null : subadminId });
            res.status(200).json({ message: 'Assignment updated.' });
        } catch (err) {
            res.status(500).json({ message: 'Failed to update assignment', error: err.message });
        }
    });

    // Edit user
    router.put('/edit-user/:id', authenticateAdminOrSubAdmin, async (req, res) => {
        const userIdtoEdit = req.params.id;
        const { name, email, labels } = req.body;
        if (!userIdtoEdit || (!name && !email && !labels)) return res.status(400).json({ error: 'User ID and at least one field (name or email or labels) are required' });
        try {
            const user = await users.get(userIdtoEdit);
            if (user.labels?.includes('admin')) return res.status(403).json({ error: 'Cannot edit admin users' });
            if (name) await users.updateName(userIdtoEdit, name);
            if (email) await users.updateEmail(userIdtoEdit, email);
            const doc = await getUserMeta(userIdtoEdit);
            if (!doc) return res.status(404).json({ error: 'User metadata document not found in users_mets' });
            if (req.user.role === 'subadmin' && doc.parentId !== req.user.userId) return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, doc.$id, { ...(name && { name }), ...(email && { email }), ...(labels && { labels }) });
            res.json({ message: 'User updated successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to update user' });
        }
    });

    // Reset password
    router.post('/reset-password/:id', authenticateAdminOrSubAdmin, async (req, res) => {
        const userId = req.params.id;
        const { password } = req.body;
        if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        try {
            const doc = await getUserMeta(userId);
            if (!doc) return res.status(404).json({ error: 'User metadata document not found in users_mets' });
            if (req.user.role === 'subadmin' && doc.parentId !== req.user.userId) return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
            const user = await users.get(userId);
            if (user.labels?.includes('admin')) return res.status(403).json({ error: 'Cannot reset password for admin users' });
            await users.updatePassword(userId, password);
            res.json({ message: 'Password reset successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to reset password' });
        }
    });

    // Update user status
    router.post('/update-user-status', authenticateAdminOrSubAdmin, async (req, res) => {
        const { userId, status } = req.body;
        if (!userId || typeof status !== 'boolean') return res.status(400).json({ error: 'Missing or invalid fields' });
        try {
            const user = await users.get(userId);
            if (user.labels.includes('admin')) return res.status(403).json({ error: 'Forbidden: Cannot change status of admin users' });
            await users.updateStatus(userId, status);
            const doc = await getUserMeta(userId);
            if (!doc) return res.status(404).json({ error: 'User metadata document not found in users_meta' });
            if (req.user.role === 'subadmin' && doc.parentId !== req.user.userId) return res.status(403).json({ error: 'Forbidden: Cannot edit users not assigned to you' });
            await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, doc.$id, { status });
            res.json({ success: true, status });
        } catch (err) {
            res.status(500).json({ error: 'Failed to update status' });
        }
    });

    // Delete user
    router.delete('/delete-user/:id', authenticateAdmin, async (req, res) => {
        const userId = req.params.id;
        if (!userId) return res.status(400).json({ error: 'Missing user ID' });
        try {
            const user = await users.get(userId);
            if (user.labels?.includes('admin')) return res.status(403).json({ error: 'Cannot delete admin users' });
            await users.delete(userId);
            const doc = await getUserMeta(userId);
            if (doc) await databases.deleteDocument(APPWRITE_DATABASE_ID, APPWRITE_USERS_META_COLLECTION_ID, doc.$id);
            res.status(200).json({ message: 'User deleted successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to delete user' });
        }
    });

    // Admin transactions
    router.get('/transactions', authenticateAdmin, async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 50);
        let filters = [];
        try {
            if (userId && qrId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.includes(qrId)) filters.push(Query.equal('qrCodeId', qrId));
                else return res.status(200).json({ transactions: [] });
            } else if (qrId) filters.push(Query.equal('qrCodeId', qrId));
            else if (userId) {
                const userQrIds = await getQrIdsForUser(userId);
                if (userQrIds.length > 0) filters.push(Query.equal('qrCodeId', userQrIds));
                else return res.status(200).json({ transactions: [] });
            }
            if (from && to) {
                const { start, end } = toISTRange(from === to ? from : from);
                filters.push(Query.between("created_at", start.toISOString(), toISTRange(to).end.toISOString()));
            } else if (from) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else if (to) {
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual("created_at", end.toISOString()));
            }
            const queries = [...filters, Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));
            const transactions = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);
            const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;
            res.status(200).json({ transactions: docs, nextCursor });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch transactions' });
        }
    });

    // User transactions
    router.get('/user/transactions', authenticateToken, async (req, res) => {
        const { userId, qrId, limit = 25, cursor, from, to } = req.query;
        const limitNum = Math.min(parseInt(limit) || 25, 50);
        const userRequested = req.user;
        const isSubadmin = userRequested.role === 'subadmin';
        if (!isSubadmin && userRequested.userId !== userId) return res.status(403).json({ error: 'Forbidden: Cannot access other users\' transactions' });
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        let filters = [];
        try {
            const userQrIds = isSubadmin ? await getQrIdsForSubadmin(userId) : await getQrIdsForUser(userId);
            if (qrId) {
                if (userQrIds.includes(qrId)) filters.push(Query.equal('qrCodeId', qrId));
                else return res.status(200).json({ transactions: [] });
            } else {
                if (userQrIds.length === 0) return res.status(200).json({ transactions: [] });
                filters.push(Query.equal('qrCodeId', userQrIds));
            }
            if (from && to) {
                const { start, end } = toISTRange(from === to ? from : from);
                filters.push(Query.between("created_at", start.toISOString(), toISTRange(to).end.toISOString()));
            } else if (from) {
                const { start, end } = toISTRange(from);
                filters.push(Query.between("created_at", start.toISOString(), end.toISOString()));
            } else if (to) {
                const { end } = toISTRange(to);
                filters.push(Query.lessThanEqual("created_at", end.toISOString()));
            }
            const queries = [...filters, Query.orderDesc('created_at'), Query.limit(limitNum)];
            if (cursor) queries.push(Query.cursorAfter(cursor));
            const transactions = await databases.listDocuments(APPWRITE_DATABASE_ID, webhook_collectionId, queries);
            const docs = transactions.documents;
            const nextCursor = docs.length === limitNum ? docs[docs.length - 1].$id : null;
            res.status(200).json({ transactions: docs, nextCursor });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch user transactions' });
        }
    });

    // Get my metadata
    router.get('/getMyMetaData', authenticateToken, async (req, res) => {
        try {
            const doc = await getUserMeta(req.user.userId);
            if (!doc) return res.status(404).json({ error: 'User metadata not found' });
            const payload = {
                id: doc.userId, email: doc.email, name: doc.name,
                role: doc.role, parentId: doc.parentId, status: doc.status, labels: doc.labels,
            };
            res.json(payload);
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch metadata' });
        }
    });

    return router;
};