require('dotenv').config();

const { App } = require('@slack/bolt');
const { LinearClient } = require('@linear/sdk');

// Customer mapping
const CUSTOMER_MAPPING = {
  // Add customers like: 'T01ABC123': 'linear-project-uuid',
};

const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

// Helper functions
function getLinearProject(workspaceId) {
  return CUSTOMER_MAPPING[workspaceId] || null;
}

function generateResponse(type, data) {
  const greetings = [
    "Yo! What's good? 🐱",
    "Hey hey! Kat here, what can I help with?",
    "Sup! Ready to tackle some tickets? 😎"
  ];
  
  const ticketCreated = [
    "Bet! I've logged that for you.",
    "Got it! Ticket created, we're on it.",
    "Say less! Your ticket is in the system."
  ];
  
  if (type === 'ticket_created' && data) {
    const msg = ticketCreated[Math.floor(Math.random() * ticketCreated.length)];
    return `${msg} 🎫\n\n*Ticket:* ${data.title}\n*ID:* ${data.identifier}\n*Link:* ${data.url}\n\nI'll keep you posted!`;
  }
  
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// Handle messages
app.message(async ({ message, client, say }) => {
  // Ignore bot messages and threaded messages
  if (message.subtype || message.thread_ts) return;
  
  const workspaceId = message.team;
  const projectId = getLinearProject(workspaceId);
  
  if (!projectId) {
    await say("Yo! Looks like your workspace isn't set up yet. Hit up your admin to configure Kat! 🐱");
    return;
  }
  
  try {
    // Get user info
    const userInfo = await client.users.info({ user: message.user });
    const userName = userInfo.user.real_name || userInfo.user.name;
    
    // Create Linear ticket
    const issue = await linearClient.createIssue({
      projectId: projectId,
      title: message.text.substring(0, 100),
      description: `${message.text}\n\n---\n*Created by:* ${userName} via Kat 🐱`,
      priority: 0
    });
    
    const createdIssue = await issue.issue;
    const ticket = {
      id: createdIssue.id,
      identifier: createdIssue.identifier,
      title: createdIssue.title,
      url: createdIssue.url
    };
    
    const response = generateResponse('ticket_created', ticket);
    await say(response);
    
  } catch (error) {
    console.error('Error:', error);
    await say("Oof, something went sideways on my end. Mind trying again?");
  }
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Kat is vibing on port ${port}! 🐱`);
})();
