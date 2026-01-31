const mc = require('minecraft-protocol');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();

function parseToken(tokenString) {
    const parts = tokenString.split(':');
    if (parts.length < 3) {
        throw new Error('Invalid format. Use: email:password:token');
    }
    
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
        if (parts.length !== 3) throw new Error('Invalid JWT');
        
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        throw new Error('JWT decode failed: ' + e.message);
    }
}

async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`[${botId}] Starting...`);
        const { email, password, accessToken } = parseToken(sessionToken);
        
        const tokenData = decodeJWT(accessToken);
        const mcProfile = tokenData.profiles?.mc || tokenData.pfd?.[0]?.id;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcName) throw new Error('No Minecraft username in token');
        
        console.log(`[${botId}] Account: ${mcName} (${mcProfile})`);
        console.log(`[${botId}] Connecting...`);
        
        // CRITICAL: Use minecraft-protocol with session injection
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            // Tell the server we're authenticated
            auth: 'microsoft',
            // Provide the session
            session: {
                accessToken: accessToken,
                clientToken: tokenData.xuid || tokenData.aid,
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            },
            // Don't validate with Microsoft (we already have token)
            skipValidation: true,
            version: false
        });
        
        client.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
        });
        
        client.on('kick_disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`❌ [${botId}] Kicked: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.error(`❌ [${botId}] Kicked: ${packet.reason}`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            console.log(`[${botId}] Disconnected`);
            bots.delete(botId);
        });
        
        client.on('end', () => {
            console.log(`[${botId}] Connection ended`);
            bots.delete(botId);
        });
        
        client.on('login', (packet) => {
            console.log(`✅ [${botId}] LOGGED IN AS ${mcName}!`);
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
                console.log(`[${botId}] ${text}`);
            } catch {}
        });
        
        bots.set(botId, { client, mcName, mcProfile });
        
        return {
            success: true,
            mcUsername: mcName,
            uuid: mcProfile
        };
        
    } catch (error) {
        console.error(`❌ [${botId}] Failed: ${error.message}`);
        throw error;
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

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        
        if (!username || !token) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing username or token' 
            });
        }
        
        if (bots.has(username)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bot already running' 
            });
        }
        
        const result = await createBot(username, host, port, token);
        
        res.json({ 
            success: true, 
            message: 'Bot started',
            ...result
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, error: 'Missing username' });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    bot.client.end('Stopped');
    bots.delete(username);
    
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) {
        return res.status(400).json({ success: false, error: 'Missing data' });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    bot.client.write('chat', { message });
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        connected: bot.client.socket && bot.client.socket.writable
    }));
    
    res.json({ 
        success: true,
        count: bots.size,
        bots: status 
    });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Bot Manager on port ${PORT}`);
});
