const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SocksClient } = require('socks');
const app = express();

app.use(express.json());

const bots = new Map();
const CACHE_DIR = './auth_cache';

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const PROXIES = (process.env.PROXY_LIST || '').split(',').filter(p => p.trim());

function getRandomProxy() {
    if (PROXIES.length === 0) return null;
    return PROXIES[Math.floor(Math.random() * PROXIES.length)].trim();
}

function parseProxy(proxyString) {
    try {
        const url = new URL(proxyString);
        return {
            type: 5,
            host: url.hostname,
            port: parseInt(url.port) || 1080,
            userId: url.username || undefined,
            password: url.password || undefined
        };
    } catch {
        const [host, port] = proxyString.split(':');
        return { type: 5, host, port: parseInt(port) || 1080 };
    }
}

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

async function xboxToMinecraftJava(xboxToken) {
    try {
        console.log('🔄 Converting to JAVA token...');
        
        const xstsRes = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: { SandboxId: 'RETAIL', UserTokens: [xboxToken] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT'
        }, {
            headers: { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1' },
            validateStatus: () => true
        });
        
        if (xstsRes.status !== 200) {
            console.log('❌ XSTS failed');
            return null;
        }
        
        const xstsToken = xstsRes.data.Token;
        const userHash = xstsRes.data.DisplayClaims.xui[0].uhs;
        
        const mcRes = await axios.post(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
            { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
        );
        
        if (mcRes.status !== 200) {
            console.log('❌ MC auth failed');
            return null;
        }
        
        const profileRes = await axios.get(
            'https://api.minecraftservices.com/minecraft/profile',
            { headers: { 'Authorization': `Bearer ${mcRes.data.access_token}` }, validateStatus: () => true }
        );
        
        if (profileRes.status !== 200) {
            console.log('❌ No Java profile');
            return null;
        }
        
        console.log('✅ JAVA profile:', profileRes.data.name);
        
        return {
            accessToken: mcRes.data.access_token,
            profile: profileRes.data
        };
    } catch (err) {
        console.error('Token error:', err.message);
        return null;
    }
}

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) component.extra.forEach(e => text += extractText(e));
    return text;
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    try {
