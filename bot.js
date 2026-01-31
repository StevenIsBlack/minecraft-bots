const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const bots = new Map();

function parseToken(tokenString) {
    const parts = tokenString.split(':');
    if (parts.length < 3) throw new Error('Invalid format');
    return {
        email: parts[0],
        password: parts[1],
        accessToken: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        token = token.trim();
        const parts = token.split('.');
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (e) {
        throw new Error('JWT decode failed');
    }
}

// Convert Xbox token to Minecraft session token
async function xboxToMinecraft(xboxToken, xuid) {
    try {
        console.log('🔄 Converting Xbox token to Minecraft token...');
        
        // Step 1: Get XSTS token
        const xstsRes = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: {
                SandboxId: 'RETAIL',
                UserTokens: [xboxToken]
            },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT'
        }, {
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-xbl-contract-version': '1'
            },
            validateStatus: () => true
        });
        
        if (xstsRes.status !== 200) {
            console.log('❌ XSTS failed, using direct token');
            return null;
        }
        
        const xstsToken = xstsRes.data.Token;
        const userHash = xstsRes.data.DisplayClaims.xui[0].uhs;
        
        console.log('✅ Got XSTS token');
        
        // Step 2: Get Minecraft access token
        const mcRes = await axios.post(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
            { 
                headers: { 'Content-Type': 'application/json' },
                validateStatus: () => true
            }
        );
        
        if (mcRes.status !== 200) {
            console.log('❌ MC auth failed, using direct token');
            return null;
        }
        
        console.log('✅ Got Minecraft access token!');
        return mcRes.data.access_token;
        
    } catch (err) {
        console.error('Token conversion error:', err.message);
        return null;
    }
}

async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`[${botId}] Starting...`);
        const { email, password, accessToken } = parseToken(sessionToken);
        
        const tokenData = decodeJWT(accessToken);
        const mcProfile = tokenData.profiles?.mc || tokenData.pfd?.[0]?.id;
        const mcName = tokenData.pfd?.[0]?.name;
        const xuid = tokenData.xuid;
        
        if (!mcName) throw new Error('No username in token');
        
        console.log(`[${botId}] Account: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        
        // Try to convert Xbox token to MC token
        let finalToken = accessToken;
        const mcToken = await xboxToMinecraft(accessToken, xuid);
        if (mcToken) {
            console.log(`[${botId}] ✅ Using converted Minecraft token`);
            finalToken = mcToken;
        } else {
            console.log(`[${botId}] ⚠️ Using Xbox token directly`);
        }
        
        console.log(`[${botId}] Connecting...`);
        
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            auth: 'microsoft', // Tell server we're Microsoft auth
            session: {
                accessToken: finalToken,
                clientToken: xuid,
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            },
            skipValidation: true,
            version: false,
            hideErrors: false
        });
        
        client.on('connect', () => {
            console.log(`[${botId}] 🔌 Connected`);
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
        });
        
        client.on('kick_disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`[${botId}] 🚫 KICKED: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.error(`[${botId}] 🚫 KICKED: ${packet.reason}`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.log(`[${botId}] 🔌 DISCONNECT: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.log(`[${botId}] 🔌 DISCONNECT`);
            }
            bots.delete(botId);
        });
        
        client.on('end', (reason) => {
            console.log(`[${botId}] 🔌 Ended: ${reason || 'Unknown'}`);
            bots.delete(botId);
        });
        
        client.on('login', () => {
            console.log(`[${botId}] ✅✅✅ LOGGED IN! ✅✅✅`);
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED!`);
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                if (msg) console.log(`[${botId}] 💬 ${msg}`);
            } catch {}
        });
        
        bots.set(botId, { client, mcName });
        
        return { success: true, mcUsername: mcName, uuid: mcProfile };
        
    } catch (error) {
        console.error(`[${botId}] ❌ Failed: ${error.message}`);
        throw error;
    }
}

function extractText(c) {
    if (typeof c === 'string') return c;
    if (!c) return '';
    let text = c.text || '';
    if (c.extra) c.extra.forEach(e => text += extractText(e));
    return text;
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        if (!username || !token) return res.status(400).json({ success: false, error: 'Missing data' });
        if (bots.has(username)) return res.status(400).json({ success: false, error: 'Already running' });
        
        const result = await createBot(username, host, port, token);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.end();
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.write('chat', { message });
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        connected: bot.client.socket?.writable || false
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Running on ${PORT}`));
