const { Strategy: PassportLocalStrategy } = require('passport-local');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles, ErrorTypes } = require('librechat-data-provider');
const { getBalanceConfig, isEnabled } = require('@librechat/api');
const { createUser, findUser, updateUser, countUsers } = require('~/models');

const SESSION_KEEPER_URL = (
  process.env.SESSION_KEEPER_URL || 'http://localhost:8090'
).replace(/\/+$/, '');
const BMW_SSO_TOOL_KEY = process.env.BMW_SSO_TOOL_KEY || 'octane';
const BMW_SSO_LOGIN_TIMEOUT_MS = Number(process.env.BMW_SSO_LOGIN_TIMEOUT_MS) || 120000;

/**
 * Call the session_keeper service to verify BMW SSO credentials.
 * Returns `true` when the keeper acknowledges a valid session, `false` otherwise.
 * The keeper handles the full ForgeRock AM / SAML flow and session caching.
 */
async function verifyWithSessionKeeper(username, password) {
  const url = `${SESSION_KEEPER_URL}/sessions/${encodeURIComponent(BMW_SSO_TOOL_KEY)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BMW_SSO_LOGIN_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        strong_auth: false,
        strong_auth_type: 'mobile',
      }),
      signal: controller.signal,
    });
    if (resp.ok) {
      return true;
    }
    logger.warn(
      `[bmwSsoStrategy] session_keeper returned ${resp.status}: ${await resp.text().catch(() => '')}`,
    );
    return false;
  } catch (err) {
    logger.warn(`[bmwSsoStrategy] session_keeper request failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Map a BMW username (e.g. "q446328") to a synthetic email that satisfies the
 * User schema's email regex. Mirrors the LDAP strategy's `@ldap.local` pattern.
 */
function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@bmw.com`;
}

async function bmwSsoLogin(req, username, password, done) {
  try {
    if (!username || !username.trim() || !password) {
      logger.error(
        `[bmwSsoStrategy] Login failed — missing credentials [Username: ${username}] [Request-IP: ${req.ip}]`,
      );
      return done(null, false, { message: 'Username and password are required.' });
    }

    const verified = await verifyWithSessionKeeper(username.trim(), password);
    if (!verified) {
      logger.error(
        `[bmwSsoStrategy] Login failed — session_keeper rejected credentials [Username: ${username}] [Request-IP: ${req.ip}]`,
      );
      return done(null, false, { message: 'BMW SSO login failed: invalid credentials.' });
    }

    const email = usernameToEmail(username);
    let user = await findUser({ email });

    if (user && user.provider !== 'bmw_sso') {
      logger.info(
        `[bmwSsoStrategy] User ${user.email} already exists with provider ${user.provider}`,
      );
      return done(null, false, { message: ErrorTypes.AUTH_FAILED });
    }

    if (!user) {
      const isFirstRegisteredUser = (await countUsers()) === 0;
      const role = isFirstRegisteredUser ? SystemRoles.ADMIN : SystemRoles.USER;
      const newUser = {
        provider: 'bmw_sso',
        username: username.trim().toLowerCase(),
        email,
        emailVerified: true,
        name: username.trim(),
        role,
      };
      const balanceConfig = getBalanceConfig();
      const userId = await createUser(newUser, balanceConfig);
      user = await findUser({ _id: userId });
    } else {
      user.provider = 'bmw_sso';
      user.username = username.trim().toLowerCase();
      user = await updateUser(user._id, {
        provider: user.provider,
        username: user.username,
      });
    }

    logger.info(
      `[bmwSsoStrategy] Login successful [Username: ${username}] [Request-IP: ${req.ip}]`,
    );
    return done(null, user);
  } catch (err) {
    logger.error('[bmwSsoStrategy]', err);
    return done(err);
  }
}

module.exports = () =>
  new PassportLocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password',
      session: false,
      passReqToCallback: true,
    },
    bmwSsoLogin,
  );
