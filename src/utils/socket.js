// src/utils/socket.js
import { io } from 'socket.io-client';
import { getAuthToken } from './auth';

let socket = null;

export const initSocket = async () => {
  if (socket?.connected) return socket;

  const token = await getAuthToken();
  if (!token) {
    console.error('No auth token available for Socket.IO');
    return null;
  }

  socket = io('https://wheels-backend.vercel.app', {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('✅ Socket.IO connected:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ Socket.IO disconnected:', reason);
  });

  socket.on('error', (error) => {
    console.error('Socket.IO error:', error);
  });

  return socket;
};

export const getSocket = () => socket;

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const emitEvent = (event, data) => {
  if (socket?.connected) {
    socket.emit(event, data);
  } else {
    console.warn('Socket not connected, cannot emit:', event);
  }
};

export const onEvent = (event, callback) => {
  if (socket) {
    socket.on(event, callback);
  }
};

export const offEvent = (event, callback) => {
  if (socket) {
    socket.off(event, callback);
  }
};