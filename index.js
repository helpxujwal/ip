const dns = require('dns').promises;
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ==========================================
// CONFIGURATION 
// ==========================================
const DDNS_DOMAIN = process.env.DDNS_DOMAIN || 'ujwaljha.tplinkdns.com';

// SpherAAA OAuth2 Credentials
const SPHERAAA_CLIENT_ID = process.env.SPHERAAA_CLIENT_ID || 'ShopAdminApp'; 
const SPHERAAA_CLIENT_SECRET = process.env.SPHERAAA_CLIENT_SECRET || process.env.SPHERAAA_API_KEY; 

const RADIUS_SECRET = process.env.RADIUS_SECRET || 'Life!2025'; // Your router's secret password
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
const port = process.env.PORT || 3000;

let currentKnownIp = '0.0.0.0';

// ==========================================
// TELEGRAM BOT SETUP
// ==========================================
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram Bot initialized.");
    
    // THE FIX: This silences the harmless "409 Conflict" error during Render redeploys
    bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
            return; // Ignore silently
        }
        console.error("Telegram Polling Error:", error.message);
    });

    bot.onText(/\/(restart|check|update)/, (msg) => {
        const chatId = msg.chat.id.toString();
        if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) return;
        bot.sendMessage(chatId, "🔄 Manual sync initiated. Checking IP...");
        syncIpWithSpherAAA(true); 
    });
}

async function notify(message, isError = false) {
    if (isError) console.error(message);
    else console.log(message);
    if (bot && TELEGRAM_CHAT_ID) {
        try { await bot.sendMessage(TELEGRAM_CHAT_ID, message); } 
        catch (err) { /* Ignored to prevent crashes */ }
    }
}

// ==========================================
// CORE LOGIC: SpherAAA Official API Flow
// ==========================================
async function syncIpWithSpherAAA(manualTrigger = false) {
    console.log(`\n[${new Date().toISOString()}] Starting IP Check...`);
    
    if (!SPHERAAA_CLIENT_SECRET) {
        await notify("❌ ERROR: Missing SPHERAAA_CLIENT_SECRET in Environment Variables", true);
        return;
    }

    let liveIp;

    // 1. Check DDNS for current Om Telecom IP
    try {
        const { address } = await dns.lookup(DDNS_DOMAIN);
        liveIp = address;
        console.log(`🌐 DDNS Resolved: ${liveIp}`);
    } catch (error) {
        await notify(`⚠️ DNS Lookup Failed. Retrying later. Error: ${error.message}`, true);
        return;
    }

    if (liveIp === currentKnownIp && !manualTrigger) {
        console.log(`✅ IP has not changed (${liveIp}).`);
        return;
    }

    await notify(`🚨 IP CHANGE DETECTED!\nLogging in to SpherAAA to update to ${liveIp}...`);
    
    try {
        // ---> THE FIX: SpherAAA Strict OAuth2 Requirements <---
        let token;
        try {
            const payload = new URLSearchParams({
                'grant_type': 'client_credentials',
                'client_id': SPHERAAA_CLIENT_ID,
                'client_secret': SPHERAAA_CLIENT_SECRET,
                'scope': 'splc_nas:read splc_nas:write' // THE FIX: Exactly matching your dashboard scopes
            });
            
            // SpherAAA docs ask for Basic Auth Header as the primary auth method
            const authHeader = 'Basic ' + Buffer.from(SPHERAAA_CLIENT_ID + ':' + SPHERAAA_CLIENT_SECRET).toString('base64');

            const tokenResponse = await axios.post('https://cloud.spheralogic.com/api/token', payload.toString(), {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': authHeader
                },
                timeout: 10000
            });
            token = tokenResponse.data.access_token;
        } catch (loginError) {
            // Un-hid the error so SpherAAA tells us EXACTLY what is wrong if it fails
            const errorMsg = loginError.response ? JSON.stringify(loginError.response.data) : loginError.message;
            await notify(`❌ Auth Failed! SpherAAA responded with: ${errorMsg}`, true);
            return;
        }

        // Now inject the valid token into the headers
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        // 2. Fetch all current NAS entries from SpherAAA
        const listResponse = await axios.get(`https://cloud.spheralogic.com/api/nas/list`, { headers, timeout: 10000 });
        
        // 3. Delete old IPs (so we don't exceed the 4 NAS limit)
        if (Array.isArray(listResponse.data)) {
            for (let nas of listResponse.data) {
                if (nas.nasIpAddr && nas.nasIpAddr !== liveIp) {
                    try {
                        await axios.delete(`https://cloud.spheralogic.com/api/nas/${nas.nasIpAddr}`, { headers, timeout: 5000 });
                        console.log(`🗑️ Deleted old IP from SpherAAA: ${nas.nasIpAddr}`);
                    } catch (e) { console.log(`Failed to delete old IP: ${nas.nasIpAddr}`); }
                }
            }
        }

        // 4. Create the new NAS entry with the updated IP
        const payload = {
            "nasIpAddr": liveIp,
            "secret": RADIUS_SECRET,
            "dynPort": "3799",
            "note": "Auto-Updated via DDNS",
            "type": "AP",
            "env": "prod"
        };

        const addResponse = await axios.post(`https://cloud.spheralogic.com/api/nas/`, payload, { headers, timeout: 10000 });

        if (addResponse.status === 200 || addResponse.status === 201) {
            await notify(`🎉 SUCCESS: SpherAAA NAS updated to ${liveIp}!`);
            currentKnownIp = liveIp; 
        } else {
            await notify(`⚠️ SpherAAA returned an unexpected status: ${addResponse.status}`, true);
        }

    } catch (error) {
        await notify("❌ API Update Failed!", true);
        if (error.response) {
            await notify(`   Status: ${error.response.status}\n   Message: ${JSON.stringify(error.response.data)}`, true);
        } else {
            await notify(`   Error: ${error.message}`, true);
        }
    }
}

// ==========================================
// SERVER START
// ==========================================
app.get('/', (req, res) => res.send({ status: "Active", tracking: DDNS_DOMAIN, ip: currentKnownIp }));
app.listen(port, () => {
    notify(`🚀 Auto-Updater Started!\n📡 Tracking: ${DDNS_DOMAIN}\n⏱️ Interval: 5 mins`);
    syncIpWithSpherAAA();
    setInterval(syncIpWithSpherAAA, CHECK_INTERVAL_MS);
});
