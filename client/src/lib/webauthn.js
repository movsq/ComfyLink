/**
 * webauthn.js — WebAuthn PRF extension for vault key derivation.
 *
 * The PRF extension allows deterministic keying material to be derived
 * during each WebAuthn ceremony (registration/authentication). This output
 * is used to derive an AES-KW wrapping key for the vault master key.
 */

import { bufToB64, b64ToBuf } from './vault-crypto.js';
import { getSubtle } from './crypto.js';

/**
 * Check if the browser supports WebAuthn with the PRF extension.
 * This is a basic feature check — actual PRF support depends on the authenticator.
 */
export function checkWebAuthnSupport() {
  return typeof window !== 'undefined'
    && window.isSecureContext === true // navigator.credentials rejects otherwise
    && typeof PublicKeyCredential !== 'undefined'
    && typeof navigator.credentials !== 'undefined';
}

/**
 * Check if a platform authenticator is available (fingerprint, Face ID, etc).
 * Returns true if available, false otherwise.
 * Cannot distinguish between fingerprint and face — just "platform auth exists".
 */
export async function checkPlatformAuthenticator() {
  if (!checkWebAuthnSupport()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Register a new WebAuthn credential with PRF extension.
 *
 * @param {string} userId — account identifier (the e-mail address); it is hashed
 *   before it becomes the user handle, never sent to the authenticator as-is
 * @param {string} userName — display name
 * @param {Uint8Array} prfSalt — random salt for PRF eval (stored server-side)
 * @returns {{ credentialId: string, publicKey: string, prfOutput: Uint8Array | null }}
 *   prfOutput is null if the authenticator does not support PRF.
 */
export async function registerCredential(userId, userName, prfSalt) {
  // user.id must be an opaque byte sequence with no personally identifying
  // information (WebAuthn L2 §5.4.3) and at most 64 bytes. With
  // residentKey: 'preferred' the credential is discoverable, so the handle is
  // written into the authenticator/passkey provider and can be synced and shown
  // in credential pickers — the raw e-mail does not belong there. SHA-256 gives
  // a stable, opaque, spec-length (32-byte) handle for the same account.
  // The e-mail stays in user.name / user.displayName, which is where it belongs.
  const userIdBytes = new Uint8Array(
    await getSubtle().digest('SHA-256', new TextEncoder().encode(userId)),
  );

  const publicKeyOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: {
      // Explicit rp.id pins the credential to the current hostname. Without
      // this the browser defaults to the effective domain anyway, so the
      // behaviour is unchanged — but the explicit value makes it visible that
      // credentials registered on one hostname (e.g. Tailscale MagicDNS) will
      // NOT work when the same site is later accessed via a different
      // hostname (e.g. a public domain). Both halves must agree on rp.id.
      id: window.location.hostname,
      name: 'ComfyLink',
    },
    user: {
      id: userIdBytes,
      name: userName,
      displayName: userName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },   // ES256
      { alg: -257, type: 'public-key' },  // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
    extensions: {
      prf: {
        eval: {
          first: prfSalt,
        },
      },
    },
    timeout: 60000,
  };

  const credential = await navigator.credentials.create({ publicKey: publicKeyOptions });

  const credentialId = bufToB64(new Uint8Array(credential.rawId));
  const publicKey = bufToB64(new Uint8Array(credential.response.getPublicKey()));

  // Check if PRF extension was enabled
  const extResults = credential.getClientExtensionResults();
  let prfOutput = null;

  if (extResults.prf?.results?.first) {
    prfOutput = new Uint8Array(extResults.prf.results.first);
  }

  // Also check prf.enabled for browsers that report it
  const prfEnabled = extResults.prf?.enabled ?? (prfOutput !== null);

  return {
    credentialId,
    publicKey,
    prfOutput,
    prfEnabled,
  };
}

/**
 * Authenticate with an existing credential and get PRF output.
 *
 * @param {string} credentialIdB64 — base64-encoded credential ID
 * @param {Uint8Array} prfSalt — the same salt used during registration
 * @returns {Uint8Array} — PRF output (32 bytes keying material)
 * @throws if authentication fails or PRF output not available
 */
export async function authenticateWithPRF(credentialIdB64, prfSalt) {
  const credentialIdBytes = b64ToBuf(credentialIdB64);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // Must match the rpId used at registration. See registerCredential().
      rpId: window.location.hostname,
      allowCredentials: [
        {
          id: credentialIdBytes,
          type: 'public-key',
          transports: ['internal'],
        },
      ],
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: prfSalt,
          },
        },
      },
      timeout: 60000,
    },
  });

  const extResults = assertion.getClientExtensionResults();

  if (!extResults.prf?.results?.first) {
    throw new Error('PRF output not available from authenticator');
  }

  return new Uint8Array(extResults.prf.results.first);
}
