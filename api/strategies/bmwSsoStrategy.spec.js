let capturedVerifyCallback;

jest.mock('passport-local', () => ({
  Strategy: jest.fn((_options, verifyCallback) => {
    capturedVerifyCallback = verifyCallback;
    return { name: 'local' };
  }),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('librechat-data-provider', () => ({
  SystemRoles: { ADMIN: 'ADMIN', USER: 'USER' },
  ErrorTypes: { AUTH_FAILED: 'AUTH_FAILED' },
}));

jest.mock('@librechat/api', () => ({
  getBalanceConfig: jest.fn(),
  isEnabled: jest.fn(),
}));

jest.mock('~/models', () => ({
  createUser: jest.fn(),
  findUser: jest.fn(),
  updateUser: jest.fn(),
  countUsers: jest.fn(),
}));

const bmwSsoLogin = require('./bmwSsoStrategy');
const { findUser, updateUser } = require('~/models');

function authenticate(request) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(request, 'q123456', '123456', (error, user, info) => {
      if (error) {
        return reject(error);
      }
      resolve({ user, info });
    });
  });
}

describe('bmwSsoStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    findUser.mockResolvedValue({ _id: 'user-1', provider: 'bmw_sso' });
    updateUser.mockResolvedValue({ _id: 'user-1', provider: 'bmw_sso' });
    bmwSsoLogin();
  });

  it('forwards mobile strong authentication to the session keeper', async () => {
    await authenticate({
      body: { strong_auth: true, strong_auth_type: 'mobile' },
      ip: '127.0.0.1',
    });

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      username: 'q123456',
      password: '123456',
      strong_auth: true,
      strong_auth_type: 'mobile',
    });
  });
});
