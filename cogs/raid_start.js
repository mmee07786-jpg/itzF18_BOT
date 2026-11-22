const {
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../clan_config.json');
const DATA_FILE = path.join(__dirname, '../raid_data.json');
const MAX_BANNER_SIZE = 8 * 1024 * 1024; // 8MB

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (e) {
            return { clan_name: "VLX", embed_color: 0x8B0000 };
        }
    }
    return { clan_name: "VLX", embed_color: 0x8B0000 };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf8');
}

function loadRaidData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const gid = Object.keys(data)[0];
            if (gid && data[gid] && typeof data[gid] === 'object' && data[gid].raider_stats) {
                return data[gid];
            }
            return data.raider_stats ? data : { raider_stats: {}, win_streak: 0 };
        } catch (e) {
            return { raider_stats: {}, win_streak: 0 };
        }
    }
    return { raider_stats: {}, win_streak: 0 };
}

// مسار الصورة الدائمة (محفوظة كملف محلي لأن روابط ديسكورد تنتهي صلاحيتها)
function getBannerPath(config) {
    if (!config.banner_file) return null;
    const p = path.join(__dirname, '..', path.basename(config.banner_file));
    return fs.existsSync(p) ? p : null;
}

function clip(text) {
    return `\`${String(text).replace(/`/g, "'").slice(0, 1000)}\``;
}

class RaidStartModal extends ModalBuilder {
    constructor() {
        super();
        this.setTitle("⚔️ | Raid Start & Announcement").setCustomId("raid_start_modal");

        const serverLink = new TextInputBuilder().setCustomId("server_link").setLabel("Server Link").setStyle(TextInputStyle.Short).setRequired(true);
        const difficulty = new TextInputBuilder().setCustomId("difficulty").setLabel("Difficulty").setStyle(TextInputStyle.Short).setRequired(true);
        const targets = new TextInputBuilder().setCustomId("targets").setLabel("Targets / Matchup").setStyle(TextInputStyle.Short).setRequired(true);
        const counts = new TextInputBuilder().setCustomId("counts").setLabel("Our Count & Their Count").setStyle(TextInputStyle.Short).setRequired(true);
        const region = new TextInputBuilder().setCustomId("region").setLabel("Region").setStyle(TextInputStyle.Short).setRequired(true);

        this.addComponents(
            new ActionRowBuilder().addComponents(serverLink),
            new ActionRowBuilder().addComponents(difficulty),
            new ActionRowBuilder().addComponents(targets),
            new ActionRowBuilder().addComponents(counts),
            new ActionRowBuilder().addComponents(region)
        );
    }
}

module.exports = {
    async handleRaidStartModalSubmit(interaction, serverLink, difficulty, targets, counts, region) {
        await interaction.deferReply({ ephemeral: true });

        try {
            // تنظيف رابط السيرفر (زر الرابط يرفض أي شي مو رابط صحيح)
            let link = String(serverLink).trim();
            if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
            try {
                new URL(link);
            } catch (e) {
                await interaction.editReply({ content: "❌ | رابط السيرفر غير صحيح! اكتب رابط كامل مثل `https://...`" });
                return;
            }

            const config = loadConfig();
            const clan = config.clan_name || "VLX";
            const embedColor = config.embed_color || 0x8B0000;

            const embed = new EmbedBuilder()
                .setTitle("NEW RAID")
                .setColor(embedColor)
                .addFields(
                    { name: "⚔️ Difficulty", value: clip(difficulty), inline: false },
                    { name: "🎯 Targets", value: clip(targets), inline: false },
                    { name: "🔢 Our Count & Their Count", value: clip(counts), inline: false },
                    { name: "📡 Region", value: `🌍 ${clip(region)}`, inline: false },
                    {
                        name: "📜 Instructions",
                        value: "→ Click **Join** below to enter the server\n→ Click **Leaderboard** to check top active raiders\n→ Follow callouts from raid leadership\n→ Stay until the raid is concluded",
                        inline: false
                    }
                );

            // الصورة الدائمة (تنحط بأمر /set-img-raid-start)
            const files = [];
            const bannerPath = getBannerPath(config);
            if (bannerPath) {
                const attachName = `raid_banner${path.extname(bannerPath)}`;
                files.push(new AttachmentBuilder(bannerPath, { name: attachName }));
                embed.setImage(`attachment://${attachName}`);
            }

            embed.setFooter({ text: `Raid Initiated by ${interaction.user.tag} | ${clan} Clan` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel("Join").setStyle(ButtonStyle.Link).setURL(link).setEmoji("🎮"),
                new ButtonBuilder().setCustomId("show_leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary).setEmoji("🏆")
            );

            const channel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId);
            await channel.send({
                content: "@here 🔔 **New Raid Notification:**",
                embeds: [embed],
                components: [row],
                files
            });
            await interaction.deleteReply().catch(() => {});
        } catch (e) {
            console.error("خطأ في raid-start:", e);
            await interaction.editReply({ content: `❌ | فشل نشر الإعلان: \`${e.message}\`` }).catch(() => {});
        }
    },

    raidStartCommand: new SlashCommandBuilder()
        .setName('raid-start')
        .setDescription('[ Admin Only ] Start a raid with announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    setImgRaidStartCommand: new SlashCommandBuilder()
        .setName('set-img-raid-start')
        .setDescription('[ Admin Only ] تعيين صورة إعلان الرايد (تبقى دائمية مع كل raid-start)')
        .addAttachmentOption(o => o.setName('image').setDescription('الصورة أو الـ GIF اللي تطلع تحت الإعلان').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    nameClanCommand: new SlashCommandBuilder()
        .setName('name_clan')
        .setDescription('[ Admin Only ] تعيين اسم الكلان الظهور بإعلانات الرايد')
        .addStringOption(o => o.setName('name').setDescription('اكتب اسم الكلان الجديد').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    colorEmedCommand: new SlashCommandBuilder()
        .setName('color_emed')
        .setDescription('[ Admin Only ] تغيير لون شريط إعلان الرايد')
        .addStringOption(o => o.setName('hex_code').setDescription('اكتب كود اللون (مثل #FF0000)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async handleRaidStart(interaction) {
        await interaction.showModal(new RaidStartModal());
    },

    async handleSetImgRaidStart(interaction) {
        const attachment = interaction.options.getAttachment('image');
        const type = attachment.contentType || "";

        if (!type.startsWith('image/')) {
            await interaction.reply({ content: "❌ | لازم ترفع صورة (PNG / JPG / GIF / WEBP)!", ephemeral: true });
            return;
        }
        if (attachment.size > MAX_BANNER_SIZE) {
            await interaction.reply({ content: "❌ | حجم الصورة كبير، الحد الأقصى 8MB.", ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const res = await fetch(attachment.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());

            const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
            const ext = extMap[type.split(';')[0]] || path.extname(attachment.name || '') || '.png';
            const fileName = `raid_start_banner${ext}`;

            const config = loadConfig();

            // حذف الصورة القديمة لو بامتداد مختلف
            if (config.banner_file && config.banner_file !== fileName) {
                const old = path.join(__dirname, '..', path.basename(config.banner_file));
                if (fs.existsSync(old)) fs.unlinkSync(old);
            }

            fs.writeFileSync(path.join(__dirname, '..', fileName), buffer);
            config.banner_file = fileName;
            saveConfig(config);

            await interaction.editReply({
                content: "✅ | تم حفظ الصورة بشكل دائمي، راح تطلع تحت كل `/raid-start` (هذي معاينة):",
                files: [new AttachmentBuilder(buffer, { name: `preview${ext}` })]
            });
        } catch (e) {
            console.error("خطأ في set-img-raid-start:", e);
            await interaction.editReply({ content: `❌ | فشل حفظ الصورة: \`${e.message}\`` }).catch(() => {});
        }
    },

    async handleNameClan(interaction) {
        const name = interaction.options.getString('name') || "VLX";
        const config = loadConfig();
        config.clan_name = name;
        saveConfig(config);
        await interaction.reply({ content: `✅ | تم تحديث اسم الكلان بنجاح إلى: **${name}**`, ephemeral: true });
    },

    async handleColorEmed(interaction) {
        const hexCode = interaction.options.getString('hex_code').trim();
        const cleanedCode = hexCode.startsWith("#") ? hexCode.substring(1) : hexCode;

        let colorInt;
        try {
            colorInt = parseInt(cleanedCode, 16);
            if (isNaN(colorInt)) throw new Error();
        } catch (e) {
            await interaction.reply({ content: "❌ | كود اللون غير صحيح! استخدم صيغة صحيحة مثل `#FF0000`.", ephemeral: true });
            return;
        }

        const config = loadConfig();
        config.embed_color = colorInt;
        saveConfig(config);
        await interaction.reply({ content: `✅ | تم تحديث لون إعلان الرايد بنجاح إلى \`#${cleanedCode}\``, ephemeral: true });
    },

    async handleButtonInteraction(interaction) {
        if (interaction.customId === "show_leaderboard") {
            const data = loadRaidData();
            const stats = data.raider_stats || {};

            if (Object.keys(stats).length === 0) {
                await interaction.reply({ content: "❌ | No raid statistics recorded yet!", ephemeral: true });
                return;
            }

            const sortedRaiders = Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 10);

            let description = "";
            for (let i = 0; i < sortedRaiders.length; i++) {
                const [uid, count] = sortedRaiders[i];
                const index = i + 1;
                const member = await interaction.guild.members.fetch(uid).catch(() => null);
                const name = member ? member.toString() : `<@${uid}>`;
                const medal = index === 1 ? "🥇" : index === 2 ? "🥈" : index === 3 ? "🥉" : `#${index}`;
                description += `${medal} ${name} ──> **${count}** Raids\n`;
            }

            const config = loadConfig();
            const lbEmbed = new EmbedBuilder()
                .setTitle("🏆 | Clan Top Raiders (Leaderboard)")
                .setDescription(description)
                .setColor(config.embed_color || 0x8B0000)
                .setFooter({ text: "Clan Statistics" });

            await interaction.reply({ embeds: [lbEmbed], ephemeral: true });
        }
    }
};
