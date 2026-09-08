// configManager.js
const { Query } = require('node-appwrite');

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
            // Page the whole collection. A bare listDocuments() returns only Appwrite's
            // default 25 docs, which truncated both caches: getRawDoc() then returned null
            // for every key past #25, so set() and admin POST /config CREATED a second row
            // instead of updating the existing one (the payout_max_pending 100/200 dupes).
            const all = [];
            let cursor = null;
            for (let page = 0; page < 50; page++) {
                const q = [Query.limit(100), Query.orderAsc('$id')];
                if (cursor) q.push(Query.cursorAfter(cursor));
                const res = await databasesInstance.listDocuments(CONFIG_DB_ID, CONFIG_COLLECTION_ID, q);
                all.push(...res.documents);
                if (res.documents.length < 100) break;
                cursor = res.documents[res.documents.length - 1].$id;
            }

            // Collapse any duplicate keys already in the collection: newest $updatedAt wins.
            // Both caches must resolve to the SAME doc, otherwise get() reads one row while
            // set() writes to another — that is what made a saved value appear to not stick.
            const byKey = new Map();
            for (const doc of all) {
                const prev = byKey.get(doc.key);
                if (!prev || String(doc.$updatedAt || '') > String(prev.$updatedAt || '')) byKey.set(doc.key, doc);
            }
            if (byKey.size !== all.length) {
                const dupes = [...byKey.keys()].filter(k => all.filter(d => d.key === k).length > 1);
                console.warn(`[config] duplicate keys in config collection: ${dupes.join(', ')} — newest value used; run "node scripts/dedupe-config.js --write" to clean up`);
            }

            const config = {};
            for (let doc of byKey.values()) {
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
            rawDocsCache = [...byKey.values()];

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
        // Never trust the cache alone to decide create-vs-update: a miss here writes a
        // duplicate row that then shadows the real one. Confirm against the collection.
        let doc = this.getRawDoc(key);
        if (!doc) {
            const found = await databasesInstance.listDocuments(CONFIG_DB_ID, CONFIG_COLLECTION_ID, [
                Query.equal('key', key), Query.orderDesc('$updatedAt'), Query.limit(1),
            ]);
            doc = found.documents[0] || null;
        }

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
