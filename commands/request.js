const fs = require('fs');
const path = require('path');

// File path for storing the requests
const requestsFile = path.join(__dirname, '../config/plex_requests.json');

// Helper to load requests from the disk
function loadRequests() {
    if (!fs.existsSync(requestsFile)) return [];
    return JSON.parse(fs.readFileSync(requestsFile, 'utf8'));
}

// Helper to save requests to the disk
function saveRequests(data) {
    fs.writeFileSync(requestsFile, JSON.stringify(data, null, 4));
}

module.exports = {
    name: 'request',
    command: {
        usage: '!request [add/list/complete/remove/ask]',
        description: 'Manage media requests for the Plex server via DMs.',
        process: async function(...args) {
            let msg = null;
            let commandArgs = [];

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                } else if (typeof arg === 'string') {
                    commandArgs.push(arg);
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const rawInput = commandArgs.join(" ").trim();
            const words = rawInput.split(" ");
            const action = words[0] ? words[0].toLowerCase() : '';

            // ==========================================
            // MAIN MENU
            // ==========================================
            if (!action || action === 'menu' || action === 'help') {
                const menuText = `
🍿 **The Nerdgasm Request Board** 🍿
*Request movies, TV shows, or albums for the server!*

**Commands:**
📝 \`!request add\` - The bot will DM you to get your request details.
📋 \`!request list\` - View the anonymous server wishlist.
✅ \`!request complete [ID]\` - (Admin) Mark a request as fulfilled!
🗑️ \`!request remove [ID]\` - (Admin) Delete a request.
❓ \`!request ask [ID] [Message]\` - (Admin) Send an anonymous DM to the requester asking for clarification.
                `;
                return msg.channel.send(menuText.trim());
            }

            let requests = loadRequests();

            // ==========================================
            // ADD A REQUEST (DM INTERVIEW FLOW)
            // ==========================================
            if (action === 'add') {
                try {
                    // Open a DM channel with the user
                    const dmChannel = await msg.author.createDM();

                    // Let the channel know the bot is handling it
                    await msg.channel.send(`📬 <@${msg.author.id}>, check your DMs! I've sent you a message to gather the details for your request.`);

                    // Question 1: Title
                    await dmChannel.send("🎬 **New Plex Request!**\nFirst, what is the **Title** of the movie, TV show, or album you are requesting?");

                    const filter = m => m.author.id === msg.author.id;
                    const titleCollected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000 });

                    if (titleCollected.size === 0) {
                        return dmChannel.send("🕰️ *Request timed out. Please run `!request add` in the server again when you are ready.*");
                    }
                    const title = titleCollected.first().content;

                    // Question 2: Identifying Info
                    await dmChannel.send(`Got it! You requested **${title}**.\n\nNext, please provide any **identifying information** to help the admin find the right version. (e.g., Release year, director, 'the anime version', 'season 3', etc.). \n*If you don't have any extra info, just type 'none'.*`);

                    const infoCollected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000 });

                    if (infoCollected.size === 0) {
                        return dmChannel.send("🕰️ *Request timed out. Please start over in the server.*");
                    }
                    const details = infoCollected.first().content;

                    // Generate ID and Save
                    let newId = 1;
                    if (requests.length > 0) {
                        newId = Math.max(...requests.map(r => r.id)) + 1;
                    }

                    requests.push({
                        id: newId,
                        userId: msg.author.id,
                        title: title,
                        details: details,
                        date: new Date().toLocaleDateString()
                    });

                    saveRequests(requests);

                    return dmChannel.send(`✅ **Request Logged!**\nYour request for **${title}** has been added to the board as ID **#${newId}**. I will send you a DM here when it's added to the server!`);

                } catch (err) {
                    console.error(err);
                    return msg.channel.send(`❌ <@${msg.author.id}>, I couldn't send you a DM! Please make sure your server privacy settings allow direct messages from bots, then try again.`);
                }
            }

            // ==========================================
            // LIST REQUESTS (ANONYMOUS)
            // ==========================================
            if (action === 'list') {
                if (requests.length === 0) {
                    return msg.channel.send("📋 **Current Requests**\n*The wishlist is completely empty! You are all caught up.*");
                }

                let listText = "📋 **Current Plex Requests** 📋\n\n";
                requests.forEach(req => {
                    // Notice we completely omit the username/userId here
                    listText += `**#${req.id}** - **${req.title}**\n> *Info: ${req.details}*\n\n`;
                });

                return msg.channel.send(listText.trim());
            }

            // ==========================================
            // ASK FOR CLARIFICATION (ADMIN TO USER DM)
            // ==========================================
            if (action === 'ask') {
                const targetId = parseInt(words[1]);
                const question = words.slice(2).join(" ");

                if (!targetId || isNaN(targetId) || !question) {
                    return msg.channel.send(`⚠️ *Please provide the ID and your question. Example: \`!request ask 3 Is this the 1990 version or the 2017 remake?\`*`);
                }

                const targetRequest = requests.find(r => r.id === targetId);
                if (!targetRequest) {
                    return msg.channel.send(`❌ *I couldn't find a request with the ID #${targetId}.*`);
                }

                try {
                    const targetUser = await msg.client.users.fetch(targetRequest.userId);
                    if (targetUser) {
                        await targetUser.send(`❓ **Question regarding your Plex request:**\nThe server admin needs some clarification on your request for **${targetRequest.title}** (ID #${targetId}):\n\n*"${question}"*\n\n*(You can reply to the admin directly in the server to let them know!)*`);
                        return msg.channel.send(`✅ Message secretly forwarded to the user who requested **#${targetId}**.`);
                    }
                } catch (err) {
                    return msg.channel.send(`❌ *I couldn't DM the user who made that request. They may have closed their DMs or left the server.*`);
                }
            }

            // ==========================================
            // COMPLETE / REMOVE A REQUEST
            // ==========================================
            if (action === 'complete' || action === 'remove') {
                const targetId = parseInt(words[1]);

                if (!targetId || isNaN(targetId)) {
                    return msg.channel.send(`⚠️ *Please provide the ID number of the request. Example: \`!request ${action} 3\`*`);
                }

                const requestIndex = requests.findIndex(r => r.id === targetId);

                if (requestIndex === -1) {
                    return msg.channel.send(`❌ *I couldn't find a request with the ID #${targetId}. Try running \`!request list\` to check the numbers.*`);
                }

                const removedRequest = requests.splice(requestIndex, 1)[0];
                saveRequests(requests);

                if (action === 'complete') {
                    // Notify the channel anonymously
                    msg.channel.send(`🎉 **Request Fulfilled!**\nRequest **#${targetId}** (**${removedRequest.title}**) has been completed and is now on the server!`);

                    // Secretly DM the user who requested it
                    try {
                        const targetUser = await msg.client.users.fetch(removedRequest.userId);
                        if (targetUser) {
                            targetUser.send(`🎉 **Good news!**\nYour Plex request for **${removedRequest.title}** has been fulfilled and is now available to watch/listen on The Nerdgasm! Enjoy!`).catch(() => {});
                        }
                    } catch (err) {
                        console.error("Could not send completion DM to user.");
                    }
                    return;
                } else {
                    return msg.channel.send(`🗑️ **Request Removed:** **${removedRequest.title}** (ID: #${targetId})`);
                }
            }

            // Fallback for unknown commands
            return msg.channel.send("⚠️ *Unknown action. Type \`!request\` to see the menu!*");
        }
    }
};