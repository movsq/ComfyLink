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
import { findAllUsersByEmail, setUserAdmin, updateUserStatus } from './db.js';

const email = process.argv[2];

if (!email) {
  console.error('Usage: node src/seed-admin.js <email>');
  process.exit(1);
}

const matches = findAllUsersByEmail(email);

if (matches.length === 0) {
  console.error(`No user found with email "${email}".`);
  console.error('The user must register an account first before they can be promoted to admin.');
  process.exit(1);
}

if (matches.length > 1) {
  // The unique index on email only applies to email-auth users (WHERE google_sub IS NULL).
  // A Google user can legitimately share an email with an email-auth user. Refuse to
  // guess — operator must pick by ID.
  console.error(`Found ${matches.length} users with email "${email}":`);
  for (const u of matches) {
    const kind = u.google_sub ? 'google' : 'email-auth';
    console.error(`  id=${u.id}  kind=${kind}  status=${u.status}  is_admin=${u.is_admin ? 1 : 0}`);
  }
  console.error('Refusing to pick one. Promote the right user manually (see db.js setUserAdmin).');
  process.exit(1);
}

const user = matches[0];

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
