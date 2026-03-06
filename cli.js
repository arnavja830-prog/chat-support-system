#!/usr/bin/env node

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8000';

async function fetchMessages() {
    try {
        const response = await axios.get(`${SERVER_URL}/api/messages`);
        const messages = response.data;

        if (messages.length === 0) {
            console.log('\n📭 No messages yet.\n');
            return;
        }

        console.log(`\n📨 Fetched ${messages.length} message(s):\n`);
        console.log('─'.repeat(80));

        messages.forEach((msg, index) => {
            const time = new Date(msg.timestamp).toLocaleString();
            console.log(`\n[${index + 1}] ${msg.sender} • ${time}`);
            console.log('─'.repeat(80));

            if (msg.text) {
                console.log(`📝 Text:\n${msg.text}`);
            }

            if (msg.image) {
                console.log(`🖼️  Image: [Base64 data - ${Math.floor(msg.image.length / 1024)} KB]`);
                console.log(`   Data: ${msg.image.substring(0, 80)}...`);
            }

            console.log(`\n   Message ID: ${msg.messageId}`);
            console.log('─'.repeat(80));
        });

        console.log(`\n✅ Total messages: ${messages.length}\n`);
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('\n❌ Error: Cannot connect to server at ' + SERVER_URL);
            console.error('   Make sure the chat server is running on port 8000\n');
            console.error('   Run: npm start\n');
        } else {
            console.error('\n❌ Error fetching messages:', error.message, '\n');
        }
        process.exit(1);
    }
}

// Options for different commands
const command = process.argv[2];

if (command === '--watch') {
    // Watch mode - fetch every 2 seconds
    console.log('👀 Watching for messages (refreshing every 2 seconds)...');
    console.log('Press Ctrl+C to stop\n');

    setInterval(() => {
        console.clear();
        console.log('👀 Watching for messages (refreshing every 2 seconds)...');
        console.log('Press Ctrl+C to stop\n');
        fetchMessages().catch(console.error);
    }, 2000);
} else if (command === '--help' || command === '-h') {
    console.log(`
📱 Chat Support System - Message Viewer

Usage:
  node cli.js              Display all messages once
  node cli.js --watch      Watch messages in real-time (updates every 2s)
  node cli.js --help       Show this help message

Environment Variables:
  SERVER_URL               Default: http://localhost:8000

Examples:
  node cli.js
  node cli.js --watch
  SERVER_URL=http://localhost:3000 node cli.js
  `);
} else {
    // Default - fetch once
    fetchMessages();
}
