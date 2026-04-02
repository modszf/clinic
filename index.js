const ViberBot = require('viber-bot').Bot;
const Events = require('viber-bot').Events;
const { TextMessage, ImageMessage } = require('viber-bot').Message;
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const stream = require('stream');
const http = require('http');

/**
 * --- HARDCODED CONFIGURATION ---
 */
const CONFIG = {
    VIBER_TOKEN: "4c734c163a000c84-6a811e0772269375-6a99aeab3fb5d761",
    GEMINI_API_KEY: "AIzaSyAsgWKzI-gQgTea5ZnN1NJXURTX8DKkyG4",
    SHEET_ID: "1Hgb5QMdQPPCdHj37EiQdlfTLw4tjrUFHkogk2gp-nWo",
    DRIVE_FOLDER_ID: "0ANEyWUbLsliyUk9PVA",
    WEBHOOK_URL: "https://clinic-aungmyin.zocomputer.io",
    ALLOWED_USERS: [], 
    PORT: process.env.PORT || 3000
};

// --- Bot Initialization ---
const bot = new ViberBot({
    authToken: CONFIG.VIBER_TOKEN,
    name: "Aung Myin Clinic AI",
    avatar: "https://raw.githubusercontent.com/google/material-design-icons/master/png/action/receipt/mw24/1x/baseline_receipt_black_24dp.png"
});

const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json', 
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
});

// --- AI & Google Functions ---
async function analyzeVoucher(imageBuffer) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Analyze receipt. Return JSON: {is_voucher, vendor, date, category, total_amount, total_discount, net_total, foc_items, status, is_direct_paid, confidence_score}`;
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBuffer.toString('base64'), mimeType: "image/jpeg" } }
        ]);
        const responseText = result.response.text();
        return JSON.parse(responseText.replace(/```json|```/g, "").trim());
    } catch (e) { 
        console.error("AI Error:", e); 
        throw e; 
    }
}

async function uploadToDrive(imageBuffer, data) {
    const drive = google.drive({ version: 'v3', auth });
    const media = { mimeType: 'image/jpeg', body: stream.Readable.from(imageBuffer) };
    const file = await drive.files.create({ 
        resource: { name: `${data.vendor || 'Unknown'}_${Date.now()}.jpg`, parents: [CONFIG.DRIVE_FOLDER_ID] }, 
        media, fields: 'webViewLink' 
    });
    return file.data.webViewLink;
}

async function saveToSheet(data, userName) {
    const sheets = google.sheets({ version: 'v4', auth });
    const row = [
        data.date || new Date().toLocaleDateString(), 
        data.vendor || "Unknown", 
        "N/A", 
        data.category || "Other", 
        data.total_amount || 0, 
        data.total_discount || 0, 
        data.net_total || 0, 
        Array.isArray(data.foc_items) ? data.foc_items.join(", ") : (data.foc_items || ""), 
        data.is_direct_paid ? "Paid (Direct)" : (data.status || "Unpaid"), 
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

// --- Viber Event Listeners ---
bot.on(Events.MESSAGE_RECEIVED, async (message, response) => {
    const senderId = response.userProfile.id;
    const senderName = response.userProfile.name;
    
    console.log(`[VIBER_EVENT] Message from: ${senderName} | ID: ${senderId}`);
    
    // 1. Check for ID command first
    if (message instanceof TextMessage) {
        const text = message.text.toLowerCase().trim();
        if (text === "id" || text === "my id" || text === "get id") {
            console.log(`Sending ID back to ${senderName}`);
            return response.send(new TextMessage(`Hello ${senderName}!\n\nYour Viber ID is:\n${senderId}`));
        }
    }

    // 2. Handle Images
    if (message instanceof ImageMessage) {
        try {
            await response.send(new TextMessage("⚙️ AI Processing Voucher..."));
            const imgResponse = await axios.get(message.url, { responseType: 'arraybuffer' });
            const imgBuffer = Buffer.from(imgResponse.data);
            
            const aiData = await analyzeVoucher(imgBuffer);
            
            if (aiData.is_voucher === false) {
                return response.send(new TextMessage("❌ This doesn't look like a voucher."));
            }

            aiData.drive_url = await uploadToDrive(imgBuffer, aiData);
            await saveToSheet(aiData, senderName);
            
            response.send(new TextMessage(`✅ Saved to Sheets!\nVendor: ${aiData.vendor}\nTotal: ${aiData.net_total} MMK`));
        } catch (error) {
            console.error("Processing error:", error);
            response.send(new TextMessage("⚠️ Error processing voucher. Check logs."));
        }
    } else {
        // 3. Fallback help message
        response.send(new TextMessage(`Hi ${senderName}! Send a voucher photo or type 'id' to see your ID.`));
    }
});

// --- Server Startup ---
const server = http.createServer((req, res) => {
    // Health Check
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end("Aung Myin Bot is Alive and Running!");
    }

    // Viber Webhook Handling
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                // Critical: Viber SDK needs the raw body to validate HMAC signature
                req.rawBody = body; 
                console.log("POST request received from Viber");
                bot.middleware()(req, res);
            } catch (err) {
                console.error("Middleware Error:", err);
                res.writeHead(500);
                res.end();
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(CONFIG.PORT, () => {
    console.log(`Server started on port ${CONFIG.PORT}`);
    bot.setWebhook(CONFIG.WEBHOOK_URL)
        .then(() => console.log(`✅ Webhook registration attempt for: ${CONFIG.WEBHOOK_URL}`))
        .catch(err => {
            console.error("❌ Webhook Setup Failed!");
            console.error(err);
        });
});
