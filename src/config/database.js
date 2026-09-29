import mongoose from 'mongoose';

import logger from './logger.js';

export const connectDatabase = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is not defined. Set it in your .env file.');
  }

  // Connection loss after a successful start must not be silent.
  mongoose.connection.on('error', (error) => {
    logger.error('MongoDB connection error', error.message);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  await mongoose.connect(uri);
  logger.info('MongoDB connected successfully');

  return mongoose.connection;
};

export const disconnectDatabase = async () => {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
};

export default connectDatabase;
