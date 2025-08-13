// -----------------------------------------------------------------------------------------------------
// routes/qrcode.js
// This file contains the API endpoints for QR code management.

const express = require('express');
const { ID, Query } = require('node-appwrite');

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, databaseId, Qr_collectionId, bucketId, authenticateAdmin, roleAuth, requireRole) => {
    const router = express.Router();

    // GET all QR codes
    // This is a public endpoint
    router.get('/qr-codes', authenticateAdmin, async (req, res) => {
        try {
            // const result = await databases.listDocuments(databaseId, Qr_collectionId);

            const result = await databases.listDocuments(databaseId, Qr_collectionId, // Transactions collection
                [
                    Query.orderDesc('createdAt'), // Add this line to sort descending by date
                    Query.limit(100) // Limits the results to 10 documents
                ]
            );

            const qrCodes = result.documents.map(doc => ({
                qrId: doc.qrId,
                fileId: doc.fileId,
                imageUrl: doc.imageUrl,
                assignedUserId: doc.assignedUserId || null,
                createdAt: doc.createdAt,
                isActive: doc.isActive,
                totalTransactions : doc.totalTransactions || 0,
                totalPayInAmount : doc.totalPayInAmount || 0,
            }));

            res.status(200).json(qrCodes.reverse());// Reverse the order to show the most recent first

        } catch (error) {
            console.error('Error fetching QR codes:', error);
            res.status(500).json({ message: "Failed to fetch QR codes.", error: error.message });
        }
    });

    // POST a new QR code entry
    // This is an admin-only endpoint
    router.post('/create-qr-entry', authenticateAdmin, async (req, res) => {
        const { qrId, fileId, imageUrl , createdAt } = req.body;

        if (!qrId || !fileId || !imageUrl) {
            return res.status(400).json({ message: "Missing required fields: qrId, fileId, or imageUrl." });
        }

        try {
            const newQrCode = await databases.createDocument(
                databaseId,
                Qr_collectionId,
                ID.unique(),
                {
                    qrId,
                    fileId,
                    imageUrl,
                    assignedUserId: null,
                    isActive: true,
                    createdAt: createdAt
                }
            );

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
            const docResult = await databases.listDocuments(databaseId, Qr_collectionId, [
                Query.equal('qrId', qrId)
            ]);
            
            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: "QR Code not found." });
            }

            const doc = docResult.documents[0];
            const fileId = doc.fileId;
            const docId = doc.$id;

            await storage.deleteFile(bucketId, fileId);
            await databases.deleteDocument(databaseId, Qr_collectionId, docId);

            res.status(200).json({ message: "QR Code and file deleted successfully." });
        } catch (error) {
            console.error('Error deleting QR code:', error);
            res.status(500).json({ message: "Failed to delete QR code.", error: error.message });
        }
    });

    // PUT to toggle the isActive status
    // This is an admin-only endpoint
    router.put('/toggle-qr-status/:qrId', authenticateAdmin, async (req, res) => {
        const { qrId } = req.params;
        const { isActive } = req.body;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: "Invalid value for 'isActive'." });
        }

        try {
            const docResult = await databases.listDocuments(databaseId, Qr_collectionId, [
                Query.equal('qrId', qrId)
            ]);

            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: "QR Code not found." });
            }

            const docId = docResult.documents[0].$id;

            await databases.updateDocument(
                databaseId,
                Qr_collectionId,
                docId,
                { isActive }
            );

            res.status(200).json({ message: "QR Code status updated successfully." });
        } catch (error) {
            console.error('Error toggling QR code status:', error);
            res.status(500).json({ message: "Failed to update QR code status.", error: error.message });
        }
    });

    // PUT to assign a user to a QR code
    // This is an admin-only endpoint
    // MODIFIED: Endpoint to assign or unlink a user from a QR code
    router.put('/assign-qr/:qrId', authenticateAdmin, async (req, res) => {
        const { qrId } = req.params;
        const { assignedUserId } = req.body; // assignedUserId can now be null or a string

        try {
            const docResult = await databases.listDocuments(databaseId, Qr_collectionId, [
                Query.equal('qrId', qrId)
            ]);

            if (docResult.documents.length === 0) {
                return res.status(404).json({ message: "QR Code not found." });
            }

            const docId = docResult.documents[0].$id;
            
            // If assignedUserId is null or empty, this will correctly clear the field in Appwrite
            // otherwise, it will update the field with the new userId.
            await databases.updateDocument(
                databaseId,
                Qr_collectionId,
                docId,
                { assignedUserId: assignedUserId === '' ? null : assignedUserId }
            );

            res.status(200).json({ message: "User assignment updated successfully." });
        } catch (error) {
            console.error('Error updating user assignment for QR code:', error);
            res.status(500).json({ message: "Failed to update user assignment.", error: error.message });
        }
    });
    
    router.get('/qr-codes/user/:userId', async (req, res) => {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ message: 'Missing userId parameter' });
        }

        try {
            const response = await databases.listDocuments(
                databaseId,
                Qr_collectionId,
                [Query.equal('assignedUserId', userId)]
            );

            const userQrCodes = response.documents.map(doc => ({
                qrId: doc.qrId,
                fileId: doc.fileId,
                imageUrl: doc.imageUrl,
                assignedUserId: doc.assignedUserId || null,
                createdAt: doc.createdAt,
                isActive: doc.isActive,
            }));

            res.status(200).json(userQrCodes);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
        }
    });


    return router;
};