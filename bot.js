const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) return null;
    
    return {
        email: parts[0],
        password: parts[1],
        token: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const profile = payload.pfd?.[0];
        return {
            username: profile?.name || 'Unknown',
            uuid: profile?.id || '00000000-0000-0000-0000-000000000000',
            xuid: payload.xuid
        };
    } catch (err) {
        return null;
    }
}

// Use the Xbox token to get a Minecraft token WITHOUT interactive auth
async function getMCTokenFromXbox(xboxToken, userHash) {
    try {
        console.log('Converting Xbox token to Minecraft token...');
        
        // First, get XSTS token
        const xstsRes = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: {
                SandboxId: 'RETAIL',
                UserTokens: [xboxToken]
            },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT'
        }, {
            headers: { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1' }
        }).catch(err => {
            console.log('XSTS request failed, using token directly');
            return null;
        });
        
        if (!xstsRes || xstsRes.status !== 200) {
            console.log('Could not get XSTS token, will try direct connection');
            return null;
        }
        
        const xstsToken = xstsRes.data.Token;
        const uhs = xstsRes.data.DisplayClaims.xui[0].uhs;
        
        // Get Minecraft token
        const mcRes = await axios.post(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            { identityToken: `XBL3.0 x=${uhs};${xstsToken}` },
            { headers: { 'Content-Type': 'application/json' } }
        ).catch(err => {
            console.log('Minecraft auth failed');
            return null;
        });
        
        if (!mcRes || mcRes.status !== 200) {
            return null;
        }
        
        console.log('✅ Got Minecraft access token!');
        return mcRes.data.access_token;
        
    } catch (err) {
        console.error('Token conversion error:', err.message);
        return null;
    }
}

async function startBot(account) {
    const creds = parseCredentials(account.credentials);
    if (!creds) {
        console.error('Invalid credentials format');
        return;
    }
    
    const info = decodeJWT(creds.token);
    if (!info) {
        console.error('Could not decode token');
        return;
    }
    
    console.log(`\n🤖 Starting: ${info.username} (${creds.email})`);
    account.username = info.username;
    
    try {
        // Try to get proper MC token
        const mcToken = await getMCTokenFromXbox(creds.token, info.xuid);
        
        // Create client with minimal auth
        const client = mc.createClient({
            host: SERVER,
            port: 25565,
            username: info.username,
            auth: 'offline', // Start offline, inject session manually
            version: false,
            skipValidation: true,
        });
        
        // Manually inject session if we got a token
        if (mcToken) {
            console.log('Injecting Minecraft token into session');
            client.session = {
                accessToken: mcToken,
                selectedProfile: {
                    id: info.uuid,
                    name: info.username
                }
            };
        } else {
            console.log('No MC token, using Xbox token directly');
            client.session = {
                accessToken: creds.token,
                selectedProfile: {
                    id: info.uuid,
                    name: info.username
                }
            };
        }
        
        account.online = false;
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        client.on('error', (err) => {
            console.error(`[${info.username}] ❌ Error: ${err.message}`);
        });
        
        client.on('kick_disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`[${info.username}] 🚫 Kicked: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.error(`[${info.username}] 🚫 Kicked: ${packet.reason}`);
            }
            account.online = false;
        });
        
        client.on('disconnect', (packet) => {
            console.log(`[${info.username}] Disconnected`);
            account.online = false;
        });
        
        client.on('end', () => {
            console.log(`[${info.username}] Connection ended`);
            account.online = false;
            bots.delete(info.username);
        });
        
        client.on('login', (packet) => {
            console.log(`[${info.username}] ✅ LOGGED IN!`);
            account.online = true;
        });
        
        client.on('chat', (packet) => {
            try {
                let text = '';
                if (typeof packet.message === 'string') {
                    const msg = JSON.parse(packet.message);
                    text = extractText(msg);
                } else {
                    text = extractText(packet.message);
                }
                
                if (!text || text.includes('discord.gg')) return;
                
                const name = parseName(text, info.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${info.username}] 📥 Queued: ${name} (Total: ${queue.length})`);
                }
            } catch (e) {}
        });
        
        setInterval(() => {
            if (!client.socket || !client.socket.writable) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = Math.random().toString(36).substring(7);
                
                try {
                    client.write('chat', {
                        message: `/msg ${target} discord.gg\\bills cheapest market ${random}`
                    });
                    console.log(`[${info.username}] 📨 Sent to: ${target} (Queue: ${queue.length})`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (err) {}
            }
        }, 100);
        
        bots.set(info.username, client);
        
    } catch (err) {
        console.error(`Failed to start bot: ${err.message}`);
        console.error(err.stack);
        account.online = false;
    }
}

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) {
        for (const extra of component.extra) {
            text += extractText(extra);
        }
    }
    return text;
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    let name = text.split(':')[0].trim();
    name = name.replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name.endsWith('+')) name = name.slice(0, -1);
    if (name === myName || name.length < 3) return null;
    return name;
}

app.get('/status', (req, res) => {
    const online = accounts.filter(a => a.online).length;
    res.json({ total: accounts.length, online });
});

app.post('/add', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });
        
        const creds = parseCredentials(token);
        if (!creds) {
            return res.status(400).json({ error: 'Invalid format' });
        }
        
        const acc = { credentials: token, username: 'Loading...', online: false };
        accounts.push(acc);
        
        startBot(acc);
        
        res.json({ status: 'starting' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/stopall', (req, res) => {
    bots.forEach(client => client.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    const list = accounts.map(a => ({
        username: a.username,
        online: a.online
    }));
    res.json({ accounts: list });
});

app.listen(PORT, () => {
    console.log(`🤖 Bot manager running on port ${PORT}`);
    console.log(`📡 Will connect to: ${SERVER}:25565`);
});
