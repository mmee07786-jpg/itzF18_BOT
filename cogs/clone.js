const {
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelType
} = require('discord.js');

const OWNER_ID = "1107355943408259112";
const EMBED_COLOR = 0x8B0000;

// ───────────────────────── مساعدات ─────────────────────────

function guildOptions(client, excludeId = null) {
    return [...client.guilds.cache.values()]
        .filter(g => g.id !== excludeId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 25)
        .map(g => ({
            label: g.name.slice(0, 100),
            description: `الأعضاء: ${g.memberCount}`,
            value: g.id
        }));
}

function cancelRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cl_cancel").setLabel("إلغاء | Cancel").setStyle(ButtonStyle.Secondary)
    );
}

function sourceView(client) {
    const options = guildOptions(client);
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("📋 | نسخ الرومات | Clone Channels")
        .setDescription("**الخطوة 1/3:** اختر السيرفر **المصدر** (اللي تنسخ منه)\nStep 1/3: choose the SOURCE server");

    if (options.length === 0) {
        embed.setDescription("❌ | البوت مو موجود بأي سيرفر.");
        return { embeds: [embed], components: [] };
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId("cl_src")
        .setPlaceholder("السيرفر المصدر | Source server")
        .addOptions(options);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), cancelRow()] };
}

function targetView(client, srcId) {
    const src = client.guilds.cache.get(srcId);
    const options = guildOptions(client, srcId);
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("📋 | نسخ الرومات | Clone Channels")
        .setDescription(`المصدر: **${src ? src.name : "?"}**\n\n**الخطوة 2/3:** اختر السيرفر **الهدف** (اللي تنسخ له)\nStep 2/3: choose the TARGET server`);

    if (options.length === 0) {
        embed.setDescription("❌ | تحتاج البوت يكون بسيرفرين على الأقل.");
        return { embeds: [embed], components: [cancelRow()] };
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`cl_dst:${srcId}`)
        .setPlaceholder("السيرفر الهدف | Target server")
        .addOptions(options);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), cancelRow()] };
}

// صلاحيات: لازم تكون أدمن بالسيرفرين، والبوت عنده Manage Channels بالهدف
async function verifyAccess(client, userId, srcId, dstId) {
    const src = client.guilds.cache.get(srcId);
    const dst = client.guilds.cache.get(dstId);
    if (!src || !dst) return { error: "❌ | أحد السيرفرين ما عاد موجود." };

    for (const [guild, label] of [[src, "المصدر"], [dst, "الهدف"]]) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.permissions.has(PermissionFlagsBits.Administrator)) {
            return { error: `❌ | لازم تكون **أدمن** بسيرفر ${label} (**${guild.name}**). النسخ مسموح بين السيرفرات اللي تديرها بس.` };
        }
    }

    if (!dst.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { error: `❌ | البوت ما عنده صلاحية **Manage Channels** بسيرفر الهدف (**${dst.name}**).` };
    }
    return { src, dst };
}

function summarize(src) {
    const all = [...src.channels.cache.values()].filter(c => !c.isThread?.());
    const cats = all.filter(c => c.type === ChannelType.GuildCategory).length;
    return { cats, channels: all.length - cats };
}

async function createOne(dst, c, parent) {
    const base = { name: c.name, parent };

    switch (c.type) {
        case ChannelType.GuildText:
            return dst.channels.create({ ...base, type: ChannelType.GuildText, topic: c.topic || undefined, nsfw: c.nsfw, rateLimitPerUser: c.rateLimitPerUser || 0 });
        case ChannelType.GuildVoice:
            return dst.channels.create({ ...base, type: ChannelType.GuildVoice, userLimit: c.userLimit || 0 });
        case ChannelType.GuildAnnouncement:
            // يحتاج Community بالهدف، لو فشل نسويه نصي
            return dst.channels.create({ ...base, type: ChannelType.GuildAnnouncement, topic: c.topic || undefined })
                .catch(() => dst.channels.create({ ...base, type: ChannelType.GuildText, topic: c.topic || undefined }));
        case ChannelType.GuildStageVoice:
            return dst.channels.create({ ...base, type: ChannelType.GuildStageVoice })
                .catch(() => dst.channels.create({ ...base, type: ChannelType.GuildVoice }));
        case ChannelType.GuildForum:
            return dst.channels.create({ ...base, type: ChannelType.GuildForum })
                .catch(() => dst.channels.create({ ...base, type: ChannelType.GuildText }));
        default:
            return null; // أنواع ثانية ما ننسخها
    }
}

async function cloneChannels(src, dst, onProgress) {
    await src.channels.fetch();
    const all = [...src.channels.cache.values()].filter(c => !c.isThread?.());

    const cats = all.filter(c => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition);
    const catOrder = new Map(cats.map((c, i) => [c.id, i + 1]));

    // الرومات مرتبة حسب ترتيب الكاتيجوري ثم موقعها
    const others = all.filter(c => c.type !== ChannelType.GuildCategory)
        .sort((a, b) => {
            const ka = a.parentId ? (catOrder.get(a.parentId) || 0) : 0;
            const kb = b.parentId ? (catOrder.get(b.parentId) || 0) : 0;
            return (ka - kb) || (a.rawPosition - b.rawPosition);
        });

    const total = cats.length + others.length;
    let done = 0, created = 0, failed = 0;
    const catMap = new Map();

    const tick = async () => {
        done++;
        if (done % 5 === 0 || done === total) await onProgress(done, total);
    };

    for (const c of cats) {
        try {
            const n = await dst.channels.create({ name: c.name, type: ChannelType.GuildCategory });
            catMap.set(c.id, n.id);
            created++;
        } catch (e) { failed++; }
        await tick();
    }

    for (const c of others) {
        try {
            const parent = c.parentId ? catMap.get(c.parentId) : undefined;
            const n = await createOne(dst, c, parent);
            if (n) created++; else failed++;
        } catch (e) { failed++; }
        await tick();
    }

    return { total, created, failed };
}

// ───────────────────────── نسخ من قالب سيرفر (Template) ─────────────────────────

async function createFromTemplateChannel(dst, c, parent, overwrites) {
    const base = { name: String(c.name).slice(0, 100), parent, permissionOverwrites: overwrites };
    const fallbackText = () => dst.channels.create({ ...base, type: ChannelType.GuildText, topic: c.topic || undefined });

    switch (c.type) {
        case 0:
            return dst.channels.create({ ...base, type: ChannelType.GuildText, topic: c.topic || undefined, nsfw: !!c.nsfw, rateLimitPerUser: c.rate_limit_per_user || 0 });
        case 2:
            return dst.channels.create({ ...base, type: ChannelType.GuildVoice, userLimit: c.user_limit || 0 });
        case 5:
            return dst.channels.create({ ...base, type: ChannelType.GuildAnnouncement, topic: c.topic || undefined }).catch(fallbackText);
        case 13:
            return dst.channels.create({ ...base, type: ChannelType.GuildStageVoice })
                .catch(() => dst.channels.create({ ...base, type: ChannelType.GuildVoice }));
        case 15:
            return dst.channels.create({ ...base, type: ChannelType.GuildForum }).catch(fallbackText);
        default:
            return null;
    }
}

async function applyTemplate(dst, tpl, onProgress) {
    const sg = tpl.serializedGuild || {};
    const roles = sg.roles || [];
    const channels = sg.channels || [];

    const everyoneT = roles.find(r => r.name === '@everyone') || roles[0];
    const otherRoles = roles.filter(r => r !== everyoneT);

    const total = otherRoles.length + channels.length + 1;
    let done = 0;
    const result = { rolesCreated: 0, rolesFailed: 0, channelsCreated: 0, channelsFailed: 0 };
    const tick = async () => {
        done++;
        if (done % 5 === 0 || done === total) await onProgress(done, total);
    };

    const roleMap = new Map();
    if (everyoneT) roleMap.set(String(everyoneT.id), dst.roles.everyone.id);

    // صلاحيات @everyone
    if (everyoneT) {
        try { await dst.roles.everyone.setPermissions(BigInt(everyoneT.permissions || 0)); } catch (e) {}
    }
    await tick();

    // الرتب (من الأعلى للأدنى عشان الترتيب يطلع مثل القالب)
    for (const r of [...otherRoles].reverse()) {
        try {
            const created = await dst.roles.create({
                name: String(r.name).slice(0, 100),
                color: r.color || 0,
                hoist: !!r.hoist,
                mentionable: !!r.mentionable,
                permissions: BigInt(r.permissions || 0)
            });
            roleMap.set(String(r.id), created.id);
            result.rolesCreated++;
        } catch (e) { result.rolesFailed++; }
        await tick();
    }

    const buildOverwrites = c => (c.permission_overwrites || [])
        .filter(o => o.type === 0 && roleMap.has(String(o.id)))
        .map(o => ({
            id: roleMap.get(String(o.id)),
            allow: BigInt(o.allow || 0),
            deny: BigInt(o.deny || 0)
        }));

    // الكاتيجوريات
    const cats = channels.filter(c => c.type === 4).sort((a, b) => (a.position || 0) - (b.position || 0));
    const catOrder = new Map(cats.map((c, i) => [String(c.id), i + 1]));
    const catMap = new Map();

    for (const c of cats) {
        try {
            const n = await dst.channels.create({
                name: String(c.name).slice(0, 100),
                type: ChannelType.GuildCategory,
                permissionOverwrites: buildOverwrites(c)
            });
            catMap.set(String(c.id), n.id);
            result.channelsCreated++;
        } catch (e) { result.channelsFailed++; }
        await tick();
    }

    // باقي الرومات
    const others = channels.filter(c => c.type !== 4).sort((a, b) => {
        const ka = a.parent_id ? (catOrder.get(String(a.parent_id)) || 0) : 0;
        const kb = b.parent_id ? (catOrder.get(String(b.parent_id)) || 0) : 0;
        return (ka - kb) || ((a.position || 0) - (b.position || 0));
    });

    for (const c of others) {
        try {
            const parent = c.parent_id ? catMap.get(String(c.parent_id)) : undefined;
            const n = await createFromTemplateChannel(dst, c, parent, buildOverwrites(c));
            if (n) result.channelsCreated++; else result.channelsFailed++;
        } catch (e) { result.channelsFailed++; }
        await tick();
    }

    return result;
}

// ───────────────────────── التصدير ─────────────────────────

module.exports = {
    cloneCommand: new SlashCommandBuilder()
        .setName('clone-channels')
        .setDescription('[ Owner Only ] نسخ رومات سيرفر لسيرفر ثاني (تحتاج أدمن بالاثنين)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    cloneTemplateCommand: new SlashCommandBuilder()
        .setName('clone-template')
        .setDescription('[ Owner Only ] نسخ رومات ورتب وصلاحيات من رابط قالب سيرفر (discord.new) لهذا السيرفر')
        .addStringOption(o => o.setName('template').setDescription('رابط القالب (مثل discord.new/xxxx) أو الكود').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    inviteBotCommand: new SlashCommandBuilder()
        .setName('invite-bot')
        .setDescription('[ Owner Only ] رابط إضافة البوت لأي سيرفر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async handleInviteBot(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true });
            return;
        }

        const url = interaction.client.generateInvite({
            scopes: ['bot', 'applications.commands'],
            permissions: [PermissionFlagsBits.Administrator]
        });

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle("🔗 | رابط إضافة البوت | Invite Bot")
            .setDescription(
                "افتح الرابط واختر السيرفر. لازم يكون عندك صلاحية **Manage Server** بالسيرفر.\n" +
                "Open the link and pick a server (needs Manage Server permission).\n\n" +
                "بعد ما ينضاف البوت راح توصلك رسالة بالخاص فيها معلومات السيرفر، وتقدر تستخدم `/clone-channels`."
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("إضافة البوت | Add Bot").setStyle(ButtonStyle.Link).setURL(url)
        );
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    },

    async handleCloneTemplate(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true });
            return;
        }
        if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: "❌ | استخدم الأمر داخل سيرفرك وأنت أدمن فيه.", ephemeral: true });
            return;
        }

        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            await interaction.reply({ content: "❌ | البوت يحتاج صلاحيتي **Manage Channels** و**Manage Roles** (الأفضل Administrator) بهذا السيرفر.", ephemeral: true });
            return;
        }

        const input = interaction.options.getString('template').trim();
        await interaction.deferReply({ ephemeral: true });

        let tpl;
        try {
            tpl = await interaction.client.fetchGuildTemplate(input);
        } catch (e) {
            await interaction.editReply({
                content: "❌ | ما قدرت أجيب القالب. تأكد إنه رابط **قالب** (مثل `discord.new/xxxx`) وليس رابط دعوة عادي، وإن مالك السيرفر مفعّل القالب."
            });
            return;
        }

        const sg = tpl.serializedGuild || {};
        const rolesCount = Math.max((sg.roles || []).length - 1, 0);
        const channelsCount = (sg.channels || []).length;

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle("📋 | تأكيد نسخ القالب | Confirm Template")
            .setDescription(
                `**القالب:** ${tpl.name}\n` +
                (tpl.description ? `**الوصف:** ${String(tpl.description).slice(0, 200)}\n` : "") +
                `**من سيرفر:** ${sg.name || "?"}\n` +
                `**إلى:** ${interaction.guild.name}\n\n` +
                `راح ينسخ: \`${rolesCount}\` رتبة (بصلاحياتها) + \`${channelsCount}\` روم/كاتيجوري (بصلاحيات كل روم).\n` +
                `• يضيف فقط، وما يحذف أي شي من سيرفرك.\n` +
                `• يغيّر صلاحيات @everyone لتطابق القالب.\n\n` +
                `Adds roles & channels with their permissions. Nothing gets deleted.`
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cl_tgo:${tpl.code}`).setLabel("بدء النسخ | Start").setEmoji("✅").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cl_cancel").setLabel("إلغاء | Cancel").setStyle(ButtonStyle.Danger)
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
    },

    async handleClone(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true });
            return;
        }
        await interaction.reply({ ...sourceView(interaction.client), ephemeral: true });
    },

    async handleSelect(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true });
            return;
        }
        const client = interaction.client;
        const id = interaction.customId;

        // الخطوة 1 -> 2
        if (id === 'cl_src') {
            await interaction.update(targetView(client, interaction.values[0]));
            return;
        }

        // الخطوة 2 -> 3 (تأكيد)
        if (id.startsWith('cl_dst:')) {
            const srcId = id.split(':')[1];
            const dstId = interaction.values[0];

            const check = await verifyAccess(client, interaction.user.id, srcId, dstId);
            if (check.error) {
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(check.error)],
                    components: [cancelRow()]
                });
                return;
            }

            const info = summarize(check.src);
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle("📋 | تأكيد النسخ | Confirm")
                .setDescription(
                    `**من:** ${check.src.name}\n**إلى:** ${check.dst.name}\n\n` +
                    `راح ينسخ: \`${info.cats}\` كاتيجوري + \`${info.channels}\` روم (بالأسماء والترتيب).\n` +
                    `• ما يحذف أي شي من سيرفر الهدف، يضيف فقط.\n` +
                    `• ما ينسخ الرسائل ولا الرتب ولا الصلاحيات.\n\n` +
                    `Adds categories & channels only. Nothing gets deleted.`
                );
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`cl_go:${srcId}:${dstId}`).setLabel("بدء النسخ | Start").setEmoji("✅").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("cl_cancel").setLabel("إلغاء | Cancel").setStyle(ButtonStyle.Danger)
            );
            await interaction.update({ embeds: [embed], components: [row] });
        }
    },

    async handleButton(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true });
            return;
        }
        const id = interaction.customId;

        if (id === 'cl_cancel') {
            await interaction.update({
                embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription("تم الإلغاء. | Cancelled.")],
                components: []
            });
            return;
        }

        if (id.startsWith('cl_tgo:')) {
            const code = id.split(':')[1];
            if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: "❌ | لازم تكون أدمن بهذا السيرفر.", ephemeral: true });
                return;
            }

            await interaction.update({
                embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription("⏳ | جاري النسخ... | Cloning...")],
                components: []
            });

            try {
                const tpl = await interaction.client.fetchGuildTemplate(code);
                const r = await applyTemplate(interaction.guild, tpl, async (done, total) => {
                    await interaction.editReply({
                        embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`⏳ | جاري النسخ... \`${done}/${total}\``)]
                    }).catch(() => {});
                });

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(0x00C853)
                        .setTitle("✅ | تم النسخ | Done")
                        .setDescription(
                            `**الرتب:** \`${r.rolesCreated}\` تم` + (r.rolesFailed ? ` / \`${r.rolesFailed}\` فشل` : "") + `\n` +
                            `**الرومات:** \`${r.channelsCreated}\` تم` + (r.channelsFailed ? ` / \`${r.channelsFailed}\` فشل` : "") +
                            (r.rolesFailed || r.channelsFailed ? "\n\nالفشل غالباً بسبب حد الرومات/الرتب أو نقص صلاحيات البوت (الأفضل Administrator)." : "")
                        )]
                });
            } catch (e) {
                console.error("خطأ في clone-template:", e);
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(`❌ | فشل النسخ: \`${e.message}\``)]
                }).catch(() => {});
            }
            return;
        }

        if (id.startsWith('cl_go:')) {
            const [, srcId, dstId] = id.split(':');

            // نعيد التحقق وقت التنفيذ
            const check = await verifyAccess(interaction.client, interaction.user.id, srcId, dstId);
            if (check.error) {
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(check.error)],
                    components: []
                });
                return;
            }

            await interaction.update({
                embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription("⏳ | جاري النسخ... | Cloning...")],
                components: []
            });

            try {
                const result = await cloneChannels(check.src, check.dst, async (done, total) => {
                    await interaction.editReply({
                        embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`⏳ | جاري النسخ... \`${done}/${total}\``)]
                    }).catch(() => {});
                });

                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(0x00C853)
                        .setTitle("✅ | تم النسخ | Done")
                        .setDescription(
                            `**من:** ${check.src.name}\n**إلى:** ${check.dst.name}\n\n` +
                            `تم إنشاء: \`${result.created}\` / \`${result.total}\`` +
                            (result.failed ? `\nفشل/تخطّى: \`${result.failed}\` (أنواع غير مدعومة أو حد الرومات)` : "")
                        )]
                });
            } catch (e) {
                console.error("خطأ في clone-channels:", e);
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(`❌ | فشل النسخ: \`${e.message}\``)]
                }).catch(() => {});
            }
        }
    }
};
