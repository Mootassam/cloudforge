'use strict';
// Access-code generator. The admin hands this code to a customer so their
// client app can connect to their project on the Oracle cloud. No lookalike
// characters (no 0/O, 1/I) so it's easy to read over the phone / WhatsApp.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function group(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function generateCode() {
  return `CF-${group(4)}-${group(4)}-${group(4)}`;
}

module.exports = { generateCode };
