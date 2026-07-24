// migrate-company-names-to-json.js — convert the `company_names` config from a
// JSON array of company names to a JSON object { "<company name>": "<email>" },
// and flip the config doc's `type` from "array" to "json".
//
// Sample emails (`<slug>@example.com`) are filled in for every company so the map
// is complete for now — replace them with real recipients via the config editor
// / PUT /api/admin/config later. example.com is a reserved placeholder domain, so
// the temp addresses are obviously not real.
//
// Idempotent: re-running preserves any real emails already set and only fills the
// blanks/missing ones with a temp sample. Safe to run repeatedly.
//
// Usage (from project root so .env loads):
//   node scripts/migrate-company-names-to-json.js            # DRY RUN — prints the before/after
//   node scripts/migrate-company-names-to-json.js --write    # apply the change
//   node scripts/migrate-company-names-to-json.js --write --overwrite-samples
//                                                            # also reset NON-empty emails to temp samples

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Databases, Query } = require('node-appwrite');

const DRY_RUN = !process.argv.includes('--write');
const OVERWRITE_SAMPLES = process.argv.includes('--overwrite-samples');
const CONFIG_KEY = 'company_names';

const {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID,
    APPWRITE_CONFIG_COLLECTION_ID,
} = process.env;

for (const [name, val] of Object.entries({
    APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
    APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID,
})) {
    if (!val) {
        console.error(`Missing required env var: ${name}. Run from project root so .env loads.`);
        process.exit(1);
    }
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function sampleEmail(name) {
    return `${slug(name) || 'company'}@example.com`;
}

async function main() {
    console.log(`\nMigrate config "${CONFIG_KEY}" array -> json — ${DRY_RUN ? 'DRY RUN' : 'WRITE'}` +
        `${OVERWRITE_SAMPLES ? ' (overwrite-samples)' : ''}\n`);

    // 1) Find the config doc by business key (never assume key === $id).
    const found = await db.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID,
        [Query.equal('key', CONFIG_KEY), Query.limit(1)]);
    if (!found.documents.length) {
        console.error(`Config key "${CONFIG_KEY}" not found — nothing to migrate.`);
        process.exit(1);
    }
    const doc = found.documents[0];
    const rawVal = doc.val ?? String(doc.value ?? '');

    let parsed;
    try {
        parsed = JSON.parse(rawVal || '[]');
    } catch (e) {
        console.error(`Current val is not valid JSON — aborting. val=${rawVal}`);
        process.exit(1);
    }

    // 2) Normalize current state into { name: email }.
    //    - array (legacy): names only, no emails yet.
    //    - object (already migrated / partial): keep existing emails.
    let currentMap;
    if (Array.isArray(parsed)) {
        console.log(`Current: array of ${parsed.length} name(s), type="${doc.type}"`);
        currentMap = Object.fromEntries(parsed.map((n) => [String(n), '']));
    } else if (parsed && typeof parsed === 'object') {
        console.log(`Current: object of ${Object.keys(parsed).length} entr(ies), type="${doc.type}" (already object-shaped)`);
        currentMap = { ...parsed };
    } else {
        console.error(`Current val is neither an array nor an object — aborting. val=${rawVal}`);
        process.exit(1);
    }

    // 3) Fill emails: blanks (and, with --overwrite-samples, non-blanks) get a temp sample.
    const nextMap = {};
    let filled = 0, kept = 0;
    for (const [name, email] of Object.entries(currentMap)) {
        const hasReal = typeof email === 'string' && email.trim() !== '';
        if (hasReal && !OVERWRITE_SAMPLES) {
            nextMap[name] = email;
            kept++;
        } else {
            nextMap[name] = sampleEmail(name);
            filled++;
        }
    }

    // 4) Show the plan.
    console.log(`\nType:  "${doc.type}" -> "json"`);
    console.log(`Emails: ${filled} sample(s) filled, ${kept} existing kept\n`);
    for (const [name, email] of Object.entries(nextMap)) {
        console.log(`  ${email.endsWith('@example.com') ? '[sample]' : '[kept]  '} ${name}  ->  ${email}`);
    }

    const nextVal = JSON.stringify(nextMap);
    const alreadyDone = doc.type === 'json' && rawVal === nextVal;
    if (alreadyDone) {
        console.log('\nAlready up to date — no change needed.');
        return;
    }

    if (DRY_RUN) {
        console.log('\nDRY RUN — no write. Re-run with --write to apply.');
        return;
    }

    // 5) Apply: flip type + val together (mirrors PUT /api/admin/config).
    await db.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_CONFIG_COLLECTION_ID, doc.$id, {
        type: 'json',
        val: nextVal,
    });
    console.log(`\n✅ Updated config "${CONFIG_KEY}" (type=json, ${Object.keys(nextMap).length} companies).`);
    console.log('   Replace the [sample] emails with real recipients via the config editor when ready.');
}

main().catch((err) => {
    console.error('Migration failed:', err.message || err);
    process.exit(1);
});
