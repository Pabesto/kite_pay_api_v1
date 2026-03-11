// configManager.js
let configCache = null;
let databasesInstance = null; // Store reference

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
                process.env.APPWRITE_DATABASE_ID || '688ca9f3003e593a6227', 
                '68a73217002ed987b246'
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
                    parsedValue = (doc.value === "true");
                } else if (doc.type === "json") {
                    parsedValue = JSON.parse(doc.value);
                } else {
                    parsedValue = doc.value;
                }
                config[doc.key] = parsedValue;
            }

            configCache = config;
            return config;
        } catch (err) {
            console.error("Error loading config:", err);
            return {};
        }
    }

    static get(key, defaultValue = null) {
        return configCache?.[key] ?? defaultValue;
    }

    static refresh() {
        configCache = null;
        return this.getConfig();
    }
}

module.exports = ConfigManager;
