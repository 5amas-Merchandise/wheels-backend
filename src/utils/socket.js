// src/utils/socket.js - DISABLED (Polling only for Vercel)
// Socket.IO doesn't work on Vercel serverless - use polling instead

export const initSocket = async () => {
  console.log('⚠️ Socket.IO disabled - Vercel uses serverless functions');
  console.log('📡 Using HTTP polling for real-time updates');
  return null;
};

export const getSocket = () => null;

export const disconnectSocket = () => {
  console.log('✅ Socket disconnected (no-op)');
};

export const emitEvent = (event, data) => {
  console.log(`⚠️ Socket emit ignored (${event}):`, data);
};

export const onEvent = (event, callback) => {
  console.log(`⚠️ Socket event listener ignored: ${event}`);
};

export const offEvent = (event, callback) => {
  // No-op
};

export const isSocketConnected = () => false;

export const getSocketId = () => null;

export const reconnectSocket = async () => {
  console.log('⚠️ Socket reconnect ignored - using polling');
  return null;
};