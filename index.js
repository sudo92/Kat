require('dotenv').config();
// Kat - Your friendly neighborhood support bot 🐱
// Built with Slack Bolt.js + Linear API

const { App, LogLevel } = require('@slack/bolt');
const { LinearClient } = require('@linear/sdk');

// ============================================
// CONFIGURATION
// ============================================

// Customer mapping: Slack Workspace ID -> Linear Project ID
const CUSTOMER_MAPPING = {
  // Example: 'T01ABC123': 'project-uuid-from-linear',
  // Add your customers here as they install the bot
};

// Environment variables you'll need:
// SLACK_BOT_TOKEN - Bot User OAuth Token (starts with xoxb-)
// SLACK_SIGNING_SECRET - From Slack app settings
// LINEAR_API_KEY - Your Linear personal API key
// PORT - Server port (default 3000)

const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false, // Use HTTP mode for production
  logLevel: LogLevel.INFO
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get Linear project ID for a Slack workspace
function getLinearProject(workspaceId) {
  return CUSTOMER_MAPPING[workspaceId] || null;
}

// Parse user intent from message
function parseIntent(text) {
  const lower = text.toLowerCase();
  
  // Query patterns
  if (lower.match(/\b(show|list|what|which|get|find|see)\b.*(ticket|issue)/)) {
    return { type: 'query', text };
  }
  if (lower.match(/\b(open|pending|active|my)\b.*ticket/)) {
    return { type: 'query', status: 'open', text };
  }
  if (lower.match(/what.*happened|status.*of|update.*on/)) {
    return { type: 'query', text };
  }
  
  // Default to ticket creation
  return { type: 'create', text };
}

// Generate response with GenZ professor vibes
function generateResponse(type, data) {
  const vibes = {
    greeting: [
      "Yo! What's good? 🐱",
      "Hey hey! Kat here, what can I help with?",
      "Sup! Ready to tackle some tickets? 😎"
    ],
    ticketCreated: [
      "Bet! I've logged that for you.",
      "Got it! Ticket created, we're on it.",
      "Say less! Your ticket is in the system."
    ],
    ticketQueried: [
      "Here's what I found:",
      "Alright, let me pull that up for you:",
      "Okay okay, check this out:"
    ],
    noTickets: [
      "Looks like you're all clear! No open tickets rn.",
      "Nothing to see here - you're good! ✨",
      "Clean slate! No tickets at the moment."
    ],
    error: [
      "Oof, something went sideways on my end. Mind trying again?",
      "My bad! Hit a snag there. Can you try that one more time?",
      "Yikes, that didn't work. Let me know if it keeps happening!"
    ]
  };
  
  const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
  
  if (type === 'ticket_created') {
    return `${random(vibes.ticketCreated)} 🎫\n\n*Ticket:* ${data.title}\n*ID:* ${data.identifier}\n*Link:* ${data.url}\n\nI'll keep you posted on updates!`;
  }
  
  if (type === 'tickets_found') {
    if (data.tickets.length === 0) {
      return random(vibes.noTickets);
    }
    
    let response = `${random(vibes.ticketQueried)}\n\n`;
    data.tickets.forEach(ticket => {
      response += `🎫 *${ticket.identifier}* - ${ticket.title}\n`;
      response += `   Status: ${ticket.state.name} | Priority: ${ticket.priority || 'None'}\n`;
      response += `   ${ticket.url}\n\n`;
    });
    return response;
  }
  
  if (type === 'error') {
    return random(vibes.error);
  }
  
  return random(vibes.greeting);
}

// ============================================
// LINEAR API FUNCTIONS
// ============================================

async function createLinearTicket(projectId, title, description, createdBy) {
  try {
    const issue = await linearClient.createIssue({
      projectId: projectId,
      title: title,
      description: `${description}\n\n---\n*Created by:* ${createdBy} via Kat 🐱`,
      priority: 0 // No priority by default
    });
    
    const createdIssue = await issue.issue;
    return {
      id: createdIssue.id,
      identifier: createdIssue.identifier,
      title: createdIssue.title,
      url: createdIssue.url
    };
  } catch (error) {
    console.error('Error creating Linear ticket:', error);
    throw error;
  }
}

async function searchLinearTickets(projectId, query, statusFilter = null) {
  try {
    const issues = await linearClient.issues({
      filter: {
        project: { id: { eq: projectId } },
        ...(statusFilter === 'open' && {
          state: { type: { nin: ['completed', 'canceled'] } }
        })
      },
      first: 10,
      orderBy: 'updatedAt'
    });
    
    let tickets = await issues.nodes;
    
    // If there's a search query, filter by relevance
    if (query) {
      const searchTerms = query.toLowerCase();
      tickets = tickets.filter(ticket => 
        ticket.title.toLowerCase().includes(searchTerms) ||
        (ticket.description && ticket.description.toLowerCase().includes(searchTerms))
      );
    }
    
    return tickets.map(ticket => ({
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      url: ticket.url,
      state: { name: ticket.state.name },
      priority: ticket.priority
    }));
  } catch (error) {
    console.error('Error searching Linear tickets:', error);
    throw error;
  }
}

// ============================================
// SLACK EVENT HANDLERS
// ============================================

// Handle direct messages and app mentions
app.event('message', async ({ event, client, say }) => {
  // Ignore bot messages and threaded messages (for now)
  if (event.subtype || event.thread_ts) return;
  
  const workspaceId = event.team || client.team.id;
  const projectId = getLinearProject(workspaceId);
  
  if (!projectId) {
    await say({
      text: "Yo! Looks like your workspace isn't set up yet. Hit up your admin to configure Kat! 🐱",
      thread_ts: event.ts
    });
    return;
  }
  
  try {
    // Get user info for attribution
    const userInfo = await client.users.info({ user: event.user });
    const userName = userInfo.user.real_name || userInfo.user.name;
    
    // Parse intent
    const intent = parseIntent(event.text);
    
    if (intent.type === 'query') {
      // Search for tickets
      const tickets = await searchLinearTickets(
        projectId,
        intent.text,
        intent.status
      );
      
      const response = generateResponse('tickets_found', { tickets });
      await say({ text: response, thread_ts: event.ts });
      
    } else if (intent.type === 'create') {
      // Create a new ticket
      const ticket = await createLinearTicket(
        projectId,
        event.text.substring(0, 100), // Use first 100 chars as title
        event.text,
        userName
      );
      
      const response = generateResponse('ticket_created', ticket);
      await say({ text: response, thread_ts: event.ts });
    }
    
  } catch (error) {
    console.error('Error handling message:', error);
    const response = generateResponse('error');
    await say({ text: response, thread_ts: event.ts });
  }
});

// Handle app mentions (@Kat)
app.event('app_mention', async ({ event, say }) => {
  // Remove the mention from the text
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  
  // For now, just acknowledge it
  await say({
    text: "Hey! I got your mention. Let me help with that!",
    thread_ts: event.ts
  });
});

// Handle app installation (when customer adds bot to their workspace)
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to Kat! 🐱*\n\nYour friendly support companion. Just message me naturally and I\'ll help you manage tickets.\n\n*What I can do:*\n• Create tickets - just tell me what\'s up\n• Find tickets - ask me "what are my open tickets?"\n• Get updates - "what happened to my ticket about..."\n\n*Examples:*\n• "Hey, our dashboard is showing wrong metrics"\n• "Show me my open tickets"\n• "What\'s the status of the AI campaign issue?"\n\nLet\'s get it! 🚀'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error publishing home tab:', error);
  }
});

// ============================================
// LINEAR WEBHOOKS (Optional - for real-time updates)
// ============================================

// Endpoint for Linear webhooks
app.use('/webhooks/linear', async (req, res) => {
  // Linear will POST updates here when tickets change
  // You can use this to notify customers in Slack
  
  const { action, data } = req.body;
  
  if (action === 'update' && data.updatedFrom) {
    // Ticket was updated - could notify customer in thread
    console.log('Ticket updated:', data);
  }
  
  res.status(200).send('OK');
});

// ============================================
// START SERVER
// ============================================

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Kat is vibing on port ${port}! 🐱`);
  console.log(`\n📝 Don't forget to:`);
  console.log(`   1. Set your environment variables`);
  console.log(`   2. Update CUSTOMER_MAPPING with workspace IDs`);
  console.log(`   3. Configure Slack Event Subscriptions to point to this server`);
  console.log(`   4. Subscribe to: message.channels, message.im, app_mention`);
})();

module.exports = app;
