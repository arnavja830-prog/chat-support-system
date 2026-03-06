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
let n8nConnected = false;
let messageQueue = [];

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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeUsers,
        messageCount: messages.length,
        n8nConnected,
        n8nWebhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length
    });
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

// Initialize MCP connection with n8n workflow
async function initializeN8nConnection() {
    try {
        const initPayload = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'chat-support-client',
                    version: '1.0.0'
                }
            },
            id: 1
        };

        const response = await axios.post(N8N_WEBHOOK_URL, initPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            },
            timeout: 5000
        });

        console.log('✅ Connected to n8n workflow via MCP');
        n8nConnected = true;

        // Process any queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            await sendToN8n(msg);
        }

        return response.data;
    } catch (error) {
        console.error('❌ Failed to initialize n8n connection:', error.message);
        n8nConnected = false;
        // Retry in 5 seconds
        setTimeout(initializeN8nConnection, 5000);
    }
}

// Function to send message to n8n webhook in real-time
async function sendToN8n(messageData) {
    try {
        if (!n8nConnected) {
            console.log('⏳ n8n not connected, queueing message...');
            messageQueue.push(messageData);
            return;
        }

        const payload = {
            jsonrpc: '2.0',
            method: 'call_tool',
            params: {
                name: 'message_received',
                arguments: {
                    sender: messageData.sender,
                    text: messageData.text,
                    image: messageData.image ? `[Image - ${Math.floor(messageData.image.length / 1024)} KB]` : null,
                    timestamp: messageData.timestamp,
                    messageId: messageData.messageId,
                    hasImage: !!messageData.image
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

        console.log(`📤 Message sent to n8n from ${messageData.sender}: "${messageData.text.substring(0, 50)}${messageData.text.length > 50 ? '...' : ''}"`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending to n8n:', error.message);
        // Queue the message to retry later
        if (messageQueue.length < 100) {
            messageQueue.push(messageData);
        }
    }
}

// Clear messages endpoint (optional)
app.delete('/api/messages', (req, res) => {
    messages = [];
    io.emit('messagesCleared');
    res.json({ message: 'Messages cleared' });
});

// n8n status endpoint
app.get('/api/n8n-status', (req, res) => {
    res.json({
        connected: n8nConnected,
        webhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length,
        totalMessages: messages.length
    });
});

// Manually reconnect to n8n
app.post('/api/reconnect-n8n', async (req, res) => {
    console.log('🔄 Manual reconnection triggered...');
    n8nConnected = false;
    await initializeN8nConnection();
    res.json({
        message: 'Reconnection initiated',
        connected: n8nConnected
    });
});

// Endpoint for n8n to send responses back to chat
app.post('/api/send-response', (req, res) => {
    try {
        const responseData = req.body;

        // Validate required fields - accept either 'response' or 'message'
        const messageText = responseData.response || responseData.message;
        if (!messageText) {
            return res.status(400).json({ error: 'Missing response or message field' });
        }

        // Prepare response message
        const responseMessage = {
            type: 'response',
            sender: responseData.sender || responseData.source || 'AI Assistant',
            timestamp: new Date().toISOString(),
            text: messageText,
            messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            originalMessageId: responseData.originalMessageId || null,
            category: responseData.category || null
        };

        // Store response in messages
        messages.push(responseMessage);

        // Broadcast response to all connected clients
        io.emit('responseMessage', responseMessage);

        console.log(`📥 Response received from n8n: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);

        res.json({ success: true, messageId: responseMessage.messageId });
    } catch (error) {
        console.error('❌ Error processing response:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint for creating support tickets
app.post('/api/tickets', (req, res) => {
    try {
        const ticketData = req.body;

        // Validate required fields
        if (!ticketData.ticket_title || !ticketData.ticket_description) {
            return res.status(400).json({ error: 'Missing ticket_title or ticket_description' });
        }

        // Create ticket object
        const ticket = {
            id: `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            title: ticketData.ticket_title,
            description: ticketData.ticket_description,
            priority: ticketData.priority || 'Medium',
            status: ticketData.status || 'open',
            assigned_to: ticketData.assigned_to || 'support_team',
            created_at: new Date().toISOString(),
            category: ticketData.category || null
        };

        // In a real system, you would save this to a database
        // For now, we'll just log it and store in memory
        console.log('🎫 New support ticket created:', {
            id: ticket.id,
            title: ticket.title,
            priority: ticket.priority,
            assigned_to: ticket.assigned_to
        });

        // You could store tickets in memory like messages
        // tickets = tickets || [];
        // tickets.push(ticket);

        res.json({
            success: true,
            ticket_id: ticket.id,
            message: 'Ticket created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating ticket:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 Connecting to n8n workflow: ${N8N_WEBHOOK_URL}\n`);

    // Initialize n8n connection on startup
    initializeN8nConnection();

    // Keep connection alive by checking n8n health every 30 seconds
    setInterval(async () => {
        if (!n8nConnected) {
            console.log('🔄 Attempting to reconnect to n8n...');
            await initializeN8nConnection();
        }
    }, 30000);
});
