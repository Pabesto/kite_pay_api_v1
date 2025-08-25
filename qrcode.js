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
  key_id: 'rzp_live_R9isOZf2f1NjPj',
  key_secret: 'oWoXAr0LHEN3jQGxOaMb1zgm',
});

// We will now pass the required dependencies and middleware from the main server file
module.exports = (databases, storage, users, ID, databaseId, Qr_collectionId, bucketId, authenticateAdmin, roleAuth, requireRole) => {
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

    async function assignQrToUser({qrId, assignedUserId }) {
        // Find the QR document by qrId
        const docResult = await databases.listDocuments(databaseId, Qr_collectionId, [
            Query.equal('qrId', qrId)
        ]);

        if (docResult.documents.length === 0) {
            throw new Error("QR Code not found");
        }

        const docId = docResult.documents[0].$id;

        // Update assignment
        await databases.updateDocument(
            databaseId,
            Qr_collectionId,
            docId,
            { assignedUserId: assignedUserId === '' ? null : assignedUserId }
        );

        return { success: true, docId };
    }

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

    async function saveQrEntry({
        qrId,
        fileId,
        imageUrl,
        createdAt,
        assignedUserId = null,
        }) {
        return await databases.createDocument(
            databaseId,
            Qr_collectionId,
            ID.unique(),
            {
            qrId,
            fileId,
            imageUrl,
            assignedUserId,
            isActive: true,
            createdAt,
            }
        );
    }

    // POST a new QR code entry
    // This is an admin-only endpoint
    router.post('/create-qr-entry', authenticateAdmin, async (req, res) => {
        const { qrId, fileId, imageUrl , createdAt } = req.body;

        if (!qrId || !fileId || !imageUrl) {
            return res.status(400).json({ message: "Missing required fields: qrId, fileId, or imageUrl." });
        }

        try {

            const newQrCode = await saveQrEntry({
                qrId,
                fileId,
                imageUrl,
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
            const result = await assignQrToUser({
            qrId,
            assignedUserId
        });

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
                totalTransactions : doc.totalTransactions || 0,
                totalPayInAmount : doc.totalPayInAmount || 0,
            }));

            res.status(200).json(userQrCodes);
        } catch (error) {
            console.error('Error fetching QR codes for user:', error);
            res.status(500).json({ message: 'Failed to fetch user QR codes.', error: error.message });
        }
    });


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
                databaseId,
                Qr_collectionId,
                [Query.equal('assignedUserId', userId)]
            );

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

    router.post("/create-qr/:userId", async (req, res) => {
        // console.log('Create QR request for userId:', req.params.userId);
        try {
            const { userId } = req.params;

            // console.log('Creating QR for userId:', userId);

            // Check limit before assigning
            const { hasFiveActive, activeCount } = await hasFiveActiveQRCodes(userId);

            if (hasFiveActive) {
                console.log("User already has ${activeCount} active QR codes. Cannot assign more.");
                return res.status(400).json({
                    message: `User already has ${activeCount} active QR codes. Cannot assign more.`
                });
            }

            // 1. Create QR in Razorpay
            const qr = await createRazorpayQr(userId);

            // 2. Download QR image
            const localPath = `/tmp/${qr.id}.png`;
            await downloadQrImage(qr.image_url, localPath);

            // 3. Save QR metadata in Appwrite (DB + Storage)
            await uploadQrToAppwrite(localPath, userId, qr);

            // 4. Assign QR to user using extracted method
            await assignQrToUser({
                qrId: qr.id,
                assignedUserId: userId
            });

            res.json({
                success: true,
                razorpayQrId: qr.id,
                // appwriteFileId: file.$id,
                // appwriteDocId: doc.$id,
                qrImageUrl: qr.image_url,
            });
        } catch (err) {
            console.error("Error creating QR:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post("/create-admin-qr/:userId", authenticateAdmin, async (req, res) => {
        // console.log('Create QR request for userId:', req.params.userId);
        try {
            const { userId } = req.params;

            // console.log('Creating QR for userId:', userId);

            // Check limit before assigning
            const { hasFiveActive, activeCount } = await hasFiveActiveQRCodes(userId);

            if (hasFiveActive) {
                console.log("User already has ${activeCount} active QR codes. Cannot assign more.");
                return res.status(400).json({
                    message: `User already has ${activeCount} active QR codes. Cannot assign more.`
                });
            }

            // 1. Create QR in Razorpay
            const qr = await createRazorpayQr(userId);

            // 2. Download QR image
            const localPath = `/tmp/${qr.id}.png`;
            await downloadQrImage(qr.image_url, localPath);

            // 3. Save QR metadata in Appwrite (DB + Storage)
            await uploadQrToAppwrite(localPath, userId, qr);

            // 4. Assign QR to user using extracted method
            await assignQrToUser({
                qrId: qr.id,
                assignedUserId: userId
            });

            res.json({
                success: true,
                razorpayQrId: qr.id,
                // appwriteFileId: file.$id,
                // appwriteDocId: doc.$id,
                qrImageUrl: qr.image_url,
            });
        } catch (err) {
            console.error("Error creating QR:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;

};