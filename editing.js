            const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

            const dailySummariesPromises = qrCodes.map(qr =>
                databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_DAILY_QR_SUMMARIES_COLLECTION_ID, [
                    Query.equal('qrId', qr.qrId),
                    Query.equal('date', todayISO),
                    Query.limit(1),
                ])
            );

            const allSummaries = await Promise.all(dailySummariesPromises);

            const qrCodesWithTodayTotal = qrCodes.map((qr, index) => {
                const summaryDocs = allSummaries[index].documents;
                
                const todayTotalPayIn = summaryDocs.length > 0 ? summaryDocs[0].total_amount : 0;

                return {
                    ...qr,
                    todayTotalPayIn,
                };
            });