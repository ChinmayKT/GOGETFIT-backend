import http from 'node:http';

import mongoose from 'mongoose';

import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import Otp from '../../src/models/otp.model.js';
import MigrationConflict from '../../src/models/migration-conflict.model.js';
import FreeDietPlan from '../../src/models/free-diet-plan.model.js';
import Coach from '../../src/models/coach.model.js';
import GogetfitPlan from '../../src/models/gogetfit-plan.model.js';

/**
 * Integration tests run against a dedicated database on the configured cluster
 * so they can exercise the real unique indexes. The production database name is
 * never used.
 */
export const TEST_DB_NAME = process.env.TEST_DB_NAME || 'gogetfit_test';

export const connectTestDb = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required to run integration tests');

  await mongoose.connect(process.env.MONGODB_URI, { dbName: TEST_DB_NAME });

  if (mongoose.connection.name !== TEST_DB_NAME) {
    throw new Error(`Refusing to run tests against database "${mongoose.connection.name}"`);
  }

  await Promise.all([
    User.syncIndexes(),
    Otp.syncIndexes(),
    MigrationConflict.syncIndexes(),
    FreeDietPlan.syncIndexes(),
    Coach.syncIndexes(),
    GogetfitPlan.syncIndexes(),
  ]);
};

export const clearTestDb = async () => {
  await Promise.all([
    User.deleteMany({}),
    Otp.deleteMany({}),
    MigrationConflict.deleteMany({}),
    FreeDietPlan.deleteMany({}),
    Coach.deleteMany({}),
    GogetfitPlan.deleteMany({}),
  ]);
};

export const disconnectTestDb = async () => {
  await mongoose.connection.close();
};

export const startTestServer = async () => {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    return { status: response.status, body: payload };
  };

  const close = () => new Promise((resolve) => server.close(resolve));

  return { baseUrl, request, close };
};

/** Full login: request a code, read it from the debug response, verify it. */
export const login = async (request, phone) => {
  const requested = await request('POST', '/api/auth/request-otp', { body: { phone } });
  const otp = requested.body.data.devOtp;
  const verified = await request('POST', '/api/auth/verify-otp', { body: { phone, otp } });
  return { requested, verified, token: verified.body?.data?.token };
};
