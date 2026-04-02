const ViberBot = require('viber-bot').Bot;
const Events = require('viber-bot').Events;
const { TextMessage, ImageMessage, KeyboardMessage } = require('viber-bot').Message;
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const stream = require('stream');
require('dotenv').config();

// --- Bot & AI Configuration ---
const bot = new ViberBot({
    authToken: process.env.VIBER_TOKEN,
    name: "Voucher AI Manager",
    avatar: "https://raw.githubusercontent.com/google/material-design-icons/master/png/action/receipt/mw24/1x/baseline_receipt_black_24dp.png"
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json', 
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
});

const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',') : [];
const CONFIDENCE_THRESHOLD = 85;

// Memory states for handling multi-turn conversations
const userState = new Map(); 
const pendingVouchers = new Map();

// --- AI Engine (Direct Paid Detection Logic) ---
async function analyzeVoucher(imageBuffer) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
        Analyze this receipt and return ONLY a JSON object.
        JSON Schema:
        {
            "is_voucher": boolean,
            "vendor": "string",
            "date": "string",
            "voucher_number": "string",
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
        - Detect if the receipt has a 'Paid' stamp or handwritten 'Paid' note.
        - If 'Paid' is detected, set status to "Paid" and is_direct_paid to true. 
        - This helps identify vouchers that were paid immediately upon receipt without prior recording.
        - Calculate net_total as (total_amount - total_discount).
    `;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: imageBuffer.toString('base64'), mimeType: "image/jpeg" } }
    ]);

    const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);
}

// --- Google Drive & Sheets Integration ---
async function uploadToDrive(imageBuffer, data) {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
        name: `${data.vendor || 'Unknown'}_${Date.now()}.jpg`,
        parents: [process.env.DRIVE_FOLDER_ID]
    };
    const media = { mimeType: 'image/jpeg', body: stream.Readable.from(imageBuffer) };
    const file = await drive.files.create({ resource: fileMetadata, media, fields: 'webViewLink' });
    return file.data.webViewLink;
}

async function saveToSheet(data, userName) {
    const sheets = google.sheets({ version: 'v4', auth });
    const focList = data.foc_items?.length > 0 ? data.foc_items.join(", ") : "-";
    
    // Distinguish between normal Paid and Direct Paid
    const finalStatus = data.is_direct_paid ? "Paid (Direct)" : data.status;

    const row = [
        data.date,          // Col A
        data.vendor,        // Col B
        data.voucher_number,// Col C
        data.category,      // Col D
        data.total_amount,  // Col E
        data.total_discount,// Col F
        data.net_total,     // Col G
        focList,            // Col H
        finalStatus,        // Col I
        data.drive_url,     // Col J
        userName,           // Col K
        new Date().toLocaleString() // Col L
    ];
    
    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: 'Sheet1!A:L',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] },
    });
}

// --- Detailed Analytics Report ---
async function getFullReport() {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: 'Sheet1!G:I', 
    });
    const rows = response.data.values || [];
    if (rows.length <= 1) return "📊 No records found in the system.";

    let grandTotal = 0, directPaidTotal = 0, unpaidTotal = 0;
    let directPaidCount = 0, unpaidCount = 0;

    rows.slice(1).forEach(row => {
        const amtStr = row[0] ? row[0].toString().replace(/,/g, '') : '0';
        const amt = parseInt(amtStr) || 0;
        const status = row[2]?.trim();
        grandTotal += amt;
        
        if (status === 'Paid (Direct)') {
            directPaidTotal += amt;
            directPaidCount++;
        } else {
            unpaidTotal += amt;
            unpaidCount++;
        }
    });

    return `📊 Summary Report\n--------------------\n📁 Total: ${rows.length - 1}\n💰 Grand Total: ${grandTotal.toLocaleString()} MMK\n\n✅ Paid (Direct):\n- Count: ${directPaidCount}\n- Amount: ${directPaidTotal.toLocaleString()} MMK\n\n⚠️ Unpaid/Other:\n- Count: ${unpaidCount}\n- Amount: ${unpaidTotal.toLocaleString()} MMK`;
}

// --- Bot Events Handler ---
bot.on(Events.MESSAGE_RECEIVED, async (message, response) => {
    const senderId = response.userProfile.id;
    const userName = response.userProfile.name;

    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(senderId)) return;

    if (message instanceof ImageMessage) {
        await response.send(new TextMessage("⚙️ Processing voucher..."));
        try {
            const imgBuffer = (await axios.get(message.url, { responseType: 'arraybuffer' })).data;
            const aiData = await analyzeVoucher(Buffer.from(imgBuffer));

            if (!aiData.is_voucher) return response.send(new TextMessage("❌ Not a voucher."));

            aiData.drive_url = await uploadToDrive(Buffer.from(imgBuffer), aiData);

            if (aiData.confidence_score < CONFIDENCE_THRESHOLD) {
                pendingVouchers.set(senderId, aiData);
                userState.set(senderId, "CONFIRM_WAIT");
                const kb = {
                    "Type": "keyboard", "Buttons": [
                        { "ActionBody": "ok", "Text": "Correct ✅", "BgColor": "#4CAF50", "Columns": 3 },
                        { "ActionBody": "edit", "Text": "Edit ✏️", "BgColor": "#F44336", "Columns": 3 }
                    ]
                };
                return response.send(new TextMessage(`🔍 Confidence (${aiData.confidence_score}%)\nVendor: ${aiData.vendor}\nNet: ${aiData.net_total}\nStatus: ${aiData.status}\n\nIs this correct?`, kb));
            } else {
                await saveToSheet(aiData, userName);
                return response.send(new TextMessage(`✅ Saved!\nVendor: ${aiData.vendor}\nAmount: ${aiData.net_total} MMK`));
            }
        } catch (e) { 
            console.error(e);
            return response.send(new TextMessage("⚠️ Error processing image.")); 
        }
    }

    if (message instanceof TextMessage) {
        const text = message.text.toLowerCase();

        if (text === "report") {
            const report = await getFullReport();
            return response.send(new TextMessage(report));
        }

        if (message.text === "ok" && userState.get(senderId) === "CONFIRM_WAIT") {
            await saveToSheet(pendingVouchers.get(senderId), userName);
            userState.delete(senderId);
            return response.send(new TextMessage("✅ Saved."));
        }

        if (message.text === "edit" && userState.get(senderId) === "CONFIRM_WAIT") {
            userState.set(senderId, "EDIT_WAIT");
            return response.send(new TextMessage("Enter correct amount:"));
        }

        if (userState.get(senderId) === "EDIT_WAIT") {
            const amt = parseInt(message.text.replace(/,/g, ''));
            if (isNaN(amt)) return response.send(new TextMessage("Digits only."));
            const data = pendingVouchers.get(senderId);
            data.net_total = amt;
            await saveToSheet(data, userName);
            userState.delete(senderId);
            return response.send(new TextMessage(`✅ Saved: ${amt}`));
        }
    }
});

// Server Listen
const http = require('http');
http.createServer(bot.middleware()).listen(process.env.PORT || 3000, () => {
    bot.setWebhook(process.env.WEBHOOK_URL).catch(e => console.error(e));
});
bot.on(Events.MESSAGE_RECEIVED, (message, response) => {
    // THIS LINE WILL SEND YOUR ID TO YOU IN VIBER
    response.send(new TextMessage("Your ID is: " + response.userProfile.id));
    
    console.log("User ID:", response.userProfile.id); 
});
