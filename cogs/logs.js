const { EmbedBuilder, AuditLogEvent, ChannelType, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../guild_settings.json');

// أنواع السجلات (تظهر بلوحة التحكم)
const LOG_TYPES = {
    message_delete: { icon: '🗑️', name: 'حذف الرسائل', desc: 'أي رسالة تنحذف: مين كتبها، مين حذفها، ومحتواها' },
    message_edit: { icon: '✏️', name: 'تعديل الرسائل', desc: 'الرسالة قبل وبعد التعديل مع رابطها' },
    voice: { icon: '🔊', name: 'الرومات الصوتية', desc: 'مين دخل ومين طلع ومين انتقل بين الرومات الصوتية' },
    kick: { icon: '👢', name: 'الطرد', desc: 'مين انطرد، من طرده، والسبب' },
    ban: { icon: '🔨', name: 'الباند وفك الباند', desc: 'مين انحظر أو انفك حظره، من سواها، والسبب' },
    timeout: { icon: '⏳', name: 'التايم أوت', desc: 'مين انعطى تايم أوت أو انرفع عنه، المدة، من سواها، والسبب' },
    member_join: { icon: '📥', name: 'دخول الأعضاء', desc: 'عضو جديد دخل السيرفر مع عمر حسابه' },
    member_leave: { icon: '📤', name: 'خروج الأعضاء', desc: 'عضو طلع من السيرفر (بدون طرد أو باند) ورتبه' },
    member_update: { icon: '🏷️', name: 'تغيير الرتب والأسماء', desc: 'إضافة وسحب الرتب وتغيير النكنيم، ومن سواها' },
    channels: { icon: '📁', name: 'الرومات', desc: 'إنشاء وحذف الرومات ومن سواها' },
    roles: { icon: '🎭', name: 'الرتب', desc: 'إنشاء وحذف الرتب ومن سواها' }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = ms => Math.floor(ms / 1000);
const trunc = (s, n = 1000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const safe = s => String(s ?? '').replace(/`/g, "'");
const reasonText = r => (r ? trunc(safe(r), 500) : 'لم يُذكر سبب');
const userLine = u => (u ? `<@${u.id}> (\`${safe(u.username)}\`)` : 'غير معروف');

// ───────────────────────── التخزين (لكل سيرفر مستقل) ─────────────────────────

function loadStore() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (d && typeof d === 'object') return d;
        }
    } catch (e) {}
    return {};
}

let store = loadStore();
let hooks = {};

function persist() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        console.error("خطأ في حفظ إعدادات السجلات:", e.message);
    }
}

function getGuild(gid) {
    if (!store[gid]) store[gid] = {};
    if (!store[gid].logs) store[gid].logs = {};
    if (!store[gid].errors) store[gid].errors = {};
    return store[gid];
}

function recordError(gid, type, message) {
    const g = getGuild(gid);
    if (g.errors[type] && g.errors[type].message === message) return; // نفس الخطأ، ما نكتب مرة ثانية
    g.errors[type] = { message, at: Date.now() };
    persist();
}

function clearError(gid, type) {
    const g = getGuild(gid);
    if (g.errors[type]) {
        delete g.errors[type];
        persist();
    }
}

// ───────────────────────── التحقق من الروم ─────────────────────────

const NEEDED_PERMS = [
    [PermissionFlagsBits.ViewChannel, 'عرض الروم (View Channel)'],
    [PermissionFlagsBits.SendMessages, 'إرسال الرسائل (Send Messages)'],
    [PermissionFlagsBits.EmbedLinks, 'تضمين الروابط (Embed Links)']
];

function checkChannel(guild, channelId) {
    if (!channelId) return { ok: false, error: 'ما اخترت روم.' };
    const ch = guild.channels.cache.get(String(channelId));
    if (!ch) return { ok: false, error: 'الروم غير موجود أو انحذف.' };
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
        return { ok: false, error: 'لازم تختار روم نصي.' };
    }
    const me = guild.members.me;
    if (!me) return { ok: false, error: 'ما قدرت أتحقق من صلاحيات البوت.' };
    const perms = ch.permissionsFor(me);
    const missing = NEEDED_PERMS.filter(([bit]) => !perms || !perms.has(bit)).map(p => p[1]);
    if (missing.length) {
        return { ok: false, error: `البوت ما عنده صلاحية: ${missing.join('، ')} بهذا الروم.` };
    }
    return { ok: true, channel: ch };
}

// ───────────────────────── الإرسال ─────────────────────────

async function sendLog(guild, type, embed) {
    if (hooks.isGuildDisabled && hooks.isGuildDisabled(guild.id)) return;
    const cfg = store[guild.id]?.logs?.[type];
    if (!cfg || !cfg.enabled || !cfg.channel_id) return;

    const check = checkChannel(guild, cfg.channel_id);
    if (!check.ok) {
        recordError(guild.id, type, check.error);
        return;
    }
    try {
        await check.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        clearError(guild.id, type);
    } catch (e) {
        recordError(guild.id, type, `فشل الإرسال: ${e.message}`);
    }
}

// قراءة سجل التدقيق (Audit Log) لمعرفة من نفّذ العملية
async function findAudit(guild, type, targetId, { filter = null, wait = 1200 } = {}) {
    try {
        if (wait) await sleep(wait);
        const logs = await guild.fetchAuditLogs({ type, limit: 8 });
        const now = Date.now();
        return logs.entries.find(e =>
            (!targetId || e.targetId === targetId || e.target?.id === targetId) &&
            now - e.createdTimestamp < 20000 &&
            (!filter || filter(e))
        ) || null;
    } catch (e) {
        return null;
    }
}

function makeEmbed({ color, title, user, desc, fields }) {
    const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    if (user) {
        const avatar = typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL() : undefined;
        e.setAuthor({
            name: user.globalName ? `${user.globalName} (@${user.username})` : (user.username || 'مجهول'),
            iconURL: avatar
        });
        if (avatar) e.setThumbnail(avatar);
        e.setFooter({ text: `ID: ${user.id}` });
    }
    if (desc) e.setDescription(desc);
    if (fields && fields.length) e.addFields(fields);
    return e;
}

const RED = 0xED4245, GREEN = 0x57F287, ORANGE = 0xFAA61A, BLUE = 0x5865F2, GREY = 0x99AAB5;

// ───────────────────────── تسجيل الأحداث ─────────────────────────

function register(client, opts = {}) {
    hooks = opts;
    const guard = (name, fn) => async (...args) => {
        try { await fn(...args); } catch (e) { console.error(`خطأ بسجل ${name}:`, e); }
    };

    // 🗑️ حذف رسالة
    client.on('messageDelete', guard('messageDelete', async message => {
        if (!message.guild) return;
        if (message.author && message.author.bot) return;
        const author = message.author || null;

        const entry = author
            ? await findAudit(message.guild, AuditLogEvent.MessageDelete, author.id, { filter: e => e.extra?.channel?.id === message.channelId })
            : null;

        const content = message.partial ? null : message.content;
        const files = message.attachments?.size ? [...message.attachments.values()].map(a => a.url).join('\n') : null;

        const embed = makeEmbed({
            color: RED,
            title: '🗑️ تم حذف رسالة',
            user: author,
            desc:
                `**الكاتب:** ${userLine(author)}\n` +
                `**الروم:** <#${message.channelId}>\n` +
                `**حذفها:** ${entry ? userLine(entry.executor) : 'الكاتب نفسه أو غير معروف'}`,
            fields: [
                { name: 'المحتوى', value: content ? trunc(content) : (content === null ? 'غير متوفر (الرسالة قديمة)' : '— (بدون نص)') },
                ...(files ? [{ name: 'المرفقات', value: trunc(files) }] : [])
            ]
        });
        await sendLog(message.guild, 'message_delete', embed);
    }));

    // ✏️ تعديل رسالة
    client.on('messageUpdate', guard('messageUpdate', async (oldMsg, newMsg) => {
        if (!newMsg.guild) return;
        if (newMsg.partial) await newMsg.fetch().catch(() => null);
        if (!newMsg.author || newMsg.author.bot) return;
        if (oldMsg.content === newMsg.content) return;

        const embed = makeEmbed({
            color: ORANGE,
            title: '✏️ تم تعديل رسالة',
            user: newMsg.author,
            desc: `**الكاتب:** ${userLine(newMsg.author)}\n**الروم:** <#${newMsg.channelId}>\n[الذهاب للرسالة](${newMsg.url})`,
            fields: [
                { name: 'قبل', value: oldMsg.content ? trunc(oldMsg.content) : 'غير متوفر' },
                { name: 'بعد', value: newMsg.content ? trunc(newMsg.content) : '—' }
            ]
        });
        await sendLog(newMsg.guild, 'message_edit', embed);
    }));

    // 🔊 الرومات الصوتية
    client.on('voiceStateUpdate', guard('voiceStateUpdate', async (oldState, newState) => {
        const member = newState.member || oldState.member;
        if (!member || member.user.bot) return;
        const guild = newState.guild || oldState.guild;

        const oldId = oldState.channelId, newId = newState.channelId;
        if (oldId === newId) return;

        let title, color, fields;
        if (!oldId && newId) {
            title = '🔊 دخل روم صوتي'; color = GREEN;
            fields = [{ name: 'الروم', value: `<#${newId}>`, inline: true }];
        } else if (oldId && !newId) {
            title = '🔇 طلع من روم صوتي'; color = RED;
            fields = [{ name: 'الروم', value: `<#${oldId}>`, inline: true }];
        } else {
            title = '🔁 انتقل بين رومين صوتيين'; color = BLUE;
            fields = [
                { name: 'من', value: `<#${oldId}>`, inline: true },
                { name: 'إلى', value: `<#${newId}>`, inline: true }
            ];
        }
        const embed = makeEmbed({ color, title, user: member.user, desc: `**العضو:** ${userLine(member.user)}`, fields });
        await sendLog(guild, 'voice', embed);
    }));

    // 📥 دخول عضو
    client.on('guildMemberAdd', guard('guildMemberAdd', async member => {
        const embed = makeEmbed({
            color: GREEN,
            title: member.user.bot ? '🤖 انضاف بوت' : '📥 عضو جديد',
            user: member.user,
            desc: `**العضو:** ${userLine(member.user)}`,
            fields: [
                { name: 'عمر الحساب', value: `<t:${ts(member.user.createdTimestamp)}:R>`, inline: true },
                { name: 'عدد الأعضاء', value: `${member.guild.memberCount}`, inline: true }
            ]
        });
        await sendLog(member.guild, 'member_join', embed);
    }));

    // 👢 طرد / 📤 خروج
    client.on('guildMemberRemove', guard('guildMemberRemove', async member => {
        const guild = member.guild;
        const user = member.user;

        const kick = await findAudit(guild, AuditLogEvent.MemberKick, user.id);
        if (kick) {
            const embed = makeEmbed({
                color: ORANGE,
                title: '👢 تم طرد عضو',
                user,
                desc:
                    `**المطرود:** ${userLine(user)}\n` +
                    `**بواسطة:** ${userLine(kick.executor)}\n` +
                    `**السبب:** ${reasonText(kick.reason)}`
            });
            await sendLog(guild, 'kick', embed);
            return;
        }

        // لو انحظر، سجل الباند يتولى الموضوع
        const ban = await findAudit(guild, AuditLogEvent.MemberBanAdd, user.id, { wait: 0 });
        if (ban) return;

        const roles = member.roles?.cache
            ? [...member.roles.cache.values()].filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(' ')
            : '';
        const embed = makeEmbed({
            color: RED,
            title: '📤 عضو طلع من السيرفر',
            user,
            desc: `**العضو:** ${userLine(user)}`,
            fields: [
                { name: 'دخل السيرفر', value: member.joinedTimestamp ? `<t:${ts(member.joinedTimestamp)}:R>` : 'غير معروف', inline: true },
                { name: 'عدد الأعضاء', value: `${guild.memberCount}`, inline: true },
                ...(roles ? [{ name: 'رتبه', value: trunc(roles) }] : [])
            ]
        });
        await sendLog(guild, 'member_leave', embed);
    }));

    // 🔨 باند
    client.on('guildBanAdd', guard('guildBanAdd', async ban => {
        if (ban.partial) await ban.fetch().catch(() => null);
        const entry = await findAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, { wait: 800 });
        const embed = makeEmbed({
            color: RED,
            title: '🔨 تم حظر عضو',
            user: ban.user,
            desc:
                `**المحظور:** ${userLine(ban.user)}\n` +
                `**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}\n` +
                `**السبب:** ${reasonText(ban.reason || entry?.reason)}`
        });
        await sendLog(ban.guild, 'ban', embed);
    }));

    // ✅ فك باند
    client.on('guildBanRemove', guard('guildBanRemove', async ban => {
        const entry = await findAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id, { wait: 800 });
        const embed = makeEmbed({
            color: GREEN,
            title: '✅ تم فك الحظر',
            user: ban.user,
            desc:
                `**العضو:** ${userLine(ban.user)}\n` +
                `**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}\n` +
                `**السبب:** ${reasonText(entry?.reason)}`
        });
        await sendLog(ban.guild, 'ban', embed);
    }));

    // ⏳ تايم أوت + 🏷️ رتب ونكنيم
    client.on('guildMemberUpdate', guard('guildMemberUpdate', async (oldMember, newMember) => {
        const guild = newMember.guild;
        const user = newMember.user;
        if (user.bot) return;

        // ⏳ التايم أوت
        const oldTs = oldMember.communicationDisabledUntilTimestamp;
        const newTs = newMember.communicationDisabledUntilTimestamp;
        const now = Date.now();
        const wasTimed = !!oldTs && oldTs > now;
        const isTimed = !!newTs && newTs > now;

        if (!oldMember.partial && ((!wasTimed && isTimed) || (isTimed && oldTs !== newTs))) {
            const entry = await findAudit(guild, AuditLogEvent.MemberUpdate, user.id, {
                filter: e => e.changes?.some(c => c.key === 'communication_disabled_until')
            });
            const embed = makeEmbed({
                color: ORANGE,
                title: '⏳ تم إعطاء تايم أوت',
                user,
                desc:
                    `**العضو:** ${userLine(user)}\n` +
                    `**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}\n` +
                    `**السبب:** ${reasonText(entry?.reason)}`,
                fields: [
                    { name: 'ينتهي', value: `<t:${ts(newTs)}:F>\n(<t:${ts(newTs)}:R>)`, inline: true },
                    { name: 'المدة', value: `${Math.max(1, Math.round((newTs - now) / 60000))} دقيقة تقريباً`, inline: true }
                ]
            });
            await sendLog(guild, 'timeout', embed);
        } else if (!oldMember.partial && wasTimed && !isTimed) {
            const entry = await findAudit(guild, AuditLogEvent.MemberUpdate, user.id, {
                filter: e => e.changes?.some(c => c.key === 'communication_disabled_until')
            });
            const embed = makeEmbed({
                color: GREEN,
                title: '🔓 تم رفع التايم أوت',
                user,
                desc:
                    `**العضو:** ${userLine(user)}\n` +
                    `**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`
            });
            await sendLog(guild, 'timeout', embed);
        }

        if (oldMember.partial) return;

        // 🏷️ الرتب
        const oldRoles = new Set(oldMember.roles.cache.keys());
        const newRoles = new Set(newMember.roles.cache.keys());
        const added = [...newRoles].filter(r => !oldRoles.has(r));
        const removed = [...oldRoles].filter(r => !newRoles.has(r));

        if (added.length || removed.length) {
            const entry = await findAudit(guild, AuditLogEvent.MemberRoleUpdate, user.id);
            const fields = [];
            if (added.length) fields.push({ name: '➕ رتب انضافت', value: added.map(r => `<@&${r}>`).join(' ') });
            if (removed.length) fields.push({ name: '➖ رتب انسحبت', value: removed.map(r => `<@&${r}>`).join(' ') });
            const embed = makeEmbed({
                color: BLUE,
                title: '🏷️ تغيّرت رتب عضو',
                user,
                desc: `**العضو:** ${userLine(user)}\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`,
                fields
            });
            await sendLog(guild, 'member_update', embed);
        }

        // ✏️ النكنيم
        if (oldMember.nickname !== newMember.nickname) {
            const entry = await findAudit(guild, AuditLogEvent.MemberUpdate, user.id, {
                filter: e => e.changes?.some(c => c.key === 'nick')
            });
            const embed = makeEmbed({
                color: BLUE,
                title: '✏️ تغيّر نكنيم عضو',
                user,
                desc: `**العضو:** ${userLine(user)}\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`,
                fields: [
                    { name: 'قبل', value: safe(oldMember.nickname) || '— (بدون)', inline: true },
                    { name: 'بعد', value: safe(newMember.nickname) || '— (بدون)', inline: true }
                ]
            });
            await sendLog(guild, 'member_update', embed);
        }
    }));

    // 📁 الرومات
    client.on('channelCreate', guard('channelCreate', async channel => {
        if (!channel.guild) return;
        const entry = await findAudit(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
        const embed = makeEmbed({
            color: GREEN,
            title: '📁 تم إنشاء روم',
            desc: `**الروم:** <#${channel.id}> (\`${safe(channel.name)}\`)\n**النوع:** \`${ChannelType[channel.type] || channel.type}\`\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`
        });
        await sendLog(channel.guild, 'channels', embed);
    }));

    client.on('channelDelete', guard('channelDelete', async channel => {
        if (!channel.guild) return;
        const entry = await findAudit(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
        const embed = makeEmbed({
            color: RED,
            title: '🗑️ تم حذف روم',
            desc: `**الاسم:** \`${safe(channel.name)}\`\n**النوع:** \`${ChannelType[channel.type] || channel.type}\`\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`
        });
        await sendLog(channel.guild, 'channels', embed);
    }));

    // 🎭 الرتب
    client.on('roleCreate', guard('roleCreate', async role => {
        const entry = await findAudit(role.guild, AuditLogEvent.RoleCreate, role.id);
        const embed = makeEmbed({
            color: GREEN,
            title: '🎭 تم إنشاء رتبة',
            desc: `**الرتبة:** <@&${role.id}> (\`${safe(role.name)}\`)\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`
        });
        await sendLog(role.guild, 'roles', embed);
    }));

    client.on('roleDelete', guard('roleDelete', async role => {
        const entry = await findAudit(role.guild, AuditLogEvent.RoleDelete, role.id);
        const embed = makeEmbed({
            color: RED,
            title: '🎭 تم حذف رتبة',
            desc: `**الاسم:** \`${safe(role.name)}\`\n**بواسطة:** ${entry ? userLine(entry.executor) : 'غير معروف'}`
        });
        await sendLog(role.guild, 'roles', embed);
    }));
}

// ───────────────────────── واجهة للوحة التحكم ─────────────────────────

function getSettings(gid) {
    const g = getGuild(gid);
    const logs = {};
    for (const key of Object.keys(LOG_TYPES)) {
        const c = g.logs[key] || {};
        logs[key] = { enabled: !!c.enabled, channel_id: c.channel_id || null };
    }
    return { logs, errors: g.errors };
}

// يحفظ الإعدادات بعد التحقق من كل روم. يرجع الأخطاء لكل نوع
function saveSettings(guild, incoming) {
    const g = getGuild(guild.id);
    const errors = {};

    for (const key of Object.keys(LOG_TYPES)) {
        const inc = incoming && incoming[key];
        if (!inc || typeof inc !== 'object') continue;

        const channelId = inc.channel_id ? String(inc.channel_id) : null;
        const enabled = !!inc.enabled;

        if (channelId && !/^\d{15,25}$/.test(channelId)) {
            errors[key] = 'معرّف الروم غير صحيح.';
            continue;
        }

        if (enabled) {
            const check = checkChannel(guild, channelId);
            if (!check.ok) {
                errors[key] = check.error;
                continue; // نترك الإعداد القديم كما هو
            }
        }

        g.logs[key] = { enabled, channel_id: channelId };
        if (!enabled || channelId) delete g.errors[key];
    }

    persist();
    return { errors };
}

async function sendTest(guild, type, channelId) {
    const meta = LOG_TYPES[type];
    if (!meta) return { ok: false, error: 'نوع السجل غير معروف.' };

    const check = checkChannel(guild, channelId);
    if (!check.ok) return check;

    try {
        const embed = makeEmbed({
            color: BLUE,
            title: `${meta.icon} اختبار سجل: ${meta.name}`,
            desc: '✅ هذي رسالة اختبار من لوحة التحكم.\nلو وصلتك، السجل راح يشتغل بهذا الروم.'
        });
        await check.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `فشل الإرسال: ${e.message}` };
    }
}

module.exports = { LOG_TYPES, register, checkChannel, getSettings, saveSettings, sendTest };
