const ViberBot = require('viber-bot').Bot;
const Events = require('viber-bot').Events;
const { TextMessage, ImageMessage } = require('viber-bot').Message;
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const stream = require('stream');

/**
 * --- HARDCODED CONFIGURATION ---
 * Credentials for Aung Myin Clinic.
 */
const CONFIG = {
    VIBER_TOKEN: "4c734c163a000c84-6a811e0772269375-6a99aeab3fb5d761",
    GEMINI_API_KEY: "AIzaSyAsgWKzI-gQgTea5ZnN1NJXURTX8DKkyG4",
    SHEET_ID: "1Hgb5QMdQPPCdHj37EiQdlfTLw4tjrUFHkogk2gp-nWo",
    DRIVE_FOLDER_ID: "0ANEyWUbLsliyUk9PVA",
    WEBHOOK_URL: "https://clinic-aungmyin.zocomputer.io",
    ALLOWED_USERS: [], // Replace with your Viber ID from the terminal log to secure the bot
    PORT: 3000
};

// --- Bot & AI Initialization ---
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

const userState = new Map(); 
const pendingVouchers = new Map();

/**
 * AI Logic: Extracts data from images using Gemini 1.5 Flash
 */
async function analyzeVoucher(imageBuffer) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `
        Analyze this receipt and return ONLY a JSON object.
        JSON Schema:
        {
            "is_voucher": boolean,
            "vendor": "string",
            "date": "string",
            "category": "Medicine" | "Office" | "Food" | "Transport" | "Utility" | "Other",
            "total_amount": number,
            "total_discount": number,
            "net_total": number,
            "foc_items": ["string"],
            "status": "Paid" | "Unpaid",
            "is_direct_paid": boolean,
            "confidence_score": number
        }
        Instructions:
        - Detect "Paid" stamps/notes. If found, set is_direct_paid to true.
        - Calculate net_total = total_amount - total_discount.
    `;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: imageBuffer.toString('base64'), mimeType: "image/jpeg" } }
    ]);

    const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);
}

/**
 * Google Drive: Uploads the voucher image and returns a link
 */
async function uploadToDrive(imageBuffer, data) {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
        name: `${data.vendor || 'Unknown'}_${Date.now()}.jpg`,
        parents: [CONFIG.DRIVE_FOLDER_ID]
    };
    const media = { mimeType: 'image/jpeg', body: stream.Readable.from(imageBuffer) };
    const file = await drive.files.create({ resource: fileMetadata, media: media, fields: 'webViewLink' });
    return file.data.webViewLink;
}

/**
 * Google Sheets: Saves data to the row
 */
async function saveToSheet(data, userName) {
    const sheets = google.sheets({ version: 'v4', auth });
    const focList = data.foc_items?.length > 0 ? data.foc_items.join(", ") : "-";
    const finalStatus = data.is_direct_paid ? "Paid (Direct)" : data.status;

    const row = [
        data.date || new Date().toLocaleDateString(), // A: Date
        data.vendor || "Unknown",                     // B: Vendor
        "N/A",                                        // C: Voucher No
        data.category || "Other",                    // D: Category
        data.total_amount || 0,                      // E: Gross
        data.total_discount || 0,                    // F: Discount
        data.net_total || 0,                         // G: Net Total
        focList,                                     // H: FOC
        finalStatus,                                 // I: Status
        data.drive_url || "",                        // J: Drive Link
        userName,                                    // K: User
        new Date().toLocaleString()                  // L: Timestamp
    ];
    
    await sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SHEET_ID,
        range: 'Sheet1!A:L',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] },
    });
}

/**
 * Reporting: Sums up financial totals from Sheets
 */
async function getFullReport() {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEET_ID,
        range: 'Sheet1!G:I', 
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return "📊 No records found in the sheet yet.";

    let grandTotal = 0, directPaidTotal = 0, unpaidTotal = 0;
    
    rows.slice(1).forEach(row => {
        const amtStr = row[0] ? row[0].toString().replace(/,/g, '') : '0';
        const amt = parseInt(amtStr) || 0;
        const status = row[2]?.trim();
        grandTotal += amt;
        if (status === 'Paid (Direct)') directPaidTotal += amt;
        else if (status === 'Unpaid') unpaidTotal += amt;
    });

    return `📊 Aung Myin Clinic Report\n--------------------\n💰 Total: ${grandTotal.toLocaleString()} MMK\n✅ Paid (Direct): ${directPaidTotal.toLocaleString()} MMK\n⚠️ Unpaid: ${unpaidTotal.toLocaleString()} MMK`;
}

// --- Viber Events ---
bot.on(Events.MESSAGE_RECEIVED, async (message, response) => {
    const senderId = response.userProfile.id;
    const userName = response.userProfile.name;

    // Log the ID so you can copy it for CONFIG.ALLOWED_USERS
    console.log(`[Message] From: ${userName} (ID: ${senderId})`);

    // Only filter if IDs are added to CONFIG.ALLOWED_USERS
    if (CONFIG.ALLOWED_USERS.length > 0 && !CONFIG.ALLOWED_USERS.includes(senderId)) {
        return console.log("Unauthorized user blocked.");
    }

    if (message instanceof ImageMessage) {
        await response.send(new TextMessage("⚙️ AI Scanning Voucher..."));
        try {
            const imgBuffer = (await axios.get(message.url, { responseType: 'arraybuffer' })).data;
            const aiData = await analyzeVoucher(Buffer.from(imgBuffer));
            
            if (!aiData.is_voucher) return response.send(new TextMessage("❌ Not a recognized voucher."));

            aiData.drive_url = await uploadToDrive(Buffer.from(imgBuffer), aiData);
            
            if (aiData.confidence_score > 85) {
                await saveToSheet(aiData, userName);
                return response.send(new TextMessage(`✅ Saved!\n\nVendor: ${aiData.vendor}\nAmount: ${aiData.net_total.toLocaleString()} MMK\nStatus: ${aiData.is_direct_paid ? "Paid (Direct)" : aiData.status}`));
            } else {
                pendingVouchers.set(senderId, aiData);
                userState.set(senderId, "CONFIRM_WAIT");
                return response.send(new TextMessage(`🔍 Confidence (${aiData.confidence_score}%)\n\nIs this ${aiData.vendor} for ${aiData.net_total} MMK?\n(Type 'ok' to save or 'edit' to correct)`));
            }
        } catch (e) {
            console.error(e);
            response.send(new TextMessage("⚠️ Error processing image. Check terminal."));
        }
    }

    if (message instanceof TextMessage) {
        const text = message.text.toLowerCase();

        if (text === "report") {
            const report = await getFullReport();
            return response.send(new TextMessage(report));
        }

        if (text === "ok" && userState.get(senderId) === "CONFIRM_WAIT") {
            await saveToSheet(pendingVouchers.get(senderId), userName);
            userState.delete(senderId);
            return response.send(new TextMessage("✅ Saved."));
        }

        if (text === "edit" && userState.get(senderId) === "CONFIRM_WAIT") {
            userState.set(senderId, "EDIT_WAIT");
            return response.send(new TextMessage("Please send the correct amount (digits only):"));
        }

        if (userState.get(senderId) === "EDIT_WAIT") {
            const amt = parseInt(message.text.replace(/,/g, ''));
            if (isNaN(amt)) return response.send(new TextMessage("Invalid input. Digits only."));
            const data = pendingVouchers.get(senderId);
            data.net_total = amt;
            await saveToSheet(data, userName);
            userState.delete(senderId);
            return response.send(new TextMessage(`✅ Saved with corrected amount: ${amt.toLocaleString()} MMK`));
        }
        
        response.send(new TextMessage("🏥 Aung Myin Clinic AI\nSend a photo to record or type 'report' for totals."));
    }
});

// --- Start Server ---
const http = require('http');
http.createServer(bot.middleware()).listen(CONFIG.PORT, () => {
    console.log(`Bot running on port ${CONFIG.PORT}`);
    bot.setWebhook(CONFIG.WEBHOOK_URL)
        .then(() => console.log(`✅ Webhook Connected: ${CONFIG.WEBHOOK_URL}`))
        .catch(err => console.error("❌ Webhook Error:", err));
});
