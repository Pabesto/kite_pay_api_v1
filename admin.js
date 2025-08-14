// -----------------------------------------------------------------------------------------------------
// routes/admin.js
// This file contains the API endpoints for user management.

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });


// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, Query, databaseId, Qr_collectionId, webhook_collectionId, bucketId, authenticateAdmin, InputFile, roleAuth, requireRole) => {

// router.use(roleAuth); // All routes will now have req.userMeta

    // 🔥 List all users
    router.get('/users', authenticateAdmin, async (req, res) => {
        try {
            const result = await users.list();

            const simplifiedUsers = result.users.map(user => ({
                $id: user.$id,
                email: user.email,
                name: user.name,
                status: user.status,
                labels: user.labels,
            }));

            return res.json(simplifiedUsers);
        } catch (err) {
            console.error('List users error:', err);
            return res.status(500).json({ error: 'Failed to fetch users' });
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
    router.post('/create-user', authenticateAdmin, async (req, res) => {
        const {name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, Email and password are required' });
        }

        try {
            const response = await users.create(
                ID.unique(),
                email,
                undefined,
                password,
                name
            );

            return res.status(201).json({
                message: 'User created successfully',
                user: {
                    $id: response.$id,
                    email: response.email,
                    name: response.name,
                },
            });
        } catch (err) {
            console.error('❌ Create user error:', err.message || err);
            return res.status(500).json({ error: err.message || 'User creation failed' });
        }
    });

    // ✏️ Edit user endpoint
    router.put('/edit-user/:id', authenticateAdmin, async (req, res) => {
        const userId = req.params.id;
        const { name, email, labels } = req.body;

        if (!userId || (!name && !email && !labels)) {
            return res.status(400).json({ error: 'User ID and at least one field (name or email or labels) are required' });
        }

        try {
            const user = await users.get(userId);

            if (user.labels?.includes('admin')) {
                return res.status(403).json({ error: 'Cannot edit admin users' });
            }

            if (name) await users.updateName(userId, name);
            if (email) await users.updateEmail(userId, email);
            if (labels) {
                if (!Array.isArray(labels)) {
                    return res.status(400).json({ error: 'Labels must be an array' });
                }
                await users.updateLabels(userId, labels);
            }

            return res.json({ message: 'User updated successfully' });
        } catch (err) {
            return res.status(500).json({ error: err.message || 'Failed to update user' });
        }
    });

    // 🔐 Reset user password
    router.post('/reset-password/:id', authenticateAdmin, async (req, res) => {
        const userId = req.params.id;
        const { password } = req.body;

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
    router.post('/update-user-status',authenticateAdmin, async (req, res) => {
        const { userId, status } = req.body;

        if (!userId || typeof status !== 'boolean') {
            return res.status(400).json({ error: 'Missing or invalid fields' });
        }

        try {
            const user = await users.get(userId);

            if (user.labels.includes('admin')) {
                return res.status(403).json({ error: 'Forbidden: Cannot change status of admin users' });
            }

            const result = await users.updateStatus(userId, status);
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

            await users.delete(userId);
            return res.status(200).json({ message: 'User deleted successfully' });
        } catch (err) {
            return res.status(500).json({ error: err.message || 'Failed to delete user' });
        }
    });
    
    // Helper to get QR IDs for a user
    async function getQrIdsForUser(userId) {
    try {
        const response = await databases.listDocuments(
        databaseId,
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
        const { userId, qrId , limit = 25, cursor} = req.query;
        console.log('Fetching transactions with userId:', userId, 'qrId:', qrId, 'cursor:', cursor);

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
                databaseId,
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
        const { userId, qrId, limit = 25, cursor} = req.query;
        console.log('🔍 [USER API] Fetching transactions for userId:', userId, 'qrId:', qrId, 'cursor:', cursor);

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
        
    return router;
    
};
