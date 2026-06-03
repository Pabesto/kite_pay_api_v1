// configManager.js
let configCache = null;
let rawDocsCache = null; // Store raw docs for update operations
let databasesInstance = null; // Store reference
let CONFIG_DB_ID = null;
let CONFIG_COLLECTION_ID = null;

class ConfigManager {
    // ✅ Pass databases + collection refs once during init from server.js
    static init({ databases, APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID }) {
        databasesInstance = databases;
        CONFIG_DB_ID = APPWRITE_DATABASE_ID;
        CONFIG_COLLECTION_ID = APPWRITE_CONFIG_COLLECTION_ID;
        this.refresh(); // Load config immediately
    }

    static async getConfig() {
        if (configCache) return configCache;

        if (!databasesInstance) {
            throw new Error('ConfigManager not initialized. Call ConfigManager.init(databases) first.');
        }

        try {
            const docs = await databasesInstance.listDocuments(
                CONFIG_DB_ID,
                CONFIG_COLLECTION_ID
            );

            const config = {};
            for (let doc of docs.documents) {
                const rawValue = doc.val ?? String(doc.value ?? '');
                let parsedValue = rawValue;
                if (doc.type === "integer") {
                    parsedValue = parseInt(rawValue);
                } else if (doc.type === "double") {
                    parsedValue = parseFloat(rawValue);
                } else if (doc.type === "boolean") {
                    parsedValue = !["0", "false", "no", ""].includes(String(rawValue ?? '').toLowerCase());
                } else if (doc.type === "json") {
                    try {
                        parsedValue = JSON.parse(rawValue);
                    } catch (e) {
                        console.error(`Invalid JSON for config key "${doc.key}":`, e.message);
                        continue;
                    }
                } else if (doc.type === "array") {
                    try {
                        const arr = JSON.parse(rawValue);

                        if (!Array.isArray(arr)) {
                            throw new Error("Value is not an array");
                        }

                        parsedValue = arr.map(v => String(v));
                    } catch (e) {
                        console.error(
                            `Invalid array for config key "${doc.key}":`,
                            e.message
                        );
                        parsedValue = [];
                    }
                 } else {
                    parsedValue = rawValue;
                }
                config[doc.key] = parsedValue;
            }

            configCache = config;
            rawDocsCache = docs.documents;

            return config;


        } catch (err) {
            console.error("Error loading config:", err);
            return {};
        }
    }

    static get(key, defaultValue = null) {
        return configCache?.[key] ?? defaultValue;
    }

    static getRawDoc(key) {
        return rawDocsCache?.find(doc => doc.key === key) || null;
    }

    static getRawDocs() {
        return rawDocsCache || [];
    }

    static async set(key, value) {
        if (!databasesInstance) {
            throw new Error('ConfigManager not initialized.');
        }
        const doc = this.getRawDoc(key);

        const serialized =Array.isArray(value) || typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

        if (doc) {
            // await databasesInstance.updateDocument(CONFIG_DB_ID, CONFIG_COLLECTION_ID, doc.$id, { val: String(value) });
            await databasesInstance.updateDocument(
                CONFIG_DB_ID,
                CONFIG_COLLECTION_ID,
                doc.$id,
                { val: serialized }
            );
        } else {
            // await databasesInstance.createDocument(CONFIG_DB_ID, CONFIG_COLLECTION_ID, 'unique()', { key, val: String(value) });
            await databasesInstance.createDocument(
                CONFIG_DB_ID,
                CONFIG_COLLECTION_ID,
                'unique()',
                {
                    key,
                    val: serialized,
                }
            );
        }
        // Refresh cache so subsequent get() calls return updated value
        await this.refresh();
    }

    // static async migrateValueToVal() {
    //     if (!databasesInstance) {
    //         throw new Error('ConfigManager not initialized.');
    //     }
    //     const docs = await databasesInstance.listDocuments(CONFIG_DB_ID, CONFIG_COLLECTION_ID, []);
    //     let migrated = 0;
    //     for (let doc of docs.documents) {
    //         if (doc.val == null || doc.val === '') {
    //             await databasesInstance.updateDocument(CONFIG_DB_ID, CONFIG_COLLECTION_ID, doc.$id, { val: String(doc.value ?? '') });
    //             migrated++;
    //             console.log(`Migrated key "${doc.key}": value=${doc.value} → val="${String(doc.value ?? '')}"`);
    //         }
    //     }
    //     console.log(`Migration complete. ${migrated}/${docs.documents.length} docs migrated.`);
    //     return { migrated, total: docs.documents.length };
    // }

    static refresh() {
        console.log("Refreshing config cache...");
        configCache = null;
        rawDocsCache = null;
        return this.getConfig();
    }
}

module.exports = ConfigManager;
