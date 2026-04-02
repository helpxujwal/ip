const dns = require('dns').promises;
const axios = require('axios');
const express = require('express');

// ==========================================
// CONFIGURATION (Loaded from Render Environment Variables)
// ==========================================
const DDNS_DOMAIN = process.env.DDNS_DOMAIN || 'ujwaljha.tplinkdns.com';
const SPHERAAA_API_KEY = process.env.SPHERAAA_API_KEY; 
const NAS_ID = process.env.NAS_ID; 
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Setup Web Server (Required by Render to keep the app alive)
const app = express();
const port = process.env.PORT || 3000;

let currentKnownIp = '0.0.0.0';

// ==========================================
// CORE LOGIC: Check IP and Update SpherAAA
// ==========================================
async function syncIpWithSpherAAA() {
    console.log(`\n[${new Date().toISOString()}] Starting IP Check...`);
    
    // 1. Safety Check: Ensure API keys are provided
    if (!SPHERAAA_API_KEY || !NAS_ID) {
        console.error("❌ ERROR: Missing SPHERAAA_API_KEY or NAS_ID in Environment Variables!");
        return;
    }

    let liveIp;

    // 2. Resolve the DDNS to get the real Om Telecom IP
    try {
        const { address } = await dns.lookup(DDNS_DOMAIN);
        liveIp = address;
        console.log(`🌐 DDNS Resolved: ${DDNS_DOMAIN} is currently at ${liveIp}`);
    } catch (error) {
        console.error(`⚠️ DNS Lookup Failed for ${DDNS_DOMAIN}. Retrying next cycle. Error:`, error.message);
        return; // Stop here and try again in 5 minutes
    }

    // 3. Compare with known IP
    if (liveIp === currentKnownIp) {
        console.log(`✅ IP has not changed (${liveIp}). No SpherAAA update required.`);
        return;
    }

    // 4. Update SpherAAA via API if IP has changed
    console.log(`🚨 IP CHANGE DETECTED! Updating SpherAAA from ${currentKnownIp} to ${liveIp}...`);
    
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
            console.log(`🎉 SUCCESS: SpherAAA NAS updated to ${liveIp}!`);
            currentKnownIp = liveIp; // Save the new IP so we don't spam the API
        } else {
            console.warn(`⚠️ SpherAAA returned an unexpected status: ${response.status}`);
        }

    } catch (error) {
        console.error("❌ API Update Failed!");
        if (error.response) {
            // SpherAAA rejected the request (e.g., bad API key, invalid ID)
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Message: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // SpherAAA server didn't respond (Network issue)
            console.error("   No response from SpherAAA servers (Network Timeout).");
        } else {
            // Script error
            console.error("   Error:", error.message);
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
    
    // Run the first check immediately
    syncIpWithSpherAAA();
    
    // Schedule all future checks
    setInterval(syncIpWithSpherAAA, CHECK_INTERVAL_MS);
});
