import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TInsightsResponse, TStartupConfig } from 'librechat-data-provider';
import InsightsView from './InsightsView';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: jest.fn(),
      getInsightsAccess: jest.fn(),
      getInsights: jest.fn(),
      getInsightsConversationMessages: jest.fn(),
    },
  };
});

jest.mock('~/hooks', () => {
  const translations: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return {
    useAuthContext: () => ({ user: { id: 'admin-test', role: 'ADMIN' } }),
    useDocumentTitle: () => undefined,
    useLocalize: () => (key: string, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        translations[key] ?? key,
      ),
  };
});

const mockGetInsights = dataService.getInsights as jest.MockedFunction<
  typeof dataService.getInsights
>;
const mockGetStartupConfig = dataService.getStartupConfig as jest.MockedFunction<
  typeof dataService.getStartupConfig
>;
const mockGetInsightsAccess = dataService.getInsightsAccess as jest.MockedFunction<
  typeof dataService.getInsightsAccess
>;
const mockGetMessages = dataService.getInsightsConversationMessages as jest.MockedFunction<
  typeof dataService.getInsightsConversationMessages
>;

const report: TInsightsResponse = {
  agents: [
    { id: '__unassigned__', name: '' },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `agent-${index + 1}`,
      name: `Agent ${index + 1}`,
    })),
  ],
  summary: { totalUsers: 1, totalConversations: 1, totalMessages: 2, totalTokens: 20 },
  daily: [],
  topUsers: [],
  churnedUsers: [],
  latest: {
    conversations: [
      {
        conversationId: 'conversation-test',
        userId: 'user-test',
        name: 'Test User',
        email: 'user@example.com',
        date: '2026-11-17T00:00:00.000Z',
        firstMessage: 'Synthetic conversation',
        messages: 2,
        totalTokens: 20,
      },
    ],
    page: 1,
    pageSize: 10,
    pages: 2,
  },
};

const clients: QueryClient[] = [];

function renderInsights() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
        <MemoryRouter>
          <InsightsView />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStartupConfig.mockResolvedValue({ insightsEnabled: true } as TStartupConfig);
  mockGetInsightsAccess.mockResolvedValue({ access: true });
  mockGetInsights.mockImplementation(async (params = {}) => ({
    ...report,
    latest: { ...report.latest, page: params.page ?? 1 },
  }));
  mockGetMessages.mockResolvedValue({
    messages: [
      {
        messageId: 'detail-test',
        isCreatedByUser: true,
        text: 'Preserved conversation detail',
        createdAt: '2026-11-17T00:00:00.000Z',
      },
    ],
  });
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

describe('Insights Agent filters', () => {
  it('starts with the original unfiltered statistics request', async () => {
    renderInsights();

    expect(await screen.findByRole('combobox', { name: 'Agents' })).toBeEnabled();
    await waitFor(() => expect(mockGetInsights).toHaveBeenCalled());
    expect(mockGetInsights.mock.calls[0][0]).not.toHaveProperty('agentIds');
  });

  it('clears the selection without falling back to an unfiltered request', async () => {
    const user = userEvent.setup();
    renderInsights();

    await user.click(await screen.findByRole('combobox', { name: 'Agents' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));

    await waitFor(() =>
      expect(mockGetInsights).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentIds: [], page: 1 }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Select all agents' })).toBeEnabled();
  });

  it('resets pagination when selecting a specific agent', async () => {
    const user = userEvent.setup();
    renderInsights();

    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mockGetInsights).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
    await user.click(screen.getByRole('combobox', { name: 'Agents' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await user.click(screen.getByRole('option', { name: 'Agent 2' }));

    await waitFor(() =>
      expect(mockGetInsights).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentIds: ['agent-2'], page: 1 }),
      ),
    );
  });

  it('searches a long agent list without limiting the select-all action', async () => {
    const user = userEvent.setup();
    renderInsights();

    await user.click(await screen.findByRole('combobox', { name: 'Agents' }));
    await user.type(screen.getByRole('textbox', { name: 'Search agents' }), 'Agent 11');

    expect(screen.getByRole('option', { name: 'Agent 11' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Agent 2' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await user.click(screen.getByRole('button', { name: 'Select all agents' }));

    await waitFor(() =>
      expect(mockGetInsights.mock.calls.at(-1)?.[0]).not.toHaveProperty('agentIds'),
    );
  });

  it('does not turn an explicit unassigned-only selection into unfiltered statistics', async () => {
    const user = userEvent.setup();
    mockGetInsights.mockResolvedValue({
      ...report,
      agents: [{ id: '__unassigned__', name: '' }],
    });
    renderInsights();

    await user.click(await screen.findByRole('combobox', { name: 'Agents' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await user.click(screen.getByRole('option', { name: 'Conversations without an agent' }));

    await waitFor(() =>
      expect(mockGetInsights).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentIds: ['__unassigned__'] }),
      ),
    );
  });

  it('preserves the custom conversation-detail expansion', async () => {
    const user = userEvent.setup();
    renderInsights();

    await user.click(await screen.findByRole('button', { name: 'View conversation' }));

    expect(await screen.findByText('Preserved conversation detail')).toBeInTheDocument();
    expect(mockGetMessages).toHaveBeenCalledWith('conversation-test');
  });

  it('does not request statistics when the existing access check denies them', async () => {
    mockGetInsightsAccess.mockResolvedValue({ access: false });
    renderInsights();

    await waitFor(() => expect(mockGetInsightsAccess).toHaveBeenCalled());
    expect(mockGetInsights).not.toHaveBeenCalled();
  });
});
