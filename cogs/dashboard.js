const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const logs = require('./logs.js');

const HTML_FILE = path.join(__dirname, '../index.html');
const DEFAULT_CLIENT_ID = "1546817538149711922";

// أوامر ما تنعرض بالموقع (للمالك فقط)
const HIDDEN_COMMANDS = new Set(['i', 'itzf188', 'sync', 'spy', 'invite-bot', 'clone-channels', 'clone-template']);
const OWNER_TAG = /owner only|خاص بالمالك|للمالك/i;

const sessions = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const rate = new Map();

let botClient = null;
let SECRET = null;
let commandsCache = { data: null, ts: 0 };

// ───────────────────────── أدوات ─────────────────────────

const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k !== name) continue;
        const val = rest.join('=');
        const i = val.lastIndexOf('.');
        if (i < 0) return null;
        const v = val.slice(0, i), s = val.slice(i + 1);
        if (safeEqual(s, sign(v))) return v;
    }
    return null;
}

function cookie(name, value, { maxAge, secure }) {
    return `${name}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function getBaseUrl(req) {
    if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL.replace(/\/+$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
}

function getSession(req) {
    const sid = readCookie(req, 'sid');
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s || s.expires < Date.now()) { sessions.delete(sid); return null; }
    return s;
}

function createSession(user, guilds) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { user, guilds, expires: Date.now() + SESSION_TTL });
    return sid;
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        ...headers
    });
    res.end(body);
}

function json(res, status, obj) {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function redirect(res, location, cookies = []) {
    const h = { Location: location };
    if (cookies.length) h['Set-Cookie'] = cookies;
    send(res, 302, '', h);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > 100 * 1024) { reject(new Error('too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function limited(req) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const now = Date.now();
    const r = rate.get(ip) || { count: 0, reset: now + 60000 };
    if (now > r.reset) { r.count = 0; r.reset = now + 60000; }
    r.count++;
    rate.set(ip, r);
    return r.count > 120;
}

const iconUrl = (id, icon) => (icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.png` : null);

// ───────────────────────── الأوامر (للصفحة العامة) ─────────────────────────

function categoryOf(name) {
    if (/raid|top|roblox|country|avatar/.test(name)) return '⚔️ الرايدات والتوبات';
    if (/badword|automod|mod_channel|mod-channel/.test(name)) return '🛡️ الحماية';
    if (/^(warn|clear_warnings|ban|unban|kick|timeout|untimeout|mute|unmute|clear)$/.test(name)) return '🔨 الإدارة';
    if (/welcome|leave|boost/.test(name)) return '👋 الترحيب والمغادرة والبوست';
    if (/ticket/.test(name)) return '🎫 التكت';
    if (/activity/.test(name)) return '📊 النشاط';
    if (/backup|restore/.test(name)) return '💾 النسخ الاحتياطي';
    if (/name_clan|color_emed/.test(name)) return '⚔️ الرايدات والتوبات';
    return '✨ أوامر أخرى';
}

async function getCommands() {
    if (commandsCache.data && Date.now() - commandsCache.ts < 5 * 60 * 1000) return commandsCache.data;
    const fetched = await botClient.application.commands.fetch();
    const list = [...fetched.values()]
        .filter(c => !HIDDEN_COMMANDS.has(c.name) && !OWNER_TAG.test(c.description || ''))
        .map(c => ({
            name: c.name,
            description: c.description || '',
            adminOnly: c.defaultMemberPermissions !== null && c.defaultMemberPermissions !== undefined,
            category: categoryOf(c.name),
            options: (c.options || []).map(o => ({ name: o.name, description: o.description || '', required: !!o.required }))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    commandsCache = { data: list, ts: Date.now() };
    return list;
}

// ───────────────────────── الصلاحيات ─────────────────────────

const P_ADMIN = 0x8n, P_MANAGE_GUILD = 0x20n;

function manageableGuilds(session) {
    return (session.guilds || []).filter(g => {
        const perms = BigInt(g.permissions || 0);
        return g.owner || (perms & P_ADMIN) === P_ADMIN || (perms & P_MANAGE_GUILD) === P_MANAGE_GUILD;
    });
}

// تحقق حي من الصلاحية عن طريق البوت (مو بس من جلسة تسجيل الدخول)
async function authGuild(session, gid) {
    const guild = botClient.guilds.cache.get(gid);
    if (!guild) return { status: 404, error: 'البوت مو موجود بهذا السيرفر. أضفه أول.' };

    const member = await guild.members.fetch(session.user.id).catch(() => null);
    const allowed = guild.ownerId === session.user.id ||
        (member && (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)));
    if (!allowed) return { status: 403, error: 'ما عندك صلاحية إدارة هذا السيرفر.' };
    return { guild };
}

// ───────────────────────── الخادم ─────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const secure = getBaseUrl(req).startsWith('https');

    // الصفحة
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        try {
            const html = fs.readFileSync(HTML_FILE, 'utf8');
            send(res, 200, html, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'"
            });
        } catch (e) {
            send(res, 500, 'index.html مفقود بجذر المشروع', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        return;
    }

    if (p === '/healthz') { send(res, 200, 'ok'); return; }

    // تسجيل الدخول
    if (req.method === 'GET' && p === '/login') {
        if (!process.env.CLIENT_SECRET) {
            send(res, 503, 'تسجيل الدخول غير مفعّل: ضع CLIENT_SECRET بمتغيرات البيئة.', { 'Content-Type': 'text/plain; charset=utf-8' });
            return;
        }
        const state = crypto.randomBytes(16).toString('hex');
        const authUrl = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
            client_id: process.env.CLIENT_ID || botClient.user?.id || DEFAULT_CLIENT_ID,
            redirect_uri: `${getBaseUrl(req)}/callback`,
            response_type: 'code',
            scope: 'identify guilds',
            state,
            prompt: 'none'
        });
        redirect(res, authUrl, [cookie('oauth_state', state, { maxAge: 600, secure })]);
        return;
    }

    if (req.method === 'GET' && p === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const saved = readCookie(req, 'oauth_state');
        if (!code || !state || !saved || state !== saved) {
            send(res, 400, 'طلب تسجيل دخول غير صالح. ارجع جرّب مرة ثانية.', { 'Content-Type': 'text/plain; charset=utf-8' });
            return;
        }
        try {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: process.env.CLIENT_ID || botClient.user?.id || DEFAULT_CLIENT_ID,
                    client_secret: process.env.CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: `${getBaseUrl(req)}/callback`
                })
            });
            if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
            const token = await tokenRes.json();

            const headers = { Authorization: `Bearer ${token.access_token}` };
            const [uRes, gRes] = await Promise.all([
                fetch('https://discord.com/api/users/@me', { headers }),
                fetch('https://discord.com/api/users/@me/guilds', { headers })
            ]);
            if (!uRes.ok || !gRes.ok) throw new Error('فشل جلب بيانات الحساب');
            const u = await uRes.json();
            const g = await gRes.json();

            const sid = createSession(
                { id: u.id, username: u.username, globalName: u.global_name || null, avatar: u.avatar || null },
                g.map(x => ({ id: x.id, name: x.name, icon: x.icon, owner: x.owner, permissions: x.permissions }))
            );
            redirect(res, '/#/dashboard', [
                cookie('sid', sid, { maxAge: SESSION_TTL / 1000, secure }),
                cookie('oauth_state', 'x', { maxAge: 0, secure })
            ]);
        } catch (e) {
            console.error('خطأ تسجيل الدخول:', e.message);
            send(res, 500, 'فشل تسجيل الدخول: تأكد من CLIENT_SECRET ورابط الرجوع (Redirect) بإعدادات التطبيق.', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        return;
    }

    if (p === '/logout') {
        const sid = readCookie(req, 'sid');
        if (sid) sessions.delete(sid);
        redirect(res, '/', [cookie('sid', 'x', { maxAge: 0, secure })]);
        return;
    }

    // ───── API ─────
    if (p.startsWith('/api/')) {
        if (limited(req)) { json(res, 429, { error: 'طلبات كثيرة، انتظر شوي.' }); return; }

        if (req.method === 'GET' && p === '/api/stats') {
            const guilds = botClient.guilds.cache;
            json(res, 200, {
                guilds: guilds.size,
                members: [...guilds.values()].reduce((a, g) => a + (g.memberCount || 0), 0),
                bot: { name: botClient.user?.username || 'Bot', avatar: botClient.user?.displayAvatarURL?.() || null }
            });
            return;
        }

        if (req.method === 'GET' && p === '/api/commands') {
            try { json(res, 200, { commands: await getCommands() }); }
            catch (e) { json(res, 500, { error: 'تعذر جلب الأوامر.' }); }
            return;
        }

        const session = getSession(req);

        if (req.method === 'GET' && p === '/api/me') {
            if (!session) { json(res, 200, { loggedIn: false, loginEnabled: !!process.env.CLIENT_SECRET }); return; }
            json(res, 200, {
                loggedIn: true,
                user: session.user,
                guilds: manageableGuilds(session).map(g => ({
                    id: g.id, name: g.name, icon: iconUrl(g.id, g.icon), botIn: botClient.guilds.cache.has(g.id)
                }))
            });
            return;
        }

        const m = p.match(/^\/api\/guild\/(\d{15,25})(\/logs|\/test)?$/);
        if (m) {
            if (!session) { json(res, 401, { error: 'سجّل دخول أول.' }); return; }
            if (req.method === 'POST' && req.headers['x-requested-with'] !== 'dashboard') {
                json(res, 403, { error: 'طلب مرفوض.' });
                return;
            }

            const auth = await authGuild(session, m[1]);
            if (auth.error) { json(res, auth.status, { error: auth.error }); return; }
            const guild = auth.guild;

            // معلومات السيرفر + الرومات + الإعدادات
            if (req.method === 'GET' && !m[2]) {
                await guild.channels.fetch().catch(() => null);
                const channels = [...guild.channels.cache.values()]
                    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
                    .sort((a, b) => a.rawPosition - b.rawPosition)
                    .map(c => {
                        const check = logs.checkChannel(guild, c.id);
                        return {
                            id: c.id,
                            name: c.name,
                            category: c.parent ? c.parent.name : null,
                            canSend: check.ok,
                            sendError: check.ok ? null : check.error
                        };
                    });
                const settings = logs.getSettings(guild.id);
                json(res, 200, {
                    guild: { id: guild.id, name: guild.name, icon: iconUrl(guild.id, guild.icon) },
                    channels,
                    types: Object.entries(logs.LOG_TYPES).map(([key, v]) => ({ key, icon: v.icon, name: v.name, desc: v.desc })),
                    settings: settings.logs,
                    errors: settings.errors
                });
                return;
            }

            // حفظ إعدادات السجلات
            if (req.method === 'POST' && m[2] === '/logs') {
                let body;
                try { body = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'بيانات غير صالحة.' }); return; }
                const result = logs.saveSettings(guild, body.logs || {});
                json(res, 200, { ok: true, errors: result.errors });
                return;
            }

            // اختبار روم
            if (req.method === 'POST' && m[2] === '/test') {
                let body;
                try { body = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'بيانات غير صالحة.' }); return; }
                const result = await logs.sendTest(guild, String(body.type || ''), String(body.channel_id || ''));
                json(res, 200, result);
                return;
            }
        }

        json(res, 404, { error: 'غير موجود.' });
        return;
    }

    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function start(client) {
    botClient = client;
    SECRET = process.env.SESSION_SECRET ||
        crypto.createHash('sha256').update(String(process.env.TOKEN || process.env.CLIENT_SECRET || 'dev-secret') + ':dashboard').digest('hex');

    const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(e => {
            console.error('خطأ بالموقع:', e);
            if (!res.headersSent) json(res, 500, { error: 'خطأ داخلي.' });
        });
    });
    server.on('error', e => console.log(`⚠️ تعذر تشغيل الموقع على المنفذ ${port}: ${e.message}`));
    server.listen(port, '0.0.0.0', () => console.log(`🌐 | الموقع شغال على المنفذ ${port}`));

    // تنظيف الجلسات المنتهية
    setInterval(() => {
        const now = Date.now();
        for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
        for (const [ip, r] of rate) if (r.reset < now) rate.delete(ip);
    }, 10 * 60 * 1000).unref();

    return server;
}

module.exports = {
    start,
    dashboardCommand: new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('رابط لوحة تحكم البوت (السجلات وشرح الأوامر)'),

    async handleDashboardCommand(interaction) {
        const url = process.env.DASHBOARD_URL;
        await interaction.reply({
            content: url ? `🌐 | لوحة التحكم: ${url}` : '❌ | رابط لوحة التحكم غير مضبوط بعد.',
            ephemeral: true
        });
    },

    _createSession: createSession // للاختبار فقط
};
