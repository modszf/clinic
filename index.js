const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const stream = require('stream');

/**
 * --- CONFIGURATION ---
 * Replace TELEGRAM_TOKEN and ALLOWED_USER_ID with your new details.
 */
const CONFIG = {
    TELEGRAM_TOKEN: "6076763989:AAEw6e6E3wff3L7iBRlA5HDoOuMnVBi-cWE", // From @BotFather
    ALLOWED_USER_ID: 5857288178, // Your Telegram ID (e.g., 123456789) from @userinfobot
    GEMINI_API_KEY: "AIzaSyAsgWKzI-gQgTea5ZnN1NJXURTX8DKkyG4",
    SHEET_ID: "1Hgb5QMdQPPCdHj37EiQdlfTLw4tjrUFHkogk2gp-nWo",
    DRIVE_FOLDER_ID: "1dpfbjx34gxZ-XjFvilcNgXzvR2WJWHio"
};

// --- Initialization ---
const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json', 
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
});

// --- AI Analysis Logic ---
async function analyzeVoucher(imageBuffer) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analyze this receipt image. Return ONLY a JSON object.
        {
            "is_voucher": boolean,
            "vendor": "string",
            "date": "string",
            "category": "Medicine" | "Food" | "Office" | "Other",
            "total_amount": number,
            "net_total": number,
            "status": "Paid" | "Unpaid"
        }`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBuffer.toString('base64'), mimeType: "image/jpeg" } }
        ]);
        
        const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
        return JSON.parse(cleanJson);
    } catch (e) {
        console.error("AI Error:", e);
        throw e;
    }
}

// --- Google Drive Upload ---
async function uploadToDrive(imageBuffer, vendor) {
    const drive = google.drive({ version: 'v3', auth });
    const media = { mimeType: 'image/jpeg', body: stream.Readable.from(imageBuffer) };
    const file = await drive.files.create({ 
        resource: { name: `${vendor || 'Voucher'}_${Date.now()}.jpg`, parents: [CONFIG.DRIVE_FOLDER_ID] }, 
        media, fields: 'webViewLink' 
    });
    return file.data.webViewLink;
}

// --- Google Sheets Save ---
async function saveToSheet(data, userName) {
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [
        data.date || new Date().toLocaleDateString(),
        data.vendor || "Unknown",
        "N/A",
        data.category || "Other",
        data.total_amount || 0,
        0, // Discount
        data.net_total || 0,
        "-", // FOC
        data.status || "Unpaid",
        data.drive_url || "",
        userName,
        new Date().toLocaleString()
    ];
    await sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SHEET_ID,
        range: 'Sheet1!A:L',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] },
    });
}

// --- Telegram Bot Logic ---

// Security Middleware
bot.use((ctx, next) => {
    if (CONFIG.ALLOWED_USER_ID !== 0 && ctx.from.id !== CONFIG.ALLOWED_USER_ID) {
        return ctx.reply(`🚫 Access Denied. Your ID is: ${ctx.from.id}`);
    }
    return next();
});

bot.start((ctx) => ctx.reply('🏥 Aung Myin Clinic Bot (Telegram Edition)\nSend me a photo of a voucher to save it!'));

bot.on('photo', async (ctx) => {
    try {
        await ctx.reply('⚙️ AI is analyzing the voucher...');
        
        // Get high-res photo link from Telegram
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        
        // Download image
        const imgResponse = await axios.get(link.href, { responseType: 'arraybuffer' });
        const imgBuffer = Buffer.from(imgResponse.data);

        // Analyze with Gemini
        const aiData = await analyzeVoucher(imgBuffer);
        
        if (!aiData.is_voucher) {
            return ctx.reply('❌ Image not recognized as a voucher.');
        }

        // Upload and Save
        aiData.drive_url = await uploadToDrive(imgBuffer, aiData.vendor);
        await saveToSheet(aiData, ctx.from.first_name);

        ctx.reply(`✅ Saved to Sheets!\n\n🏪 Vendor: ${aiData.vendor}\n💰 Amount: ${aiData.net_total.toLocaleString()} MMK\n📂 Category: ${aiData.category}`);
        
    } catch (error) {
        console.error(error);
        ctx.reply('⚠️ Error processing the voucher. Please check the logs.');
    }
});

bot.launch().then(() => console.log('🚀 Telegram Bot Started!'));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
