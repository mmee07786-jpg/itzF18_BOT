const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelType, PermissionFlagsBits
} = require('discord.js');

const OWNER_ID = "1107355943408259112";
const EMBED_COLOR = 0x8B0000;

const isOwner = i => i.user.id === OWNER_ID;
const isTextish = c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement;

// ───────────────────────── واجهات ─────────────────────────

function homeView(notice = "") {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("📨 | إرسال رسائل | Messenger")
        .setDescription(`${notice ? notice + "\n\n" : ""}اختر طريقة الإرسال\nChoose how to send`);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ms_mode_dm").setLabel("خاص | DM").setEmoji("📩").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ms_mode_srv").setLabel("سيرفر | Server").setEmoji("🏰").setStyle(ButtonStyle.Success)
    );
    return { embeds: [embed], components: [row] };
}

function homeRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ms_home").setLabel("الرئيسية | Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary)
    );
}

function simpleView(text) {
    return { embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(text)], components: [homeRow()] };
}

function findModal() {
    const input = new TextInputBuilder()
        .setCustomId("query")
        .setLabel("يوزر الشخص أو الـ ID | Username or ID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    return new ModalBuilder()
        .setCustomId("ms_find")
        .setTitle("🔍 | البحث عن شخص | Find User")
        .addComponents(new ActionRowBuilder().addComponents(input));
}

function sendDmModal(userId) {
    const input = new TextInputBuilder()
        .setCustomId("text")
        .setLabel("الرسالة | Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000);
    return new ModalBuilder()
        .setCustomId(`ms_send_dm:${userId}`)
        .setTitle("✉️ | رسالة خاصة | Direct Message")
        .addComponents(new ActionRowBuilder().addComponents(input));
}

function sendChannelModal(channelId) {
    const text = new TextInputBuilder()
        .setCustomId("text")
        .setLabel("الرسالة | Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1900);
    const mention = new TextInputBuilder()
        .setCustomId("mention")
        .setLabel("منشن (اختياري) | Mention")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("everyone / here / ID أو اسم رتبة أو عضو");
    return new ModalBuilder()
        .setCustomId(`ms_send_ch:${channelId}`)
        .setTitle("📢 | رسالة بالسيرفر | Server Message")
        .addComponents(new ActionRowBuilder().addComponents(text), new ActionRowBuilder().addComponents(mention));
}

// ───────────────────────── الخاص ─────────────────────────

async function searchUsers(client, query) {
    const q = query.trim().replace(/^@/, "");
    if (/^\d{15,20}$/.test(q)) {
        const u = await client.users.fetch(q).catch(() => null);
        return u ? [{ user: u, guild: "—" }] : [];
    }

    const found = new Map();
    for (const g of client.guilds.cache.values()) {
        try {
            const res = await g.members.search({ query: q, limit: 10 });
            for (const m of res.values()) {
                if (!m.user.bot && !found.has(m.id)) found.set(m.id, { user: m.user, guild: g.name });
            }
        } catch (e) {}
        if (found.size >= 25) break;
    }
    return [...found.values()].slice(0, 25);
}

function userListView(results) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("🔍 | نتائج البحث | Results")
        .setDescription(`لقيت \`${results.length}\` نتيجة، اختر الشخص:`);
    const menu = new StringSelectMenuBuilder()
        .setCustomId("ms_user")
        .setPlaceholder("اختر الشخص | Pick a user")
        .addOptions(results.map(r => ({
            label: (r.user.globalName || r.user.username).slice(0, 100),
            description: `@${r.user.username} • ${r.guild}`.slice(0, 100),
            value: r.user.id
        })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), homeRow()] };
}

async function userView(client, userId, notice = "") {
    const user = await client.users.fetch(userId, { force: true }).catch(() => null);
    if (!user) return simpleView("❌ | ما قدرت أجيب هذا الشخص.");

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`👤 | ${user.globalName || user.username}`)
        .setThumbnail(user.displayAvatarURL())
        .setDescription(
            `${notice ? notice + "\n\n" : ""}**اليوزر:** @${user.username}\n` +
            `**ID:** \`${user.id}\`\n` +
            `**أنشئ الحساب:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`
        );
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ms_dm_send:${user.id}`).setLabel("إرسال رسالة | Send").setEmoji("✉️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ms_dm_hist:${user.id}`).setLabel("المحادثة | Chat").setEmoji("📜").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row, homeRow()] };
}

async function historyView(client, userId) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return simpleView("❌ | ما قدرت أجيب هذا الشخص.");

    let lines = [];
    try {
        const dm = await user.createDM();
        const msgs = await dm.messages.fetch({ limit: 15 });
        lines = [...msgs.values()].reverse().map(m => {
            const who = m.author.id === client.user.id ? "🤖 البوت" : `👤 ${m.author.username}`;
            let content = (m.content || "").replace(/\n/g, " ").slice(0, 250);
            if (m.attachments.size) content += ` 📎×${m.attachments.size}`;
            if (!content && m.embeds.length) content = "[إيمبد]";
            return `<t:${Math.floor(m.createdTimestamp / 1000)}:t> **${who}:** ${content || "—"}`;
        });
    } catch (e) {
        return simpleView(`❌ | ما قدرت أقرأ المحادثة: \`${e.message}\``);
    }

    let desc = lines.join("\n") || "ما فيه رسائل بينك وبين هذا الشخص (بالخاص).";
    if (desc.length > 3900) desc = desc.slice(-3900);

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`📜 | المحادثة مع ${user.globalName || user.username}`)
        .setDescription(desc)
        .setFooter({ text: "آخر 15 رسالة | Last 15 messages" });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ms_dm_send:${user.id}`).setLabel("إرسال | Send").setEmoji("✉️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ms_dm_hist:${user.id}`).setLabel("تحديث | Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ms_user_back:${user.id}`).setLabel("رجوع | Back").setEmoji("⬅️").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row] };
}

// ───────────────────────── السيرفر ─────────────────────────

function guildListView(client) {
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25);
    if (guilds.length === 0) return simpleView("❌ | البوت مو موجود بأي سيرفر.");

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("🏰 | اختر السيرفر | Choose Server")
        .setDescription("السيرفرات اللي البوت داخلها:");
    const menu = new StringSelectMenuBuilder()
        .setCustomId("ms_guild")
        .setPlaceholder("اختر السيرفر | Pick a server")
        .addOptions(guilds.map(g => ({
            label: g.name.slice(0, 100),
            description: `الأعضاء: ${g.memberCount}`,
            value: g.id
        })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), homeRow()] };
}

async function categoriesView(guild) {
    await guild.channels.fetch();
    const me = guild.members.me;
    const chans = [...guild.channels.cache.values()];
    const sendable = c => isTextish(c) && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);

    const options = [];
    const cats = chans.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition);
    for (const cat of cats) {
        const count = chans.filter(c => c.parentId === cat.id && sendable(c)).length;
        if (count > 0) options.push({ label: cat.name.slice(0, 100), description: `${count} روم`, value: cat.id });
    }
    const orphans = chans.filter(c => !c.parentId && sendable(c)).length;
    if (orphans > 0) options.push({ label: "بدون قسم | No category", description: `${orphans} روم`, value: "none" });

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ms_mode_srv").setLabel("السيرفرات | Servers").setEmoji("⬅️").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ms_home").setLabel("الرئيسية | Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary)
    );

    if (options.length === 0) {
        return { embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(`❌ | ما فيه رومات نصية أقدر أرسل فيها بسيرفر **${guild.name}**.`)], components: [backRow] };
    }

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`🏰 | ${guild.name}`)
        .setDescription("اختر **القسم** (الكاتيجوري):" + (options.length > 25 ? "\n(عرض أول 25 فقط)" : ""));
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`ms_cat:${guild.id}`)
        .setPlaceholder("اختر القسم | Pick a category")
        .addOptions(options.slice(0, 25));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow] };
}

async function channelsView(guild, catId) {
    await guild.channels.fetch();
    const me = guild.members.me;
    const list = [...guild.channels.cache.values()]
        .filter(c => isTextish(c) && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
            && (catId === "none" ? !c.parentId : c.parentId === catId))
        .sort((a, b) => a.rawPosition - b.rawPosition);

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ms_cats:${guild.id}`).setLabel("الأقسام | Categories").setEmoji("⬅️").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ms_home").setLabel("الرئيسية | Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary)
    );

    if (list.length === 0) {
        return { embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription("❌ | ما فيه رومات متاحة بهذا القسم.")], components: [backRow] };
    }

    const catName = catId === "none" ? "بدون قسم" : (guild.channels.cache.get(catId)?.name || "?");
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`🏰 | ${guild.name} › ${catName}`)
        .setDescription("اختر **الروم**:" + (list.length > 25 ? "\n(عرض أول 25 فقط)" : ""));
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`ms_chan:${guild.id}:${catId}`)
        .setPlaceholder("اختر الروم | Pick a channel")
        .addOptions(list.slice(0, 25).map(c => ({ label: `#${c.name}`.slice(0, 100), value: c.id })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow] };
}

// تحويل خانة المنشن لنص + allowedMentions
async function parseMention(input, guild) {
    const t = (input || "").trim();
    if (!t) return { text: "", allowed: { parse: [] } };

    const low = t.toLowerCase().replace(/^@/, "");
    if (low === "everyone") return { text: "@everyone", allowed: { parse: ["everyone"] } };
    if (low === "here") return { text: "@here", allowed: { parse: ["everyone"] } };

    const idMatch = t.match(/\d{15,20}/);
    if (idMatch) {
        const id = idMatch[0];
        if (guild.roles.cache.has(id)) return { text: `<@&${id}>`, allowed: { roles: [id] } };
        return { text: `<@${id}>`, allowed: { users: [id] } };
    }

    const role = guild.roles.cache.find(r => r.name.toLowerCase() === low);
    if (role) return { text: `<@&${role.id}>`, allowed: { roles: [role.id] } };

    const res = await guild.members.search({ query: low, limit: 1 }).catch(() => null);
    const member = res && res.first();
    if (member) return { text: `<@${member.id}>`, allowed: { users: [member.id] } };

    return { error: `❌ | ما لقيت منشن مطابق لـ \`${t}\` (اكتب everyone أو here أو ID).` };
}

// ───────────────────────── التصدير ─────────────────────────

module.exports = {
    // الأمر !mss (للأونر فقط) - اللوحة تنرسل بالخاص
    async handleMssCommand(message, client) {
        if (message.author.id !== OWNER_ID) return;
        if (message.guild) await message.delete().catch(() => {});

        try {
            await message.author.send(homeView());
        } catch (e) {
            await message.channel.send(homeView()).catch(() => {});
        }
    },

    async handleButton(interaction) {
        if (!isOwner(interaction)) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true }).catch(() => {});
            return;
        }
        const client = interaction.client;
        const id = interaction.customId;

        if (id === "ms_home") { await interaction.update(homeView()); return; }
        if (id === "ms_mode_dm") { await interaction.showModal(findModal()); return; }
        if (id === "ms_mode_srv") { await interaction.update(guildListView(client)); return; }

        if (id.startsWith("ms_dm_send:")) {
            await interaction.showModal(sendDmModal(id.split(":")[1]));
            return;
        }
        if (id.startsWith("ms_dm_hist:")) {
            await interaction.deferUpdate();
            await interaction.editReply(await historyView(client, id.split(":")[1]));
            return;
        }
        if (id.startsWith("ms_user_back:")) {
            await interaction.deferUpdate();
            await interaction.editReply(await userView(client, id.split(":")[1]));
            return;
        }
        if (id.startsWith("ms_cats:")) {
            const guild = client.guilds.cache.get(id.split(":")[1]);
            await interaction.deferUpdate();
            await interaction.editReply(guild ? await categoriesView(guild) : simpleView("❌ | السيرفر ما عاد موجود."));
            return;
        }
        if (id.startsWith("ms_again:")) {
            await interaction.showModal(sendChannelModal(id.split(":")[1]));
        }
    },

    async handleSelect(interaction) {
        if (!isOwner(interaction)) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true }).catch(() => {});
            return;
        }
        const client = interaction.client;
        const id = interaction.customId;

        if (id === "ms_user") {
            await interaction.deferUpdate();
            await interaction.editReply(await userView(client, interaction.values[0]));
            return;
        }

        if (id === "ms_guild") {
            const guild = client.guilds.cache.get(interaction.values[0]);
            await interaction.deferUpdate();
            await interaction.editReply(guild ? await categoriesView(guild) : simpleView("❌ | السيرفر ما عاد موجود."));
            return;
        }

        if (id.startsWith("ms_cat:")) {
            const guild = client.guilds.cache.get(id.split(":")[1]);
            await interaction.deferUpdate();
            await interaction.editReply(guild ? await channelsView(guild, interaction.values[0]) : simpleView("❌ | السيرفر ما عاد موجود."));
            return;
        }

        if (id.startsWith("ms_chan:")) {
            await interaction.showModal(sendChannelModal(interaction.values[0]));
        }
    },

    async handleModal(interaction) {
        if (!isOwner(interaction)) {
            await interaction.reply({ content: "❌ | للمالك فقط!", ephemeral: true }).catch(() => {});
            return;
        }
        const client = interaction.client;
        const id = interaction.customId;

        if (interaction.isFromMessage()) await interaction.deferUpdate();
        else await interaction.deferReply({ ephemeral: true });

        // البحث عن شخص
        if (id === "ms_find") {
            const query = interaction.fields.getTextInputValue("query");
            const results = await searchUsers(client, query);

            if (results.length === 0) {
                await interaction.editReply(simpleView(`❌ | ما لقيت أحد باسم \`${query.slice(0, 50)}\` بالسيرفرات اللي البوت فيها.\nجرّب الـ ID.`));
            } else if (results.length === 1) {
                await interaction.editReply(await userView(client, results[0].user.id));
            } else {
                await interaction.editReply(userListView(results));
            }
            return;
        }

        // إرسال خاص
        if (id.startsWith("ms_send_dm:")) {
            const userId = id.split(":")[1];
            const text = interaction.fields.getTextInputValue("text");
            let notice;
            try {
                const user = await client.users.fetch(userId);
                await user.send({ content: text, allowedMentions: { parse: [] } });
                notice = "✅ | تم إرسال الرسالة بالخاص.";
            } catch (e) {
                notice = `❌ | ما قدرت أرسل (غالباً الخاص مقفول عنده): \`${e.message}\``;
            }
            await interaction.editReply(await userView(client, userId, notice));
            return;
        }

        // إرسال بروم سيرفر
        if (id.startsWith("ms_send_ch:")) {
            const channelId = id.split(":")[1];
            const text = interaction.fields.getTextInputValue("text");
            const mentionInput = interaction.fields.getTextInputValue("mention");

            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.guild) {
                await interaction.editReply(simpleView("❌ | الروم ما عاد موجود."));
                return;
            }

            const parsed = await parseMention(mentionInput, channel.guild);
            const again = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`ms_again:${channel.id}`).setLabel("رسالة ثانية لنفس الروم").setEmoji("✉️").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("ms_home").setLabel("الرئيسية | Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary)
            );
            const reply = txt => ({ embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setDescription(txt)], components: [again] });

            if (parsed.error) {
                await interaction.editReply(reply(parsed.error));
                return;
            }

            try {
                const content = (parsed.text ? `${parsed.text}\n` : "") + text;
                await channel.send({ content: content.slice(0, 2000), allowedMentions: parsed.allowed });
                await interaction.editReply(reply(`✅ | تم الإرسال إلى ${channel} بسيرفر **${channel.guild.name}**` + (parsed.text ? `\nالمنشن: ${parsed.text}` : "")));
            } catch (e) {
                await interaction.editReply(reply(`❌ | فشل الإرسال: \`${e.message}\``));
            }
        }
    }
};
