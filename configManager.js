// configManager.js
let configCache = null;
let rawDocsCache = null; // Store raw docs for update operations
let databasesInstance = null; // Store reference
const CONFIG_DB_ID = '688ca9f3003e593a6227';
const CONFIG_COLLECTION_ID = '68a73217002ed987b246';

class ConfigManager {
    // ✅ Pass databases once during init
    static init(databases) {
        databasesInstance = databases;
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
                // console.log(`Loading config key: ${doc.key} with value: ${doc.value} and type: ${doc.type}`);
                let parsedValue = doc.value;
                if (doc.type === "integer") {
                    parsedValue = parseInt(doc.value);
                } else if (doc.type === "double") {
                    parsedValue = parseFloat(doc.value);
                } else if (doc.type === "boolean") {
                    parsedValue = !["0", "false", "no", ""].includes(String(doc.value ?? '').toLowerCase());
                } else if (doc.type === "json") {
                    try {
                        parsedValue = JSON.parse(doc.value);
                    } catch (e) {
                        console.error(`Invalid JSON for config key "${doc.key}":`, e.message);
                        continue;
                    }
                } else {
                    parsedValue = doc.value;
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

    static async set(key, value) {
        if (!databasesInstance) {
            throw new Error('ConfigManager not initialized.');
        }
        const doc = this.getRawDoc(key);
        if (doc) {
            await databasesInstance.updateDocument(CONFIG_DB_ID, CONFIG_COLLECTION_ID, doc.$id, { value: String(value) });
        } else {
            await databasesInstance.createDocument(CONFIG_DB_ID, CONFIG_COLLECTION_ID, 'unique()', { key, value: String(value) });
        }
        // Refresh cache so subsequent get() calls return updated value
        await this.refresh();
    }

    static refresh() {
        console.log("Refreshing config cache...");
        configCache = null;
        rawDocsCache = null;
        return this.getConfig();
    }
}

module.exports = ConfigManager;
