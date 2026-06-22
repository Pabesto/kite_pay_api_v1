// transactionStatusMailer.js — send a notification email via the Hostinger Email API
// whenever a transaction's status changes.

// const { sendMerchantHoldEmail } = require('./scripts/transactionStatusMailer');

// await sendMerchantHoldEmail({
//   posId: '9620581400',
//   paymentIds: ['pay_T21bBZi6AjlTgY', 'pay_T20WA3duDvizI5'],
//   // merchantName: 'Pabesto AI Private Limited',  // optional, this is the default
//   // to: 'merchant@x.com',                        // optional, defaults to STATUS_EMAIL_TO
// });

//
// This is a STANDALONE, self-contained helper. It does NOT hook into any of your
// existing routes/scripts. Use it in one of two ways:
//
//   1) Programmatically (recommended) — require it wherever you update a status:
//        const { sendTransactionStatusEmail } = require('./scripts/transactionStatusMailer');
//        // ...after you persist the new status...
//        sendTransactionStatusEmail({
//          transactionId: 'TXN123',
//          oldStatus: 'pending',
//          newStatus: 'success',
//          amount: 100,          // optional, in your usual unit (e.g. rupees or paise)
//          extra: { qrCodeId: 'QR9' }, // optional, rendered as key/value rows
//        }).catch(err => console.error('status email failed:', err.message));
//
//   2) From the CLI to verify your config sends a real email:
//        node scripts/transactionStatusMailer.js --test
//        node scripts/transactionStatusMailer.js --txn TXN123 --old pending --new success --amount 100
//        node scripts/transactionStatusMailer.js --test --to someone@else.com
//
// Required config (add to .env in the project root):
//   HOSTINGER_EMAIL_API_TOKEN     = <bearer token from Hostinger Panel > Emails > API tokens>  (REQUIRED)
//   STATUS_EMAIL_TO               = recipient@yourdomain.com   (the predefined recipient; REQUIRED)
//   HOSTINGER_MAILBOX_RESOURCE_ID = AC...    (OPTIONAL — auto-discovered via /api/v1/me when omitted)
//
// Docs: https://api.mail.hostinger.com  (Send: POST /api/v1/mailboxes/{id}/send, returns 204)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const axios = require('axios');

const HOSTINGER_API_BASE = 'https://api.mail.hostinger.com';
const REQUEST_TIMEOUT_MS = 15000;

const API_TOKEN = process.env.HOSTINGER_EMAIL_API_TOKEN;

// The predefined recipient. Set STATUS_EMAIL_TO in .env. You can still override
// per call via the `to` option, but normally every status email goes here.
const DEFAULT_RECIPIENT = process.env.STATUS_EMAIL_TO || '';

// Cached so we only resolve the mailbox once per process.
let cachedMailboxResourceId = process.env.HOSTINGER_MAILBOX_RESOURCE_ID || null;

function authHeaders() {
    if (!API_TOKEN) {
        throw new Error(
            'Missing HOSTINGER_EMAIL_API_TOKEN. Create an API token in the Hostinger Panel ' +
            '(Emails > API) and add it to .env.'
        );
    }
    return {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
    };
}

// Resolve which mailbox we send FROM. If HOSTINGER_MAILBOX_RESOURCE_ID isn't set,
// ask GET /api/v1/me and use the first mailbox the token can manage, then cache it.
async function resolveMailboxResourceId() {
    if (cachedMailboxResourceId) return cachedMailboxResourceId;

    const { data } = await axios.get(`${HOSTINGER_API_BASE}/api/v1/me`, {
        headers: authHeaders(),
        timeout: REQUEST_TIMEOUT_MS,
    });

    const mailboxes = (data && data.data && data.data.mailboxes) || [];
    if (!mailboxes.length) {
        throw new Error(
            'The API token has no manageable mailboxes. Check the token scope in the Hostinger Panel.'
        );
    }

    cachedMailboxResourceId = mailboxes[0].resourceId;
    console.log(`[mailer] using mailbox ${mailboxes[0].address} (${cachedMailboxResourceId})`);
    return cachedMailboxResourceId;
}

// Low-level send. Returns true on success (Hostinger replies 204 No Content).
async function sendEmail({ to, subject, text, html, cc, bcc, displayName, attachments } = {}) {
    const recipients = Array.isArray(to) ? to : (to ? [to] : []);
    if (!recipients.length && !cc && !bcc) {
        throw new Error('sendEmail: at least one recipient (to/cc/bcc) is required.');
    }
    if (!subject) throw new Error('sendEmail: subject is required.');

    const mailboxResourceId = await resolveMailboxResourceId();

    const body = { to: recipients };
    if (subject) body.subject = subject;
    if (text) body.text = text;
    if (html) body.html = html;
    if (cc) body.cc = Array.isArray(cc) ? cc : [cc];
    if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];
    if (displayName) body.displayName = displayName;
    if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;

    await axios.post(
        `${HOSTINGER_API_BASE}/api/v1/mailboxes/${encodeURIComponent(mailboxResourceId)}/send`,
        body,
        { headers: authHeaders(), timeout: REQUEST_TIMEOUT_MS }
    );

    return true;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Common image extensions -> MIME type for outgoing attachments.
const IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

// Read a local image file and turn it into a Hostinger attachment object.
// `image` may be a path string, or { path, inline, filename, contentType, cid }.
// inline (default true) links the image via Content-ID so it can be shown in the
// HTML body; inline:false makes it a regular downloadable attachment.
function buildImageAttachment(image) {
    const spec = typeof image === 'string' ? { path: image } : (image || {});
    const filePath = spec.path;
    if (!filePath) throw new Error('image: a file path is required.');
    if (!fs.existsSync(filePath)) throw new Error(`image not found: ${filePath}`);

    const ext = path.extname(filePath).toLowerCase();
    const contentType = spec.contentType || IMAGE_MIME[ext] || 'application/octet-stream';
    const filename = spec.filename || path.basename(filePath);
    const content = fs.readFileSync(filePath).toString('base64');
    const inline = spec.inline !== false; // default: inline
    const cid = inline ? (spec.cid || 'emailimage') : undefined;

    const attachment = { filename, content, contentType, encoding: 'base64' };
    if (cid) attachment.cid = cid;
    return { attachment, inline, cid };
}

// Build the email content for a status change and send it to the predefined recipient.
//
// Options:
//   transactionId  - id/reference of the transaction (string|number)   [recommended]
//   oldStatus      - previous status                                    [optional]
//   newStatus      - new status                                         [required]
//   amount         - amount to show in the email                        [optional]
//   currency       - label for the amount, default 'INR'                [optional]
//   extra          - plain object of extra rows to render               [optional]
//   to             - override the predefined recipient for this call    [optional]
//
// Returns true on success. Never throws synchronously for missing optional fields.
async function sendTransactionStatusEmail(opts = {}) {
    const {
        transactionId,
        oldStatus,
        newStatus,
        amount,
        currency = 'INR',
        extra = {},
        to,
    } = opts;

    if (!newStatus) throw new Error('sendTransactionStatusEmail: newStatus is required.');

    const recipient = to || DEFAULT_RECIPIENT;
    if (!recipient) {
        throw new Error(
            'No recipient configured. Set STATUS_EMAIL_TO in .env or pass { to } to sendTransactionStatusEmail().'
        );
    }

    const idLabel = transactionId != null ? String(transactionId) : '(unknown)';
    const transition = oldStatus ? `${oldStatus} → ${newStatus}` : String(newStatus);

    const subject = `Transaction ${idLabel} status: ${transition}`;

    // Rows shown in both the plain-text and HTML versions.
    const rows = [
        ['Transaction', idLabel],
        ['Previous status', oldStatus != null ? String(oldStatus) : '—'],
        ['New status', String(newStatus)],
    ];
    if (amount != null && amount !== '') rows.push(['Amount', `${amount} ${currency}`]);
    for (const [k, v] of Object.entries(extra || {})) {
        if (v != null && v !== '') rows.push([k, String(v)]);
    }
    rows.push(['Time', new Date().toISOString()]);

    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');

    const htmlRows = rows
        .map(
            ([k, v]) =>
                `<tr><td style="padding:6px 12px;color:#666;font-weight:600;">${escapeHtml(k)}</td>` +
                `<td style="padding:6px 12px;color:#111;">${escapeHtml(v)}</td></tr>`
        )
        .join('');
    const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">` +
        `<h2 style="margin:0 0 12px;">Transaction status changed</h2>` +
        `<table style="border-collapse:collapse;border:1px solid #eee;">${htmlRows}</table>` +
        `</div>`;

    await sendEmail({ to: recipient, subject, text, html });
    console.log(`[mailer] sent status email for ${idLabel} (${transition}) to ${recipient}`);
    return true;
}

// Send the "transactions temporarily on hold" compliance notice to the merchant.
//
// Options:
//   posId        - POS ID to show in the notice (string|number)        [required]
//   paymentIds   - array of payment ids, rendered as bullet points     [required]
//   merchantName - merchant display name                               [optional, has default]
//   vpa          - registered VPA, mentioned in the notice             [optional]
//   to           - override the predefined recipient for this call     [optional]
//   image        - local image file to attach. Path string, or
//                  { path, inline, filename, contentType }. inline (default true)
//                  shows it at the END of the email body; inline:false attaches it. [optional]
//
// Returns true on success.
async function sendMerchantHoldEmail(opts = {}) {
    const {
        posId,
        paymentIds = [],
        merchantName = 'Pabesto AI Private Limited',
        to,
        image,
    } = opts;

    if (!posId) throw new Error('sendMerchantHoldEmail: posId is required.');
    const ids = (Array.isArray(paymentIds) ? paymentIds : [paymentIds]).filter(Boolean);
    if (!ids.length) throw new Error('sendMerchantHoldEmail: at least one paymentId is required.');

    const recipient = to || DEFAULT_RECIPIENT;
    if (!recipient) {
        throw new Error(
            'No recipient configured. Set STATUS_EMAIL_TO in .env or pass { to } to sendMerchantHoldEmail().'
        );
    }

    const subject = `Transactions Temporarily On Hold for Review — POS ID ${posId}`;

    // ----- plain-text version (payment ids as "- " bullets) -----
    const text =
        `Dear Merchant,\n\n` +
        `Merchant Name: ${merchantName}\n\n` +
        `Greetings!\n\n` +
        `We are writing to inform you that transactions processed on your POS ID: ${posId} ` +
        `associated with the registered VPA, have been temporarily placed on hold due to suspicious ` +
        `activity detected during our ongoing risk assessment and compliance monitoring process.\n\n` +
        `Our records indicate that the following payment transactions received on the above-mentioned ` +
        `POS ID have been flagged for review:\n\n` +
        `Payment IDs:\n` +
        ids.map((id) => `  - ${id}`).join('\n') + `\n\n` +
        `As part of our regulatory obligations and internal risk management procedures, we are required ` +
        `to review certain transactions that have triggered risk alerts. Consequently, settlements ` +
        `related to these transactions may be temporarily withheld until the review is completed.\n\n` +
        `Please note that, in addition to the currently identified transaction(s), any related ` +
        `transactions connected to the ongoing review may also be subject to compliance monitoring and ` +
        `temporary settlement restrictions until the review process is concluded.\n\n` +
        `We request your cooperation in providing any information or documentation that may be required ` +
        `to facilitate the review process. Our team will reach out separately if additional details are ` +
        `needed.\n\n` +
        `Please note that this action has been taken to ensure compliance with applicable regulatory and ` +
        `banking guidelines and does not necessarily indicate any wrongdoing. The hold may remain in ` +
        `effect until the review is completed and all compliance requirements have been satisfactorily ` +
        `met.\n\n` +
        `If you have any questions or require assistance, please contact our support team and reference ` +
        `your ticket ID for faster resolution.\n\n` +
        `Thank you for your understanding and cooperation.\n\n` +
        `Sincerely,\n\n` +
        `Risk & Compliance Team`;

    // ----- HTML version (payment ids as a <ul> bullet list) -----
    const p = (s) => `<p style="margin:0 0 14px;">${s}</p>`;
    const bullets = ids.map((id) => `<li style="margin:2px 0;">${escapeHtml(id)}</li>`).join('');
    const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;">` +
        p(`Dear Merchant,`) +
        p(`<strong>Merchant Name:</strong> ${escapeHtml(merchantName)}`) +
        p(`Greetings!`) +
        p(`We are writing to inform you that transactions processed on your <strong>POS ID: ${escapeHtml(String(posId))}</strong> ` +
          `associated with the registered VPA, have been temporarily placed on hold due to suspicious activity ` +
          `detected during our ongoing risk assessment and compliance monitoring process.`) +
        p(`Our records indicate that the following payment transactions received on the above-mentioned POS ID ` +
          `have been flagged for review:`) +
        `<p style="margin:0 0 6px;"><strong>Payment IDs:</strong></p>` +
        `<ul style="margin:0 0 14px;padding-left:22px;">${bullets}</ul>` +
        p(`As part of our regulatory obligations and internal risk management procedures, we are required to ` +
          `review certain transactions that have triggered risk alerts. Consequently, settlements related to ` +
          `these transactions may be temporarily withheld until the review is completed.`) +
        p(`Please note that, in addition to the currently identified transaction(s), any related transactions ` +
          `connected to the ongoing review may also be subject to compliance monitoring and temporary settlement ` +
          `restrictions until the review process is concluded.`) +
        p(`We request your cooperation in providing any information or documentation that may be required to ` +
          `facilitate the review process. Our team will reach out separately if additional details are needed.`) +
        p(`Please note that this action has been taken to ensure compliance with applicable regulatory and ` +
          `banking guidelines and does not necessarily indicate any wrongdoing. The hold may remain in effect ` +
          `until the review is completed and all compliance requirements have been satisfactorily met.`) +
        p(`If you have any questions or require assistance, please contact our support team and reference your ` +
          `ticket ID for faster resolution.`) +
        p(`Thank you for your understanding and cooperation.`) +
        p(`Sincerely,<br/>Risk &amp; Compliance Team`) +
        `</div>`;

    // Optional image: attach it, and (when inline) render it at the END of the body.
    const attachments = [];
    let htmlBody = html;
    let textBody = text;
    if (image) {
        const { attachment, inline, cid } = buildImageAttachment(image);
        attachments.push(attachment);
        if (inline) {
            const imgTag =
                `<div style="margin-top:18px;">` +
                `<img src="cid:${cid}" alt="${escapeHtml(attachment.filename)}" ` +
                `style="max-width:100%;height:auto;display:block;"/></div>`;
            htmlBody = html.replace(/<\/div>\s*$/, `${imgTag}</div>`);
        } else {
            textBody = `${text}\n\n[Attached: ${attachment.filename}]`;
        }
    }

    await sendEmail({ to: recipient, subject, text: textBody, html: htmlBody, attachments });
    console.log(
        `[mailer] sent merchant hold email (POS ${posId}, ${ids.length} payment id(s)` +
        `${image ? ', +image' : ''}) to ${recipient}`
    );
    return true;
}

module.exports = { sendTransactionStatusEmail, sendMerchantHoldEmail, sendEmail, resolveMailboxResourceId };

// ----- CLI entry point: run this file directly to send a real test email -----
if (require.main === module) {
    const argv = process.argv.slice(2);
    const getFlag = (name) => {
        const i = argv.indexOf(`--${name}`);
        return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
    };

    const isTest = argv.includes('--test');

    // --- Merchant hold notice: node scripts/transactionStatusMailer.js --hold --pos 9620581400 --payments pay_a,pay_b ---
    if (argv.includes('--hold')) {
        const posId = getFlag('pos') || '9620581400';
        const paymentIds = (getFlag('payments') || 'pay_T21bBZi6AjlTgY,pay_T20WA3duDvizI5')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        // --image <path> embeds the image at the end of the body (inline).
        // Add --image-attach to send it as a plain downloadable attachment instead.
        const imagePath = getFlag('image') || process.env.STATUS_EMAIL_IMAGE || undefined;
        const image = imagePath
            ? { path: imagePath, inline: !argv.includes('--image-attach') }
            : undefined;

        sendMerchantHoldEmail({ posId, paymentIds, to: getFlag('to'), image })
            .then(() => {
                console.log('✅ Hold email sent.');
                process.exit(0);
            })
            .catch((err) => {
                const apiBody = err.response && err.response.data;
                console.error('❌ Failed to send hold email:', err.message || err);
                if (apiBody) console.error('   API response:', JSON.stringify(apiBody));
                process.exit(1);
            });
        return;
    }

    sendTransactionStatusEmail({
        transactionId: getFlag('txn') || (isTest ? `TEST-${Math.floor(Date.now() / 1000)}` : undefined),
        oldStatus: getFlag('old') || (isTest ? 'pending' : undefined),
        newStatus: getFlag('new') || (isTest ? 'success' : undefined),
        amount: getFlag('amount'),
        to: getFlag('to'),
    })
        .then(() => {
            console.log('✅ Email sent.');
            process.exit(0);
        })
        .catch((err) => {
            const apiBody = err.response && err.response.data;
            console.error('❌ Failed to send email:', err.message || err);
            if (apiBody) console.error('   API response:', JSON.stringify(apiBody));
            process.exit(1);
        });
}
