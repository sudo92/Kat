require('dotenv').config();

const { App } = require('@slack/bolt');
const { LinearClient } = require('@linear/sdk');

const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

// In-memory storage for workspace -> customer mappings
// In production, use a database instead
const workspaceCustomerMap = {};
const pendingOnboarding = {}; // Track users waiting to provide domain

// Helper: Find customer by domain in Linear
async function findCustomerByDomain(domain) {
  try {
    const customers = await linearClient.customers();
    const allCustomers = await customers.nodes;
    
    // Search through customers for matching domain
    for (const customer of allCustomers) {
      if (customer.domains && customer.domains.length > 0) {
        // Check if any domain matches
        const matchedDomain = customer.domains.find(d => 
          d.toLowerCase() === domain.toLowerCase()
        );
        if (matchedDomain) {
          return {
            id: customer.id,
            name: customer.name,
            domain: matchedDomain
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding customer:', error);
    return null;
  }
}

// Helper: Get or create mapping for workspace
function getCustomerForWorkspace(workspaceId) {
  return workspaceCustomerMap[workspaceId] || null;
}

function setCustomerForWorkspace(workspaceId, customerId, customerName, domain) {
  workspaceCustomerMap[workspaceId] = {
    customerId,
    customerName,
    domain
  };
  console.log(`✅ Connected workspace ${workspaceId} to customer ${customerName} (${domain})`);
}

// Helper: Generate friendly responses
function generateResponse(type, data = {}) {
  const responses = {
    welcome: [
      "Hello! I'm Kat, your support assistant. I'm here to help you manage your support requests.",
      "Hi there! Welcome to Kat. I'll help you create and track your support tickets.",
      "Welcome! I'm Kat, and I'm here to make your support experience seamless."
    ],
    askDomain: [
      "To get started, please provide your company domain (e.g., getintelekt.ai or yourcompany.com)",
      "I'll need your company domain to connect your account. Please enter it like: company.com",
      "What's your company domain? This helps me link you to the right account."
    ],
    verifying: [
      "Thank you! Let me verify that information...",
      "One moment while I look up your account...",
      "Checking our records for that domain..."
    ],
    setupComplete: [
      "Great! Your account is now connected.\n\nHere's what I can help you with:\n• Create support tickets by describing your issue\n• View your tickets by asking 'show my tickets'\n• Get updates on your requests\n\nHow can I assist you today?",
      "Perfect! You're all set.\n\nI can help you:\n• Submit new support requests\n• Track existing tickets\n• Get status updates\n\nWhat can I help you with?",
      "Success! Your account is configured.\n\nYou can now:\n• Report issues and I'll create tickets for you\n• Ask about your open tickets anytime\n• Stay informed on request status\n\nWhat would you like to do?"
    ],
    notFound: [
      "I couldn't find that domain in our system.\n\nPlease verify the domain is correct (format: company.com), or contact your account manager to ensure your domain is registered with us.",
      "That domain doesn't appear to be registered yet.\n\nPlease double-check the spelling, or reach out to your account team to get your domain added to our system."
    ],
    ticketCreated: `Thank you! I've created a ticket for you.\n\n*Ticket:* {title}\n*ID:* {identifier}\n*Status:* {status}\n*Link:* {url}\n\nYou'll receive updates as we work on this.`,
    error: [
      "I apologize, but I encountered an error. Please try again in a moment.",
      "Sorry, something went wrong on my end. Could you please try that again?"
    ]
  };
  
  const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
  
  if (type === 'ticketCreated') {
    return responses.ticketCreated
      .replace('{title}', data.title)
      .replace('{identifier}', data.identifier)
      .replace('{status}', data.status)
      .replace('{url}', data.url);
  }
  
  return random(responses[type] || responses.error);
}

// Helper: Create ticket in Linear
async function createTicket(customerId, title, description, userName) {
  try {
    const issue = await linearClient.createIssue({
      customerId: customerId,
      title: title,
      description: `${description}\n\n---\n*Submitted by:* ${userName} via Kat Support Bot`,
      priority: 0
    });
    
    const createdIssue = await issue.issue;
    const state = await createdIssue.state;
    
    return {
      id: createdIssue.id,
      identifier: createdIssue.identifier,
      title: createdIssue.title,
      url: createdIssue.url,
      status: state.name
    };
  } catch (error) {
    console.error('Error creating ticket:', error);
    throw error;
  }
}

// Helper: Get tickets for customer
async function getCustomerTickets(customerId) {
  try {
    const issues = await linearClient.issues({
      filter: {
        customer: { id: { eq: customerId } }
      },
      first: 20,
      orderBy: 'updatedAt'
    });
    
    const tickets = await issues.nodes;
    const formattedTickets = await Promise.all(
      tickets.map(async (ticket) => {
        const state = await ticket.state;
        return {
          identifier: ticket.identifier,
          title: ticket.title,
          url: ticket.url,
          status: state.name,
          priority: ticket.priority
        };
      })
    );
    
    return formattedTickets;
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return [];
  }
}

// Main message handler
app.message(async ({ message, client, say }) => {
  // Ignore bot messages and threaded messages
  if (message.subtype || message.thread_ts) return;
  
  const workspaceId = message.team;
  const userId = message.user;
  const text = message.text.trim();
  
  try {
    // Get user info
    const userInfo = await client.users.info({ user: userId });
    const userName = userInfo.user.real_name || userInfo.user.name;
    
    // Check if workspace is already mapped
    const customerMapping = getCustomerForWorkspace(workspaceId);
    
    // ONBOARDING FLOW
    if (!customerMapping) {
      // Check if user is in onboarding
      if (pendingOnboarding[userId]) {
        // User is providing their domain
        await say(generateResponse('verifying'));
        
        // Search for customer by domain
        const customer = await findCustomerByDomain(text);
        
        if (customer) {
          // Found! Set up mapping
          setCustomerForWorkspace(workspaceId, customer.id, customer.name, customer.domain);
          delete pendingOnboarding[userId];
          
          await say(generateResponse('setupComplete'));
        } else {
          // Not found
          await say(generateResponse('notFound'));
          delete pendingOnboarding[userId];
        }
        return;
      }
      
      // First time user - start onboarding
      pendingOnboarding[userId] = true;
      await say(generateResponse('welcome') + '\n\n' + generateResponse('askDomain'));
      return;
    }
    
    // NORMAL OPERATION (after onboarding)
    const customerId = customerMapping.customerId;
    const customerName = customerMapping.customerName;
    
    // Check if user wants to see their tickets
    const lowerText = text.toLowerCase();
    if (lowerText.match(/\b(show|list|get|see|view|my)\b.*(ticket|request|issue)/)) {
      const tickets = await getCustomerTickets(customerId);
      
      if (tickets.length === 0) {
        await say("You currently have no open tickets. All clear!");
        return;
      }
      
      let response = `Here are your current tickets for *${customerName}*:\n\n`;
      tickets.forEach(ticket => {
        response += `📋 *${ticket.identifier}* - ${ticket.title}\n`;
        response += `   Status: ${ticket.status}\n`;
        response += `   ${ticket.url}\n\n`;
      });
      
      await say(response);
      return;
    }
    
    // Default: Create a ticket
    const ticket = await createTicket(
      customerId,
      text.substring(0, 100), // First 100 chars as title
      text,
      userName
    );
    
    await say(generateResponse('ticketCreated', ticket));
    
  } catch (error) {
    console.error('Error handling message:', error);
    await say(generateResponse('error'));
  }
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Kat Support Bot is running on port ${port}`);
  console.log(`📝 Ready to assist customers`);
  console.log(`💾 Active connections: ${Object.keys(workspaceCustomerMap).length}`);
})();

module.exports = app;
