const { Resolver } = require('dns').promises;
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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // EXACTLY 5 MINUTES

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
    
    // Silences harmless Render restart conflicts
    bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) return;
        console.error("Telegram Polling Error:", error.message);
    });

    // Case-insensitive command listener
    bot.onText(/\/(restart|check|update)/i, (msg) => {
        console.log("📥 Received Telegram Command from:", msg.chat.id);
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

    // 1. Check DDNS (Bypassing Local Cache using Google & Cloudflare Root DNS)
    try {
        const resolver = new Resolver();
        resolver.setServers(['8.8.8.8', '1.1.1.1']); // Force Google and Cloudflare DNS
        
        const addresses = await resolver.resolve4(DDNS_DOMAIN);
        liveIp = addresses[0];
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
        let token;
        try {
            const payload = new URLSearchParams({
                'grant_type': 'client_credentials',
                'client_id': SPHERAAA_CLIENT_ID,
                'client_secret': SPHERAAA_CLIENT_SECRET,
                'scope': 'splc_nas:read splc_nas:write' 
            });
            
            const authHeader = 'Basic ' + Buffer.from(SPHERAAA_CLIENT_ID + ':' + SPHERAAA_CLIENT_SECRET).toString('base64');

            const tokenResponse = await axios.post('https://cloud.spheralogic.com/api/token', payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': authHeader },
                timeout: 10000
            });
            token = tokenResponse.data.access_token;
        } catch (loginError) {
            const errorMsg = loginError.response ? JSON.stringify(loginError.response.data) : loginError.message;
            await notify(`❌ Auth Failed! SpherAAA responded with: ${errorMsg}`, true);
            return;
        }

        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        // 2. Fetch all current NAS entries from SpherAAA
        const listResponse = await axios.get(`https://cloud.spheralogic.com/api/nas/list`, { headers, timeout: 10000 });
        let alreadyExists = false;

        // 3. Delete old IPs and handle the hidden /32 subnet mask perfectly
        if (Array.isArray(listResponse.data)) {
            for (let nas of listResponse.data) {
                let dbIp = nas.nasIpAddr || nas.ip_address || '';
                let cleanDbIp = dbIp.split('/')[0]; // Strips /32

                if (cleanDbIp === liveIp) {
                    alreadyExists = true; 
                } else if (dbIp) {
                    try {
                        const encodedIp = encodeURIComponent(dbIp);
                        await axios.delete(`https://cloud.spheralogic.com/api/nas/${encodedIp}`, { headers, timeout: 5000 });
                        console.log(`🗑️ Deleted old IP from SpherAAA: ${dbIp}`);
                    } catch (e) {}
                }
            }
        }

        // 4. Create the new NAS entry ONLY if it isn't already there
        if (!alreadyExists) {
            const payload = {
                "nasIpAddr": liveIp,
                "secret": RADIUS_SECRET,
                "dynPort": "3799",
                "note": "Auto-Updated via Cloud",
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
        } else {
            await notify(`✅ SpherAAA is already configured with ${liveIp}. System perfectly synced!`);
            currentKnownIp = liveIp; 
        }

    } catch (error) {
        // BULLETPROOF CATCHER: If SpherAAA somehow throws an overlap error, treat it as a success!
        const errorText = error.response ? JSON.stringify(error.response.data) : '';
        if (errorText.includes('overlaps with existing network')) {
            await notify(`✅ SpherAAA is already configured with ${liveIp}. System perfectly synced!`);
            currentKnownIp = liveIp;
            return;
        }

        await notify("❌ API Update Failed!", true);
        if (error.response) {
            await notify(`   Status: ${error.response.status}\n   Message: ${errorText}`, true);
        } else {
            await notify(`   Error: ${error.message}`, true);
        }
    }
}

// ==========================================
// SERVER START & KEEP ALIVE MECHANISM
// ==========================================
app.get('/', (req, res) => res.send({ status: "Active", tracking: DDNS_DOMAIN, ip: currentKnownIp }));

// Self-Ping mechanism to prevent Render from going to sleep
const RENDER_APP_URL = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;

app.listen(port, () => {
    notify(`🚀 Cloud Auto-Updater Started!\n📡 Tracking: ${DDNS_DOMAIN}\n⏱️ Interval: 5 Minutes`);
    syncIpWithSpherAAA();
    setInterval(syncIpWithSpherAAA, CHECK_INTERVAL_MS);
    
    // Built-in pinger: Hits its own URL every 10 minutes to stay awake
    if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_NAME) {
        setInterval(() => {
            axios.get(RENDER_APP_URL).catch(() => {});
        }, 10 * 60 * 1000);
    }
});
