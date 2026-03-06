const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 8000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/mcp-test/c455f220-a6ac-4e60-b914-ad267d192c19';

// Store for messages
let messages = [];
let activeUsers = 0;

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get message history
app.get('/api/messages', (req, res) => {
    res.json(messages);
});

// Socket.io connection handler
io.on('connection', (socket) => {
    activeUsers++;
    console.log(`User connected. Active users: ${activeUsers}`);

    // Broadcast to all clients about active user count
    io.emit('activeUsers', activeUsers);

    // Handle incoming messages
    socket.on('sendMessage', async (data) => {
        try {
            const messageData = {
                type: 'message',
                sender: data.sender || 'Anonymous',
                timestamp: new Date().toISOString(),
                text: data.text || '',
                image: data.image || null,
                messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };

            // Store message in memory
            messages.push(messageData);

            // Broadcast message to all connected clients
            io.emit('newMessage', messageData);

            // Send to n8n webhook
            await sendToN8n(messageData);

            console.log(`Message received from ${messageData.sender}:`, {
                text: messageData.text.substring(0, 50),
                hasImage: !!messageData.image
            });

        } catch (error) {
            console.error('Error sending message:', error.message);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    // Handle typing indicator
    socket.on('typing', (data) => {
        socket.broadcast.emit('userTyping', {
            sender: data.sender,
            isTyping: data.isTyping
        });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        activeUsers--;
        console.log(`User disconnected. Active users: ${activeUsers}`);
        io.emit('activeUsers', activeUsers);
    });
});

// Function to send message to n8n webhook
async function sendToN8n(messageData) {
    try {
        const payload = {
            jsonrpc: '2.0',
            method: 'call_tool',
            params: {
                name: 'message_received',
                arguments: {
                    sender: messageData.sender,
                    text: messageData.text,
                    image: messageData.image,
                    timestamp: messageData.timestamp,
                    messageId: messageData.messageId
                }
            },
            id: Math.floor(Math.random() * 10000)
        };

        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            },
            timeout: 5000
        });

        console.log('Message sent to n8n successfully');
        return response.data;
    } catch (error) {
        console.error('Error sending to n8n:', error.message);
        // Don't throw here - we still want the message delivered to chat clients
    }
}

// Clear messages endpoint (optional)
app.delete('/api/messages', (req, res) => {
    messages = [];
    io.emit('messagesCleared');
    res.json({ message: 'Messages cleared' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeUsers,
        messageCount: messages.length,
        n8nWebhookUrl: N8N_WEBHOOK_URL
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 Connected to n8n webhook: ${N8N_WEBHOOK_URL}\n`);
});
