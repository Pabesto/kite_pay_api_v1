// PUT /assign-qr-manager/:qrId
router.put('/assign-qr-manager/:qrId', authenticateAdminOrSubAdmin, async (req, res) => {
  const { qrId } = req.params;
  const { managedByUserId, assignedUserId } = req.body; // assignedUserId optional
  const actor = req.user;

  try {
    // Admin-only ownership change
    if (actor.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can change managedByUserId.' });
    }

    const qrDocs = await databases.listDocuments(APPWRITE_DATABASE_ID, Qr_collectionId, [
      Query.equal('qrId', qrId),
      Query.limit(1),
    ]);
    if (!qrDocs.documents.length) return res.status(404).json({ message: 'QR Code not found.' });

    const qr = qrDocs.documents[0];
    const prevAssigned = qr.assignedUserId || null;

    if (!managedByUserId) {
      return res.status(400).json({ message: 'managedByUserId is required.' });
    }

    // Validate manager exists and role if needed
    const manager = await getUser(managedByUserId);
    if (!manager) return res.status(400).json({ message: 'Manager not found.' });
    // Optional: enforce manager.role in { 'merchant', 'subadmin' }

    // Normalize optional assignee
    const normalizedAssigned = assignedUserId === '' ? null : assignedUserId ?? null;

    // Build payload with policy:
    // - If an explicit assignee is provided, use it (must be under the new manager)
    // - Else if current ASSIGNED is null, default-assign to the manager
    // - Else leave ASSIGNED as-is
    const payload = {
      managedByUserId,
      ...(normalizedAssigned !== null
        ? { assignedUserId: normalizedAssigned }
        : (!qr.assignedUserId ? { assignedUserId: managedByUserId } : {})),
    };

    // If an explicit user assignee is set, validate hierarchy with new manager
    if (payload.assignedUserId && payload.assignedUserId !== managedByUserId) {
      const assignee = await getUser(payload.assignedUserId);
      if (!assignee) return res.status(400).json({ message: 'Assignee not found.' });
      if (assignee.parentId !== managedByUserId) {
        return res.status(409).json({ message: 'Assignee not under new manager.' });
      }
    }

    const updated = await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      Qr_collectionId,
      qr.$id,
      payload
    );

    // Counters: adjust on assigned state changes only
    const newAssigned = updated.assignedUserId || null;
    if (!prevAssigned && newAssigned) {
      await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', 1).catch(console.error);
    } else if (prevAssigned && !newAssigned) {
      await updateDashboardCounter(databases, APPWRITE_DATABASE_ID, 'totalQrsAssignedToMerchant', -1).catch(console.error);
    }

    return res.status(200).json({ message: 'Manager updated.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Failed to update manager.', error: e.message });
  }
});
