#!/usr/bin/env node

/**
 * seed-admin.js — One-time CLI tool to promote a user to admin.
 *
 * Usage:
 *   node src/seed-admin.js user@example.com
 *
 * The user must have signed in with Google at least once (so they exist in the DB).
 * This also sets their status to 'active' if it was 'pending'.
 */

import 'dotenv/config';
import { findUserByEmail, setUserAdmin, updateUserStatus } from './db.js';

const email = process.argv[2];

if (!email) {
  console.error('Usage: node src/seed-admin.js <email>');
  process.exit(1);
}

const user = findUserByEmail(email);

if (!user) {
  console.error(`No user found with email "${email}".`);
  console.error('The user must register an account first before they can be promoted to admin.');
  process.exit(1);
}

if (user.is_admin) {
  console.log(`${email} is already an admin.`);
  process.exit(0);
}

setUserAdmin(user.id, true);

if (user.status !== 'active') {
  updateUserStatus(user.id, 'active');
  console.log(`${email} → promoted to admin and status set to active.`);
} else {
  console.log(`${email} → promoted to admin.`);
}
