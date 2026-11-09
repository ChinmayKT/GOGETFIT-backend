import path from 'node:path';

import compression from 'compression';
import express from 'express';
import mongoose from 'mongoose';

import env from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { createCorsMiddleware, resolveAllowedOrigins } from './middleware/cors.middleware.js';

const app = express();

// Gzip for responses over 1 KB whose type compresses (JSON, text). Images and
// video are already compressed and pass through untouched.
app.use(
  createCorsMiddleware(
    resolveAllowedOrigins({ configured: env.corsAllowedOrigins, isProduction: env.isProduction }),
  ),
);
app.use(compression());
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'GOGETFIT backend is running',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// Serves locally stored uploads (profile pictures). Filenames are content
// hashes, so these URLs are immutable and safe to cache indefinitely.
app.use(
  env.storage.publicPath,
  express.static(path.resolve(env.storage.localRoot), {
    immutable: true,
    maxAge: '365d',
    index: false,
    dotfiles: 'deny',
  }),
);

app.use('/api', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
