const dns = require('dns').promises;
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ==========================================
// CONFIGURATION (Loaded from Render Environment Variables)
// ==========================================
const DDNS_DOMAIN = process.env.DDNS_DOMAIN || 'ujwaljha.tplinkdns.com';
const SPHERAAA_API_KEY = process.env.SPHERAAA_API_KEY; 
const NAS_ID = process.env.NAS_ID; 
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Setup Web Server (Required by Render to keep the app alive)
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
    
    // Listen for /restart, /check, or /update commands
    bot.onText(/\/(restart|check|update)/, (msg) => {
        const chatId = msg.chat.id.toString();
        
        // Security check: Only respond to authorized chat ID
        if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) {
            bot.sendMessage(chatId, "⛔ Unauthorized access.");
            return;
        }
        
        bot.sendMessage(chatId, "🔄 Manual sync initiated. Checking IP...");
        syncIpWithSpherAAA(true); // Pass true for manual trigger
    });
}

// Helper function to log and send telegram messages
async function notify(message, isError = false) {
    if (isError) console.error(message);
    else console.log(message);
    
    if (bot && TELEGRAM_CHAT_ID) {
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, message);
        } catch (err) {
            console.error("Failed to send Telegram message:", err.message);
        }
    }
}

// ==========================================
// CORE LOGIC: Check IP and Update SpherAAA
// ==========================================
async function syncIpWithSpherAAA(manualTrigger = false) {
    console.log(`\n[${new Date().toISOString()}] Starting IP Check...`);
    
    // 1. Safety Check: Ensure API keys are provided
    if (!SPHERAAA_API_KEY || !NAS_ID) {
        await notify("❌ ERROR: Missing SPHERAAA_API_KEY or NAS_ID in Environment Variables!", true);
        return;
    }

    let liveIp;

    // 2. Resolve the DDNS to get the real Om Telecom IP
    try {
        const { address } = await dns.lookup(DDNS_DOMAIN);
        liveIp = address;
        console.log(`🌐 DDNS Resolved: ${DDNS_DOMAIN} is currently at ${liveIp}`);
    } catch (error) {
        await notify(`⚠️ DNS Lookup Failed for ${DDNS_DOMAIN}. Retrying next cycle. Error: ${error.message}`, true);
        return; // Stop here and try again in 5 minutes
    }

    // 3. Compare with known IP
    if (liveIp === currentKnownIp) {
        const msg = `✅ IP has not changed (${liveIp}). No SpherAAA update required.`;
        console.log(msg);
        if (manualTrigger) await notify(msg);
        return;
    }

    // 4. Update SpherAAA via API if IP has changed
    await notify(`🚨 IP CHANGE DETECTED!\nUpdating SpherAAA from ${currentKnownIp} to ${liveIp}...`);
    
    try {
        // SpherAAA API Endpoint for updating a specific NAS
        const apiUrl = `https://cloud.spheralogic.com/api/v1/nas/${NAS_ID}`;
        
        const response = await axios.put(apiUrl, {
            address: liveIp
        }, {
            headers: {
                'Authorization': `Bearer ${SPHERAAA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000 // 10 second timeout so the script doesn't hang
        });

        if (response.status === 200 || response.status === 204) {
            await notify(`🎉 SUCCESS: SpherAAA NAS updated to ${liveIp}!`);
            currentKnownIp = liveIp; // Save the new IP so we don't spam the API
        } else {
            await notify(`⚠️ SpherAAA returned an unexpected status: ${response.status}`, true);
        }

    } catch (error) {
        await notify("❌ API Update Failed!", true);
        if (error.response) {
            // SpherAAA rejected the request (e.g., bad API key, invalid ID)
            await notify(`   Status: ${error.response.status}\n   Message: ${JSON.stringify(error.response.data)}`, true);
        } else if (error.request) {
            // SpherAAA server didn't respond (Network issue)
            await notify("   No response from SpherAAA servers (Network Timeout).", true);
        } else {
            // Script error
            await notify(`   Error: ${error.message}`, true);
        }
    }
}

// ==========================================
// SERVER INITIALIZATION
// ==========================================

// Web route for Render health checks and UptimeRobot pings
app.get('/', (req, res) => {
    res.send({
        status: "Active",
        domainTracking: DDNS_DOMAIN,
        lastKnownIp: currentKnownIp,
        message: "SpherAAA Auto-Updater is running smoothly 🚀"
    });
});

app.listen(port, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 SpherAAA Auto-Updater Started!`);
    console.log(`📡 Tracking Domain: ${DDNS_DOMAIN}`);
    console.log(`⏱️  Check Interval: Every 5 minutes`);
    console.log(`=========================================\n`);
    
    notify(`🚀 Auto-Updater Started!\n📡 Tracking: ${DDNS_DOMAIN}\n⏱️ Interval: 5 mins`);
    
    // Run the first check immediately
    syncIpWithSpherAAA();
    
    // Schedule all future checks
    setInterval(syncIpWithSpherAAA, CHECK_INTERVAL_MS);
});
