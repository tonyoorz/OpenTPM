import userEvent from '@testing-library/user-event';
import type { TStartupConfig } from 'librechat-data-provider';
import * as endpointQueries from '~/data-provider/Endpoints/queries';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import * as authMutations from '~/data-provider/Auth/mutations';
import { render, getByTestId } from 'test/layout-test-utils';
import * as authQueries from '~/data-provider/Auth/queries';
import Login from '../LoginForm';

jest.mock('librechat-data-provider/react-query');

const mockLogin = jest.fn();

const mockStartupConfig: TStartupConfig = {
  socialLogins: ['google', 'facebook', 'openid', 'github', 'discord', 'saml'],
  discordLoginEnabled: true,
  facebookLoginEnabled: true,
  githubLoginEnabled: true,
  googleLoginEnabled: true,
  openidLoginEnabled: true,
  appleLoginEnabled: false,
  openidLabel: 'Test OpenID',
  openidImageUrl: 'http://test-server.com',
  openidAutoRedirect: false,
  samlLoginEnabled: true,
  samlLabel: 'Test SAML',
  samlImageUrl: 'http://test-server.com',
  registrationEnabled: true,
  emailLoginEnabled: true,
  socialLoginEnabled: true,
  bmwSsoLoginEnabled: false,
  passwordResetEnabled: true,
  serverDomain: 'mock-server',
  appTitle: '',
  ldap: {
    enabled: false,
  },
  emailEnabled: false,
  showBirthdayIcon: false,
  helpAndFaqURL: '',
  sharedLinksEnabled: true,
  publicSharedLinksEnabled: true,
  allowAccountDeletion: true,
};

const setup = ({
  useGetUserQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
  useLoginUserReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {},
    isSuccess: false,
  },
  useRefreshTokenMutationReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {
      token: 'mock-token',
      user: {},
    },
  },
  useGetStartupConfigReturnValue = {
    isLoading: false,
    isError: false,
    data: mockStartupConfig,
  },
  useGetBannerQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
} = {}) => {
  const mockUseLoginUser = jest
    .spyOn(authMutations, 'useLoginUserMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useLoginUserReturnValue);
  const mockUseGetUserQuery = jest
    .spyOn(authQueries, 'useGetUserQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetUserQueryReturnValue);
  const mockUseGetStartupConfig = jest
    .spyOn(endpointQueries, 'useGetStartupConfig')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetStartupConfigReturnValue);
  const mockUseRefreshTokenMutation = jest
    .spyOn(authMutations, 'useRefreshTokenMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useRefreshTokenMutationReturnValue);
  const mockUseGetBannerQuery = jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetBannerQueryReturnValue);
  return {
    mockUseLoginUser,
    mockUseGetUserQuery,
    mockUseGetStartupConfig,
    mockUseRefreshTokenMutation,
    mockUseGetBannerQuery,
  };
};

beforeEach(() => {
  setup();
});

test('renders login form', () => {
  const { getByLabelText } = render(
    <Login
      onSubmit={mockLogin}
      startupConfig={mockStartupConfig}
      error={undefined}
      setError={jest.fn()}
    />,
  );
  expect(getByLabelText(/email/i)).toHaveClass('h-auto');
  expect(getByLabelText(/password/i)).toBeInTheDocument();
});

test('submits login form', async () => {
  const { getByLabelText } = render(
    <Login
      onSubmit={mockLogin}
      startupConfig={mockStartupConfig}
      error={undefined}
      setError={jest.fn()}
    />,
  );
  const emailInput = getByLabelText(/email/i);
  const passwordInput = getByLabelText(/password/i);
  const submitButton = getByTestId(document.body, 'login-button');

  await userEvent.type(emailInput, 'test@example.com');
  await userEvent.type(passwordInput, 'password');
  await userEvent.click(submitButton);

  expect(mockLogin).toHaveBeenCalledWith({ email: 'test@example.com', password: 'password' });
});

test('submits mobile strong authentication by default for BMW SSO', async () => {
  const { getByLabelText } = render(
    <Login
      onSubmit={mockLogin}
      startupConfig={{ ...mockStartupConfig, bmwSsoLoginEnabled: true }}
      error={undefined}
      setError={jest.fn()}
    />,
  );
  const usernameInput = getByLabelText('BMW QNumber');
  const passwordInput = getByLabelText(/strong authentication pin/i);
  const submitButton = getByTestId(document.body, 'login-button');

  await userEvent.type(usernameInput, 'q123456');
  await userEvent.type(passwordInput, '12345678');
  await userEvent.click(submitButton);

  expect(mockLogin).toHaveBeenCalledWith({
    email: 'q123456',
    password: '12345678',
    strong_auth: true,
    strong_auth_type: 'mobile',
  });
});

test('submits browser authentication when BMW mobile strong authentication is disabled', async () => {
  const { getByLabelText, getByRole } = render(
    <Login
      onSubmit={mockLogin}
      startupConfig={{ ...mockStartupConfig, bmwSsoLoginEnabled: true }}
      error={undefined}
      setError={jest.fn()}
    />,
  );
  const usernameInput = getByLabelText('BMW QNumber');
  const mobileStrongAuth = getByRole('checkbox', { name: /use mobile strong authentication/i });

  await userEvent.click(mobileStrongAuth);
  await userEvent.type(usernameInput, 'q123456');
  await userEvent.type(getByLabelText(/^password$/i), 'password');
  await userEvent.click(getByTestId(document.body, 'login-button'));

  expect(mockLogin).toHaveBeenCalledWith({
    email: 'q123456',
    password: 'password',
    strong_auth: false,
    strong_auth_type: 'mobile',
  });
});

test('displays validation error messages', async () => {
  const { getByLabelText, getByText } = render(
    <Login
      onSubmit={mockLogin}
      startupConfig={mockStartupConfig}
      error={undefined}
      setError={jest.fn()}
    />,
  );
  const emailInput = getByLabelText(/email/i);
  const passwordInput = getByLabelText(/password/i);
  const submitButton = getByTestId(document.body, 'login-button');

  await userEvent.type(emailInput, 'test');
  await userEvent.type(passwordInput, 'pass');
  await userEvent.click(submitButton);

  expect(getByText(/You must enter a valid email address/i)).toBeInTheDocument();
  expect(getByText(/Password must be at least 8 characters/i)).toBeInTheDocument();
});
