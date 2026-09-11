import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type {
  TInsightsAccessResponse,
  TInsightsParams,
  TInsightsResponse,
} from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';

export type InsightsConversationMessage = {
  messageId: string;
  isCreatedByUser: boolean;
  sender?: string;
  text?: string;
  content?: unknown[];
  model?: string;
  endpoint?: string;
  createdAt: string;
  parentMessageId?: string;
  tokenCount?: number;
};

export type InsightsConversationMessagesResponse = {
  messages: InsightsConversationMessage[];
};

export const useInsightsQuery = (
  params: TInsightsParams,
  config?: UseQueryOptions<TInsightsResponse>,
): QueryObserverResult<TInsightsResponse> =>
  useQuery<TInsightsResponse>([QueryKeys.insights, params], () => dataService.getInsights(params), {
    keepPreviousData: true,
    refetchOnWindowFocus: false,
    ...config,
  });

export const useInsightsAccessQuery = (
  userId?: string,
  config?: UseQueryOptions<TInsightsAccessResponse>,
): QueryObserverResult<TInsightsAccessResponse> =>
  useQuery<TInsightsAccessResponse>(
    [QueryKeys.insightsAccess, userId ?? 'anonymous'],
    () => dataService.getInsightsAccess(),
    {
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      ...config,
    },
  );

export const useInsightsConversationMessagesQuery = (
  conversationId: string | null,
  config?: UseQueryOptions<InsightsConversationMessagesResponse>,
): QueryObserverResult<InsightsConversationMessagesResponse> =>
  useQuery<InsightsConversationMessagesResponse>(
    [QueryKeys.insightsConversationMessages, conversationId],
    async () => {
      const response = await dataService.getInsightsConversationMessages(conversationId as string);
      return response as InsightsConversationMessagesResponse;
    },
    {
      enabled: !!conversationId,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      ...config,
    },
  );
