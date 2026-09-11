// test-axis-worldline-webhook.js — poke POST /prod/axis-worldline-webhook and print what
// came back. Sends nothing to any bank; it only exercises OUR receiver.
//
//   node scripts/test-axis-worldline-webhook.js                       # plain §1.3.1 body → /uat (capture only)
//   node scripts/test-axis-worldline-webhook.js --mode encrypted      # AES-256-GCM envelope → /prod (LIVE: credits the QR whose qrId = mid!)
//   node scripts/test-axis-worldline-webhook.js --mode garbage        # forces a decrypt failure → /prod
//   node scripts/test-axis-worldline-webhook.js --mode all            # all three, in order
//
// /prod is the LIVE money path and refuses plaintext (400) — plain bodies go to /uat. An
// encrypted post against a real server with a registered mid WILL credit that QR.
//
//   --url  <base>        default AXIS_WL_TEST_URL, else http://localhost:3000
//   --sample upi|bqr     which decrypted sample to send (default upi, spec §1.3.1 / §1.3.3)
//   --encoding b64|hex|url   how to encode the encrypted string (default b64)
//
// The key comes from AXIS_WL_AES_KEY in the project .env (same var the server reads) and is
// never printed — only its byte length.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = (arg('url', 'https://kite-pay-api-v3.onrender.com/')).replace(/\/+$/, '');
const LIVE_URL = `${BASE}/prod/axis-worldline-webhook`;
const UAT_URL = `${BASE}/uat/axis-worldline-webhook`;
const MODE = arg('mode', 'plain');
const ENCODING = arg('encoding', 'b64');

// §1.3.1 UPI and §1.3.3 BQR card, verbatim from the spec. primary_id is made unique per run
// so a re-run is a fresh row instead of a dedup hit.
const SAMPLES = {
    upi: {
        bank_code: '00099', aggregator_id: 'EZETAP', time_stamp: '20231222002458',
        mid: '037111016290183', customer_vpa: 'kapilayush81@okbank', ref_no: '335601834589',
        txn_amount: '500.00', tr_id: 'AGU0009976378167EA2312211854E180008', transaction_type: '2',
        txn_currency: '356', merchant_vpa: 'mab.037111016290178@bank',
        secondary_id: '2312211854E180008', settlement_amount: '500.00',
        primary_id: 'AGU0009976378167EA2312211854E180008',
    },
    bqr: {
        bank_code: '00099', aggregator_id: 'PINLAB', mpan: '4604901037523736',
        time_stamp: '20231228154031', mid: '037244001370350', ref_no: '336215000718',
        txn_amount: '77611.00', transaction_type: '1', auth_code: '176005',
        consumer_pan: 'c5dd2d9a3afaf60ee34639f4082cc42b2b43e9aa53436867959dcc3661986f54',
        txn_currency: '356', secondary_id: '000000', settlement_amount: '0.00',
        primary_id: '27579509', customer_name: ' ',
    },
};

function sampleBody() {
    const base = SAMPLES[arg('sample', 'upi')];
    if (!base) { console.error('--sample must be upi or bqr'); process.exit(1); }
    return { ...base, primary_id: `${base.primary_id}-T${Date.now()}` };
}

// Same key parsing as axisWorldlineUat.js: 64 hex chars, base64, or 32 raw chars.
function loadKey() {
    const raw = (process.env.AXIS_WL_AES_KEY || '').trim();
    if (!raw) return null;
    return [
        /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null,
        Buffer.from(raw, 'base64'),
        Buffer.from(raw, 'utf8'),
    ].find((b) => b && b.length === 32) || null;
}

// Mirrors Java AES/GCM/NoPadding on the bank's side: IV(16) || ciphertext || tag(16).
function encrypt(obj, key) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
    const buf = Buffer.concat([iv, out]);
    if (ENCODING === 'hex') return buf.toString('hex');
    if (ENCODING === 'url') return encodeURIComponent(buf.toString('base64'));
    return buf.toString('base64');
}

async function send(label, body, url = LIVE_URL) {
    console.log(`\n──────── ${label} ────────`);
    console.log('POST', url);
    console.log('body:', JSON.stringify(body).slice(0, 300) + (JSON.stringify(body).length > 300 ? '…' : ''));
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`→ ${res.status} ${text}`);
        return res.status;
    } catch (e) {
        console.error('→ request failed:', e?.message || e);
        return null;
    }
}

(async () => {
    const key = loadKey();
    console.log(`live     : ${LIVE_URL}`);
    console.log(`uat      : ${UAT_URL}`);
    console.log(`key      : ${key ? `loaded (${key.length} bytes)` : 'NOT CONFIGURED — set AXIS_WL_AES_KEY in .env'}`);
    console.log(`encoding : ${ENCODING}`);

    const modes = MODE === 'all' ? ['plain', 'encrypted', 'garbage'] : [MODE];
    for (const mode of modes) {
        if (mode === 'plain') {
            await send('PLAIN (decrypted-shape body → UAT capture only)', sampleBody(), UAT_URL);
        } else if (mode === 'encrypted') {
            if (!key) { console.error('\nSkipping encrypted: AXIS_WL_AES_KEY is missing or not 32 bytes.'); continue; }
            await send('ENCRYPTED (AES-256-GCM, IV+ciphertext+tag → LIVE)', { data: encrypt(sampleBody(), key) });
        } else if (mode === 'garbage') {
            await send('GARBAGE (must log DECRYPTION FAILED, still SUCCESS)', {
                data: crypto.randomBytes(96).toString('base64'),
            });
        } else {
            console.error(`Unknown --mode ${mode} (use plain | encrypted | garbage | all)`);
            process.exit(1);
        }
    }

    console.log('\nNow check the server log for:');
    console.log('  📩 received / body      — the request arrived at all');
    console.log('  🔓 decrypted OK         — key + format are right');
    console.log('  🔐 DECRYPTION FAILED    — full diagnostics (raw string, sizes, key length)');
    console.log(`Rejected/UAT rows: GET ${BASE}/uat/axis-worldline-webhook/captures  (admin auth)`);
})();
