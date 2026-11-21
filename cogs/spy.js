const { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    PermissionFlagsBits,
    AttachmentBuilder
} = require('discord.js');

const OWNER_ID = "1107355943408259112";
const MEMORY_TIMEOUT = 3600 * 1000;
const MAX_HISTORY = 20; // آخر 20 رسالة فقط

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = "https://generativelanguage.googleapis.com";

// حدود المرفقات
const MAX_IMAGES = 4;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024;       // 15MB للصورة
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;      // 100MB للفيديو
const INLINE_VIDEO_LIMIT = 10 * 1024 * 1024;   // أصغر من 10MB نرسله مباشرة، وغير كذا نرفعه لـ Files API
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'];

// Node 18+ عنده fetch جاهز. إذا نسخة أقدم، نحاول node-fetch كبديل.
let fetchFn = (typeof fetch === 'function') ? fetch : null;
if (!fetchFn) {
    try { fetchFn = require('node-fetch'); } catch (e) { fetchFn = null; }
}

const userMemory = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ───────────────────────── نظام الموديلات ─────────────────────────
// نسأل غوغل عن الموديلات الشغالة بهذا المفتاح، ونختار 3 منها ونتناوب بينها.

// قائمة احتياطية لو تعذر جلب القائمة
const FALLBACK_MODELS = [
    "gemini-2.5-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-pro"
];

let modelPoolCache = { models: [], ts: 0 };
const MODEL_POOL_TTL = 60 * 60 * 1000; // ساعة
let rrIndex = 0;

// موديلات ثبت إنها ميتة نهائياً (404) بهذا التشغيل
const deadModels = new Set();

async function getModelPool() {
    const now = Date.now();
    const cachedAlive = modelPoolCache.models.filter(m => !deadModels.has(m));
    if (cachedAlive.length > 0 && (now - modelPoolCache.ts) < MODEL_POOL_TTL) {
        return cachedAlive;
    }

    try {
        const res = await fetchFn(`${GEMINI_BASE}/v1beta/models?key=${GEMINI_API_KEY}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // نستبعد الموديلات اللي ما تنفع للمحادثة النصية (صوت، صور، فيديو، لايف، تضمين...)
        const EXCLUDE = /embedding|vision|aqa|tts|image|imagen|veo|lyria|live|audio|omni|robotics|transcribe|translate|research|computer-use|antigravity|banana|gemma/i;

        const usable = (data.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
            .map(m => m.name.replace(/^models\//, ""))
            .filter(n => !EXCLUDE.test(n));

        // flash أول، وبعدها النسخ المستقرة قبل preview/exp
        const rank = n => (/flash/i.test(n) ? 0 : 2) + (/preview|exp/i.test(n) ? 1 : 0);
        const sorted = [...new Set(usable)].sort((a, b) => rank(a) - rank(b));

        const pool = sorted.filter(n => !deadModels.has(n)).slice(0, 3);
        if (pool.length > 0) {
            modelPoolCache = { models: pool, ts: now };
            console.log(`ℹ️ موديلات الذكاء الاصطناعي الشغالة حالياً: ${pool.join(", ")}`);
            return pool;
        }
    } catch (e) {
        console.log(`⚠️ تعذر جلب قائمة الموديلات من غوغل: ${e.message}`);
    }

    const lastKnown = modelPoolCache.models.filter(m => !deadModels.has(m));
    if (lastKnown.length > 0) return lastKnown;
    const fallback = FALLBACK_MODELS.filter(m => !deadModels.has(m));
    return fallback.length > 0 ? fallback : [...FALLBACK_MODELS];
}

// نداء مباشر لـ REST API - يدعم نص + صور + فيديو
async function callGemini(modelName, systemInstruction, history, userParts) {
    const url = `${GEMINI_BASE}/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [...history, { role: "user", parts: userParts }]
    };

    const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status} :: ${errText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!text) throw new Error("NO_CONTENT");
    return text;
}

// ───────────────────────── رفع الفيديوهات الكبيرة (Files API) ─────────────────────────

async function uploadToGemini(buffer, mimeType, displayName) {
    const startRes = await fetchFn(`${GEMINI_BASE}/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(buffer.length),
            "X-Goog-Upload-Header-Content-Type": mimeType,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ file: { display_name: displayName } })
    });
    if (!startRes.ok) throw new Error(`UPLOAD_START_HTTP_${startRes.status}`);

    const uploadUrl = startRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("NO_UPLOAD_URL");

    const upRes = await fetchFn(uploadUrl, {
        method: "POST",
        headers: {
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize"
        },
        body: buffer
    });
    if (!upRes.ok) throw new Error(`UPLOAD_HTTP_${upRes.status}`);

    let file = (await upRes.json()).file;

    // ننتظر لين يخلص غوغل معالجة الفيديو
    for (let i = 0; i < 60 && file && file.state === "PROCESSING"; i++) {
        await sleep(3000);
        const r = await fetchFn(`${GEMINI_BASE}/v1beta/${file.name}?key=${GEMINI_API_KEY}`);
        if (!r.ok) throw new Error(`FILE_POLL_HTTP_${r.status}`);
        file = await r.json();
    }

    if (!file || file.state !== "ACTIVE") throw new Error(`FILE_${file ? file.state : "UNKNOWN"}`);
    return file;
}

async function deleteGeminiFile(file) {
    try {
        await fetchFn(`${GEMINI_BASE}/v1beta/${file.name}?key=${GEMINI_API_KEY}`, { method: "DELETE" });
    } catch (e) {}
}

// ───────────────────────── الفيديو: المدة والوقت المتوقع ─────────────────────────

// قراءة مدة الفيديو من هيدر MP4/MOV (صندوق mvhd). يرجع بالثواني أو null
function parseVideoDuration(buf) {
    try {
        const idx = buf.indexOf('mvhd');
        if (idx < 4) return null;
        const version = buf[idx + 4];
        let timescale, duration;
        if (version === 1) {
            timescale = buf.readUInt32BE(idx + 24);
            duration = Number(buf.readBigUInt64BE(idx + 28));
        } else {
            timescale = buf.readUInt32BE(idx + 16);
            duration = buf.readUInt32BE(idx + 20);
        }
        if (!timescale) return null;
        const seconds = duration / timescale;
        return (seconds > 0 && seconds < 86400) ? seconds : null;
    } catch (e) {
        return null;
    }
}

function formatDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec} ثانية`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} دقيقة و ${s} ثانية` : `${m} دقيقة`;
}

// الوقت المتوقع للتحليل حسب مدة الفيديو
function waitText(sec) {
    if (sec == null) return "حوالي دقيقة أو أكثر";
    if (sec <= 10) return "حوالي 30 ثانية";
    if (sec <= 60) return "حوالي دقيقة";
    if (sec <= 180) return "حوالي دقيقتين";
    if (sec <= 300) return "حوالي 3 دقائق";
    if (sec <= 600) return "حوالي 5 دقائق";
    return "أكثر من 10 دقائق";
}

// ───────────────────────── الكود كملفات ─────────────────────────

const EXT_MAP = {
    js: '.js', javascript: '.js', node: '.js', mjs: '.mjs', jsx: '.jsx',
    ts: '.ts', typescript: '.ts', tsx: '.tsx',
    py: '.py', python: '.py',
    java: '.java', kt: '.kt', kotlin: '.kt', swift: '.swift',
    c: '.c', cpp: '.cpp', 'c++': '.cpp', cs: '.cs', csharp: '.cs', 'c#': '.cs',
    go: '.go', rust: '.rs', rs: '.rs', php: '.php', rb: '.rb', ruby: '.rb', dart: '.dart',
    lua: '.lua', luau: '.lua',
    html: '.html', css: '.css', scss: '.scss',
    json: '.json', yaml: '.yml', yml: '.yml', xml: '.xml', toml: '.toml',
    sh: '.sh', bash: '.sh', shell: '.sh', powershell: '.ps1', ps1: '.ps1', bat: '.bat',
    sql: '.sql', md: '.md', markdown: '.md', r: '.r', txt: '.txt'
};

function sanitizeFileName(name) {
    return String(name).replace(/[^\w.\-]/g, '_').slice(0, 60);
}

// يستخرج كتل الكود من رد الذكاء الاصطناعي ويحوّلها لملفات
function extractCodeFiles(text) {
    const files = [];
    const usedNames = new Set();
    let out = "";
    let last = 0;
    let n = 0;
    const re = /```([\w+#.\-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let m;

    while ((m = re.exec(text)) !== null) {
        let before = text.slice(last, m.index);
        let wantedName = null;

        // سطر اسم الملف قبل الكتلة: FILE: name.ext
        const fm = before.match(/(?:^|\n)[ \t]*(?:FILE|File|file|ملف)\s*:\s*`?([^\s`]+)`?[ \t]*\n?\s*$/);
        if (fm) {
            wantedName = fm[1];
            before = before.slice(0, fm.index);
            if (before && !before.endsWith("\n")) before += "\n";
        }

        const content = m[2];
        last = re.lastIndex;
        if (!content.trim()) { out += before; continue; }

        n++;
        const lang = (m[1] || "").toLowerCase();
        const ext = EXT_MAP[lang] || '.txt';

        let name = wantedName ? sanitizeFileName(wantedName) : `code_${n}${ext}`;
        if (!/\.\w+$/.test(name)) name += ext;
        while (usedNames.has(name)) name = `${n}_${name}`;
        usedNames.add(name);

        files.push({ name, content });
        out += before + `📎 \`${name}\``;
    }

    out += text.slice(last);
    return { text: out.trim(), files: files.slice(0, 10) };
}

// إرسال الرد: النص برسالة، والكود ملفات
async function sendReply(message, replyText) {
    const { text, files } = extractCodeFiles(replyText);
    const attachments = files.map(f => new AttachmentBuilder(Buffer.from(f.content, 'utf8'), { name: f.name }));

    let content = text;
    if (content.length > 1900 && attachments.length < 10) {
        attachments.push(new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: 'answer.txt' }));
        content = "📎 الرد طويل، موجود بالملف المرفق.";
    } else if (content.length > 1900) {
        content = content.substring(0, 1897) + "...";
    }
    if (!content) content = "📎 تفضل، الكود بالملف المرفق:";

    try {
        await message.reply({ content, files: attachments, allowedMentions: { parse: [], repliedUser: true } });
    } catch (e) {
        console.log(`⚠️ فشل إرسال الرد: ${e.message}`);
        if (attachments.length > 0) {
            await message.reply("❌ ما قدرت أرفق الملفات. تأكد إن عندي صلاحية **Attach Files** بهذي القناة.").catch(() => {});
        }
    }
}

// ───────────────────────── المرفقات ─────────────────────────

async function downloadBuffer(url) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`DOWNLOAD_HTTP_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// يجمع الصور والفيديو من الرسالة (أو من الرسالة اللي ردّ عليها لو ما فيها مرفقات)
async function collectMedia(message) {
    const sources = [message];
    if (message.attachments.size === 0 && message.reference?.messageId) {
        const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (ref) sources.push(ref);
    }

    const images = [];
    let video = null;
    const notes = [];

    for (const src of sources) {
        for (const att of src.attachments.values()) {
            const type = (att.contentType || "").split(";")[0].toLowerCase();

            if (type === 'image/gif') {
                notes.push("ملفات GIF غير مدعومة، أرسلها كصورة أو فيديو.");
            } else if (IMAGE_TYPES.includes(type)) {
                if (att.size > MAX_IMAGE_SIZE) notes.push(`الصورة ${att.name} كبيرة (الحد 15MB).`);
                else if (images.length < MAX_IMAGES) images.push(att);
            } else if (type.startsWith('video/')) {
                if (video) continue; // فيديو واحد بالمرة
                if (att.size > MAX_VIDEO_SIZE) notes.push(`الفيديو ${att.name} كبير (الحد 100MB).`);
                else video = att;
            }
        }
    }
    return { images, video, notes };
}

function startTyping(channel) {
    channel.sendTyping().catch(() => {});
    const id = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
    return () => clearInterval(id);
}

const SYSTEM_INSTRUCTION = (
    "أنت ذكاء اصطناعي تتصرف بصفتك ذكر واسمك (itzF18). " +
    "تحدث دائماً بصيغة المذكر. " +
    "تفاعل باللهجة العراقية أو العربية أو الإنجليزية حسب لغة المستخدم. " +
    "ممنوع استخدام أي ألفاظ بذيئة أو شتائم. " +
    "لا تذكر اسمك (itzF18) ولا اسم من برمجك (فهد) إطلاقاً في ردودك العادية، ولا تفتتح أو تختم أي رد بذكرهم. " +
    "اذكر فقط إذا سألك الشخص بشكل مباشر وصريح من أنت أو من برمجك/صنعك (مثل: منو انت؟ شنو اسمك؟ منو صنعك؟ منو برمجك؟)، وبهذي الحالة فقط قول إن اسمك itzF18 وإن اللي برمجك وصنعك هو فهد. " +
    "إذا أرسل المستخدم صورة أو فيديو، حلله بدقة وصف ما تراه وأجب عن سؤاله بخصوصه. " +
    "عند طلب كود برمجي: اكتب الكود كاملاً وجاهزاً للتشغيل داخل كتل كود markdown مع تحديد اللغة (مثل ```python)، " +
    "كتلة واحدة لكل ملف، وضع قبل كل كتلة سطراً بالشكل FILE: اسم_الملف.امتداد. " +
    "ممنوع كتابة أي كود خارج كتل الكود. اجعل الشرح قصيراً ومختصراً."
);

module.exports = {
    serversCommand: new SlashCommandBuilder()
        .setName('spy')
        .setDescription('[خاص بالمالك] اختيار سيرفر: جلب رابط الدعوة أو مغادرته'),

    async handleReady(client) {
        console.log("🚀 | Cog Spy شغال بنجاح.");
    },

    async handleServersCommand(message, client) {
        if (message.author.id !== OWNER_ID) return;

        if (client.guilds.cache.size === 0) {
            await message.channel.send("عيوني فهد، أنا لست منضماً إلى أي سيرفر حالياً.");
            return;
        }

        const guilds = Array.from(client.guilds.cache.values()).slice(0, 25);
        const options = guilds.map(g => ({
            label: g.name.substring(0, 100),
            value: g.id,
            description: `الأعضاء: ${g.memberCount}`
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("spy_server_select")
            .setPlaceholder("اختر السيرفر...")
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setTitle("🏰 | اختيار سيرفر")
            .setDescription("اختر السيرفر من القائمة أدناه للحصول على رابط دعوته أو مغادرته:")
            .setColor(0x2b2d31);

        const sentMsg = await message.channel.send({ embeds: [embed], components: [row] });
        setTimeout(() => sentMsg.delete().catch(() => {}), 180 * 1000);
    },

    async handleInteraction(interaction, client) {
        if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
        const customId = interaction.customId;

        if (customId === "spy_server_select") {
            if (interaction.user.id !== OWNER_ID) {
                await interaction.reply({ content: "عذراً، هذا الأمر خاص بفهد فقط!", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });
            const guildId = interaction.values[0];
            const guild = client.guilds.cache.get(guildId);

            if (!guild) {
                await interaction.editReply({ content: "❌ لم يتم العثور على السيرفر المطلوب." });
                return;
            }

            let inviteLink = "تعذر إنشاء رابط دعوة (تحقق من صلاحية البوت: Create Invite)";
            try {
                for (const channel of guild.channels.cache.values()) {
                    if (channel.isTextBased() && channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
                        const invite = await channel.createInvite({ maxAge: 86400, maxUses: 0, unique: true });
                        inviteLink = invite.url;
                        break;
                    }
                }
            } catch (e) {
                console.log(`⚠️ تعذر إنشاء رابط دعوة: ${e.message}`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`🏰 ${guild.name}`)
                .setDescription(
                    `👥 **الأعضاء:** ${guild.memberCount}\n` +
                    `🔗 **رابط الدعوة:** ${inviteLink}`
                )
                .setColor(0x2b2d31);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`spy_leave_${guild.id}`)
                    .setLabel("مغادرة السيرفر")
                    .setStyle(ButtonStyle.Danger)
            );

            await interaction.editReply({ embeds: [embed], components: [row] });
        }

        else if (customId.startsWith("spy_leave_")) {
            if (interaction.user.id !== OWNER_ID) {
                await interaction.reply({ content: "عذراً، هذا الزر مخصص للأونر فقط!", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });
            const guildId = customId.split("_")[2];
            const guild = client.guilds.cache.get(guildId);

            if (!guild) {
                await interaction.editReply({ content: "❌ السيرفر غير موجود." });
                return;
            }

            const name = guild.name;
            try {
                await guild.leave();
                await interaction.editReply({ content: `✅ تم مغادرة السيرفر (**${name}**) بنجاح.` });
            } catch (e) {
                await interaction.editReply({ content: `❌ حدث خطأ أثناء المغادرة: ${e.message}` });
            }
        }
    },

    async handleMessage(message, client) {
        if (message.author.bot) return;

        const isDM = !message.guild;
        const isMentioned = message.mentions.has(client.user) && !message.mentions.everyone;
        if (!isDM && !isMentioned) return;

        const cleanPrompt = message.content
            .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), "")
            .trim();

        const media = await collectMedia(message);

        if (!cleanPrompt && media.images.length === 0 && !media.video) {
            await message.reply(media.notes.length ? `❌ ${media.notes.join("\n")}` : "هلا بيك! شكو ماكو؟");
            return;
        }

        if (!GEMINI_API_KEY || !fetchFn) {
            await message.reply("❌ مفتاح GEMINI_API_KEY غير معرف في إعدادات الاستضافة (أو fetch غير متوفر)!");
            return;
        }

        const stopTyping = startTyping(message.channel);
        let statusMsg = null;
        let uploadedFile = null;

        try {
            // ───── الذاكرة ─────
            const userId = message.author.id;
            const currentTime = Date.now();
            if (userMemory.has(userId) && currentTime - userMemory.get(userId).time > MEMORY_TIMEOUT) {
                userMemory.delete(userId);
            }
            if (!userMemory.has(userId)) {
                userMemory.set(userId, { history: [], time: currentTime });
            } else {
                userMemory.get(userId).time = currentTime;
            }
            const memoryObj = userMemory.get(userId);

            // ───── تجهيز أجزاء الرسالة (صور + فيديو + نص) ─────
            const userParts = [];

            for (const att of media.images) {
                try {
                    const buf = await downloadBuffer(att.url);
                    userParts.push({
                        inlineData: {
                            data: buf.toString("base64"),
                            mimeType: (att.contentType || "image/png").split(";")[0]
                        }
                    });
                } catch (e) {
                    console.log(`⚠️ خطأ بتحميل الصورة: ${e.message}`);
                }
            }

            if (media.video) {
                const videoBuf = await downloadBuffer(media.video.url);
                const duration = parseVideoDuration(videoBuf);
                const mime = (media.video.contentType || "video/mp4").split(";")[0];

                statusMsg = await message.reply(
                    `🎬 | استلمت الفيديو${duration ? ` (مدته ${formatDuration(duration)})` : ""}، راح أحلله وأرد عليك.\n` +
                    `⏳ المدة المتوقعة: **${waitText(duration)}**`
                ).catch(() => null);

                if (videoBuf.length <= INLINE_VIDEO_LIMIT) {
                    userParts.push({ inlineData: { data: videoBuf.toString("base64"), mimeType: mime } });
                } else {
                    uploadedFile = await uploadToGemini(videoBuf, mime, media.video.name || "video");
                    userParts.push({ fileData: { mimeType: mime, fileUri: uploadedFile.uri } });
                }
            }

            const defaultPrompt = media.video
                ? "لخّص هذا الفيديو واشرح ما يحدث فيه بالتفصيل."
                : "اوصف هذه الصورة وحللها.";
            const currentInput = cleanPrompt || defaultPrompt;
            userParts.push({ text: currentInput });

            const historyText = currentInput
                + (media.images.length ? ` [أرفق ${media.images.length} صورة]` : "")
                + (media.video ? " [أرفق فيديو]" : "");

            // ───── الموديلات ─────
            let replyText = null;
            let busyError = false;

            const pool = await getModelPool();
            const startIdx = rrIndex % pool.length;
            rrIndex++;
            const orderedModels = [...pool.slice(startIdx), ...pool.slice(0, startIdx)];

            for (let i = 0; i < orderedModels.length; i++) {
                const modelName = orderedModels[i];
                try {
                    const text = await callGemini(modelName, SYSTEM_INSTRUCTION, memoryObj.history, userParts);
                    replyText = text.trim();

                    if (replyText) {
                        memoryObj.history.push({ role: 'user', parts: [{ text: historyText }] });
                        memoryObj.history.push({ role: 'model', parts: [{ text: replyText }] });
                        if (memoryObj.history.length > MAX_HISTORY) {
                            memoryObj.history = memoryObj.history.slice(-MAX_HISTORY);
                        }
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ فشل الموديل ${modelName}: ${e.message}`);
                    if (e.status === 503 || e.status === 429) busyError = true;
                    if (e.status === 404) deadModels.add(modelName);
                    if (i < orderedModels.length - 1) await sleep(400);
                    continue;
                }
            }

            if (statusMsg) { await statusMsg.delete().catch(() => {}); statusMsg = null; }

            if (replyText) {
                await sendReply(message, replyText);
            } else if (busyError) {
                await message.reply("الخدمة مزدحمة حالياً من طرف غوغل، جرب بعد شوي. 🙏");
            } else {
                await message.reply("حدث خطأ في الاتصال بالذكاء الاصطناعي، تأكد من صحة المفتاح.");
            }
        } catch (e) {
            console.error("خطأ في الذكاء الاصطناعي:", e);
            if (statusMsg) await statusMsg.delete().catch(() => {});
            await message.reply(`❌ صار خطأ أثناء معالجة طلبك: \`${String(e.message).slice(0, 150)}\``).catch(() => {});
        } finally {
            stopTyping();
            if (uploadedFile) deleteGeminiFile(uploadedFile);
        }
    }
};
