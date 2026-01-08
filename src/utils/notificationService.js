// Mock push notification service
// In production, replace with Firebase Cloud Messaging, Twilio, AWS SNS, etc.

function sendPush({ userId, type, title, body, data }) {
  // Log to console (mock send)
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] PUSH NOTIFICATION`);
  console.log(`  User: ${userId}`);
  console.log(`  Type: ${type}`);
  console.log(`  Title: ${title}`);
  console.log(`  Body: ${body}`);
  if (data) console.log(`  Data: ${JSON.stringify(data)}`);
}

module.exports = { sendPush };
