const dns = require('dns').promises;
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ==========================================
// CONFIGURATION 
// ==========================================
const DDNS_DOMAIN = process.env.DDNS_DOMAIN || 'ujwaljha.tplinkdns.com';
const SPHERAAA_API_KEY = process.env.SPHERAAA_API_KEY; 
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
        catch (err) { console.error("Telegram error:", err.message); }
    }
}

// ==========================================
// CORE LOGIC: SpherAAA Official API Flow
// ==========================================
async function syncIpWithSpherAAA(manualTrigger = false) {
    console.log(`\n[${new Date().toISOString()}] Starting IP Check...`);
    
    if (!SPHERAAA_API_KEY) {
        await notify("❌ ERROR: Missing SPHERAAA_API_KEY", true);
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

    await notify(`🚨 IP CHANGE DETECTED!\nSyncing SpherAAA to ${liveIp}...`);
    
    try {
        const headers = {
            'Authorization': `Bearer ${SPHERAAA_API_KEY}`,
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
