const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const bots = new Map();

// Token analyzer
function analyzeToken(input) {
    const parts = input.split(':');
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 TOKEN ANALYSIS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Parts: ${parts.length}`);
    console.log(`Part 1 (email): ${parts[0]}`);
    console.log(`Part 2 (password): ${parts[1]?.substring(0, 3)}***`);
    console.log(`Part 3 (token): ${parts[2]?.substring(0, 20)}...`);
    console.log(`Token length: ${parts[2]?.length || 0}`);
    
    // Check if it's a JWT
    const token = parts[2];
    if (token && token.includes('.')) {
        const tokenParts = token.split('.');
        console.log(`Token format: JWT-like (${tokenParts.length} parts)`);
        
        try {
            // Decode JWT
            let payload = tokenParts[1];
            while (payload.length % 4 !== 0) payload += '=';
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
            
            console.log('📋 Decoded JWT:');
            console.log(JSON.stringify(decoded, null, 2));
            
            return {
                type: 'jwt',
                email: parts[0],
                password: parts[1],
                token: token,
                decoded: decoded
            };
        } catch (e) {
            console.log('⚠️ Failed to decode as JWT:', e.message);
        }
    }
    
    // Check if it's a simple bearer token
    if (token && !token.includes('.')) {
        console.log('Token format: Bearer/Simple token');
        return {
            type: 'bearer',
            email: parts[0],
            password: parts[1],
            token: token
        };
    }
    
    return null;
}

// Method 1: Direct minecraft-protocol with session injection
async function tryMethod1(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 1: Direct protocol + session injection`);
    
    try {
        const { decoded, token } = authData;
        const mcName = decoded.pfd?.[0]?.name || decoded.name || authData.email.split('@')[0];
        const mcUuid = decoded.pfd?.[0]?.id || decoded.sub || crypto.randomUUID();
        
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            accessToken: token,
            clientToken: decoded.xuid || decoded.aid || mcUuid,
            skipValidation: true,
            version: false
        });
        
        return { client, mcName };
    } catch (e) {
        console.error(`[${botId}] ❌ Method 1 failed:`, e.message);
        throw e;
    }
}

// Method 2: Mineflayer offline mode
async function tryMethod2(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 2: Offline mode`);
    
    try {
        const { decoded } = authData;
        const mcName = decoded.pfd?.[0]?.name || decoded.name || authData.email.split('@')[0];
        
        const client = mineflayer.createBot({
            host: host,
            port: port,
            username: mcName,
            auth: 'offline',
            version: false
        });
        
        return { client, mcName };
    } catch (e) {
        console.error(`[${botId}] ❌ Method 2 failed:`, e.message);
        throw e;
    }
}

// Method 3: Custom auth with token as password
async function tryMethod3(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 3: Token as username`);
    
    try {
        const client = mc.createClient({
            host: host,
            port: port,
            username: authData.token,
            skipValidation: true,
            version: false
        });
        
        return { client, mcName: authData.token.substring(0, 16) };
    } catch (e) {
        console.error(`[${botId}] ❌ Method 3 failed:`, e.message);
        throw e;
    }
}

// Method 4: Raw protocol with custom auth server
async function tryMethod4(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 4: Custom auth server (TheAltening-style)`);
    
    try {
        const { decoded, token } = authData;
        const mcName = decoded.pfd?.[0]?.name || decoded.name || authData.email.split('@')[0];
        
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            accessToken: token,
            auth: 'mojang',
            skipValidation: true,
            version: false,
            sessionServer: 'https://sessionserver.mojang.com',
            // Try using token as-is
        });
        
        return { client, mcName };
    } catch (e) {
        console.error(`[${botId}] ❌ Method 4 failed:`, e.message);
        throw e;
    }
}

// Method 5: HTTP-based auth (custom authentication server)
async function tryMethod5(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 5: HTTP-based custom auth`);
    
    try {
        const { token, email, decoded } = authData;
        
        // Try to validate token with Mojang/Microsoft
        const authResponse = await axios.post('https://api.minecraftservices.com/minecraft/profile', {}, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            validateStatus: () => true
        });
        
        console.log(`Auth response status: ${authResponse.status}`);
        
        if (authResponse.status === 200) {
            const profile = authResponse.data;
            console.log('✅ Got profile:', profile);
            
            const client = mc.createClient({
                host: host,
                port: port,
                username: profile.name,
                accessToken: token,
                clientToken: profile.id,
                skipValidation: true,
                version: false
            });
            
            return { client, mcName: profile.name };
        } else {
            throw new Error(`Auth failed with status ${authResponse.status}`);
        }
    } catch (e) {
        console.error(`[${botId}] ❌ Method 5 failed:`, e.message);
        throw e;
    }
}

// Method 6: Email/Password only (ignore token)
async function tryMethod6(botId, host, port, authData) {
    console.log(`[${botId}] 🔧 METHOD 6: Email/Password auth (ignore token)`);
    
    try {
        const client = mineflayer.createBot({
            host: host,
            port: port,
            username: authData.email,
            password: authData.password,
            auth: 'microsoft',
            version: false
        });
        
        return { client, mcName: authData.email };
    } catch (e) {
        console.error(`[${botId}] ❌ Method 6 failed:`, e.message);
        throw e;
    }
}

// Try all methods sequentially
async function tryAllMethods(botId, host, port, credentials) {
    console.log(`[${botId}] 🚀 Starting multi-method authentication...`);
    
    const authData = analyzeToken(credentials);
    if (!authData) {
        throw new Error('Failed to parse credentials');
    }
    
    const methods = [
        { name: 'Direct Protocol', fn: tryMethod1 },
        { name: 'Offline Mode', fn: tryMethod2 },
        { name: 'Token Username', fn: tryMethod3 },
        { name: 'Custom Auth Server', fn: tryMethod4 },
        { name: 'HTTP Auth', fn: tryMethod5 },
        { name: 'Email/Password', fn: tryMethod6 }
    ];
    
    for (const method of methods) {
        try {
            console.log(`\n[${botId}] 🔄 Trying: ${method.name}`);
            const result = await method.fn(botId, host, port, authData);
            
            if (result && result.client) {
                console.log(`[${botId}] ✅ ${method.name} WORKED!`);
                setupBot(botId, result.client, result.mcName);
                return result;
            }
        } catch (e) {
            console.log(`[${botId}] ❌ ${method.name} failed, trying next...`);
            continue;
        }
    }
    
    throw new Error('All authentication methods failed');
}

function setupBot(botId, client, mcName) {
    const botData = {
        client,
        mcUsername: mcName,
        isOnline: false
    };
    
    client.on('connect', () => {
        console.log(`[${botId}] 🔌 Connected`);
    });
    
    client.on('login', () => {
        console.log(`[${botId}] ✅ LOGGED IN as ${mcName}!`);
        botData.isOnline = true;
    });
    
    client.on('spawn', () => {
        console.log(`[${botId}] 🎮 SPAWNED!`);
    });
    
    client.on('kick_disconnect', (packet) => {
        try {
            const reason = JSON.parse(packet.reason);
            console.error(`[${botId}] 🚫 KICKED: ${JSON.stringify(reason)}`);
        } catch {
            console.error(`[${botId}] 🚫 KICKED`);
        }
    });
    
    client.on('disconnect', (packet) => {
        console.log(`[${botId}] 🔌 Disconnected`);
    });
    
    client.on('error', (err) => {
        console.error(`[${botId}] ❌ ${err.message}`);
    });
    
    bots.set(botId, botData);
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        if (!username || !token) return res.status(400).json({ success: false, error: 'Missing data' });
        
        const result = await tryAllMethods(username, host, port, token);
        res.json({ success: true, mcUsername: result.mcName });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/stopall', (req, res) => {
    const count = bots.size;
    bots.forEach((bot) => { try { bot.client.end(); } catch {} });
    bots.clear();
    res.json({ success: true, stopped: count });
});

app.get('/status', (req, res) => {
    const online = Array.from(bots.values()).filter(b => b.isOnline).length;
    res.json({ success: true, total: bots.size, online });
});

app.listen(8080, () => {
    console.log('✅ Multi-Auth Bot System Running on 8080');
    console.log('🔬 Will try 6 different authentication methods');
});
